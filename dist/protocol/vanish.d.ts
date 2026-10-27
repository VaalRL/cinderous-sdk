import type { NostrEvent } from "./event.js";
import type { SecretKeyOrSigner } from "./signer.js";
/** NIP-62 請求清除事件的 kind。 */
export declare const VANISH_KIND = 62;
/** NIP-62 的全域目標值（大寫）：要求**所有**中繼站清除。 */
export declare const ALL_RELAYS = "ALL_RELAYS";
/**
 * 建構 NIP-62 清除請求（以本人私鑰簽章）。
 *
 * `target` 填單一中繼 URL（只清那一座）或 {@link ALL_RELAYS}（清全部）。`reason` 進 content，
 * 純為人類可讀的備註——**中繼不得依它做任何判斷**（別讓刪除與否取決於使用者打了什麼字）。
 */
export declare function buildVanishRequest(target: string, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
sk: SecretKeyOrSigner, opts?: {
    created_at?: number;
    reason?: string;
}): NostrEvent;
/** 取清除請求的所有 `relay` tag 值（可能多個；含 {@link ALL_RELAYS}）。 */
export declare function vanishTargetsOf(event: NostrEvent): string[];
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
export declare function vanishTargetsRelay(event: NostrEvent, expectedHost: string | undefined): boolean;
//# sourceMappingURL=vanish.d.ts.map