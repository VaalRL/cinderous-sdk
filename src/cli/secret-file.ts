// 一次性秘密的落盤（SDK ADR 0137，ADR 0050 §4 的 `.secrets/`）：`--save-secrets`／`--secrets-dir` 用。
// 只給 CLI 進入點用（node:fs）；`runCli` 經 `CliDeps.writeSecretFile` 注入，測試換成假的。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/**
 * 把秘密寫進 `dir/name`，回傳實際寫入的路徑。
 *
 * - 資料夾不存在就建立（POSIX 700）；裡面放一個只有 `*` 的 `.gitignore`——不靠使用者專案根目錄的 `.gitignore`
 *   有沒有寫 `.secrets/`（已經有 `.gitignore` 就不動）。
 * - 檔案 600，以 `wx` 開檔：🔴 **絕不覆寫**。同名檔已存在（同一秒跑兩次、或舊的那把仍在寬限期內）就改名 `-2`、`-3`…
 * - Windows 沒有 POSIX 權限位元；檔案權限沿用使用者資料夾的 ACL。
 */
export function writeSecretFileToDisk(dir: string, name: string, content: string): string {
  if (name !== basename(name) || name === '' || name === '.' || name === '..') {
    throw new Error(`秘密檔名不能帶路徑：${name}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) {
    try {
      writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o644 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const path = join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
    try {
      writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`${dir} 裡 ${name} 的同名檔太多，請先整理`);
}
