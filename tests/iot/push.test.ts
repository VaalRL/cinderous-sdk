// IoT 推播協定層（SDK ADR 0049 §11.1）：端點格式、token 封包、喚醒請求的簽章與「一律是空的」、上限、`$sys/push` 操作。
import { describe, expect, it } from 'vitest';

import { generateSecretKey, getPublicKey } from '../../src/protocol/keys.js';
import { conversationKey, decryptWithKey } from '../../src/protocol/nip44.js';
import {
  assertEmptyIotPushWake,
  buildIotPushRequest,
  buildIotPushRevokeBody,
  buildIotPushWakeBody,
  fetchIotPushSend,
  IOT_PUSH_LIMITS,
  iotPushEndpointId,
  iotPushLimits,
  iotPushRegId,
  iotPushResultOf,
  iotPushRevokeMessage,
  iotPushSign,
  iotPushWakeMessage,
  isPrivateIotPushHost,
  parseIotPushEndpoint,
  parseIotPushOp,
  parseIotPushSubscriptions,
  parseIotPushTokenPayload,
  retryAfterMs,
  sealIotPushToken,
  splitIotPushSealed,
  type IotPushEndpoint,
} from '../../src/iot/push.js';

const FCM_TOKEN = 'fcm_token-AbC123:xyz_0123456789abcdefghij';
const gatewaySk = generateSecretKey();
const gatewayPub = getPublicKey(gatewaySk);

function open(sealed: string): unknown {
  const parts = splitIotPushSealed(sealed)!;
  return JSON.parse(decryptWithKey(parts.ciphertext, conversationKey(gatewaySk, parts.epk)));
}

describe('上限（裁示 7）', () => {
  it('預設值：每家 32 端點、標準 1／分、即時 6／分、閘道每 token 60／時、TTL 30 天', () => {
    const l = iotPushLimits();
    expect(l).toMatchObject({ maxEndpoints: 32, standardPerMinute: 1, instantPerMinute: 6, gatewayTokenPerHour: 60, gatewayTokenPerMinute: 6, registrationTtlSec: 30 * 86_400 });
  });

  it('可設定；strict 時超出範圍丟例外，否則夾進範圍', () => {
    expect(iotPushLimits({ maxEndpoints: 8, instantPerMinute: 3 }).maxEndpoints).toBe(8);
    expect(() => iotPushLimits({ maxEndpoints: 0 }, { strict: true })).toThrow(/maxEndpoints/);
    expect(iotPushLimits({ maxEndpoints: 10_000 }).maxEndpoints).toBe(IOT_PUSH_LIMITS.maxEndpoints.max);
    expect(() => iotPushLimits({ standardPerMinute: 1.5 }, { strict: true })).toThrow();
  });
});

