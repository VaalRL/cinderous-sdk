// 設定檔驅動的命令列（SDK ADR 0050）：`relay deploy --config`、`relay build`、`config validate|schema`。
// 🔴 差異測試：同一組選擇走旗標路徑與走設定檔路徑，交給部署函式的參數逐項相同。
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type CliDeps, parseDotEnv, runCli } from '../../src/cli/commands.js';
import type { CloudflareDeployOptions } from '../../src/deploy/cloudflare.js';
import type { DockerDeployOptions } from '../../src/deploy/docker.js';
import type { FlyDeployOptions } from '../../src/deploy/fly.js';
import type { BuildRelayPackageOptions } from '../../src/deploy/build.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/index.js';

const alice = getPublicKey(generateSecretKey());
const bob = npubEncode(getPublicKey(generateSecretKey()));
const CWD = resolve('/work');

function harness(files: Record<string, string> = {}, overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const cloudflare: CloudflareDeployOptions[] = [];
  const docker: DockerDeployOptions[] = [];
  const fly: FlyDeployOptions[] = [];
  const builds: BuildRelayPackageOptions[] = [];
  const deps: CliDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: {},
    cwd: CWD,
    startNodeRelay: () => ({ close() {} }),
    deployCloudflareRelay: async (o) => {
      cloudflare.push(o);
      return { workerName: o.workerName ?? 'cinderous-relay', configPath: 'w', httpUrl: 'https://r.me.workers.dev', relayEndpoint: 'wss://r.me.workers.dev' };
    },
    deployDockerRelay: async (o) => {
      docker.push(o);
      return { name: 'r', configPath: 'c', httpUrl: 'http://localhost:8080', relayEndpoint: o.tunnel ? `wss://${o.tunnel.hostname}` : 'ws://localhost:8080' };
    },
    deployFlyRelay: async (o) => {
      fly.push(o);
      return { name: 'r', configPath: 'f', httpUrl: 'https://r.fly.dev', relayEndpoint: 'wss://r.fly.dev' };
    },
    writeFile: (path, content) => {
      written[path] = content;
    },
    readFile: (path) => files[resolve(path)],
    buildRelayPackage: async (o) => {
      builds.push(o);
      return { outDir: o.outDir, files: ['cinderous.config.json', 'README-DEPLOY.md'], removed: [], copiedSdk: true, warnings: [] };
    },
    sdkVersion: '0.38.0',
    ...overrides,
  };
  return { deps, out, err, written, cloudflare, docker, fly, builds };
}

const configFile = (config: unknown, name = 'cinderous.config.json') => ({ [resolve(CWD, name)]: JSON.stringify(config) });
/** 部署選項去掉函式（onProgress）再比較 */
const plain = (o: object) => JSON.parse(JSON.stringify(o)) as unknown;

describe('🔴 差異測試：旗標路徑＝設定檔路徑（SDK ADR 0050 P0）', () => {
  const cases: { label: string; flags: string[]; config: Record<string, unknown>; env?: Record<string, string> }[] = [
    {
      label: 'cloudflare：站台參數全套＋環境變數的 Token 與帳號',
      flags: [
        '--name', 'my-relay', '-k', `${alice},${bob}`, '--max-file-mb', '17', '--relay-name', 'Mine', '--relay-description', 'd',
        '--relay-contact', 'mailto:a@example.com', '--relay-software-url', 'https://git.example.com/fork', '--max-ttl-days', '14',
        '--max-connections-per-pubkey', '9', '--max-messages-per-second-per-ip', '99', '--app-lanes', 'dochost,cindersync',
        '--file-lanes', 'cindersync', '--app-lane-pow', '0', '--developer-docs-url', 'https://example.com/dev', '--compatibility-date', '2026-09-15',
      ],
      config: {
        configVersion: 1,
        target: 'cloudflare',
        name: 'my-relay',
        site: {
          allowedPubkeys: [alice, bob],
          maxFileMb: 17,
          relayName: 'Mine',
          relayDescription: 'd',
          relayContact: 'mailto:a@example.com',
          relaySoftwareUrl: 'https://git.example.com/fork',
          maxTtlDays: 14,
          maxConnectionsPerPubkey: 9,
          maxMessagesPerSecondPerIp: 99,
          appLanes: ['dochost', 'cindersync'],
          fileLanes: ['cindersync'],
          appLanePow: 0,
          developerDocsUrl: 'https://example.com/dev',
        },
        cloudflare: { compatibilityDate: '2026-09-15' },
      },
      env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' },
    },
    {
      label: 'docker：埠、保存、開放中繼收檔案塊',
      flags: ['--provider', 'docker', '--name', 'home', '--port', '9000', '--persist', '--max-file-mb', '17', '--open-file-relay'],
      config: { configVersion: 1, target: 'docker', name: 'home', site: { maxFileMb: 17, openFileRelay: true }, node: { port: 9000, persist: true } },
    },
    {
      label: 'fly：區域與 FLY_API_TOKEN',
      flags: ['--provider', 'fly', '--region', 'sin', '-k', alice, '--persist'],
      config: { configVersion: 1, target: 'fly', site: { allowedPubkeys: [alice] }, node: { persist: true }, fly: { region: 'sin' } },
      env: { FLY_API_TOKEN: 'fly-tok' },
    },
    { label: '什麼都不給（開放中繼的 cloudflare）', flags: [], config: { configVersion: 1, target: 'cloudflare' } },
  ];

  for (const c of cases) {
    it(c.label, async () => {
      const viaFlags = harness({}, { env: c.env ?? {} });
      expect(await runCli(['relay', 'deploy', ...c.flags], viaFlags.deps)).toBe(0);
      const viaConfig = harness(configFile(c.config), { env: c.env ?? {} });
      expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], viaConfig.deps)).toBe(0);
      expect(plain([viaConfig.cloudflare, viaConfig.docker, viaConfig.fly])).toEqual(plain([viaFlags.cloudflare, viaFlags.docker, viaFlags.fly]));
      expect(viaFlags.cloudflare.length + viaFlags.docker.length + viaFlags.fly.length).toBe(1);
      expect(viaConfig.written).toEqual(viaFlags.written);
    });
  }
});

