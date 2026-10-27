/** 墓碑壽命：與快照壽命對齊（30 天）。超過就清掉，墓碑不會無限累積。 */
export declare const TOMBSTONE_TTL_MS: number;
/** 離線超過這麼久才回來的裝置視為「沉睡」：它的墓碑可能已被別台清掉。 */
export declare const STALE_DEVICE_MS: number;
export interface FileTombstone {
    path: string;
    /** 刪除時間（毫秒） */
    deletedAt: number;
}
/** 合併兩份墓碑清單：同一路徑取較新的刪除時間。可交換，任意順序合併結果都一樣。 */
export declare function mergeTombstones(a: readonly FileTombstone[], b: readonly FileTombstone[]): FileTombstone[];
/**
 * 這個檔案算不算已刪（PRD 的 LWW）：檔案的修改時間比墓碑新 ⇒ 刪了之後又重新建立，復活；否則已刪。
 * 平手算已刪：寧可不要讓刪掉的檔案復活。
 */
export declare function isDeleted(path: string, modifiedAt: number | undefined, tombstones: readonly FileTombstone[]): boolean;
/** 清掉超過壽命的墓碑。 */
export declare function gcTombstones(tombstones: readonly FileTombstone[], now: number, ttlMs?: number): FileTombstone[];
/**
 * 沉睡裝置隔離（PRD 2.6.1）：離線超過 30 天才回來，它手上的墓碑可能已被別台清掉，
 * 直接合併會讓別台早已刪掉的檔案復活 ⇒ 回 true，由 App 請使用者確認後再合併。
 * 從沒同步過的新裝置不算（它沒有舊資料可以復活）。
 */
export declare function isStaleDevice(lastSyncAt: number | undefined, now: number, thresholdMs?: number): boolean;
//# sourceMappingURL=tombstones.d.ts.map