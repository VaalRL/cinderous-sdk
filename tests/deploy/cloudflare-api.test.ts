// 以 Cloudflare REST API 部署（SDK ADR 0021）。全部用假的 HTTP：測請求順序、標頭、multipart 內容、
// 重新部署的冪等、錯誤分類與 Token 網址。不會真的呼叫 Cloudflare。
import { describe, expect, it } from 'vitest';

import {
  buildMultipartBody,
  buildTokenCreationUrl,
  classifyCloudflareError,
  CloudflareApiError,
  deployCloudflareRelayViaApi,
  type HttpFetch,
  type HttpRequestInit,
  listAccounts,
  planMigrations,
  relayWorkerSdkVersion,
  relayWorkerSource,
  renderApiWorkerEntry,
  verifyToken,
} from '../../src/deploy/cloudflare-api/index.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/index.js';

const alice = getPublicKey(generateSecretKey());
const API = 'https://api.cloudflare.com/client/v4';

type Call = { method: string; url: string; init: HttpRequestInit };
type Reply = { status?: number; body: unknown } | { status: number; raw: string };
type Route = (call: Call) => Reply | undefined;

const ok = (result: unknown): Reply => ({ status: 200, body: { success: true, errors: [], messages: [], result } });
const fail = (status: number, ...codes: number[]): Reply => ({
  status,
  body: { success: false, errors: codes.map((code) => ({ code, message: `error ${code}` })), messages: [], result: null },
});

/** 假的 Cloudflare：依序比對路由；沒有對應的路由就讓測試失敗。 */
function fakeCloudflare(overrides: Record<string, Reply> = {}, extra: Route[] = []) {
  const calls: Call[] = [];
  const defaults: Record<string, Reply> = {
    'GET /user/tokens/verify': ok({ id: 'tok-id', status: 'active' }),
    'GET /accounts?per_page=50&page=1': ok([{ id: 'acc1', name: 'Alice' }]),
    'GET /accounts/acc1/workers/subdomain': ok({ subdomain: 'alice' }),
    'GET /accounts/acc1/workers/scripts': ok([]),
    'PUT /accounts/acc1/workers/scripts/my-relay': ok({ id: 'my-relay', migration_tag: 'v2' }),
    'POST /accounts/acc1/workers/scripts/my-relay/subdomain': ok({ enabled: true, previews_enabled: false }),
    'GET /accounts/acc1/workers/scripts/my-relay/settings': ok({ bindings: [] }),
    'GET https://my-relay.alice.workers.dev/healthz': { status: 200, raw: 'ok' },
  };
  const routes = { ...defaults, ...overrides };
  const http: HttpFetch = async (url, init) => {
    const call = { method: init.method, url, init };
    calls.push(call);
    for (const route of extra) {
      const reply = route(call);
      if (reply) return respond(reply);
    }
    const key = url.startsWith(API) ? `${init.method} ${url.slice(API.length)}` : `${init.method} ${url}`;
    const reply = routes[key];
    if (!reply) throw new Error(`假的 Cloudflare 沒有這個路由：${key}`);
    return respond(reply);
  };
  return { http, calls, keys: () => calls.map((c) => (c.url.startsWith(API) ? `${c.method} ${c.url.slice(API.length)}` : `${c.method} ${c.url}`)) };
}

function respond(reply: Reply) {
  const text = 'raw' in reply ? reply.raw : JSON.stringify(reply.body);
  return { status: reply.status ?? 200, text: async () => text };
}

/** 把自己組的 multipart 本文拆回各段 */
function parseMultipart(call: Call): Map<string, { headers: string; content: string }> {
  const boundary = /boundary=(.+)$/.exec(call.init.headers['Content-Type'] ?? '')?.[1];
  expect(boundary).toBeTruthy();
  const text = new TextDecoder().decode(call.init.body as Uint8Array);
  const parts = new Map<string, { headers: string; content: string }>();
  for (const chunk of text.split(`--${boundary}`).slice(1, -1)) {
    const [headers, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    const name = /name="([^"]+)"/.exec(headers!)![1]!;
    parts.set(name, { headers: headers!, content: rest.join('\r\n\r\n').replace(/\r\n$/, '') });
  }
  expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  return parts;
}

