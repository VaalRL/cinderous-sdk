// IoT 設備端的跨語言測試向量（SDK ADR 0140）：`tests/fixtures/iot-device-v1.vectors.json`。
//
// 這份 JSON 由 TypeScript 實作**產生**，韌體與參考設備（examples/iot-device-python、ESP-IDF／ESPHome）以它驗證自己的實作。
// 這個測試每次都用目前的 SDK 重新產生一次、和檔案逐欄比對：協定或實作改了，向量就會對不上（不會悄悄漂移）。
// 有意改協定時：`UPDATE_IOT_VECTORS=1 npx vitest run tests/iot/device-vectors.test.ts` 重寫檔案，並在 ADR 寫明。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { classifyIotDeviceDisconnect, iotDeviceRetryDelayMs, type IotDeviceDisconnect, type IotDeviceObservation, type IotDeviceRetryContext } from '../../src/iot/device-backoff.js';
import { encodeIotDeviceFrame, hashIotDeviceToken, IOT_DEVICE_TOKEN_PATTERN, parseIotDeviceFrame, verifyIotDeviceToken } from '../../src/iot/device-frame.js';
import { parseIotDownMessage, parseIotUpMessage } from '../../src/iot/device-message.js';
import { connectIotDevice, memoryIotDeviceCounterStore, type IotDeviceCommand, type IotDeviceSocket } from '../../src/iot/device.js';
import { deriveIotDeviceKeyDown, iotEnvelopeAad, IotEnvelopeError, openIotEnvelope, sealIotEnvelope, type IotDeviceEnvelope } from '../../src/iot/envelope.js';
import { deriveIotHome } from '../../src/iot/keys.js';

const FILE = fileURLToPath(new URL('../fixtures/iot-device-v1.vectors.json', import.meta.url));

const HOME_SECRET = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const OPERATOR_SECRET = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff000102030405060708090a0b0c0d0e0f';
const home = deriveIotHome(HOME_SECRET);
const LAMP_KEY = home.deviceKey('lamp', 0);
const DOOR_KEY = home.deviceKey('door', 0);
const DOOR_KEY_DOWN = deriveIotDeviceKeyDown(OPERATOR_SECRET, 'door', 0);
const NOW_MS = 1_800_000_000_123;
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** down nonce：0x00＋11 bytes（向量固定，實際由發送端隨機） */
const downNonce = (n: number): Uint8Array => hexToBytes(`00${n.toString(16).padStart(2, '0').repeat(11)}`);

function keysSection() {
  return {
    homeSecret: HOME_SECRET,
    homeTag: home.homeTag,
    topicKey: bytesToHex(home.topicKey),
    blind: ['home', 'dev:lamp', 'dev:door', 'dev:lamp|1', 'gw', 'sys:acl', 'home/lamp/power', '客廳/燈'].map((value) => ({ value, blinded: home.blind(value) })),
    deviceKey: [
      ['lamp', 0],
      ['lamp', 1],
      ['door', 0],
      ['燈.一號', 7],
    ].map(([id, epoch]) => ({ id, epoch, key: bytesToHex(home.deviceKey(id as string, epoch as number)) })),
    operatorSecret: OPERATOR_SECRET,
    deviceKeyDown: [
      ['door', 0],
      ['door', 3],
    ].map(([id, epoch]) => ({ id, epoch, key: bytesToHex(deriveIotDeviceKeyDown(OPERATOR_SECRET, id as string, epoch as number)) })),
  };
}

