import type { NostrEvent } from "./event.js";
import type { SecretKeyOrSigner } from "./signer.js";
/** 收件確認事件的 kind（Cinderous 中繼擴充；不是標準 NIP）。 */
export declare const INBOX_ACK_KIND = 25190;
/** 一則收件確認最多帶幾個 id（超過分多則送）。 */
export declare const INBOX_ACK_MAX_IDS = 500;
/** 建構收件確認（以收件人本人的金鑰簽章）。`ids` 是處理完的外層事件 id；重複的只留一個。 */
export declare function buildInboxAck(ids: readonly string[], 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
sk: SecretKeyOrSigner, opts?: {
    created_at?: number;
}): NostrEvent;
/**
 * 取收件確認裡的 id（中繼端用；不驗簽，簽章由呼叫端照常驗）。
 * kind 不對、空的、任何一段不是 64 位小寫 hex、超過 {@link INBOX_ACK_MAX_IDS} 個 ⇒ null（整則不處理）。
 */
export declare function inboxAckIdsOf(event: NostrEvent): string[] | null;
//# sourceMappingURL=inbox-ack.d.ts.map