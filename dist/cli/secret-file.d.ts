/**
 * 把秘密寫進 `dir/name`，回傳實際寫入的路徑。
 *
 * - 資料夾不存在就建立（POSIX 700）；裡面放一個只有 `*` 的 `.gitignore`——不靠使用者專案根目錄的 `.gitignore`
 *   有沒有寫 `.secrets/`（已經有 `.gitignore` 就不動）。
 * - 檔案 600，以 `wx` 開檔：🔴 **絕不覆寫**。同名檔已存在（同一秒跑兩次、或舊的那把仍在寬限期內）就改名 `-2`、`-3`…
 * - Windows 沒有 POSIX 權限位元；檔案權限沿用使用者資料夾的 ACL。
 */
export declare function writeSecretFileToDisk(dir: string, name: string, content: string): string;
//# sourceMappingURL=secret-file.d.ts.map