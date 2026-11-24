/** CRC-32（IEEE 802.3，zip／gzip 用的那個） */
export declare function crc32(data: Uint8Array): number;
export interface ZipEntry {
    /** 以 `/` 分隔的相對路徑 */
    path: string;
    /** 文字以 UTF-8 寫入 */
    content: string | Uint8Array;
}
export interface CreateZipOptions {
    /** 檔案的修改時間（預設現在）；給固定值可以得到逐位元組相同的 zip */
    date?: Date;
    /** 把所有檔案放進這個資料夾底下 */
    root?: string;
}
/**
 * 相對路徑而且留在原目錄裡：不是絕對路徑、沒有磁碟代號、沒有反斜線、沒有 `..`／`.`／空段。
 * zip 的檔名（zip slip）與 `relay build` 清單裡的路徑共用這一條規則。
 */
export declare function isSafeRelativePath(path: string): boolean;
/** 把檔案打成 STORE（不壓縮）的 zip；回傳整個檔案的位元組 */
export declare function createStoreZip(entries: readonly ZipEntry[], opts?: CreateZipOptions): Uint8Array;
//# sourceMappingURL=zip.d.ts.map