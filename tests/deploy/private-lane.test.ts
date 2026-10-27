// 私人路徑模式（SDK ADR 0051）：個人專屬中繼「開放寫入＋不可猜的隨機路徑」。
// 部署端：產生器、站台參數（relaySiteVars）、REST 部署回傳的網址與重新部署、設定器（描述表、Schema、部署包、CLI）。
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CloudflareApiError,
  collectRelaySiteIssues,
  deployCloudflareRelayViaApi,
  generatePrivateLaneId,
  type HttpFetch,
  type HttpRequestInit,
  PRIVATE_LANE_MIN_LENGTH,
  privateLaneEndpoint,
  privateLaneFromUrl,
  relaySiteVars,
} from '../../src/deploy/cloudflare-api/index.js';
import { deployConfigJsonSchema, renderDeployPackage, validateDeployConfig, type DeployConfig } from '../../src/deploy/config/index.js';
import { LANE_ID_PATTERN } from '../../src/relay/shard.js';
import { type CliDeps, runCli } from '../../src/cli/commands.js';
import type { CloudflareDeployOptions } from '../../src/deploy/cloudflare.js';
import type { DockerDeployOptions } from '../../src/deploy/docker.js';
import { generateSecretKey, getPublicKey } from '../../src/protocol/index.js';

const SECRET = 'k7q2mxz4ab3cd5ef6gh7ij2kl3';
const OTHER = 'zz2mxz4ab3cd5ef6gh7ij2kl3q';
const alice = getPublicKey(generateSecretKey());

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generatePrivateLaneId：WebCrypto 產生、128 位元以上、符合車道 id 規則', () => {
  it('26 字 base32 小寫（130 位元）；每次不同；用 getRandomValues', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const a = generatePrivateLaneId();
    const b = generatePrivateLaneId();
    expect(spy).toHaveBeenCalled();
    expect(a).toMatch(/^[a-z2-7]{26}$/);
    expect(LANE_ID_PATTERN.test(a)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(PRIVATE_LANE_MIN_LENGTH);
    expect(a).not.toBe(b);
  });

  it('網址：組出 /app/<id>（容忍結尾斜線）；從網址取回 id（只認得夠長的私人路徑）', () => {
    expect(privateLaneEndpoint('wss://r.alice.workers.dev', SECRET)).toBe(`wss://r.alice.workers.dev/app/${SECRET}`);
    expect(privateLaneEndpoint('wss://r.alice.workers.dev/', SECRET)).toBe(`wss://r.alice.workers.dev/app/${SECRET}`);
    expect(privateLaneFromUrl(`wss://r.alice.workers.dev/app/${SECRET}`)).toBe(SECRET);
    expect(privateLaneFromUrl(`wss://r.alice.workers.dev/app/${SECRET}/`)).toBe(SECRET);
    expect(privateLaneFromUrl('wss://r.alice.workers.dev')).toBeUndefined();
    expect(privateLaneFromUrl('wss://relay.example/app/cindersync')).toBeUndefined();
    expect(privateLaneFromUrl('not a url')).toBeUndefined();
  });
});