function tokenSection() {
  const tokens = ['cit1_' + 'A'.repeat(43), 'cit1_abcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFG'];
  return {
    hash: tokens.map((token) => ({ token, sha256: hashIotDeviceToken(token) })),
    pattern: [
      ...tokens,
      'cit1_' + 'A'.repeat(42),
      'cit1_' + 'A'.repeat(44),
      'cit2_' + 'A'.repeat(43),
      'cit1_' + 'A'.repeat(42) + '=',
      'cit1_' + 'A'.repeat(42) + '+',
      '',
    ].map((token) => ({ token, valid: IOT_DEVICE_TOKEN_PATTERN.test(token) })),
    verify: [
      { token: tokens[0]!, hash: hashIotDeviceToken(tokens[0]!) },
      { token: tokens[1]!, hash: hashIotDeviceToken(tokens[0]!) },
      { token: tokens[0]!, hash: hashIotDeviceToken(tokens[0]!).toUpperCase() },
      { token: 'cit1_short', hash: hashIotDeviceToken('cit1_short') },
    ].map((c) => ({ ...c, ok: verifyIotDeviceToken(c.token, c.hash) })),
  };
}

function envelopeSection() {
  const seal = [
    { name: 'down 指令（燈）', key: LAMP_KEY, kid: 'lamp.0', dir: 'down' as const, ctr: 1, ts: NOW_SEC, nonce: downNonce(0x11), plaintext: '{"type":"query","msgId":"AAAAAAAAAAAAAAAA","exp":1800000015}' },
    { name: 'down 空明文', key: LAMP_KEY, kid: 'lamp.0', dir: 'down' as const, ctr: 0, ts: 0, nonce: downNonce(0x22), plaintext: '' },
    { name: 'up 狀態（ctr 決定 nonce）', key: LAMP_KEY, kid: 'lamp.0', dir: 'up' as const, ctr: 42, ts: NOW_SEC, plaintext: '{"type":"state","topics":{"home/lamp/state":{"payload":"ON","ts":1800000000123}}}' },
    { name: 'up 大計數器（超過 32 位元）', key: LAMP_KEY, kid: 'lamp.0', dir: 'up' as const, ctr: 2 ** 40 + 5, ts: NOW_SEC, plaintext: '{"type":"state","topics":{}}' },
    { name: 'down 門鎖（deviceKeyDown，kid 可含點）', key: DOOR_KEY_DOWN, kid: 'front.door.3', dir: 'down' as const, ctr: 7, ts: NOW_SEC, nonce: downNonce(0x33), plaintext: 'UTF-8：開門 🔓' },
  ].map((c) => {
    const env = sealIotEnvelope({ key: c.key, kid: c.kid, dir: c.dir, ctr: c.ctr, ts: c.ts, plaintext: c.plaintext, ...(c.nonce ? { nonce: c.nonce } : {}) });
    return { name: c.name, key: bytesToHex(c.key), kid: c.kid, dir: c.dir, ctr: c.ctr, ts: c.ts, ...(c.nonce ? { nonce: bytesToHex(c.nonce) } : {}), plaintext: c.plaintext, aad: iotEnvelopeAad(c), envelope: env };
  });
  const base = seal[0]!.envelope as IotDeviceEnvelope;
  const up = seal[2]!.envelope as IotDeviceEnvelope;
  const flip = (b64: string): string => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 1;
    return btoa(String.fromCharCode(...bytes));
  };
  const open: { name: string; key: Uint8Array; envelope: unknown }[] = [
    { name: '正確', key: LAMP_KEY, envelope: base },
    { name: 'up 正確', key: LAMP_KEY, envelope: up },
    { name: '金鑰不對', key: DOOR_KEY, envelope: base },
    { name: '密文被改一位', key: LAMP_KEY, envelope: { ...base, ct: flip(base.ct) } },
    { name: 'ts 被改（AAD）', key: LAMP_KEY, envelope: { ...base, ts: base.ts + 1 } },
    { name: 'ctr 被改（down 只在 AAD）', key: LAMP_KEY, envelope: { ...base, ctr: base.ctr + 1 } },
    { name: 'up 的 ctr 被改（nonce 對不上）', key: LAMP_KEY, envelope: { ...up, ctr: up.ctr + 1 } },
    { name: 'dir 改成 up（nonce 分區不對）', key: LAMP_KEY, envelope: { ...base, dir: 'up' } },
    { name: 'down 借用 up 的 nonce 分區', key: LAMP_KEY, envelope: { ...up, dir: 'down' } },
    { name: '版本不對', key: LAMP_KEY, envelope: { ...base, v: 2 } },
    { name: '演算法不對', key: LAMP_KEY, envelope: { ...base, alg: 'A128GCM' } },
    { name: 'kid 沒有 epoch', key: LAMP_KEY, envelope: { ...base, kid: 'lamp' } },
    { name: 'nonce 長度不對', key: LAMP_KEY, envelope: { ...base, nonce: btoa('\u0000'.repeat(11)) } },
    { name: '密文比 tag 還短', key: LAMP_KEY, envelope: { ...base, ct: btoa('x'.repeat(15)) } },
    { name: 'ctr 是負數', key: LAMP_KEY, envelope: { ...base, ctr: -1 } },
    { name: 'ts 不是整數', key: LAMP_KEY, envelope: { ...base, ts: 1.5 } },
    { name: 'base64 不合法', key: LAMP_KEY, envelope: { ...base, ct: '!!!' } },
  ];
  return {
    seal,
    open: open.map((c) => {
      try {
        return { name: c.name, key: bytesToHex(c.key), envelope: c.envelope, plaintext: new TextDecoder().decode(openIotEnvelope(c.envelope, c.key)) };
      } catch (error) {
        if (!(error instanceof IotEnvelopeError)) throw error;
        return { name: c.name, key: bytesToHex(c.key), envelope: c.envelope, error: error.code };
      }
    }),
  };
}

