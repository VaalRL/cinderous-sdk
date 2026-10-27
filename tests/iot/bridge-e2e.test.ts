// IoT P0 端到端（SDK ADR 0049 分階段計畫 P0 的測試欄）：真的 Node 中繼（純記憶體、嚴格平面、要求 NIP-42）＋測試用 MQTT broker（Aedes，devDependency）
// ＋真的 mqtt.js＋家中橋接器（`startIotBridge`）＋手機端 `IotClient`（真的 `RelayPool`）。設備以另一個 mqtt.js 客戶端模擬（Tasmota 風格的 topic）。
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Aedes } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { fileIotAclStore, fileIotPushStore, startIotBridge, type IotBridge } from '../../src/iot/bridge/index.js';
import {
  buildIotEvent,
  deriveIotHome,
  generateIotHomeSecret,
  IOT_KIND_ACK,
  IOT_KIND_COMMAND,
  IotClient,
  IotGateway,
  IotKeyring,
  newIotMsgId,
  type IotGatewayStatus,
  type IotStateMessage,
} from '../../src/iot/index.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { RelayEventBudget, sharedRelayEventBudget } from '../../src/relay-budget.js';
import { RelayPool, type SocketLike, type SocketListener } from '../../src/relay-pool.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<boolean> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) return false;
    await sleep(50);
  }
  return true;
}

const home = deriveIotHome(generateIotHomeSecret());
const gw = Identity.generate();
const owner = Identity.generate();
const operator = Identity.generate();
const viewer = Identity.generate();
const outsider = Identity.generate();

let relayUrl = '';
let relay: { close(): void };
let broker: Aedes;
let mqttServer: Server;
let mqttUrl = '';
let device: MqttClient;
let bridge: IotBridge;
let aclPath = '';
let pushPath = '';
/** 模擬 UnifiedPush 伺服器（例如家裡的 ntfy）收到的推播：路徑與本文 */
const ntfyInbox: { path: string; body: string; urgency?: string }[] = [];
let ntfy: HttpServer;
let ntfyUrl = '';
/** 設備收到的指令（topic, payload） */
const deviceInbox: [string, string][] = [];
const pools: RelayPool[] = [];
const clients: IotClient[] = [];

function memberClient(
  identity: Identity,
  opts: { budget?: RelayEventBudget | 'shared'; createSocket?: (url: string) => SocketLike; publishTimeoutMs?: number } = {},
): IotClient {
  const pool = new RelayPool({
    urls: [relayUrl],
    identity,
    ...(opts.createSocket ? { createSocket: opts.createSocket } : {}),
    ...(opts.publishTimeoutMs ? { publishTimeoutMs: opts.publishTimeoutMs } : {}),
  });
  pool.connect();
  pools.push(pool);
  const budget = opts.budget === 'shared' ? undefined : (opts.budget ?? new RelayEventBudget());
  const client = new IotClient({ pool, signer: identity, home, gateway: gw.npub, ...(budget ? { budget } : {}) });
  clients.push(client);
  return client;
}

