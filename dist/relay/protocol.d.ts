import type { NostrEvent } from "../protocol/index.js";
/**
 * Relay 端支援的訂閱 filter（NIP-01 子集，含 `#<tag>` 標籤 filter）。
 *
 * 契約同步：與 core 端的 `Filter`（`packages/core/src/presence.ts`）形狀相同，
 * 修改欄位時兩處須同步更新。
 */
export interface RelayFilter {
    ids?: string[];
    authors?: string[];
    kinds?: number[];
    since?: number;
    until?: number;
    limit?: number;
    /** 標籤 filter，如 `#p`（收件人）、`#e`（引用事件）。 */
    [tag: `#${string}`]: string[] | undefined;
}
export type ClientMessage = {
    type: "EVENT";
    event: NostrEvent;
} | {
    type: "REQ";
    subId: string;
    filters: RelayFilter[];
} | {
    type: "CLOSE";
    subId: string;
} | {
    type: "AUTH";
    event: NostrEvent;
} | {
    type: "INVALID";
    reason: string;
};
/** Relay → Client 訊息（NIP-01 + NIP-42 AUTH 挑戰）。 */
export type RelayMessage = ["EVENT", string, NostrEvent] | ["OK", string, boolean, string] | ["EOSE", string] | ["CLOSED", string, string] | ["NOTICE", string] | ["AUTH", string];
/** 解析客戶端送來的原始字串為結構化訊息；無法解析時回傳 INVALID。 */
export declare function parseClientMessage(raw: string): ClientMessage;
//# sourceMappingURL=protocol.d.ts.map