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
/** 簽一個綁定 URL＋method＋時間的授權事件。 */
export declare function buildHttpAuthEvent(url: string, method: string, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
sk: SecretKeyOrSigner, nowSec?: number): NostrEvent;
/**
 * 未簽章的授權事件範本（SDK ADR 0017：從 `buildHttpAuthEvent` 抽出，
 * 讓不交出私鑰的簽章者——例如 SDK 的 `Identity`——也能簽出同一種格式）。
 */
export declare function httpAuthTemplate(url: string, method: string, nowSec?: number): EventTemplate;
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
export declare function verifyHttpAuth(header: string | null, url: string, method: string, nowSec?: number): string | null;
//# sourceMappingURL=http-auth.d.ts.map