beforeAll(async () => {
  const relayPort = 47_000 + Math.floor(Math.random() * 2_000);
  relay = startNodeRelay({ PORT: String(relayPort) }, { memory: true });
  relayUrl = `ws://127.0.0.1:${relayPort}`;

  broker = await Aedes.createBroker();
  mqttServer = createServer(broker.handle);
  await new Promise<void>((resolve) => mqttServer.listen(0, '127.0.0.1', resolve));
  const address = mqttServer.address();
  mqttUrl = `mqtt://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  // 模擬設備：收到 POWER 就回報新值；收到 STATUS 就回報整份狀態
  device = mqtt.connect(mqttUrl, { clientId: 'sim-device' });
  await new Promise<void>((resolve) => device.on('connect', () => resolve()));
  await new Promise<void>((resolve) => device.subscribe('cmnd/#', { qos: 1 }, () => resolve()));
  const power: Record<string, string> = { plug1: 'OFF', plug2: 'OFF' };
  device.on('message', (topic, payload) => {
    const text = payload.toString('utf8');
    deviceInbox.push([topic, text]);
    const m = /^cmnd\/(plug[12])\/(POWER|STATUS)$/.exec(topic);
    if (!m) return;
    const dev = m[1]!;
    if (m[2] === 'POWER') {
      power[dev] = text;
      device.publish(`stat/${dev}/POWER`, text, { qos: 1 });
    } else {
      device.publish(`stat/${dev}/STATUS11`, JSON.stringify({ StatusSTS: { POWER: power[dev] } }), { qos: 1 });
      device.publish(`stat/${dev}/POWER`, power[dev]!, { qos: 1 });
    }
  });

  aclPath = join(mkdtempSync(join(tmpdir(), 'cinder-iot-')), 'iot-acl.json');
  pushPath = join(mkdtempSync(join(tmpdir(), 'cinder-iot-')), 'iot-push.json');
  ntfy = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      ntfyInbox.push({ path: req.url ?? '', body, ...(typeof req.headers.urgency === 'string' ? { urgency: req.headers.urgency } : {}) });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
  const ntfyAddress = ntfy.address();
  ntfyUrl = `http://127.0.0.1:${typeof ntfyAddress === 'object' && ntfyAddress ? ntfyAddress.port : 0}`;
  bridge = await startIotBridge({
    mqtt: { url: mqttUrl },
    relays: [relayUrl],
    signer: gw,
    home,
    acl: {
      entries: [
        { npub: owner.npub, role: 'owner' },
        { pubkey: operator.pubkey, role: 'operator' },
        { pubkey: viewer.pubkey, role: 'viewer' },
      ],
      rules: [{ topic: 'home/door/#', minRole: 'owner', confirm: true }],
    },
    aclStore: fileIotAclStore(aclPath),
    topicMap: [
      { mqtt: 'stat/plug1/+', topic: 'home/plug1/+', device: 'plug1', dir: 'up' },
      { mqtt: 'tele/plug1/LWT', topic: 'home/plug1/lwt', device: 'plug1', dir: 'up', lwt: true },
      { mqtt: 'stat/plug2/+', topic: 'home/plug2/+', device: 'plug2', dir: 'up' },
      { topic: 'home/plug1/set', mqtt: 'cmnd/plug1/POWER', device: 'plug1', dir: 'down' },
      { topic: 'home/plug2/set', mqtt: 'cmnd/plug2/POWER', device: 'plug2', dir: 'down' },
      { topic: 'home/door/open', mqtt: 'cmnd/door/OPEN', device: 'door', dir: 'down' },
    ],
    queryMap: [{ device: 'plug1', mqtt: 'cmnd/plug1/STATUS', payload: '11' }],
    retainedDebounceMs: 100,
    queryCollectMs: 150,
    queryTimeoutMs: 3_000,
    budget: new RelayEventBudget({ perMinute: 600 }),
    // 推播（ADR 0049 §11.1）：預設的 fetch 送出；抖動 0；允許區網 http（模擬家裡的 ntfy）
    push: { store: fileIotPushStore(pushPath, { allowPrivateHttp: true }), allowPrivateHttp: true, random: () => 0 },
  });
  await sleep(800); // AUTH、訂閱就緒
}, 30_000);

afterAll(async () => {
  for (const c of clients) c.close();
  for (const p of pools) p.close();
  await bridge?.close().catch(() => {});
  device?.end(true);
  await new Promise<void>((resolve) => broker?.close(() => resolve()));
  mqttServer?.close();
  ntfy?.close();
  relay?.close();
});

