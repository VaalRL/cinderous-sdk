import type { PubkeyHex } from "./keys.js";
/** 建立事件時由呼叫端提供的欄位。 */
export interface EventTemplate {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
}
/** 已知作者、尚未簽章（用於計算 id）。 */
export interface UnsignedEvent extends EventTemplate {
    pubkey: PubkeyHex;
}
/** 完整、可在網路上傳遞的 Nostr 事件。 */
export interface NostrEvent extends UnsignedEvent {
    id: string;
    sig: string;
}
/**
 * NIP-01 規定的事件序列化：對 `[0, pubkey, created_at, kind, tags, content]`
 * 做無多餘空白的 UTF-8 JSON 編碼，作為計算 id 的輸入。
 */
export declare function serializeEvent(event: UnsignedEvent): string;
/** event id：序列化字串的 sha256（小寫 hex）。 */
export declare function getEventHash(event: UnsignedEvent): string;
/** 任意 UTF-8 文字的 sha256（小寫 hex）；供內容定址（如自製貼圖 id）使用。 */
export declare function contentHash(text: string): string;
//# sourceMappingURL=event.d.ts.map