import type { VaultConflictKind, VaultVersion } from './types.js';
export declare function sha256Hex(bytes: Uint8Array): string;
/** 由內容決定的 id（32 位 hex）：兩台裝置算同一件事會得到同一個 id。 */
export declare function deterministicId(...parts: string[]): string;
/**
 * 支援衝突 callout 的寫入端產生的版本 id（SDK ADR 0046）：前 24 位隨機，後 8 位是前 24 位的雜湊。
 * 能力記在**版本資料本身**（id 會原樣經過舊版裝置的儲存與轉送，新增欄位則會被舊版的 `parseVersion` 丟掉），
 * 每台裝置看同一個版本得到同一個答案。舊版的隨機 id 巧合符合的機率是 2^-32。
 */
export declare function markCalloutCapableId(id: string): string;
/** 這個 id 是不是支援衝突 callout 的寫入端產生的（只看 id；合併版本請用 {@link supportsConflictCallouts}） */
export declare function isCalloutCapableId(id: string): boolean;
/**
 * 這個版本能不能參與 callout 模式的合併（SDK ADR 0046）：非合併版本看 id 的標記；合併版本（兩個以上父版本）
 * ＝所有父版本都支援。`cache` 存已算過的結果（協調器在加入版本時就算好、持久化，之後修剪祖先也不會改變答案）。
 * 找不到的版本當作不支援（保守：退回衝突副本，不會遺失資料）。
 */
export declare function supportsConflictCallouts(nodes: NodeMap, id: string, cache?: Record<string, boolean>): boolean;
/**
 * 名單能力宣告（SDK ADR 0035 §G9）裡表示「這台支援 Markdown 合併規則」的鍵（SDK ADR 0059）。應用在**名單上所有成員**都宣告了
 * 之後才打開協調器的 `mergeRules`（`membership.allDeclare(MERGE_RULES_CAPABILITY)`）；合併時再由版本資料（id 的標記）決定，每台一致。
 */
export declare const MERGE_RULES_CAPABILITY = "mdMergeRules";
/**
 * 支援 Markdown 合併規則（SDK ADR 0059：同路徑新建的文字檔以空檔為祖先合併、任務勾選框自動合併）的寫入端產生的版本 id：
 * 第 17–24 位是前 16 位的雜湊。與 callout 的標記（最後 8 位，{@link markCalloutCapableId}）各佔不同位置，可以同時帶；
 * 兩個都要時先標這個、再標 callout（callout 的標記涵蓋前 24 位）。舊版的隨機 id 巧合符合的機率是 2^-32。
 */
export declare function markMergeRulesId(id: string): string;
/** 這個 id 是不是支援 Markdown 合併規則的寫入端產生的（只看 id；合併版本請用 {@link supportsMergeRules}） */
export declare function isMergeRulesId(id: string): boolean;
/**
 * 這個版本能不能參與「Markdown 合併規則」模式的合併（SDK ADR 0059）：與 {@link supportsConflictCallouts} 同一個推導——
 * 非合併版本看 id 的標記；合併版本＝所有父版本都支援；找不到的版本當作不支援（退回舊規則）。
 */
export declare function supportsMergeRules(nodes: NodeMap, id: string, cache?: Record<string, boolean>): boolean;
/**
 * 名單能力宣告（SDK ADR 0035 §G9）裡表示「這台支援衝突 callout 後空一行的格式」的鍵（SDK ADR 0087）。應用在**名單上所有成員**都宣告了
 * 之後才打開協調器的 `calloutBreak`（`membership.allDeclare(CALLOUT_BREAK_CAPABILITY)`）；合併時再由版本資料（id 的標記）決定，每台一致。
 */
export declare const CALLOUT_BREAK_CAPABILITY = "calloutBreak";
/**
 * 支援「衝突 callout 後空一行」（SDK ADR 0087）的寫入端產生的版本 id：第 9–16 位是前 8 位的雜湊。與合併規則（第 17–24 位）、
 * callout（最後 8 位）的標記各佔不同位置，可以同時帶；三個都要時依序標這個、合併規則、callout（後者涵蓋前者的位置）。
 * 舊版的隨機 id 巧合符合的機率是 2^-32。
 */
export declare function markCalloutBreakId(id: string): string;
/** 這個 id 是不是支援「衝突 callout 後空一行」的寫入端產生的（只看 id；合併版本請用 {@link supportsCalloutBreak}） */
export declare function isCalloutBreakId(id: string): boolean;
/**
 * 這個版本能不能參與「callout 後空一行」格式的合併（SDK ADR 0087）：與 {@link supportsConflictCallouts} 同一個推導——
 * 非合併版本看 id 的標記；合併版本＝所有父版本都支援；找不到的版本當作不支援（舊格式）。
 */
export declare function supportsCalloutBreak(nodes: NodeMap, id: string, cache?: Record<string, boolean>): boolean;
/**
 * 這些版本與它們在 `nodes` 裡的所有祖先，父版本在前（SDK ADR 0088：補送給不認得這個檔案的裝置，對方依序併入、不必等）。
 * 不在 `nodes` 裡的（修剪掉的）略過。
 */
