// 收件確認（SDK ADR 0067）：收件人處理完自己收件匣裡的包，告訴中繼「這些我收好了」，
// 中繼把那幾列的到期時間降為「現在＋寬限」，不必放滿保存期。
//
// - **瞬時** kind：中繼當成控制訊息，不存、不轉發。
// - 以收件人**自己的**金鑰簽；中繼只在連線的 AUTH 身分＝簽章者時處理，而且只動寄給那個人的列
//   ⇒ 別人無法讓你的包提早過期。
// - content 只有外層事件 id，不帶任何標籤：不新增中繼看得到的資訊（ADR 0066）。

import type { NostrEvent } from "./event.js";
import { signWith } from "./key-ops.js";
import type { SecretKeyOrSigner } from "./signer.js";

/** 收件確認事件的 kind（Cinderous 中繼擴充；不是標準 NIP）。 */
export const INBOX_ACK_KIND = 25190;

/** 一則收件確認最多帶幾個 id（超過分多則送）。 */
export const INBOX_ACK_MAX_IDS = 500;

const EVENT_ID = /^[0-9a-f]{64}$/;

/** 建構收件確認（以收件人本人的金鑰簽章）。`ids` 是處理完的外層事件 id；重複的只留一個。 */
export function buildInboxAck(
  ids: readonly string[],
  /** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
  sk: SecretKeyOrSigner,
  opts: { created_at?: number } = {},
): NostrEvent {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new RangeError("收件確認至少要有一個 id");
  if (unique.length > INBOX_ACK_MAX_IDS) throw new RangeError(`收件確認一則最多 ${INBOX_ACK_MAX_IDS} 個 id`);
  for (const id of unique) if (!EVENT_ID.test(id)) throw new TypeError("收件確認的 id 必須是 64 位小寫 hex");
  return signWith(
    { kind: INBOX_ACK_KIND, created_at: opts.created_at ?? Math.floor(Date.now() / 1000), tags: [], content: unique.join(",") },
    sk,
  );
}

/**
 * 取收件確認裡的 id（中繼端用；不驗簽，簽章由呼叫端照常驗）。
 * kind 不對、空的、任何一段不是 64 位小寫 hex、超過 {@link INBOX_ACK_MAX_IDS} 個 ⇒ null（整則不處理）。
 */
export function inboxAckIdsOf(event: NostrEvent): string[] | null {
  if (event.kind !== INBOX_ACK_KIND || event.content === "") return null;
  // 先擋長度再 split：一則 500 個 id 的上限要在配置陣列之前就成立
  if (event.content.length > INBOX_ACK_MAX_IDS * 65) return null;
  const parts = event.content.split(",");
  if (parts.length > INBOX_ACK_MAX_IDS) return null;
  for (const part of parts) if (!EVENT_ID.test(part)) return null;
  return [...new Set(parts)];
}
