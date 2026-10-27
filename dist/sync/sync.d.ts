/** 可變狀態的一筆值（last-writer-wins 以 updatedAt 比較）。 */
export interface MutableEntry {
    value: string;
    updatedAt: number;
}
/** 一次增量同步：新訊息（以 id 去重）與可變狀態變更（LWW）。 */
export interface SyncDelta {
    messages?: ReadonlyArray<{
        id: string;
    }>;
    state?: Record<string, MutableEntry>;
}
/** 多設備同步的資源上限（A5：防惡意/失控 delta 撐爆記憶體）。 */
export interface DeviceSyncLimits {
    /** 保留的訊息 id 數上限（超過即逐出最舊）。預設 100,000。 */
    maxMessages?: number;
    /** 可變狀態鍵數上限（超過即逐出 `updatedAt` 最舊者）。預設 10,000。 */
    maxStateKeys?: number;
}
/**
 * 多設備同步的本機收斂狀態：
 * - 訊息以 event id 去重（集合語意，順序無關）。
 * - 可變狀態（已讀位置、暱稱、封鎖等）採 last-writer-wins。
 *
 * 兩者皆為交換律（commutative）：不同設備以任意順序套用相同的 delta，
 * 最終會收斂到一致狀態。
 *
 * **A5 上限**：為防惡意或失控 delta 無限撐大記憶體，保留量有上限——訊息逐出最舊、
 * 可變狀態逐出最舊更新者。上限遠高於正常用量，故正常運作下不會逐出、收斂性不受影響；
 * 逐出僅作為濫用時的安全閥（此時已非正常收斂情境）。
 */
export declare class DeviceSyncState {
    private readonly seen;
    private readonly order;
    private readonly state;
    private readonly maxMessages;
    private readonly maxStateKeys;
    constructor(limits?: DeviceSyncLimits);
    apply(delta: SyncDelta): void;
    /** 逐出 `updatedAt` 最舊的可變狀態鍵（狀態滿載時的安全閥）。 */
    private evictOldestState;
    /** 目前已知的所有訊息 id（依首次出現順序）。 */
    messageIds(): string[];
    /** 取得某可變狀態鍵的當前值。 */
    get(key: string): string | undefined;
}
//# sourceMappingURL=sync.d.ts.map