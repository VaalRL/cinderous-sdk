// `cinderous` 命令列（PRD 5.2、5.3、5.4；SDK ADR 0008）。
// 起中繼、部署、寫檔都換成替身：測的是「旗標怎麼解讀、交給誰、輸出什麼」。
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type CliDeps, parseEstimateArgs, parseRelayStartArgs, runCli } from '../../src/cli/commands.js';
import type { CloudflareDeployOptions } from '../../src/deploy/cloudflare.js';
import type { DockerDeployOptions } from '../../src/deploy/docker.js';
import type { FlyDeployOptions } from '../../src/deploy/fly.js';
import type { NodeRelayEnv, NodeRelayOptions } from '../../src/relay/node-relay.js';

function harness(overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, string> = {};
  const started: { env: NodeRelayEnv; options: NodeRelayOptions }[] = [];
  const deployed: CloudflareDeployOptions[] = [];
  const docker: DockerDeployOptions[] = [];
  const fly: FlyDeployOptions[] = [];
  const deps: CliDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: {},
    cwd: '/work',
    startNodeRelay: (env, options) => {
      started.push({ env, options: options ?? {} });
      return { close() {} };
    },
    deployDockerRelay: async (options) => {
      docker.push(options);
      return { name: options.name ?? 'cinderous-relay', configPath: '/x/docker-compose.yml', httpUrl: 'http://localhost:8080', relayEndpoint: 'ws://localhost:8080' };
    },
    deployFlyRelay: async (options) => {
      fly.push(options);
      return { name: options.name ?? 'cinderous-relay', configPath: '/x/fly.toml', httpUrl: 'https://r.fly.dev', relayEndpoint: 'wss://r.fly.dev' };
    },
    deployCloudflareRelay: async (options) => {
      deployed.push(options);
      return { workerName: options.workerName ?? 'cinderous-relay', configPath: '/x/wrangler.toml', httpUrl: 'https://r.me.workers.dev', relayEndpoint: 'wss://r.me.workers.dev' };
    },
    writeFile: (path, content) => {
      files[path] = content;
    },
    ...overrides,
  };
  return { deps, out, err, files, started, deployed, docker, fly };
}

describe('parseEstimateArgs', () => {
  it('PRD 5.4.3 的範例旗標', () => {
    const input = parseEstimateArgs(['--mode=double-ratchet', '--pq=true', '--devices=5', '--collaborators=15', '--daily-actions=500', '--payload-kb=20']);
    expect(input).toMatchObject({
      cryptoMode: 'double-ratchet',
      postQuantum: true,
      devicesCount: 5,
      collaboratorsCount: 15,
      dailyActionsCount: 500,
      averagePayloadBytes: 20_000,
    });
  });

  it('什麼都不給 → PRD 的預設情境（Cinder EK、3 台、1:1、每日 300 次、15 KB）', () => {
    expect(parseEstimateArgs([])).toMatchObject({
      cryptoMode: 'cinder-ek',
      postQuantum: false,
      devicesCount: 3,
      collaboratorsCount: 1,
      dailyActionsCount: 300,
      averagePayloadBytes: 15_000,
    });
  });

  it('壞值直接報錯，不默默換成預設（試算結果會悄悄變成另一個情境）', () => {
    expect(() => parseEstimateArgs(['--mode=signal'])).toThrow(/--mode/);
    expect(() => parseEstimateArgs(['--devices=0'])).toThrow(/--devices/);
    expect(() => parseEstimateArgs(['--p2p-rate=1.5'])).toThrow(/--p2p-rate/);
  });
});

