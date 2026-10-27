export interface MergeConflict {
    base: string[];
    local: string[];
    remote: string[];
}
export interface MergeResult {
    /** 沒有衝突 */
    clean: boolean;
    /** 沒有衝突時就是合併結果；有衝突時，衝突區塊暫時取本機的內容（要拼接請用 `renderWithConflictMarkers`） */
    merged: string;
    conflicts: MergeConflict[];
}
/** Myers diff：回傳兩邊相同的行 `[a 的索引, b 的索引]`（最長共同子序列，索引遞增）。 */
export declare function diffLines(a: readonly string[], b: readonly string[]): [number, number][];
/** 合併結果的一段：兩邊一致（或只有一邊改）的行，或一個衝突區塊 */
export type Merge3Chunk = {
    kind: 'ok';
    lines: string[];
} | ({
    kind: 'conflict';
} & MergeConflict);
/**
 * 衝突區塊的解決規則（SDK ADR 0059）：回傳取代整個區塊的行就算解決；回 null＝照舊是衝突。
 * 必須是純函式、確定性（每台裝置對同一個區塊得到同一個結果），而且最好與 `local`／`remote` 的順序無關。
 */
export type Merge3Resolver = (conflict: MergeConflict) => string[] | null;
export interface Merge3Options {
    /** 衝突區塊的解決規則（例如 {@link resolveTaskCheckboxConflict}） */
    resolve?: Merge3Resolver;
}
/**
 * 逐段的三方合併（SDK ADR 0046）：與 {@link merge3} 同一套演算法，但保留每一段的位置——衝突區塊之間至少隔一行穩定行。
 * 給「把衝突就地呈現」（例如 Markdown 的衝突 callout）用。
 */
export declare function merge3Chunks(base: string, local: string, remote: string, options?: Merge3Options): Merge3Chunk[];
/** 三方合併：`base` 是兩邊最後一次同步時的共同版本。 */
export declare function merge3(base: string, local: string, remote: string, options?: Merge3Options): MergeResult;
/** 「雙版本合併拼接」：衝突區塊前後插入標記，兩邊全文都保留（PRD 2.6.2）。 */
export declare function renderWithConflictMarkers(result: MergeResult, labels?: {
    local?: string;
    remote?: string;
}): string;
/**
 * 兩份沒有共同祖先的文字（例如兩台各自新建的同一天的筆記）合併時用的「虛擬共同祖先」（SDK ADR 0059）：
 * 兩邊共同的行（最長共同子序列）。以它當祖先做三方合併，等於「以空檔為祖先」再把衝突區塊精簡到真正不同的地方——
 * 兩邊都有的行只出現一次、只有一邊有的行直接採用、同一處兩邊各自新增不同的行才算衝突。
 * 祖先裡的每一行兩邊都有，所以三方合併不會刪掉任何一邊的內容。純函式：同樣的輸入得到同樣的輸出。
 */
export declare function commonLinesBase(local: string, remote: string): string;
/**
 * 任務勾選框的衝突自動合併（SDK ADR 0059，裁示 7）：衝突區塊兩邊行數相同、而且每一行要嘛相同、要嘛只差在任務的勾選狀態
 * （`- [ ]`／`- [x]`，含 Tasks 外掛勾選時附加的 ` ✅ YYYY-MM-DD`）時，逐行合併；否則回 null（照舊是衝突）。
 *
 * - 兩邊不同的每一行都必須是同一個任務、只差在勾選（文字、縮排、項目符號有任何不同就回 null）；
 * - 祖先也是同樣行數時逐行三方：只有一邊改的那一行取改的那邊（例如一台把勾拿掉、另一台沒動那一行）；
 * - 兩邊都改了同一行（或沒有逐行對得上的祖先）：**已勾的贏**；都勾了取有完成日期的、日期較早的（第一次完成）；
 *   其餘（例如 `[x]` 與 `[X]`）取字典序較小的。只看兩行本身，與 `local`／`remote` 的順序無關，每台裝置一致。
 */
export declare function resolveTaskCheckboxConflict(conflict: MergeConflict): string[] | null;
/**
 * 路徑被佔用時的第 `n` 個候選名稱（`n` ≥ 2）：`notes/doc.md` → `notes/doc 2.md`。
 * 協調器替衝突副本、路徑相撞找空位時用（`#freePath`）；`parseConflictCopyName` 以同一個規則拆回來（CinderSync G18）。
 */
export declare function freePathCandidate(path: string, n: number): string;
/** 衝突副本檔名（PRD 2.6.1）：`[檔名] (衝突-[設備別名]-[時間戳]).[副檔名]`，時間戳用 UTC。 */
export declare function conflictCopyName(path: string, deviceLabel: string, at: number): string;
/** `parseConflictCopyName` 的結果 */
export interface ConflictCopyNameInfo {
    /** 原檔路徑（副本是從它分出來的） */
    readonly original: string;
    /** 產生副本的裝置名稱（換掉禁用字元之後的，與檔名上的相同） */
    readonly label: string;
    /** 檔名上的時間（毫秒，UTC，精確到秒） */
    readonly at: number;
    /** 沒有編號的副本路徑（`conflictCopyName(original, label, at)`） */
    readonly copyPath: string;
    /** 副本名稱被佔用時協調器加的編號（≥ 2）；沒有編號時不出現 */
    readonly n?: number;
}
/**
 * 這個路徑是不是 `conflictCopyName` 產生的衝突副本（CinderSync G18）；是的話拆出原檔、裝置名稱、時間。
 * 也認得名稱被佔用時協調器加的編號（`freePathCandidate`，` 2`、` 3`……加在副檔名之前）。
 * 只認 SDK 組得出來的名稱：使用者自己取的「會議 (衝突-討論).md」、日期不合法的都回 null。純函式，不碰磁碟。
 */
export declare function parseConflictCopyName(path: string): ConflictCopyNameInfo | null;
//# sourceMappingURL=merge3.d.ts.map