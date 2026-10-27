// `@cinderous/client/sync/vault` 子路徑（SDK ADR 0025 §1）：
// 1. 模組圖裡沒有任何 Node 內建模組（Obsidian 行動版沒有 Node）；
// 2. 主入口與 `./sync` 不帶進協調器（它們的打包大小不因這一批而變大）；
// 3. package.json 宣告了子路徑，打包後（dist）以套件名稱引用得到。
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'node:*'];

async function bundle(entry: string): Promise<{ metafile: Metafile; size: number }> {
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
  return { metafile: result.metafile, size: result.outputFiles[0]!.contents.length };
}

function externalImports(metafile: Metafile): string[] {
  const found: string[] = [];
  for (const [file, input] of Object.entries(metafile.inputs)) {
    for (const imported of input.imports) if (imported.external) found.push(`${file} → ${imported.path}`);
  }
  return found;
}

describe('./sync/vault 子路徑', () => {
  it('零 Node 內建模組', async () => {
    const { metafile } = await bundle('src/sync/vault/index.ts');
    expect(externalImports(metafile)).toEqual([]);
    // 不把連線池的執行期、部署或中繼拉進來（只用型別）
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.some((f) => f.includes('relay-pool') || f.includes('/deploy/') || f.includes('/relay/'))).toBe(false);
  });

  for (const entry of ['src/index.ts', 'src/sync/index.ts', 'src/transfer/index.ts', 'src/protocol/index.ts']) {
    it(`${entry} 不含協調器`, async () => {
      const { metafile } = await bundle(entry);
      expect(Object.keys(metafile.inputs).some((file) => file.includes('sync/vault/'))).toBe(false);
    });
  }

  it('package.json 宣告了 ./sync/vault', () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { exports: Record<string, { types: string; import: string }> };
    expect(pkg.exports['./sync/vault']).toEqual({ types: './dist/sync/vault/index.d.ts', import: './dist/sync/vault/index.js' });
  });

  it('打包後的套件（dist）以套件名稱引用得到', async () => {
    const vault = await import('@cinderous/client/sync/vault');
    expect(typeof vault.VaultSyncCoordinator).toBe('function');
    expect(typeof vault.createNostrVaultTransport).toBe('function');
    expect(vault.VAULT_OP_KIND).toBe(4360);
  }, 30_000); // 第一次載入打包後的整個 dist，整套平行跑、機器忙時超過預設 5 秒

  // SDK ADR 0047：排除規則給設定頁單獨用（不必帶進協調器），零 Node、零相依
  it('排除規則（path-filter）零 Node、不依賴任何模組、單獨打包很小', async () => {
    const { metafile, size } = await bundle('src/sync/vault/path-filter.ts');
    expect(externalImports(metafile)).toEqual([]);
    expect(Object.keys(metafile.inputs)).toEqual(['src/sync/vault/path-filter.ts']);
    expect(size).toBeLessThan(8 * 1024);
  });

  it('dist 匯出排除規則的 API', async () => {
    const vault = await import('@cinderous/client/sync/vault');
    expect(typeof vault.compileSyncExcludes).toBe('function');
    expect(typeof vault.compilePathFilter).toBe('function');
    expect(typeof vault.validatePattern).toBe('function');
    expect(vault.DEFAULT_USER_EXCLUDES).toContain('.DS_Store');
    expect(vault.compileSyncExcludes({ fixed: ['.*'] }).isExcluded('a/Thumbs.db')).toBe(true);
  });
});
