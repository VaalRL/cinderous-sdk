// `cinderous iot …`（SDK ADR 0049 P0）：旗標與設定檔怎麼解讀、交給誰、輸出什麼。橋接器、relay 連線、寫檔都換成替身；
// 另外以真的檔案系統跑一次 `prepareIotBridgeContext`（Docker 建置內容）。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type CliDeps, type IotAclClient, runCli } from '../../src/cli/commands.js';
import { prepareIotBridgeContext } from '../../src/deploy/container.js';
import { renderIotBridgeCompose, renderIotBridgeDockerfile } from '../../src/deploy/render.js';
import { Identity } from '../../src/identity.js';
import type { ResolvedIotBridgeConfig, ResolvedIotClientConfig } from '../../src/iot/bridge/config.js';
import type { IotAclEntryInput } from '../../src/iot/acl.js';
import { generateIotHomeSecret } from '../../src/iot/keys.js';

const owner = Identity.generate();
const gateway = Identity.generate();
const member = Identity.generate();
const homeSecret = generateIotHomeSecret();
/** Windows 的 resolve 會加上磁碟代號與反斜線：統一成 POSIX 形狀再比 */
const norm = (path: string): string => path.replace(/^[A-Za-z]:/, '').split(String.fromCharCode(92)).join('/');

function harness(files: Record<string, string> = {}, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const bridges: { config: ResolvedIotBridgeConfig; aclPath: string; pushPath?: string }[] = [];
  const clients: ResolvedIotClientConfig[] = [];
  const ops: unknown[] = [];
  let closed = 0;
  const built: { workDir: string; configPath?: string }[] = [];
  const client: IotAclClient = {
    updateAcl: async (op) => {
      ops.push(op);
      const denied = op.op === 'add' && (op.entry as IotAclEntryInput).role === 'owner';
      return { status: denied ? 'not-allowed' : 'ok', msgId: 'x'.repeat(32), attempts: 1, ...(denied ? { reason: 'owner-only' } : {}) };
    },
    getAcl: async () => ({ entries: [{ pubkey: owner.pubkey, role: 'owner' }, { pubkey: member.pubkey, role: 'viewer', devices: ['cam-*'] }], rules: [{ topic: 'home/door/#', minRole: 'owner' }] }),
  };
  const deps: CliDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env,
    cwd: '/home/me',
    startNodeRelay: () => ({ close() {} }),
    deployCloudflareRelay: async () => {
      throw new Error('不該部署');
    },
    deployDockerRelay: async () => {
      throw new Error('不該部署');
    },
    deployFlyRelay: async () => {
      throw new Error('不該部署');
    },
    writeFile: () => {},
    readFile: (path) => files[norm(path)],
    startIotBridge: async (config, extra) => {
      bridges.push({ config, aclPath: norm(extra.aclPath), ...(extra.pushPath !== undefined ? { pushPath: norm(extra.pushPath) } : {}) });
      return { gatewayNpub: gateway.npub, homeTag: 'tag', close: async () => {} };
    },
    connectIotClient: async (config) => {
      clients.push(config);
      return { client, close: () => void (closed += 1) };
    },
    prepareIotBridgeContext: (opts) => {
      built.push(opts);
      return ['package.json', 'Dockerfile', 'compose.yaml', 'sdk/'];
    },
  };
  return { deps, out, err, bridges, clients, ops, built, closedCount: () => closed };
}

const bridgeConfig = JSON.stringify({
  mqtt: { url: 'mqtt://localhost:1883' },
  relays: ['wss://relay.example/app/iot'],
  topicMap: [{ mqtt: 'stat/p/POWER', topic: 'home/p/power', device: 'p', dir: 'up' }],
  acl: [{ npub: owner.npub, role: 'owner' }],
});
const clientConfig = JSON.stringify({ relays: ['wss://relay.example/app/iot'], gateway: gateway.npub });
const dotEnv = `IOT_HOME_SECRET=${homeSecret}\nIOT_GATEWAY_KEY=${gateway.nsec()}\nIOT_MEMBER_KEY=${owner.nsec()}\n`;

