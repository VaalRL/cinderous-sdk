import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { RelayQueryOutcome, RelayQueryStatus } from '../relay-pool.js';
/** 放到背景超過這麼久就主動斷線（PRD：15 秒） */
export declare const DEFAULT_HIDDEN_DISCONNECT_MS = 15000;
/** 只用到連線池的這幾個方法；RelayPool 直接符合 */
export interface HydratorPool {
    connect(): void;
    close(): void;
    query(filters: Filter[], timeoutMs?: number): Promise<Event[]>;
    /**
     * 選配（SDK ADR 0045，G12a；`RelayPool` 有）：回報幾座完整回完。有的話，**一座都沒回完**的那一頁不算「翻完了」，
     * 游標（`setLastSyncAt`、補拉起點）不會被推進。只有 `query` 的自訂池分不出來，沿用舊行為。
     */
    queryResult?(filters: Filter[], timeoutMs?: number, options?: {
        readonly waitForPrimary?: boolean;
    }): Promise<RelayQueryOutcome>;
}
/**
 * 沒有任何一座中繼完成查詢（都沒開、逾時、被 CLOSED、查到一半全部斷線；SDK ADR 0045，G12a）。
 * 不是「查完但沒結果」：依查詢結果推進的游標此時不得推進。`events`＝在那之前已經拿到的（已交出去的頁）。
 */
export declare class RelayQueryIncompleteError extends Error {
    readonly relays: readonly RelayQueryStatus[];
    readonly events: readonly Event[];
    constructor(relays: readonly RelayQueryStatus[], events?: readonly Event[]);
}
export declare function isRelayQueryIncompleteError(error: unknown): error is RelayQueryIncompleteError;
export interface VisibilitySource {
    isHidden(): boolean;
    /** 回傳取消函式 */
    onChange(listener: (hidden: boolean) => void): () => void;
}
/** 瀏覽器預設：`document.visibilityState`；沒有 document（Node、React Native）回 null，請自行注入 */
export declare function documentVisibility(): VisibilitySource | null;
/** 分頁取回最多翻幾頁（防惡意中繼無止盡地回更舊的事件）。每頁至多約 16 MB（中繼的 REQ 位元組預算） */
export declare const DEFAULT_MAX_PAGES = 64;
export interface PagedQueryOptions {
    /** 每一頁的逾時（毫秒；交給 `pool.query`） */
    timeoutMs?: number;
    /** 最多翻幾頁；預設 {@link DEFAULT_MAX_PAGES}。1＝不分頁（與 v0.24 相同） */
    maxPages?: number;
}
/** {@link forEachPage} 的結果 */
export interface PagedQueryResult {
    /** 總共拿到幾則（以 id 去重） */
    events: number;
    /**
     * 翻到一頁沒有新事件才停（true）；撞到 `maxPages` 就停下的、或某一頁沒有任何中繼回完（`unanswered`）的是 false——
     * 更舊的可能還沒拿，游標不要推進
     */
    complete: boolean;
    /** 某一頁沒有任何中繼完成查詢（SDK ADR 0045，G12a；只有池提供 `queryResult` 才分辨得出）。只在這種情況出現 */
    unanswered?: true;
    /** `unanswered` 時，那一頁每一座的狀態 */
    relays?: readonly RelayQueryStatus[];
}
/**
 * 分頁取回歷史事件（SDK ADR 0029；NIP-01 `until`）：每拿到一頁、把**這一頁新的事件**交給 `onPage`。
 *
 * 為什麼要分頁：中繼一次 REQ 回傳的量有上限（Cinderous ADR-0371：16 MB 位元組預算，約 120 顆檔案塊；
 * 另有 1024 筆的筆數上限），超過的**最舊**那些不會出現在這次回應裡——而且中繼**不會告訴你**被截斷了。
 * 所以這裡不猜：以這一頁最舊的 `created_at` 當下一頁的 `until`（含邊界，同一秒的不會漏）再查，
 * 直到一頁沒有任何新事件為止。代價是每次多一個（通常是空的）REQ。
 *
 * ⚠ `pool.query` 把多座中繼的結果合在一起：各座內容不一致、又各自被截斷時，以合併後最舊的時間往回翻，
 * 可能跳過較新那座被截斷的部分。Vault 同步由協調器的摘要／索取補回；要逐座精準分頁，每座給一個 pool。
 */
export declare function forEachPage(pool: Pick<HydratorPool, 'query'> & Partial<Pick<HydratorPool, 'queryResult'>>, filters: Filter[], onPage: (events: Event[]) => void, opts?: PagedQueryOptions): Promise<PagedQueryResult>;
/**
 * {@link forEachPage} 的收集版：回傳所有頁的事件（去重、由新到舊）。
 * 某一頁沒有任何中繼回完時丟 {@link RelayQueryIncompleteError}（v0.36 起；帶著已拿到的事件），不再回空陣列假裝查完。
 */
export declare function queryPaged(pool: Pick<HydratorPool, 'query'> & Partial<Pick<HydratorPool, 'queryResult'>>, filters: Filter[], opts?: PagedQueryOptions): Promise<Event[]>;
export interface FastHydratorOptions {
    pool: HydratorPool;
    /** 喚醒時要拉的東西（不含 since，這裡會補上） */
    filters: Filter[];
    onEvents: (events: Event[]) => void;
    /** 上次同步成功的時間（秒）；沒同步過回 undefined */
    lastSyncAt: () => number | undefined;
    setLastSyncAt: (seconds: number) => void;
    visibility?: VisibilitySource | null;
    hiddenDisconnectMs?: number;
    /**
     * since 要往前退讓多少秒。預設是 NIP-59 的時間倒填窗（兩天）：禮物包的外層時間會被隨機往前推，
     * 不退讓的話，剛寄出、外層時間卻落在兩天前的訊息會被 since 濾掉——而且是靜默漏訊（Cinderous ADR-0109）。
     */
    sinceSlackSeconds?: number;
    queryTimeoutMs?: number;
    /**
     * 最多翻幾頁（SDK ADR 0029）：中繼一次回傳有上限、而且不告訴你被截斷了，所以預設以 `until` 往回翻到沒有新事件。
     * 預設 {@link DEFAULT_MAX_PAGES}；1＝不分頁（v0.24 的行為）。
     */
    maxPages?: number;
}
export declare class FastHydrator {
    #private;
    constructor(opts: FastHydratorOptions);
    /** 開始監看可見性，並立刻拉一次增量。 */
    start(): Promise<void>;
    stop(): void;
    /**
     * 拉一次增量；回傳拿到幾則。失敗時不更新同步時間（下次重拉，不會漏）。
     * 沒有任何中繼回完（池有 `queryResult` 時才分辨得出；SDK ADR 0045）也是失敗：拿到的頁照樣交出去，
     * 但不更新同步時間，並丟 {@link RelayQueryIncompleteError}。
     */
    resume(): Promise<number>;
}
//# sourceMappingURL=hydrator.d.ts.map