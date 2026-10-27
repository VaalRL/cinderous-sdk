// C′ 即時通道的家庭核心（SDK ADR 0049 §9、R1）：relay 的轉送半＋設備連線。平台無關，Workers DO 與 Node 宿主共用。
// 以真的 RelayCore 當手機端、假的設備連線測整條路：手機 25170 → relay 授權、剝外層 → 設備幀 → 設備 ack → 25171 給下指令的人。
import { describe, expect, it } from 'vitest';
import {
  deriveIotHome,
  encodeIotDeviceFrame,
  generateIotDeviceToken,
  hashIotDeviceToken,
  IOT_KIND_ACK,
  IOT_KIND_COMMAND,
  IOT_KIND_QUERY,
  IOT_KIND_RETAINED,
  IOT_KIND_STATE,
  newIotMsgId,
  openIotEnvelope,
  parseIotBody,
  parseIotDeviceFrame,
  sealIotEnvelope,
  type IotDeviceEnvelope,
} from '../../src/iot/index.js';
import { decryptDM, encryptDM } from '../../src/protocol/nip44.js';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { MessageStore } from '../../src/relay/message-store.js';
import { RelayCore, type Outbound } from '../../src/relay/relay-core.js';
import {
  IotRealtimeHome,
  parseIotRealtimeConfig,
  type IotRealtimeHomeConfig,
  type IotRealtimeSockets,
} from '../../src/relay/iot-realtime.js';

const SECRET = '22'.repeat(32);
const home = deriveIotHome(SECRET);
const gwSk = generateSecretKey();
const gwPk = getPublicKey(gwSk);
const owner = generateSecretKey();
const operator = generateSecretKey();
const viewer = generateSecretKey();
const lampOnly = generateSecretKey();
const doorToken = generateIotDeviceToken();
const lampToken = generateIotDeviceToken();
const T0 = 1_760_000_000_000;

function config(over: Partial<IotRealtimeHomeConfig> = {}): IotRealtimeHomeConfig {
  return {
    homeTag: home.homeTag,
    homePub: home.homePub,
    gatewayPubkey: gwPk,
    acl: [
      { pubkey: getPublicKey(owner), role: 'owner' },
      { pubkey: getPublicKey(operator), role: 'operator' },
      { pubkey: getPublicKey(viewer), role: 'viewer' },
      { pubkey: getPublicKey(lampOnly), role: 'operator', devices: ['lamp'] },
    ],
    devices: [
      { id: 'door', blindId: home.blind('dev:door'), epoch: 0, tokenHash: hashIotDeviceToken(doorToken), class: 'lock', minRole: 'owner', localFallback: ['key'] },
      { id: 'lamp', blindId: home.blind('dev:lamp'), epoch: 1, tokenHash: hashIotDeviceToken(lampToken) },
    ],
    ...over,
  };
}

/** 假的設備連線：記下送給每台設備的幀；可以設定在不在線、最後心跳 */
function fakeSockets() {
  const sent = new Map<string, string[]>();
  const online = new Set<string>();
  const heartbeat = new Map<string, number>();
  const sockets: IotRealtimeSockets = {
    isConnected: (b) => online.has(b),
    lastHeartbeatMs: (b) => heartbeat.get(b),
    send: (b, text) => {
      if (!online.has(b)) return false;
      sent.set(b, [...(sent.get(b) ?? []), text]);
      return true;
    },
  };
  return { sockets, sent, online, heartbeat };
}

function setup(over: Partial<IotRealtimeHomeConfig> = {}, opts: { now?: () => number } = {}) {
  let now = T0;
  const clock = opts.now ?? (() => now);
  const s = fakeSockets();
  const rt = new IotRealtimeHome(config(over), gwSk, { sockets: s.sockets, now: clock });
  const core: RelayCore = new RelayCore({
    now: () => Math.floor(clock() / 1000),
    store: new MessageStore(),
    intercept: (connId, event, authed): Outbound[] | undefined => {
      const r = rt.interceptPhoneEvent(connId, event, authed);
      if (!r) return undefined;
      return [...r.outbound, ...r.publish.flatMap((e) => core.publishLocal(e))];
    },
  });
  const fromDevice = (blindId: string, frame: string): Outbound[] => rt.onDeviceFrame(blindId, frame).publish.flatMap((e) => core.publishLocal(e));
  return { rt, core, s, fromDevice, advance: (ms: number) => (now += ms), nowMs: () => clock() };
}

