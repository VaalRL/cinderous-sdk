// REST 部署的進度子步驟與雙語訊息、名稱檢查的雙語問題（SDK ADR 0055；CinderSync G20）。假的 HTTP，不會呼叫 Cloudflare。
import { describe, expect, it } from 'vitest';

import {
  checkRelayName,
  collectCloudflareApiDeployIssues,
  CLOUDFLARE_DEPLOY_SUBSTEPS,
  deployCloudflareRelayViaApi,
  type DeployProgressStatus,
  type HttpFetch,
} from '../../src/deploy/cloudflare-api/index.js';

const API = 'https://api.cloudflare.com/client/v4';
const ok = (result: unknown) => ({ status: 200, text: async () => JSON.stringify({ success: true, errors: [], messages: [], result }) });

function fakeCloudflare(opts: { existing?: boolean; settingsStatus?: number } = {}): HttpFetch {
  return async (url, init) => {
    const key = url.startsWith(API) ? `${init.method} ${url.slice(API.length)}` : `${init.method} ${url}`;
    switch (key) {
      case 'GET /user/tokens/verify':
        return ok({ id: 't', status: 'active' });
      case 'GET /accounts?per_page=50&page=1':
        return ok([{ id: 'acc1', name: 'Alice' }]);
      case 'GET /accounts/acc1/workers/subdomain':
        return ok({ subdomain: 'alice' });
      case 'GET /accounts/acc1/workers/scripts':
        return ok(opts.existing ? [{ id: 'my-relay', migration_tag: 'v1' }] : []);
      case 'GET /accounts/acc1/workers/scripts/my-relay/settings':
        if (opts.settingsStatus) return { status: opts.settingsStatus, text: async () => JSON.stringify({ success: false, errors: [{ code: 10000, message: 'x' }], messages: [], result: null }) };
        return ok({ bindings: [] });
      case 'PUT /accounts/acc1/workers/scripts/my-relay':
        return ok({ id: 'my-relay' });
      case 'POST /accounts/acc1/workers/scripts/my-relay/subdomain':
        return ok({ enabled: true });
      case 'GET https://my-relay.alice.workers.dev/healthz':
        return { status: 200, text: async () => 'ok' };
      default:
        throw new Error(`沒有這個路由：${key}`);
    }
  };
}

const base = { apiToken: 'secret-token', workerName: 'my-relay', healthRetries: 1, healthDelayMs: 0 };

describe('部署進度的子步驟 id 與雙語訊息', () => {
  it('🔴 每個進度都有穩定的 substep 與 { zh-TW, en } 訊息；message 照舊是中文（相容）；順序固定', async () => {
    const got: DeployProgressStatus[] = [];
    await deployCloudflareRelayViaApi({ ...base, fetch: fakeCloudflare(), onProgress: (s) => got.push(s) });
    expect(got.map((s) => [s.step, s.substep])).toEqual([
      ['config', 'verify-token'],
      ['config', 'account'],
      ['config', 'subdomain'],
      ['deploy', 'upload'],
      ['deploy', 'route'],
      ['health', 'health'],
      ['done', 'done'],
    ]);
    for (const s of got) {
      expect(s.messages!['zh-TW']).toBe(s.message);
      expect(s.messages!.en).toMatch(/^[\x20-\x7e]+$/); // 英文訊息沒有中文
      expect(CLOUDFLARE_DEPLOY_SUBSTEPS).toContain(s.substep);
    }
    expect(got[3]!.messages!.en).toContain('my-relay');
    expect(got[6]!.messages!.en).toContain('wss://my-relay.alice.workers.dev');
  });

  it('重新部署讀線上設定：live-config；讀不到 → live-config-skipped（雙語說明）', async () => {
    const got: DeployProgressStatus[] = [];
    await deployCloudflareRelayViaApi({ ...base, fetch: fakeCloudflare({ existing: true }), onProgress: (s) => got.push(s) });
    expect(got.map((s) => s.substep)).toContain('live-config');
    const skipped: DeployProgressStatus[] = [];
    await deployCloudflareRelayViaApi({ ...base, fetch: fakeCloudflare({ existing: true, settingsStatus: 403 }), onProgress: (s) => skipped.push(s) });
    const note = skipped.find((s) => s.substep === 'live-config-skipped')!;
    expect(note.message).toContain('略過已知租戶名單的變更檢查');
    expect(note.messages!.en).toContain('skipp');
  });

  it('🔴 私人路徑：雙語訊息都不含私人路徑', async () => {
    const got: DeployProgressStatus[] = [];
    const privateLane = 'k7q2mxz4ab3cd5ef6gh7ij2kl3';
    await deployCloudflareRelayViaApi({ ...base, fetch: fakeCloudflare(), privateLane, onProgress: (s) => got.push(s) });
    for (const s of got) expect(JSON.stringify(s)).not.toContain(privateLane);
  });

  it('OAuth 不驗 Token：沒有 verify-token；指定 accountId：沒有 account', async () => {
    const got: DeployProgressStatus[] = [];
    await deployCloudflareRelayViaApi({ ...base, credential: 'oauth', accountId: 'acc1', fetch: fakeCloudflare(), onProgress: (s) => got.push(s) });
    expect(got.map((s) => s.substep)).toEqual(['subdomain', 'upload', 'route', 'health', 'done']);
  });
});