describe('cinderous iot push-keygen', () => {
  it('印出推播閘道私鑰（nsec）與公鑰（hex）；多給參數是用法錯誤', async () => {
    const h = harness();
    expect(await runCli(['iot', 'push-keygen'], h.deps)).toBe(0);
    const line = h.out.find((l) => l.startsWith('PUSH_GATEWAY_KEY='))!;
    const nsec = line.slice('PUSH_GATEWAY_KEY='.length);
    expect(nsec.startsWith('nsec1')).toBe(true);
    expect(h.out.join('\n')).toContain(Identity.fromNsec(nsec).pubkey);
    expect(await runCli(['iot', 'push-keygen', 'x'], harness().deps)).toBe(2);
  });
});

describe('cinderous iot bridge', () => {
  it('讀設定檔與旁邊的 .env；aclFile 相對於設定檔', async () => {
    const h = harness({ '/home/me/iot-bridge.json': bridgeConfig, '/home/me/.env': dotEnv });
    expect(await runCli(['iot', 'bridge'], h.deps)).toBe(0);
    expect(h.bridges).toHaveLength(1);
    expect(h.bridges[0]!.config.gatewayNsec).toBe(gateway.nsec());
    expect(h.bridges[0]!.aclPath).toMatch(/\/home\/me\/iot-acl\.json$/);
    expect(h.out.join('\n')).toContain(gateway.npub);
  });

  it('--acl-file 覆寫存檔位置', async () => {
    const h = harness({ '/cfg/b.json': bridgeConfig }, { IOT_HOME_SECRET: homeSecret, IOT_GATEWAY_KEY: gateway.nsec() });
    expect(await runCli(['iot', 'bridge', '-c', '/cfg/b.json', '--acl-file', '/data/acl.json'], h.deps)).toBe(0);
    expect(h.bridges[0]!.aclPath).toMatch(/\/data\/acl\.json$/);
  });

  it('設定檔有 push 段：推播端點存檔相對於設定檔，--push-file 可覆寫；沒有 push 段就不給', async () => {
    const withPush = JSON.stringify({ ...JSON.parse(bridgeConfig), push: { storeFile: 'push.json' } });
    const env = { IOT_HOME_SECRET: homeSecret, IOT_GATEWAY_KEY: gateway.nsec() };
    const h = harness({ '/cfg/b.json': withPush }, env);
    expect(await runCli(['iot', 'bridge', '-c', '/cfg/b.json'], h.deps)).toBe(0);
    expect(h.bridges[0]!.pushPath).toMatch(/\/cfg\/push\.json$/);
    expect(h.out.join('\n')).toContain('推播端點存檔');
    const over = harness({ '/cfg/b.json': withPush }, env);
    expect(await runCli(['iot', 'bridge', '-c', '/cfg/b.json', '--push-file', '/data/p.json'], over.deps)).toBe(0);
    expect(over.bridges[0]!.pushPath).toMatch(/\/data\/p\.json$/);
    const none = harness({ '/cfg/b.json': bridgeConfig }, env);
    expect(await runCli(['iot', 'bridge', '-c', '/cfg/b.json', '--push-file', '/data/p.json'], none.deps)).toBe(0);
    expect(none.bridges[0]!.pushPath).toBeUndefined();
  });

  it('缺秘密、秘密寫死、找不到檔：結束碼 1，不啟動', async () => {
    const missing = harness({ '/home/me/iot-bridge.json': bridgeConfig });
    expect(await runCli(['iot', 'bridge'], missing.deps)).toBe(1);
    expect(missing.err.join('\n')).toContain('IOT_HOME_SECRET');
    const literal = harness({ '/home/me/iot-bridge.json': JSON.stringify({ ...JSON.parse(bridgeConfig), gatewayKey: gateway.nsec() }), '/home/me/.env': dotEnv });
    expect(await runCli(['iot', 'bridge'], literal.deps)).toBe(1);
    expect(literal.err.join('\n')).toContain('$env');
    const none = harness();
    expect(await runCli(['iot', 'bridge'], none.deps)).toBe(1);
    expect(none.bridges).toHaveLength(0);
  });
});