describe('parseRelayStartArgs', () => {
  it('預設純記憶體、8787 埠；旗標換成主機看得懂的環境變數', () => {
    const { env, options } = parseRelayStartArgs(['--port', '9000', '--allowed-pubkeys', 'npub1a,npub1b', '--no-auth', '--name', '我的站'], {});
    expect(options.memory).toBe(true);
    expect(env).toMatchObject({ PORT: '9000', ALLOWED_PUBKEYS: 'npub1a,npub1b', REQUIRE_AUTH: '0', RELAY_NAME: '我的站' });
  });

  it('--persist → 寫 SQLite（預設 cinderous-relay.db，可用 --db-path 換）', () => {
    expect(parseRelayStartArgs(['--persist'], {})).toMatchObject({ options: { memory: false }, env: { DB_PATH: 'cinderous-relay.db' } });
    expect(parseRelayStartArgs(['--persist', '--db-path', '/data/r.db'], {}).env.DB_PATH).toBe('/data/r.db');
  });

  it('--host → HOST（只聽這個位址，SDK ADR 0119）；沒給就不設（照舊聽所有位址）', () => {
    expect(parseRelayStartArgs(['--host', '127.0.0.1'], {}).env.HOST).toBe('127.0.0.1');
    expect(parseRelayStartArgs([], {}).env.HOST).toBeUndefined();
    expect(parseRelayStartArgs([], { HOST: '::1' }).env.HOST).toBe('::1');
  });

  it('沒給的旗標沿用既有環境變數（Docker 以 -e 設定的照樣生效）', () => {
    expect(parseRelayStartArgs([], { ALLOWED_PUBKEYS: 'npub1x', PORT: '8080' }).env).toMatchObject({ ALLOWED_PUBKEYS: 'npub1x', PORT: '8080' });
  });
});

