// 參考推播閘道（SDK ADR 0049 §11.1 裁示 3、5、7）：解封、驗簽、防重放、撤銷、每 token 上限、FCM／APNs 送出與零知識守門。
// 不呼叫 Google／Apple：FCM 以 fetch mock、APNs 以本機 HTTP/2（h2c）測試伺服器；JWT 以 node:crypto 的公鑰驗章。
import { createPublicKey, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { createServer as createHttp2Server, type Http2Server, type IncomingHttpHeaders } from 'node:http2';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../../src/identity.js';
import { buildIotPushRequest, buildIotPushRevokeBody, fetchIotPushSend, sealIotPushToken, type IotPushEndpoint } from '../../src/iot/push.js';
import {
  admitPushWake,
  androidFcmMessage,
  assertContentlessPushPayload,
  createPushGatewayFromEnv,
  DEFAULT_PUSH_GATEWAY_IOS_MODE,
  DEFAULT_PUSH_GATEWAY_LIMITS,
  iosWakePayload,
  memoryPushGatewayStore,
  parseFcmServiceAccount,
  pushGatewayConfigFromEnv,
  pushGatewayIosModeFromEnv,
  type PushGatewayLogEntry,
  type PushTokenState,
} from '../../src/iot/push-gateway/index.js';
import { startNodePushGateway } from '../../src/iot/push-gateway/node.js';
import worker, { PushGatewayState, type PushStateNamespaceLike } from '../../src/iot/push-gateway/worker.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'cinder-test-123',
  private_key_id: 'abcdef0123456789',
  private_key: rsa.privateKey,
  client_email: 'push@cinder-test-123.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});
const pushKey = Identity.generate();
const FCM_TOKEN = 'fcm-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789';
const APNS_TOKEN = 'ab'.repeat(32);
/** 經 FCM 的設定（iOS 明寫 fcm：v0.48.0 起預設改為 apns、fcm 已棄用但仍可用——SDK ADR 0062；這組測試釘住 FCM 送出層） */
const ENV = { PUSH_GATEWAY_KEY: pushKey.nsec(), FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT, PUSH_IOS: 'fcm' };

/** 假的 Google：OAuth token 端點與 FCM 送出端點 */
function fakeGoogle(opts: { send?: (n: number) => Response; oauthFails?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let sends = 0;
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, headers, body: String(init?.body ?? '') });
    if (url === 'https://oauth2.googleapis.com/token') {
      if (opts.oauthFails) return new Response('{"error":"invalid_grant"}', { status: 400 });
      return Response.json({ access_token: `ya29.test-${calls.length}`, expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.startsWith('https://fcm.googleapis.com/v1/projects/cinder-test-123/messages:send')) {
      sends += 1;
      return opts.send?.(sends) ?? Response.json({ name: 'projects/cinder-test-123/messages/1' });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetchMock, calls, sendCalls: () => calls.filter((c) => c.url.includes('messages:send')) };
}

function endpointFor(platform: 'android' | 'ios', tokenType: 'fcm' | 'apns' = 'fcm', url = 'https://push.example'): Extract<IotPushEndpoint, { type: 'gateway' }> {
  const { sealed, key } = sealIotPushToken(pushKey.pubkey, { platform, token: tokenType === 'fcm' ? FCM_TOKEN : APNS_TOKEN, tokenType });
  return { type: 'gateway', url, sealed, key };
}

function wakeRequest(endpoint: IotPushEndpoint, ts = Date.now(), ref?: string): Request {
  const req = buildIotPushRequest(endpoint, { ts, ...(ref ? { ref } : {}) });
  return new Request(req.url, { method: req.method, headers: req.headers, body: req.body });
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; input: string; signature: Buffer } {
  const [h, c, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c!, 'base64url').toString('utf8')) as Record<string, unknown>,
    input: `${h}.${c}`,
    signature: Buffer.from(s!, 'base64url'),
  };
}

