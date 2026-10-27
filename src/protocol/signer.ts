import type { EventTemplate, NostrEvent } from "./event.js";
import type { PubkeyHex, SecretKey } from "./keys.js";

/**
 * 不交出私鑰的身分（SDK ADR 0023 §2）：協定與同步 API 需要的全部能力，只有這三樣。
 *
 * - `pubkey`：64 位 hex 公鑰。
 * - `sign`：補上 pubkey、id 與 Schnorr 簽章。
 * - `conversationKey`：與某個公鑰的 NIP-44 對話金鑰（ECDH 後的 HKDF-extract，32 bytes）。
 *   要的是**對話金鑰**而不是「加密／解密」兩個方法：NIP-59 的後量子混合封裝（ADR-0365）
 *   要把古典對話金鑰與 ML-KEM 的共享秘密再混一次，只給加解密做不到。
 *   拿到它能做的事與 NIP-44 加解密相同，不是私鑰（SDK ADR 0010 已經這樣交出）。
 *
 * SDK 的 `Identity` 實作這個介面，所以凡是收 `SecretKey | NostrSigner` 的函式都能直接傳 `Identity`。
 * 這些函式的線上格式與傳原始私鑰時**逐位元組相同**（除了本來就隨機的 nonce 與一次性金鑰）。
 */
export interface NostrSigner {
  readonly pubkey: PubkeyHex;
  sign(template: EventTemplate): NostrEvent;
  conversationKey(pubkey: PubkeyHex): Uint8Array;
}

/** 原始私鑰（既有呼叫方式）或不交出私鑰的簽章者（例如 `Identity`）。 */
export type SecretKeyOrSigner = SecretKey | NostrSigner;

/**
 * 是不是 `NostrSigner`。以形狀判斷，不用 `instanceof`：外掛可能在別的 realm（iframe、Worker）建立物件，
 * 原始私鑰也可能是別的 realm 的 `Uint8Array`。
 */
export function isNostrSigner(value: unknown): value is NostrSigner {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return false;
  const v = value as Partial<NostrSigner>;
  return typeof v.pubkey === "string" && typeof v.sign === "function" && typeof v.conversationKey === "function";
}