const MSG = 'AbCdEfGhIjKlMnOp';
const downEnv = (plaintext: string, opts: { key?: Uint8Array; kid?: string; ts?: number; ctr?: number; nonce?: number } = {}) =>
  sealIotEnvelope({ key: opts.key ?? LAMP_KEY, kid: opts.kid ?? 'lamp.0', dir: 'down', ctr: opts.ctr ?? 1, ts: opts.ts ?? NOW_SEC, nonce: downNonce(opts.nonce ?? 0x44), plaintext });
const upEnv = sealIotEnvelope({ key: LAMP_KEY, kid: 'lamp.0', dir: 'up', ctr: 1, ts: NOW_SEC, plaintext: '{"type":"state","topics":{}}' });

function framesSection() {
  const cmd = encodeIotDeviceFrame({ t: 'cmd', env: downEnv('x') });
  const cases: { name: string; source: 'relay' | 'device'; text: string }[] = [
    { name: 'relay → 設備 cmd', source: 'relay', text: cmd },
    { name: 'relay → 設備 query', source: 'relay', text: encodeIotDeviceFrame({ t: 'query', env: downEnv('x') }) },
    { name: '設備 → relay ack', source: 'device', text: encodeIotDeviceFrame({ t: 'ack', env: upEnv }) },
    { name: '設備 → relay state', source: 'device', text: encodeIotDeviceFrame({ t: 'state', env: upEnv }) },
    { name: '心跳（逐位元組固定）', source: 'device', text: encodeIotDeviceFrame({ t: 'hb' }) },
    { name: 'relay 不送 hb', source: 'relay', text: '{"t":"hb"}' },
    { name: '方向不對：relay 送 ack', source: 'relay', text: JSON.stringify({ t: 'ack', env: upEnv }) },
    { name: '信封方向不對：cmd 帶 up 信封', source: 'relay', text: JSON.stringify({ t: 'cmd', env: upEnv }) },
    { name: '不認得的 t', source: 'relay', text: JSON.stringify({ t: 'reboot', env: downEnv('x') }) },
    { name: '不是 JSON', source: 'relay', text: 'hello' },
    { name: 'JSON 陣列', source: 'relay', text: '[1,2]' },
    { name: '信封缺欄位', source: 'relay', text: JSON.stringify({ t: 'cmd', env: { v: 1 } }) },
    { name: '超過 32 KiB', source: 'relay', text: JSON.stringify({ t: 'cmd', env: downEnv('x'), pad: 'x'.repeat(33 * 1024) }) },
  ];
  return {
    heartbeat: '{"t":"hb"}',
    heartbeatAck: '{"t":"hb-ack"}',
    maxBytes: 32 * 1024,
    cases: cases.map((c) => {
      const f = parseIotDeviceFrame(c.text, c.source);
      return { ...c, expect: f ? { t: f.t, ...(f.t !== 'hb' ? { kid: f.env.kid, dir: f.env.dir } : {}) } : null };
    }),
  };
}