describe('名稱檢查的雙語問題', () => {
  it('🔴 checkRelayName：合法回 null；不合法回 DeployIssue（code、path、雙語訊息）', () => {
    expect(checkRelayName('my-relay', 'worker')).toBeNull();
    const bad = checkRelayName('My_Relay', 'worker')!;
    expect(bad).toMatchObject({ path: 'workerName', code: 'invalid-name', severity: 'error' });
    expect(bad.message['zh-TW']).toContain('Worker 名稱');
    expect(bad.message.en).toContain('Worker name');
    expect(checkRelayName('-x', 'subdomain')).toMatchObject({ path: 'workersDevSubdomain', code: 'invalid-name' });
    expect(checkRelayName('a'.repeat(64), 'subdomain')!.message.en).toContain('63');
    expect(checkRelayName('', 'worker')).toMatchObject({ code: 'invalid-name' });
  });

  it('🔴 collectCloudflareApiDeployIssues：名稱、子網域、相容日期、retireLane 與站台參數一次列出；沒問題是空陣列', () => {
    expect(collectCloudflareApiDeployIssues({ apiToken: 't', workerName: 'my-relay' })).toEqual([]);
    const issues = collectCloudflareApiDeployIssues({
      apiToken: 't',
      workerName: 'Bad Name',
      workersDevSubdomain: '-alice',
      compatibilityDate: '2026/01/01',
      appLanes: ['DocHost'],
      retireLane: { id: 'old', graceDays: 99 },
    });
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ['workerName', 'invalid-name'],
      ['workersDevSubdomain', 'invalid-name'],
      ['compatibilityDate', 'invalid-date'],
      ['retireLane', 'retire-needs-private-lane'],
      ['appLanes', expect.any(String)],
    ]);
    for (const i of issues) {
      expect(i.message['zh-TW'].length).toBeGreaterThan(0);
      expect(i.message.en.length).toBeGreaterThan(0);
    }
    // 預設的 Worker 名稱合法
    expect(collectCloudflareApiDeployIssues({ apiToken: 't' })).toEqual([]);
  });

  it('retireLane 的各種錯誤也是雙語問題，與部署時丟的例外同一份規則', async () => {
    const privateLane = 'k7q2mxz4ab3cd5ef6gh7ij2kl3';
    const codes = (retireLane: { id: string; graceDays?: number }) =>
      collectCloudflareApiDeployIssues({ apiToken: 't', privateLane, retireLane }).filter((i) => i.path === 'retireLane').map((i) => i.code);
    expect(codes({ id: 'BAD ID' })).toEqual(['invalid-retire-lane']);
    expect(codes({ id: privateLane })).toEqual(['retire-lane-same']);
    expect(codes({ id: 'old-lane', graceDays: 0 })).toEqual(['invalid-grace-days']);
    expect(codes({ id: 'old-lane', graceDays: 7 })).toEqual([]);
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: fakeCloudflare(), privateLane, retireLane: { id: privateLane } })).rejects.toThrow('相同');
  });
});
