// C′ R2（SDK ADR 0120）端到端：真的 Node 中繼（IOT_REALTIME）＋手機端 IotClient（真的 RelayPool）＋設備端 connectIotDevice（Node 內建 WebSocket）。
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { connectIotDevice, memoryIotDeviceCounterStore, type IotDeviceCommand, type IotDeviceConnection, type IotDeviceLinkState, type IotDeviceOptions } from '../../src/iot/device.js';
import { deriveIotDeviceKeyDown, deriveIotHome, generateIotDeviceToken, generateIotHomeSecret, hashIotDeviceToken, IotClient, type IotClientOptions, type IotStateMessage } from '../../src/iot/index.js';
import { generateSecretKey, getPublicKey } from '../../src/protocol/index.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { RelayEventBudget } from '../../src/relay-budget.js';
import { RelayPool } from '../../src/relay-pool.js';
import { opened } from '../node-relay-harness.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const home = deriveIotHome(generateIotHomeSecret());
const gwSk = generateSecretKey();
const gwPub = getPublicKey(gwSk);
const owner = Identity.generate();
const viewer = Identity.generate();
const operatorSecret = bytesToHex(generateSecretKey());
const tokens: Record<string, string> = { lamp: generateIotDeviceToken(), door: generateIotDeviceToken() };
const lamps = ['lamp1', 'lamp2', 'lamp3', 'lamp4', 'lamp5', 'lamp6'];
for (const id of lamps) tokens[id] = generateIotDeviceToken();
const blind = (id: string) => home.blind(`dev:${id}`);

type LampKey = { epoch: number; previousEpoch?: { epoch: number; until: number } };