export declare function ancestryOf(nodes: NodeMap, ids: readonly string[]): string[];
/** 版本先後：`(at, device, id)`，全序且每台裝置一致。 */
export declare function compareVersions(a: Pick<VaultVersion, 'at' | 'device' | 'id'>, b: Pick<VaultVersion, 'at' | 'device' | 'id'>): number;
export type NodeMap = Readonly<Record<string, VaultVersion>>;
/** `id` 與它所有已知的祖先（含自己）。缺少的祖先（被修剪或還沒收到）就停在那裡。 */
export declare function ancestorsOf(nodes: NodeMap, id: string): Set<string>;
/** `a` 是不是 `b` 的祖先（或就是 `b`）。 */
export declare function isAncestor(nodes: NodeMap, a: string, b: string): boolean;
/** 合併版本：有兩個以上父版本的版本（本機編輯、改名、衝突副本最多只有一個父版本）。 */
export declare function isMergeVersion(node: VaultVersion): boolean;
/**
 * 版本頭：沒有被任何已知版本當成父版本的版本，依 `(at, device, id)` 排序。
 *
 * 另加一條「涵蓋」規則，避免合併越合越多：幾台裝置在訊息還在路上時，會各自合併手上不同的版本頭組合
 * （例如 {a,b}、{a,c}），合併版本之間彼此不是祖先，不處理的話會一直「合併的合併」下去。
 * 所以：一個合併版本 X，若另一個版本頭 Y 已經包含 X 底下所有真正的修改（X 的葉子都是 Y 的祖先），
 * X 就不算版本頭。兩個合併版本互相涵蓋（同一組修改、不同的合併順序）時，留 id 較小的那個——
 * 兩者都保留了全部修改（衝突內容各自在副本裡），所以選哪一個都不會遺失資料，重要的是每台選得一樣。
 */
export declare function computeHeads(nodes: NodeMap): string[];
/**
 * 最佳共同祖先：兩邊祖先的交集裡，不是其他共同祖先之祖先的那些；有好幾個時取 `(at, device, id)` 最大的。
 * 沒有共同祖先回 `null`（例如祖先被修剪了）。
 */
export declare function bestCommonAncestor(nodes: NodeMap, a: ReadonlySet<string>, b: ReadonlySet<string>): string | null;
/** 合併產生的衝突副本：另一方的**完整**內容，存成新檔案。 */
export interface ConflictCopy {
    /** 被放進副本的那一方是哪些版本（排序後以 + 連接）；同一方在不同的合併裡產生的副本以它去重 */
    source: string;
    bytes: Uint8Array;
    hash: string;
    size: number;
    text: boolean;
    label: string;
    device: string;
    at: number;
}
export interface MergeNote {
    kind: VaultConflictKind;
    otherPath?: string;
    copyIndex?: number;
    /** 衝突就地放進了這些 callout（SDK ADR 0046；沒有衝突副本） */
    callouts?: string[];
}
export interface PlanMergeOptions {
    /**
     * Markdown 的同行衝突改用就地 callout（SDK ADR 0046）。協調器只在**所有**版本頭都支援時打開
     * （{@link supportsConflictCallouts}）——由版本資料決定，每台裝置一致。
     */
    callouts?: boolean;
    /**
     * Markdown 合併規則（SDK ADR 0059）。協調器只在**所有**版本頭都支援時打開（{@link supportsMergeRules}）：
     * - 兩邊都是文字檔、找不到共同祖先（例如兩台各自新建的同路徑檔案被收成同一個檔案）：以空檔為祖先三方合併
     *   （{@link "@cinderous/client/sync"!commonLinesBase} 精簡衝突），合不了才退回 callout／衝突副本；
     * - 衝突區塊兩邊只差在任務勾選狀態：自動合併（{@link "@cinderous/client/sync"!resolveTaskCheckboxConflict}）。
     */
    mergeRules?: boolean;
    /**
     * 衝突 callout 後空一行的格式（SDK ADR 0087）。協調器只在**所有**版本頭都支援時打開（{@link supportsCalloutBreak}）；
     * 沒開時 callout 與 v0.60 位元組相同。只在 `callouts` 打開時有作用。
     */
    calloutBreak?: boolean;
}
export interface MergePlan {
    /** 合併後的版本（尚未指定 id 與 parents 以外的欄位都已確定） */
    version: VaultVersion;
    /** 合併後的內容（刪除時為 undefined） */
    bytes: Uint8Array | undefined;
    copies: ConflictCopy[];
    notes: MergeNote[];
}
/**
 * 合併需要哪些內容：每個（未刪除的）版本頭，以及每一步的共同祖先（只有文字檔需要祖先的內容）。
 * 版本頭的順序就是合併的順序（`computeHeads` 已排好）。
 */
export declare function mergeInputs(nodes: NodeMap, heads: readonly string[]): {
    bases: (string | null)[];
};
/**
 * 把多個版本頭確定性地合併成一個版本。`content(hash)` 回傳已知的內容（找不到回 undefined）。
 *
 * 規則（每兩邊一次，以共同祖先 O 為準；逐項三方）：
 * - 刪除：兩邊都刪 → 刪；一邊刪、另一邊相對 O 內容沒動（只改名也算沒動）→ 刪；
 *   另一邊改了內容 → **保留修改**，記 `delete-modify`。
 * - 路徑：只有一邊改 → 取改的；兩邊改得不同 → 取較晚的，記 `rename-rename`（內容不受影響）。
 * - 內容：只有一邊改 → 取改的；兩邊都改 → 文字檔且有 O 的內容就 `merge3`；
 *   合不起來（或二進位、缺 O）→ 較晚的一方留在主檔，另一方的完整內容成為衝突副本。
 *
 * 內容只在真的用到時才需要（文字合併、衝突副本、被選為結果的那一方）；需要卻拿不到時丟 `MissingContentError`。
 * 只貢獻路徑（內容沒變）的一方不需要內容。
 */
export declare function planMerge(nodes: NodeMap, heads: readonly string[], content: (hash: string) => Uint8Array | undefined, options?: PlanMergeOptions): MergePlan;
/** 合併需要某個版本頭的內容，但拿不到（大檔等 P2P、或內容還沒到） */
export declare class MissingContentError extends Error {
    readonly hash: string;
    constructor(hash: string);
}
//# sourceMappingURL=graph.d.ts.map