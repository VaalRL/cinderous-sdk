// 把中繼 Worker（src/relay/worker.ts）打包成單一 ES module 字串，寫成可匯入的原始碼（SDK ADR 0021）。
//
// 為什麼：`@cinderous/client/deploy/cloudflare-api` 以 Cloudflare REST API 上傳 Worker，
// 需要已經打包好的 JS；外掛（Obsidian 桌面與行動版）不能在執行期跑打包工具。
// 產出的檔案進版控，`npm run check` 會確認它與原始碼一致（tests/deploy/relay-worker-bundle.test.ts 也會重打一次比對）。
//
// 用法：node scripts/build-relay-worker-bundle.mjs          寫檔
//       renderRelayWorkerBundleModule()                      測試用：只回傳內容，不寫檔
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
export const OUTPUT_PATH = `${root}src/deploy/cloudflare-api/relay-worker-bundle.ts`;
/** 版號與雜湊另存一個小檔（SDK ADR 0094）：只 import 它的程式不會把 Worker 本體打包進去 */
export const INFO_PATH = `${root}src/deploy/cloudflare-api/relay-worker-info.ts`;

/** 打包出 Worker 的 ES module 原始碼：轉出 Worker 本體、Durable Object 類別與注入版號的函式。 */
export async function bundleRelayWorker() {
  const result = await build({
    stdin: {
      contents: [
        "export { default, RelayRoom, IotHomeRoom } from './worker.js';",
        "export { setRelayVersion } from './version.js';",
      ].join('\n'),
      resolveDir: `${root}src/relay`,
      sourcefile: 'relay-worker-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    minify: true,
    legalComments: 'eof',
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/** 版號與雜湊的小檔（SDK ADR 0094）：`source` 是打包好的 Worker，雜湊算它的 UTF-8 位元組 */
export function renderRelayWorkerInfoModule(source) {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  return [
    '// 由 scripts/build-relay-worker-bundle.mjs 產生（SDK ADR 0094），不要手改；`npm run build` 會重新產生。',
    '',
    '/** 打包這份 Worker 時的 SDK 版號；部署時預設寫進 NIP-11 `version`。 */',
    `export const relayWorkerSdkVersion = ${JSON.stringify(pkg.version)};`,
    '',
    '/** 打包好的 Worker（`relayWorkerSource`）UTF-8 位元組的 SHA-256（十六進位）：部署時才下載 Worker 的外掛拿它比對 */',
    `export const relayWorkerSha256 = ${JSON.stringify(sha256)};`,
    '',
  ].join('\n');
}

export async function renderRelayWorkerBundleModule(source) {
  source ??= await bundleRelayWorker();
  return [
    '// 由 scripts/build-relay-worker-bundle.mjs 產生（SDK ADR 0021），不要手改；`npm run build` 會重新產生。',
    '',
    "export { relayWorkerSdkVersion } from './relay-worker-info.js';",
    '',
    '/**',
    ' * 中繼 Worker（`src/relay/worker.ts`）打包成的單一 ES module 原始碼。',
    ' * 轉出 `default`（Worker）、`RelayRoom`／`IotHomeRoom`（Durable Object）與 `setRelayVersion`。',
    ' */',
    `export const relayWorkerSource: string = ${JSON.stringify(source)};`,
    '',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const source = await bundleRelayWorker();
  writeFileSync(OUTPUT_PATH, await renderRelayWorkerBundleModule(source));
  writeFileSync(INFO_PATH, renderRelayWorkerInfoModule(source));
}
