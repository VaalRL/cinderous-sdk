import type { PublishResult } from './relay-pool.js';
/** SDK 中繼預設的每把公鑰每分鐘事件上限（鏡射 `relay/host-config` 的 `MAX_EVENTS_PER_MINUTE`；測試釘住兩者相同） */
export declare const RELAY_MAX_EVENTS_PER_MINUTE = 120;
/** 客戶端預設的每分鐘事件預算：低於上限，留 20 則給私訊、心跳等沒有經過預算的發布 */
export declare const DEFAULT_RELAY_EVENTS_PER_MINUTE = 100;
/** 收到 `rate-limited:` 之後退避多久：中繼每分鐘的計數窗（與 `DEFAULT_RELAY_HEALTH_COOLDOWNS.rateLimitedMs` 相同） */
export declare const RELAY_RATE_LIMIT_BACKOFF_MS = 60000;
/**
 * 從中繼的 NIP-11 文件（或多份）算出每分鐘事件預算：`cinder_max_events_per_minute` × 0.8，多座取最小；
 * 都沒宣告就回 `fallback`。
 */
export declare function relayEventsPerMinute(nip11: unknown, fallback?: number): number;
export interface RelayEventBudgetOptions {
    /** 每分鐘幾則；預設 {@link DEFAULT_RELAY_EVENTS_PER_MINUTE} */
    perMinute?: number;
    /** 測試用 */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
/**
 * 滑動一分鐘的事件預算：任何 60 秒內最多 `perMinute` 則，所以中繼的固定計數窗（從第一則起算 60 秒）裡也不會超過。
 * `take()` 依呼叫順序排隊（先到先發），可以由同一身分的多個元件共用。
 */
export declare class RelayEventBudget {
    #private;
    constructor(opts?: RelayEventBudgetOptions);
    /** 目前每分鐘幾則 */
    get perMinute(): number;
    /** 依中繼的 NIP-11 調整：取建構時的速率與宣告值 × 0.8 的較小者（每次從建構時的速率重算，不會越調越低）。回傳新的速率 */
    applyRelayInfo(nip11: unknown): number;
    /** 中繼說限速了：到 `ms` 毫秒之後都不發（只會延長，不會縮短） */
    backoff(ms: number): void;
    /** 等到可以再發一則，並把這一則記進預算 */
    take(): Promise<void>;
}
/**
 * 同一把公鑰共用的預算（中繼以認證身分計數，所以同一身分的所有元件要共用一個桶）。第一次取用時建立，速率是預設值；
 * 要依 NIP-11 調整就 `sharedRelayEventBudget(pubkey).applyRelayInfo(docs)`。
 */
export declare function sharedRelayEventBudget(pubkey: string): RelayEventBudget;
/** 這次發布有沒有中繼說限速；有就回退避毫秒數（`ip` 詞元 1 秒，其他一分鐘） */
export declare function rateLimitBackoffMs(result: PublishResult): number | undefined;
/**
 * 取預算 → 發布；有中繼說限速就讓整個預算退避。`done(result)` 為 false（預設：沒有任何一座收下）而且原因是限速時，
 * 退避後重送同一顆（被拒的事件不留在中繼的重放快取裡，ADR 0038 P0-R1），最多 `retries` 次。
 */
export declare function publishPaced(budget: RelayEventBudget, publish: () => Promise<PublishResult>, opts?: {
    retries?: number;
    done?: (result: PublishResult) => boolean;
    /** 每一次嘗試的結果（含之後重送成功的那些限速拒收），給 `onPublishRejected` 回報用 */
    onAttempt?: (result: PublishResult) => void;
}): Promise<PublishResult>;
//# sourceMappingURL=relay-budget.d.ts.map