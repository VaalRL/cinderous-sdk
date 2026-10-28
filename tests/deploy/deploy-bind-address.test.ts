// docker 目標的發布位址（SDK ADR 0119，ADR 0109〈後續〉）：Docker 發布的埠會繞過 ufw；
// 開了 trustProxy 又對所有網卡發布，直接連埠的人就能自己帶 X-Forwarded-For 假裝成任何 IP。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CommandRunner } from '../../src/deploy/common.js';
import {
  type DeployConfig,
  renderDeployGuide,
  renderDeployPackage,
  validateDeployConfig,
} from '../../src/deploy/config/index.js';
import { deployDockerRelay, renderCompose } from '../../src/deploy/docker.js';
import { composeBindAddress, relayEnvironment } from '../../src/deploy/render.js';

const ALICE = 'a'.repeat(63) + '1';
const ctx = { sdkVersion: '0.0.0-test', licenseText: 'L\n' };
const compose = (config: DeployConfig) => renderDeployPackage(config, ctx).files.find((f) => f.path === 'docker-compose.yml')!.content;
const docker = (node: NonNullable<DeployConfig['node']>): DeployConfig => ({ configVersion: 1, target: 'docker', site: { allowedPubkeys: [ALICE] }, node });

describe('composeBindAddress', () => {
  it('🔴 開了 trustProxy、沒指定：只發布在 127.0.0.1；沒開 trustProxy：照舊對所有網卡（區網直連的樹莓派）', () => {
    expect(composeBindAddress(undefined, true)).toBe('127.0.0.1');
    expect(composeBindAddress(undefined, false)).toBeUndefined();
    expect(composeBindAddress('192.168.1.5', true)).toBe('192.168.1.5');
    expect(composeBindAddress('0.0.0.0', true)).toBe('0.0.0.0');
  });
});

describe('renderCompose：bindAddress', () => {
  const environment = relayEnvironment({ persist: false, trustProxy: true });
  it('IPv4 與 IPv6（加方括號）；沒給＝不加前綴', () => {
    expect(renderCompose({ name: 'r', port: 9000, environment, bindAddress: '127.0.0.1' })).toContain('"127.0.0.1:9000:8080"');
    expect(renderCompose({ name: 'r', port: 9000, environment, bindAddress: '::1' })).toContain('"[::1]:9000:8080"');
    expect(renderCompose({ name: 'r', port: 9000, environment })).toContain('"9000:8080"');
  });
});

describe('部署包（relay build）', () => {
  it('🔴 trustProxy＝true：compose 只發布在 127.0.0.1', () => {
    expect(compose(docker({ trustProxy: true }))).toContain('"127.0.0.1:8080:8080"');
  });

  it('沒開 trustProxy：與之前相同（對所有網卡）；指定了就照指定', () => {
    expect(compose(docker({}))).toContain('"8080:8080"');
    expect(compose(docker({ trustProxy: true, bindAddress: '10.0.0.5', port: 9000 }))).toContain('"10.0.0.5:9000:8080"');
  });

  it('home-tunnel 照舊不發布任何埠', () => {
    const config: DeployConfig = {
      configVersion: 1,
      target: 'home-tunnel',
      site: { allowedPubkeys: [ALICE] },
      tunnel: { hostname: 'relay.example.com' },
      secrets: { tunnelToken: { $env: 'TUNNEL_TOKEN' } },
    };
    expect(compose(config)).not.toMatch(/ports:/);
  });

  it('說明：docker 的安全檢查清單寫明 Docker 會繞過 ufw；trustProxy 時說只發布在 127.0.0.1（兩種語言）', () => {
    const zh = renderDeployGuide(docker({ trustProxy: true }), 'zh-TW', { sdkVersion: '1.2.3' });
    const en = renderDeployGuide(docker({ trustProxy: true }), 'en', { sdkVersion: '1.2.3' });
    expect(zh).toContain('ufw');
    expect(en).toContain('ufw');
    expect(zh).toContain('127.0.0.1:8080');
    expect(en).toContain('127.0.0.1:8080');
  });
});

