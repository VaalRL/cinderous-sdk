// `@cinderous/client/durability` 子路徑（SDK ADR 0041）：零 Node 內建模組、不拉進連線池執行期；
// 主入口與其他子路徑不帶進稽核與中繼清單；package.json 宣告了子路徑；打包後以套件名稱引用得到。
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

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

describe('./durability 子路徑', () => {
  it('零 Node 內建模組；不拉進連線池執行期（只用型別）、部署、中繼', async () => {
    const metafile = await bundle('src/durability/index.ts');
    const external: string[] = [];
    for (const [file, input] of Object.entries(metafile.inputs)) for (const i of input.imports) if (i.external) external.push(`${file} → ${i.path}`);
    expect(external).toEqual([]);
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.some((f) => f.includes('relay-pool') || f.includes('relay-health') || f.includes('/deploy/') || f.includes('/relay/'))).toBe(false);
  });

  for (const entry of ['src/index.ts', 'src/sync/vault/index.ts', 'src/pairing/index.ts', 'src/protocol/index.ts']) {
    it(`${entry} 不含稽核與中繼清單`, async () => {
      const metafile = await bundle(entry);
      expect(Object.keys(metafile.inputs).some((file) => file.includes('src/durability/'))).toBe(false);
    });
  }

  it('./sync/vault 與 ./pairing 不拉進健康狀態（連線池內部）', async () => {
    for (const entry of ['src/sync/vault/index.ts', 'src/pairing/index.ts']) {
      const metafile = await bundle(entry);
      expect(Object.keys(metafile.inputs).some((file) => file.includes('relay-health')), entry).toBe(false);
    }
  });

  it('package.json 宣告了 ./durability', () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { exports: Record<string, { types: string; import: string }> };
    expect(pkg.exports['./durability']).toEqual({ types: './dist/durability/index.d.ts', import: './dist/durability/index.js' });
  });

  it('打包後的套件（dist）以套件名稱引用得到', async () => {
    const durability = await import('@cinderous/client/durability');
    expect(typeof durability.auditOwnEvents).toBe('function');
    expect(typeof durability.OwnEventAuditor).toBe('function');
    expect(durability.RELAY_LIST_KIND).toBe(10002);
    expect(durability.DM_RELAY_LIST_KIND).toBe(10050);
  }, 30_000); // 第一次載入打包後的 dist，整套平行跑、機器忙時超過預設 5 秒
});