describe('relaySiteVars：privateLane（SDK ADR 0051）', () => {
  it('Worker：APP_LANES＝FILE_LANES＝秘密、LANES_ONLY=1；不要求白名單（不需 openFileRelay）', () => {
    const vars = relaySiteVars({ privateLane: SECRET, maxFileMb: 17 }, 'worker');
    expect(vars).toMatchObject({ APP_LANES: SECRET, FILE_LANES: SECRET, LANES_ONLY: '1', MAX_FILE_MB: '17' });
    expect(vars.ALLOWED_PUBKEYS).toBeUndefined();
  });

  it('白名單仍可選用（兩道一起擋）', () => {
    const vars = relaySiteVars({ privateLane: SECRET, maxFileMb: 17, allowedPubkeys: [alice] }, 'worker');
    expect(vars.ALLOWED_PUBKEYS).toBe(alice);
    expect(vars.LANES_ONLY).toBe('1');
  });

  it('沒開檔案：不寫 FILE_LANES', () => {
    const vars = relaySiteVars({ privateLane: SECRET }, 'worker');
    expect(vars.FILE_LANES).toBeUndefined();
    expect(vars.APP_LANES).toBe(SECRET);
  });

  it('Node 主機也能用（自架）：APP_LANES＋LANES_ONLY，MAX_FILE_MB 照舊是全站開關、沒有 FILE_LANES', () => {
    const vars = relaySiteVars({ privateLane: SECRET, maxFileMb: 17 }, 'node');
    expect(vars).toMatchObject({ APP_LANES: SECRET, LANES_ONLY: '1', MAX_FILE_MB: '17' });
    expect(vars.FILE_LANES).toBeUndefined();
  });

  it('🔴 太短、大寫、不合法的字元 → 拒絕，而且訊息不回顯值', () => {
    for (const bad of ['abc', SECRET.toUpperCase(), `${SECRET}!`, '_' + SECRET, 'a'.repeat(65)]) {
      const issues = collectRelaySiteIssues({ privateLane: bad }, 'worker');
      expect(issues.map((i) => i.code), bad).toContain('invalid-private-lane');
      expect(JSON.stringify(issues), bad).not.toContain(bad);
    }
  });

  it('與 appLanes／fileLanes 互斥（私人路徑模式只有那一條）', () => {
    expect(collectRelaySiteIssues({ privateLane: SECRET, appLanes: ['dochost'] }, 'worker').map((i) => i.code)).toContain('private-lane-exclusive');
    expect(collectRelaySiteIssues({ privateLane: SECRET, fileLanes: ['dochost'] }, 'worker').map((i) => i.code)).toContain('private-lane-exclusive');
  });

  it('沒有私人路徑時，開放中繼收檔案照舊要 openFileRelay（ADR 0027 §2 不變）', () => {
    expect(collectRelaySiteIssues({ maxFileMb: 17 }, 'worker').map((i) => i.code)).toContain('open-file-relay');
  });
});

// ── REST 部署（假的 Cloudflare，不會真的呼叫）──────────────────────────────────
const API = 'https://api.cloudflare.com/client/v4';
type Reply = { status?: number; body?: unknown; raw?: string };
const ok = (result: unknown): Reply => ({ body: { success: true, errors: [], messages: [], result } });

function fakeCloudflare(overrides: Record<string, Reply> = {}) {
  const calls: { method: string; url: string; init: HttpRequestInit }[] = [];
  const routes: Record<string, Reply> = {
    'GET /user/tokens/verify': ok({ id: 't', status: 'active' }),
    'GET /accounts?per_page=50&page=1': ok([{ id: 'acc1', name: 'Alice' }]),
    'GET /accounts/acc1/workers/subdomain': ok({ subdomain: 'alice' }),
    'GET /accounts/acc1/workers/scripts': ok([]),
    'PUT /accounts/acc1/workers/scripts/my-relay': ok({ id: 'my-relay' }),
    'POST /accounts/acc1/workers/scripts/my-relay/subdomain': ok({ enabled: true }),
    'GET https://my-relay.alice.workers.dev/healthz': { raw: 'ok' },
    ...overrides,
  };
  const http: HttpFetch = async (url, init) => {
    calls.push({ method: init.method, url, init });
    const key = url.startsWith(API) ? `${init.method} ${url.slice(API.length)}` : `${init.method} ${url}`;
    const reply = routes[key];
    if (!reply) throw new Error(`沒有這個路由：${key}`);
    const text = reply.raw ?? JSON.stringify(reply.body);
    return { status: reply.status ?? 200, text: async () => text };
  };
  return { http, calls };
}
const base = { apiToken: 'tok', workerName: 'my-relay', healthRetries: 1, healthDelayMs: 0 };
const metadataOf = (cf: ReturnType<typeof fakeCloudflare>) => {
  const put = cf.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/my-relay'))!;
  const text = new TextDecoder().decode(put.init.body as Uint8Array);
  const json = /\{"main_module".*?\}\r\n/s.exec(text)![0];
  return JSON.parse(json) as { bindings: { name: string; text?: string }[] };
};
const liveWith = (bindings: { name: string; text: string }[]) =>
  fakeCloudflare({
    'GET /accounts/acc1/workers/scripts': ok([{ id: 'my-relay', migration_tag: 'v1' }]),
    'GET /accounts/acc1/workers/scripts/my-relay/settings': ok({ bindings: bindings.map((b) => ({ type: 'plain_text', ...b })) }),
  });