describe('端點', () => {
  it('unifiedpush 要 https；區網主機在 allowPrivateHttp 時可以 http', () => {
    expect(parseIotPushEndpoint({ type: 'unifiedpush', url: 'https://ntfy.example/up123' })).toEqual({ type: 'unifiedpush', url: 'https://ntfy.example/up123' });
    expect(() => parseIotPushEndpoint({ type: 'unifiedpush', url: 'http://ntfy.example/up' })).toThrow(/https/);
    expect(() => parseIotPushEndpoint({ type: 'unifiedpush', url: 'http://8.8.8.8/up' }, { allowPrivateHttp: true })).toThrow();
    expect(parseIotPushEndpoint({ type: 'unifiedpush', url: 'http://192.168.1.5:8080/up' }, { allowPrivateHttp: true }).url).toBe('http://192.168.1.5:8080/up');
    expect(() => parseIotPushEndpoint({ type: 'unifiedpush', url: 'https://u:p@ntfy.example/up' })).toThrow(/帳號密碼/);
    expect(() => parseIotPushEndpoint({ type: 'unifiedpush', url: 'https://x', extra: 1 })).toThrow();
  });

  it('區網主機判斷', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.9', 'nas.local', 'pi.lan', 'x.home.arpa', '[::1]', 'fd12::1']) {
      expect(isPrivateIotPushHost(h)).toBe(true);
    }
    for (const h of ['8.8.8.8', '172.32.0.1', 'example.com', '192.169.0.1']) expect(isPrivateIotPushHost(h)).toBe(false);
  });

  it('gateway 端點：網址去掉結尾斜線；sealed 與 key 的形狀不對就拒絕；錯誤訊息不含端點內容', () => {
    const { sealed, key } = sealIotPushToken(gatewayPub, { platform: 'android', token: FCM_TOKEN });
    const ep = parseIotPushEndpoint({ type: 'gateway', url: 'https://push.example/', sealed, key });
    expect(ep).toEqual({ type: 'gateway', url: 'https://push.example', sealed, key });
    expect(() => parseIotPushEndpoint({ type: 'gateway', url: 'https://push.example', sealed: 'nope', key })).toThrow(/封包/);
    try {
      parseIotPushEndpoint({ type: 'gateway', url: 'https://push.example', sealed, key: 'SECRET-NOT-HEX' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('SECRET-NOT-HEX');
    }
  });

  it('端點 id 是確定的；不同端點不同 id', () => {
    const a: IotPushEndpoint = { type: 'unifiedpush', url: 'https://ntfy.example/a' };
    expect(iotPushEndpointId(a)).toBe(iotPushEndpointId({ ...a }));
    expect(iotPushEndpointId(a)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(iotPushEndpointId(a)).not.toBe(iotPushEndpointId({ type: 'unifiedpush', url: 'https://ntfy.example/b' }));
  });
});

describe('token 封包', () => {
  it('只有推播閘道解得開；內含平台、token、每次登記獨有密鑰、到期', () => {
    const { sealed, key, expiresAt } = sealIotPushToken(gatewayPub, { platform: 'ios', token: FCM_TOKEN, now: 1_759_000_000_000 });
    expect(sealed).toMatch(/^cp1\.[0-9a-f]{64}\./);
    expect(sealed).not.toContain(FCM_TOKEN);
    const payload = parseIotPushTokenPayload(open(sealed));
    expect(payload).toMatchObject({ v: 1, p: 'ios', tt: 'fcm', t: FCM_TOKEN, k: key, iat: 1_759_000_000, exp: expiresAt });
    expect(expiresAt - 1_759_000_000).toBe(30 * 86_400);
    // 別把鑰匙解不開
    const parts = splitIotPushSealed(sealed)!;
    expect(() => decryptWithKey(parts.ciphertext, conversationKey(generateSecretKey(), parts.epk))).toThrow();
  });

  it('每次封都是新的密鑰與新的封包', () => {
    const a = sealIotPushToken(gatewayPub, { platform: 'android', token: FCM_TOKEN });
    const b = sealIotPushToken(gatewayPub, { platform: 'android', token: FCM_TOKEN });
    expect(a.key).not.toBe(b.key);
    expect(a.sealed).not.toBe(b.sealed);
  });

  it('APNs 裝置 token（iOS 直連）；Android 不能用 APNs；格式不對拒絕', () => {
    const apns = 'AB'.repeat(32);
    const { sealed } = sealIotPushToken(gatewayPub, { platform: 'ios', token: apns, tokenType: 'apns' });
    expect(parseIotPushTokenPayload(open(sealed))).toMatchObject({ tt: 'apns', t: apns.toLowerCase() });
    expect(() => sealIotPushToken(gatewayPub, { platform: 'android', token: apns, tokenType: 'apns' })).toThrow(/Android/);
    expect(() => sealIotPushToken(gatewayPub, { platform: 'ios', token: 'xyz', tokenType: 'apns' })).toThrow();
    expect(() => sealIotPushToken('not-a-key', { platform: 'android', token: FCM_TOKEN })).toThrow();
  });

  it('ttl 夾在 1 小時–30 天', () => {
    const now = 1_759_000_000_000;
    expect(sealIotPushToken(gatewayPub, { platform: 'android', token: FCM_TOKEN, ttlSec: 10, now }).expiresAt).toBe(1_759_000_000 + 3_600);
    expect(sealIotPushToken(gatewayPub, { platform: 'android', token: FCM_TOKEN, ttlSec: 999 * 86_400, now }).expiresAt).toBe(1_759_000_000 + 30 * 86_400);
  });

  it('parseIotPushTokenPayload 擋掉不合法的明文', () => {
    const ok = { v: 1, p: 'android', tt: 'fcm', t: FCM_TOKEN, k: 'a'.repeat(64), iat: 1, exp: 2 };
    expect(parseIotPushTokenPayload(ok)).toBeDefined();
    expect(parseIotPushTokenPayload({ ...ok, tt: 'apns' })).toBeUndefined();
    expect(parseIotPushTokenPayload({ ...ok, exp: 1 })).toBeUndefined();
    expect(parseIotPushTokenPayload({ ...ok, k: 'zz' })).toBeUndefined();
    expect(parseIotPushTokenPayload({ ...ok, v: 2 })).toBeUndefined();
  });
});

describe('喚醒請求', () => {
  const sealedFor = () => {
    const { sealed, key } = sealIotPushToken(gatewayPub, { platform: 'android', token: FCM_TOKEN });
    return { type: 'gateway' as const, url: 'https://push.example', sealed, key };
  };

  it('簽章以登記密鑰做 HMAC，涵蓋時間戳、ref 與登記 id', () => {
    const ep = sealedFor();
    const ref = 'e'.repeat(64);
    const body = buildIotPushWakeBody(ep, { ts: 1_759_000_000_123, ref });
    expect(Object.keys(body).sort()).toEqual(['ref', 'sealed', 'sig', 'ts', 'v']);
    expect(body.sig).toBe(iotPushSign(ep.key, iotPushWakeMessage(iotPushRegId(ep.sealed), 1_759_000_000_123, ref)));
    expect(body.sig).not.toBe(iotPushSign(ep.key, iotPushWakeMessage(iotPushRegId(ep.sealed), 1_759_000_000_124, ref)));
    const revoke = buildIotPushRevokeBody(ep, 5);
    expect(revoke.sig).toBe(iotPushSign(ep.key, iotPushRevokeMessage(iotPushRegId(ep.sealed), 5)));
  });

  it('ref 只收 64 位 hex；其他內容不會被帶出去', () => {
    const ep = sealedFor();
    expect(buildIotPushWakeBody(ep, { ts: 1, ref: '門被打開了' }).ref).toBeUndefined();
  });

  it('assertEmptyIotPushWake：多一個欄位（設備、類別、內容）就丟例外', () => {
    const body = buildIotPushWakeBody(sealedFor(), { ts: 1 });
    expect(() => assertEmptyIotPushWake(body)).not.toThrow();
    for (const extra of [{ device: 'door' }, { category: 'security' }, { title: 'x' }, { body: 'x' }]) {
      expect(() => assertEmptyIotPushWake({ ...body, ...extra })).toThrow(/不得帶設備、內容或類別/);
    }
    expect(() => assertEmptyIotPushWake({ ...body, ref: 'abc' })).toThrow(/ref/);
  });

  it('UnifiedPush：本文空的，不帶 ref；推播閘道：POST /v1/wake', () => {
    const up = buildIotPushRequest({ type: 'unifiedpush', url: 'https://ntfy.example/up1' }, { ts: 1, ref: 'a'.repeat(64) });
    expect(up).toEqual({ url: 'https://ntfy.example/up1', method: 'POST', headers: { TTL: '3600', Urgency: 'high' }, body: '' });
    const gw = buildIotPushRequest(sealedFor(), { ts: 7 });
    expect(gw.url).toBe('https://push.example/v1/wake');
    expect(JSON.parse(gw.body)).toMatchObject({ v: 1, ts: 7 });
  });

  it('HTTP 狀態 → 送出結果；Retry-After 秒數與日期', () => {
    expect(iotPushResultOf(201, null, 0)).toEqual({ status: 'ok' });
    expect(iotPushResultOf(410, null, 0)).toEqual({ status: 'gone' });
    expect(iotPushResultOf(404, null, 0)).toEqual({ status: 'gone' });
    expect(iotPushResultOf(429, '30', 0)).toEqual({ status: 'retry', retryAfterMs: 30_000 });
    expect(iotPushResultOf(500, null, 0)).toEqual({ status: 'error', reason: 'http-500' });
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(retryAfterMs('garbage', 0, 5)).toBe(5);
  });

  it('fetchIotPushSend：照請求送；失敗的原因不含網址', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = fetchIotPushSend(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status: 201 });
    });
    expect(await ok({ type: 'unifiedpush', url: 'https://ntfy.example/secret-topic' }, { ts: 1 })).toEqual({ status: 'ok' });
    expect(calls[0]).toMatchObject({ url: 'https://ntfy.example/secret-topic', init: { method: 'POST', body: '' } });
    const broken = fetchIotPushSend(async () => {
      throw new Error('connect ECONNREFUSED https://ntfy.example/secret-topic');
    });
    const result = await broken({ type: 'unifiedpush', url: 'https://ntfy.example/secret-topic' }, { ts: 1 });
    expect(result).toEqual({ status: 'error', reason: 'network' });
  });
});

