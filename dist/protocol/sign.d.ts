import { type EventTemplate, type NostrEvent } from "./event.js";
import { type SecretKey } from "./keys.js";
/** 以私鑰補上 pubkey、計算 id 並 Schnorr 簽章，產出完整事件。 */
export declare function finalizeEvent(template: EventTemplate, sk: SecretKey): NostrEvent;
/**
 * 驗證事件：
 * 1. id 必須等於重新計算的 hash（防止欄位竄改）。
 * 2. Schnorr 簽章對 (id, pubkey) 必須有效。
 */
export declare function verifyEvent(event: NostrEvent): boolean;
//# sourceMappingURL=sign.d.ts.map