describe('deployCloudflareRelayViaApi：私人路徑模式', () => {
  it('回傳的網址就是含秘密路徑的完整網址；健康檢查打的是 /healthz（不帶路徑）', async () => {
    const cf = fakeCloudflare();
    const result = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, privateLane: SECRET, maxFileMb: 17 });
    expect(result.relayEndpoint).toBe(`wss://my-relay.alice.workers.dev/app/${SECRET}`);
    expect(result.privateLane).toBe(SECRET);
    expect(result.httpUrl).toBe('https://my-relay.alice.workers.dev');
    const bindings = metadataOf(cf).bindings;
    expect(bindings).toContainEqual(expect.objectContaining({ name: 'LANES_ONLY', text: '1' }));
    expect(bindings).toContainEqual(expect.objectContaining({ name: 'APP_LANES', text: SECRET }));
    expect(bindings).toContainEqual(expect.objectContaining({ name: 'FILE_LANES', text: SECRET }));
  });

  it('重新部署沿用同一個 id：冪等，照常上傳', async () => {
    const cf = liveWith([
      { name: 'APP_LANES', text: SECRET },
      { name: 'LANES_ONLY', text: '1' },
    ]);
    const result = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, privateLane: SECRET, maxFileMb: 17 });
    expect(result.relayEndpoint).toBe(`wss://my-relay.alice.workers.dev/app/${SECRET}`);
  });

  it('🔴 換新 id（或從白名單模式改過來）沒有 allowLaneChange → lane-change、不上傳，訊息不含任何秘密', async () => {
    for (const live of [
      [
        { name: 'APP_LANES', text: SECRET },
        { name: 'LANES_ONLY', text: '1' },
      ],
      [{ name: 'ALLOWED_PUBKEYS', text: alice }],
    ]) {
      const cf = liveWith(live);
      const error = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, privateLane: OTHER, maxFileMb: 17 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect((error as CloudflareApiError).kind).toBe('lane-change');
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).not.toContain(OTHER);
      expect((error as Error).message).toContain('私人路徑');
      expect(cf.calls.some((c) => c.method === 'PUT')).toBe(false);
    }
  });

  it('allowLaneChange：換新路徑', async () => {
    const cf = liveWith([
      { name: 'APP_LANES', text: SECRET },
      { name: 'LANES_ONLY', text: '1' },
    ]);
    const result = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, privateLane: OTHER, maxFileMb: 17, allowLaneChange: true });
    expect(result.relayEndpoint.endsWith(`/app/${OTHER}`)).toBe(true);
  });

  it('不合法的 id → 一個請求都不發', async () => {
    const cf = fakeCloudflare();
    await expect(deployCloudflareRelayViaApi({ ...base, fetch: cf.http, privateLane: 'short' })).rejects.toThrow('私人路徑');
    expect(cf.calls).toHaveLength(0);
  });
});

// ── 設定器（SDK ADR 0050）─────────────────────────────────────────────────────
const ctx = { sdkVersion: '0.0.0-test', licenseText: 'LICENSE\n' };
const privateConfig = (target: DeployConfig['target'], extra: Partial<DeployConfig> = {}): DeployConfig =>
  ({
    configVersion: 1,
    target,
    name: 'mine',
    site: { privateLane: { $env: 'CINDEROUS_PRIVATE_LANE' }, maxFileMb: 17 },
    ...extra,
  }) as DeployConfig;

