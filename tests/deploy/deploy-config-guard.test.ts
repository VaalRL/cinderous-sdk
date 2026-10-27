// 守門（SDK ADR 0050 §2）：設定檔、描述表、驗證、部署包與說明的產生器（./deploy/config 與 render.ts）不得碰 Node——
// CLI、未來的網頁設定器（P3）與外掛的行動版共用同一份。做法同 cloudflare-api-guard：用 esbuild 實際打包一次，看 metafile。
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
    write: false,
    metafile: true,
    logLevel: 'silent',
    external: nodeBuiltins,
  });
  return result.metafile;
}

function externalImports(metafile: Metafile): string[] {
  const found: string[] = [];
  for (const [file, input] of Object.entries(metafile.inputs)) {
    for (const imported of input.imports) if (imported.external) found.push(`${file} → ${imported.path}`);
  }
  return found;
}

describe('./deploy/config 零 Node 依賴', () => {
  for (const entry of ['src/deploy/config/index.ts', 'src/deploy/render.ts']) {
    it(`${entry}：模組圖裡沒有任何 Node 內建模組`, async () => {
      expect(externalImports(await bundle(entry))).toEqual([]);
    });
  }

  it('沒有把 wrangler／docker／fly 的部署本體、CLI 或打包好的 Worker 拉進來', async () => {
    const inputs = Object.keys((await bundle('src/deploy/config/index.ts')).inputs);
    for (const file of ['cloudflare.ts', 'common.ts', 'container.ts', 'docker.ts', 'fly.ts', 'build.ts']) {
      expect(inputs).not.toContain(`src/deploy/${file}`);
    }
    expect(inputs.some((file) => file.includes('relay-worker-bundle') || file.includes('src/cli/') || file.endsWith('cloudflare-api/deploy.ts'))).toBe(false);
  });

  it('對照組：./deploy 的 build.ts 確實有 Node 內建模組——守門抓得到', async () => {
    expect(externalImports(await bundle('src/deploy/build.ts')).some((line) => /node:fs/.test(line))).toBe(true);
  });
});
