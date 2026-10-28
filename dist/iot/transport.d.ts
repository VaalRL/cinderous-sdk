import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from '../protocol/event.js';
import { type ClassifiedRejection } from '../publish-rejections.js';
import { type RelayEventBudget } from '../relay-budget.js';
import type { RelayHealthSnapshot } from '../relay-health.js';
import type { PublishResult, RelayTransport } from '../relay-pool.js';
/**
 * `RelayPool` 直接符合；有 `query` 就用它，沒有就以訂閱＋EOSE 代替。
 * 有 `relayHealth` 就看得出「relay 已經以 4429 關掉、還沒到重置時間」（SDK ADR 0122）。
 */
export type IotTransport = RelayTransport & {
    query?(filters: Filter[], timeoutMs?: number): Promise<Event[]>;
    relayHealth?(): ReadonlyMap<string, RelayHealthSnapshot>;
};
/** 中繼的額度拒收（ADR 0049 §10）：`…iot-quota:<重置 unix 秒>` 或只有詞元；4429 關閉的原因也是這個格式 */
export declare const IOT_QUOTA_REJECTION: RegExp;
/**
 * 這條路線的每一座（不含備援）都還掛著 4429 `iot-quota` 的標記（SDK ADR 0122）：額度用完、連線被關、還沒到重置時間。
 * 回 `{ reset }`（unix 秒，取最早的；不知道就沒有），否則 undefined。
 */
export declare function iotQuotaHold(pool: IotTransport): {
    readonly reset?: number;
} | undefined;
/** 一次性查詢：有 `query` 用它，否則訂閱到第一個 EOSE（或逾時）為止 */
export declare function iotQuery(pool: IotTransport, filters: Filter[], timeoutMs: number): Promise<Event[]>;
/** 驗簽（連線池已經驗過；自訂傳輸層不一定，閘道與客戶端是安全邊界，再驗一次） */
export declare function iotVerified(event: Event | NostrEvent): boolean;
export interface IotPublishOutcome {
    readonly ok: boolean;
    readonly result: PublishResult;
    readonly rejected: readonly ClassifiedRejection[];
}
/** 取預算 → 發布（限速就退避重送）；至少一座收下算成功 */
export declare function iotPublish(pool: IotTransport, budget: RelayEventBudget, event: NostrEvent): Promise<IotPublishOutcome>;
//# sourceMappingURL=transport.d.ts.map