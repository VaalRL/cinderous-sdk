// NIP-62 Request to Vanish（ADR-0260）：讓使用者要求中繼站**立即**清除自己的資料，
// 而不是等 7 天 TTL 自然過期。
//
// ## 為什麼本專案需要它
//
// 在此之前，使用者對「中繼站上還留著我什麼」**沒有任何主動權**：
//
// - 個人：只能等 NIP-40 的 7 天 TTL（ADR-0065）；
// - 企業離職：名冊移除＋allowlist 擋的是**未來發布**（ADR-0163 決策 #2），
//   已經躺在離線信箱裡的殘留照樣躺到過期。
//
// ## 為什麼 `p` tag 是刪除的關鍵
//
// Gift Wrap 的外層作者是**一次性金鑰**（NIP-59 刻意如此，藏寄件者），所以「刪掉我的事件」
// 光看 `pubkey` 欄位是抓不到收件匣的——唯一能定位「這封是給我的」的就是 `#p`。NIP-62 規範
// 也明寫應刪除「Gift Wraps mentioning the pubkey」，與本專案的資料形狀正好對上。
//
// ## 安全性天然成立
//
// kind 62 必須以**本人私鑰**簽章，他人無法代發；而「刪掉我的收件匣」刪的是*寄給我的*訊息
// ——那本來就是我的資料。中繼端另有 NIP-42 身分比對與重放窗（見 `relay-core.ts`）。

import type { NostrEvent } from "./event.js";
import { signWith } from "./key-ops.js";
import { relayHostOf } from "./nip42.js";
import type { SecretKeyOrSigner } from "./signer.js";

/** NIP-62 請求清除事件的 kind。 */
export const VANISH_KIND = 62;

/** NIP-62 的全域目標值（大寫）：要求**所有**中繼站清除。 */
export const ALL_RELAYS = "ALL_RELAYS";

/**
 * 建構 NIP-62 清除請求（以本人私鑰簽章）。
 *
 * `target` 填單一中繼 URL（只清那一座）或 {@link ALL_RELAYS}（清全部）。`reason` 進 content，
 * 純為人類可讀的備註——**中繼不得依它做任何判斷**（別讓刪除與否取決於使用者打了什麼字）。
 */
export function buildVanishRequest(
  target: string,
  /** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
  sk: SecretKeyOrSigner,
  opts: { created_at?: number; reason?: string } = {},
): NostrEvent {
  return signWith(
    {
      kind: VANISH_KIND,
      created_at: opts.created_at ?? Math.floor(Date.now() / 1000),
      tags: [["relay", target]],
      content: opts.reason ?? "",
    },
    sk,
  );
}

/** 取清除請求的所有 `relay` tag 值（可能多個；含 {@link ALL_RELAYS}）。 */
export function vanishTargetsOf(event: NostrEvent): string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === "relay" && tag[1] !== undefined) out.push(tag[1]);
  }
  return out;
}

/**
 * 這份清除請求是否指向本站。
 *
 * - **無任何 `relay` tag → false**：NIP-62 要求至少一個目標；沒有目標的請求無從判斷範圍，
 *   而「刪除」這個動作不該對模糊輸入寬容。
 * - `ALL_RELAYS` → true（全域請求）。
 * - 其餘比對**主機**（沿用 NIP-42 的 {@link relayHostOf}：客戶端記 `wss://host`、
 *   中繼看到的是 `https://host/`，逐字比對本來就不會相同）。
 * - `expectedHost` 為 undefined（宿主沒提供本站主機）時，**只認 `ALL_RELAYS`**。
 *   這與 NIP-42 `relay` tag 檢查「不給就不強制」的寬鬆處理**刻意相反**——認證放寬只是少一道
 *   防線，刪除放寬則會讓「發給 A 站的請求」把 B 站的資料也清掉。不可逆的動作採 fail-closed。
 */
export function vanishTargetsRelay(event: NostrEvent, expectedHost: string | undefined): boolean {
  const targets = vanishTargetsOf(event);
  if (targets.length === 0) return false;
  if (targets.includes(ALL_RELAYS)) return true;
  const expected = relayHostOf(expectedHost);
  if (expected === undefined) return false;
  return targets.some((t) => relayHostOf(t) === expected);
}
