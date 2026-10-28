// C′ 即時通道的部署接線（SDK ADR 0121）：站台參數 → `IOT_REALTIME`、秘密 → `IOT_GATEWAY_KEYS`、
// Worker 的 `IOT_HOME` 綁定與 v2 遷移。驗證與 relay 共用同一份規則（checkIotRealtimeConfig）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import type { CommandRunner } from '../../src/deploy/common.js';
import { cloudflareApiOptionsFromConfig, type DeployConfig, type DeployPackageContext, renderDeployPackage } from '../../src/deploy/config/index.js';
import { deployDockerRelay } from '../../src/deploy/docker.js';
import { deployFlyRelay } from '../../src/deploy/fly.js';
import { buildWorkerMetadata, planMigrations, renderApiWorkerEntry } from '../../src/deploy/cloudflare-api/deploy.js';
import { relayWorkerSource } from '../../src/deploy/cloudflare-api/index.js';
import { renderWranglerToml } from '../../src/deploy/render.js';
import {
  collectRelaySiteIssues,
  IOT_HOME_DO_BINDING,
  RELAY_DO_MIGRATIONS,
  relaySiteVars,
  type RelaySiteOptions,
  relayWorkerSecrets,
} from '../../src/deploy/shared.js';
import { IOT_BLIND_LENGTH } from '../../src/iot/index.js';
import { generateSecretKey, getPublicKey } from '../../src/protocol/keys.js';
import { IOT_REALTIME_BLIND_LENGTH } from '../../src/relay/iot-realtime-config.js';

const gatewaySecret = generateSecretKey();
const HOME_TAG = 'h'.repeat(22);

/** 測試也要餵壞的形狀進去，所以回傳型別直接宣告成站台參數的型別 */
function realtime(overrides: Record<string, unknown> = {}): NonNullable<RelaySiteOptions['iotRealtime']> {
  return {
    homes: [
      {
        homeTag: HOME_TAG,
        homePub: getPublicKey(generateSecretKey()),
        gatewayPubkey: getPublicKey(gatewaySecret),
        acl: [{ pubkey: getPublicKey(generateSecretKey()), role: 'owner' }],
        devices: [{ id: 'lamp', blindId: 'd'.repeat(22), epoch: 0, tokenHash: 'a'.repeat(64) }],
        ...overrides,
      },
    ],
  } as unknown as NonNullable<RelaySiteOptions['iotRealtime']>;
}

describe('站台參數 iotRealtime → IOT_REALTIME（SDK ADR 0121）', () => {
  it('兩種主機都寫成 JSON；沒給就不設', () => {
    const cfg = realtime();
    for (const host of ['worker', 'node'] as const) {
      expect(JSON.parse(relaySiteVars({ iotRealtime: cfg }, host).IOT_REALTIME!)).toEqual(cfg);
      expect(relaySiteVars({}, host).IOT_REALTIME).toBeUndefined();
    }
  });

  it('與 relay 同一份規則：一次列出全部問題，路徑帶 iotRealtime. 前綴', () => {
    const issues = collectRelaySiteIssues({ iotRealtime: realtime({ homeTag: 'short', devices: [{ id: 'x', blindId: 'bad', epoch: 0, tokenHash: 'nope' }] }) }, 'worker');
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ['iotRealtime.homes[0].homeTag', 'iot-home-tag'],
      ['iotRealtime.homes[0].devices[0].blindId', 'iot-blind-id'],
      ['iotRealtime.homes[0].devices[0].tokenHash', 'iot-token-hash'],
    ]);
    expect(issues.every((i) => i.severity === 'error' && i.message.en.length > 0)).toBe(true);
    expect(() => relaySiteVars({ iotRealtime: realtime({ homeTag: 'short' }) }, 'worker')).toThrow(/homeTag/);
  });

  it('名單只檢查形狀（部署設定器不帶進 ./iot）：缺 pubkey、壞角色都擋', () => {
    const issues = collectRelaySiteIssues({ iotRealtime: realtime({ acl: [{ pubkey: 'x', role: 'owner' }, { role: 'god' }] }) }, 'node');
    expect(issues.map((i) => i.code)).toEqual(['iot-acl']);
  });

  it('門鎖類沒有本地開啟方式就拒絕部署（ADR 0049 §10.5）', () => {
    const issues = collectRelaySiteIssues({ iotRealtime: realtime({ devices: [{ id: 'door', blindId: 'd'.repeat(22), epoch: 0, tokenHash: 'a'.repeat(64), class: 'lock' }] }) }, 'worker');
    expect(issues.map((i) => i.code)).toEqual(['iot-lock-local-fallback']);
  });

  it('iotHomeDailyRequests → IOT_HOME_DAILY_REQUESTS：只有 Cloudflare 版、要有 iotRealtime、範圍 1–10,000,000', () => {
    expect(relaySiteVars({ iotRealtime: realtime(), iotHomeDailyRequests: 5000 }, 'worker').IOT_HOME_DAILY_REQUESTS).toBe('5000');
    expect(collectRelaySiteIssues({ iotRealtime: realtime(), iotHomeDailyRequests: 5000 }, 'node').map((i) => i.code)).toEqual(['worker-only']);
    expect(collectRelaySiteIssues({ iotHomeDailyRequests: 5000 }, 'worker').map((i) => i.code)).toEqual(['iot-needs-realtime']);
    expect(collectRelaySiteIssues({ iotRealtime: realtime(), iotHomeDailyRequests: 0 }, 'worker').map((i) => i.code)).toEqual(['out-of-range']);
  });

  it('盲化 id 長度與 ./iot 一致（設定模組不能引用 ./iot，只能靠這個測試守）', () => {
    expect(IOT_REALTIME_BLIND_LENGTH).toBe(IOT_BLIND_LENGTH);
  });
});