function messagesSection() {
  const down = [
    { name: '指令', text: `{"type":"cmd","msgId":"${MSG}","topic":"home/lamp/power","payload":"ON","enc":"utf8","exp":${NOW_SEC + 15}}` },
    { name: '指令 base64＋confirmed', text: `{"type":"cmd","msgId":"${MSG}","topic":"home/lamp/raw","payload":"AQI=","enc":"base64","confirmed":true,"exp":${NOW_SEC + 15}}` },
    { name: '查詢', text: `{"type":"query","msgId":"${MSG}","exp":${NOW_SEC + 15}}` },
    { name: '多出來的欄位忽略', text: `{"type":"query","msgId":"${MSG}","exp":${NOW_SEC + 15},"x":1}` },
    { name: 'msgId 太短', text: `{"type":"query","msgId":"short","exp":${NOW_SEC}}` },
    { name: 'msgId 有不允許的字元', text: `{"type":"query","msgId":"AbCdEfGhIjKlMn.p","exp":${NOW_SEC}}` },
    { name: 'exp 不是正整數', text: `{"type":"query","msgId":"${MSG}","exp":0}` },
    { name: 'topic 有萬用字元', text: `{"type":"cmd","msgId":"${MSG}","topic":"home/+/power","payload":"ON","enc":"utf8","exp":${NOW_SEC}}` },
    { name: 'topic 空的一層可以', text: `{"type":"cmd","msgId":"${MSG}","topic":"home//power","payload":"ON","enc":"utf8","exp":${NOW_SEC}}` },
    { name: 'enc 不認得', text: `{"type":"cmd","msgId":"${MSG}","topic":"a","payload":"ON","enc":"hex","exp":${NOW_SEC}}` },
    { name: 'confirmed 不是布林', text: `{"type":"cmd","msgId":"${MSG}","topic":"a","payload":"ON","enc":"utf8","confirmed":1,"exp":${NOW_SEC}}` },
    { name: '酬載超過 8 KiB', text: JSON.stringify({ type: 'cmd', msgId: MSG, topic: 'a', payload: 'x'.repeat(8 * 1024 + 1), enc: 'utf8', exp: NOW_SEC }) },
    { name: '不認得的 type', text: `{"type":"reboot","msgId":"${MSG}","exp":${NOW_SEC}}` },
    { name: '不是 JSON', text: 'nope' },
  ].map((c) => ({ ...c, expect: parseIotDownMessage(c.text) ?? null }));
  const up = [
    { name: 'ack ok 帶狀態', text: `{"type":"ack","inReplyTo":"${MSG}","status":"ok","topics":{"home/lamp/state":{"payload":"ON","ts":${NOW_MS}}}}` },
    { name: 'ack rejected 帶原因', text: `{"type":"ack","inReplyTo":"${MSG}","status":"rejected","reason":"expired"}` },
    { name: 'state＋will', text: `{"type":"state","topics":{"a/b":{"payload":"AQI=","enc":"base64","ts":1}},"will":true}` },
    { name: 'status 不認得', text: `{"type":"ack","inReplyTo":"${MSG}","status":"offline"}` },
    { name: 'reason 超過 200 字', text: JSON.stringify({ type: 'ack', inReplyTo: MSG, status: 'rejected', reason: 'x'.repeat(201) }) },
    { name: 'topics 的 ts 不是正整數', text: `{"type":"state","topics":{"a":{"payload":"x","ts":0}}}` },
  ].map((c) => ({ ...c, expect: parseIotUpMessage(c.text) ?? null }));
  return { down, up };
}

