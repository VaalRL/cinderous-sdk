// 守門（SDK ADR 0021）：
// 1. `./deploy/cloudflare-api` 的模組圖裡不得出現任何 Node 內建模組——Obsidian 行動版沒有 Node，
//    只要有一個就會在載入時崩潰；也不得把 wrangler 路徑（cloudflare.ts／common.ts）拉進來。
// 2. 主入口與其他子路徑不得帶進打包好的中繼 Worker（約 60KB），它只屬於這個子路徑。
// 做法：用 esbuild 實際打包一次，看 metafile 的輸入與外部引用。
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
    // 內建模組標成外部，才能在 metafile 裡把它們找出來（而不是讓打包直接失敗、看不出是誰引用的）
    external: nodeBuiltins,
  });
  return { metafile: result.metafile, size: result.outputFiles[0]!.contents.length };
}

/** 模組圖裡所有「外部」引用（也就是 Node 內建模組），附上是誰引用的 */
function externalImports(metafile: Metafile): string[] {
  const found: string[] = [];
  for (const [file, input] of Object.entries(metafile.inputs)) {
    for (const imported of input.imports) if (imported.external) found.push(`${file} → ${imported.path}`);
  }
  return found;
}

describe('./deploy/cloudflare-api 零 Node 依賴', () => {
  it('模組圖裡沒有任何 Node 內建模組（node:*、fs、child_process、path…）', async () => {
    const { metafile } = await bundle('src/deploy/cloudflare-api/index.ts');
    expect(externalImports(metafile)).toEqual([]);
  });

  it('沒有把 wrangler 路徑（cloudflare.ts、common.ts、container／docker／fly）拉進來', async () => {
    const { metafile } = await bundle('src/deploy/cloudflare-api/index.ts');
    const inputs = Object.keys(metafile.inputs);
    for (const file of ['cloudflare.ts', 'common.ts', 'container.ts', 'docker.ts', 'fly.ts']) {
      expect(inputs).not.toContain(`src/deploy/${file}`);
    }
    expect(inputs).toContain('src/deploy/cloudflare-api/relay-worker-bundle.ts');
  });

  it('對照組：./deploy（wrangler 路徑）確實有 Node 內建模組——守門測試真的抓得到', async () => {
    const { metafile } = await bundle('src/deploy/index.ts');
    expect(externalImports(metafile).some((line) => /node:child_process/.test(line))).toBe(true);
  });
});

describe('打包好的中繼 Worker 只屬於 ./deploy/cloudflare-api', () => {
  // 部署設定器（SDK ADR 0050 §5）的說明要嵌 Token 指南（ADR 0022 的資料）：./deploy 與 ./deploy/config 只准帶進
  // 這三個純資料／純函式的檔案，打包好的 Worker 與 REST 部署本體仍然不行。
  const TOKEN_GUIDE_FILES = ['src/deploy/cloudflare-api/guide.ts', 'src/deploy/cloudflare-api/auth.ts', 'src/deploy/cloudflare-api/http.ts'];
  for (const entry of ['src/index.ts', 'src/protocol/index.ts', 'src/sync/index.ts', 'src/deploy/index.ts', 'src/deploy/config/index.ts']) {
    it(`${entry} 不含 relay-worker-bundle`, async () => {
      const { metafile } = await bundle(entry);
      const allowed = entry.startsWith('src/deploy/') ? TOKEN_GUIDE_FILES : [];
      expect(Object.keys(metafile.inputs).some((file) => file.includes('relay-worker-bundle'))).toBe(false);
      expect(Object.keys(metafile.inputs).filter((file) => file.includes('deploy/cloudflare-api') && !allowed.includes(file))).toEqual([]);
    });
  }
});
