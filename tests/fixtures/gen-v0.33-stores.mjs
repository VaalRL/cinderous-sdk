// 產生 `v0.33-stores.mjs`（SDK ADR 0042）：v0.33.0 的 `MessageStore` 與 `SqlMessageStore`，原樣打包成一個 ES module。
//
// 用途（tests/relay/capacity-compat.test.ts）：
// 1. **向下相容**：同一串寫入分別丟給 v0.33 與現在的 store（都不設容量選項），每一則的結果與最後庫裡的內容要一模一樣。
// 2. **回滾**：現在的建構子遷移過的 SQLite（多了 `borrowed` 欄、部分索引、`inbox_drops` 表），交給 v0.33 的程式照常讀寫。
//    v0.33 的 schema 與 Cinderous main（ADR-0375／0376／0377）逐字相同（schema-compat.test.ts 釘住），所以這也代表錨點回滾。
//
// 用法（repo 根目錄）：node tests/fixtures/gen-v0.33-stores.mjs
// 需要 git 與 v0.33.0 這個 tag；產物進版控，平常跑測試不需要重產。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('../..', import.meta.url));
const TAG = 'v0.33.0';
const dir = mkdtempSync(join(tmpdir(), 'sdk-v033-'));
try {
  // 逐檔 `git show`（不用 tar：Windows 的 GNU tar 會把 `C:` 當成遠端主機）
  const files = execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', TAG, 'src/relay', 'src/protocol'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), execFileSync('git', ['-C', root, 'show', `${TAG}:${file}`]));
  }
  const result = await build({
    stdin: {
      contents: [
        "export { MessageStore } from './message-store.ts';",
        "export { SqlMessageStore } from './sql-message-store.ts';",
      ].join('\n'),
      resolveDir: join(dir, 'src', 'relay'),
      sourcefile: 'entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    legalComments: 'none',
    charset: 'utf8',
  });
  const header = [
    `// 由 tests/fixtures/gen-v0.33-stores.mjs 從 ${TAG} 產生（SDK ADR 0042），不要手改。`,
    '// @ts-nocheck',
    '',
  ].join('\n');
  writeFileSync(join(root, 'tests', 'fixtures', 'v0.33-stores.mjs'), header + result.outputFiles[0].text);
  console.log('wrote tests/fixtures/v0.33-stores.mjs');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