describe('秘密 iotGatewayKeys → IOT_GATEWAY_KEYS（SDK ADR 0121）', () => {
  const key = bytesToHex(gatewaySecret);

  it('寫成 JSON 的 Worker secret', () => {
    const out = relayWorkerSecrets({ iotGatewayKeys: { [HOME_TAG]: key }, iotRealtime: realtime() });
    expect(JSON.parse(out.IOT_GATEWAY_KEYS!)).toEqual({ [HOME_TAG]: key });
  });

  it('🔴 沒有 iotRealtime、缺家庭、不是 64 位 hex、與 gatewayPubkey 不符都丟例外，訊息不含私鑰', () => {
    const cases: [Parameters<typeof relayWorkerSecrets>[0], RegExp][] = [
      [{ iotGatewayKeys: { [HOME_TAG]: key } }, /iotRealtime/],
      [{ iotGatewayKeys: {}, iotRealtime: realtime() }, /hhhh/],
      [{ iotGatewayKeys: { [HOME_TAG]: 'zz' }, iotRealtime: realtime() }, /64/],
      [{ iotGatewayKeys: { [HOME_TAG]: bytesToHex(generateSecretKey()) }, iotRealtime: realtime() }, /gatewayPubkey/],
      [{ iotGatewayKeys: { [HOME_TAG]: key, ['x'.repeat(22)]: key }, iotRealtime: realtime() }, /xxxx/],
    ];
    for (const [opts, message] of cases) {
      let error: Error | undefined;
      try {
        relayWorkerSecrets(opts);
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).toMatch(message);
      expect(error?.message).not.toContain(key);
    }
  });

  it('有 iotRealtime 卻沒給私鑰：不丟（沿用線上已經有的 secret）', () => {
    expect(relayWorkerSecrets({ iotRealtime: realtime() })).toEqual({});
  });
});

