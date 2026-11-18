// C′ R5 Shelly 明文轉譯（SDK ADR 0139）：Shelly Gen2+ 以 Outbound WebSocket（`Ws.SetConfig { server }`）連進 relay，講明文 JSON-RPC。
// relay 替它扮演設備：用**這台設備的** deviceKey 解開 down 信封 → `Switch.Set`／`Switch.Toggle`／`Shelly.GetStatus`；
// RPC 結果與 `NotifyStatus` 封成 up 信封（ack／state）交給家庭核心——手機端看到的與 E2EE 設備完全一樣。
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  deriveIotHome,
  generateIotDeviceToken,
  hashIotDeviceToken,
  openIotEnvelope,
  parseIotDeviceFrame,
  parseIotUpMessage,
  sealIotEnvelope,
  type IotDeviceEnvelope,
} from '../../src/iot/index.js';
import { generateSecretKey, getPublicKey } from '../../src/protocol/index.js';
import { IotShellyTranslator, IOT_SHELLY_MAX_SWITCHES } from '../../src/relay/iot-shelly.js';
import { iotPlaintextFrom, parseIotRealtimeConfig, type IotRealtimeDeviceConfig, type IotRealtimeHomeConfig } from '../../src/relay/iot-realtime.js';

const home = deriveIotHome('77'.repeat(32));
const gwSk = generateSecretKey();
const T0 = 1_760_000_000_000;
const key = home.deviceKey('plug', 2);
const plug: IotRealtimeDeviceConfig = {
  id: 'plug',
  blindId: home.blind('dev:plug'),
  epoch: 2,
  tokenHash: hashIotDeviceToken(generateIotDeviceToken()),
  transport: 'shelly',
  shelly: { switches: [{ id: 0, topic: 'home/plug/power' }, { id: 1, topic: 'home/plug/usb' }] },
};

function setup() {
  let now = T0;
  const t = new IotShellyTranslator({ device: plug, deviceKey: key, now: () => now });
  return { t, advance: (ms: number) => void (now += ms), nowMs: () => now };
}

let downCtr = 0;
function down(t: 'cmd' | 'query', body: Record<string, unknown>, nowMs: number, over: { ts?: number; key?: Uint8Array } = {}): string {
  const env = sealIotEnvelope({ key: over.key ?? key, kid: 'plug.2', dir: 'down', ctr: ++downCtr, ts: over.ts ?? Math.floor(nowMs / 1000), plaintext: JSON.stringify(body) });
  return JSON.stringify({ t, env });
}
const cmd = (msgId: string, topic: string, payload: string, nowMs: number) => down('cmd', { type: 'cmd', msgId, topic, payload, enc: 'utf8', exp: Math.floor(nowMs / 1000) + 15 }, nowMs);
/** 解開 relay 要交給家庭核心的 up 幀 */
function up(frame: string): { t: string; env: IotDeviceEnvelope; msg: ReturnType<typeof parseIotUpMessage> } {
  const f = parseIotDeviceFrame(frame, 'device') as { t: 'ack' | 'state'; env: IotDeviceEnvelope };
  return { t: f.t, env: f.env, msg: parseIotUpMessage(openIotEnvelope(f.env, key)) };
}
const rpc = (s: string) => JSON.parse(s) as { id: number; src: string; method: string; params?: Record<string, unknown> };
const ID = (n: number) => `msg${String(n).padStart(16, '0')}`;

