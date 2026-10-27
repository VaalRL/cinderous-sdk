// 部署設定檔（SDK ADR 0050 §3、§4、§6）：描述表、JSON Schema、收集式驗證、秘密。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PUSH_GATEWAY_DO, pushGatewayVars } from '../../src/deploy/config/push-package.js';
import { DEFAULT_PUSH_GATEWAY_IOS, PUSH_GATEWAY_LIMIT_SPECS } from '../../src/deploy/config/specs.js';
import { IOT_PUSH_LIMITS } from '../../src/iot/push.js';
import { DEFAULT_PUSH_GATEWAY_IOS_MODE } from '../../src/iot/push-gateway/core.js';
import { PUSH_STATE_BINDING, PUSH_STATE_MIGRATIONS } from '../../src/iot/push-gateway/worker.js';

import { USAGE } from '../../src/cli/commands.js';
import {
  DEPLOY_OPTION_SPECS,
  type DeployConfig,
  findSecretLiterals,
  renderDeployConfigJsonSchema,
  resolveSecret,
  SITE_OPTION_KEYS,
  validateDeployConfig,
} from '../../src/deploy/config/index.js';
import { relaySiteVars, WORKER_ONLY_SITE_OPTIONS } from '../../src/deploy/shared.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const alice = getPublicKey(generateSecretKey());

const base = (extra: Partial<DeployConfig> = {}): DeployConfig => ({ configVersion: 1, target: 'cloudflare', site: { allowedPubkeys: [alice] }, ...extra });
const codes = (input: unknown, opts = {}) => validateDeployConfig(input, opts).issues.map((i) => `${i.severity}:${i.path}:${i.code}`);

describe('描述表 DEPLOY_OPTION_SPECS', () => {
  it('站台參數的鍵＝RelaySiteOptions 的鍵（型別在編譯期保證；這裡再比一次 Worker 限定的清單）', () => {
    const workerOnly = DEPLOY_OPTION_SPECS.filter((s) => s.path.startsWith('site.') && s.hosts?.length === 1 && s.hosts[0] === 'worker').map((s) => s.path.slice(5));
    expect(workerOnly.sort()).toEqual([...WORKER_ONLY_SITE_OPTIONS].sort());
    expect(SITE_OPTION_KEYS).toContain('relaySoftwareUrl');
  });

  it('每一項都有中英說明；路徑不重複', () => {
    const paths = DEPLOY_OPTION_SPECS.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const spec of DEPLOY_OPTION_SPECS) {
      expect(spec.description['zh-TW'].length, spec.path).toBeGreaterThan(0);
      expect(spec.description.en.length, spec.path).toBeGreaterThan(0);
    }
  });

  it('描述表的 env 就是 relaySiteVars 寫出的環境變數名稱', () => {
    const vars = relaySiteVars(
      {
        allowedPubkeys: [alice],
        relayName: 'n',
        relayDescription: 'd',
        relayContact: 'c',
        relayPubkey: alice,
        relaySoftwareUrl: 'https://x.example/src',
        maxTtlDays: 3,
        maxFileMb: 17,
        appLanes: ['a'],
        fileLanes: ['a'],
        appLanePow: 1,
        developerDocsUrl: 'https://x.example',
      },
      'worker',
    );
    // 私人路徑（SDK ADR 0051）與 appLanes 互斥：另外算一份
    const privateVars = relaySiteVars(
      {
        privateLane: 'k7q2mxz4ab3cd5ef6gh7ij2kl3',
        maxFileMb: 17,
        // 唯讀寬限期（SDK ADR 0052）
        readOnlyLanes: [{ id: 'z9y8x7w6v5u4t3s2r2q2p2o2n2', expiresAt: Math.floor(Date.now() / 1000) + 86_400 }],
      },
      'worker',
    );
    // 只有 Node 主機的項目（SDK ADR 0099）
    const nodeVars = relaySiteVars(
      {
        ceilingMode: 'evict',
        maxConnections: 2000,
        maxConnectionsPerIp: 20,
        monthlyTrafficGib: 900,
        trafficResetDay: 15,
        trafficCount: 'out',
        trafficNearFullPercent: 90,
      },
      'node',
    );
    const keys = [...Object.keys(vars), ...Object.keys(privateVars), ...Object.keys(nodeVars)];
    for (const spec of DEPLOY_OPTION_SPECS.filter((s) => s.path.startsWith('site.') && s.env && !s.env.includes('*') && !s.env.startsWith('DO_'))) {
      expect(keys, spec.path).toContain(spec.env);
    }
  });

  it('推播閘道項目的 env 就是推播閘道部署包寫出的變數名稱；上限與 ./iot 的 IOT_PUSH_LIMITS 一致', () => {
    const vars = pushGatewayVars({ configVersion: 1, target: 'docker', service: 'push-gateway', pushGateway: { ios: 'apns', apnsTopic: 'com.example.a', apnsKeyId: 'ABCDEFGHIJ', apnsTeamId: 'ABCDEFGHIJ' } });
    const specs = DEPLOY_OPTION_SPECS.filter((s) => s.path.startsWith('pushGateway.'));
    expect(specs.length).toBe(11);
    for (const spec of specs) {
      expect(spec.services, spec.path).toEqual(['push-gateway']);
      expect(Object.keys(vars), spec.path).toContain(spec.env);
    }
    expect(PUSH_GATEWAY_LIMIT_SPECS.tokenPerHour).toEqual(IOT_PUSH_LIMITS.gatewayTokenPerHour);
    expect(PUSH_GATEWAY_LIMIT_SPECS.tokenPerMinute).toEqual(IOT_PUSH_LIMITS.gatewayTokenPerMinute);
    expect(PUSH_GATEWAY_LIMIT_SPECS.maxSkewSec).toEqual(IOT_PUSH_LIMITS.gatewayMaxSkewSec);
    expect(PUSH_GATEWAY_LIMIT_SPECS.maxRegistrationDays.max * 86_400).toBe(IOT_PUSH_LIMITS.registrationTtlSec.max);
    // iOS 的預設值（SDK ADR 0062）：設定器、描述表與執行期同一個
    expect(DEFAULT_PUSH_GATEWAY_IOS).toBe(DEFAULT_PUSH_GATEWAY_IOS_MODE);
    expect(specs.find((s) => s.path === 'pushGateway.ios')!.default).toBe(DEFAULT_PUSH_GATEWAY_IOS_MODE);
    expect(pushGatewayVars({ configVersion: 1, target: 'docker', service: 'push-gateway' }).PUSH_IOS).toBe(DEFAULT_PUSH_GATEWAY_IOS_MODE);
    // 部署包的 DO 綁定與 Worker 程式一致
    expect(PUSH_GATEWAY_DO).toMatchObject({ name: PUSH_STATE_BINDING.name, className: PUSH_STATE_BINDING.className, migrationTag: PUSH_STATE_MIGRATIONS[0]!.tag });
  });

  it('有旗標的項目都出現在 relay deploy 的 USAGE 裡（CLI 與描述表不漂移）', () => {
    for (const spec of DEPLOY_OPTION_SPECS.filter((s) => s.flag)) expect(USAGE, spec.path).toContain(`--${spec.flag}`);
  });
});