const base = { apiToken: 'secret-token', workerName: 'my-relay', healthRetries: 3, healthDelayMs: 0 };

describe('deployCloudflareRelayViaApi：第一次部署', () => {
  it('照順序打 API：驗 Token → 帳號 → 子網域 → 查現有 Worker → 上傳 → 開路由 → 健康檢查', async () => {
    const cf = fakeCloudflare();
    const steps: string[] = [];
    const result = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, onProgress: (s) => steps.push(s.step) });

    expect(cf.keys()).toEqual([
      'GET /user/tokens/verify',
      'GET /accounts?per_page=50&page=1',
      'GET /accounts/acc1/workers/subdomain',
      'GET /accounts/acc1/workers/scripts',
      'PUT /accounts/acc1/workers/scripts/my-relay',
      'POST /accounts/acc1/workers/scripts/my-relay/subdomain',
      'GET https://my-relay.alice.workers.dev/healthz',
    ]);
    expect(result).toEqual({
      workerName: 'my-relay',
      accountId: 'acc1',
      subdomain: 'alice',
      httpUrl: 'https://my-relay.alice.workers.dev',
      relayEndpoint: 'wss://my-relay.alice.workers.dev',
      migrationsApplied: true,
    });
    expect(steps[0]).toBe('config');
    expect(steps).toContain('deploy');
    expect(steps.slice(-2)).toEqual(['health', 'done']);
  });

  it('🔴 Cloudflare 的請求都帶 Bearer Token；健康檢查不帶（Token 不能送到自己的站以外）', async () => {
    const cf = fakeCloudflare();
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http });
    for (const call of cf.calls) {
      if (call.url.startsWith(API)) expect(call.init.headers.Authorization).toBe('Bearer secret-token');
      else expect(call.init.headers.Authorization).toBeUndefined();
    }
  });

  it('multipart：metadata 正確（主模組、相容日期、DO 綁定、SQLite 遷移、防濫用預設、白名單、站名），兩個 module 都在', async () => {
    const cf = fakeCloudflare();
    await deployCloudflareRelayViaApi({
      ...base,
      fetch: cf.http,
      allowedPubkeys: [npubEncode(alice)],
      relayName: 'Alice relay',
      compatibilityDate: '2026-09-15',
      version: '1.2.3',
    });
    const upload = cf.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/workers/scripts/my-relay'))!;
    expect(upload.init.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    const parts = parseMultipart(upload);
    expect([...parts.keys()]).toEqual(['metadata', 'entry.mjs', 'relay.mjs']);

    expect(parts.get('metadata')!.headers).toContain('Content-Type: application/json');
    const metadata = JSON.parse(parts.get('metadata')!.content);
    expect(metadata).toEqual({
      main_module: 'entry.mjs',
      compatibility_date: '2026-09-15',
      bindings: [
        { type: 'durable_object_namespace', name: 'RELAY_ROOM', class_name: 'RelayRoom' },
        { type: 'durable_object_namespace', name: 'IOT_HOME', class_name: 'IotHomeRoom' },
        { type: 'plain_text', name: 'MAX_CONNECTIONS_PER_PUBKEY', text: '5' },
        { type: 'plain_text', name: 'MAX_MESSAGES_PER_SECOND_PER_IP', text: '20' },
        { type: 'plain_text', name: 'ALLOWED_PUBKEYS', text: alice }, // npub 已換成 hex
        { type: 'plain_text', name: 'RELAY_NAME', text: 'Alice relay' },
      ],
      keep_bindings: ['secret_text', 'secret_key'],
      observability: { enabled: true },
      migrations: { new_tag: 'v2', steps: [{ new_sqlite_classes: ['RelayRoom'] }, { new_sqlite_classes: ['IotHomeRoom'] }] },
    });

    const entry = parts.get('entry.mjs')!;
    expect(entry.headers).toContain('filename="entry.mjs"');
    expect(entry.headers).toContain('Content-Type: application/javascript+module');
    expect(entry.content).toContain('setRelayVersion("1.2.3")');
    expect(entry.content).toContain('export { default, RelayRoom, IotHomeRoom } from "./relay.mjs"');

    const relay = parts.get('relay.mjs')!;
    expect(relay.headers).toContain('Content-Type: application/javascript+module');
    expect(relay.content).toBe(relayWorkerSource);
  });

  it('沒給站名、白名單、版號：不設 RELAY_NAME／ALLOWED_PUBKEYS（ADR 0019 中立預設），版號用打包時的 SDK 版號', async () => {
    const cf = fakeCloudflare();
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http });
    const parts = parseMultipart(cf.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/my-relay'))!);
    const names = JSON.parse(parts.get('metadata')!.content).bindings.map((b: { name: string }) => b.name);
    expect(names).not.toContain('RELAY_NAME');
    expect(names).not.toContain('ALLOWED_PUBKEYS');
    expect(parts.get('entry.mjs')!.content).toContain(`setRelayVersion(${JSON.stringify(relayWorkerSdkVersion)})`);
  });

  it('開路由：enabled true、不開預覽網址', async () => {
    const cf = fakeCloudflare();
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http });
    const route = cf.calls.find((c) => c.method === 'POST')!;
    expect(route.init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(route.init.body as string)).toEqual({ enabled: true, previews_enabled: false });
  });

  it('給了 accountId 就不列帳號', async () => {
    const cf = fakeCloudflare();
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, accountId: 'acc1' });
    expect(cf.keys()).not.toContain('GET /accounts?per_page=50&page=1');
  });
});

