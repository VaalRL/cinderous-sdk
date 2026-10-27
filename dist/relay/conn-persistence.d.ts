import type { ConnSnapshot } from "./relay-core.js";
import type { SqlExec } from "./sql-message-store.js";
/**
 * 連線狀態的休眠持久化（ADR-0059 → Cinderous ADR-0373）。
 *
 * ## 為什麼不能只靠 WebSocket attachment
 *
 * Cloudflare 規定 `serializeAttachment` 序列化後最多 **16,384 bytes**。一把 pubkey 在 filter 裡約
 * 67 bytes ⇒ 同一條連線的 `authors` 合計約 240 把就超過，`serializeAttachment` 直接拋例外——
 * 在 `webSocketMessage` 裡那是**未捕捉例外**：客戶端什麼都收不到，訂閱只留在記憶體，
 * DO 休眠喚醒後消失。而 App 的心跳訂閱正是 `{kinds:[20000], authors:[全部聯絡人]}`。
 *
 * ## 混合策略
 *
 * - **小的訂閱照舊放 attachment**（讀寫免費、喚醒時不必讀 storage——ADR-0059 選 attachment 的理由不變）。
 * - 放不下的訂閱**溢位到 DO SQLite 的 `ws_subs` 表**（鍵＝連線 id ＋訂閱 id），attachment 只記它們的訂閱 id。
 * - 放置規則與插入順序無關（由小到大塞滿預算），所以喚醒還原後再存一次**不會**搬來搬去。
 * - 只有內容真的變了才寫：心跳 EVENT 之類不改訂閱的訊息**零寫入**，也不重做 `serializeAttachment`。
 * - 每連線訂閱合計上限 {@link MAX_CONN_SUB_BYTES}：超過的（新／改的那幾條）由呼叫方回 `CLOSED`，不靜默。
 */
/** Cloudflare 的 attachment 上限（序列化後位元組）。 */
export declare const ATTACHMENT_MAX_BYTES = 16384;
/**
 * 放進 attachment 的訂閱 JSON 預算。刻意比 16KB 低一截：attachment 是 structured clone 不是 JSON，
 * 實測兩者只差幾十 bytes（260 把 authors：JSON 17,462、attachment 17,435），但連線 id、挑戰、
 * pubkey、主機與溢位清單也要放進去——留 4KB 餘裕，寧可多溢位一條也不要撞上限。
 */
export declare const INLINE_BUDGET_BYTES: number;
/**
 * 每連線可持久化的訂閱合計上限（filter JSON 位元組）。
 *
 * 1024 把 authors（ADR-0123 的上限）一條約 70KB；512KiB 可容 7 條那樣的訂閱，遠超真實用量。
 * 沒有這一道的話，一條連線 16 條訂閱 × 384KB 訊息上限 ≈ 6MB 會落進 DO storage。
 */
export declare const MAX_CONN_SUB_BYTES: number;
/** attachment 的形狀：{@link ConnSnapshot} ＋溢位到 storage 的訂閱 id。 */
export interface ConnAttachment extends ConnSnapshot {
    /** 存在 `ws_subs` 表的訂閱 id（其 filter 不在 `subs` 裡）。舊版 attachment 沒有此欄。 */
    spilled?: string[];
}
/** 休眠式 WebSocket 裡本模組用得到的部分。 */
export interface AttachmentSocket {
    serializeAttachment(value: unknown): void;
    deserializeAttachment(): unknown;
}
/** 一次存檔的結果：`rejected` 是沒能持久化、呼叫方必須關掉並告知客戶端的訂閱。 */
export interface SaveResult {
    rejected: {
        subId: string;
        reason: "too-large" | "persist-failed";
    }[];
}
/** 喚醒還原的結果：`lost` 是 attachment 記著、storage 卻找不到的訂閱（呼叫方要告知客戶端重訂）。 */
export interface LoadResult {
    snapshots: ConnSnapshot[];
    lost: {
        connId: string;
        subId: string;
    }[];
}
export declare class ConnPersistence {
    private readonly sql;
    private readonly persisted;
    constructor(sql: SqlExec);
    /**
     * 把某連線的最新狀態存起來；沒變就什麼都不做。
     *
     * 不拋例外：任何失敗都轉成 `rejected`，由呼叫方關掉那些訂閱並告訴客戶端。
     */
    save(ws: AttachmentSocket, snap: ConnSnapshot): SaveResult;
    private write;
    /** 連線結束：清掉它的溢位列（有才刪——刪除也計入寫入列數）。 */
    remove(connId: string): void;
    /**
     * 喚醒還原：讀所有存活連線的 attachment，補回溢位的訂閱，並**清掉孤兒列**
     *（連線已不在——例如部署重啟時 `webSocketClose` 沒被呼叫——或 attachment 已不再指著它）。
     *
     * 只有 attachment 記著溢位時才碰 storage：一般情況（沒有大訂閱）喚醒仍然零讀取（ADR-0059）。
     */
    load(sockets: Iterable<AttachmentSocket>): LoadResult;
    /**
     * 讀溢位列。有任何 attachment 記著溢位就讀整張表（順便找出孤兒）；
     * 否則只問「表裡有沒有東西」——有就代表有孤兒要清，沒有就到此為止。
     */
    private readRows;
}
//# sourceMappingURL=conn-persistence.d.ts.map