async function gateway(env: Record<string, string> = ENV, google = fakeGoogle()) {
  const logs: PushGatewayLogEntry[] = [];
  const instance = await createPushGatewayFromEnv(env, 'node', { store: memoryPushGatewayStore(), fetch: google.fetchMock, onLog: (e) => logs.push(e) });
  return { ...instance, google, logs };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('零知識守門（payload）', () => {
  it('Android：FCM 高優先空資料訊息；多一個欄位就丟例外', () => {
    const m = androidFcmMessage(FCM_TOKEN).message;
    expect(m).toEqual({ token: FCM_TOKEN, data: {}, android: { priority: 'HIGH', ttl: '3600s' } });
    expect(() => assertContentlessPushPayload('android', { ...m, notification: { title: '門被打開了' } })).toThrow(/空的喚醒/);
    expect(() => assertContentlessPushPayload('android', { ...m, data: { device: 'door' } })).toThrow();
  });

  it('iOS：一般推播＋mutable-content，alert 只有在地化鍵，payload 只多 ref', () => {
    expect(iosWakePayload('CINDER_WAKE', 'e'.repeat(64))).toEqual({ aps: { alert: { 'loc-key': 'CINDER_WAKE' }, 'mutable-content': 1 }, ref: 'e'.repeat(64) });
    expect(() => iosWakePayload('門被打開了')).toThrow();
    expect(() => assertContentlessPushPayload('ios', { aps: { alert: { 'loc-key': 'X', body: 'hi' }, 'mutable-content': 1 } })).toThrow();
    expect(() => assertContentlessPushPayload('ios', { aps: { 'content-available': 1 } })).toThrow();
    expect(() => assertContentlessPushPayload('ios', { aps: { alert: { 'loc-key': 'X' }, 'mutable-content': 1 }, device: 'door' })).toThrow();
  });
});

describe('設定（只從環境變數；錯誤不含值）', () => {
  it('預設：Android 開、iOS 直連 APNs（v0.48.0 起，SDK ADR 0062）、上限 60／時 6／分', () => {
    const c = pushGatewayConfigFromEnv({ PUSH_GATEWAY_KEY: pushKey.nsec() }, 'node');
    expect(c).toMatchObject({ pubkey: pushKey.pubkey, android: true, ios: 'apns', iosLocKey: 'CINDER_WAKE', limits: DEFAULT_PUSH_GATEWAY_LIMITS });
    expect(DEFAULT_PUSH_GATEWAY_IOS_MODE).toBe('apns');
    expect(DEFAULT_PUSH_GATEWAY_LIMITS).toMatchObject({ tokenPerHour: 60, tokenPerMinute: 6 });
  });

  it('上限可調，超出範圍拒絕', () => {
    expect(pushGatewayConfigFromEnv({ ...ENV, PUSH_TOKEN_PER_HOUR: '120', PUSH_TOKEN_PER_MINUTE: '3' }, 'node').limits).toMatchObject({ tokenPerHour: 120, tokenPerMinute: 3 });
    expect(() => pushGatewayConfigFromEnv({ ...ENV, PUSH_TOKEN_PER_HOUR: '0' }, 'node')).toThrow(/PUSH_TOKEN_PER_HOUR/);
  });

  it('Workers 版與 Node 版都能直連 APNs（SDK ADR 0061）；沒寫 PUSH_IOS 兩版都是 apns，明寫 fcm／off 照用（SDK ADR 0062）', () => {
    const { PUSH_IOS: _ignored, ...unset } = ENV;
    for (const host of ['worker', 'node'] as const) {
      expect(pushGatewayConfigFromEnv({ ...ENV, PUSH_IOS: 'apns' }, host).ios).toBe('apns');
      expect(pushGatewayConfigFromEnv(unset, host).ios).toBe('apns');
      expect(pushGatewayConfigFromEnv({ ...unset, PUSH_IOS: ' ' }, host).ios).toBe('apns');
      expect(pushGatewayConfigFromEnv(ENV, host).ios).toBe('fcm');
      expect(pushGatewayConfigFromEnv({ ...ENV, PUSH_IOS: 'off' }, host).ios).toBe('off');
    }
    expect(pushGatewayIosModeFromEnv(unset)).toBe('apns');
    expect(pushGatewayIosModeFromEnv({ PUSH_IOS: ' fcm ' })).toBe('fcm');
    expect(() => pushGatewayIosModeFromEnv({ PUSH_IOS: 'google' })).toThrow(/PUSH_IOS 只能是 apns、fcm 或 off/);
  });

  it('錯誤訊息不含秘密的值', async () => {
    const secret = 'zz-very-secret-value-zz';
    for (const run of [
      () => pushGatewayConfigFromEnv({ PUSH_GATEWAY_KEY: secret }, 'node'),
      () => parseFcmServiceAccount(`{"private_key": "${secret}`),
      () => parseFcmServiceAccount(JSON.stringify({ type: 'service_account', project_id: 'cinder-test-123', client_email: secret, private_key: 'x' })),
    ]) {
      let message = '';
      try {
        await run();
      } catch (error) {
        message = String(error) + String((error as Error).cause ?? '');
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(secret);
    }
    await expect(createPushGatewayFromEnv({ ...ENV, FCM_SERVICE_ACCOUNT: JSON.stringify({ ...JSON.parse(SERVICE_ACCOUNT), private_key: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(secret).toString('base64')}\n-----END PRIVATE KEY-----` }) }, 'node', { store: memoryPushGatewayStore() })).rejects.toThrow(/無法匯入/);
    await expect(createPushGatewayFromEnv({ PUSH_GATEWAY_KEY: pushKey.nsec() }, 'node', { store: memoryPushGatewayStore() })).rejects.toThrow(/FCM_SERVICE_ACCOUNT/);
  });
});

describe('喚醒：解封、驗簽、送 FCM', () => {
  it('Android：服務帳號 JWT（RS256）換 OAuth token，送高優先空資料訊息；ref 不送給 Android', async () => {
    const g = await gateway();
    const res = await g.handle(wakeRequest(endpointFor('android'), Date.now(), 'e'.repeat(64)));
    expect(res.status).toBe(202);
    const [oauth, send] = g.google.calls;
    expect(oauth!.url).toBe('https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(oauth!.body).get('assertion')!;
    const jwt = decodeJwt(assertion);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'abcdef0123456789' });
    expect(jwt.claims).toMatchObject({ iss: 'push@cinder-test-123.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token' });
    expect(verifySignature('RSA-SHA256', Buffer.from(jwt.input), createPublicKey(rsa.publicKey), jwt.signature)).toBe(true);
    expect(send!.headers.authorization).toBe('Bearer ya29.test-1');
    expect(JSON.parse(send!.body)).toEqual({ message: { token: FCM_TOKEN, data: {}, android: { priority: 'HIGH', ttl: '3600s' } } });
  });

  it('iOS 經 FCM：apns 區塊是一般推播＋mutable-content，payload 只有在地化鍵與 ref', async () => {
    const g = await gateway({ ...ENV, PUSH_IOS_LOC_KEY: 'HOME_ALERT' });
    expect((await g.handle(wakeRequest(endpointFor('ios'), Date.now(), 'a'.repeat(64)))).status).toBe(202);
    const message = JSON.parse(g.google.sendCalls()[0]!.body).message;
    expect(message.token).toBe(FCM_TOKEN);
    expect(message.apns.headers).toMatchObject({ 'apns-push-type': 'alert', 'apns-priority': '10' });
    expect(message.apns.payload).toEqual({ aps: { alert: { 'loc-key': 'HOME_ALERT' }, 'mutable-content': 1 }, ref: 'a'.repeat(64) });
    expect(Object.keys(message).sort()).toEqual(['apns', 'token']);
  });

  it('OAuth token 快取：連續兩次喚醒只換一次 token', async () => {
    const g = await gateway();
    const ep = endpointFor('android');
    expect((await g.handle(wakeRequest(ep, Date.now()))).status).toBe(202);
    expect((await g.handle(wakeRequest(ep, Date.now() + 1))).status).toBe(202);
    expect(g.google.calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
  });

  it('FCM 回 401：換一把 access token 再送一次', async () => {
    const google = fakeGoogle({ send: (n) => (n === 1 ? new Response('{}', { status: 401 }) : Response.json({ name: 'x' })) });
    const g = await gateway(ENV, google);
    expect((await g.handle(wakeRequest(endpointFor('android')))).status).toBe(202);
    expect(google.calls.filter((c) => c.url.includes('oauth2')).length).toBe(2);
  });

  it('FCM 回 UNREGISTERED → 410；送出端的 fetchIotPushSend 判成 gone', async () => {
    const google = fakeGoogle({ send: () => Response.json({ error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 }) });
    const g = await gateway(ENV, google);
    const send = fetchIotPushSend(async (url, init) => g.handle(new Request(String(url), init)));
    expect(await send(endpointFor('android'), { ts: Date.now() })).toEqual({ status: 'gone' });
  });

  it('FCM 回 429 → 503＋Retry-After（送出端延後）；OAuth 失敗 → 502', async () => {
    const busy = await gateway(ENV, fakeGoogle({ send: () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }) }));
    const res = await busy.handle(wakeRequest(endpointFor('android')));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('120');
    const broken = await gateway(ENV, fakeGoogle({ oauthFails: true }));
    expect((await broken.handle(wakeRequest(endpointFor('android')))).status).toBe(502);
  });
});

describe('拒絕：簽章、重放、時間、到期、撤銷、上限、平台', () => {
  it('簽章不對 → 401；本文多欄位 → 400；別人的封包 → 400', async () => {
    const g = await gateway();
    const ep = endpointFor('android');
    expect((await g.handle(wakeRequest({ ...ep, key: '0'.repeat(64) }))).status).toBe(401);
    const body = JSON.parse(buildIotPushRequest(ep, { ts: Date.now() }).body);
    expect((await g.handle(new Request('https://push.example/v1/wake', { method: 'POST', body: JSON.stringify({ ...body, device: 'door' }) }))).status).toBe(400);
    const other = sealIotPushToken(Identity.generate().pubkey, { platform: 'android', token: FCM_TOKEN });
    expect((await g.handle(wakeRequest({ ...ep, sealed: other.sealed, key: other.key }))).status).toBe(400);
    expect(g.google.sendCalls()).toEqual([]);
  });

  it('重放：同一個請求第二次 → 409；時間戳要嚴格遞增；時間差太大 → 400', async () => {
    const g = await gateway();
    const ep = endpointFor('android');
    const ts = Date.now();
    expect((await g.handle(wakeRequest(ep, ts))).status).toBe(202);
    expect((await g.handle(wakeRequest(ep, ts))).status).toBe(409);
    expect((await g.handle(wakeRequest(ep, ts - 5))).status).toBe(409);
    expect((await g.handle(wakeRequest(ep, Date.now() - 600_000))).status).toBe(400);
    expect(g.google.sendCalls()).toHaveLength(1);
  });

  it('封包過期 → 410', async () => {
    const now = Date.now();
    const { sealed, key } = sealIotPushToken(pushKey.pubkey, { platform: 'android', token: FCM_TOKEN, ttlSec: 3_600, now: now - 7_200_000 });
    const g = await gateway();
    expect((await g.handle(wakeRequest({ type: 'gateway', url: 'https://push.example', sealed, key }, now))).status).toBe(410);
  });

  it('撤銷：之後的喚醒 → 410（直到封包到期）；撤銷要同一把密鑰', async () => {
    const g = await gateway();
    const ep = endpointFor('android');
    const revoke = (body: unknown) => g.handle(new Request('https://push.example/v1/revoke', { method: 'POST', body: JSON.stringify(body) }));
    expect((await revoke({ ...buildIotPushRevokeBody(ep, Date.now()), sig: '0'.repeat(64) })).status).toBe(401);
    expect((await revoke(buildIotPushRevokeBody(ep, Date.now()))).status).toBe(200);
    expect((await g.handle(wakeRequest(ep, Date.now() + 10))).status).toBe(410);
    expect(g.google.sendCalls()).toEqual([]);
  });

  it('每個 token 每分鐘上限（同一 token 的不同登記一起算）→ 429＋Retry-After', async () => {
    const g = await gateway({ ...ENV, PUSH_TOKEN_PER_MINUTE: '2' });
    const a = endpointFor('android');
    const b = endpointFor('android'); // 同一個 token、另一個送出端
    expect((await g.handle(wakeRequest(a, Date.now()))).status).toBe(202);
    expect((await g.handle(wakeRequest(b, Date.now()))).status).toBe(202);
    const res = await g.handle(wakeRequest(a, Date.now() + 5));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('每小時上限（純函式）', () => {
    const state: PushTokenState = { hits: [], regs: {} };
    const limits = { ...DEFAULT_PUSH_GATEWAY_LIMITS, tokenPerHour: 3, tokenPerMinute: 60 };
    const now = 10_000_000;
    for (let i = 0; i < 3; i += 1) expect(admitPushWake(state, { tokenKey: 't', regId: 'r', ts: now + i * 61_000, exp: 99_999_999, now: now + i * 61_000 }, limits).verdict).toBe('ok');
    const v = admitPushWake(state, { tokenKey: 't', regId: 'r', ts: now + 200_000, exp: 99_999_999, now: now + 200_000 }, limits);
    expect(v).toMatchObject({ verdict: 'rate-limited' });
    expect(admitPushWake(state, { tokenKey: 't', regId: 'r', ts: now + 3_700_000, exp: 99_999_999, now: now + 3_700_000 }, limits).verdict).toBe('ok');
  });

  it('平台關掉 → 501；Node 版重啟後重放不了重啟前的請求', async () => {
    const g = await gateway({ ...ENV, PUSH_ANDROID: '0' });
    expect((await g.handle(wakeRequest(endpointFor('android')))).status).toBe(501);
    const ep = endpointFor('ios');
    const old = Date.now() - 1_000;
    const fresh = await gateway(); // 「重啟」：新的記憶體狀態，下限＝啟動時間
    expect((await fresh.handle(wakeRequest(ep, old))).status).toBe(409);
  });

  it('日誌與回應不含 token、封包、密鑰、憑證', async () => {
    const g = await gateway();
    const ep = endpointFor('android');
    const texts: string[] = [];
    for (const req of [wakeRequest(ep), wakeRequest({ ...ep, key: '1'.repeat(64) }), wakeRequest(ep, 1)]) {
      const res = await g.handle(req);
      texts.push(await res.text());
    }
    texts.push(JSON.stringify(g.logs));
    for (const text of texts) {
      for (const secret of [FCM_TOKEN, ep.sealed, ep.key, 'BEGIN PRIVATE KEY', pushKey.nsec(), 'ya29']) expect(text).not.toContain(secret);
    }
    // 第一筆是啟動時的棄用紀錄（ENV 明寫 PUSH_IOS=fcm；SDK ADR 0062），也一樣不含秘密
    expect(g.logs.map((l) => l.result)).toEqual(['ios-via-fcm-deprecated', 'ok', 'rejected-401', 'rejected-400']);
  });

  it('/v1/info 給 App：公鑰、平台、上限', async () => {
    const g = await gateway();
    const info = await (await g.handle(new Request('https://push.example/v1/info'))).json();
    expect(info).toEqual({ v: 1, pubkey: pushKey.pubkey, android: true, ios: 'fcm', maxRegistrationDays: 30, limits: { tokenPerHour: 60, tokenPerMinute: 6 } });
    expect(await (await g.handle(new Request('https://push.example/healthz'))).text()).toBe('ok');
    expect((await g.handle(new Request('https://push.example/v1/wake'))).status).toBe(405);
  });
});

describe('Node 版：直連 APNs（node:http2）', () => {
  let apns: Http2Server | undefined;
  let gw: Awaited<ReturnType<typeof startNodePushGateway>> | undefined;
  afterEach(async () => {
    await gw?.close();
    await new Promise<void>((resolve) => (apns ? apns.close(() => resolve()) : resolve()));
    gw = undefined;
    apns = undefined;
  });

  async function startApns(respond: (headers: IncomingHttpHeaders) => { status: number; body?: string }) {
    const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
    apns = createHttp2Server();
    apns.on('stream', (stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (c: string) => (body += c));
      stream.on('end', () => {
        seen.push({ headers, body });
        const r = respond(headers);
        stream.respond({ ':status': r.status });
        stream.end(r.body ?? '');
      });
    });
    await new Promise<void>((resolve) => apns!.listen(0, '127.0.0.1', resolve));
    const address = apns.address();
    return { origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, seen };
  }

  const apnsEnv = { PUSH_GATEWAY_KEY: pushKey.nsec(), PUSH_IOS: 'apns', PUSH_ANDROID: '0', APNS_KEY: ec.privateKey, APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456', APNS_TOPIC: 'com.example.cinder', APNS_ENV: 'sandbox' };

  it('iOS 喚醒不經 Google：ES256 provider token、一般推播＋mutable-content、只帶 ref', async () => {
    const server = await startApns(() => ({ status: 200 }));
    const google = fakeGoogle();
    gw = await startNodePushGateway(apnsEnv, { port: 0, host: '127.0.0.1', apnsOrigin: server.origin, fetch: google.fetchMock, onLog: () => {} });
    const ep = endpointFor('ios', 'apns', gw.url);
    const result = await fetchIotPushSend()(ep, { ts: Date.now(), ref: 'c'.repeat(64) });
    expect(result).toEqual({ status: 'ok' });
    expect(google.calls).toEqual([]);
    const { headers, body } = server.seen[0]!;
    expect(headers[':path']).toBe(`/3/device/${APNS_TOKEN}`);
    expect(headers).toMatchObject({ 'apns-topic': 'com.example.cinder', 'apns-push-type': 'alert', 'apns-priority': '10' });
    expect(JSON.parse(body)).toEqual({ aps: { alert: { 'loc-key': 'CINDER_WAKE' }, 'mutable-content': 1 }, ref: 'c'.repeat(64) });
    const jwt = decodeJwt(String(headers.authorization).replace(/^bearer /, ''));
    expect(jwt.header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(jwt.claims).toMatchObject({ iss: 'TEAM123456' });
    expect(verifySignature('sha256', Buffer.from(jwt.input), { key: createPublicKey(ec.publicKey), dsaEncoding: 'ieee-p1363' }, jwt.signature)).toBe(true);
  });

  it('沒寫 PUSH_IOS：Node 版預設就直連 APNs（自動帶 node:http2 傳輸，v0.48.0 起；SDK ADR 0062）', async () => {
    const server = await startApns(() => ({ status: 200 }));
    const { PUSH_IOS: _ignored, ...unset } = apnsEnv;
    const logs: PushGatewayLogEntry[] = [];
    gw = await startNodePushGateway(unset, { port: 0, host: '127.0.0.1', apnsOrigin: server.origin, onLog: (e) => logs.push(e) });
    expect(gw.instance.config.ios).toBe('apns');
    expect(await fetchIotPushSend()(endpointFor('ios', 'apns', gw.url), { ts: Date.now() })).toEqual({ status: 'ok' });
    expect(server.seen).toHaveLength(1);
    expect(logs.some((l) => l.event === 'config')).toBe(false);
  });

  it('APNs 410 Unregistered → 送出端判成 gone；403 ExpiredProviderToken → 重簽再送', async () => {
    let n = 0;
    const server = await startApns(() => {
      n += 1;
      if (n === 1) return { status: 403, body: '{"reason":"ExpiredProviderToken"}' };
      return { status: 410, body: '{"reason":"Unregistered"}' };
    });
    gw = await startNodePushGateway(apnsEnv, { port: 0, host: '127.0.0.1', apnsOrigin: server.origin, onLog: () => {} });
    expect(await fetchIotPushSend()(endpointFor('ios', 'apns', gw.url), { ts: Date.now() })).toEqual({ status: 'gone' });
    expect(server.seen).toHaveLength(2);
  });

  it('Node 版 HTTP：/v1/info 與過大的本文', async () => {
    gw = await startNodePushGateway(ENV, { port: 0, host: '127.0.0.1', fetch: fakeGoogle().fetchMock, onLog: () => {} });
    expect(((await (await fetch(`${gw.url}/v1/info`)).json()) as { pubkey: string }).pubkey).toBe(pushKey.pubkey);
    expect((await fetch(`${gw.url}/v1/wake`, { method: 'POST', body: 'x'.repeat(20_000) })).status).toBe(413);
  });
});

describe('Workers 版：每個 token 一顆 DO', () => {
  function fakeNamespace(): PushStateNamespaceLike & { objects: Map<string, PushGatewayState> } {
    const objects = new Map<string, PushGatewayState>();
    return {
      objects,
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

  it('送 FCM、狀態在 DO（重放被擋）；直連 APNs 卻缺 APNs 設定時回 503', async () => {
    const google = fakeGoogle();
    vi.stubGlobal('fetch', google.fetchMock);
    const ns = fakeNamespace();
    const env = { ...ENV, PUSH_STATE: ns };
    const ep = endpointFor('android');
    const ts = Date.now();
    expect((await worker.fetch(wakeRequest(ep, ts), env)).status).toBe(202);
    expect((await worker.fetch(wakeRequest(ep, ts), env)).status).toBe(409);
    expect(ns.objects.size).toBe(1);
    expect(google.sendCalls()).toHaveLength(1);
    const bad = { ...ENV, PUSH_IOS: 'apns', PUSH_STATE: fakeNamespace() };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(wakeRequest(ep, ts + 1), bad);
    expect(res.status).toBe(503);
    expect(String(errors.mock.calls[0]?.[0])).not.toContain(pushKey.nsec());
    errors.mockRestore();
  });
});
