// 批次串流在 `./transfer` 子路徑（SDK ADR 0026 §1）：零 Node 內建模組；主入口不帶進來（打包大小不變）。
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

import * as main from '../../src/index.js';
import * as transfer from '../../src/transfer/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'node:*'];

async function bundle(entry: string): Promise<Metafile> {
  const result = await build({
    entryPoints: [`${root}${entry}`],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    minify: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
    external: nodeBuiltins,
  });
  return result.metafile;
}

describe('./transfer 的批次串流', () => {
  it('子路徑匯出批次串流與可持久化的佇列', () => {
    for (const name of ['StreamTransfer', 'MemoryStreamingStore', 'P2PStreamQueue', 'hashSource', 'bytesEntry', 'isStreamMessage', 'STREAM_WIRE_VERSION'] as const) {
      expect(transfer[name], name).toBeDefined();
    }
  });

  it('零 Node 內建模組（Obsidian 行動版沒有 Node）', async () => {
    const metafile = await bundle('src/transfer/index.ts');
    const external = Object.values(metafile.inputs).flatMap((input) => input.imports.filter((i) => i.external).map((i) => i.path));
    expect(external).toEqual([]);
  });

  it('主入口不帶進批次串流（打包大小不因這一批而變大）', async () => {
    const metafile = await bundle('src/index.ts');
    expect(Object.keys(metafile.inputs).some((f) => f.includes('transfer/stream'))).toBe(false);
    expect('StreamTransfer' in main).toBe(false);
  });
});