describe('Worker 的 IOT_HOME 綁定與 v2 遷移（SDK ADR 0121）', () => {
  it('🔴 v1 不動，v2 只新增 IotHomeRoom（已發出去的遷移不能改）', () => {
    expect(RELAY_DO_MIGRATIONS).toEqual([
      { tag: 'v1', newSqliteClasses: ['RelayRoom'] },
      { tag: 'v2', newSqliteClasses: ['IotHomeRoom'] },
    ]);
    expect(IOT_HOME_DO_BINDING).toEqual({ name: 'IOT_HOME', className: 'IotHomeRoom' });
  });

  it('已部署 v1 的站只送 v2；新站一次送兩步', () => {
    expect(planMigrations('v1')).toEqual({ payload: { old_tag: 'v1', new_tag: 'v2', steps: [{ new_sqlite_classes: ['IotHomeRoom'] }] }, foreign: false });
    expect(planMigrations(undefined).payload?.steps).toEqual([{ new_sqlite_classes: ['RelayRoom'] }, { new_sqlite_classes: ['IotHomeRoom'] }]);
    expect(planMigrations('v2')).toEqual({ foreign: false });
  });

  it('REST 與 wrangler 都帶 IOT_HOME 綁定（不論有沒有開 C′：沒設 IOT_REALTIME 時整條 /iot/ 回 404）', () => {
    const meta = buildWorkerMetadata({ compatibilityDate: '2026-09-01', vars: {} });
    expect(meta.bindings).toContainEqual({ type: 'durable_object_namespace', name: 'IOT_HOME', class_name: 'IotHomeRoom' });
    const toml = renderWranglerToml({ name: 'r', main: 'entry.mjs', compatibilityDate: '2026-09-01' });
    expect(toml).toContain('[[durable_objects.bindings]]\nname = "IOT_HOME"\nclass_name = "IotHomeRoom"');
    expect(toml).toContain('[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ["IotHomeRoom"]');
  });

  it('入口與打包好的 Worker 都轉出 IotHomeRoom（缺了 Cloudflare 會拒收 v2 遷移）', () => {
    expect(renderApiWorkerEntry('1.0.0')).toMatch(/export \{ default, RelayRoom, IotHomeRoom \}/);
    expect(relayWorkerSource).toMatch(/as IotHomeRoom\b/);
  });
});

describe('Node 主機的閘道私鑰（SDK ADR 0121）', () => {
  const key = bytesToHex(gatewaySecret);
  const fakeSdk = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-sdk-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@cinderous/client', version: '9.9.9', type: 'module', dependencies: {} }));
    mkdirSync(join(dir, 'dist', 'relay'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'relay', 'node.js'), 'export {}');
    return dir;
  };
  const okFetch = (async () => ({ ok: true, status: 200, text: async () => 'ok' })) as unknown as typeof fetch;
  const recorder = () => {
    const calls: { cmd: string; args: string[]; env: Record<string, string | undefined>; input?: string }[] = [];
    const run: CommandRunner = async (cmd, args, env, input) => {
      calls.push({ cmd, args, env, ...(input !== undefined ? { input } : {}) });
      return { code: 0, stdout: cmd === 'fly' && args[1] === 'list' ? '[]' : '', stderr: '' };
    };
    return { run, calls };
  };

  it('docker：compose 從環境代入（沒設就不啟動），私鑰只進 docker compose 的環境、不寫檔', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'deploy-'));
    const { run, calls } = recorder();
    await deployDockerRelay({ workDir, sdkRoot: fakeSdk(), run, fetch: okFetch, healthRetries: 1, healthDelayMs: 0, iotRealtime: realtime(), iotGatewayKeys: { [HOME_TAG]: key } });
    const compose = readFileSync(join(workDir, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('IOT_GATEWAY_KEYS: "${IOT_GATEWAY_KEYS:?');
    expect(compose).toContain('IOT_REALTIME: ');
    expect(compose).not.toContain(key);
    expect(JSON.parse(calls[0]!.env.IOT_GATEWAY_KEYS!)).toEqual({ [HOME_TAG]: key });
  });

  it('fly：不進 fly.toml，以 fly secrets import 從標準輸入上傳（不進參數）', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'deploy-'));
    const { run, calls } = recorder();
    await deployFlyRelay({ workDir, sdkRoot: fakeSdk(), run, fetch: okFetch, healthRetries: 1, healthDelayMs: 0, iotRealtime: realtime(), iotGatewayKeys: { [HOME_TAG]: key } });
    const toml = readFileSync(join(workDir, 'fly.toml'), 'utf8');
    expect(toml).toContain('IOT_REALTIME');
    expect(toml).not.toContain('IOT_GATEWAY_KEYS');
    const imported = calls.find((c) => c.cmd === 'fly' && c.args[0] === 'secrets')!;
    expect(imported.args).toEqual(['secrets', 'import', '--app', 'cinderous-relay', '--stage']);
    expect(imported.input).toBe(`IOT_GATEWAY_KEYS=${JSON.stringify({ [HOME_TAG]: key })}\n`);
    expect(calls.every((c) => !c.args.join(' ').includes(key))).toBe(true);
    // 先上傳私鑰再部署：機器一啟動就有
    expect(calls.indexOf(imported)).toBeLessThan(calls.findIndex((c) => c.args[0] === 'deploy'));
  });

  it('私鑰對不上：一個檔案都不寫、一個指令都不跑', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'deploy-'));
    const { run, calls } = recorder();
    await expect(
      deployDockerRelay({ workDir, sdkRoot: fakeSdk(), run, fetch: okFetch, iotRealtime: realtime(), iotGatewayKeys: { [HOME_TAG]: bytesToHex(generateSecretKey()) } }),
    ).rejects.toThrow(/gatewayPubkey/);
    expect(calls).toEqual([]);
    expect(existsSync(join(workDir, 'docker-compose.yml'))).toBe(false);
  });
});

