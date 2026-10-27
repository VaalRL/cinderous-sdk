// `relay build` 的寫檔（SDK ADR 0050 §5）：真的寫到暫存資料夾。SDK 換成假的套件目錄。
// 另外測 docker 部署的 home-tunnel 模式（替身執行器，不跑真的 docker）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildRelayPackage } from '../../src/deploy/build.js';
import type { CommandRunner } from '../../src/deploy/common.js';
import { GENERATED_MANIFEST } from '../../src/deploy/config/index.js';
import { deployDockerRelay } from '../../src/deploy/docker.js';

const ALICE = 'b'.repeat(64);

function fakeSdk(): string {
  const root = mkdtempSync(join(tmpdir(), 'fake-sdk-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@cinderous/client', version: '9.9.9', type: 'module', bin: { cinderous: './dist/cli/index.js' }, devDependencies: { vitest: '*' } }),
  );
  writeFileSync(join(root, 'LICENSE'), 'GNU AFFERO GENERAL PUBLIC LICENSE\n');
  mkdirSync(join(root, 'dist', 'relay'), { recursive: true });
  writeFileSync(join(root, 'dist', 'relay', 'node.js'), 'export {}');
  return root;
}

const dockerConfig = { configVersion: 1, target: 'docker', site: { allowedPubkeys: [ALICE] }, node: { persist: true } };

describe('buildRelayPackage', () => {
  it('寫出部署包、複製 sdk/（含 LICENSE、bin，不含開發相依）、記下清單；回報提醒', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pkg-'));
    const result = await buildRelayPackage({ config: { configVersion: 1, target: 'docker' }, outDir, sdkRoot: fakeSdk() });
    expect(result.copiedSdk).toBe(true);
    expect(result.files).toContain('docker-compose.yml');
    expect(result.warnings.map((w) => w.code)).toEqual(['open-relay']);
    for (const file of [...result.files, 'sdk/package.json', 'sdk/LICENSE', 'sdk/dist/relay/node.js']) expect(existsSync(join(outDir, file)), file).toBe(true);
    const sdkPkg = JSON.parse(readFileSync(join(outDir, 'sdk', 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(sdkPkg.devDependencies).toBeUndefined();
    expect(sdkPkg.bin).toEqual({ cinderous: './dist/cli/index.js' });
    expect(readFileSync(join(outDir, 'LICENSE'), 'utf8')).toContain('AFFERO');
    expect(JSON.parse(readFileSync(join(outDir, 'cinderous.config.json'), 'utf8')).sdk).toBe('9.9.9');
  });

  it('設定有錯：什麼都不寫，列出全部錯誤', async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), 'pkg-')), 'out');
    await expect(buildRelayPackage({ config: { configVersion: 1, target: 'docker', site: { appLanes: ['a'], maxTtlDays: 0 } }, outDir, sdkRoot: fakeSdk() })).rejects.toThrow(
      /2 個錯誤[\s\S]*site\.appLanes[\s\S]*site\.maxTtlDays/,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it('🔴 重新產生：沒改過就照寫；手改過的產生檔案 → 拒絕（--force 才覆寫）', async () => {
    const sdkRoot = fakeSdk();
    const outDir = mkdtempSync(join(tmpdir(), 'pkg-'));
    await buildRelayPackage({ config: dockerConfig, outDir, sdkRoot });
    await buildRelayPackage({ config: dockerConfig, outDir, sdkRoot }); // 沒改過：照寫
    writeFileSync(join(outDir, 'docker-compose.yml'), '# 手改\n');
    await expect(buildRelayPackage({ config: dockerConfig, outDir, sdkRoot })).rejects.toThrow('docker-compose.yml');
    expect(readFileSync(join(outDir, 'docker-compose.yml'), 'utf8')).toBe('# 手改\n');
    await buildRelayPackage({ config: dockerConfig, outDir, sdkRoot, force: true });
    expect(readFileSync(join(outDir, 'docker-compose.yml'), 'utf8')).toContain('services:');
  });

  it('🔴 輸出目錄裡已有同名、不是產生的檔案 → 拒絕；輸入的設定檔本身可以被正規化覆寫', async () => {
    const sdkRoot = fakeSdk();
    const outDir = mkdtempSync(join(tmpdir(), 'pkg-'));
    writeFileSync(join(outDir, 'Dockerfile'), 'FROM scratch\n');
    await expect(buildRelayPackage({ config: dockerConfig, outDir, sdkRoot })).rejects.toThrow('Dockerfile');

    const inPlace = mkdtempSync(join(tmpdir(), 'pkg-'));
    const configPath = join(inPlace, 'cinderous.config.json');
    writeFileSync(configPath, JSON.stringify(dockerConfig));
    await buildRelayPackage({ config: dockerConfig, configPath, outDir: inPlace, sdkRoot });
    // 使用者之後改了設定檔（它在清單裡）：不算手改產生檔案
    writeFileSync(configPath, JSON.stringify({ ...dockerConfig, name: 'renamed' }));
    await buildRelayPackage({ config: { ...dockerConfig, name: 'renamed' }, configPath, outDir: inPlace, sdkRoot });
    expect(readFileSync(join(inPlace, 'docker-compose.yml'), 'utf8')).toContain('container_name: renamed');
  });

  it('換目標：上一次產生、這次不需要的檔案（沒改過）會被移除', async () => {
    const sdkRoot = fakeSdk();
    const outDir = mkdtempSync(join(tmpdir(), 'pkg-'));
    await buildRelayPackage({ config: dockerConfig, outDir, sdkRoot });
    const result = await buildRelayPackage({ config: { configVersion: 1, target: 'fly', site: { allowedPubkeys: [ALICE] } }, outDir, sdkRoot });
    expect(result.removed).toContain('docker-compose.yml');
    expect(existsSync(join(outDir, 'docker-compose.yml'))).toBe(false);
    expect(existsSync(join(outDir, 'fly.toml'))).toBe(true);
    expect(JSON.parse(readFileSync(join(outDir, GENERATED_MANIFEST), 'utf8')).target).toBe('fly');
  });

  it('Workers --self-contained：附 src/relay.mjs、不複製 sdk/（之前內嵌過的 sdk/ 會被移除）', async () => {
    const sdkRoot = fakeSdk();
    const outDir = mkdtempSync(join(tmpdir(), 'pkg-'));
    const config = { configVersion: 1, target: 'cloudflare', site: { allowedPubkeys: [ALICE] } };
    await buildRelayPackage({ config, outDir, sdkRoot });
    expect(existsSync(join(outDir, 'sdk'))).toBe(true);
    const result = await buildRelayPackage({ config, outDir, sdkRoot, selfContained: true, relayWorkerSource: 'export default {}; export class RelayRoom {}; export function setRelayVersion() {}' });
    expect(result.copiedSdk).toBe(false);
    expect(result.removed).toContain('sdk/');
    expect(readFileSync(join(outDir, 'src', 'relay.mjs'), 'utf8')).toContain('export class RelayRoom');
  });

  it('自帶 LICENSE 檢查：SDK 沒有 LICENSE 就拒絕（AGPL 要附全文）', async () => {
    const sdkRoot = mkdtempSync(join(tmpdir(), 'no-license-'));
    writeFileSync(join(sdkRoot, 'package.json'), JSON.stringify({ name: '@cinderous/client', version: '9.9.9' }));
    await expect(buildRelayPackage({ config: dockerConfig, outDir: mkdtempSync(join(tmpdir(), 'pkg-')), sdkRoot })).rejects.toThrow('LICENSE');
  });
});