describe('設定器：site.privateLane 是秘密（只寫 $env）', () => {
  it('Schema：site.privateLane 是 secretRef', () => {
    const site = (deployConfigJsonSchema().properties as Record<string, { properties: Record<string, unknown> }>).site!.properties;
    expect(site.privateLane).toMatchObject({ $ref: '#/$defs/secretRef' });
  });

  it('$env 引用 → ok，而且不提醒「開放中繼」（私人路徑本來就開放寫入）', () => {
    const result = validateDeployConfig(privateConfig('cloudflare'));
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => i.code)).not.toContain('open-relay');
    expect(validateDeployConfig(privateConfig('docker')).ok).toBe(true);
  });

  it('🔴 直接寫值 → 拒絕（秘密不進設定檔）', () => {
    const result = validateDeployConfig({ configVersion: 1, target: 'cloudflare', site: { privateLane: SECRET } });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('secret-literal');
  });

  it('與 appLanes 一起用 → 與部署路徑同一條規則', () => {
    const result = validateDeployConfig({ ...privateConfig('cloudflare'), site: { privateLane: { $env: 'X' }, appLanes: ['dochost'] } });
    expect(result.issues.map((i) => i.code)).toContain('private-lane-exclusive');
  });

  it('🔴 部署包不含秘密：wrangler.toml 只寫 LANES_ONLY，APP_LANES／FILE_LANES 由說明教你用 wrangler secret put', () => {
    const pkg = renderDeployPackage(privateConfig('cloudflare'), ctx);
    const file = (path: string) => pkg.files.find((f) => f.path === path)!.content;
    const toml = file('wrangler.toml');
    expect(toml).toContain('LANES_ONLY = "1"');
    expect(toml).not.toMatch(/^APP_LANES\s*=/m);
    expect(toml).not.toMatch(/^FILE_LANES\s*=/m);
    expect(file('README-DEPLOY.md')).toContain('wrangler@4 secret put APP_LANES');
    expect(file('README-DEPLOY.md')).toContain('wrangler@4 secret put FILE_LANES');
    expect(file('README-DEPLOY.en.md')).toContain('wrangler@4 secret put APP_LANES');
    expect(file('.env.example')).toContain('CINDEROUS_PRIVATE_LANE=');
  });

  it('docker／home-tunnel：compose 從 .env 代入 APP_LANES（沒設就不啟動）', () => {
    const pkg = renderDeployPackage(privateConfig('docker'), ctx);
    const compose = pkg.files.find((f) => f.path === 'docker-compose.yml')!.content;
    expect(compose).toContain('APP_LANES: "${CINDEROUS_PRIVATE_LANE:?');
    expect(compose).toContain('LANES_ONLY: "1"');
    expect(compose).not.toContain('FILE_LANES');
    expect(pkg.files.find((f) => f.path === '.env.example')!.content).toContain('CINDEROUS_PRIVATE_LANE=');
  });

  it('fly：fly.toml 不含 APP_LANES，說明教你用 fly secrets set', () => {
    const pkg = renderDeployPackage(privateConfig('fly'), ctx);
    expect(pkg.files.find((f) => f.path === 'fly.toml')!.content).not.toContain('APP_LANES');
    expect(pkg.files.find((f) => f.path === 'fly.toml')!.content).toContain('LANES_ONLY');
    expect(pkg.files.find((f) => f.path === 'README-DEPLOY.md')!.content).toContain('fly secrets set APP_LANES=');
  });
});

