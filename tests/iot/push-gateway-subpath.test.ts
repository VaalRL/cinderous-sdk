// 守門（SDK ADR 0049 §8、§11.1）：
// 1. 主入口、`./iot` 與其他子路徑不帶進推播閘道、`node:http2` 或 MQTT 套件；
// 2. `./iot/push-gateway` 與 `./iot/push-gateway/worker` 中立：零 Node 內建模組、零外部引用（能進 Workers）；
// 3. `./iot/push-gateway/node` 只在這裡用 `node:http`／`node:http2`，沒有 MQTT。
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

const externalImports = (metafile: Metafile): string[] => {
  const out: string[] = [];
  for (const [file, input] of Object.entries(metafile.inputs)) for (const i of input.imports) if (i.external) out.push(`${file} → ${i.path}`);
  return out;
};
const pushGatewayInputs = (metafile: Metafile): string[] => Object.keys(metafile.inputs).filter((f) => f.includes('src/iot/push-gateway/'));
const mqttInputs = (metafile: Metafile): string[] => Object.keys(metafile.inputs).filter((f) => MQTT_PACKAGES.some((name) => f.includes(`node_modules/${name}/`)));

describe('推播閘道不進主入口與 ./iot', () => {
  for (const entry of ['src/index.ts', 'src/iot/index.ts', 'src/protocol/index.ts', 'src/sync/index.ts', 'src/deploy/config/index.ts', 'src/relay/index.ts']) {
    it(`${entry} 不含推播閘道、node:http2、MQTT`, async () => {
      const metafile = await bundle(entry);
      expect(pushGatewayInputs(metafile)).toEqual([]);
      expect(externalImports(metafile).filter((i) => i.includes('http2'))).toEqual([]);
      expect(mqttInputs(metafile)).toEqual([]);
    });
  }

  it('./iot/bridge 也不含推播閘道', async () => {
    const metafile = await bundle('src/iot/bridge/index.ts', 'node', [...nodeBuiltins, 'mqtt', 'ws']);
    expect(pushGatewayInputs(metafile)).toEqual([]);
  });
});

describe('./iot/push-gateway 與 ./iot/push-gateway/worker 中立', () => {
  for (const entry of ['src/iot/push-gateway/index.ts', 'src/iot/push-gateway/worker.ts']) {
    it(`${entry}：零 Node 內建模組、零外部引用、沒有 MQTT、沒有中繼與連線池`, async () => {
      const metafile = await bundle(entry);
      expect(externalImports(metafile)).toEqual([]);
      expect(mqttInputs(metafile)).toEqual([]);
      expect(Object.keys(metafile.inputs).filter((f) => f.includes('src/relay/') || f.endsWith('src/relay-pool.ts') || f.includes('src/iot/bridge/'))).toEqual([]);
    });
  }
});

describe('./iot/push-gateway/node', () => {
  it('只用 node:http／node:http2，沒有 MQTT', async () => {
    const metafile = await bundle('src/iot/push-gateway/node.ts', 'node');
    const builtins = [...new Set(externalImports(metafile).map((i) => i.split(' → ')[1]!))].sort();
    expect(builtins).toEqual(['node:http', 'node:http2']);
    expect(mqttInputs(metafile)).toEqual([]);
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { exports: Record<string, unknown> };

  it('宣告了三個推播閘道子路徑', () => {
    expect(pkg.exports['./iot/push-gateway']).toEqual({ types: './dist/iot/push-gateway/index.d.ts', import: './dist/iot/push-gateway/index.js' });
    expect(pkg.exports['./iot/push-gateway/worker']).toEqual({ types: './dist/iot/push-gateway/worker.d.ts', import: './dist/iot/push-gateway/worker.js' });
    expect(pkg.exports['./iot/push-gateway/node']).toEqual({ types: './dist/iot/push-gateway/node.d.ts', import: './dist/iot/push-gateway/node.js' });
  });

  it('打包後的套件（dist）以套件名稱引用得到', async () => {
    const core = await import('@cinderous/client/iot/push-gateway');
    expect(typeof core.createPushGatewayHandler).toBe('function');
    const w = await import('@cinderous/client/iot/push-gateway/worker');
    expect(typeof w.PushGatewayState).toBe('function');
    expect(typeof w.default.fetch).toBe('function');
    const n = await import('@cinderous/client/iot/push-gateway/node');
    expect(typeof n.startNodePushGateway).toBe('function');
  }, 30_000); // 第一次載入打包後的 dist，整套平行跑、機器忙時超過預設 5 秒
});
