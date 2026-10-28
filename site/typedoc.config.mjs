// API 參考（SDK ADR 0115）：TypeDoc 從發佈出去的 dist/*.d.ts 產生 HTML，放在 VitePress 產出的 api/。
// 入口點＝package.json 的 exports（有型別的子路徑），不另外維護清單；`npm run docs:build` 先建 VitePress 再跑這裡。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// TypeDoc 的入口點是 glob：Windows 的反斜線要換成 /
const root = fileURLToPath(new URL('..', import.meta.url)).replaceAll('\\', '/');

/** 子路徑匯出 → 它的 .d.ts（相對 repo 根目錄）；沒有型別的（JSON Schema）略過 */
export function apiEntryPoints(exports) {
  return Object.values(exports)
    .map((target) => (typeof target === 'object' && target !== null ? target.types : undefined))
    .filter((types) => typeof types === 'string')
    .map((types) => types.replace(/^\.\//, ''));
}

/** TypeDoc 的模組名稱（`index`、`relay/node`）→ 使用方 import 的寫法 */
export function importPath(moduleName) {
  return moduleName === 'index' ? '@cinderous/client' : `@cinderous/client/${moduleName}`;
}

export const API_OUT = fileURLToPath(new URL('./.vitepress/dist/api', import.meta.url));

const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));

/** @type {import('typedoc').TypeDocOptions} */
export default {
  name: `Cinderous SDK ${pkg.version} API`,
  entryPoints: apiEntryPoints(pkg.exports).map((entry) => `${root}${entry}`),
  tsconfig: `${root}tsconfig.typedoc.json`,
  plugin: [`${root}site/typedoc-plugin.mjs`],
  out: API_OUT,
  readme: 'none',
  // 來源是 .d.ts，連回去沒有意義；說明、型別、註解都在頁面上
  disableSources: true,
  excludePrivate: true,
  excludeInternal: true,
  hostedBaseUrl: 'https://vaalrl.github.io/cinderous-sdk/api/',
  navigationLinks: {
    Guide: 'https://vaalrl.github.io/cinderous-sdk/',
    GitHub: 'https://github.com/VaalRL/cinderous-sdk',
  },
  // 不連外部字型或追蹤（與 VitePress 網站相同，ADR 0113）
  githubPages: true,
  // 註解是中英混寫的散文，不要求每個匯出都有說明；連不到的 {@link} 讓建置失敗（ADR 0115 補充）
  validation: { notExported: false, invalidLink: true, notDocumented: false },
  treatWarningsAsErrors: true,
  logLevel: 'Warn',
};
