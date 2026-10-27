// 推播閘道直連 APNs（SDK ADR 0061；ADR 0049 §11.1 裁示 5 與實測）：Node 版與 Workers 版共用的純函式（請求、provider token、回應對照），
// Workers 版以 fetch() 送（注入 mock，絕不呼叫真的 APNs）；JWT 以 node:crypto 的公鑰驗章。
import { createPublicKey, generateKeyPairSync, verify as verifySignature } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../../src/identity.js';
import { buildIotPushRequest, sealIotPushToken, type IotPushEndpoint } from '../../src/iot/push.js';
import {
  APNS_JWT_REFRESH_SEC,
  APNS_ORIGINS,
  APNS_REASONS,
  ApnsSender,
  apnsResultOf,
  buildApnsRequest,
  createPushGatewayFromEnv,
  fetchApnsTransport,
  memoryPushGatewayStore,
  pushGatewayConfigFromEnv,
  type ApnsCredentials,
  type PushGatewayLogEntry,
} from '../../src/iot/push-gateway/index.js';
import worker, { PushGatewayState, type PushStateNamespaceLike } from '../../src/iot/push-gateway/worker.js';

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'cinder-test-123',
  private_key_id: 'abcdef0123456789',
  private_key: rsa.privateKey,
  client_email: 'push@cinder-test-123.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});
const pushKey = Identity.generate();
const APNS_TOKEN = 'ab'.repeat(32);
const FCM_TOKEN = 'fcm-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789';
const CREDS: ApnsCredentials = { keyPem: ec.privateKey, keyId: 'ABC123DEFG', teamId: 'TEAM123456', topic: 'com.example.cinder', environment: 'sandbox' };
const APNS_ENV = {
  PUSH_GATEWAY_KEY: pushKey.nsec(),
  PUSH_IOS: 'apns',
  PUSH_ANDROID: '0',
  APNS_KEY: ec.privateKey,
  APNS_KEY_ID: 'ABC123DEFG',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_TOPIC: 'com.example.cinder',
  APNS_ENV: 'sandbox',
};

/** 假的 APNs（fetch mock）：記下每個請求，依序回應 */
function fakeApns(respond: (n: number) => Response = () => new Response(null, { status: 200, headers: { 'apns-id': 'x' } })) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? '') });
    return respond(calls.length);
  }) as typeof fetch;
  return { fetchMock, calls };
}

const reason = (status: number, r: string) => () => new Response(JSON.stringify({ reason: r }), { status, headers: { 'content-type': 'application/json' } });

function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c!, 'base64url').toString('utf8')) as Record<string, unknown>,
    input: `${h}.${c}`,
    signature: Buffer.from(s!, 'base64url'),
  };
}
const bearer = (headers: Record<string, string>) => String(headers.authorization).replace(/^bearer /, '');
const verifies = (jwt: string) => {
  const d = decodeJwt(jwt);
  return verifySignature('sha256', Buffer.from(d.input), { key: createPublicKey(ec.publicKey), dsaEncoding: 'ieee-p1363' }, d.signature);
};

