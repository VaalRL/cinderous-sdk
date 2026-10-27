import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
/**
 * NIP-01 規定的事件序列化：對 `[0, pubkey, created_at, kind, tags, content]`
 * 做無多餘空白的 UTF-8 JSON 編碼，作為計算 id 的輸入。
 */
export function serializeEvent(event) {
    return JSON.stringify([
        0,
        event.pubkey,
        event.created_at,
        event.kind,
        event.tags,
        event.content,
    ]);
}
/** event id：序列化字串的 sha256（小寫 hex）。 */
export function getEventHash(event) {
    return bytesToHex(sha256(utf8ToBytes(serializeEvent(event))));
}
/** 任意 UTF-8 文字的 sha256（小寫 hex）；供內容定址（如自製貼圖 id）使用。 */
export function contentHash(text) {
    return bytesToHex(sha256(utf8ToBytes(text)));
}
//# sourceMappingURL=event.js.map