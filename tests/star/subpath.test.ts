// `@cinderous/client/star` 子路徑（SDK ADR 0030 §10）：零 Node 內建模組、不拉進連線池執行期／部署／中繼／同步／傳檔；
// 主入口與其他子路徑不帶進星狀會話（主入口打包大小不變）；package.json 宣告了子路徑；打包後以套件名稱引用得到。
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

import * as main from '../../src/index.js';

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

describe('./star 子路徑', () => {
  it('零 Node 內建模組；不拉進連線池執行期、部署、中繼、同步、傳檔', async () => {
    const { metafile } = await bundle('src/star/index.ts');
    const external: string[] = [];
    for (const [file, input] of Object.entries(metafile.inputs)) for (const i of input.imports) if (i.external) external.push(`${file} → ${i.path}`);
    expect(external).toEqual([]);
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.filter((f) => f.includes('relay-pool') || f.includes('/deploy/') || f.includes('src/relay/') || f.includes('/sync/') || f.includes('/transfer/'))).toEqual([]);
  });

  for (const entry of ['src/index.ts', 'src/sync/index.ts', 'src/sync/vault/index.ts', 'src/transfer/index.ts', 'src/protocol/index.ts', 'src/pairing/index.ts']) {
    it(`${entry} 不含星狀會話`, async () => {
      const { metafile } = await bundle(entry);
      expect(Object.keys(metafile.inputs).some((file) => file.includes('src/star/'))).toBe(false);
    });
  }

  it('主入口不匯出星狀會話', () => {
    expect('StarHost' in main).toBe(false);
    expect('StarMember' in main).toBe(false);
  });

  it('package.json 宣告了 ./star', () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { exports: Record<string, { types: string; import: string }> };
    expect(pkg.exports['./star']).toEqual({ types: './dist/star/index.d.ts', import: './dist/star/index.js' });
  });

  it('打包後的套件（dist）以套件名稱引用得到', async () => {
    const star = await import('@cinderous/client/star');
    expect(typeof star.StarHost).toBe('function');
    expect(typeof star.StarMember).toBe('function');
    expect(star.STAR_MAGIC).toBe(0xc5);
    expect(star.STAR_INVITE_PREFIX).toBe('cinderous-star:');
  }, 30_000); // 第一次載入打包後的 dist，整套平行跑、機器忙時超過預設 5 秒
});
