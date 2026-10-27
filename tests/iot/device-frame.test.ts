// C′ 設備幀與設備權杖（SDK ADR 0049 §9.2、§9.3）。
import { describe, expect, it } from 'vitest';
import {
  deriveIotDeviceKey,
  encodeIotDeviceFrame,
  generateIotDeviceToken,
  hashIotDeviceToken,
  IOT_DEVICE_FRAME_MAX_BYTES,
  IOT_DEVICE_HEARTBEAT,
  IOT_DEVICE_HEARTBEAT_ACK,
  IOT_DEVICE_TOKEN_PATTERN,
  parseIotDeviceFrame,
  sealIotEnvelope,
  verifyIotDeviceToken,
} from '../../src/iot/index.js';

const KEY = deriveIotDeviceKey('11'.repeat(32), 'door', 0);
const down = sealIotEnvelope({ key: KEY, kid: 'door.0', dir: 'down', ctr: 1, ts: 1759370000, plaintext: 'x' });
const up = sealIotEnvelope({ key: KEY, kid: 'door.0', dir: 'up', ctr: 1, ts: 1759370000, plaintext: 'x' });

describe('心跳字串（ADR 0049 §9.3）', () => {
  it('逐位元組固定：自動回覆要與設備送的心跳完全相同，否則每則都喚醒 DO、悄悄變成計費', () => {
    expect(IOT_DEVICE_HEARTBEAT).toBe('{"t":"hb"}');
    expect(IOT_DEVICE_HEARTBEAT_ACK).toBe('{"t":"hb-ack"}');
    expect(encodeIotDeviceFrame({ t: 'hb' })).toBe(IOT_DEVICE_HEARTBEAT);
  });
});

describe('設備幀（ADR 0049 §9.2）', () => {
  it('relay → 設備只有 cmd／query（down 信封）；設備 → relay 只有 ack／state（up 信封）與 hb', () => {
    expect(parseIotDeviceFrame(encodeIotDeviceFrame({ t: 'cmd', env: down }), 'relay')).toEqual({ t: 'cmd', env: down });
    expect(parseIotDeviceFrame(encodeIotDeviceFrame({ t: 'query', env: down }), 'relay')).toEqual({ t: 'query', env: down });
    expect(parseIotDeviceFrame(encodeIotDeviceFrame({ t: 'ack', env: up }), 'device')).toEqual({ t: 'ack', env: up });
    expect(parseIotDeviceFrame(encodeIotDeviceFrame({ t: 'state', env: up }), 'device')).toEqual({ t: 'state', env: up });
    expect(parseIotDeviceFrame(IOT_DEVICE_HEARTBEAT, 'device')).toEqual({ t: 'hb' });
  });

  it('方向不符、信封方向不符、壞 JSON、多餘的型別、超過大小 → undefined', () => {
    expect(parseIotDeviceFrame(encodeIotDeviceFrame({ t: 'cmd', env: down }), 'device')).toBeUndefined();
    expect(parseIotDeviceFrame(encodeIotDeviceFrame({ t: 'ack', env: up }), 'relay')).toBeUndefined();
    expect(parseIotDeviceFrame(JSON.stringify({ t: 'ack', env: down }), 'device')).toBeUndefined();
    expect(parseIotDeviceFrame(JSON.stringify({ t: 'cmd', env: up }), 'relay')).toBeUndefined();
    expect(parseIotDeviceFrame('{not json', 'device')).toBeUndefined();
    expect(parseIotDeviceFrame(JSON.stringify({ t: 'reboot' }), 'device')).toBeUndefined();
    expect(parseIotDeviceFrame(JSON.stringify({ t: 'state', env: { ...up, ct: 'zz' } }), 'device')).toBeUndefined();
    expect(parseIotDeviceFrame(' '.repeat(IOT_DEVICE_FRAME_MAX_BYTES + 1), 'device')).toBeUndefined();
  });

  it('二進位幀以 UTF-8 解讀', () => {
    expect(parseIotDeviceFrame(new TextEncoder().encode(IOT_DEVICE_HEARTBEAT), 'device')).toEqual({ t: 'hb' });
  });
});

describe('設備權杖（ADR 0049 §9.2、§9.5）', () => {
  it('`cit1_` 開頭、32 bytes base64url；每次不同', () => {
    const a = generateIotDeviceToken();
    expect(a).toMatch(IOT_DEVICE_TOKEN_PATTERN);
    expect(a).toMatch(/^cit1_[A-Za-z0-9_-]{43}$/);
    expect(generateIotDeviceToken()).not.toBe(a);
  });

  it('relay 只存雜湊（SHA-256 hex）；驗證以常數時間比較，格式不對直接拒絕', () => {
    const t = generateIotDeviceToken();
    const h = hashIotDeviceToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyIotDeviceToken(t, h)).toBe(true);
    expect(verifyIotDeviceToken(generateIotDeviceToken(), h)).toBe(false);
    expect(verifyIotDeviceToken(`${t}x`, h)).toBe(false);
    expect(verifyIotDeviceToken(t, 'not-a-hash')).toBe(false);
    expect(verifyIotDeviceToken(undefined, h)).toBe(false);
  });
});