function endpointFor(platform: 'android' | 'ios', tokenType: 'fcm' | 'apns' = 'apns'): Extract<IotPushEndpoint, { type: 'gateway' }> {
  const { sealed, key } = sealIotPushToken(pushKey.pubkey, { platform, token: tokenType === 'fcm' ? FCM_TOKEN : APNS_TOKEN, tokenType });
  return { type: 'gateway', url: 'https://push.example', sealed, key };
}
function wakeRequest(endpoint: IotPushEndpoint, ts = Date.now(), ref?: string): Request {
  const req = buildIotPushRequest(endpoint, { ts, ...(ref ? { ref } : {}) });
  return new Request(req.url, { method: req.method, headers: req.headers, body: req.body });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('共用純函式：APNs 請求與回應對照', () => {
  it('buildApnsRequest：路徑、標頭、payload（一般推播＋mutable-content、只帶 ref）；sandbox／production 主機', () => {
    const req = buildApnsRequest({ credentials: CREDS, deviceToken: APNS_TOKEN, providerToken: 'h.c.s', nowSec: 1_000, locKey: 'CINDER_WAKE', ref: 'c'.repeat(64) });
    expect(req.origin).toBe('https://api.sandbox.push.apple.com');
    expect(req.path).toBe(`/3/device/${APNS_TOKEN}`);
    expect(req.headers).toEqual({
      authorization: 'bearer h.c.s',
      'apns-topic': 'com.example.cinder',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '4600',
      'content-type': 'application/json',
    });
    expect(JSON.parse(req.body)).toEqual({ aps: { alert: { 'loc-key': 'CINDER_WAKE' }, 'mutable-content': 1 }, ref: 'c'.repeat(64) });
    expect(buildApnsRequest({ credentials: { ...CREDS, environment: 'production' }, deviceToken: APNS_TOKEN, providerToken: 't', nowSec: 0, locKey: 'X' }).origin).toBe('https://api.push.apple.com');
    expect(APNS_ORIGINS).toEqual({ production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' });
    expect(() => buildApnsRequest({ credentials: CREDS, deviceToken: APNS_TOKEN, providerToken: 't', nowSec: 0, locKey: '有新動態' })).toThrow(/空的喚醒/);
  });

  it('provider token 的重簽間隔在 Apple 要求的 20–60 分鐘之間', () => {
    expect(APNS_JWT_REFRESH_SEC).toBeGreaterThanOrEqual(20 * 60);
    expect(APNS_JWT_REFRESH_SEC).toBeLessThan(60 * 60);
  });

  it('apnsResultOf：每個 reason 對到推播閘道的結果（gone＝送出端刪掉端點）', () => {
    const table: [number, string | undefined, unknown][] = [
      [200, undefined, { status: 'ok' }],
      [410, 'Unregistered', { status: 'gone', apnsReason: 'Unregistered' }],
      [410, 'ExpiredToken', { status: 'gone', apnsReason: 'ExpiredToken' }],
      [400, 'BadDeviceToken', { status: 'gone', apnsReason: 'BadDeviceToken' }],
      [400, 'DeviceTokenNotForTopic', { status: 'gone', apnsReason: 'DeviceTokenNotForTopic' }],
      [429, 'TooManyRequests', { status: 'retry', retryAfterSec: 60, apnsReason: 'TooManyRequests' }],
      [429, 'TooManyProviderTokenUpdates', { status: 'retry', retryAfterSec: 60, apnsReason: 'TooManyProviderTokenUpdates' }],
      [500, 'InternalServerError', { status: 'retry', retryAfterSec: 60, apnsReason: 'InternalServerError' }],
      [503, 'ServiceUnavailable', { status: 'retry', retryAfterSec: 60, apnsReason: 'ServiceUnavailable' }],
      [503, 'Shutdown', { status: 'retry', retryAfterSec: 60, apnsReason: 'Shutdown' }],
      [403, 'ExpiredProviderToken', { status: 'error', code: 'auth', apnsReason: 'ExpiredProviderToken' }],
      [403, 'InvalidProviderToken', { status: 'error', code: 'auth', apnsReason: 'InvalidProviderToken' }],
      [403, 'MissingProviderToken', { status: 'error', code: 'auth', apnsReason: 'MissingProviderToken' }],
      [403, 'BadCertificateEnvironment', { status: 'error', code: 'auth', apnsReason: 'BadCertificateEnvironment' }],
      // 金鑰限定 Sandbox 或 Production、與 APNS_ENV 不符：獨立的代碼，部署說明有對應的改法（SDK ADR 0062 §6）
      [403, 'BadEnvironmentKeyInToken', { status: 'error', code: 'key-environment', apnsReason: 'BadEnvironmentKeyInToken' }],
      [400, 'TopicDisallowed', { status: 'error', code: 'topicdisallowed', apnsReason: 'TopicDisallowed' }],
      [400, 'BadTopic', { status: 'error', code: 'badtopic', apnsReason: 'BadTopic' }],
      [413, 'PayloadTooLarge', { status: 'error', code: 'payloadtoolarge', apnsReason: 'PayloadTooLarge' }],
      [400, undefined, { status: 'error', code: 'http-400', apnsReason: 'other' }],
      // 不在 Apple 文件清單裡的 reason：一律 other，也不拿來組代碼
      [400, 'SomethingNewFromApple', { status: 'error', code: 'http-400', apnsReason: 'other' }],
      [403, 'NotARealReason', { status: 'error', code: 'auth', apnsReason: 'other' }],
    ];
    for (const [status, r, want] of table) expect(apnsResultOf(status, r), `${status} ${r}`).toEqual(want);
  });

  it('APNS_REASONS：Apple 文件列出的 reason 白名單（含 BadEnvironmentKeyInToken），只有英文字母', () => {
    for (const r of ['BadEnvironmentKeyInToken', 'InvalidProviderToken', 'ExpiredProviderToken', 'Unregistered', 'BadDeviceToken', 'TopicDisallowed', 'TooManyProviderTokenUpdates']) {
      expect(APNS_REASONS, r).toContain(r);
    }
    for (const r of APNS_REASONS) expect(r).toMatch(/^[A-Za-z]{1,40}$/);
    expect(new Set(APNS_REASONS).size).toBe(APNS_REASONS.length);
  });
});

describe('Workers 版的傳輸：fetch() 直連 APNs', () => {
  it('fetchApnsTransport：POST 到主機＋路徑，帶標頭與本文；回應只取狀態與（截斷的）本文；連不上 → network', async () => {
    const apns = fakeApns(reason(400, 'BadDeviceToken'));
    const t = fetchApnsTransport({ fetch: apns.fetchMock });
    const res = await t.post('https://api.sandbox.push.apple.com', `/3/device/${APNS_TOKEN}`, { 'apns-topic': 'com.example.cinder' }, '{"aps":{}}');
    expect(res).toEqual({ status: 400, body: '{"reason":"BadDeviceToken"}' });
    expect(apns.calls[0]).toMatchObject({ url: `https://api.sandbox.push.apple.com/3/device/${APNS_TOKEN}`, method: 'POST', headers: { 'apns-topic': 'com.example.cinder' }, body: '{"aps":{}}' });
    const down = fetchApnsTransport({ fetch: (async () => { throw new TypeError('Network connection lost'); }) as typeof fetch });
    await expect(down.post('https://api.push.apple.com', '/3/device/x', {}, '')).rejects.toThrow(/^network$/);
    const long = fetchApnsTransport({ fetch: (async () => new Response('x'.repeat(10_000), { status: 400 })) as typeof fetch });
    expect((await long.post('https://api.push.apple.com', '/', {}, '')).body.length).toBe(4096);
  });

  it('ApnsSender＋fetch：ES256 JWT（header alg／kid、claims iss／iat）以公鑰驗得過', async () => {
    const apns = fakeApns();
    const now = 1_760_000_000_000;
    const sender = new ApnsSender({ credentials: CREDS, transport: fetchApnsTransport({ fetch: apns.fetchMock }), now: () => now });
    expect(await sender.send({ platform: 'ios', tokenType: 'apns', token: APNS_TOKEN })).toEqual({ status: 'ok' });
    const jwt = bearer(apns.calls[0]!.headers);
    expect(jwt.split('.')).toHaveLength(3);
    const d = decodeJwt(jwt);
    expect(d.header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(d.claims).toEqual({ iss: 'TEAM123456', iat: now / 1000 });
    expect(verifies(jwt)).toBe(true);
    expect(apns.calls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${APNS_TOKEN}`);
  });

  it('JWT 快取：重簽間隔內重用同一顆，到期才換新的；同時送出只簽一次', async () => {
    const apns = fakeApns();
    let now = 1_760_000_000_000;
    const sender = new ApnsSender({ credentials: CREDS, transport: fetchApnsTransport({ fetch: apns.fetchMock }), now: () => now });
    const send = () => sender.send({ platform: 'ios', tokenType: 'apns', token: APNS_TOKEN });
    await Promise.all([send(), send(), send()]);
    now += (APNS_JWT_REFRESH_SEC - 1) * 1000;
    await send();
    const first = new Set(apns.calls.map((c) => bearer(c.headers)));
    expect(first.size).toBe(1);
    now += 1000;
    await send();
    const renewed = bearer(apns.calls.at(-1)!.headers);
    expect(first.has(renewed)).toBe(false);
    expect(decodeJwt(renewed).claims.iat).toBe(now / 1000);
    expect(verifies(renewed)).toBe(true);
  });

  it('403 ExpiredProviderToken：重簽一次再送；再過期就回錯誤，不無限重試', async () => {
    const once = fakeApns((n) => (n === 1 ? reason(403, 'ExpiredProviderToken')() : reason(410, 'Unregistered')()));
    const now = 1_760_000_000_000;
    const a = new ApnsSender({ credentials: CREDS, transport: fetchApnsTransport({ fetch: once.fetchMock }), now: () => now });
    expect(await a.send({ platform: 'ios', tokenType: 'apns', token: APNS_TOKEN })).toEqual({ status: 'gone', apnsReason: 'Unregistered' });
    expect(once.calls).toHaveLength(2);
    expect(bearer(once.calls[0]!.headers)).not.toBe(bearer(once.calls[1]!.headers));

    const always = fakeApns(reason(403, 'ExpiredProviderToken'));
    const b = new ApnsSender({ credentials: CREDS, transport: fetchApnsTransport({ fetch: always.fetchMock }), now: () => now });
    expect(await b.send({ platform: 'ios', tokenType: 'apns', token: APNS_TOKEN })).toEqual({ status: 'error', code: 'auth', apnsReason: 'ExpiredProviderToken' });
    expect(always.calls).toHaveLength(2);
  });

  it('同時兩個請求都收到 ExpiredProviderToken：只重簽一次（不觸發 TooManyProviderTokenUpdates）', async () => {
    // 前兩個請求（同一顆舊 token）都被判過期，之後都成功
    const apns = fakeApns((n) => (n <= 2 ? reason(403, 'ExpiredProviderToken')() : new Response(null, { status: 200 })));
    const sender = new ApnsSender({ credentials: CREDS, transport: fetchApnsTransport({ fetch: apns.fetchMock }), now: () => 1_760_000_000_000 });
    const send = () => sender.send({ platform: 'ios', tokenType: 'apns', token: APNS_TOKEN });
    expect(await Promise.all([send(), send()])).toEqual([{ status: 'ok' }, { status: 'ok' }]);
    expect(apns.calls).toHaveLength(4);
    const tokens = apns.calls.map((c) => bearer(c.headers));
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).toBe(tokens[3]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it('不是 APNs 裝置 token → wrong-token-type，不送', async () => {
    const apns = fakeApns();
    const sender = new ApnsSender({ credentials: CREDS, transport: fetchApnsTransport({ fetch: apns.fetchMock }) });
    expect(await sender.send({ platform: 'ios', tokenType: 'fcm', token: FCM_TOKEN })).toEqual({ status: 'error', code: 'wrong-token-type' });
    expect(apns.calls).toEqual([]);
  });
});

describe('Workers 版推播閘道：iOS 直連 APNs', () => {
  function fakeNamespace(): PushStateNamespaceLike {
    const objects = new Map<string, PushGatewayState>();
    return {
      idFromName: (name) => name,
      get: (id) => {
        let obj = objects.get(id as string);
        if (!obj) {
          const data = new Map<string, unknown>();
          obj = new PushGatewayState({ storage: { get: async <T>(k: string) => data.get(k) as T | undefined, put: async (k, v) => void data.set(k, structuredClone(v)) } });
          objects.set(id as string, obj);
        }
        const o = obj;
        return { fetch: (input, init) => o.fetch(new Request(input, init)) };
      },
    };
  }

  it('設定：Workers 版接受 PUSH_IOS=apns（不再限定 Node 版）', () => {
    expect(pushGatewayConfigFromEnv(APNS_ENV, 'worker').ios).toBe('apns');
  });

  it('createPushGatewayFromEnv(worker)：預設以 fetch 送 APNs，不經 Google、不需要 FCM_SERVICE_ACCOUNT', async () => {
    const apns = fakeApns();
    const logs: PushGatewayLogEntry[] = [];
    const gw = await createPushGatewayFromEnv(APNS_ENV, 'worker', { store: memoryPushGatewayStore(), fetch: apns.fetchMock, onLog: (e) => logs.push(e) });
    expect(gw.config.ios).toBe('apns');
    const res = await gw.handle(wakeRequest(endpointFor('ios'), Date.now(), 'c'.repeat(64)));
    expect(res.status).toBe(202);
    expect(apns.calls).toHaveLength(1);
    expect(apns.calls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${APNS_TOKEN}`);
    expect(apns.calls.some((c) => c.url.includes('googleapis'))).toBe(false);
    expect(JSON.parse(apns.calls[0]!.body)).toEqual({ aps: { alert: { 'loc-key': 'CINDER_WAKE' }, 'mutable-content': 1 }, ref: 'c'.repeat(64) });
    expect(verifies(bearer(apns.calls[0]!.headers))).toBe(true);
    expect(logs).toEqual([{ event: 'wake', result: 'ok', platform: 'ios' }]);
  });

  it('production 主機（APNS_ENV 預設 production）', async () => {
    const apns = fakeApns();
    const env: Record<string, string> = { ...APNS_ENV };
    delete env.APNS_ENV;
    const gw = await createPushGatewayFromEnv(env, 'worker', { store: memoryPushGatewayStore(), fetch: apns.fetchMock });
    expect((await gw.handle(wakeRequest(endpointFor('ios')))).status).toBe(202);
    expect(apns.calls[0]!.url).toBe(`https://api.push.apple.com/3/device/${APNS_TOKEN}`);
  });

  it('APNs 的結果經推播閘道回給送出端：Unregistered／BadDeviceToken／DeviceTokenNotForTopic → 410；429 → 503＋Retry-After；認證錯 → 502', async () => {
    for (const [respond, status] of [
      [reason(410, 'Unregistered'), 410],
      [reason(400, 'BadDeviceToken'), 410],
      [reason(400, 'DeviceTokenNotForTopic'), 410],
      [reason(429, 'TooManyRequests'), 503],
      [reason(403, 'InvalidProviderToken'), 502],
    ] as const) {
      const apns = fakeApns(respond);
      const gw = await createPushGatewayFromEnv(APNS_ENV, 'worker', { store: memoryPushGatewayStore(), fetch: apns.fetchMock });
      const res = await gw.handle(wakeRequest(endpointFor('ios')));
      expect(res.status).toBe(status);
      if (status === 503) expect(res.headers.get('Retry-After')).toBe('60');
    }
  });

  it('APNs 的 reason 進結構化日誌（白名單外＝other），不進回應本文；日誌不含 token、JWT 或金鑰', async () => {
    const cases: [() => Response, string, string][] = [
      [reason(403, 'BadEnvironmentKeyInToken'), 'error-key-environment', 'BadEnvironmentKeyInToken'],
      [reason(403, 'InvalidProviderToken'), 'error-auth', 'InvalidProviderToken'],
      [reason(410, 'Unregistered'), 'gone', 'Unregistered'],
      [reason(429, 'TooManyRequests'), 'retry', 'TooManyRequests'],
      [reason(400, 'SomethingNewFromApple'), 'error-http-400', 'other'],
      [() => new Response(JSON.stringify({ reason: APNS_TOKEN }), { status: 400 }), 'error-http-400', 'other'],
      [() => new Response('not json', { status: 500 }), 'retry', 'other'],
    ];
    for (const [respond, result, apnsReason] of cases) {
      const apns = fakeApns(respond);
      const logs: PushGatewayLogEntry[] = [];
      const gw = await createPushGatewayFromEnv(APNS_ENV, 'worker', { store: memoryPushGatewayStore(), fetch: apns.fetchMock, onLog: (e) => logs.push(e) });
      const res = await gw.handle(wakeRequest(endpointFor('ios')));
      expect(logs, result).toEqual([{ event: 'wake', result, platform: 'ios', apnsReason }]);
      // 回應本文不帶 reason（送出端不是推播閘道的維運者；SDK ADR 0062 §6）
      const body = await res.text();
      expect(body).not.toContain('apnsReason');
      if (apnsReason !== 'other') expect(body).not.toContain(apnsReason);
      const logText = JSON.stringify(logs);
      for (const secret of [APNS_TOKEN, 'PRIVATE KEY', bearer(apns.calls[0]!.headers)]) expect(logText).not.toContain(secret);
    }
    // 成功與送出前就被擋下的（重放）沒有 apnsReason
    const ok = fakeApns();
    const logs: PushGatewayLogEntry[] = [];
    const gw = await createPushGatewayFromEnv(APNS_ENV, 'worker', { store: memoryPushGatewayStore(), fetch: ok.fetchMock, onLog: (e) => logs.push(e) });
    const ep = endpointFor('ios');
    const ts = Date.now();
    await gw.handle(wakeRequest(ep, ts));
    await gw.handle(wakeRequest(ep, ts));
    expect(logs).toEqual([{ event: 'wake', result: 'ok', platform: 'ios' }, { event: 'wake', result: 'replay', platform: 'ios' }]);
  });

  it('既有的每 token 上限照樣生效：超過每分鐘上限 → 429，不呼叫 APNs', async () => {
    const apns = fakeApns();
    const gw = await createPushGatewayFromEnv({ ...APNS_ENV, PUSH_TOKEN_PER_MINUTE: '1' }, 'worker', { store: memoryPushGatewayStore(), fetch: apns.fetchMock });
    const ep = endpointFor('ios');
    const ts = Date.now();
    expect((await gw.handle(wakeRequest(ep, ts))).status).toBe(202);
    const limited = await gw.handle(wakeRequest(ep, ts + 1));
    expect(limited.status).toBe(429);
    expect(apns.calls).toHaveLength(1);
  });

  it('worker.fetch：Worker 入口以全域 fetch 直連 APNs、狀態在 DO；日誌不含金鑰或 token', async () => {
    const apns = fakeApns();
    vi.stubGlobal('fetch', apns.fetchMock);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    const env = { ...APNS_ENV, PUSH_STATE: fakeNamespace() };
    const ep = endpointFor('ios');
    const ts = Date.now();
    expect((await worker.fetch(wakeRequest(ep, ts), env)).status).toBe(202);
    expect((await worker.fetch(wakeRequest(ep, ts), env)).status).toBe(409);
    expect(apns.calls).toHaveLength(1);
    expect(apns.calls[0]!.url.startsWith('https://api.sandbox.push.apple.com/3/device/')).toBe(true);
    const all = lines.join('\n');
    expect(all).not.toContain(APNS_TOKEN);
    expect(all).not.toContain('PRIVATE KEY');
    expect(all).not.toContain(bearer(apns.calls[0]!.headers));
  });

  it('PUSH_IOS=apns 卻沒設 APNS_KEY：Worker 回 503 not-configured，錯誤只寫變數名稱', async () => {
    const env: Record<string, unknown> = { ...APNS_ENV, PUSH_STATE: fakeNamespace() };
    delete env.APNS_KEY;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errors.push(String(line)));
    const res = await worker.fetch(wakeRequest(endpointFor('ios')), env as Parameters<typeof worker.fetch>[1]);
    expect(res.status).toBe(503);
    expect(errors.join('\n')).toContain('APNS_KEY');
    expect(errors.join('\n')).not.toContain(pushKey.nsec());
  });

  it('Node 版沒有 HTTP/2 傳輸時仍拒絕直連（Node 的 fetch 不講 HTTP/2）', async () => {
    await expect(createPushGatewayFromEnv(APNS_ENV, 'node', { store: memoryPushGatewayStore() })).rejects.toThrow(/http2ApnsTransport/);
  });
});

describe('預設直連 APNs、iOS 經 FCM 兩版都棄用（v0.48.0；SDK ADR 0062）', () => {
  /** 假的 Google：OAuth 與 FCM 送出 */
  function fakeGoogle() {
    const calls: string[] = [];
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
      return Response.json({ name: 'projects/cinder-test-123/messages/1' });
    }) as typeof fetch;
    return { fetchMock, calls };
  }
  const FCM_ONLY = { PUSH_GATEWAY_KEY: pushKey.nsec(), FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT };
  const { PUSH_IOS: _ignored, ...APNS_UNSET } = APNS_ENV;

  it('沒寫 PUSH_IOS、有 APNs 設定：兩版都直連 APNs（/v1/info 的 ios 是 apns），不經 Google、不記棄用', async () => {
    const apns = fakeApns();
    const logs: PushGatewayLogEntry[] = [];
    const gw = await createPushGatewayFromEnv(APNS_UNSET, 'worker', { store: memoryPushGatewayStore(), fetch: apns.fetchMock, onLog: (e) => logs.push(e) });
    expect(gw.config.ios).toBe('apns');
    expect(((await (await gw.handle(new Request('https://push.example/v1/info'))).json()) as { ios: string }).ios).toBe('apns');
    expect((await gw.handle(wakeRequest(endpointFor('ios')))).status).toBe(202);
    expect(apns.calls).toHaveLength(1);
    expect(logs.some((l) => l.event === 'config')).toBe(false);
    const node = await createPushGatewayFromEnv(APNS_UNSET, 'node', { store: memoryPushGatewayStore(), apnsTransport: fetchApnsTransport({ fetch: fakeApns().fetchMock }) });
    expect(node.config.ios).toBe('apns');
  });

  it('沒寫 PUSH_IOS、只有 FCM 設定（v0.47 以前的設定）：啟動失敗，訊息指出缺哪個變數與三種改法（只寫變數名稱）', async () => {
    for (const host of ['worker', 'node'] as const) {
      let message = '';
      try {
        await createPushGatewayFromEnv(FCM_ONLY, host, { store: memoryPushGatewayStore(), fetch: fakeGoogle().fetchMock, apnsTransport: fetchApnsTransport({ fetch: fakeApns().fetchMock }) });
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).toContain('APNS_KEY');
      expect(message).toMatch(/PUSH_IOS 沒寫時預設是 apns/);
      expect(message).toContain('PUSH_IOS=off');
      expect(message).toContain('PUSH_IOS=fcm');
      expect(message).not.toContain(pushKey.nsec());
      expect(message).not.toContain('PRIVATE KEY');
    }
  });

  it('明寫 PUSH_IOS=apns 卻缺 APNs 設定：錯誤只寫缺的變數，不提預設值', async () => {
    const { APNS_TOPIC: _t, ...missing } = APNS_ENV;
    await expect(createPushGatewayFromEnv(missing, 'worker', { store: memoryPushGatewayStore(), fetch: fakeApns().fetchMock })).rejects.toThrow(/^APNS_TOPIC/);
  });

  it('沒寫 PUSH_IOS、只有 FCM 設定：Worker 回 503 not-configured，日誌只寫變數名稱', async () => {
    const objects = new Map<string, PushGatewayState>();
    const ns: PushStateNamespaceLike = {
      idFromName: (name) => name,
      get: (id) => {
        let obj = objects.get(id as string);
        if (!obj) {
          const data = new Map<string, unknown>();
          obj = new PushGatewayState({ storage: { get: async <T>(k: string) => data.get(k) as T | undefined, put: async (k, v) => void data.set(k, structuredClone(v)) } });
          objects.set(id as string, obj);
        }
        const o = obj;
        return { fetch: (input, init) => o.fetch(new Request(input, init)) };
      },
    };
    vi.stubGlobal('fetch', fakeGoogle().fetchMock);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errors.push(String(line)));
    const res = await worker.fetch(wakeRequest(endpointFor('android', 'fcm')), { ...FCM_ONLY, PUSH_STATE: ns });
    expect(res.status).toBe(503);
    expect(errors.join('\n')).toContain('APNS_KEY');
    expect(errors.join('\n')).toContain('PUSH_IOS=off');
    expect(errors.join('\n')).not.toContain(pushKey.nsec());
  });

  it('明寫 PUSH_IOS=fcm：仍經 FCM（/v1/info 的 ios 是 fcm），兩版都記一筆棄用的設定日誌', async () => {
    for (const host of ['worker', 'node'] as const) {
      const google = fakeGoogle();
      const logs: PushGatewayLogEntry[] = [];
      const gw = await createPushGatewayFromEnv({ ...FCM_ONLY, PUSH_IOS: 'fcm' }, host, { store: memoryPushGatewayStore(), fetch: google.fetchMock, onLog: (e) => logs.push(e) });
      expect(gw.config.ios).toBe('fcm');
      expect(((await (await gw.handle(new Request('https://push.example/v1/info'))).json()) as { ios: string }).ios).toBe('fcm');
      expect(logs).toEqual([{ event: 'config', result: 'ios-via-fcm-deprecated' }]);
      expect((await gw.handle(wakeRequest(endpointFor('ios', 'fcm')))).status).toBe(202);
      expect(google.calls.filter((u) => u.includes('messages:send'))).toHaveLength(1);
    }
  });

  it('PUSH_IOS=off：只支援 Android，不需要任何 Apple 金鑰、不記棄用；iOS 喚醒回 501', async () => {
    for (const host of ['worker', 'node'] as const) {
      const google = fakeGoogle();
      const logs: PushGatewayLogEntry[] = [];
      const gw = await createPushGatewayFromEnv({ ...FCM_ONLY, PUSH_IOS: 'off' }, host, { store: memoryPushGatewayStore(), fetch: google.fetchMock, onLog: (e) => logs.push(e) });
      expect(((await (await gw.handle(new Request('https://push.example/v1/info'))).json()) as { ios: string; android: boolean })).toMatchObject({ ios: 'off', android: true });
      expect((await gw.handle(wakeRequest(endpointFor('android', 'fcm')))).status).toBe(202);
      expect((await gw.handle(wakeRequest(endpointFor('ios', 'fcm')))).status).toBe(501);
      expect((await gw.handle(wakeRequest(endpointFor('ios', 'apns')))).status).toBe(501);
      expect(logs.filter((l) => l.event === 'config')).toEqual([]);
    }
  });

  it('沒有過渡期：PUSH_IOS=apns（含沒寫）時 iOS 的 FCM token 不改走 Google（501 platform-disabled）；Android 仍經 FCM', async () => {
    for (const env of [APNS_ENV, APNS_UNSET]) {
      const apns = fakeApns();
      const google = fakeGoogle();
      const both = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes('apple.com') ? apns.fetchMock(input, init) : google.fetchMock(input, init))) as typeof fetch;
      const gw = await createPushGatewayFromEnv({ ...env, PUSH_ANDROID: '1', FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT }, 'worker', { store: memoryPushGatewayStore(), fetch: both });
      expect((await gw.handle(wakeRequest(endpointFor('ios', 'fcm')))).status).toBe(501);
      expect((await gw.handle(wakeRequest(endpointFor('android', 'fcm')))).status).toBe(202);
      expect((await gw.handle(wakeRequest(endpointFor('ios', 'apns')))).status).toBe(202);
      expect(apns.calls).toHaveLength(1);
      expect(google.calls.filter((u) => u.includes('messages:send'))).toHaveLength(1);
    }
  });
});
