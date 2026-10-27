// 設備信封（SDK ADR 0049 §2.6）：AES-256-GCM、AAD、nonce 分區、kid、計數器。
// 交叉驗證用 Node 內建 crypto（獨立實作）——設備端（Berry／mbedtls／Python）照同一份規格算，必須逐位元組相同。
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveIotDeviceKey,
  deriveIotDeviceKeyDown,
  iotEnvelopeAad,
  IotEnvelopeError,
  iotKid,
  IotUpCounterGuard,
  openIotEnvelope,
  parseIotEnvelope,
  parseIotKid,
  sealIotEnvelope,
  IOT_ENVELOPE_MAX_PLAINTEXT_BYTES,
} from '../../src/iot/index.js';

const SECRET = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY = deriveIotDeviceKey(SECRET, 'plug1', 0);
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

/** 用 Node crypto 獨立加密（交叉驗證） */
function nodeSeal(key: Uint8Array, nonce: Uint8Array, aad: string, plaintext: string): string {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]).toString('base64');
}

describe('kid（ADR 0049 §2.6）', () => {
  it('`<設備 id>.<epoch>`；設備 id 可以含點，以最後一個點切', () => {
    expect(iotKid('plug1', 0)).toBe('plug1.0');
    expect(parseIotKid('plug1.0')).toEqual({ deviceId: 'plug1', epoch: 0 });
    expect(parseIotKid('living.room.lamp.12')).toEqual({ deviceId: 'living.room.lamp', epoch: 12 });
    for (const bad of ['plug1', 'plug1.', '.3', 'plug1.-1', 'plug1.1.5x', 'plug1.01']) expect(parseIotKid(bad)).toBeUndefined();
    expect(() => iotKid('plug1', -1)).toThrow(RangeError);
  });
});

describe('設備信封（ADR 0049 §2.6）', () => {
  it('up：nonce＝0x01＋3 個零＋8 bytes 大端 ctr；與 Node crypto 逐位元組相同', () => {
    const env = sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'up', ctr: 1842, ts: 1759370000, plaintext: '{"type":"state"}' });
    const nonce = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x07, 0x32]);
    expect(env).toMatchObject({ v: 1, alg: 'A256GCM', kid: 'plug1.0', dir: 'up', ctr: 1842, ts: 1759370000, nonce: b64(nonce) });
    const aad = 'cinder-iot/v1|up|plug1.0|1842|1759370000';
    expect(iotEnvelopeAad(env)).toBe(aad);
    expect(env.ct).toBe(nodeSeal(KEY, nonce, aad, '{"type":"state"}'));
    expect(dec.decode(openIotEnvelope(env, KEY))).toBe('{"type":"state"}');
  });

  it('down：nonce 首位元組 0x00、其餘隨機；可以指定 nonce（測試向量）；Node crypto 解得開', () => {
    const a = sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'down', ctr: 7, ts: 1759370001, plaintext: 'ON' });
    const b = sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'down', ctr: 7, ts: 1759370001, plaintext: 'ON' });
    expect(Buffer.from(a.nonce, 'base64')[0]).toBe(0);
    expect(a.nonce).not.toBe(b.nonce);
    const nonce = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const fixed = sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'down', ctr: 7, ts: 1759370001, plaintext: enc.encode('ON'), nonce });
    const raw = Buffer.from(fixed.ct, 'base64');
    const d = createDecipheriv('aes-256-gcm', KEY, nonce);
    d.setAAD(Buffer.from('cinder-iot/v1|down|plug1.0|7|1759370001', 'utf8'));
    d.setAuthTag(raw.subarray(raw.length - 16));
    expect(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8')).toBe('ON');
  });

  it('竄改 AAD 的任何欄位、密文或 tag → 解不開（auth）', () => {
    const env = sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'up', ctr: 5, ts: 1759370000, plaintext: 'x' });
    const raw = Buffer.from(env.ct, 'base64');
    const flipped = Buffer.from(raw);
    flipped[0]! ^= 1;
    const tagFlip = Buffer.from(raw);
    tagFlip[tagFlip.length - 1]! ^= 1;
    for (const bad of [
      { ...env, ts: env.ts + 1 },
      { ...env, kid: 'plug1.1' },
      { ...env, ct: flipped.toString('base64') },
      { ...env, ct: tagFlip.toString('base64') },
    ]) {
      expect(() => openIotEnvelope(bad, KEY)).toThrow(IotEnvelopeError);
    }
    expect(() => openIotEnvelope(env, deriveIotDeviceKey(SECRET, 'plug1', 1))).toThrow(/auth/);
  });

  it('nonce 與方向／計數器不符 → 拒收（防止把 up 的 nonce 空間拿去 down、或 ctr 與 nonce 不一致）', () => {
    const up = sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'up', ctr: 5, ts: 1759370000, plaintext: 'x' });
    expect(() => openIotEnvelope({ ...up, ctr: 6 }, KEY)).toThrow(/nonce/);
    expect(() => openIotEnvelope({ ...up, dir: 'down' }, KEY)).toThrow(/nonce/);
    expect(() =>
      sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'down', ctr: 1, ts: 1, plaintext: 'x', nonce: new Uint8Array(12).fill(1) }),
    ).toThrow(/nonce/);
  });

  it('parseIotEnvelope：只收合法形狀（v、alg、kid、dir、整數 ctr／ts、12 bytes nonce、至少 16 bytes ct）', () => {
    const env = sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'up', ctr: 5, ts: 1759370000, plaintext: 'x' });
    expect(parseIotEnvelope(JSON.parse(JSON.stringify(env)))).toEqual(env);
    for (const bad of [
      null,
      'x',
      { ...env, v: 2 },
      { ...env, alg: 'C20P1305' },
      { ...env, kid: 'plug1' },
      { ...env, dir: 'side' },
      { ...env, ctr: -1 },
      { ...env, ctr: 1.5 },
      { ...env, ts: '1' },
      { ...env, nonce: b64(new Uint8Array(11)) },
      { ...env, ct: b64(new Uint8Array(15)) },
      { ...env, ct: 'not base64!' },
    ]) {
      expect(parseIotEnvelope(bad)).toBeUndefined();
    }
  });

  it('明文上限：超過就拒絕封裝', () => {
    const big = new Uint8Array(IOT_ENVELOPE_MAX_PLAINTEXT_BYTES + 1);
    expect(() => sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'up', ctr: 1, ts: 1, plaintext: big })).toThrow(RangeError);
  });

  it('金鑰必須 32 bytes；ctr／ts 必須是非負安全整數', () => {
    expect(() => sealIotEnvelope({ key: new Uint8Array(16), kid: 'plug1.0', dir: 'up', ctr: 1, ts: 1, plaintext: 'x' })).toThrow(RangeError);
    expect(() => sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'up', ctr: -1, ts: 1, plaintext: 'x' })).toThrow(RangeError);
    expect(() => sealIotEnvelope({ key: KEY, kid: 'plug1.0', dir: 'up', ctr: 1, ts: Number.MAX_SAFE_INTEGER + 1, plaintext: 'x' })).toThrow(RangeError);
  });
});