describe('CLI：relay deploy --config 解析私人路徑', () => {
  const CWD = resolve('/work');
  function harness(config: unknown, env: Record<string, string>) {
    const cloudflare: CloudflareDeployOptions[] = [];
    const docker: DockerDeployOptions[] = [];
    const err: string[] = [];
    const written: Record<string, string> = {};
    const deps: CliDeps = {
      stdout: () => {},
      stderr: (line) => err.push(line),
      env,
      cwd: CWD,
      startNodeRelay: () => ({ close() {} }),
      deployCloudflareRelay: async (o) => {
        cloudflare.push(o);
        return { workerName: 'mine', configPath: 'w', httpUrl: 'https://mine.me.workers.dev', relayEndpoint: `wss://mine.me.workers.dev/app/${o.privateLane}` };
      },
      deployDockerRelay: async (o) => {
        docker.push(o);
        return { name: 'mine', configPath: 'c', httpUrl: 'http://localhost:8080', relayEndpoint: 'ws://localhost:8080' };
      },
      deployFlyRelay: async () => {
        throw new Error('不該呼叫');
      },
      writeFile: (path, content) => {
        written[path] = content;
      },
      readFile: (path) => (resolve(path) === resolve(CWD, 'cinderous.config.json') ? JSON.stringify(config) : undefined),
      buildRelayPackage: async () => {
        throw new Error('不該呼叫');
      },
      sdkVersion: '0.41.0',
    };
    return { deps, cloudflare, docker, err };
  }

  it('從環境讀出秘密交給部署函式', async () => {
    const h = harness(privateConfig('cloudflare'), { CINDEROUS_PRIVATE_LANE: SECRET });
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], h.deps)).toBe(0);
    expect(h.cloudflare[0]?.privateLane).toBe(SECRET);
  });

  it('環境裡沒有值 → 不部署、說出變數名稱（不印值）', async () => {
    const h = harness(privateConfig('cloudflare'), {});
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('CINDEROUS_PRIVATE_LANE');
    expect(h.cloudflare).toHaveLength(0);
  });
});

// ── 唯讀寬限期（SDK ADR 0052）────────────────────────────────────────────────
describe('relaySiteVars：readOnlyLanes（換私人路徑之後的舊路徑；SDK ADR 0052）', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('寫出 READONLY_LANES（`<id>@<到期>`）；過期的自動略過；Worker 與 Node 都支援', () => {
    const until = now() + 7 * 86_400;
    const lanes = [
      { id: SECRET, expiresAt: until },
      { id: 'old2xz4ab3cd5ef6gh7ij2kl3q', expiresAt: now() - 1 },
    ];
    expect(relaySiteVars({ privateLane: OTHER, readOnlyLanes: lanes }, 'worker').READONLY_LANES).toBe(`${SECRET}@${until}`);
    expect(relaySiteVars({ privateLane: OTHER, readOnlyLanes: lanes }, 'node').READONLY_LANES).toBe(`${SECRET}@${until}`);
    expect(relaySiteVars({ privateLane: OTHER, readOnlyLanes: [lanes[1]!] }, 'worker').READONLY_LANES).toBeUndefined();
  });

  it('🔴 不合法、太長、與可寫的車道相同、超過上限 → 拒絕，而且訊息不回顯 id', () => {
    const codes = (readOnlyLanes: { id: string; expiresAt: number }[]) => {
      const issues = collectRelaySiteIssues({ privateLane: OTHER, readOnlyLanes }, 'worker');
      expect(JSON.stringify(issues)).not.toContain(SECRET);
      expect(JSON.stringify(issues)).not.toContain(OTHER);
      return issues.map((i) => i.code);
    };
    expect(codes([{ id: `_${SECRET}`, expiresAt: now() + 60 }])).toContain('invalid-read-only-lane');
    expect(codes([{ id: SECRET, expiresAt: now() + 40 * 86_400 }])).toContain('read-only-too-long');
    expect(codes([{ id: OTHER, expiresAt: now() + 60 }])).toContain('read-only-lane-active');
    expect(codes([{ id: SECRET, expiresAt: 1.5 }])).toContain('out-of-range');
    expect(codes(Array.from({ length: 9 }, (_, i) => ({ id: `${SECRET.slice(0, 20)}lane${i}x`, expiresAt: now() + 60 })))).toContain('too-many-lanes');
  });
});