describe('部署包（設定檔）帶 C′（SDK ADR 0121）', () => {
  const ctx: DeployPackageContext = { sdkVersion: '0.0.0-test', licenseText: 'AGPL\n' };
  const files = (target: DeployConfig['target']) =>
    Object.fromEntries(
      renderDeployPackage({ configVersion: 1, target, ...(target === 'home-tunnel' ? { tunnel: { hostname: 'r.example.com' }, secrets: { tunnelToken: { $env: 'TUNNEL_TOKEN' } } } : {}), site: { iotRealtime: realtime() } }, ctx).files.map((f) => [f.path, f.content]),
    );

  it('compose：IOT_REALTIME 寫進去、閘道私鑰從 .env 代入（沒設不啟動）；.env.example 列出它', () => {
    for (const target of ['docker', 'home-tunnel'] as const) {
      const f = files(target);
      expect(f['docker-compose.yml']).toContain('IOT_REALTIME: ');
      expect(f['docker-compose.yml']).toContain('IOT_GATEWAY_KEYS: "${IOT_GATEWAY_KEYS:?set IOT_GATEWAY_KEYS in .env');
      expect(f['.env.example']).toMatch(/^IOT_GATEWAY_KEYS=$/m);
    }
  });

  it('fly：fly.toml 不含閘道私鑰的變數（以 fly secrets set 設定）', () => {
    const f = files('fly');
    expect(f['fly.toml']).toContain('IOT_REALTIME');
    expect(f['fly.toml']).not.toContain('IOT_GATEWAY_KEYS');
    expect(f['.env.example']).toMatch(/^IOT_GATEWAY_KEYS=$/m);
  });

  it('Workers：.dev.vars.example 有 IOT_GATEWAY_KEYS；自帶 Worker 的入口轉出 IotHomeRoom', () => {
    expect(files('cloudflare')['.dev.vars.example']).toMatch(/^IOT_GATEWAY_KEYS=$/m);
    const self = renderDeployPackage({ configVersion: 1, target: 'cloudflare', site: {} }, { ...ctx, selfContained: true, relayWorkerSource: 'export default {}' });
    expect(self.files.find((x) => x.path === 'src/entry.mjs')!.content).toContain('export { default, RelayRoom, IotHomeRoom }');
  });

  it('cloudflare-api：閘道私鑰從環境讀出、壞 JSON 只報變數名稱', () => {
    const config: DeployConfig = { configVersion: 1, target: 'cloudflare-api', site: { iotRealtime: realtime() } };
    const key = bytesToHex(gatewaySecret);
    const env = { CLOUDFLARE_API_TOKEN: 't', IOT_GATEWAY_KEYS: JSON.stringify({ [HOME_TAG]: key }) };
    expect(cloudflareApiOptionsFromConfig(config, env).iotGatewayKeys).toEqual({ [HOME_TAG]: key });
    expect(() => cloudflareApiOptionsFromConfig(config, { ...env, IOT_GATEWAY_KEYS: `[${key}]` })).toThrow(/IOT_GATEWAY_KEYS/);
    expect(() => cloudflareApiOptionsFromConfig(config, { ...env, IOT_GATEWAY_KEYS: `[${key}]` })).not.toThrow(new RegExp(key));
  });
});