describe('門鎖類設備的 down 金鑰（ADR 0049 §9.5 operatorSecret）', () => {
  it('HKDF(operatorSecret, info="cinder-iot/v1/device-key-down|<id>|<epoch>")；與 deviceKey 不同、epoch 不同就不同', () => {
    const op = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
    const k0 = deriveIotDeviceKeyDown(op, 'door', 0);
    expect(k0).toHaveLength(32);
    expect(Buffer.from(k0).equals(Buffer.from(deriveIotDeviceKeyDown(op, 'door', 0)))).toBe(true);
    expect(Buffer.from(k0).equals(Buffer.from(deriveIotDeviceKeyDown(op, 'door', 1)))).toBe(false);
    expect(Buffer.from(k0).equals(Buffer.from(deriveIotDeviceKey(op, 'door', 0)))).toBe(false);
  });
});

describe('up 計數器（ADR 0049 §2.6 防重放）', () => {
  it('每個 kid 嚴格遞增；相同或較小的拒收；不同 kid 各自計', () => {
    const g = new IotUpCounterGuard();
    expect(g.accept('plug1.0', 10)).toBe(true);
    expect(g.accept('plug1.0', 10)).toBe(false);
    expect(g.accept('plug1.0', 9)).toBe(false);
    expect(g.accept('plug1.0', 1010)).toBe(true); // 開機預約跳號
    expect(g.accept('plug2.0', 1)).toBe(true);
    expect(g.last('plug1.0')).toBe(1010);
  });

  it('可以從持久化的值恢復；有上限，最舊的先丟', () => {
    const g = new IotUpCounterGuard({ initial: { 'plug1.0': 50 }, maxEntries: 2 });
    expect(g.accept('plug1.0', 50)).toBe(false);
    g.accept('a.0', 1);
    g.accept('b.0', 1);
    expect(g.last('plug1.0')).toBeUndefined();
    expect(g.snapshot()).toEqual({ 'a.0': 1, 'b.0': 1 });
  });
});