describe('deployCloudflareRelayViaApi：重新部署要冪等', () => {
  it('Worker 已套用最後一個遷移 tag → 不再送 migrations（再送會被 Cloudflare 拒絕）', async () => {
    const cf = fakeCloudflare({ 'GET /accounts/acc1/workers/scripts': ok([{ id: 'other' }, { id: 'my-relay', migration_tag: 'v2' }]) });
    const result = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http });
    const metadata = JSON.parse(parseMultipart(cf.calls.find((c) => c.method === 'PUT')!).get('metadata')!.content);
    expect(metadata.migrations).toBeUndefined();
    expect(metadata.bindings[0]).toEqual({ type: 'durable_object_namespace', name: 'RELAY_ROOM', class_name: 'RelayRoom' });
    expect(result.migrationsApplied).toBe(false);
  });

  it('連續部署兩次：第二次不送遷移', async () => {
    let tag: string | undefined;
    const cf = fakeCloudflare({}, [
      (call) => (call.method === 'GET' && call.url.endsWith('/workers/scripts') ? ok(tag ? [{ id: 'my-relay', migration_tag: tag }] : []) : undefined),
      (call) => {
        if (call.method !== 'PUT' || !call.url.endsWith('/workers/scripts/my-relay')) return undefined;
        const metadata = JSON.parse(parseMultipart(call).get('metadata')!.content);
        if (metadata.migrations?.old_tag !== tag && metadata.migrations) return fail(400, 10079);
        if (metadata.migrations) tag = metadata.migrations.new_tag;
        return ok({ id: 'my-relay', migration_tag: tag });
      },
    ]);
    expect((await deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).migrationsApplied).toBe(true);
    expect((await deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).migrationsApplied).toBe(false);
  });

  it('planMigrations：沒有 tag 送全部；最後一個 tag 不送；陌生 tag 標記為別人的 Worker', () => {
    expect(planMigrations(undefined)).toEqual({ payload: { new_tag: 'v2', steps: [{ new_sqlite_classes: ['RelayRoom'] }, { new_sqlite_classes: ['IotHomeRoom'] }] }, foreign: false });
    expect(planMigrations('v2')).toEqual({ foreign: false });
    expect(planMigrations('their-tag')).toEqual({
      payload: { old_tag: 'their-tag', new_tag: 'v2', steps: [{ new_sqlite_classes: ['RelayRoom'] }, { new_sqlite_classes: ['IotHomeRoom'] }] },
      foreign: true,
    });
  });
});