describe('$sys/push 操作與訂閱', () => {
  const dv = 'A'.repeat(22);

  it('訂閱：mode 預設 standard；dv 或 special 擇一；不重複；上限 64', () => {
    expect(parseIotPushSubscriptions([{ dv }, { special: 'quota', mode: 'instant' }])).toEqual([
      { dv, mode: 'standard' },
      { special: 'quota', mode: 'instant' },
    ]);
    expect(() => parseIotPushSubscriptions([{ dv, special: 'quota' }])).toThrow();
    expect(() => parseIotPushSubscriptions([{ dv }, { dv }])).toThrow(/重複/);
    expect(() => parseIotPushSubscriptions([{ dv: 'door' }])).toThrow(/盲化/);
    expect(() => parseIotPushSubscriptions([{ dv, mode: 'urgent' }])).toThrow(/mode/);
    expect(() => parseIotPushSubscriptions([{ special: 'alarm' }])).toThrow();
    expect(() => parseIotPushSubscriptions([])).toThrow();
  });

  it('register／remove', () => {
    expect(parseIotPushOp(JSON.stringify({ op: 'register', endpoint: 'ciphertext', subscriptions: [{ dv }], ttlSec: 60 }))).toEqual({
      op: 'register',
      endpoint: 'ciphertext',
      subscriptions: [{ dv, mode: 'standard' }],
      ttlSec: 60,
    });
    expect(parseIotPushOp(JSON.stringify({ op: 'remove', id: 'B'.repeat(22) }))).toEqual({ op: 'remove', id: 'B'.repeat(22) });
    expect(() => parseIotPushOp('{')).toThrow(/JSON/);
    expect(() => parseIotPushOp(JSON.stringify({ op: 'list' }))).toThrow();
    expect(() => parseIotPushOp(JSON.stringify({ op: 'remove', id: 'x' }))).toThrow();
  });
});
