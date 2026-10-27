// Docker／Fly 部署（SDK ADR 0018）。真的 docker、flyctl 與網路都換成替身。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CommandRunner } from '../../src/deploy/common.js';
import { prepareNodeRelayContext, relayEnvironment, renderDockerfile } from '../../src/deploy/container.js';
import { deployDockerRelay, renderCompose } from '../../src/deploy/docker.js';
import { deployFlyRelay, renderFlyToml } from '../../src/deploy/fly.js';
import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/index.js';

const alice = getPublicKey(generateSecretKey());

/** 假的 SDK 套件目錄（只要有 package.json 與 dist） */
function fakeSdk(): string {
  const root = mkdtempSync(join(tmpdir(), 'fake-sdk-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@cinderous/client',
      version: '9.9.9',
      type: 'module',
      exports: { '.': './dist/index.js' },
      dependencies: { '@noble/hashes': '^1.8.0' },
      optionalDependencies: { ws: '^8.0.0' },
      devDependencies: { vitest: '*' },
      scripts: { build: 'tsc' },
    }),
  );
  mkdirSync(join(root, 'dist', 'relay'), { recursive: true });
  writeFileSync(join(root, 'dist', 'relay', 'node.js'), 'export {}');
  return root;
}

const base = () => ({ workDir: mkdtempSync(join(tmpdir(), 'deploy-')), sdkRoot: fakeSdk(), healthRetries: 2, healthDelayMs: 0 });

