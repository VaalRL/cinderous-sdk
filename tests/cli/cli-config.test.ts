// 設定檔驅動的命令列（SDK ADR 0050）：`relay deploy --config`、`relay build`、`config validate|schema`。
// 🔴 差異測試：同一組選擇走旗標路徑與走設定檔路徑，交給部署函式的參數逐項相同。
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type CliDeps, parseDotEnv, runCli } from '../../src/cli/commands.js';
import type { CloudflareDeployOptions } from '../../src/deploy/cloudflare.js';
import type { CloudflareApiDeployOptions } from '../../src/deploy/cloudflare-api/index.js';
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

  it('cloudflare-api：交給 REST 部署，Token 與 TURN 的 Token 從 .env 讀（SDK ADR 0118）', async () => {
    const config = {
      configVersion: 1,
      target: 'cloudflare-api',
      name: 'my-relay',
      site: { allowedPubkeys: [alice], turnKeyId: 'k1' },
      cloudflare: { accountId: '0123456789abcdef0123456789abcdef' },
    };
    const api: CloudflareApiDeployOptions[] = [];
    const h = harness(
      { ...configFile(config, 'pkg/cinderous.config.json'), [resolve(CWD, 'pkg/.env')]: 'CLOUDFLARE_API_TOKEN=cf-tok\nTURN_API_TOKEN=turn-tok\n' },
      {
        deployCloudflareRelayViaApi: async (o) => {
          api.push(o);
          o.onProgress?.({ step: 'deploy', substep: 'upload', message: '上傳', messages: { 'zh-TW': '上傳', en: 'Uploading' } });
          return { workerName: 'my-relay', accountId: 'acc1', subdomain: 'me', httpUrl: 'https://my-relay.me.workers.dev', relayEndpoint: 'wss://my-relay.me.workers.dev', migrationsApplied: true };
        },
      },
    );
    expect(await runCli(['relay', 'deploy', '-c', 'pkg/cinderous.config.json'], h.deps)).toBe(0);
    expect(api).toHaveLength(1);
    expect(api[0]).toMatchObject({ apiToken: 'cf-tok', accountId: '0123456789abcdef0123456789abcdef', workerName: 'my-relay', turnKeyId: 'k1', turnApiToken: 'turn-tok', allowedPubkeys: [alice] });
    expect(h.cloudflare).toHaveLength(0);
    expect(h.out).toContain('[deploy] 上傳');
    expect(h.written[join(CWD, '.env.cinderous')]).toBe('CINDEROUS_RELAY_URL=wss://my-relay.me.workers.dev\n');
    // 🔴 秘密不出現在任何輸出
    expect([...h.out, ...h.err].join('\n')).not.toMatch(/cf-tok|turn-tok/);
  });

  it('cloudflare-api：沒有 Token → 回 1、說變數名稱；--dry-run → 用法錯誤（REST 沒有試打包）；環境不支援 → 回 1', async () => {
    const config = { configVersion: 1, target: 'cloudflare-api' };
    const viaApi = async () => {
      throw new Error('不該被呼叫');
    };
    const missing = harness(configFile(config), { deployCloudflareRelayViaApi: viaApi });
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], missing.deps)).toBe(1);
    expect(missing.err.join('\n')).toContain('CLOUDFLARE_API_TOKEN');

    const dry = harness(configFile(config), { env: { CLOUDFLARE_API_TOKEN: 't' }, deployCloudflareRelayViaApi: viaApi });
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json', '--dry-run'], dry.deps)).toBe(2);
    expect(dry.err.join('\n')).toContain('relay build');

    const unsupported = harness(configFile(config), { env: { CLOUDFLARE_API_TOKEN: 't' } });
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], unsupported.deps)).toBe(1);
    expect(unsupported.err.join('\n')).toContain('cloudflare-api');
  });

  it('cloudflare（wrangler）：TURN 的 Token 也從環境帶給部署函式', async () => {
    const config = { configVersion: 1, target: 'cloudflare', site: { turnKeyId: 'k1' }, secrets: { turnApiToken: { $env: 'MY_TURN' } } };
    const h = harness(configFile(config), { env: { MY_TURN: 'turn-tok' } });
    expect(await runCli(['relay', 'deploy', '--config', 'cinderous.config.json'], h.deps)).toBe(0);
    expect(h.cloudflare[0]).toMatchObject({ turnKeyId: 'k1', turnApiToken: 'turn-tok' });
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
    expect(await runCli(['config', 'upgrade'], harness().deps)).toBe(2);
  });
});