describe('deployCloudflareRelayViaApi：已知租戶車道（appLanes，SDK ADR 0036）', () => {
  const liveWith = (lanes: string | undefined) =>
    fakeCloudflare({
      'GET /accounts/acc1/workers/scripts': ok([{ id: 'my-relay', migration_tag: 'v2' }]),
      'GET /accounts/acc1/workers/scripts/my-relay/settings': ok({
        bindings: [
          { type: 'durable_object_namespace', name: 'RELAY_ROOM', class_name: 'RelayRoom' },
          ...(lanes === undefined ? [] : [{ type: 'plain_text', name: 'APP_LANES', text: lanes }]),
        ],
      }),
    });
  const bindingsOf = (cf: ReturnType<typeof fakeCloudflare>) =>
    JSON.parse(parseMultipart(cf.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/my-relay'))!).get('metadata')!.content).bindings as {
      name: string;
      text?: string;
    }[];

  it('第一次部署：appLanes 寫成 APP_LANES，其他站台參數也一併寫入；不讀線上設定', async () => {
    const cf = fakeCloudflare();
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, appLanes: ['dochost'], maxMessagesPerSecondPerIp: 50, maxTtlDays: 14 });
    const bindings = bindingsOf(cf);
    expect(bindings).toContainEqual({ type: 'plain_text', name: 'APP_LANES', text: 'dochost' });
    expect(bindings).toContainEqual({ type: 'plain_text', name: 'MAX_MESSAGES_PER_SECOND_PER_IP', text: '50' });
    expect(bindings).toContainEqual({ type: 'plain_text', name: 'MAX_TTL_DAYS', text: '14' });
    expect(cf.keys()).not.toContain('GET /accounts/acc1/workers/scripts/my-relay/settings');
  });

  it('🔴 重新部署、名單相同（順序不同也算）：冪等，照常上傳', async () => {
    const cf = liveWith('cindersync,dochost');
    const result = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, appLanes: ['dochost', 'cindersync'] });
    expect(result.migrationsApplied).toBe(false);
    expect(cf.keys()).toContain('GET /accounts/acc1/workers/scripts/my-relay/settings');
    expect(bindingsOf(cf)).toContainEqual({ type: 'plain_text', name: 'APP_LANES', text: 'dochost,cindersync' });
  });

  it('🔴 重新部署時名單不同（包括忘了帶）→ lane-change，不上傳；訊息說明新增／移除哪幾條', async () => {
    for (const [live, next, text] of [
      ['dochost', [], '移除 dochost'],
      [undefined, ['dochost'], '新增 dochost'],
      ['dochost', ['dochost', 'other'], '新增 other'],
    ] as const) {
      const cf = liveWith(live);
      const error = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, appLanes: [...next] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect((error as CloudflareApiError).kind).toBe('lane-change');
      expect((error as Error).message).toContain(text);
      expect(cf.calls.some((c) => c.method === 'PUT')).toBe(false);
    }
  });

  it('allowLaneChange：明確同意就上傳新名單', async () => {
    const cf = liveWith('dochost');
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, appLanes: ['dochost', 'other'], allowLaneChange: true });
    expect(bindingsOf(cf)).toContainEqual({ type: 'plain_text', name: 'APP_LANES', text: 'dochost,other' });
  });

  it('讀不到線上設定（權限、網路）→ 不擋部署，只在進度裡說明略過檢查', async () => {
    const cf = fakeCloudflare({
      'GET /accounts/acc1/workers/scripts': ok([{ id: 'my-relay', migration_tag: 'v1' }]),
      'GET /accounts/acc1/workers/scripts/my-relay/settings': fail(403, 10000),
    });
    const messages: string[] = [];
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, appLanes: ['dochost'], onProgress: (s) => messages.push(s.message) });
    expect(messages.some((m) => m.includes('略過已知租戶名單的變更檢查'))).toBe(true);
    expect(cf.calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('站台參數壞了（車道 id、相容日期）→ 一個請求都不發', async () => {
    const cf = fakeCloudflare();
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http, appLanes: ['DocHost'] })).rejects.toThrow('車道 id');
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http, compatibilityDate: '2026/09/01' })).rejects.toThrow('YYYY-MM-DD');
    expect(cf.calls).toHaveLength(0);
  });
});