function fakeRun(outputs: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const run: CommandRunner = async (cmd, args, env) => {
    calls.push({ cmd, args, env });
    const key = `${cmd} ${args.slice(0, 2).join(' ')}`;
    const out = outputs[key] ?? {};
    return { code: out.code ?? 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };
  return { run, calls };
}

const okFetch = (async () => ({ ok: true, status: 200, text: async () => 'ok' })) as unknown as typeof fetch;

describe('建置內容（兩個 provider 共用）', () => {
  it('SDK 放進 sdk/（只帶執行需要的欄位），以 file:./sdk 安裝；server.mjs 啟動 Node 中繼', () => {
    const { workDir, sdkRoot } = base();
    prepareNodeRelayContext({ workDir, sdkRoot });
    const pkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@cinderous/client']).toBe('file:./sdk');
    const sdkPkg = JSON.parse(readFileSync(join(workDir, 'sdk', 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(sdkPkg.devDependencies).toBeUndefined(); // 不裝開發用的套件
    expect(sdkPkg.scripts).toBeUndefined(); // 不在映像裡跑任何 script
    expect(existsSync(join(workDir, 'sdk', 'dist', 'relay', 'node.js'))).toBe(true);
    const server = readFileSync(join(workDir, 'server.mjs'), 'utf8');
    expect(server).toContain("from '@cinderous/client/relay/node'");
    expect(server).toContain('startNodeRelay(process.env');
    expect(readFileSync(join(workDir, 'Dockerfile'), 'utf8')).toContain('RELAY_VERSION=9.9.9');
  });

  it('Dockerfile：先裝相依再複製程式（快取友善），以 node:sqlite 旗標啟動', () => {
    const dockerfile = renderDockerfile('1.2.3');
    expect(dockerfile.indexOf('npm install')).toBeLessThan(dockerfile.indexOf('COPY server.mjs'));
    expect(dockerfile).toContain('--experimental-sqlite');
  });

  it('環境變數：PRD 3.3 的防濫用預設、白名單、保存', () => {
    expect(relayEnvironment({ allowedPubkeys: [alice], persist: true, trustProxy: true })).toEqual({
      MAX_CONNECTIONS_PER_PUBKEY: '5',
      MAX_MESSAGES_PER_SECOND_PER_IP: '20',
      ALLOWED_PUBKEYS: alice,
      PERSIST: '1',
      DB_PATH: '/data/relay.db',
      TRUST_PROXY: '1',
    });
    expect(relayEnvironment({ persist: false, trustProxy: false })).toEqual({
      MAX_CONNECTIONS_PER_PUBKEY: '5',
      MAX_MESSAGES_PER_SECOND_PER_IP: '20',
    });
  });
});

describe('--provider=docker', () => {
  it('compose：對外埠、重啟策略、環境變數；保存時掛 volume', () => {
    const yaml = renderCompose({ name: 'my-relay', port: 9000, environment: relayEnvironment({ persist: true, trustProxy: false }) });
    expect(yaml).toContain('"9000:8080"');
    expect(yaml).toContain('restart: unless-stopped');
    expect(yaml).toContain('PERSIST: "1"');
    expect(yaml).toContain('relay-data:/data');
  });

  it('寫出建置內容 → docker compose up -d --build → 健康檢查 → ws://localhost:埠', async () => {
    const { run, calls } = fakeRun();
    const opts = base();
    const result = await deployDockerRelay({ ...opts, name: 'my-relay', port: 9000, allowedPubkeys: [npubEncode(alice)], run, fetch: okFetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('docker');
    expect(calls[0]!.args).toEqual(['compose', '-f', join(opts.workDir, 'docker-compose.yml'), '-p', 'my-relay', 'up', '-d', '--build']);
    expect(readFileSync(join(opts.workDir, 'docker-compose.yml'), 'utf8')).toContain(`ALLOWED_PUBKEYS: "${alice}"`); // npub 已換成 hex
    expect(result.relayEndpoint).toBe('ws://localhost:9000');
  });

  it('dryRun：只寫檔，不跑 docker', async () => {
    const { run, calls } = fakeRun();
    const result = await deployDockerRelay({ ...base(), dryRun: true, run });
    expect(calls).toHaveLength(0);
    expect(result.relayEndpoint).toBeUndefined();
  });

  it('docker 失敗 → 丟出含 docker 訊息的例外', async () => {
    const { run } = fakeRun({ 'docker compose -f': { code: 1, stderr: 'Cannot connect to the Docker daemon' } });
    await expect(deployDockerRelay({ ...base(), run, fetch: okFetch })).rejects.toThrow(/Docker daemon/);
  });
});

describe('--provider=fly', () => {
  it('fly.toml：常駐一台（WebSocket 不能被自動停機）、/healthz 檢查、信任 Fly 的代理；保存時掛 volume', () => {
    const toml = renderFlyToml({ name: 'my-relay', region: 'nrt', environment: relayEnvironment({ persist: true, trustProxy: true }), persist: true });
    expect(toml).toContain('app = "my-relay"');
    expect(toml).toContain('primary_region = "nrt"');
    expect(toml).toContain('auto_stop_machines = "off"');
    expect(toml).toContain('min_machines_running = 1');
    expect(toml).toContain('path = "/healthz"');
    expect(toml).toContain('TRUST_PROXY = "1"');
    expect(toml).toContain('destination = "/data"');
  });

  it('建立 app → 部署（單一機器）→ 健康檢查 → wss://名稱.fly.dev；token 經環境變數傳給 flyctl', async () => {
    const { run, calls } = fakeRun();
    const opts = base();
    const result = await deployFlyRelay({ ...opts, name: 'my-relay', region: 'nrt', apiToken: 'fly-tok', run, fetch: okFetch });
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['apps create', 'deploy --config']);
    expect(calls[1]!.args).toContain('--ha=false'); // 記憶體或單一 SQLite 檔：只能一台
    expect(calls.every((c) => c.env.FLY_API_TOKEN === 'fly-tok')).toBe(true);
    expect(result.relayEndpoint).toBe('wss://my-relay.fly.dev');
  });

  it('app 已經存在 → 不算失敗，照樣部署', async () => {
    const { run, calls } = fakeRun({ 'fly apps create': { code: 1, stderr: 'Validation failed: Name has already been taken' } });
    await deployFlyRelay({ ...base(), name: 'my-relay', run, fetch: okFetch });
    expect(calls.map((c) => c.args[0])).toEqual(['apps', 'deploy']);
  });

  it('保存：volume 還不存在才建立（重複建會多一顆、多付錢）', async () => {
    const { run, calls } = fakeRun({ 'fly volumes list': { stdout: '[]' } });
    await deployFlyRelay({ ...base(), name: 'my-relay', persist: true, run, fetch: okFetch });
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['apps create', 'volumes list', 'volumes create', 'deploy --config']);

    const again = fakeRun({ 'fly volumes list': { stdout: '[{"name":"relay_data"}]' } });
    await deployFlyRelay({ ...base(), name: 'my-relay', persist: true, run: again.run, fetch: okFetch });
    expect(again.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['apps create', 'volumes list', 'deploy --config']);
  });

  it('健康檢查沒過 → 丟例外，不回報成功', async () => {
    const { run } = fakeRun();
    const bad = (async () => ({ ok: false, status: 502, text: async () => '' })) as unknown as typeof fetch;
    await expect(deployFlyRelay({ ...base(), name: 'x', run, fetch: bad })).rejects.toThrow(/502/);
  });
});