describe('runCli', () => {
  it('estimate：印出報告，回傳 0', async () => {
    const h = harness();
    expect(await runCli(['estimate', '--collaborators=15', '--mode=double-ratchet'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('扇出乘數');
  });

  it('estimate --json：輸出可解析的 JSON', async () => {
    const h = harness();
    await runCli(['estimate', '--json'], h.deps);
    expect(JSON.parse(h.out.join('\n'))).toHaveProperty('crypto.fanoutMultiplier');
  });

  it('relay start：交給 Node 主機', async () => {
    const h = harness();
    expect(await runCli(['relay', 'start', '--port', '9001'], h.deps)).toBe(0);
    expect(h.started[0]).toMatchObject({ env: { PORT: '9001' }, options: { memory: true } });
  });

  it('relay deploy：旗標交給部署 API、端點寫進 .env.cinderous', async () => {
    const h = harness({ env: { CLOUDFLARE_API_TOKEN: 'from-env' } });
    const code = await runCli(['relay', 'deploy', '--name', 'my-private-sync', '-k', 'npub1a, npub1b', '--account-id', 'acc'], h.deps);
    expect(code).toBe(0);
    expect(h.deployed[0]).toMatchObject({
      workerName: 'my-private-sync',
      allowedPubkeys: ['npub1a', 'npub1b'],
      apiToken: 'from-env', // 旗標沒給就讀環境變數
      accountId: 'acc',
    });
    expect(h.files[join('/work', '.env.cinderous')]).toBe('CINDEROUS_RELAY_URL=wss://r.me.workers.dev\n');
    expect(h.out.join('\n')).toContain('wss://r.me.workers.dev');
  });

  it('🔴 relay deploy 沒給白名單 → 警告這會是開放中繼（PRD 5.3「開放前警示」）', async () => {
    const h = harness();
    await runCli(['relay', 'deploy'], h.deps);
    expect(h.err.join('\n')).toMatch(/開放中繼/);
  });

  it('relay deploy --provider=heroku → 不支援，列出支援的選項並回傳非 0', async () => {
    const h = harness();
    expect(await runCli(['relay', 'deploy', '--provider=heroku'], h.deps)).not.toBe(0);
    expect(h.err.join('\n')).toMatch(/cloudflare.*docker.*fly/);
    expect(h.deployed).toHaveLength(0);
  });

  it('relay deploy --provider=docker：埠、保存、白名單交給 Docker 部署；端點寫進 .env.cinderous', async () => {
    const h = harness();
    const code = await runCli(['relay', 'deploy', '--provider=docker', '--name', 'home', '--port', '9000', '--persist', '-k', 'npub1a'], h.deps);
    expect(code).toBe(0);
    expect(h.docker[0]).toMatchObject({ name: 'home', port: 9000, persist: true, allowedPubkeys: ['npub1a'] });
    expect(h.files[join('/work', '.env.cinderous')]).toBe('CINDEROUS_RELAY_URL=ws://localhost:8080\n');
    expect(h.deployed).toHaveLength(0);
  });

  it('relay deploy --provider=fly：區域與 token（沒給就讀 FLY_API_TOKEN）交給 Fly 部署', async () => {
    const h = harness({ env: { FLY_API_TOKEN: 'fly-env' } });
    expect(await runCli(['relay', 'deploy', '--provider=fly', '--region', 'sin', '-k', 'npub1a'], h.deps)).toBe(0);
    expect(h.fly[0]).toMatchObject({ region: 'sin', apiToken: 'fly-env', allowedPubkeys: ['npub1a'] });
  });

  it('--port 只能是正整數', async () => {
    const h = harness();
    expect(await runCli(['relay', 'deploy', '--provider=docker', '--port', 'abc'], h.deps)).toBe(2);
  });

  it('部署失敗 → 印出原因、回傳非 0', async () => {
    const h = harness({
      deployCloudflareRelay: async () => {
        throw new Error('wrangler 部署失敗：Authentication error');
      },
    });
    expect(await runCli(['relay', 'deploy', '-k', 'npub1a'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('Authentication error');
  });

  it('不認得的指令或旗標 → 印用法、回傳 2', async () => {
    const h = harness();
    expect(await runCli(['launch'], h.deps)).toBe(2);
    expect(await runCli(['estimate', '--bogus'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('cinderous');
  });

  it('help／沒有參數 → 印用法、回傳 0', async () => {
    const h = harness();
    expect(await runCli([], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('relay deploy');
  });
});

describe('PRD 3.3 的預設值（SDK ADR 0013）', () => {
  it('relay start 預設每把公鑰 5 條連線、每 IP 每秒 20 則；環境變數有設就沿用', () => {
    expect(parseRelayStartArgs([], {}).env).toMatchObject({ MAX_CONNECTIONS_PER_PUBKEY: '5', MAX_MESSAGES_PER_SECOND_PER_IP: '20' });
    expect(parseRelayStartArgs([], { MAX_CONNECTIONS_PER_PUBKEY: '9' }).env.MAX_CONNECTIONS_PER_PUBKEY).toBe('9');
  });
});

describe('relay deploy 的站台參數（SDK ADR 0036、0037）', () => {
  it('--app-lanes 等旗標交給部署 API（名稱與 RelaySiteOptions 相同）', async () => {
    const h = harness();
    const code = await runCli(
      [
        'relay', 'deploy',
        '--app-lanes', 'dochost, cindersync',
        '--file-lanes', 'cindersync',
        '--max-file-mb', '30',
        '--relay-name', 'My relay',
        '--relay-description', 'desc',
        '--relay-contact', 'mailto:me@example.com',
        '--max-ttl-days', '14',
        '--max-connections-per-pubkey', '10',
        '--max-messages-per-second-per-ip', '100',
        '--app-lane-pow', '0',
        '--developer-docs-url', 'https://example.com/dev',
      ],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.deployed[0]).toMatchObject({
      appLanes: ['dochost', 'cindersync'],
      fileLanes: ['cindersync'],
      maxFileMb: 30,
      relayName: 'My relay',
      relayDescription: 'desc',
      relayContact: 'mailto:me@example.com',
      maxTtlDays: 14,
      maxConnectionsPerPubkey: 10,
      maxMessagesPerSecondPerIp: 100,
      appLanePow: 0,
      developerDocsUrl: 'https://example.com/dev',
    });
  });

  it('🔴 只有 Cloudflare 支援的旗標配 docker／fly → 用法錯誤（回傳 2），不部署', async () => {
    for (const provider of ['docker', 'fly']) {
      const h = harness();
      const code = await runCli(['relay', 'deploy', '--provider', provider, '--app-lanes', 'dochost'], h.deps);
      expect(code).toBe(2);
      expect(h.err.join(' ')).toContain('--app-lanes');
      expect(h.docker.length + h.fly.length).toBe(0);
    }
  });

  it('docker／fly 也吃共用的站台參數（站名、保存期、限速）', async () => {
    const h = harness();
    expect(await runCli(['relay', 'deploy', '--provider', 'docker', '--relay-name', 'Box', '--max-ttl-days', '30'], h.deps)).toBe(0);
    expect(h.docker[0]).toMatchObject({ relayName: 'Box', maxTtlDays: 30 });
  });

  it('數字旗標不是正整數 → 用法錯誤', async () => {
    const h = harness();
    expect(await runCli(['relay', 'deploy', '--max-ttl-days', '0'], h.deps)).toBe(2);
    expect(await runCli(['relay', 'deploy', '--app-lane-pow', '-1'], h.deps)).toBe(2);
  });
});