describe('deployCloudflareRelayViaApi：名稱衝突', () => {
  it('同名 Worker 不是中繼（沒有遷移 tag）→ name-conflict，而且不上傳', async () => {
    const cf = fakeCloudflare({ 'GET /accounts/acc1/workers/scripts': ok([{ id: 'my-relay' }]) });
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).rejects.toMatchObject({ kind: 'name-conflict' });
    expect(cf.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('同名 Worker 有別人的遷移 tag → name-conflict', async () => {
    const cf = fakeCloudflare({ 'GET /accounts/acc1/workers/scripts': ok([{ id: 'my-relay', migration_tag: 'their-v3' }]) });
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).rejects.toMatchObject({ kind: 'name-conflict' });
  });

  it('replaceExisting：覆蓋，遷移帶 old_tag 對齊 Cloudflare 上的狀態', async () => {
    const cf = fakeCloudflare({ 'GET /accounts/acc1/workers/scripts': ok([{ id: 'my-relay', migration_tag: 'their-v3' }]) });
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, replaceExisting: true });
    const metadata = JSON.parse(parseMultipart(cf.calls.find((c) => c.method === 'PUT')!).get('metadata')!.content);
    expect(metadata.migrations).toEqual({ old_tag: 'their-v3', new_tag: 'v2', steps: [{ new_sqlite_classes: ['RelayRoom'] }, { new_sqlite_classes: ['IotHomeRoom'] }] });
  });
});

describe('deployCloudflareRelayViaApi：帳號與子網域', () => {
  it('多個帳號又沒指定 → account-ambiguous，附帳號清單讓 UI 讓使用者選', async () => {
    const cf = fakeCloudflare({
      'GET /accounts?per_page=50&page=1': ok([
        { id: 'acc1', name: 'Alice' },
        { id: 'acc2', name: 'Work' },
      ]),
    });
    const error = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).kind).toBe('account-ambiguous');
    expect((error as CloudflareApiError).accounts).toEqual([
      { id: 'acc1', name: 'Alice' },
      { id: 'acc2', name: 'Work' },
    ]);
  });

  it('Token 看不到任何帳號 → permission', async () => {
    const cf = fakeCloudflare({ 'GET /accounts?per_page=50&page=1': ok([]) });
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).rejects.toMatchObject({ kind: 'permission' });
  });

  it('帳號沒有 workers.dev 子網域、也沒給名字 → subdomain-missing，不上傳', async () => {
    const cf = fakeCloudflare({ 'GET /accounts/acc1/workers/subdomain': fail(404, 10007) });
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).rejects.toMatchObject({ kind: 'subdomain-missing' });
    expect(cf.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('帳號沒有子網域、有給名字 → PUT 註冊後用它組網址', async () => {
    const cf = fakeCloudflare({
      'GET /accounts/acc1/workers/subdomain': fail(404, 10007),
      'PUT /accounts/acc1/workers/subdomain': ok({ subdomain: 'alice-new' }),
      'GET https://my-relay.alice-new.workers.dev/healthz': { status: 200, raw: 'ok' },
    });
    const result = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, workersDevSubdomain: 'alice-new' });
    const register = cf.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/workers/subdomain'))!;
    expect(JSON.parse(register.init.body as string)).toEqual({ subdomain: 'alice-new' });
    expect(result.relayEndpoint).toBe('wss://my-relay.alice-new.workers.dev');
  });

  it('子網域被別人用了 → name-conflict', async () => {
    const cf = fakeCloudflare({
      'GET /accounts/acc1/workers/subdomain': fail(404, 10007),
      'PUT /accounts/acc1/workers/subdomain': fail(409, 10031),
    });
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http, workersDevSubdomain: 'taken' })).rejects.toMatchObject({
      kind: 'name-conflict',
    });
  });
});