function backoffSection() {
  const NOW = 1_800_000_000;
  const relay = (status: number, error: string, extra: Record<string, string> = {}, more: Record<string, unknown> = {}): IotDeviceObservation => ({
    kind: 'http',
    status,
    headers: { 'Cinder-Relay': '1', ...extra },
    body: JSON.stringify({ error, ...more }),
  });
  const observations: { name: string; observation: IotDeviceObservation }[] = [
    { name: '家庭預算用完（503＋Cinder-Quota＋reset）', observation: relay(503, 'rate-limited: iot-quota: this home has used its relay budget for today', { 'Cinder-Quota': 'home-budget', 'Retry-After': '7200' }, { reset: NOW + 7200 }) },
    { name: 'DO 額度（503＋Cinder-Quota，沒有 reset，標頭小寫）', observation: { kind: 'http', status: 503, headers: { 'cinder-relay': '1', 'cinder-quota': 'do-requests', 'retry-after': '600' }, body: '{"error":"rate-limited: iot-quota: x"}' } },
    { name: 'Workers 帳號額度（平台 429＋1027）', observation: { kind: 'http', status: 429, headers: {}, body: 'error code: 1027' } },
    { name: '權杖錯', observation: relay(401, 'restricted: iot-token: device token missing or wrong') },
    { name: '不認得的家', observation: relay(403, 'restricted: iot-home: this relay does not serve that home') },
    { name: '不認得的設備', observation: relay(404, 'restricted: iot-device: unknown device') },
    { name: '站沒開 C′', observation: relay(404, 'blocked: iot-disabled: this relay does not run the IoT realtime channel') },
    { name: '不是升級', observation: relay(426, 'invalid: iot-upgrade: WebSocket upgrade required') },
    { name: 'relay 的 503 沒有 Cinder-Quota', observation: relay(503, 'error: iot-relay: the home instance failed; retry with backoff') },
    { name: '每 IP 升級限速（429＋Retry-After）', observation: relay(429, 'rate-limited: iot-upgrade: too many connection attempts from this address', { 'Retry-After': '60' }) },
    { name: '平台 522', observation: { kind: 'http', status: 522, headers: {}, body: '' } },
    { name: '平台 1101', observation: { kind: 'http', status: 500, headers: {}, body: 'error code: 1101' } },
    { name: '沒有 Cinder-Relay 的 401（不是 relay 說的）', observation: { kind: 'http', status: 401, headers: {}, body: '' } },
    { name: 'close 4429 帶 reset', observation: { kind: 'close', code: 4429, reason: `iot-quota:${NOW + 300}` } },
    { name: 'close 4429 沒有 reset', observation: { kind: 'close', code: 4429, reason: 'iot-quota' } },
    { name: 'close 4409 被擠掉', observation: { kind: 'close', code: 4409, reason: 'replaced' } },
    { name: 'close 1006', observation: { kind: 'close', code: 1006 } },
    { name: 'close 4000 心跳逾時（自己關的）', observation: { kind: 'close', code: 4000, reason: 'heartbeat timeout' } },
    { name: 'DNS／TCP／TLS 失敗', observation: { kind: 'network' } },
    { name: '心跳逾時', observation: { kind: 'heartbeat-timeout' } },
  ];
  const delays: { name: string; disconnect: IotDeviceDisconnect; ctx: IotDeviceRetryContext }[] = [];
  const ctx = (attempt: number, random: number, clockSynced = true): IotDeviceRetryContext => ({ attempt, nowSec: NOW, clockSynced, random });
  for (const r of [0, 0.25, 0.5, 0.999999]) {
    delays.push({ name: `額度 reset＋${r}`, disconnect: { class: 'quota-exhausted', reset: NOW + 3600 }, ctx: ctx(0, r) });
    for (const a of [0, 1, 4, 7, 8, 30]) {
      delays.push({ name: `relay-error 第 ${a} 次 r=${r}`, disconnect: { class: 'relay-error' }, ctx: ctx(a, r) });
      delays.push({ name: `network-down 第 ${a} 次 r=${r}`, disconnect: { class: 'network-down' }, ctx: ctx(a, r) });
    }
  }
  delays.push(
    { name: '額度 reset 已過', disconnect: { class: 'quota-exhausted', reset: NOW - 10 }, ctx: ctx(0, 0) },
    { name: '額度但時鐘沒同步', disconnect: { class: 'quota-exhausted', reset: NOW + 3600 }, ctx: ctx(0, 0.5, false) },
    { name: '額度不知道 reset', disconnect: { class: 'quota-exhausted' }, ctx: ctx(0, 0.5) },
    { name: '設定錯誤', disconnect: { class: 'config-error' }, ctx: ctx(5, 0.5) },
    { name: '被擠掉', disconnect: { class: 'replaced' }, ctx: ctx(5, 0.5) },
    { name: 'relay-error 的 Retry-After 是下限', disconnect: { class: 'relay-error', retryAfterSec: 60 }, ctx: ctx(0, 0.5) },
    { name: 'relay-error 的 Retry-After 比退避短', disconnect: { class: 'relay-error', retryAfterSec: 1 }, ctx: ctx(6, 0.5) },
    { name: 'random 夾到 [0, 1)', disconnect: { class: 'network-down' }, ctx: ctx(3, 1.5) },
    { name: 'random 負數夾到 0', disconnect: { class: 'network-down' }, ctx: ctx(3, -1) },
  );
  return {
    classify: observations.map((c) => ({ ...c, nowSec: NOW, expect: classifyIotDeviceDisconnect(c.observation, NOW) })),
    delay: delays.map((c) => ({ ...c, expectMs: iotDeviceRetryDelayMs(c.disconnect, c.ctx) })),
  };
}