describe('IoT P0 端到端：Node 中繼＋Aedes＋橋接器＋IotClient', () => {
  let op: IotClient;
  let view: IotClient;
  let own: IotClient;
  beforeAll(async () => {
    op = memberClient(operator);
    view = memberClient(viewer);
    own = memberClient(owner);
    await sleep(800);
  });

  it('指令 → 設備 → ack（中繼只看到密文與盲化標籤）', async () => {
    const r = await op.command('home/plug1/set', 'ON', { timeoutMs: 3_000 });
    expect(r.status).toBe('ok');
    expect(r.attempts).toBe(1);
    expect(deviceInbox).toContainEqual(['cmnd/plug1/POWER', 'ON']);
  }, 20_000);

  it('retained 讀回（31170，不打擾設備）與 listDevices', async () => {
    expect(await until(async () => (await view.getRetained('plug1'))?.topics['home/plug1/POWER']?.payload === 'ON')).toBe(true);
    const snap = await view.getRetained('plug1');
    expect(snap).toMatchObject({ device: 'plug1', stale: false, complete: true });
    const devices = await view.listDevices();
    expect(devices.map((d) => d.device)).toContain('plug1');
  }, 20_000);

  it('MQTT 萬用字元：+ 與 # 都收得到，前綴不同的收不到', async () => {
    const plus: IotStateMessage[] = [];
    const hash: IotStateMessage[] = [];
    const onlyPlug1: IotStateMessage[] = [];
    const a = view.subscribeState('home/+/POWER', (m) => plus.push(m));
    const b = view.subscribeState('home/#', (m) => hash.push(m));
    const c = view.subscribeState('home/plug1/#', (m) => onlyPlug1.push(m));
    // 中繼看得到的：只有密文與盲化標籤
    const raw: string[] = [];
    const rawSub = pools[1]!.subscribe([{ kinds: [25172], authors: [gw.pubkey], '#h': [home.homeTag] }], {
      onEvent: (e) => void raw.push(JSON.stringify({ tags: e.tags.flat(), content: e.content })),
    });
    await sleep(500);
    expect((await op.command('home/plug2/set', 'ON')).status).toBe('ok');
    expect((await op.command('home/plug1/set', 'OFF')).status).toBe('ok');
    expect(await until(() => plus.length >= 2 && hash.length >= 2 && onlyPlug1.length >= 1)).toBe(true);
    await sleep(300);
    expect(plus.map((m) => m.topic).sort()).toEqual(['home/plug1/POWER', 'home/plug2/POWER']);
    expect(hash.map((m) => m.topic).sort()).toEqual(['home/plug1/POWER', 'home/plug2/POWER']);
    expect(onlyPlug1.map((m) => `${m.topic}=${m.payload}`)).toEqual(['home/plug1/POWER=OFF']);
    expect(plus.find((m) => m.topic === 'home/plug2/POWER')).toMatchObject({ device: 'plug2', payload: 'ON', live: true });
    expect(raw.length).toBeGreaterThanOrEqual(2);
    for (const line of raw) {
      const { tags, content } = JSON.parse(line) as { tags: string[]; content: string };
      expect(tags.some((t) => /home\/|plug|POWER/.test(t))).toBe(false);
      expect(() => JSON.parse(content) as unknown).toThrow(); // NIP-44 密文，不是 JSON 明文
    }
    rawSub.close();
    a.close();
    b.close();
    c.close();
  }, 30_000);

  it('查詢 → 設備立刻回報（不是 retained）；5 秒內再查被節流、以 retained 回覆', async () => {
    const live: IotStateMessage[] = [];
    const sub = view.subscribeState('home/plug1/#', (m) => live.push(m));
    await sleep(400);
    const before = deviceInbox.filter(([t]) => t === 'cmnd/plug1/STATUS').length;
    const q = await view.query('plug1');
    expect(q.status).toBe('ok');
    expect(q.fromRetained).toBe(false);
    expect(q.state?.topics['home/plug1/STATUS11']?.payload).toContain('StatusSTS');
    expect(deviceInbox.filter(([t]) => t === 'cmnd/plug1/STATUS').length).toBe(before + 1);
    expect(await until(() => live.some((m) => m.topic === 'home/plug1/STATUS11' && m.inReplyTo !== undefined))).toBe(true);

    const again = await view.query('plug1');
    expect(again.status).toBe('throttled');
    expect(again.fromRetained).toBe(true);
    expect(again.state?.topics['home/plug1/POWER']?.payload).toBe('OFF');
    expect(deviceInbox.filter(([t]) => t === 'cmnd/plug1/STATUS').length).toBe(before + 1); // 沒有打擾設備
    sub.close();
  }, 30_000);

  it('viewer 下指令被拒（not-allowed），設備什麼都沒收到；不在名單的人也一樣', async () => {
    const count = deviceInbox.length;
    expect((await view.command('home/plug1/set', 'ON')).status).toBe('not-allowed');
    const stranger = memberClient(outsider);
    await sleep(500);
    expect((await stranger.command('home/plug1/set', 'ON', { retries: 0 })).status).toBe('not-allowed');
    expect((await stranger.query('plug1')).status).toBe('not-allowed');
    await sleep(300);
    expect(deviceInbox.length).toBe(count);
  }, 30_000);

  it('owner 改名單（$sys/acl）：viewer 升為 operator 後能操作；名單寫進閘道本地檔；非 owner 改不了', async () => {
    expect(await view.myRole()).toBe('viewer');
    const denied = await op.updateAcl({ op: 'add', entry: { pubkey: operator.pubkey, role: 'owner' } });
    expect(denied.status).toBe('not-allowed');
    const r = await own.updateAcl({ op: 'add', entry: { pubkey: viewer.pubkey, role: 'operator', devices: ['plug*'] } });
    expect(r.status).toBe('ok');
    expect(await until(async () => (await view.myRole()) === 'operator')).toBe(true);
    expect((await view.command('home/plug2/set', 'OFF')).status).toBe('ok');
    const saved = JSON.parse(readFileSync(aclPath, 'utf8')) as { entries: { pubkey: string; role: string }[] };
    expect(saved.entries.find((e) => e.pubkey === viewer.pubkey)?.role).toBe('operator');
    expect(saved.entries.find((e) => e.pubkey === operator.pubkey)?.role).toBe('operator');
    // 不能移除最後一位 owner
    expect((await own.updateAcl({ op: 'remove', pubkey: owner.pubkey })).status).toBe('rejected');
  }, 30_000);

  it('minRole 與 confirm：門鎖只有 owner、而且要明確確認', async () => {
    expect((await op.command('home/door/open', 'PULSE', { confirmed: true })).status).toBe('not-allowed');
    const unconfirmed = await own.command('home/door/open', 'PULSE');
    expect(unconfirmed).toMatchObject({ status: 'rejected', reason: 'confirm-required' });
    expect((await own.command('home/door/open', 'PULSE', { confirmed: true })).status).toBe('ok');
    expect(deviceInbox.filter(([t]) => t === 'cmnd/door/OPEN')).toHaveLength(1);
  }, 30_000);

  it('QoS 1：第一次送出的事件被弄丟 → 逾時重送，每次重新簽章（新 id）、同一個 msgId；設備只執行一次', async () => {
    const sentCommands: { id: string; content: string; pubkey: string }[] = [];
    let dropped = false;
    const lossy = (url: string): SocketLike => {
      const ws = new WebSocket(url);
      return {
        get readyState() {
          return ws.readyState;
        },
        send(data: string) {
          const msg = JSON.parse(data) as unknown[];
          if (msg[0] === 'EVENT' && (msg[1] as { kind: number }).kind === IOT_KIND_COMMAND) {
            const ev = msg[1] as { id: string; content: string; pubkey: string };
            sentCommands.push(ev);
            if (!dropped) {
              dropped = true;
              return; // 弄丟第一次
            }
          }
          ws.send(data);
        },
        close: () => ws.close(),
        addEventListener: (type: 'open' | 'message' | 'close' | 'error', listener: SocketListener) => ws.addEventListener(type, listener as (e: Event) => void),
      };
    };
    const flaky = memberClient(operator, { createSocket: lossy, publishTimeoutMs: 500 });
    await sleep(800);
    const r = await flaky.command('home/plug2/set', 'QOS1', { timeoutMs: 800, retries: 2 });
    expect(r.status).toBe('ok');
    expect(r.attempts).toBe(2);
    expect(sentCommands).toHaveLength(2);
    expect(sentCommands[0]!.id).not.toBe(sentCommands[1]!.id);
    const keyring = new IotKeyring(home, gw);
    const bodies = sentCommands.map((e) => keyring.open(e.content, e.pubkey));
    expect(bodies[0]?.msgId).toBe(r.msgId);
    expect(bodies[1]?.msgId).toBe(r.msgId);
    await sleep(300);
    expect(deviceInbox.filter(([t, p]) => t === 'cmnd/plug2/POWER' && p === 'QOS1')).toHaveLength(1);
  }, 30_000);

  it('去重：同一個 msgId 的兩顆事件（各自簽章）→ 設備只執行一次，兩次都回 ok（冪等）', async () => {
    const pool = pools[0]!; // op 的連線池
    const acks: string[] = [];
    const keyring = new IotKeyring(home, operator);
    const msgId = newIotMsgId();
    const sub = pool.subscribe([{ kinds: [IOT_KIND_ACK], authors: [gw.pubkey], '#p': [operator.pubkey] }], {
      onEvent: (event) => {
        const body = keyring.open(event.content, event.pubkey);
        if (body?.type === 'ack' && body.inReplyTo === msgId) acks.push(body.status);
      },
    });
    await sleep(300);
    const ts = Date.now();
    const body = { v: 1 as const, type: 'cmd' as const, msgId, ts, topic: 'home/plug1/set', payload: 'DEDUPE', enc: 'utf8' as const, qos: 1 as const };
    const tags = [['h', home.homeTag], ['t', home.blind('home/plug1/set')], ['p', gw.pubkey], ['expiration', String(Math.floor(ts / 1000) + 30)]];
    const first = buildIotEvent(keyring, operator, IOT_KIND_COMMAND, tags, body);
    const second = buildIotEvent(keyring, operator, IOT_KIND_COMMAND, tags, body);
    expect(first.id).not.toBe(second.id);
    expect((await pool.publish(first as never)).accepted).toHaveLength(1);
    await sleep(200);
    expect((await pool.publish(second as never)).accepted).toHaveLength(1);
    expect(await until(() => acks.length >= 2)).toBe(true);
    expect(acks).toEqual(['ok', 'ok']);
    await sleep(300);
    expect(deviceInbox.filter(([, p]) => p === 'DEDUPE')).toHaveLength(1);
    sub.close();
  }, 30_000);

  it('過期與時間窗外的指令被拒收，設備不執行', async () => {
    const pool = pools[0]!;
    const keyring = new IotKeyring(home, operator);
    const statuses = new Map<string, string>();
    const sub = pool.subscribe([{ kinds: [IOT_KIND_ACK], authors: [gw.pubkey], '#p': [operator.pubkey] }], {
      onEvent: (event) => {
        const body = keyring.open(event.content, event.pubkey);
        if (body?.type === 'ack') statuses.set(body.inReplyTo, `${body.status}:${body.reason ?? ''}`);
      },
    });
    await sleep(300);
    const now = Date.now();
    const expired = await (async () => {
      const msgId = newIotMsgId();
      const ts = now - 20_000;
      const event = buildIotEvent(keyring, operator, IOT_KIND_COMMAND, [['h', home.homeTag], ['t', home.blind('home/plug1/set')], ['p', gw.pubkey], ['expiration', String(Math.floor(now / 1000) - 1)]], {
        v: 1, type: 'cmd', msgId, ts, topic: 'home/plug1/set', payload: 'EXPIRED', enc: 'utf8', qos: 1,
      });
      await pool.publish(event as never);
      return msgId;
    })();
    const stale = await (async () => {
      const msgId = newIotMsgId();
      const ts = now - 60_000;
      const event = buildIotEvent(keyring, operator, IOT_KIND_COMMAND, [['h', home.homeTag], ['t', home.blind('home/plug1/set')], ['p', gw.pubkey], ['expiration', String(Math.floor(now / 1000) + 30)]], {
        v: 1, type: 'cmd', msgId, ts, topic: 'home/plug1/set', payload: 'STALE', enc: 'utf8', qos: 1,
      });
      await pool.publish(event as never);
      return msgId;
    })();
    expect(await until(() => statuses.has(expired) && statuses.has(stale))).toBe(true);
    expect(statuses.get(expired)).toBe('rejected:expired');
    expect(statuses.get(stale)).toBe('rejected:stale');
    await sleep(300);
    expect(deviceInbox.filter(([, p]) => ['EXPIRED', 'STALE'].includes(p))).toEqual([]);
    sub.close();
  }, 30_000);

  it('事件預算：IotClient 預設與同一身分共用 sharedRelayEventBudget；預算用完就等', async () => {
    const shared = memberClient(operator, { budget: 'shared' });
    await sleep(500);
    sharedRelayEventBudget(operator.pubkey).backoff(700); // 同一身分的其他元件被限速了
    const t0 = Date.now();
    expect((await shared.command('home/plug2/set', 'SHARED')).status).toBe('ok');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(650);

    const waits: number[] = [];
    const tight = memberClient(operator, { budget: new RelayEventBudget({ perMinute: 2, sleep: async (ms) => void waits.push(ms) }) });
    await sleep(500);
    for (const p of ['B1', 'B2', 'B3']) await tight.command('home/plug2/set', p, { qos: 0, timeoutMs: 1_000 });
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...waits)).toBeGreaterThan(50_000);
  }, 30_000);

  it('心跳：閘道在線；心跳過期＝離線（不靠中繼代發遺囑）', async () => {
    const statuses: IotGatewayStatus[] = [];
    const stop = view.watchGateway((s) => statuses.push(s));
    expect(await until(() => statuses.some((s) => s.online))).toBe(true);
    stop();

    // 第二個閘道：時鐘往回撥 44 秒、心跳 15 秒 ⇒ expiration ≈ 現在＋1 秒，之後不再發
    const gw2 = Identity.generate();
    const pool2 = new RelayPool({ urls: [relayUrl], identity: gw2 });
    pool2.connect();
    pools.push(pool2);
    const offset = 44_000;
    const g2 = new IotGateway({ pool: pool2, signer: gw2, home, handler: { command: () => ({ status: 'ok' }) }, acl: [{ pubkey: owner.pubkey, role: 'owner' }], heartbeatSec: 15, now: () => Date.now() - offset, budget: new RelayEventBudget() });
    await sleep(500);
    await g2.start();
    const watcherPool = pools[1]!;
    const watcher = new IotClient({ pool: watcherPool, signer: viewer, home, gateway: gw2.pubkey, budget: new RelayEventBudget() });
    clients.push(watcher);
    const seen: IotGatewayStatus[] = [];
    const stop2 = watcher.watchGateway((s) => seen.push(s));
    expect(await until(() => seen.some((s) => s.online), 5_000)).toBe(true);
    expect(await until(() => seen.at(-1)?.online === false, 5_000)).toBe(true);
    stop2();
    await g2.stop({ announceOffline: false });
  }, 30_000);

  it('推播：viewer 登記家裡的 ntfy（加密指令到 $sys/push）；設備狀態有變化 → 真的 POST 一則空的喚醒；撤銷後不再送', async () => {
    const endpoint = { type: 'unifiedpush' as const, url: `${ntfyUrl}/up-viewer-topic` };
    expect((await view.registerPush(endpoint, [{ device: 'plug2', mode: 'instant' }])).status).toBe('ok');
    expect(JSON.parse(readFileSync(pushPath, 'utf8'))).toHaveLength(1);
    expect((await op.command('home/plug2/set', 'OFF')).status).toBe('ok');
    expect(await until(() => ntfyInbox.length >= 1)).toBe(true);
    expect(ntfyInbox[0]).toEqual({ path: '/up-viewer-topic', body: '', urgency: 'high' });
    expect((await view.revokePush(endpoint)).status).toBe('ok');
    expect(JSON.parse(readFileSync(pushPath, 'utf8'))).toEqual([]);
    const before = ntfyInbox.length;
    expect((await op.command('home/plug2/set', 'ON')).status).toBe('ok');
    await sleep(1_000);
    expect(ntfyInbox.length).toBe(before);
  }, 30_000);

  it('閘道正常關閉時先發 online: false', async () => {
    const statuses: IotGatewayStatus[] = [];
    const stop = view.watchGateway((s) => statuses.push(s));
    expect(await until(() => statuses.some((s) => s.online))).toBe(true);
    await bridge.close();
    expect(await until(() => statuses.at(-1)?.online === false)).toBe(true);
    stop();
  }, 30_000);
});