describe('relay deploy --config', () => {
  it('秘密以 $env 引用：從環境讀；設定檔旁邊的 .env 也讀（環境變數優先）', async () => {
    const config = { configVersion: 1, target: 'cloudflare', site: { allowedPubkeys: [alice] }, secrets: { cloudflareApiToken: { $env: 'MY_CF' } }, cloudflare: { accountId: { $env: 'MY_ACC' } } };
    const h = harness({ ...configFile(config, 'pkg/cinderous.config.json'), [resolve(CWD, 'pkg/.env')]: '# x\nMY_CF="from-dotenv"\nMY_ACC=acc-dotenv\n' }, { env: { MY_ACC: 'acc-env' } });
    expect(await runCli(['relay', 'deploy', '-c', 'pkg/cinderous.config.json'], h.deps)).toBe(0);
    expect(h.cloudflare[0]).toMatchObject({ apiToken: 'from-dotenv', accountId: 'acc-env' });
  });

  it('home-tunnel：交給 docker 部署，帶 Tunnel 主機名稱與 Token（只在記憶體裡）', async () => {
    const config = {
      configVersion: 1,
      target: 'home-tunnel',
      name: 'home',
      site: { allowedPubkeys: [alice] },
      tunnel: { hostname: 'relay.example.com' },
      secrets: { tunnelToken: { $env: 'TUNNEL_TOKEN' } },
    };
    const h = harness(configFile(config), { env: { TUNNEL_TOKEN: 'tt' } });
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], h.deps)).toBe(0);
    expect(h.docker[0]).toMatchObject({ name: 'home', tunnel: { hostname: 'relay.example.com', tokenEnv: 'TUNNEL_TOKEN', token: 'tt' } });
    expect(h.written[join(CWD, '.env.cinderous')]).toBe('CINDEROUS_RELAY_URL=wss://relay.example.com\n');

    // 沒有 Token：不起任何容器（--dry-run 只產生設定，可以沒有）
    const missing = harness(configFile(config));
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], missing.deps)).toBe(1);
    expect(missing.err.join('\n')).toContain('TUNNEL_TOKEN');
    expect(missing.docker).toHaveLength(0);
    const dry = harness(configFile(config));
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json', '--dry-run'], dry.deps)).toBe(0);
  });

  it('設定檔有錯：一次列出全部、不部署、回傳 1', async () => {
    const h = harness(configFile({ configVersion: 1, target: 'docker', site: { appLanes: ['x'], maxTtlDays: 0 }, node: { prot: 1 } }));
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], h.deps)).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('node.prot');
    expect(text).toContain('site.appLanes');
    expect(text).toContain('site.maxTtlDays');
    expect(h.docker).toHaveLength(0);
  });

  it('設定檔不存在／不是 JSON → 回傳 1', async () => {
    expect(await runCli(['relay', 'deploy', '--config', 'nope.json'], harness().deps)).toBe(1);
    const h = harness({ [resolve(CWD, 'bad.json')]: '{ nope' });
    expect(await runCli(['relay', 'deploy', '--config', 'bad.json'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('不是合法的 JSON');
  });

  it('🔴 --config 不能和站台旗標一起用（設定只能在一個地方）；--dry-run、--output-env 可以', async () => {
    const h = harness(configFile({ configVersion: 1, target: 'docker' }));
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json', '--max-ttl-days', '3'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('--max-ttl-days');
    const ok = harness(configFile({ configVersion: 1, target: 'docker' }));
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json', '--dry-run', '-o', 'x.env'], ok.deps)).toBe(0);
    expect(ok.docker[0]).toMatchObject({ dryRun: true });
  });

  it('cloudflare-api 目標在 P1 才接上 → 用法錯誤，說明替代做法', async () => {
    const h = harness(configFile({ configVersion: 1, target: 'cloudflare-api' }));
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('P1');
  });

  it('設定檔由較新的 SDK 產生 → 拒絕', async () => {
    const h = harness(configFile({ configVersion: 1, target: 'docker', sdk: '9.0.0' }));
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('較新的 SDK');
  });
});

describe('旗標路徑的新規則（ADR 0050 §3）', () => {
  it('🔴 cloudflare 給 --persist／--port：設了卻不生效 → 用法錯誤（原本默默忽略）', async () => {
    for (const flags of [['--persist'], ['--port', '9000']]) {
      const h = harness();
      expect(await runCli(['relay', 'deploy', ...flags], h.deps)).toBe(2);
      expect(h.cloudflare).toHaveLength(0);
    }
  });

  it('--relay-software-url 交給部署函式', async () => {
    const h = harness();
    expect(await runCli(['relay', 'deploy', '--provider', 'docker', '--relay-software-url', 'https://git.example.com/fork'], h.deps)).toBe(0);
    expect(h.docker[0]).toMatchObject({ relaySoftwareUrl: 'https://git.example.com/fork' });
  });
});

describe('relay build', () => {
  it('預設讀 cinderous.config.json、輸出到它所在的資料夾；旗標交給 buildRelayPackage', async () => {
    const h = harness(configFile({ configVersion: 1, target: 'docker' }, 'deploy/cinderous.config.json'));
    expect(await runCli(['relay', 'build', '-c', 'deploy/cinderous.config.json', '--sdk-spec', 'github:x/y#v1', '--force'], h.deps)).toBe(0);
    expect(h.builds[0]).toMatchObject({ outDir: resolve(CWD, 'deploy'), configPath: resolve(CWD, 'deploy/cinderous.config.json'), sdkSpec: 'github:x/y#v1', force: true });
    expect(h.out.join('\n')).toContain('README-DEPLOY.md');
  });

  it('--out 與 --self-contained', async () => {
    const h = harness(configFile({ configVersion: 1, target: 'cloudflare' }));
    expect(await runCli(['relay', 'build', '--out', 'pkg', '--self-contained'], h.deps)).toBe(0);
    expect(h.builds[0]).toMatchObject({ outDir: resolve(CWD, 'pkg'), selfContained: true });
  });

  it('產生失敗（設定有錯、檔案被手改過）→ 印出原因、回傳 1', async () => {
    const h = harness(configFile({ configVersion: 1, target: 'docker' }), {
      buildRelayPackage: async () => {
        throw new Error('有被手改過的檔案：docker-compose.yml');
      },
    });
    expect(await runCli(['relay', 'build'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('docker-compose.yml');
  });
});

describe('config validate／schema', () => {
  it('沒問題 → 0；有提醒 → 0 並印出；有錯 → 1 並列出全部', async () => {
    const ok = harness(configFile({ configVersion: 1, target: 'docker', site: { allowedPubkeys: [alice] } }));
    expect(await runCli(['config', 'validate'], ok.deps)).toBe(0);
    expect(ok.out.join('\n')).toContain('沒有問題');
    const warn = harness(configFile({ configVersion: 1, target: 'docker' }, 'x.json'));
    expect(await runCli(['config', 'validate', 'x.json'], warn.deps)).toBe(0);
    expect(warn.err.join('\n')).toContain('⚠');
    const bad = harness(configFile({ configVersion: 1, target: 'fly', site: { appLanes: ['a'] }, secrets: { flyApiToken: 'FlyV1 fm2_abcdefghijklmnopqrstuvwxyz' } }));
    expect(await runCli(['config', 'validate', '--config', 'cinderous.config.json'], bad.deps)).toBe(1);
    expect(bad.err.join('\n')).toContain('✖ site.appLanes');
    expect(bad.err.join('\n')).toContain('✖ secrets.flyApiToken');
  });

  it('config schema 印出 JSON Schema；不認得的子指令 → 2', async () => {
    const h = harness();
    expect(await runCli(['config', 'schema'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join('\n'))).toHaveProperty('properties.site');
    expect(await runCli(['config', 'migrate'], harness().deps)).toBe(2);
  });
});

describe('parseDotEnv', () => {
  it('KEY=VALUE、註解、export、成對引號', () => {
    expect(parseDotEnv('# c\nA=1\nexport B = "two words"\nC=\'x\'\n bad line\nD=\n')).toEqual({ A: '1', B: 'two words', C: 'x', D: '' });
  });
});
