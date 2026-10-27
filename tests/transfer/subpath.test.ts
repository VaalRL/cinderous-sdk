// `@cinderous/client/transfer` 子路徑（SDK ADR 0023 §1）：外掛不必為了檔案傳輸載入整個主入口。
// 主入口繼續轉出同一批名稱（相容），而且必須是**同一個實作**——兩份 class 會讓 instanceof 失效。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as main from '../../src/index.js';
import * as transfer from '../../src/transfer/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

const RUNTIME_NAMES = [
  'blobSource',
  'bytesSource',
  'DEFAULT_FILE_CHUNK_BYTES',
  'DEFAULT_MAX_FILE_BYTES',
  'FileIntegrityError',
  'FileRejectedError',
  'FileTransfer',
  'isFileTransferMessage',
  'LargeFileOverRelayError',
  'MemoryPartialStore',
  'P2PFileQueue',
] as const;

describe('./transfer 子路徑', () => {
  it('匯出檔案傳輸的全部執行期名稱', () => {
    for (const name of RUNTIME_NAMES) expect(transfer[name], name).toBeDefined();
  });

  it('與主入口是同一個實作（同一個參照），主入口仍然轉出', () => {
    for (const name of RUNTIME_NAMES) expect(main[name], name).toBe(transfer[name]);
  });

  it('package.json 宣告了 ./transfer，指向 dist/transfer/index', () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(pkg.exports['./transfer']).toEqual({
      types: './dist/transfer/index.d.ts',
      import: './dist/transfer/index.js',
    });
  });

  it('打包後的套件（dist）也是同一個實作：以套件名稱自我引用', async () => {
    const [viaMain, viaSubpath] = await Promise.all([
      import('@cinderous/client'),
      import('@cinderous/client/transfer'),
    ]);
    expect(viaSubpath.FileTransfer).toBe(viaMain.FileTransfer);
    expect(viaSubpath.P2PFileQueue).toBe(viaMain.P2PFileQueue);
  });
});