const keyLamp = home.deviceKey('lamp', 1);
const keyDoor = home.deviceKey('door', 0);

function downEnv(device: string, epoch: number, key: Uint8Array, nowMs: number, text = 'ON'): IotDeviceEnvelope {
  return sealIotEnvelope({ key, kid: `${device}.${epoch}`, dir: 'down', ctr: 1, ts: Math.floor(nowMs / 1000), plaintext: text });
}

/** 手機送一則 C′ 指令（外層 NIP-44 給閘道） */
function phoneEvent(sk: Uint8Array, kind: number, body: Record<string, unknown>, nowMs: number, tags: string[][] = []): NostrEvent {
  const device = String(body.device ?? '');
  return finalizeEvent(
    {
      kind,
      created_at: Math.floor(nowMs / 1000),
      tags: [['h', home.homeTag], ['p', gwPk], ['dv', home.blind(`dev:${device}`)], ['expiration', String(Math.floor(nowMs / 1000) + 15)], ...tags],
      content: encryptDM(JSON.stringify({ v: 1, ts: nowMs, msgId: newIotMsgId(), ...body }), sk, gwPk),
    },
    sk,
  );
}

const EVENT = (e: NostrEvent) => JSON.stringify(['EVENT', e]);
const REQ = (sub: string, filter: object) => JSON.stringify(['REQ', sub, filter]);
const eventsTo = (out: Outbound[], conn: string) => out.filter((o) => o.to === conn && o.message[0] === 'EVENT').map((o) => o.message[2] as NostrEvent);
/** 以 homeKey 解開 relay（閘道）發給全家的內容 */
const openHome = (e: NostrEvent) => parseIotBody(JSON.parse(decryptDM(e.content, home.homeKey, e.pubkey)));

describe('設定（parseIotRealtimeConfig）', () => {
  it('合法設定沒有問題；閘道金鑰與公鑰相符', () => {
    const r = parseIotRealtimeConfig({ homes: [config()] }, { [home.homeTag]: bytesToHex(gwSk) });
    expect(r.issues).toEqual([]);
    expect(r.homes.get(home.homeTag)?.config.devices).toHaveLength(2);
  });

  it('門鎖類設備沒有本地開啟方式、重複的設備、壞權杖雜湊、閘道金鑰不符或缺少 → 逐項列出', () => {
    const bad = config({
      devices: [
        { id: 'door', blindId: home.blind('dev:door'), epoch: 0, tokenHash: 'x', class: 'lock' },
        { id: 'door', blindId: home.blind('dev:door'), epoch: 0, tokenHash: hashIotDeviceToken(doorToken) },
      ],
    });
    const r = parseIotRealtimeConfig({ homes: [bad] }, { [home.homeTag]: bytesToHex(generateSecretKey()) });
    const codes = r.issues.map((i) => i.code).sort();
    expect(codes).toEqual(['device-duplicate', 'gateway-key-mismatch', 'lock-local-fallback', 'token-hash'].sort());
    expect(parseIotRealtimeConfig({ homes: [config()] }, {}).issues.map((i) => i.code)).toEqual(['gateway-key-missing']);
  });
});

describe('設備連線的權杖（Worker 在碰 DO 之前驗）', () => {
  it('權杖對 → ok；錯 → 401 restricted: iot-token:；沒這台設備 → 404 restricted: iot-device:', () => {
    const { rt } = setup();
    expect(rt.authenticateDevice(home.blind('dev:lamp'), `Bearer ${lampToken}`)).toMatchObject({ ok: true, device: { id: 'lamp' } });
    const wrong = rt.authenticateDevice(home.blind('dev:lamp'), `Bearer ${doorToken}`);
    expect(wrong).toMatchObject({ ok: false, status: 401 });
    expect(wrong.ok === false && wrong.error).toMatch(/^restricted: iot-token:/);
    expect(rt.authenticateDevice(home.blind('dev:lamp'), undefined)).toMatchObject({ ok: false, status: 401 });
    const missing = rt.authenticateDevice('A'.repeat(22), `Bearer ${lampToken}`);
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });
});

