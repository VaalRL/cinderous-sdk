/** 序號區間 [lo, hi]（含兩端），依 lo 排序、不重疊 */
export type SeqRange = [number, number];
/** 一份簽收單最多幾段區間（codec 也照這個上限驗） */
export declare const MAX_RECEIPT_RANGES = 1000;
/** 把 [lo, hi] 併進區間清單（合併重疊與相鄰的）；回傳新的清單 */
export declare function addRange(ranges: readonly SeqRange[], lo: number, hi: number): SeqRange[];
export declare function coversRange(ranges: readonly SeqRange[] | undefined, n: number): boolean;
/** 一筆帳 */
export interface LedgerEntry {
    /** 寄件序號；0＝沒有序號（舊版的帳、簽收單本身）：簽收不掉，只會過期 */
    rs: number;
    /** 佔幾塊（每位收件人） */
    f: number;
    /** 送出的小時（`floor(毫秒 / 1 小時)`）；記帳時省略＝現在 */
    h?: number;
    /** 只送給這些裝置；省略＝廣播 */
    to?: string[];
    /** 這則帶了哪些版本（`[fileId, nodeId]`）：收件人簽收了就表示它有這些版本 */
    v?: Array<[string, string]>;
}
/** 持久化格式：`e` 每筆 `[rs, f, h, to | 0, v?]`；`k` 每台的簽收區間；`j` 每台第一次成為收件人的小時（SDK ADR 0107） */
export interface RelayLedgerJSON {
    e: Array<[number, number, number, string[] | 0, Array<[string, string]>?] | [number, number, number]>;
    k: Record<string, SeqRange[]>;
    j?: Record<string, number>;
}
export interface RelayLedgerOptions {
    now: () => number;
    /** 保存期（毫秒） */
    windowMs: () => number;
}
export declare class RelayLedger {
    #private;
    constructor(opts: RelayLedgerOptions);
    /** 從持久化資料還原；`legacy`：舊版的 `relayUse`（`[小時, 塊數]`），轉成沒有序號的廣播帳 */
    static parse(raw: unknown, opts: RelayLedgerOptions, legacy?: ReadonlyArray<readonly [number, number]>): RelayLedger;
    /**
     * 目前的收件人（SDK ADR 0107）：第一次看到的那幾台記下現在的小時（還沒記過任何收件人時一律從 0 算）。
     * 有新記的回 true（要存）。已經記過的不再改：被撤銷又加回來的照舊算它以前的廣播（寧可多算）。
     */
    join(devices: readonly string[]): boolean;
    toJSON(): RelayLedgerJSON;
    get size(): number;
    record(entry: LedgerEntry): void;
    /**
     * 收到 `device` 的簽收單：記下區間。回傳這次**新**劃掉、帶版本的那幾筆的版本清單（每筆一組；給「對方已收到」用）。
     */
    receipt(device: string, ranges: readonly SeqRange[]): Array<Array<[string, string]>>;
    /** 送給 `device` 還沒簽收、還沒過期的塊數；`null`＝不分收件人（不知道有哪些收件人時，舊的一本帳） */
    used(device: string | null): number;
    /**
     * 再送 `frames` 塊給 `device` 要等多久才不超過 `budget`（只看過期；簽收單來了會更早）。
     * 帳是空的時候一律放行：一則比整份預算還大的訊息不能永遠卡住。
     */
    wait(device: string | null, frames: number, budget: number): number;
    /** `device` 簽收過的序號區間（依序、不重疊；還用得到的部分，見 `prune`）；沒有簽收過是 undefined */
    receipts(device: string): readonly SeqRange[] | undefined;
    /** 每位收件人一列（最滿的在前，同樣多依裝置 id） */
    usage(devices: readonly string[]): Array<{
        device: string;
        used: number;
    }>;
    /** 丟掉過期的、`devices`（目前的收件人）每一台都簽收了的；簽收區間只留還用得到的部分 */
    prune(devices: readonly string[]): void;
    /** 筆數超過 `max` 時，最舊的併成每小時一筆沒有序號的廣播帳（只會多算、不會少算） */
    compact(max: number): void;
}
//# sourceMappingURL=relay-ledger.d.ts.map