function iotEnv(opts: { aclBlindId?: string; lamp?: LampKey } = {}): Record<string, string> {
  return {
    DB_PATH: ':memory:',
    PORT: '0',
    IOT_REALTIME: JSON.stringify({
      homes: [
        {
          homeTag: home.homeTag,
          homePub: home.homePub,
          gatewayPubkey: gwPub,
          acl: [
            { pubkey: owner.pubkey, role: 'owner' },
            { pubkey: viewer.pubkey, role: 'viewer' },
          ],
          devices: [
            { id: 'lamp', blindId: blind('lamp'), epoch: 0, tokenHash: hashIotDeviceToken(tokens.lamp!), ...opts.lamp },
            { id: 'door', blindId: blind('door'), epoch: 0, tokenHash: hashIotDeviceToken(tokens.door!), class: 'lock', minRole: 'operator', localFallback: ['key'] },
            ...lamps.map((id) => ({ id, blindId: blind(id), epoch: 0, tokenHash: hashIotDeviceToken(tokens[id]!) })),
          ],
          ...(opts.aclBlindId !== undefined ? { aclBlindId: opts.aclBlindId } : {}),
        },
      ],
    }),
    IOT_GATEWAY_KEYS: JSON.stringify({ [home.homeTag]: bytesToHex(gwSk) }),
  };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function relay(opts: { aclBlindId?: string; lamp?: LampKey } = {}): Promise<number> {
  const handles: { close(): void }[] = [];
  const port = await opened(handles, startNodeRelay(iotEnv(opts)));
  cleanups.push(() => handles.forEach((h) => h.close()));
  return port;
}

async function phone(port: number, signer: Identity, realtime: Partial<NonNullable<IotClientOptions['realtime']>> = {}): Promise<IotClient> {
  const pool = new RelayPool({ urls: [`ws://127.0.0.1:${port}/iot/v1/home/${home.homeTag}`], identity: signer });
  pool.connect();
  for (let i = 0; i < 100 && ![...pool.status().values()].includes('open'); i++) await sleep(20);
  const client = new IotClient({
    pool,
    signer,
    home,
    gateway: gwPub,
    budget: new RelayEventBudget({ perMinute: 6000 }),
    readTimeoutMs: 1_000,
    realtime: { devices: { lamp: {}, door: { class: 'lock' } }, operatorSecret, ...realtime },
  });
  cleanups.push(() => {
    client.close();
    pool.close();
  });
  return client;
}

async function device(port: number, id: string, opts: Partial<IotDeviceOptions> = {}): Promise<{ dev: IotDeviceConnection; commands: IotDeviceCommand[] }> {
  const commands: IotDeviceCommand[] = [];
  let resolveConnected!: () => void;
  const connected = new Promise<void>((r) => (resolveConnected = r));
  const dev = connectIotDevice({
    url: `ws://127.0.0.1:${port}/iot/v1/dev/${home.homeTag}/${blind(id)}`,
    token: tokens[id]!,
    deviceKey: home.deviceKey(id, 0),
    ...(id === 'door' ? { deviceKeyDown: deriveIotDeviceKeyDown(operatorSecret, 'door', 0), maxSkewSec: 15 } : {}),
    kid: `${id}.0`,
    counterStore: memoryIotDeviceCounterStore(),
    onCommand: (cmd) => {
      commands.push(cmd);
      return { status: 'ok', state: { [`home/${id}/state`]: cmd.payload } };
    },
    onQuery: () => ({ [`home/${id}/state`]: 'QUERIED' }),
    ...opts,
    onLinkState: (s: IotDeviceLinkState, info) => {
      if (s === 'connected') resolveConnected();
      opts.onLinkState?.(s, info);
    },
  });
  cleanups.push(() => dev.close());
  await connected;
  return { dev, commands };
}

describe('手機 → relay → 設備（C′）', () => {
  it('指令往返：設備收到明文、ack 帶回執行後的狀態', async () => {
    const port = await relay();
    const { commands } = await device(port, 'lamp');
    const client = await phone(port, owner);
    const r = await client.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime' });
    expect(r.status).toBe('ok');
    expect(r.attempts).toBe(1);
    expect(r.state?.topics['home/lamp/state']?.payload).toBe('ON');
    expect(commands).toMatchObject([{ topic: 'home/lamp/power', payload: 'ON', enc: 'utf8' }]);
  });

  it('設備沒有連線 → 立刻回 offline（即時等級不排隊，也不必查詢）', async () => {
    const port = await relay();
    const client = await phone(port, owner);
    const started = Date.now();
    const r = await client.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime' });
    expect(r.status).toBe('offline');
    expect(r.after).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('逾時沒有 ack → unknown（不是失敗），並自動查一次，結果在 after', async () => {
    const port = await relay();
    await device(port, 'lamp', { onCommand: () => new Promise(() => {}) }); // 設備執行卡住、ack 永遠不回
    const client = await phone(port, owner);
    const r = await client.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime', ackTimeoutMs: 300 });
    expect(r.status).toBe('unknown');
    expect(r.after?.status).toBe('ok');
    expect(r.after?.fromRetained).toBe(false);
    expect(r.after?.state?.topics['home/lamp/state']?.payload).toBe('QUERIED');
  });

  it('viewer 可以查詢、不能操作（relay 依角色擋）', async () => {
    const port = await relay();
    const { commands } = await device(port, 'lamp');
    const client = await phone(port, viewer, { operatorSecret: undefined });
    expect((await client.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime' })).status).toBe('not-allowed');
    const q = await client.query('lamp', { timeoutMs: 2_000 });
    expect(q.status).toBe('ok');
    expect(q.state?.topics['home/lamp/state']?.payload).toBe('QUERIED');
    expect(commands).toEqual([]);
  });
});

describe('門鎖類與 operatorSecret（ADR 0049 §9.5）', () => {
  it('沒有 operatorSecret 的手機不送門鎖指令；有的才開得了', async () => {
    const port = await relay();
    const { commands } = await device(port, 'door');
    const without = await phone(port, owner, { operatorSecret: undefined });
    const r0 = await without.command('home/door/open', 'PULSE', { device: 'door', urgency: 'realtime', confirmed: true });
    expect(r0).toMatchObject({ status: 'not-allowed', attempts: 0, reason: 'operator-secret' });
    const r1 = await (await phone(port, owner)).command('home/door/open', 'PULSE', { device: 'door', urgency: 'realtime', confirmed: true });
    expect(r1.status).toBe('ok');
    expect(commands).toMatchObject([{ topic: 'home/door/open', payload: 'PULSE', confirmed: true }]);
  });

  it('以 deviceKey 偽造的門鎖指令（viewer 也算得出 deviceKey）relay 照轉，設備解不開、不執行；查詢照常可用', async () => {
    const port = await relay();
    const { commands } = await device(port, 'door');
    // 把門當成一般設備：down 用 deviceKey——這是「viewer＋被攻破的 relay」做得出來的東西
    const forger = await phone(port, owner, { devices: { door: {} }, operatorSecret: undefined });
    const r = await forger.command('home/door/open', 'PULSE', { device: 'door', urgency: 'realtime', confirmed: true, ackTimeoutMs: 400 });
    expect(r.status).toBe('unknown');
    expect(r.after?.state?.topics['home/door/state']?.payload).toBe('QUERIED');
    expect(commands).toEqual([]);
  });
});

describe('NIP-11', () => {
  it('開了 C′ 的 Node 中繼宣告 cinder_iot.realtime（不列家庭）', async () => {
    const port = await relay();
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { Accept: 'application/nostr+json' } });
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.cinder_iot).toEqual({ realtime: { ws: true, longpoll: false, heartbeat_sec: 30 } });
    expect(JSON.stringify(doc)).not.toContain(home.homeTag);
  });
});

describe('deviceLink、狀態與 retained', () => {
  it('deviceLink：relay 以當下的連線回答；設備斷線後變成 online: false', async () => {
    const port = await relay();
    const { dev } = await device(port, 'lamp');
    const client = await phone(port, viewer);
    expect(await client.deviceLink('lamp')).toMatchObject({ transport: 'ws', status: 'ok', online: true });
    dev.close();
    let link = await client.deviceLink('lamp');
    for (let i = 0; i < 20 && link.online !== false; i++) {
      await sleep(50);
      link = await client.deviceLink('lamp');
    }
    expect(link).toMatchObject({ transport: 'ws', status: 'ok', online: false });
  });

  it('設備回報狀態 → 手機的 subscribeState 收到（topic 在信封裡比對）；getRetained 讀得到', async () => {
    const port = await relay();
    const { dev } = await device(port, 'lamp');
    const client = await phone(port, viewer);
    const got: IotStateMessage[] = [];
    const sub = client.subscribeState('home/lamp/#', (m) => got.push(m));
    cleanups.push(() => sub.close());
    await sleep(150);
    expect(await dev.publishState({ 'home/lamp/power': 'OFF', 'home/other/x': '1' })).toBe(true);
    for (let i = 0; i < 40 && got.length === 0; i++) await sleep(25);
    expect(got).toMatchObject([{ topic: 'home/lamp/power', payload: 'OFF', device: 'lamp', live: true }]);
    const retained = await client.getRetained('lamp');
    expect(retained?.topics['home/lamp/power']?.payload).toBe('OFF');
    expect(retained?.complete).toBe(false);
  });
});

describe('SDK ADR 0121：retained 的上限與名單公告', () => {
  it('六台設備各報一次狀態，六顆 retained 都在（家庭儲存的可尋址上限不是嚴格平面的 5）', async () => {
    const port = await relay();
    const devs = await Promise.all(lamps.map((id) => device(port, id)));
    for (const { dev } of devs) expect(await dev.publishState({ 'home/x/power': 'ON' })).toBe(true);
    const client = await phone(port, viewer, { devices: Object.fromEntries(lamps.map((id) => [id, {}])), operatorSecret: undefined });
    await sleep(200);
    const got = await Promise.all(lamps.map((id) => client.getRetained(id)));
    expect(got.map((r) => r?.topics['home/x/power']?.payload)).toEqual(lamps.map(() => 'ON'));
  });

  it('有 aclBlindId：手機連上就讀得到名單（myRole）；owner 改名單後 relay 重發公告', async () => {
    const port = await relay({ aclBlindId: home.blind('sys:acl') });
    const ownerClient = await phone(port, owner);
    await sleep(100);
    expect(await ownerClient.myRole()).toBe('owner');
    const newcomer = Identity.generate();
    expect((await ownerClient.updateAcl({ op: 'add', entry: { pubkey: newcomer.pubkey, role: 'operator' } })).status).toBe('ok');
    const acl = await (await phone(port, viewer)).getAcl();
    expect(acl?.entries.find((e) => e.pubkey === newcomer.pubkey)?.role).toBe('operator');
    // viewer 改不了
    expect((await (await phone(port, viewer)).updateAcl({ op: 'remove', pubkey: newcomer.pubkey })).status).toBe('not-allowed');
  });

  it('沒有 aclBlindId：不公告（myRole 讀不到，與 R2 相同）', async () => {
    const port = await relay();
    const client = await phone(port, owner);
    await sleep(100);
    expect(await client.myRole()).toBeUndefined();
  });
});

describe('金鑰輪換（SDK ADR 0122）', () => {
  const rotated = (): LampKey => ({ epoch: 1, previousEpoch: { epoch: 0, until: Math.floor(Date.now() / 1000) + 3600 } });

  it('🔴 換了 epoch、設備還沒更新：寬限期內手機收得到舊版本的狀態，指令改用設備最近開口的版本——燈照樣開得了', async () => {
    const lamp = rotated();
    const port = await relay({ lamp });
    const { dev, commands } = await device(port, 'lamp');
    const client = await phone(port, owner, { devices: { lamp } });
    const got: IotStateMessage[] = [];
    const sub = client.subscribeState('home/lamp/#', (m) => got.push(m));
    cleanups.push(() => sub.close());
    await sleep(150);
    expect(await dev.publishState({ 'home/lamp/power': 'OFF' })).toBe(true);
    for (let i = 0; i < 40 && got.length === 0; i++) await sleep(25);
    expect(got).toMatchObject([{ topic: 'home/lamp/power', payload: 'OFF', live: true }]);
    const r = await client.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime' });
    expect(r.status).toBe('ok');
    expect(commands.map((c) => c.payload)).toEqual(['ON']);
  });

  it('設備已經換成新版本：手機用新版本（還沒聽過設備開口時預設就是新版本）', async () => {
    const lamp = rotated();
    const port = await relay({ lamp });
    const { commands } = await device(port, 'lamp', { deviceKey: home.deviceKey('lamp', 1), kid: 'lamp.1' });
    const client = await phone(port, owner, { devices: { lamp } });
    const r = await client.command('home/lamp/power', 'ON', { device: 'lamp', urgency: 'realtime' });
    expect(r.status).toBe('ok');
    expect(commands).toHaveLength(1);
  });
});