describe('init 精靈（SDK ADR 0117）', () => {
  /** 依欄位回答（問題開頭是欄位路徑）；危險選項的確認題另外排隊 */
  const prompter = (answers: Record<string, string[]>, confirms: string[] = []) => async (question: string) => {
    if (question.startsWith('要開的話')) return confirms.shift() ?? '';
    return answers[question.split('（')[0]!]?.shift() ?? '';
  };
  const OUT = resolve(CWD, 'cinderous.config.json');

  it('問完寫出設定檔（固定鍵順序、記下 SDK 版號），提示下一步', async () => {
    const h = harness({}, { prompt: prompter({ target: ['docker'], 'site.allowedPubkeys': [alice] }) });
    expect(await runCli(['init'], h.deps)).toBe(0);
    expect(JSON.parse(h.written[OUT]!)).toEqual({ configVersion: 1, sdk: '0.38.0', target: 'docker', site: { allowedPubkeys: [alice] } });
    expect(h.out.at(-1)).toContain('relay build --config');
    // 寫出的檔案本身就通過 config validate
    const v = harness({ [OUT]: h.written[OUT]! });
    expect(await runCli(['config', 'validate'], v.deps)).toBe(0);
  });

  it('🔴 危險選項打錯確認字＝不開，也不會寫進設定檔', async () => {
    const h = harness({}, { prompt: prompter({ 'site.allowedPubkeys': [alice], 'site.openFileRelay': ['y'] }, ['y']) });
    expect(await runCli(['init', '-p', 'cloudflare', '-o', 'x.json'], h.deps)).toBe(0);
    expect(JSON.parse(h.written[resolve(CWD, 'x.json')]!).site).toEqual({ allowedPubkeys: [alice] });
  });

  it('--yes：不詢問、全部預設；開放中繼的提醒印在 stderr', async () => {
    const h = harness();
    expect(await runCli(['init', '--yes', '--provider', 'fly'], h.deps)).toBe(0);
    expect(JSON.parse(h.written[OUT]!)).toEqual({ configVersion: 1, sdk: '0.38.0', target: 'fly' });
    expect(h.err.some((line) => line.startsWith('⚠ site.allowedPubkeys'))).toBe(true);
  });

  it('--yes 沒有 --provider、不認得的目標或語言：用法錯誤', async () => {
    expect(await runCli(['init', '--yes'], harness().deps)).toBe(2);
    expect(await runCli(['init', '--yes', '-p', 'heroku'], harness().deps)).toBe(2);
    expect(await runCli(['init', '--yes', '-p', 'fly', '--locale', 'ja'], harness().deps)).toBe(2);
  });

  it('設定檔已經存在：不覆寫（--force 才覆寫）', async () => {
    const existing = configFile({ configVersion: 1, target: 'docker' });
    const h = harness(existing);
    expect(await runCli(['init', '--yes', '-p', 'fly'], h.deps)).toBe(1);
    expect(h.written).toEqual({});
    const forced = harness(existing);
    expect(await runCli(['init', '--yes', '-p', 'fly', '--force'], forced.deps)).toBe(0);
    expect(JSON.parse(forced.written[OUT]!).target).toBe('fly');
  });

  it('必填題（home-tunnel 的 tunnel.hostname）在 --yes 下答不出來：停止、不寫檔', async () => {
    const h = harness();
    expect(await runCli(['init', '--yes', '-p', 'home-tunnel'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('tunnel.hostname');
    expect(h.written).toEqual({});
  });

  it('不能互動的環境（沒有 prompt）又沒加 --yes：說明怎麼做', async () => {
    const h = harness();
    expect(await runCli(['init', '-p', 'fly'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('--yes');
  });

  it('英文：訊息是英文', async () => {
    const h = harness();
    expect(await runCli(['init', '--yes', '-p', 'fly', '--locale', 'en'], h.deps)).toBe(0);
    expect(h.out[0]).toMatch(/^Creating cinderous\.config\.json/);
    expect(h.out.at(-1)).toMatch(/^Next: /);
  });
});

describe('parseDotEnv', () => {
  it('KEY=VALUE、註解、export、成對引號', () => {
    expect(parseDotEnv('# c\nA=1\nexport B = "two words"\nC=\'x\'\n bad line\nD=\n')).toEqual({ A: '1', B: 'two words', C: 'x', D: '' });
  });
});

describe('config migrate（SDK ADR 0118）', () => {
  const path = resolve(CWD, 'cinderous.config.json');

  it('舊版 SDK 的設定：sdk 換成這一版、列出中間影響部署的變更、用固定的鍵順序寫回', async () => {
    const h = harness(configFile({ target: 'docker', sdk: '0.33.0', configVersion: 1 }));
    expect(await runCli(['config', 'migrate'], h.deps)).toBe(0);
    expect(h.written[path]).toBe('{\n  "configVersion": 1,\n  "sdk": "0.38.0",\n  "target": "docker"\n}\n');
    const text = h.out.join('\n');
    expect(text).toContain('0.33.0');
    expect(text).toContain('v0.34.0');
    expect(text).toContain('v0.38.0');
    expect(text).not.toContain('v0.31.0');
  });

  it('--dry-run：只印出結果，不寫檔', async () => {
    const h = harness(configFile({ configVersion: 1, target: 'docker', sdk: '0.33.0' }, 'x.json'));
    expect(await runCli(['config', 'migrate', 'x.json', '--dry-run'], h.deps)).toBe(0);
    expect(h.written).toEqual({});
    expect(h.out.join('\n')).toContain('"sdk": "0.38.0"');
  });

  it('已經是這一版：不寫檔', async () => {
    const h = harness(configFile({ configVersion: 1, target: 'docker', sdk: '0.38.0' }));
    expect(await runCli(['config', 'migrate'], h.deps)).toBe(0);
    expect(h.written).toEqual({});
    expect(h.out.join('\n')).toContain('不需要遷移');
  });

  it('🔴 較新的 SDK 產生的、或遷移後還有錯：回 1、不寫檔', async () => {
    const newer = harness(configFile({ configVersion: 1, target: 'docker', sdk: '9.0.0' }));
    expect(await runCli(['config', 'migrate'], newer.deps)).toBe(1);
    expect(newer.written).toEqual({});
    expect(newer.err.join('\n')).toContain('較新的 SDK');
    const bad = harness(configFile({ configVersion: 1, target: 'docker', sdk: '0.33.0', node: { prot: 1 } }));
    expect(await runCli(['config', 'migrate'], bad.deps)).toBe(1);
    expect(bad.written).toEqual({});
    expect(bad.err.join('\n')).toContain('node.prot');
  });

  it('用法：只吃一個檔；不知道 SDK 版號的環境 → 回 1', async () => {
    expect(await runCli(['config', 'migrate', 'a.json', 'b.json'], harness().deps)).toBe(2);
    const h = harness(configFile({ configVersion: 1, target: 'docker' }));
    delete h.deps.sdkVersion;
    expect(await runCli(['config', 'migrate'], h.deps)).toBe(1);
  });
});