describe('deployDockerRelay：home-tunnel 模式（SDK ADR 0050）', () => {
  it('relay 不發布埠、TRUST_PROXY=1、Token 只進 docker compose 的環境；健康檢查與端點用 Tunnel 主機名稱', async () => {
    const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const run: CommandRunner = async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return { code: 0, stdout: '', stderr: '' };
    };
    const fetched: string[] = [];
    const fetch = (async (url: string) => {
      fetched.push(url);
      return { status: 200, text: async () => 'ok' };
    }) as unknown as typeof globalThis.fetch;
    const workDir = mkdtempSync(join(tmpdir(), 'tunnel-'));
    const deployment = await deployDockerRelay({
      name: 'home',
      allowedPubkeys: [ALICE],
      tunnel: { hostname: 'relay.example.com', tokenEnv: 'TUNNEL_TOKEN', token: 'secret-token' },
      workDir,
      sdkRoot: fakeSdk(),
      run,
      fetch,
      healthRetries: 1,
      healthDelayMs: 0,
    });
    const compose = readFileSync(join(workDir, 'docker-compose.yml'), 'utf8');
    expect(compose).not.toContain('ports:');
    expect(compose).toContain('TRUST_PROXY: "1"');
    expect(compose).toContain('${TUNNEL_TOKEN:?');
    expect(compose).not.toContain('secret-token');
    expect(calls[0]!.env).toEqual({ TUNNEL_TOKEN: 'secret-token' });
    expect(fetched).toEqual(['https://relay.example.com/healthz']);
    expect(deployment.relayEndpoint).toBe('wss://relay.example.com');
  });
});
