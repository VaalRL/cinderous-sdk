/** OR-Set 墓碑：`key`＝元素鍵、`at`＝刪除時間（毫秒）。與 ADR-0224 資產墓碑同構。 */
export interface OrSetTombstone {
    key: string;
    at: number;
}
/** 墓碑保留上限（顆）；超過取新到舊前 N。裝置最長離線期內不得回收，否則久離線裝置漏掉刪除。 */
export declare const OR_SET_TOMBSTONE_MAX = 256;
/**
 * 墓碑時間保留窗（毫秒）：預設 90 天。超過此窗的墓碑可回收（時間 GC）。
 * **必須 ≥ 裝置合理最長離線期**——否則一台久未上線的裝置回來時，刪除的墓碑已被 GC，
 * 它帶著舊的（未刪）版本合併就會讓刪掉的東西**復活**。90 天涵蓋絕大多數「抽屜裡的第二台」情境。
 */
export declare const OR_SET_TOMBSTONE_RETENTION_MS: number;
/** 丟棄早於 `olderThan`（毫秒）的墓碑（時間 GC）；`olderThan` 通常＝`now - 保留窗`。純函式。 */
export declare function pruneTombstonesByTime(tombstones: OrSetTombstone[], olderThan: number): OrSetTombstone[];
export interface MergeOrSetOpts<T> {
    /** 元素去重鍵（聯絡人＝pubkey、群組＝id、封鎖＝pubkey）。 */
    keyOf: (item: T) => string;
    /** 加入/更新時間（毫秒；缺＝0 最舊，同 ADR-0224）。 */
    atOf: (item: T) => number;
    /** 同 key 兩版內容擇一；預設 `at` 大者勝、平手用 key 字典序（交換律）。 */
    pick?: (a: T, b: T) => T;
    /** 存活集合上限；超過從尾端（`at` 最小的非保護者）淘汰。未設＝不限。 */
    max?: number;
    /** 墓碑保留上限（顆）；預設 {@link OR_SET_TOMBSTONE_MAX}。 */
    tombstoneMax?: number;
    /** 受保護元素（如自建/自己）永不因 `max` 淘汰。 */
    protect?: (item: T) => boolean;
}
/**
 * 合併兩端的 OR-Set（元素＋墓碑），回傳存活元素與清理後的墓碑。純函式、交換律、不變更輸入。
 */
export declare function mergeOrSet<T>(local: T[], remote: T[], localTombstones: OrSetTombstone[], remoteTombstones: OrSetTombstone[], opts: MergeOrSetOpts<T>): {
    items: T[];
    tombstones: OrSetTombstone[];
};
/** 單筆墓碑形狀是否合法（快照/外部來源逐筆過濾用）。 */
export declare function isWellFormedOrSetTombstone(x: unknown): x is OrSetTombstone;
//# sourceMappingURL=or-set.d.ts.map