describe('deployCloudflareRelayViaApi：錯誤分類', () => {
  it('Token 無效 → token-invalid，後面都不打', async () => {
    const cf = fakeCloudflare({ 'GET /user/tokens/verify': fail(401, 1000) });
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).rejects.toMatchObject({ kind: 'token-invalid', status: 401, codes: [1000] });
    expect(cf.calls).toHaveLength(1);
  });

  it('Token 停用或過期 → token-invalid', async () => {
    const cf = fakeCloudflare({ 'GET /user/tokens/verify': ok({ id: 't', status: 'expired' }) });
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).rejects.toMatchObject({ kind: 'token-invalid' });
  });

  it('上傳時權限不足 → permission', async () => {
    const cf = fakeCloudflare({ 'PUT /accounts/acc1/workers/scripts/my-relay': fail(403, 10000) });
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).rejects.toMatchObject({ kind: 'permission' });
  });

  it('Worker 數量或大小超過額度、被限流 → quota', async () => {
    for (const reply of [fail(400, 10037), fail(400, 10027), fail(429, 971)]) {
      const cf = fakeCloudflare({ 'PUT /accounts/acc1/workers/scripts/my-relay': reply });
      await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).rejects.toMatchObject({ kind: 'quota' });
    }
  });

  it('連不到 Cloudflare → network', async () => {
    const http: HttpFetch = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: http })).rejects.toMatchObject({ kind: 'network' });
  });

  it('不是 JSON 的錯誤回應 → api，訊息帶原文開頭', async () => {
    const cf = fakeCloudflare({ 'GET /accounts/acc1/workers/scripts': { status: 502, raw: '<html>Bad gateway</html>' } });
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http })).rejects.toThrow(/Bad gateway/);
  });

  it('🔴 健康檢查一直不過 → health，不能回報成功', async () => {
    const cf = fakeCloudflare({ 'GET https://my-relay.alice.workers.dev/healthz': { status: 503, raw: 'nope' } });
    const error = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http }).catch((e: unknown) => e);
    expect((error as CloudflareApiError).kind).toBe('health');
    expect((error as Error).message).toMatch(/healthz.*503/);
  });

  it('名稱或白名單不合法 → 一個請求都不發', async () => {
    const cf = fakeCloudflare();
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http, workerName: 'My Relay!' })).rejects.toThrow(/名稱/);
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http, allowedPubkeys: ['npub1壞掉'] })).rejects.toThrow(/ALLOWED_PUBKEYS/);
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http, workersDevSubdomain: '-bad' })).rejects.toThrow(/子網域/);
    expect(cf.calls).toHaveLength(0);
  });

  it('classifyCloudflareError：狀態碼為主、錯誤碼補充', () => {
    expect(classifyCloudflareError(401, [])).toBe('token-invalid');
    expect(classifyCloudflareError(400, [9109])).toBe('token-invalid');
    expect(classifyCloudflareError(403, [])).toBe('permission');
    expect(classifyCloudflareError(403, [10000])).toBe('permission');
    expect(classifyCloudflareError(429, [])).toBe('quota');
    expect(classifyCloudflareError(400, [10031])).toBe('name-conflict');
    expect(classifyCloudflareError(500, [10013])).toBe('api');
  });
});

describe('授權', () => {
  it('buildTokenCreationUrl：照官方文件的使用者 Token 範本格式預填最小權限', () => {
    const url = buildTokenCreationUrl();
    expect(url).toBe(
      'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
        '%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D' +
        '&accountId=%2A&zoneId=all&name=Cinderous%20relay%20deploy',
    );
    const permissions = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('permissionGroupKeys')!));
    expect(permissions).toEqual([
      { key: 'workers_scripts', type: 'edit' },
      { key: 'account_settings', type: 'read' },
    ]);
  });

  it('buildTokenCreationUrl：帳號 Token 與自訂名稱', () => {
    const url = buildTokenCreationUrl({ kind: 'account', name: 'My vault relay' });
    expect(url.startsWith('https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B')).toBe(true);
    expect(url.endsWith('&name=My%20vault%20relay')).toBe(true);
    expect(url).not.toContain('accountId=');
  });

  it('verifyToken：使用者 Token 打 /user/tokens/verify；帳號 Token 打 /accounts/{id}/tokens/verify', async () => {
    const cf = fakeCloudflare({ 'GET /accounts/acc1/tokens/verify': ok({ id: 'a', status: 'active', expires_on: '2027-01-01T00:00:00Z' }) });
    expect(await verifyToken({ apiToken: 't', fetch: cf.http })).toEqual({ id: 'tok-id', status: 'active' });
    expect(await verifyToken({ apiToken: 't', fetch: cf.http, accountId: 'acc1' })).toEqual({
      id: 'a',
      status: 'active',
      expiresOn: '2027-01-01T00:00:00Z',
    });
  });

  it('verifyToken：空字串不發請求', async () => {
    const cf = fakeCloudflare();
    await expect(verifyToken({ apiToken: '  ', fetch: cf.http })).rejects.toMatchObject({ kind: 'token-invalid' });
    expect(cf.calls).toHaveLength(0);
  });

  it('listAccounts：一頁 50 筆，滿了就讀下一頁', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, name: `A${i}` }));
    const cf = fakeCloudflare({
      'GET /accounts?per_page=50&page=1': ok(page1),
      'GET /accounts?per_page=50&page=2': ok([{ id: 'last', name: 'Last' }]),
    });
    const accounts = await listAccounts({ apiToken: 't', fetch: cf.http });
    expect(accounts).toHaveLength(51);
    expect(accounts[50]).toEqual({ id: 'last', name: 'Last' });
  });
});

