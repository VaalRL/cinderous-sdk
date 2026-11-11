import type { EventTemplate, NostrEvent } from "./event.js";
import type { SecretKeyOrSigner } from "./signer.js";
/** NIP-98 HTTP Auth 事件 kind。 */
export declare const HTTP_AUTH_KIND = 27235;
/**
 * 允許的時鐘偏移（秒）。
 *
 * ⚠ 太嚴會擋掉時鐘不準的裝置（他們拿不到 TURN、退回純 STUN）；
 * 太鬆則放大重放窗口。60 秒是兩者的折衷。
 */
export declare const HTTP_AUTH_SKEW_SEC = 60;
/**
 * 授權事件的選項（SDK ADR 0132）。
 *
 * `payload`：把**請求內容**也綁進簽章（NIP-98 的 `payload` tag＝內容 UTF-8 的 sha256 小寫十六進位）。
 * 有內容的請求（例如 NIP-86 的 POST）要帶，否則截到標頭的人在時間窗內能換掉內容重送。
 */
export interface HttpAuthOptions {
    payload?: string;
}
/** 內容的 sha256（NIP-98 `payload` tag 的值）。 */
export declare function httpAuthPayloadHash(payload: string): string;
/** 簽一個綁定 URL＋method＋時間（＋可選的內容）的授權事件。 */
export declare function buildHttpAuthEvent(url: string, method: string, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
sk: SecretKeyOrSigner, nowSec?: number, opts?: HttpAuthOptions): NostrEvent;
/**
 * 未簽章的授權事件範本（SDK ADR 0017：從 `buildHttpAuthEvent` 抽出，
 * 讓不交出私鑰的簽章者——例如 SDK 的 `Identity`——也能簽出同一種格式）。
 */
export declare function httpAuthTemplate(url: string, method: string, nowSec?: number, opts?: HttpAuthOptions): EventTemplate;
/** 包成 `Authorization` 標頭的值。 */
export declare function httpAuthHeader(event: NostrEvent): string;
/**
 * 事件結構驗證——**必須在 `verifyEvent` 之前**（ADR-0235 C1）。
 *
 * `verifyEvent` 只保證「`id` 是這串 JSON 的 sha256、`sig` 是 `pubkey` 對 `id` 的簽章」，
 * **完全不檢查欄位型別**。攻擊者可以對 `{tags:{}}` 這種形狀自己算 hash、自己簽，
 * `verifyEvent` 會回傳 true，接著 `tags.find(...)` 拋 `TypeError`。
 */
export declare function isValidAuthEventShape(e: unknown): boolean;
/**
 * 驗證 `Authorization` 標頭。回傳簽署者 pubkey，或 `null`（一律當作未授權）。
 *
 * ⚠ **回傳 `null` 不區分原因**——對外不說「是簽章壞了還是時間過期」，
 * 那對攻擊者是免費的偵錯資訊，對正常使用者也幫不上忙（他們的客戶端會自己重簽）。
 */
export declare function verifyHttpAuth(header: string | null, url: string, method: string, nowSec?: number, 
/** 給了 `payload`＝要求簽章綁定這份內容（SDK ADR 0132）；沒給＝不檢查，與之前相同 */
opts?: HttpAuthOptions): string | null;
/**
 * 這個標頭是誰簽的（SDK ADR 0133）：驗簽章與時間窗，**不看** `u`／`method`／`payload`。
 *
 * 給「讀請求內容之前先擋人」用：伺服器可以在還沒收任何內容時就拒絕不是自己人的請求。
 * ⚠ 它**不是**授權——通過之後仍要用 {@link verifyHttpAuth} 綁定網址、方法與內容。
 */
export declare function httpAuthSigner(header: string | null | undefined, nowSec?: number): string | null;
//# sourceMappingURL=http-auth.d.ts.map