describe('手機 → 設備：轉送半（ADR 0049 §2.6 第 2 步、§9.4）', () => {
  it('operator 對在線設備下指令：設備收到同一個 down 信封；設備回 ack → 25171 只給下指令的人，內含 up 信封', () => {
    const { core, s, fromDevice, nowMs } = setup();
    const lamp = home.blind('dev:lamp');
    s.online.add(lamp);
    s.heartbeat.set(lamp, nowMs());
    core.connect('op');
    core.connect('other');
    core.handle('op', REQ('a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(operator)], '#h': [home.homeTag] }));
    core.handle('other', REQ('a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(viewer)], '#h': [home.homeTag] }));
    const env = downEnv('lamp', 1, keyLamp, nowMs());
    const cmd = phoneEvent(operator, IOT_KIND_COMMAND, { type: 'dev-cmd', device: 'lamp', env }, nowMs());
    const out = core.handle('op', EVENT(cmd));
    expect(out[0]).toEqual({ to: 'op', message: ['OK', cmd.id, true, ''] });
    const frames = (s.sent.get(lamp) ?? []).map((f) => parseIotDeviceFrame(f, 'relay'));
    expect(frames).toEqual([{ t: 'cmd', env }]);
    // 設備回 ack（up 信封）
    const up = sealIotEnvelope({ key: keyLamp, kid: 'lamp.1', dir: 'up', ctr: 3, ts: Math.floor(nowMs() / 1000), plaintext: '{"type":"ack","status":"ok"}' });
    const fanned = fromDevice(lamp, encodeIotDeviceFrame({ t: 'ack', env: up }));
    const acks = eventsTo(fanned, 'op');
    expect(acks).toHaveLength(1);
    expect(eventsTo(fanned, 'other')).toHaveLength(0);
    expect(acks[0]!.pubkey).toBe(gwPk);
    expect(acks[0]!.tags).toContainEqual(['e', cmd.id]);
    const body = openHome(acks[0]!);
    expect(body).toMatchObject({ type: 'dev-ack', device: 'lamp', env: up });
    expect(new TextDecoder().decode(openIotEnvelope((body as { env: IotDeviceEnvelope }).env, keyLamp))).toContain('"ok"');
  });

  it('設備沒有連線 → 立刻回 25171 offline（即時等級不排隊）', () => {
    const { core, s, nowMs } = setup();
    core.connect('op');
    core.handle('op', REQ('a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(operator)] }));
    const cmd = phoneEvent(operator, IOT_KIND_COMMAND, { type: 'dev-cmd', device: 'lamp', env: downEnv('lamp', 1, keyLamp, nowMs()) }, nowMs());
    const out = core.handle('op', EVENT(cmd));
    const ack = openHome(eventsTo(out, 'op')[0]!);
    expect(ack).toMatchObject({ type: 'ack', status: 'offline', device: 'lamp' });
    expect(s.sent.size).toBe(0);
  });

  it('連線還在但心跳過期 → stale，不送', () => {
    const { core, s, nowMs } = setup();
    const lamp = home.blind('dev:lamp');
    s.online.add(lamp);
    s.heartbeat.set(lamp, nowMs() - 5 * 60_000);
    core.connect('op');
    core.handle('op', REQ('a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(operator)] }));
    const out = core.handle('op', EVENT(phoneEvent(operator, IOT_KIND_COMMAND, { type: 'dev-cmd', device: 'lamp', env: downEnv('lamp', 1, keyLamp, nowMs()) }, nowMs())));
    expect(openHome(eventsTo(out, 'op')[0]!)).toMatchObject({ status: 'stale' });
    expect(s.sent.size).toBe(0);
  });

  it('viewer 下指令 → not-allowed、不送；viewer 查詢 → 送 query 幀', () => {
    const { core, s, nowMs } = setup();
    const lamp = home.blind('dev:lamp');
    s.online.add(lamp);
    s.heartbeat.set(lamp, nowMs());
    core.connect('v');
    core.handle('v', REQ('a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(viewer)] }));
    const out = core.handle('v', EVENT(phoneEvent(viewer, IOT_KIND_COMMAND, { type: 'dev-cmd', device: 'lamp', env: downEnv('lamp', 1, keyLamp, nowMs()) }, nowMs())));
    expect(openHome(eventsTo(out, 'v')[0]!)).toMatchObject({ status: 'not-allowed' });
    expect(s.sent.size).toBe(0);
    core.handle('v', EVENT(phoneEvent(viewer, IOT_KIND_QUERY, { type: 'dev-query', device: 'lamp', env: downEnv('lamp', 1, keyLamp, nowMs(), '?') }, nowMs())));
    expect((s.sent.get(lamp) ?? []).map((f) => parseIotDeviceFrame(f, 'relay')?.t)).toEqual(['query']);
  });

  it('依設備細分（只能碰 lamp 的 operator 開不了 door）；門鎖設定 minRole: owner（operator 也不行）', () => {
    const { core, s, nowMs } = setup();
    for (const b of [home.blind('dev:door'), home.blind('dev:lamp')]) {
      s.online.add(b);
      s.heartbeat.set(b, nowMs());
    }
    const send = (sk: Uint8Array, device: string, key: Uint8Array, epoch: number) => {
      core.connect('c');
      core.handle('c', REQ('a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(sk)] }));
      const out = core.handle('c', EVENT(phoneEvent(sk, IOT_KIND_COMMAND, { type: 'dev-cmd', device, env: downEnv(device, epoch, key, nowMs()) }, nowMs())));
      core.disconnect('c');
      return eventsTo(out, 'c').map((e) => openHome(e)) as { status?: string }[];
    };
    expect(send(lampOnly, 'door', keyDoor, 0)[0]?.status).toBe('not-allowed');
    expect(send(operator, 'door', keyDoor, 0)[0]?.status).toBe('not-allowed');
    expect(send(owner, 'door', keyDoor, 0)).toEqual([]); // 送出了，等設備 ack
    expect(s.sent.get(home.blind('dev:door'))).toHaveLength(1);
  });

  it('kid 的 epoch 不是目前的 → OK false invalid: iot-e2ee:；dv 與 device 不一致 → invalid', () => {
    const { core, s, nowMs } = setup();
    s.online.add(home.blind('dev:lamp'));
    s.heartbeat.set(home.blind('dev:lamp'), nowMs());
    core.connect('op');
    const stale = phoneEvent(operator, IOT_KIND_COMMAND, { type: 'dev-cmd', device: 'lamp', env: downEnv('lamp', 0, home.deviceKey('lamp', 0), nowMs()) }, nowMs());
    expect(core.handle('op', EVENT(stale))[0]!.message).toEqual(['OK', stale.id, false, expect.stringMatching(/^invalid: iot-e2ee:/)]);
    const mismatch = finalizeEvent({ ...stale, tags: stale.tags.map((t) => (t[0] === 'dv' ? ['dv', home.blind('dev:door')] : t)), content: stale.content }, operator);
    expect(core.handle('op', EVENT(mismatch))[0]!.message[2]).toBe(false);
    expect(s.sent.size).toBe(0);
  });

  it('外層解不開、不是這個家、p 不是閘道 → OK false；同一個 msgId 重送 → OK true、不再送給設備（冪等）', () => {
    const { core, s, nowMs } = setup();
    s.online.add(home.blind('dev:lamp'));
    s.heartbeat.set(home.blind('dev:lamp'), nowMs());
    core.connect('op');
    const junk = finalizeEvent({ kind: IOT_KIND_COMMAND, created_at: Math.floor(nowMs() / 1000), tags: [['h', home.homeTag], ['p', gwPk]], content: 'garbage' }, operator);
    expect(core.handle('op', EVENT(junk))[0]!.message[2]).toBe(false);
    const otherHome = finalizeEvent({ ...junk, tags: [['h', 'B'.repeat(22)], ['p', gwPk]] }, operator);
    expect(core.handle('op', EVENT(otherHome))[0]!.message[2]).toBe(false);
    const body = { type: 'dev-cmd', device: 'lamp', env: downEnv('lamp', 1, keyLamp, nowMs()), msgId: newIotMsgId() };
    const first = phoneEvent(operator, IOT_KIND_COMMAND, body, nowMs());
    const again = phoneEvent(operator, IOT_KIND_COMMAND, body, nowMs()); // 重新簽章（新 id）、同一個 msgId
    core.handle('op', EVENT(first));
    expect(core.handle('op', EVENT(again))[0]!.message).toEqual(['OK', again.id, true, expect.stringMatching(/duplicate/)]);
    expect(s.sent.get(home.blind('dev:lamp'))).toHaveLength(1);
  });

  it('只有閘道能發的 kind（25171、25172、31170、31171）手機送來一律拒收', () => {
    const { core } = setup();
    core.connect('x');
    for (const kind of [IOT_KIND_ACK, IOT_KIND_STATE]) {
      const e = finalizeEvent({ kind, created_at: Math.floor(T0 / 1000), tags: [['h', home.homeTag]], content: 'x' }, viewer);
      expect(core.handle('x', EVENT(e))[0]!.message).toEqual(['OK', e.id, false, expect.stringMatching(/^restricted: iot-gateway-only:/)]);
    }
  });

  it('dev-link：relay 直接回答設備連著沒、最後心跳（不打擾設備、不落庫）', () => {
    const { core, s, nowMs } = setup();
    const lamp = home.blind('dev:lamp');
    s.online.add(lamp);
    s.heartbeat.set(lamp, nowMs() - 1000);
    core.connect('v');
    core.handle('v', REQ('a', { kinds: [IOT_KIND_ACK], '#p': [getPublicKey(viewer)] }));
    const out = core.handle('v', EVENT(phoneEvent(viewer, IOT_KIND_QUERY, { type: 'dev-link', device: 'lamp' }, nowMs())));
    expect(openHome(eventsTo(out, 'v')[0]!)).toMatchObject({ type: 'ack', status: 'ok', online: true, lastHeartbeat: nowMs() - 1000 });
    expect(s.sent.size).toBe(0);
  });
});

describe('設備 → 全家：狀態（ADR 0049 §9.4）', () => {
  it('state → 25172 給訂了這個家的人；retained 31170 寫入，每台至少隔 5 分鐘才再寫', () => {
    const { core, fromDevice, advance, nowMs } = setup();
    const lamp = home.blind('dev:lamp');
    core.connect('w');
    core.handle('w', REQ('s', { kinds: [IOT_KIND_STATE], '#h': [home.homeTag] }));
    const state = (ctr: number) =>
      encodeIotDeviceFrame({ t: 'state', env: sealIotEnvelope({ key: keyLamp, kid: 'lamp.1', dir: 'up', ctr, ts: Math.floor(nowMs() / 1000), plaintext: `{"n":${ctr}}` }) });
    const first = fromDevice(lamp, state(1));
    const live = eventsTo(first, 'w');
    expect(live).toHaveLength(1);
    expect(live[0]!.tags).toContainEqual(['d', lamp]);
    expect(openHome(live[0]!)).toMatchObject({ type: 'dev-state', device: 'lamp' });
    const retained = () => {
      core.connect('r');
      const out = core.handle('r', REQ('q', { kinds: [IOT_KIND_RETAINED], '#h': [home.homeTag] }));
      core.disconnect('r');
      return out.filter((o) => o.message[0] === 'EVENT').map((o) => openHome(o.message[2] as NostrEvent) as { env: IotDeviceEnvelope });
    };
    expect(retained().map((b) => b.env.ctr)).toEqual([1]);
    advance(60_000);
    fromDevice(lamp, state(2));
    expect(retained().map((b) => b.env.ctr)).toEqual([1]);
    advance(5 * 60_000);
    fromDevice(lamp, state(3));
    expect(retained().map((b) => b.env.ctr)).toEqual([3]);
  });

  it('up ctr 沒有遞增、kid 不是這台設備或目前 epoch、壞幀 → 丟掉', () => {
    const { core, fromDevice, nowMs } = setup();
    const lamp = home.blind('dev:lamp');
    core.connect('w');
    core.handle('w', REQ('s', { kinds: [IOT_KIND_STATE], '#h': [home.homeTag] }));
    const frame = (kid: string, ctr: number) =>
      encodeIotDeviceFrame({ t: 'state', env: sealIotEnvelope({ key: keyLamp, kid, dir: 'up', ctr, ts: Math.floor(nowMs() / 1000), plaintext: 'x' }) });
    expect(eventsTo(fromDevice(lamp, frame('lamp.1', 5)), 'w')).toHaveLength(1);
    expect(eventsTo(fromDevice(lamp, frame('lamp.1', 5)), 'w')).toHaveLength(0);
    expect(eventsTo(fromDevice(lamp, frame('door.0', 9)), 'w')).toHaveLength(0);
    expect(eventsTo(fromDevice(lamp, frame('lamp.0', 9)), 'w')).toHaveLength(0);
    expect(eventsTo(fromDevice(lamp, '{"t":"cmd"}'), 'w')).toHaveLength(0);
  });
});

describe('金鑰輪換寬限（ADR 0049 §2.6）', () => {
  it('previousEpoch 在 until 之前照收、之後拒收', () => {
    const until = Math.floor(T0 / 1000) + 3600;
    const { core, s, advance, nowMs } = setup({
      devices: [{ id: 'lamp', blindId: home.blind('dev:lamp'), epoch: 1, tokenHash: hashIotDeviceToken(lampToken), previousEpoch: { epoch: 0, until } }],
    });
    const lamp = home.blind('dev:lamp');
    s.online.add(lamp);
    s.heartbeat.set(lamp, nowMs());
    core.connect('op');
    const send = () => {
      s.heartbeat.set(lamp, nowMs());
      const e = phoneEvent(operator, IOT_KIND_COMMAND, { type: 'dev-cmd', device: 'lamp', env: downEnv('lamp', 0, home.deviceKey('lamp', 0), nowMs()) }, nowMs());
      return core.handle('op', EVENT(e))[0]!.message[2];
    };
    expect(send()).toBe(true);
    advance(3601_000);
    expect(send()).toBe(false);
  });
});

describe('$sys/acl（只有 owner 能改；名單以 relay 本地為準）', () => {
  it('owner 新增成員後立刻生效並交給儲存；非 owner → not-allowed', () => {
    const saved: unknown[] = [];
    const { core, s, nowMs } = setup();
    const rt2 = new IotRealtimeHome(config(), gwSk, { sockets: s.sockets, now: nowMs, aclStore: { load: () => undefined, save: (acl) => void saved.push(acl) } });
    const newbie = generateSecretKey();
    const op = (sk: Uint8Array, entry: object) =>
      rt2.interceptPhoneEvent('c', finalizeEvent({
        kind: IOT_KIND_COMMAND,
        created_at: Math.floor(nowMs() / 1000),
        tags: [['h', home.homeTag], ['p', gwPk]],
        content: encryptDM(JSON.stringify({ v: 1, type: 'cmd', msgId: newIotMsgId(), ts: nowMs(), topic: '$sys/acl', payload: JSON.stringify({ op: 'add', entry }), enc: 'utf8', qos: 0 }), sk, gwPk),
      }, sk), undefined);
    const denied = op(viewer, { pubkey: getPublicKey(newbie), role: 'operator' });
    expect(openHome(denied!.publish[0]!)).toMatchObject({ status: 'not-allowed' });
    expect(saved).toHaveLength(0);
    const ok = op(owner, { pubkey: getPublicKey(newbie), role: 'operator' });
    expect(openHome(ok!.publish[0]!)).toMatchObject({ status: 'ok' });
    expect(saved).toHaveLength(1);
    expect(rt2.acl().entries.some((e) => e.pubkey === getPublicKey(newbie))).toBe(true);
    void core;
  });
});