// ── 設備行為（§9.4）：把 relay 送來的幀餵給 SDK 的 connectIotDevice，記下它執行了什麼、送出了什麼 ─────────────────────

class VectorSocket implements IotDeviceSocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}

interface DeviceScenario {
  name: string;
  device: 'lamp' | 'door';
  counterStart?: number;
  clockSynced?: boolean;
  maxSkewSec?: number;
  /** 依序送進設備的幀；每一則可以有自己的「現在」 */
  steps: { frame: string; nowMs?: number }[];
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 參考處理器：`cmd` 一律成功並回報「topic＝收到的酬載」；`query` 回固定狀態 */
async function runDevice(s: DeviceScenario) {
  const socket = new VectorSocket();
  const commands: IotDeviceCommand[] = [];
  let nowMs = NOW_MS;
  const counter = memoryIotDeviceCounterStore(s.counterStart ?? 0);
  const door = s.device === 'door';
  const conn = connectIotDevice({
    url: 'wss://relay.example/iot/v1/dev/h/b',
    token: 'cit1_' + 'A'.repeat(43),
    deviceKey: door ? DOOR_KEY : LAMP_KEY,
    ...(door ? { deviceKeyDown: DOOR_KEY_DOWN } : {}),
    kid: door ? 'door.0' : 'lamp.0',
    counterStore: counter,
    clockSynced: () => s.clockSynced ?? true,
    ...(s.maxSkewSec !== undefined ? { maxSkewSec: s.maxSkewSec } : {}),
    heartbeat: { intervalSec: 3600 },
    now: () => nowMs,
    webSocket: () => socket,
    onCommand: (cmd) => {
      commands.push(cmd);
      return { status: 'ok', state: { [cmd.topic]: cmd.payload } };
    },
    onQuery: () => ({ 'home/lamp/state': 'QUERIED' }),
  });
  socket.readyState = 1;
  socket.onopen?.({});
  await flush();
  const out: { afterStep: number; frame: string }[] = [];
  for (const [i, step] of s.steps.entries()) {
    nowMs = step.nowMs ?? NOW_MS;
    const before = socket.sent.length;
    socket.onmessage?.({ data: step.frame });
    await flush();
    for (const frame of socket.sent.slice(before)) out.push({ afterStep: i, frame });
  }
  conn.close();
  return { commands: commands.map((c) => ({ ...c })), out, counterEnd: counter.value };
}

function deviceSection() {
  const cmd = (msgId: string, opts: { topic?: string; payload?: string; exp?: number } = {}) =>
    JSON.stringify({ type: 'cmd', msgId, topic: opts.topic ?? 'home/lamp/power', payload: opts.payload ?? 'ON', enc: 'utf8', exp: opts.exp ?? NOW_SEC + 15 });
  const query = (msgId: string) => JSON.stringify({ type: 'query', msgId, exp: NOW_SEC + 15 });
  const frame = (t: 'cmd' | 'query', plaintext: string, opts: Parameters<typeof downEnv>[1] = {}) => encodeIotDeviceFrame({ t, env: downEnv(plaintext, opts) });
  const scenarios: DeviceScenario[] = [
    { name: '指令：執行並回 ok，ack 帶執行後的狀態', device: 'lamp', steps: [{ frame: frame('cmd', cmd('msg-0000000000001')) }] },
    { name: '查詢：回 ok 與目前狀態', device: 'lamp', steps: [{ frame: frame('query', query('msg-0000000000002')) }] },
    { name: '計數器從存好的值往上加（先存再送）', device: 'lamp', counterStart: 41, steps: [{ frame: frame('query', query('msg-0000000000003')) }, { frame: frame('query', query('msg-0000000000004'), { nonce: 0x45 }) }] },
    {
      name: '重送同一個 msgId：不再執行，回同一個 ack（新的 ctr）',
      device: 'lamp',
      steps: [{ frame: frame('cmd', cmd('msg-0000000000005')) }, { frame: frame('cmd', cmd('msg-0000000000005'), { nonce: 0x46 }), nowMs: NOW_MS + 2000 }],
    },
    { name: '時鐘沒同步：拒絕（fail-closed）', device: 'lamp', clockSynced: false, steps: [{ frame: frame('cmd', cmd('msg-0000000000006')) }] },
    { name: '信封時間超出時間窗（預設 60 秒）：拒絕 expired', device: 'lamp', steps: [{ frame: frame('cmd', cmd('msg-0000000000007', { exp: NOW_SEC + 600 }), { ts: NOW_SEC - 61 }) }] },
    { name: '時間窗邊界（剛好 60 秒）：照常執行', device: 'lamp', steps: [{ frame: frame('cmd', cmd('msg-0000000000008'), { ts: NOW_SEC - 60 }) }] },
    { name: '來自未來的信封：拒絕 expired', device: 'lamp', steps: [{ frame: frame('cmd', cmd('msg-0000000000009'), { ts: NOW_SEC + 61 }) }] },
    { name: '內容已過期（exp 早於現在）：拒絕 expired', device: 'lamp', steps: [{ frame: frame('cmd', cmd('msg-000000000000a', { exp: NOW_SEC - 1 })) }] },
    { name: '門類時間窗 15 秒', device: 'door', maxSkewSec: 15, steps: [{ frame: frame('cmd', cmd('msg-000000000000b', { topic: 'home/door/lock', payload: 'UNLOCK' }), { key: DOOR_KEY_DOWN, kid: 'door.0', ts: NOW_SEC - 16 }) }] },
    { name: '金鑰不對：解不開，什麼都不回', device: 'lamp', steps: [{ frame: frame('cmd', cmd('msg-000000000000c'), { key: DOOR_KEY }) }] },
    { name: 'kid 不是這台：不理', device: 'lamp', steps: [{ frame: frame('cmd', cmd('msg-000000000000d'), { kid: 'lamp.1' }) }] },
    { name: '幀是 cmd、內容是 query：不理', device: 'lamp', steps: [{ frame: frame('cmd', query('msg-000000000000e')) }] },
    { name: '門鎖：以 deviceKey 做的指令（viewer 也算得出）解不開、不執行', device: 'door', steps: [{ frame: frame('cmd', cmd('msg-000000000000f', { topic: 'home/door/lock', payload: 'UNLOCK' }), { kid: 'door.0', key: DOOR_KEY }) }] },
    { name: '門鎖：以 deviceKeyDown 做的指令照常執行', device: 'door', steps: [{ frame: frame('cmd', cmd('msg-0000000000010', { topic: 'home/door/lock', payload: 'UNLOCK' }), { kid: 'door.0', key: DOOR_KEY_DOWN }) }] },
    { name: '門鎖：查詢一律用 deviceKey', device: 'door', steps: [{ frame: frame('query', query('msg-0000000000011'), { kid: 'door.0', key: DOOR_KEY }) }] },
    { name: 'hb-ack 不產生任何輸出', device: 'lamp', steps: [{ frame: '{"t":"hb-ack"}' }] },
    { name: '壞掉的幀：不理', device: 'lamp', steps: [{ frame: '{"t":"cmd","env":{"v":1}}' }, { frame: 'garbage' }] },
  ];
  return { scenarios };
}

async function generate() {
  return {
    $comment:
      'Cinderous SDK ADR 0140：IoT 設備端跨語言測試向量（由 TypeScript 實作產生；tests/iot/device-vectors.test.ts）。位元組欄位一律小寫 hex，信封內的 nonce／ct 是標準 base64（有補齊）。協定：SDK ADR 0049 §2.1、§2.6、§9、§10.2；ADR 0120。',
    version: 1,
    keys: keysSection(),
    token: tokenSection(),
    envelope: envelopeSection(),
    frames: framesSection(),
    messages: messagesSection(),
    backoff: backoffSection(),
    device: {
      reference: {
        nowMs: NOW_MS,
        homeSecret: HOME_SECRET,
        operatorSecret: OPERATOR_SECRET,
        devices: {
          lamp: { kid: 'lamp.0', deviceKey: bytesToHex(LAMP_KEY) },
          door: { kid: 'door.0', deviceKey: bytesToHex(DOOR_KEY), deviceKeyDown: bytesToHex(DOOR_KEY_DOWN) },
        },
        defaults: { maxSkewSec: 60, counterStart: 0, clockSynced: true },
        handler: 'cmd → { status: "ok", state: { [topic]: payload } }；query → { "home/lamp/state": "QUERIED" }；狀態的 ts＝nowMs',
      },
      scenarios: await Promise.all(deviceSection().scenarios.map(async (s) => ({ ...s, expect: await runDevice(s) }))),
    },
  };
}

describe('IoT 設備端跨語言測試向量（SDK ADR 0140）', () => {
  it('檔案與目前的 SDK 實作一致（改協定要重寫檔案並在 ADR 說明）', async () => {
    const fresh = JSON.parse(JSON.stringify(await generate())) as unknown;
    if (process.env.UPDATE_IOT_VECTORS === '1') writeFileSync(FILE, `${JSON.stringify(fresh, null, 2)}\n`);
    const saved = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    expect(fresh).toEqual(saved);
  });

  it('向量本身有意義：每一類都有成功與失敗的例子', async () => {
    const v = JSON.parse(readFileSync(FILE, 'utf8')) as {
      envelope: { open: { error?: string }[] };
      frames: { cases: { expect: unknown }[] };
      device: { scenarios: { expect: { commands: unknown[]; out: unknown[] } }[] };
      backoff: { classify: { expect: { class: string } }[] };
    };
    expect(new Set(v.envelope.open.map((c) => c.error ?? 'ok'))).toEqual(new Set(['ok', 'format', 'nonce', 'auth']));
    expect(v.frames.cases.some((c) => c.expect === null) && v.frames.cases.some((c) => c.expect !== null)).toBe(true);
    expect(v.device.scenarios.some((s) => s.expect.commands.length > 0)).toBe(true);
    expect(v.device.scenarios.some((s) => s.expect.out.length === 0)).toBe(true);
    expect(new Set(v.backoff.classify.map((c) => c.expect.class))).toEqual(new Set(['quota-exhausted', 'config-error', 'relay-error', 'network-down', 'replaced']));
  });
});