describe('multipart 與入口模組', () => {
  it('buildMultipartBody：CRLF 分段、結尾有收尾分隔', () => {
    const { body, contentType } = buildMultipartBody([{ name: 'metadata', contentType: 'application/json', content: '{}' }], 'XYZ');
    expect(contentType).toBe('multipart/form-data; boundary=XYZ');
    expect(new TextDecoder().decode(body)).toBe(
      '--XYZ\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{}\r\n--XYZ--\r\n',
    );
  });

  it('buildMultipartBody：內容撞到分隔字串就拒絕', () => {
    expect(() => buildMultipartBody([{ name: 'a', contentType: 'text/plain', content: 'xx--XYZyy' }], 'XYZ')).toThrow(/分隔/);
  });

  it('renderApiWorkerEntry：版號經 JSON 跳脫，不能注入程式碼', () => {
    expect(renderApiWorkerEntry('1.0"); evil("')).toContain('setRelayVersion("1.0\\"); evil(\\"")');
  });
});

describe('deployCloudflareRelayViaApi：TURN（SDK ADR 0118）', () => {
  it('turnKeyId 是 plain_text、turnApiToken 是 secret_text 綁定；Token 不出現在進度訊息', async () => {
    const cf = fakeCloudflare();
    const messages: string[] = [];
    await deployCloudflareRelayViaApi({
      ...base,
      fetch: cf.http,
      turnKeyId: 'turn-key-1',
      turnTtlSeconds: 3600,
      turnApiToken: 'turn-secret-value',
      onProgress: (s) => messages.push(JSON.stringify(s)),
    });
    const parts = parseMultipart(cf.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/my-relay'))!);
    const metadata = JSON.parse(parts.get('metadata')!.content);
    expect(metadata.bindings).toContainEqual({ type: 'plain_text', name: 'TURN_KEY_ID', text: 'turn-key-1' });
    expect(metadata.bindings).toContainEqual({ type: 'plain_text', name: 'TURN_TTL_SECONDS', text: '3600' });
    expect(metadata.bindings).toContainEqual({ type: 'secret_text', name: 'TURN_API_TOKEN', text: 'turn-secret-value' });
    // 其他儀表板設的 secret 照舊保留
    expect(metadata.keep_bindings).toEqual(['secret_text', 'secret_key']);
    expect(messages.join('\n')).not.toContain('turn-secret-value');
  });

  it('沒給 turnApiToken：不送 secret_text（沿用線上已經有的 secret）', async () => {
    const cf = fakeCloudflare();
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, turnKeyId: 'turn-key-1' });
    const parts = parseMultipart(cf.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/my-relay'))!);
    const types = JSON.parse(parts.get('metadata')!.content).bindings.map((b: { type: string }) => b.type);
    expect(types).not.toContain('secret_text');
  });

  it('🔴 有 turnApiToken 卻沒有 turnKeyId → 部署前就拒絕（訊息不含 Token）', async () => {
    const cf = fakeCloudflare();
    const error = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, turnApiToken: 'turn-secret-value' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/turnKeyId/);
    expect((error as Error).message).not.toContain('turn-secret-value');
    expect(cf.calls).toHaveLength(0);
  });

  it('turnTtlSeconds 沒有 turnKeyId → 部署前就拒絕', async () => {
    const cf = fakeCloudflare();
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http, turnTtlSeconds: 3600 })).rejects.toThrow(/turnKeyId/);
    expect(cf.calls).toHaveLength(0);
  });
});