describe('deployCloudflareRelayViaApi：retireLane（換私人路徑時舊路徑唯讀；SDK ADR 0052）', () => {
  const liveRotating = (extra: { name: string; text: string }[] = []) =>
    liveWith([{ name: 'APP_LANES', text: SECRET }, { name: 'LANES_ONLY', text: '1' }, ...extra]);
  const binding = (cf: ReturnType<typeof fakeCloudflare>, name: string) => metadataOf(cf).bindings.find((b) => b.name === name)?.text;

  it('APP_LANES 只有新的、READONLY_LANES 是舊的＋預設 7 天；結果帶 readOnlyLanes', async () => {
    const cf = liveRotating();
    const before = Math.floor(Date.now() / 1000);
    const result = await deployCloudflareRelayViaApi({
      ...base,
      fetch: cf.http,
      privateLane: OTHER,
      maxFileMb: 17,
      allowLaneChange: true,
      retireLane: { id: SECRET },
    });
    expect(binding(cf, 'APP_LANES')).toBe(OTHER);
    expect(binding(cf, 'FILE_LANES')).toBe(OTHER);
    const [id, until] = String(binding(cf, 'READONLY_LANES')).split('@');
    expect(id).toBe(SECRET);
    expect(Number(until) - before).toBeGreaterThanOrEqual(7 * 86_400);
    expect(Number(until) - before).toBeLessThan(7 * 86_400 + 60);
    expect(result.readOnlyLanes).toEqual([{ id: SECRET, expiresAt: Number(until) }]);
  });

  it('graceDays 1–30 可選', async () => {
    const cf = liveRotating();
    const before = Math.floor(Date.now() / 1000);
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, privateLane: OTHER, allowLaneChange: true, retireLane: { id: SECRET, graceDays: 30 } });
    expect(Number(String(binding(cf, 'READONLY_LANES')).split('@')[1]) - before).toBeGreaterThanOrEqual(30 * 86_400);
  });

  it('🔴 不合法（沒有新的私人路徑、與新的相同、天數超出範圍、id 不合法）→ 一個請求都不發，訊息不回顯 id', async () => {
    for (const bad of [
      { privateLane: undefined, retireLane: { id: SECRET } },
      { privateLane: OTHER, retireLane: { id: OTHER } },
      { privateLane: OTHER, retireLane: { id: SECRET, graceDays: 0 } },
      { privateLane: OTHER, retireLane: { id: SECRET, graceDays: 31 } },
      { privateLane: OTHER, retireLane: { id: `_${SECRET}` } },
    ]) {
      const cf = fakeCloudflare();
      const error = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, allowLaneChange: true, ...bad } as never).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).not.toContain(OTHER);
      expect(cf.calls).toHaveLength(0);
    }
  });

  it('重新部署（沒有 retireLane）保留線上還沒到期的唯讀車道；過期的、又變成可寫的清掉', async () => {
    const now = Math.floor(Date.now() / 1000);
    const STALE = 'st4lexz4ab3cd5ef6gh7ij2kl3';
    const cf = liveWith([
      { name: 'APP_LANES', text: OTHER },
      { name: 'LANES_ONLY', text: '1' },
      { name: 'READONLY_LANES', text: `${SECRET}@${now + 3_600},${STALE}@${now - 1},${OTHER}@${now + 60}` },
    ]);
    const result = await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, privateLane: OTHER, maxFileMb: 17 });
    expect(binding(cf, 'READONLY_LANES')).toBe(`${SECRET}@${now + 3_600}`);
    expect(result.readOnlyLanes).toEqual([{ id: SECRET, expiresAt: now + 3_600 }]);
  });

  it('連續換兩次：前一次的舊路徑還在寬限期就一起保留', async () => {
    const now = Math.floor(Date.now() / 1000);
    const THIRD = 'th1rdz4ab3cd5ef6gh7ij2kl3q';
    const cf = liveWith([
      { name: 'APP_LANES', text: OTHER },
      { name: 'LANES_ONLY', text: '1' },
      { name: 'READONLY_LANES', text: `${SECRET}@${now + 3_600}` },
    ]);
    await deployCloudflareRelayViaApi({ ...base, fetch: cf.http, privateLane: THIRD, allowLaneChange: true, retireLane: { id: OTHER } });
    const listed = String(binding(cf, 'READONLY_LANES'))
      .split(',')
      .map((e) => e.split('@')[0]);
    expect(listed.sort()).toEqual([OTHER, SECRET].sort());
    expect(binding(cf, 'APP_LANES')).toBe(THIRD);
  });
});

