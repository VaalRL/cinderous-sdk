import type { SyncStateStore } from './types.js';
/** 記憶體實作：測試與範例用。`snapshot()`／`fromSnapshot` 可模擬「重新啟動、狀態還在」。 */
export declare class MemorySyncStateStore implements SyncStateStore {
    #private;
    constructor(initial?: ReadonlyMap<string, Uint8Array>);
    get(key: string): Promise<Uint8Array | null>;
    set(key: string, value: Uint8Array): Promise<void>;
    delete(key: string): Promise<void>;
    keys(prefix: string): Promise<string[]>;
    /** 目前內容的複本 */
    snapshot(): Map<string, Uint8Array>;
    get size(): number;
}
/**
 * 同一個鍵的寫入依序完成；讀取等排在前面的寫入完成。寫入失敗會往上拋給呼叫端，
 * 但鏈本身不會變成 rejected（之後的寫入照常執行）。
 */
export declare class SerializedStore {
    #private;
    constructor(inner: SyncStateStore);
    get(key: string): Promise<Uint8Array | null>;
    set(key: string, value: Uint8Array): Promise<void>;
    delete(key: string): Promise<void>;
    keys(prefix: string): Promise<string[]>;
    /** 等所有排隊中的寫入完成 */
    flush(): Promise<void>;
}
export declare function encodeJson(value: unknown): Uint8Array;
export declare function decodeJson<T>(bytes: Uint8Array | null): T | null;
//# sourceMappingURL=state-store.d.ts.map