describe('down → Shelly RPC', () => {
  it('ON／OFF → Switch.Set；TOGGLE → Switch.Toggle；RPC 結果 → ack ok＋新的狀態', () => {
    const { t, nowMs } = setup();
    const a = t.fromRelay(cmd(ID(1), 'home/plug/power', 'ON', nowMs()));
    expect(a.up).toEqual([]);
    const set = rpc(a.toDevice[0]!);
    expect(set).toMatchObject({ method: 'Switch.Set', params: { id: 0, on: true } });
    const r = t.fromDevice(JSON.stringify({ id: set.id, src: 'shellyplus2pm-x', dst: set.src, result: { was_on: false } }));
    const ack = up(r.up[0]!);
    expect(ack.t).toBe('ack');
    expect(ack.msg).toMatchObject({ type: 'ack', inReplyTo: ID(1), status: 'ok', topics: { 'home/plug/power': { payload: 'ON' } } });
    expect(ack.env.kid).toBe('plug.2');

    const b = t.fromRelay(cmd(ID(2), 'home/plug/usb', 'toggle', nowMs()));
    const tog = rpc(b.toDevice[0]!);
    expect(tog).toMatchObject({ method: 'Switch.Toggle', params: { id: 1 } });
    const r2 = up(t.fromDevice(JSON.stringify({ id: tog.id, result: { was_on: true } })).up[0]!);
    expect(r2.msg).toMatchObject({ status: 'ok', topics: { 'home/plug/usb': { payload: 'OFF' } } });
  });

  it('沒對應的 topic → unknown-topic；酬載看不懂 → rejected bad-payload；都不送 RPC', () => {
    const { t, nowMs } = setup();
    const a = t.fromRelay(cmd(ID(3), 'home/plug/other', 'ON', nowMs()));
    expect(a.toDevice).toEqual([]);
    expect(up(a.up[0]!).msg).toMatchObject({ status: 'unknown-topic', inReplyTo: ID(3) });
    const b = t.fromRelay(cmd(ID(4), 'home/plug/power', 'MAYBE', nowMs()));
    expect(b.toDevice).toEqual([]);
    expect(up(b.up[0]!).msg).toMatchObject({ status: 'rejected', reason: 'bad-payload' });
  });

  it('RPC 回錯誤 → rejected，reason 帶 Shelly 的錯誤碼', () => {
    const { t, nowMs } = setup();
    const set = rpc(t.fromRelay(cmd(ID(5), 'home/plug/power', 'OFF', nowMs())).toDevice[0]!);
    const r = up(t.fromDevice(JSON.stringify({ id: set.id, error: { code: -103, message: 'Invalid argument' } })).up[0]!);
    expect(r.msg).toMatchObject({ status: 'rejected', reason: 'shelly:-103' });
  });

  it('query → Shelly.GetStatus；回覆的 switch:N.output 變成所有對應 topic 的值', () => {
    const { t, nowMs } = setup();
    const q = rpc(t.fromRelay(down('query', { type: 'query', msgId: ID(6), exp: Math.floor(nowMs() / 1000) + 15 }, nowMs())).toDevice[0]!);
    expect(q.method).toBe('Shelly.GetStatus');
    const r = up(t.fromDevice(JSON.stringify({ id: q.id, result: { 'switch:0': { output: true }, 'switch:1': { output: false }, sys: {} } })).up[0]!);
    expect(r.msg).toMatchObject({ status: 'ok', topics: { 'home/plug/power': { payload: 'ON' }, 'home/plug/usb': { payload: 'OFF' } } });
  });

  it('信封時間超出 ±60 秒或指令過期 → rejected expired；解不開（別的金鑰）→ 什麼都不回', () => {
    const { t, nowMs } = setup();
    const old = down('cmd', { type: 'cmd', msgId: ID(7), topic: 'home/plug/power', payload: 'ON', enc: 'utf8', exp: Math.floor(nowMs() / 1000) + 15 }, nowMs(), { ts: Math.floor(nowMs() / 1000) - 120 });
    const r = t.fromRelay(old);
    expect(r.toDevice).toEqual([]);
    expect(up(r.up[0]!).msg).toMatchObject({ status: 'rejected', reason: 'expired' });
    const forged = down('cmd', { type: 'cmd', msgId: ID(8), topic: 'home/plug/power', payload: 'ON', enc: 'utf8', exp: Math.floor(nowMs() / 1000) + 15 }, nowMs(), { key: home.deviceKey('other', 2) });
    expect(t.fromRelay(forged)).toEqual({ toDevice: [], up: [] });
  });

  it('同一個 msgId 重送 → 不再送 RPC，回同一個 ack', () => {
    const { t, nowMs } = setup();
    const frame = cmd(ID(9), 'home/plug/power', 'ON', nowMs());
    const set = rpc(t.fromRelay(frame).toDevice[0]!);
    const first = up(t.fromDevice(JSON.stringify({ id: set.id, result: { was_on: false } })).up[0]!);
    const again = t.fromRelay(frame);
    expect(again.toDevice).toEqual([]);
    expect(up(again.up[0]!).msg).toEqual(first.msg);
  });
});

describe('Shelly 主動通知 → up state', () => {
  it('NotifyStatus 的 switch:N.output → state；沒對應的開關與其他通知不送', () => {
    const { t } = setup();
    const r = t.fromDevice(JSON.stringify({ src: 'shelly', dst: 'cinder-relay', method: 'NotifyStatus', params: { ts: 1, 'switch:1': { id: 1, output: true }, 'switch:5': { output: true } } }));
    const s = up(r.up[0]!);
    expect(s.t).toBe('state');
    expect(s.msg).toEqual({ type: 'state', topics: { 'home/plug/usb': { payload: 'ON', ts: expect.any(Number) } } });
    expect(t.fromDevice(JSON.stringify({ method: 'NotifyStatus', params: { 'switch:1': { apower: 3.2 } } })).up).toEqual([]);
    expect(t.fromDevice(JSON.stringify({ method: 'NotifyEvent', params: { events: [] } })).up).toEqual([]);
    expect(t.fromDevice('not json').up).toEqual([]);
  });
});

