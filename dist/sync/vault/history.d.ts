import type { VaultHistoryErrorCode, VaultRestorePlan, VaultRestoreSkipped } from './types.js';
/** 保留天數的預設（裁示 1） */
export declare const DEFAULT_HISTORY_KEEP_DAYS = 30;
/** 每個檔案最多幾版的預設（裁示 1） */
export declare const DEFAULT_HISTORY_MAX_VERSIONS = 100;
/** 歸檔內容總容量上限的預設：1 GiB（裁示 1） */
export declare const DEFAULT_HISTORY_MAX_BYTES: number;
/** `restore()`、`readHistory()` 的錯誤 */
export declare class VaultHistoryError extends Error {
    readonly code: VaultHistoryErrorCode;
    readonly versionId: string;
    constructor(code: VaultHistoryErrorCode, versionId: string, message?: string);
}
/** 命名檢查點最多幾個（裁示補充 3）：超過時拒絕建立，不自動清掉任何一個 */
export declare const MAX_NAMED_CHECKPOINTS = 50;
/** 自動檢查點最多多久一個（裁示補充 1） */
export declare const AUTO_CHECKPOINT_INTERVAL_MS = 3600000;
export declare function isVaultHistoryError(error: unknown): error is VaultHistoryError;
/** 歸檔裡的先後：版本時間，平手時看這台歸檔的順序（合併版本的時間等於較晚的父版本，歸檔一定在父版本之後） */
export interface HistoryOrder {
    at: number;
    /** 這台的歸檔序號（單調遞增） */
    n: number;
}
export declare function compareHistory(a: HistoryOrder, b: HistoryOrder): number;
export interface ThinOptions {
    /** 保留天數（`Infinity`＝永久） */
    keepDays: number;
    /** 稀疏化後每個檔案最多幾版 */
    maxVersions: number;
    /** 把時間換成「當地牆上時間」要加的毫秒（決定小時與日期的界線）；預設 0（UTC） */
    offset?: (at: number) => number;
}
export interface Thinnable extends HistoryOrder {
    deleted: boolean;
}
export interface ThinResult<T> {
    /** 留下的（由舊到新） */
    keep: T[];
    drop: T[];
    /**
     * 因保留天數或版本數上限從**前面**清掉的版本裡最新的時間（沒有就省略）。有它表示更早的狀態已經不在歸檔；
     * 稀疏化在中間清掉的不算（那一段由留下的最新一版代表）。
     */
    cut?: number;
}
/**
 * 一個檔案的歸檔稀疏化（裁示 3）：
 * - 最新的一版一律留下（檔案目前的狀態）；只有最新的一版是刪除、而且超過保留天數時，整個檔案的歷史清掉。
 * - 1 小時內的全留；1 天內每個（當地）小時留最新的一版；之後到保留天數為止每個（當地）日期留最新的一版；更舊的清掉。
 *   刪除不佔區段：區段裡刪除之前的最後一版（有內容的）照留，刪除本身也留（之後沒有再出現內容時）。
 * - 稀疏化後超過 `maxVersions` 就從最舊的清。
 *
 * 「最新的一版」以 `(at, n)` 比。每個區段留下的一定是那個區段（小時或日期）最新的一版，所以同一份歸檔隔一陣子再做一次，
 * 結果和一次做到那個時間相同（不含版本數上限）。
 */
export declare function thinHistory<T extends Thinnable>(entries: readonly T[], now: number, options: ThinOptions): ThinResult<T>;
export interface Budgeted extends HistoryOrder {
    hash: string;
    /** 這一版的內容存在歸檔裡（以雜湊去重） */
    content: boolean;
}
/**
 * 歸檔內容超過總容量上限時要清掉哪些版本：從最舊的開始，每個檔案至少留最新的一版；只清有內容的
 * （沒有內容的版本清了也不省空間）。內容以雜湊去重：同一份內容的最後一個版本清掉時才算省下。
 */