describe('cinderous iot acl', () => {
  const files = { '/home/me/iot-client.json': clientConfig, '/home/me/.env': dotEnv };

  it('add：交給閘道（$sys/acl），印出結果、關掉連線', async () => {
    const h = harness(files);
    expect(await runCli(['iot', 'acl', 'add', member.npub, '--role', 'operator', '--devices', 'light-*,plug1', '--topics', 'home/+/light/#', '--label', '小孩'], h.deps)).toBe(0);
    expect(h.ops).toEqual([{ op: 'add', entry: { pubkey: member.pubkey, role: 'operator', devices: ['light-*', 'plug1'], topics: ['home/+/light/#'], label: '小孩' } }]);
    expect(h.clients[0]!.memberNsec).toBe(owner.nsec());
    expect(h.out.join('\n')).toContain('operator');
    expect(h.closedCount()).toBe(1);
  });

  it('閘道拒絕 → 結束碼 1 並說明原因', async () => {
    const h = harness(files);
    expect(await runCli(['iot', 'acl', 'add', member.pubkey, '--role', 'owner'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('not-allowed');
  });

  it('remove 與 list', async () => {
    const h = harness(files);
    expect(await runCli(['iot', 'acl', 'remove', member.npub], h.deps)).toBe(0);
    expect(h.ops).toEqual([{ op: 'remove', pubkey: member.pubkey }]);
    expect(await runCli(['iot', 'acl', 'list'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain(owner.npub);
    expect(text).toContain('devices=cam-*');
    expect(text).toContain('minRole=owner');
  });

  it('用法錯誤：結束碼 2', async () => {
    for (const argv of [
      ['iot', 'acl'],
      ['iot', 'acl', 'add', member.npub],
      ['iot', 'acl', 'add', member.npub, '--role', 'admin'],
      ['iot', 'acl', 'add', 'npub1bad', '--role', 'viewer'],
      ['iot', 'acl', 'remove'],
      ['iot', 'acl', 'remove', member.npub, '--role', 'viewer'],
      ['iot', 'acl', 'list', 'extra'],
      ['iot', 'nope'],
    ]) {
      const h = harness(files);
      expect(await runCli(argv, h.deps), argv.join(' ')).toBe(2);
      expect(h.ops).toEqual([]);
    }
  });
});

describe('cinderous iot keygen／build', () => {
  it('keygen：新的家庭秘密與閘道私鑰（可直接貼進 .env）', async () => {
    const h = harness();
    expect(await runCli(['iot', 'keygen'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/^IOT_HOME_SECRET=[0-9a-f]{64}$/m);
    expect(text).toMatch(/^IOT_GATEWAY_KEY=nsec1[02-9ac-hj-np-z]+$/m);
    expect(text).toMatch(/npub1/);
  });

  it('build：交給 prepareIotBridgeContext', async () => {
    const h = harness({ '/home/me/iot-bridge.json': bridgeConfig });
    expect(await runCli(['iot', 'build', '-o', 'docker-iot', '-c', 'iot-bridge.json'], h.deps)).toBe(0);
    expect(norm(h.built[0]!.workDir)).toMatch(/\/home\/me\/docker-iot$/);
    expect(norm(h.built[0]!.configPath ?? '')).toMatch(/\/home\/me\/iot-bridge\.json$/);
  });
});

describe('橋接器的 Docker 建置內容', () => {
  it('Dockerfile 跑 cinderous iot bridge、名單存在 volume；compose 不發布埠、用 .env', () => {
    const dockerfile = renderIotBridgeDockerfile('9.9.9');
    expect(dockerfile).toContain('"iot", "bridge", "--config", "/config/iot-bridge.json", "--acl-file", "/data/iot-acl.json", "--push-file", "/data/iot-push.json"');
    expect(dockerfile).toContain('USER node');
    const compose = renderIotBridgeCompose();
    expect(compose).toContain('env_file: .env');
    expect(compose).toContain('./iot-bridge.json:/config/iot-bridge.json:ro');
    expect(compose).not.toContain('ports:');
  });

  it('prepareIotBridgeContext 真的寫出檔案：sdk/、裝 mqtt 的 package.json、設定檔副本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cinder-iot-build-'));
    const cfg = join(dir, 'src.json');
    const out = join(dir, 'out');
    writeFileSync(cfg, bridgeConfig);
    const files = prepareIotBridgeContext({ workDir: out, configPath: cfg, version: '0.0.0-test' });
    expect(files).toEqual(['package.json', 'Dockerfile', 'compose.yaml', '.dockerignore', '.env.example', 'iot-bridge.json', 'sdk/']);
    const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toEqual({ '@cinderous/client': 'file:./sdk', mqtt: '^5.16.0' });
    expect(existsSync(join(out, 'sdk', 'dist', 'iot', 'bridge', 'index.js'))).toBe(true);
    expect(readFileSync(join(out, '.env.example'), 'utf8')).toMatch(/^IOT_HOME_SECRET=$/m);
    expect(readFileSync(join(out, 'iot-bridge.json'), 'utf8')).toBe(bridgeConfig);
  });
});