describe('validateDeployConfig：node.bindAddress', () => {
  const codes = (config: DeployConfig) => validateDeployConfig(config).issues.map((i) => `${i.severity}:${i.path}:${i.code}`);

  it('合法的 IPv4／IPv6 通過', () => {
    for (const bindAddress of ['127.0.0.1', '0.0.0.0', '192.168.1.5', '::1', '::', 'fd00::5']) {
      expect(validateDeployConfig(docker({ bindAddress })).ok, bindAddress).toBe(true);
    }
  });

  it('不是 IP 的值 → 錯誤', () => {
    for (const bindAddress of ['localhost', '1.2.3', '256.1.1.1', '[::1]', '127.0.0.1:8080', '']) {
      expect(codes(docker({ bindAddress })), bindAddress).toContain('error:node.bindAddress:pattern');
    }
  });

  it('🔴 trustProxy 又明確對所有網卡發布 → 警告（直接連埠的人能偽造 IP）', () => {
    expect(codes(docker({ trustProxy: true, bindAddress: '0.0.0.0' }))).toContain('warning:node.bindAddress:public-bind-trust-proxy');
    expect(codes(docker({ trustProxy: true, bindAddress: '::' }))).toContain('warning:node.bindAddress:public-bind-trust-proxy');
    expect(codes(docker({ bindAddress: '0.0.0.0' }))).not.toContain('warning:node.bindAddress:public-bind-trust-proxy');
  });

  it('只適用於 docker 目標', () => {
    const fly: DeployConfig = { configVersion: 1, target: 'fly', site: { allowedPubkeys: [ALICE] }, node: { bindAddress: '127.0.0.1' } };
    expect(codes(fly).some((c) => c.startsWith('error:node.bindAddress:not-applicable'))).toBe(true);
  });
});

describe('deployDockerRelay：bindAddress', () => {
  const okFetch = (async () => ({ ok: true, status: 200, text: async () => 'ok' })) as unknown as typeof fetch;
  const run: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' });
  const base = () => ({ workDir: mkdtempSync(join(tmpdir(), 'cinderous-bind-')), sdkRoot: fakeSdkRoot(), healthRetries: 1, healthDelayMs: 0 });

  it('trustProxy 沒指定：compose 只發布在 127.0.0.1', async () => {
    const opts = base();
    await deployDockerRelay({ ...opts, trustProxy: true, dryRun: true });
    expect(readFileSync(join(opts.workDir, 'docker-compose.yml'), 'utf8')).toContain('"127.0.0.1:8080:8080"');
  });

  it('指定了區網位址：compose 照寫、健康檢查打那個位址（localhost 連不到）', async () => {
    const opts = base();
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => 'ok' };
    }) as unknown as typeof globalThis.fetch;
    const result = await deployDockerRelay({ ...opts, bindAddress: '192.168.1.5', port: 9000, run, fetch });
    expect(readFileSync(join(opts.workDir, 'docker-compose.yml'), 'utf8')).toContain('"192.168.1.5:9000:8080"');
    expect(urls[0]).toBe('http://192.168.1.5:9000/healthz');
    expect(result.relayEndpoint).toBe('ws://192.168.1.5:9000');
  });

  it('不是 IP → 寫任何檔案之前就拒絕', async () => {
    await expect(deployDockerRelay({ ...base(), bindAddress: 'localhost', run, fetch: okFetch })).rejects.toThrow(/bindAddress/);
  });
});

/** 假的 SDK 套件目錄（prepareNodeRelayContext 只要 package.json 與 dist） */
function fakeSdkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fake-sdk-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@cinderous/client', version: '9.9.9', type: 'module' }));
  mkdirSync(join(root, 'dist', 'relay'), { recursive: true });
  writeFileSync(join(root, 'dist', 'relay', 'node.js'), 'export {}');
  return root;
}