describe('JSON Schema', () => {
  it('提交的 schema/cinderous.config.schema.json 與描述表一致（不一致請跑 `cinderous config schema > schema/cinderous.config.schema.json`）', () => {
    expect(readFileSync(`${root}schema/cinderous.config.schema.json`, 'utf8').replace(/\r\n/g, '\n')).toBe(renderDeployConfigJsonSchema());
  });

  it('所有層級都不接受未知的鍵；home-tunnel 必填 hostname 與 tunnelToken', () => {
    const schema = JSON.parse(renderDeployConfigJsonSchema()) as Record<string, any>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.site.additionalProperties).toBe(false);
    expect(schema.properties.site.properties.maxTtlDays).toMatchObject({ type: 'integer', minimum: 1, maximum: 365, default: 7 });
    expect(schema.properties.secrets.properties.tunnelToken).toMatchObject({ $ref: '#/$defs/secretRef' });
    expect(schema.allOf[0].then.properties.tunnel.required).toEqual(['hostname']);
  });
});

describe('validateDeployConfig：收集式、不丟例外', () => {
  it('合法的設定 → ok', () => {
    expect(validateDeployConfig(base())).toEqual({ ok: true, issues: [] });
    expect(validateDeployConfig({ configVersion: 1, target: 'docker', node: { port: 9000, persist: true } }).ok).toBe(true);
  });

  it('不是物件、缺 configVersion／target、未知的目標', () => {
    expect(codes(null)).toEqual(['error::type']);
    expect(codes({ target: 'docker' })).toContain('error:configVersion:required');
    expect(codes({ configVersion: 1 })).toEqual(['error:target:required']);
    expect(codes({ configVersion: 1, target: 'heroku' })).toEqual(['error:target:enum']);
    expect(codes({ configVersion: 2, target: 'docker' })).toEqual(['error:configVersion:unsupported-version']);
  });

  it('🔴 未知的鍵（打錯字）每一層都擋', () => {
    expect(codes({ ...base(), sit: {} })).toContain('error:sit:unknown-key');
    expect(codes(base({ site: { maxTtlDay: 3 } as never }))).toContain('error:site.maxTtlDay:unknown-key');
    expect(codes(base({ node: { persists: true } as never }))).toContain('error:node.persists:unknown-key');
    expect(codes(base({ site: { donations: { patreon: 'x' } as never } }))).toContain('error:site.donations.patreon:unknown-key');
  });

  it('站台參數的錯誤與部署路徑同一句話（collectRelaySiteIssues），而且一次列出全部', () => {
    const result = validateDeployConfig(base({ site: { allowedPubkeys: [alice], maxTtlDays: 0, relayName: 'a\nb' } }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.path)).toEqual(['site.relayName', 'site.maxTtlDays']);
    expect(result.issues[1]!.message['zh-TW']).toBe('maxTtlDays 必須是 1–365 的整數，收到 0');
  });

  it('型別錯了先報型別，不再跑站台規則（避免一個錯報兩次）', () => {
    expect(codes(base({ site: { allowedPubkeys: [alice], maxTtlDays: '7' as never } }))).toEqual(['error:site.maxTtlDays:type']);
  });

  it('🔴 Worker 目標設了 node.* → 拒絕（不再默默忽略；ADR 0050 §3）', () => {
    expect(codes(base({ node: { persist: true } }))).toContain('error:node.persist:not-applicable');
    expect(codes(base({ node: { trustProxy: true } }))).toContain('error:node.trustProxy:not-applicable');
    expect(codes({ configVersion: 1, target: 'fly', node: { port: 9000 }, site: { allowedPubkeys: [alice] } })).toContain('error:node.port:not-applicable');
  });

  it('不適用的區段只提醒（fly 區段配 docker 目標）', () => {
    expect(codes({ configVersion: 1, target: 'docker', fly: { region: 'sin' }, site: { allowedPubkeys: [alice] } })).toEqual(['warning:fly.region:not-applicable']);
  });

  it('Node 主機收到車道 → worker-only（與 relaySiteVars 同一條規則）', () => {
    expect(codes({ configVersion: 1, target: 'docker', site: { allowedPubkeys: [alice], appLanes: ['dochost'] } })).toEqual(['error:site.appLanes:worker-only']);
  });

  it('home-tunnel：hostname 與 tunnelToken 必填；trustProxy 不能關', () => {
    const issues = codes({ configVersion: 1, target: 'home-tunnel', node: { trustProxy: false }, site: { allowedPubkeys: [alice] } });
    expect(issues).toContain('error:tunnel.hostname:required');
    expect(issues).toContain('error:secrets.tunnelToken:required');
    expect(issues).toContain('error:node.trustProxy:trust-proxy-required');
    expect(
      validateDeployConfig({
        configVersion: 1,
        target: 'home-tunnel',
        tunnel: { hostname: 'relay.example.com' },
        secrets: { tunnelToken: { $env: 'TUNNEL_TOKEN' } },
        site: { allowedPubkeys: [alice] },
      }).ok,
    ).toBe(true);
    expect(codes({ configVersion: 1, target: 'home-tunnel', tunnel: { hostname: 'not a host' }, secrets: { tunnelToken: { $env: 'T' } } })).toContain(
      'error:tunnel.hostname:pattern',
    );
  });

  it('fly 的 trustProxy 也不能關；區域代碼要三個小寫字母', () => {
    expect(codes({ configVersion: 1, target: 'fly', node: { trustProxy: false } })).toContain('error:node.trustProxy:trust-proxy-required');
    expect(codes({ configVersion: 1, target: 'fly', fly: { region: 'Tokyo' } })).toContain('error:fly.region:pattern');
  });

  it('Cloudflare 的 Account ID：32 字元 hex 或 $env；compatibilityDate 要是真的日期', () => {
    expect(validateDeployConfig(base({ cloudflare: { accountId: 'a'.repeat(32) } })).ok).toBe(true);
    expect(validateDeployConfig(base({ cloudflare: { accountId: { $env: 'CF_ACCOUNT' } } })).ok).toBe(true);
    expect(codes(base({ cloudflare: { accountId: 'acc' } }))).toContain('error:cloudflare.accountId:pattern');
    expect(codes(base({ cloudflare: { compatibilityDate: '2026-02-31x' } }))).toContain('error:cloudflare.compatibilityDate:pattern');
  });

  it('沒有白名單 → 提醒開放中繼（不擋）', () => {
    const result = validateDeployConfig({ configVersion: 1, target: 'docker' });
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => i.code)).toEqual(['open-relay']);
  });

  it('checkSite: false（旗標路徑）：不跑站台規則', () => {
    expect(validateDeployConfig(base({ site: { allowedPubkeys: ['npub1a'] } }), { checkSite: false }).ok).toBe(true);
  });
});