describe('up 計數器（GCM nonce 不重用）', () => {
  it('以時間為底（毫秒 × 1024）嚴格遞增：同一毫秒多則也遞增；重開（新實例）也比之前大', () => {
    const { t, nowMs } = setup();
    const ctrs = [1, 2, 3].map(() => up(t.fromDevice(JSON.stringify({ method: 'NotifyStatus', params: { 'switch:0': { output: true } } })).up[0]!).env.ctr);
    expect(ctrs[0]).toBeGreaterThanOrEqual(nowMs() * 1024);
    expect(ctrs[1]).toBe(ctrs[0]! + 1);
    expect(ctrs[2]).toBe(ctrs[1]! + 1);
    expect(Number.isSafeInteger(ctrs[2])).toBe(true);
    const restarted = new IotShellyTranslator({ device: plug, deviceKey: key, now: () => nowMs() + 1 });
    const next = up(restarted.fromDevice(JSON.stringify({ method: 'NotifyStatus', params: { 'switch:0': { output: false } } })).up[0]!).env.ctr;
    expect(next).toBeGreaterThan(ctrs[2]!);
  });
});

describe('設定與開關（三個條件都要有，否則這個家不啟用）', () => {
  const homeCfg = (devices: IotRealtimeDeviceConfig[]): IotRealtimeHomeConfig => ({ homeTag: home.homeTag, homePub: home.homePub, gatewayPubkey: getPublicKey(gwSk), acl: [], devices });
  const gw = { [home.homeTag]: bytesToHex(gwSk) };
  const keys = JSON.stringify({ [`${home.homeTag}/plug`]: bytesToHex(key) });
  const allow = getPublicKey(generateSecretKey());

  it('危險旗標＋白名單＋這台的金鑰 → 啟用，金鑰交給宿主', () => {
    const plaintext = iotPlaintextFrom({ IOT_PLAINTEXT_DEVICES: '1', ALLOWED_PUBKEYS: allow, IOT_PLAINTEXT_DEVICE_KEYS: keys });
    const r = parseIotRealtimeConfig({ homes: [homeCfg([plug])] }, gw, plaintext);
    expect(r.issues).toEqual([]);
    expect(bytesToHex(r.homes.get(home.homeTag)!.plaintextKeys.get('plug')!)).toBe(bytesToHex(key));
  });

  it('沒有危險旗標、沒有白名單（開放站，例如官方錨點）、缺金鑰 → plaintext-disabled／plaintext-key-missing，家庭不啟用', () => {
    for (const env of [
      { ALLOWED_PUBKEYS: allow, IOT_PLAINTEXT_DEVICE_KEYS: keys },
      { IOT_PLAINTEXT_DEVICES: '1', IOT_PLAINTEXT_DEVICE_KEYS: keys },
      { IOT_PLAINTEXT_DEVICES: 'true', ALLOWED_PUBKEYS: allow, IOT_PLAINTEXT_DEVICE_KEYS: keys },
    ]) {
      const r = parseIotRealtimeConfig({ homes: [homeCfg([plug])] }, gw, iotPlaintextFrom(env));
      expect(r.issues.map((i) => i.code)).toEqual(['plaintext-disabled']);
      expect(r.homes.size).toBe(0);
    }
    const missing = parseIotRealtimeConfig({ homes: [homeCfg([plug])] }, gw, iotPlaintextFrom({ IOT_PLAINTEXT_DEVICES: '1', ALLOWED_PUBKEYS: allow }));
    expect(missing.issues.map((i) => i.code)).toEqual(['plaintext-key-missing']);
    // 沒有 Shelly 設備的家庭不受影響
    const plain = parseIotRealtimeConfig({ homes: [homeCfg([{ ...plug, transport: undefined, shelly: undefined }])] }, gw, iotPlaintextFrom({}));
    expect(plain.issues).toEqual([]);
  });

  it('形狀：門鎖類不能走 Shelly；開關 1–16 個、id 0–15 不重複、topic 合法；shelly 要搭 transport', () => {
    const plaintext = iotPlaintextFrom({ IOT_PLAINTEXT_DEVICES: '1', ALLOWED_PUBKEYS: allow, IOT_PLAINTEXT_DEVICE_KEYS: keys });
    const codes = (d: Partial<IotRealtimeDeviceConfig> & Record<string, unknown>) =>
      parseIotRealtimeConfig({ homes: [homeCfg([{ ...plug, ...d } as IotRealtimeDeviceConfig])] }, gw, plaintext).issues.map((i) => i.code);
    expect(codes({ class: 'lock', localFallback: ['key'] })).toEqual(['shelly-lock']);
    expect(codes({ shelly: { switches: [] } })).toEqual(['shelly']);
    expect(codes({ shelly: { switches: Array.from({ length: IOT_SHELLY_MAX_SWITCHES + 1 }, (_, i) => ({ id: i, topic: `a/${i}` })) } })).toEqual(['shelly']);
    expect(codes({ shelly: { switches: [{ id: 0, topic: 'a' }, { id: 0, topic: 'b' }] } })).toEqual(['shelly']);
    expect(codes({ shelly: { switches: [{ id: 16, topic: 'a' }] } })).toEqual(['shelly']);
    expect(codes({ shelly: { switches: [{ id: 0, topic: 'a/+' }] } })).toEqual(['shelly']);
    expect(codes({ transport: undefined })).toEqual(['shelly']);
    expect(codes({ transport: 'mqtt' as never })).toEqual(['shape']);
  });
});
