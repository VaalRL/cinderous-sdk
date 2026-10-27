// `@cinderous/client/pairing` 子路徑（SDK ADR 0028 §1）：零 Node 內建模組、不拉進連線池執行期／部署／中繼／同步；
// 主入口與其他子路徑不帶進配對；package.json 宣告了子路徑；打包後以套件名稱引用得到。
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
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

describe('./pairing 子路徑', () => {
  it('零 Node 內建模組；不拉進連線池執行期、部署、中繼、同步', async () => {
    const { metafile } = await bundle('src/pairing/index.ts');
    const external: string[] = [];
    for (const [file, input] of Object.entries(metafile.inputs)) for (const i of input.imports) if (i.external) external.push(`${file} → ${i.path}`);
    expect(external).toEqual([]);
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.some((f) => f.includes('relay-pool') || f.includes('/deploy/') || f.includes('/relay/') || f.includes('/sync/'))).toBe(false);
  });

  for (const entry of ['src/index.ts', 'src/sync/index.ts', 'src/sync/vault/index.ts', 'src/transfer/index.ts', 'src/protocol/index.ts']) {
    it(`${entry} 不含配對`, async () => {
      const { metafile } = await bundle(entry);
      expect(Object.keys(metafile.inputs).some((file) => file.includes('src/pairing/'))).toBe(false);
    });
  }

  it('package.json 宣告了 ./pairing', () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { exports: Record<string, { types: string; import: string }> };
    expect(pkg.exports['./pairing']).toEqual({ types: './dist/pairing/index.d.ts', import: './dist/pairing/index.js' });
  });

  it('打包後的套件（dist）以套件名稱引用得到', async () => {
    const pairing = await import('@cinderous/client/pairing');
    expect(typeof pairing.createPairingOffer).toBe('function');
    expect(typeof pairing.VaultMembership).toBe('function');
    expect(pairing.PAIRING_KIND).toBe(21003);
    expect(pairing.VAULT_ROSTER_KIND).toBe(4361);
  }, 30_000); // 第一次載入打包後的 dist，整套平行跑、機器忙時超過預設 5 秒
});