describe('版本相容（ADR 0050 §6）', () => {
  it('設定檔比 CLI 新 → 拒絕；比 CLI 舊 → 提醒中間影響部署的變更；相同 → 沒事', () => {
    expect(codes(base({ sdk: '0.39.0' }), { sdkVersion: '0.38.0' })).toEqual(['error:sdk:sdk-newer']);
    const older = validateDeployConfig(base({ sdk: '0.30.0' }), { sdkVersion: '0.38.0' });
    expect(older.ok).toBe(true);
    expect(older.issues[0]!.code).toBe('sdk-older');
    expect(older.issues[0]!.message['zh-TW']).toContain('ADR 0036、0037');
    expect(older.issues[0]!.message['zh-TW']).toContain('ADR 0050');
    expect(older.issues[0]!.message['zh-TW']).not.toContain('ADR 0027');
    expect(validateDeployConfig(base({ sdk: '0.38.0' }), { sdkVersion: '0.38.0' }).issues).toEqual([]);
  });
});

describe('秘密（ADR 0050 §4）', () => {
  it('🔴 秘密欄位直接寫值 → 拒絕；只能是 { $env }', () => {
    expect(codes(base({ secrets: { cloudflareApiToken: 'abc' as never } }))).toEqual(['error:secrets.cloudflareApiToken:secret-literal']);
    expect(codes(base({ secrets: { cloudflareApiToken: { $env: '1BAD' } } }))).toEqual(['error:secrets.cloudflareApiToken:secret-ref']);
    expect(codes(base({ secrets: { cloudflareApiToken: { $env: 'CF', value: 'x' } as never } }))).toContain('error:secrets.cloudflareApiToken:secret-ref');
  });

  it('🔴 任何欄位裡確定是秘密的字串（nsec、Fly Token、Tunnel Token、PEM）→ 拒絕', () => {
    const nsec = 'nsec1' + 'q'.repeat(58);
    expect(codes(base({ site: { allowedPubkeys: [alice], relayContact: nsec } }))).toContain('error:site.relayContact:secret-literal');
    expect(findSecretLiterals({ name: 'FlyV1 fm2_abcdefghijklmnopqrstuvwxyz' })[0]!.severity).toBe('error');
    expect(findSecretLiterals({ x: `eyJ${'a'.repeat(60)}` })[0]!.severity).toBe('error');
    expect(findSecretLiterals({ x: '-----BEGIN OPENSSH PRIVATE KEY-----' })[0]!.severity).toBe('error');
  });

  it('疑似 Token（大小寫與數字混合的長字串）→ 只提醒；公鑰、Account ID、網址、npub 不誤報', () => {
    const token = 'Abc123XyZ789def456GHI012jkl345MNO678pq';
    expect(findSecretLiterals({ site: { relayContact: token } })).toMatchObject([{ severity: 'warning', code: 'secret-like', path: 'site.relayContact' }]);
    expect(
      findSecretLiterals({
        site: { allowedPubkeys: [alice, npubEncode(alice)], relaySoftwareUrl: 'https://Example.com/AbC123XyZ789def456GHI012jkl345MNO' },
        cloudflare: { accountId: 'a'.repeat(32) },
        secrets: { cloudflareApiToken: { $env: 'CLOUDFLARE_API_TOKEN' } },
      }),
    ).toEqual([]);
  });

  it('resolveSecret：引用的名稱 → 沒有就用預設名稱 → 都沒有回 undefined', () => {
    const env = { MY_TOKEN: 't1', CLOUDFLARE_API_TOKEN: 't2', EMPTY: '' };
    expect(resolveSecret({ $env: 'MY_TOKEN' }, env, 'CLOUDFLARE_API_TOKEN')).toBe('t1');
    expect(resolveSecret(undefined, env, 'CLOUDFLARE_API_TOKEN')).toBe('t2');
    expect(resolveSecret({ $env: 'EMPTY' }, env)).toBeUndefined();
    expect(resolveSecret(undefined, {}, 'X')).toBeUndefined();
  });
});