describe('設定器：site.readOnlyLanes 是秘密（只寫 $env；SDK ADR 0052）', () => {
  const rotatedConfig = (target: DeployConfig['target']): DeployConfig =>
    privateConfig(target, {
      site: { privateLane: { $env: 'CINDEROUS_PRIVATE_LANE' }, readOnlyLanes: { $env: 'CINDEROUS_READONLY_LANES' }, maxFileMb: 17 },
    } as Partial<DeployConfig>);

  it('Schema 是 secretRef；$env 引用 → ok；直接寫值 → 拒絕', () => {
    const site = (deployConfigJsonSchema().properties as Record<string, { properties: Record<string, unknown> }>).site!.properties;
    expect(site.readOnlyLanes).toMatchObject({ $ref: '#/$defs/secretRef' });
    expect(validateDeployConfig(rotatedConfig('cloudflare')).ok).toBe(true);
    expect(validateDeployConfig({ configVersion: 1, target: 'cloudflare', site: { readOnlyLanes: `${SECRET}@1` } } as never).ok).toBe(false);
  });

  it('🔴 部署包不含秘密：wrangler 用 secret put、compose 從 .env 代入（沒設＝沒有）、fly 用 secrets set', () => {
    const cf = renderDeployPackage(rotatedConfig('cloudflare'), ctx);
    const file = (pkg: ReturnType<typeof renderDeployPackage>, path: string) => pkg.files.find((f) => f.path === path)!.content;
    expect(file(cf, 'wrangler.toml')).not.toMatch(/^READONLY_LANES\s*=/m);
    expect(file(cf, 'README-DEPLOY.md')).toContain('wrangler@4 secret put READONLY_LANES');
    expect(file(cf, 'README-DEPLOY.en.md')).toContain('wrangler@4 secret put READONLY_LANES');
    expect(file(cf, '.env.example')).toContain('CINDEROUS_READONLY_LANES=');
    const docker = renderDeployPackage(rotatedConfig('docker'), ctx);
    expect(file(docker, 'docker-compose.yml')).toContain('READONLY_LANES: "${CINDEROUS_READONLY_LANES:-}"');
    const fly = renderDeployPackage(rotatedConfig('fly'), ctx);
    expect(file(fly, 'fly.toml')).not.toContain('READONLY_LANES');
    expect(file(fly, 'README-DEPLOY.md')).toContain('fly secrets set READONLY_LANES=');
    for (const pkg of [cf, docker, fly]) expect(JSON.stringify(pkg.files)).not.toContain('rrrrrrrrrrrrrrrrrrrrrrrrrr@');
  });

  it('resolveSiteSecrets：從環境讀出並解析；沒有值＝沒有；格式不對 → 例外（不印 id）', async () => {
    const { resolveSiteSecrets } = await import('../../src/deploy/config/index.js');
    const until = Math.floor(Date.now() / 1000) + 60;
    const site = rotatedConfig('cloudflare').site;
    expect(resolveSiteSecrets(site, { CINDEROUS_PRIVATE_LANE: OTHER, CINDEROUS_READONLY_LANES: `${SECRET}@${until}` }).readOnlyLanes).toEqual([
      { id: SECRET, expiresAt: until },
    ]);
    expect(resolveSiteSecrets(site, { CINDEROUS_PRIVATE_LANE: OTHER }).readOnlyLanes).toBeUndefined();
    expect(() => resolveSiteSecrets(site, { CINDEROUS_PRIVATE_LANE: OTHER, CINDEROUS_READONLY_LANES: SECRET })).toThrow(/CINDEROUS_READONLY_LANES/);
    try {
      resolveSiteSecrets(site, { CINDEROUS_PRIVATE_LANE: OTHER, CINDEROUS_READONLY_LANES: SECRET });
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});