export declare function overByteBudget<T extends Budgeted>(files: ReadonlyMap<string, readonly T[]>, sizeOf: (hash: string) => number, maxBytes: number): Array<{
    fileId: string;
    entry: T;
}>;
/** 歸檔裡的一個版本（協調器內部的形狀，`buildRestorePlan` 用） */
export interface ArchivedVersion extends Thinnable {
    versionId: string;
    path: string;
    device: string;
    label: string;
    hash: string;
    size: number;
    text: boolean;
    content: boolean;
    /** 內容拿不到時回報的原因（預設：文字檔 `content-missing`、二進位檔 `binary`）；例如輕量成員範圍外的檢查點項目是 `not-local` */
    unavailable?: VaultRestoreSkipped['reason'];
}
/** 一個檔案的歸檔 */
export interface ArchivedFile {
    fileId: string;
    /** 由舊到新 */
    entries: readonly ArchivedVersion[];
    /** 檔案建立的時間（歸檔收到了它的第一個版本才有）：比它早的時間點，檔案確定不存在 */
    born?: number;
}
/** 一個檔案現在的狀態（協調器從版本圖與磁碟判斷） */
export type CurrentFile = 
/** 在磁碟上（同步中）。`text`／`size`：現在這一版的（v0.50；沒給時從歸檔裡找那一版） */
{
    state: 'live';
    path: string;
    hash: string;
    versionId: string;
    text?: boolean;
    size?: number;
}
/** 還在（有沒刪除的版本頭），但內容不在這台：被排除、輕量成員範圍外、內容還沒到 */
 | {
    state: 'not-local';
    path: string;
    reason: 'excluded' | 'not-local';
}
/** 刪除了，或這台已經不認得 */
 | {
    state: 'gone';
};
/** 檔案在時間 T 的狀態：`known: false`＝歸檔沒涵蓋；`entry` 是 null＝那時不存在 */
export declare function fileStateAt(file: ArchivedFile, at: number): {
    known: false;
} | {
    known: true;
    entry: ArchivedVersion | null;
};
export interface RestorePlanOptions {
    /** 刪掉 T 之後才建立的檔案；預設 false（不刪） */
    removeCreatedAfter?: boolean;
    /**
     * 連 T 之後建立的**二進位檔**也刪（預設 false；只在 `removeCreatedAfter` 打開時有效，v0.50 裁示 1 乙）：歸檔沒有二進位內容，
     * 這些刪除標 `irreversible: true`、救不回來，預覽附上總大小（`irreversibleBytes`）。
     */
    removeCreatedBinaries?: boolean;
    /** 只看這些路徑（T 時的路徑或現在的路徑符合其一就算）；省略＝全部 */
    include?: (path: string) => boolean;
    /** 同步排除範圍 */
    excluded?: (path: string) => boolean;
    /** 這份內容（雜湊）在歸檔裡 */
    archived: (hash: string) => boolean;
    /** 預覽產生的時間 */
    now: number;
    /** 檔案在 T 時的狀態；預設 `fileStateAt(file, at)`（只看歸檔）。協調器從檢查點開始推算時給 */
    stateOf?: (file: ArchivedFile) => ReturnType<typeof fileStateAt>;
}
/** 空的預覽（`addToRestorePlan` 逐檔加入、`finishRestorePlan` 收尾；協調器逐檔串流時用） */
export declare function emptyRestorePlan(at: number, now: number): VaultRestorePlan;
/** 一個檔案加入預覽時需要的判斷（`buildRestorePlan` 從 `RestorePlanOptions` 與歸檔算；協調器逐檔算） */
export interface RestoreFileContext {
    removeCreatedAfter?: boolean;
    removeCreatedBinaries?: boolean;
    include?: (path: string) => boolean;
    excluded?: (path: string) => boolean;
    /** 現在的內容（`current` 的雜湊）在歸檔裡：覆寫或刪了找得回來 */
    curArchived: boolean;
    /** T 時那一版的內容在歸檔裡 */
    thenArchived: boolean;
    /** 現在這一版的大小、是不是文字檔、時間（`current` 沒給時） */
    curVersion?: {
        size: number;
        text: boolean;
        at: number;
    };
}
/**
 * 一個檔案加入預覽（裁示 6）。每個檔案取 `at ≤ T` 的最後一版（`state`）：
 * - T 時存在、現在也在：內容或路徑不同 → 改回（內容要拿得到：歸檔裡有，或和現在相同；要覆寫的現有內容也要在歸檔裡，覆寫了才找得回來）。
 * - T 時存在、現在刪了 → 復原（內容要在歸檔裡）。
 * - T 時不存在（確定）、現在在 → `removeCreatedAfter` 才刪（現有內容要在歸檔裡，刪了才找得回來；二進位檔只有
 *   `removeCreatedBinaries` 打開時刪，標 `irreversible`）。
 * - 歸檔沒涵蓋 T 時的狀態、現在在 → 無法還原（`out-of-range`）。
 */
export declare function addToRestorePlan(plan: VaultRestorePlan, fileId: string, state: ReturnType<typeof fileStateAt>, cur: CurrentFile, ctx: RestoreFileContext): void;
/** 預覽收尾：每一類依路徑排序 */
export declare function finishRestorePlan(plan: VaultRestorePlan): VaultRestorePlan;
/**
 * 整個 Vault 回到時間 T 的預覽（裁示 6）：每個檔案照 `addToRestorePlan` 判斷（見那裡的規則）。
 */
export declare function buildRestorePlan(at: number, files: Iterable<ArchivedFile>, current: (fileId: string) => CurrentFile, options: RestorePlanOptions): VaultRestorePlan;
/** 檢查點清單裡的一個檔案（fileId → 這一筆） */
export interface CheckpointFile {
    path: string;
    versionId: string;
    hash: string;
    size: number;
    text: boolean;
    /** 內容在這台（輕量成員範圍外的是 false：只有版本資訊，不能從這個檢查點還原） */
    local: boolean;
}
/** fileId → 檔案 */
export type CheckpointManifest = ReadonlyMap<string, CheckpointFile>;
/** 編碼後的清單：完整的（沒有 `d`）或相對於前一個檢查點的差異（`s`＝新增或改了的、`d`＝不在了的 fileId） */
export interface EncodedManifest {
    /** `[fileId, 路徑或 [和前一列相同的前綴長度, 其餘], versionId, hash, size, flags]`，依路徑排序 */
    s: Array<[string, string | [number, string], string, string, number, number]>;
    d?: string[];
}
/** 完整的清單 */
export declare function encodeManifest(manifest: CheckpointManifest): EncodedManifest;
/** `next` 相對於 `prev` 的差異（沒有差異時 `s`、`d` 都是空的） */
export declare function diffManifest(prev: CheckpointManifest, next: CheckpointManifest): EncodedManifest;
/** 差異是空的（兩個清單相同） */
export declare function isEmptyDiff(diff: EncodedManifest): boolean;
/** 解出清單：完整的直接解；差異套在 `base` 上（`base` 不會被改） */
export declare function decodeManifest(encoded: EncodedManifest, base?: CheckpointManifest): Map<string, CheckpointFile>;
//# sourceMappingURL=history.d.ts.map