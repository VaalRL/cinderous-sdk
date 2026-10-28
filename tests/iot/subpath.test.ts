// 守門（SDK ADR 0049 §8；使用者裁示 10）：
// 1. `./iot` 中立：零 Node 內建模組、零外部引用；不拉進連線池執行期、中繼、部署、同步、橋接器，也沒有任何 MQTT 程式。
// 2. 主入口與其他子路徑不帶進 `./iot`，也不帶進 mqtt／aedes／mqtt-packet。
// 3. `./iot/bridge`：mqtt 只以動態 `import()` 載入（選用 peer 相依），沒有 aedes。
// 做法同 cloudflare-api-guard：用 esbuild 實際打包一次，看 metafile。
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'node:*'];
const MQTT_PACKAGES = ['mqtt', 'aedes', 'mqtt-packet'];

async function bundle(entry: string, platform: 'neutral' | 'node' = 'neutral', external: string[] = nodeBuiltins): Promise<Metafile> {
  const result = await build({
    entryPoints: [`${root}${entry}`],
    bundle: true,
    format: 'esm',
    platform,
    mainFields: ['module', 'main'],
    write: false,
    metafile: true,
    logLevel: 'silent',
    external,
  });
  return result.metafile;
}

const mqttInputs = (metafile: Metafile): string[] =>
  Object.keys(metafile.inputs).filter((file) => MQTT_PACKAGES.some((name) => file.includes(`node_modules/${name}/`)));

describe('./iot 子路徑', () => {
  it('零 Node 內建模組、零外部引用', async () => {
    const metafile = await bundle('src/iot/index.ts');
    const external: string[] = [];
    for (const [file, input] of Object.entries(metafile.inputs)) for (const i of input.imports) if (i.external) external.push(`${file} → ${i.path}`);
    expect(external).toEqual([]);
  });

  it('不拉進連線池執行期、中繼、部署、同步、橋接器；沒有 MQTT 程式', async () => {
    const inputs = Object.keys((await bundle('src/iot/index.ts')).inputs);
    expect(inputs.filter((f) => f.endsWith('src/relay-pool.ts') || f.includes('src/relay/') || f.includes('src/deploy/') || f.includes('src/sync/') || f.includes('src/iot/bridge/'))).toEqual([]);
    expect(mqttInputs(await bundle('src/iot/index.ts'))).toEqual([]);
  });

  for (const entry of ['src/index.ts', 'src/protocol/index.ts', 'src/pairing/index.ts', 'src/sync/index.ts', 'src/sync/vault/index.ts', 'src/transfer/index.ts', 'src/relay/index.ts', 'src/deploy/config/index.ts']) {
    it(`${entry} 不含 ./iot 與 MQTT 套件`, async () => {
      const metafile = await bundle(entry);
      expect(Object.keys(metafile.inputs).filter((f) => f.includes('src/iot/'))).toEqual([]);
      expect(mqttInputs(metafile)).toEqual([]);
    });
  }

  it('Worker 與 Node 中繼的入口只帶 ./iot 的協定層（C′ 即時通道需要），不帶手機端、閘道、推播、橋接器與 MQTT 套件', async () => {
    // SDK ADR 0049 C′（R1）：relay 就是即時通道的閘道，需要協定層——kind、盲化、內容格式、角色名單、設備信封與設備幀。
    // 手機端 IotClient、A/B 的 IotGateway（用計時器，不能進 DO）、推播與 MQTT 仍然不准進中繼。
    const allowed = ['kinds.ts', 'keys.ts', 'topic.ts', 'content.ts', 'acl.ts', 'envelope.ts', 'device-frame.ts'].map((f) => `src/iot/${f}`);
    for (const entry of ['src/relay/worker.ts', 'src/relay/node.ts']) {
      const metafile = await bundle(entry, 'node', [...nodeBuiltins, 'ws']);
      const iot = Object.keys(metafile.inputs).filter((f) => f.includes('src/iot/'));
      expect(iot.filter((f) => !allowed.some((a) => f.endsWith(a)))).toEqual([]);
      expect(mqttInputs(metafile)).toEqual([]);
    }
  });
});

describe('./iot/bridge 子路徑', () => {
  it('mqtt 只以動態 import() 載入；沒有 aedes', async () => {
    const metafile = await bundle('src/iot/bridge/index.ts', 'node', [...nodeBuiltins, 'mqtt', 'ws']);
    const mqttImports = Object.values(metafile.inputs).flatMap((input) => input.imports.filter((i) => i.path === 'mqtt'));
    expect(mqttImports.length).toBeGreaterThan(0);
    for (const i of mqttImports) expect(i.kind).toBe('dynamic-import');
    expect(Object.keys(metafile.inputs).some((f) => f.includes('node_modules/aedes/'))).toBe(false);
  });
});

describe('./iot/device 子路徑（SDK ADR 0120）', () => {
  it('中立：零 Node 內建模組、零外部引用；只帶設備需要的協定層（不帶手機端、閘道、推播、連線池、中繼）', async () => {
    const metafile = await bundle('src/iot/device.ts');
    const external: string[] = [];
    for (const [file, input] of Object.entries(metafile.inputs)) for (const i of input.imports) if (i.external) external.push(`${file} → ${i.path}`);
    expect(external).toEqual([]);
    const allowed = ['device.ts', 'device-message.ts', 'device-frame.ts', 'envelope.ts', 'keys.ts', 'topic.ts', 'content.ts', 'kinds.ts'].map((f) => `src/iot/${f}`);
    const inputs = Object.keys(metafile.inputs).filter((f) => f.startsWith('src/'));
    expect(inputs.filter((f) => f.startsWith('src/iot/') && !allowed.some((a) => f.endsWith(a)))).toEqual([]);
    expect(inputs.filter((f) => f.endsWith('src/relay-pool.ts') || f.includes('src/relay/') || f.includes('src/deploy/'))).toEqual([]);
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
    exports: Record<string, unknown>;
    dependencies: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it('宣告了 ./iot 與 ./iot/bridge', () => {
    expect(pkg.exports['./iot']).toEqual({ types: './dist/iot/index.d.ts', import: './dist/iot/index.js' });
    expect(pkg.exports['./iot/bridge']).toEqual({ types: './dist/iot/bridge/index.d.ts', import: './dist/iot/bridge/index.js' });
    expect(pkg.exports['./iot/device']).toEqual({ types: './dist/iot/device.d.ts', import: './dist/iot/device.js' });
  });

  it('mqtt 是選用 peer 相依、不是一般相依；aedes 不在任何執行期相依裡', () => {
    expect(pkg.peerDependencies?.mqtt).toBeDefined();
    expect(pkg.peerDependenciesMeta?.mqtt?.optional).toBe(true);
    expect(pkg.dependencies.mqtt).toBeUndefined();
    expect(pkg.dependencies.aedes).toBeUndefined();
    expect(pkg.peerDependencies?.aedes).toBeUndefined();
  });

  it('打包後的套件（dist）以套件名稱引用得到', async () => {
    const iot = await import('@cinderous/client/iot');
    expect(typeof iot.IotClient).toBe('function');
    expect(typeof iot.IotGateway).toBe('function');
    expect(iot.IOT_KIND_COMMAND).toBe(25170);
    const bridge = await import('@cinderous/client/iot/bridge');
    expect(typeof bridge.startIotBridge).toBe('function');
    const device = await import('@cinderous/client/iot/device');
    expect(typeof device.connectIotDevice).toBe('function');
  }, 30_000); // 第一次載入打包後的 dist，整套平行跑、機器忙時超過預設 5 秒
});
