import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getEventHash, type EventTemplate, type NostrEvent } from "./event.js";
import { getPublicKey, type SecretKey } from "./keys.js";

/** 以私鑰補上 pubkey、計算 id 並 Schnorr 簽章，產出完整事件。 */
export function finalizeEvent(template: EventTemplate, sk: SecretKey): NostrEvent {
  const pubkey = getPublicKey(sk);
  const id = getEventHash({ ...template, pubkey });
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk));
  return { ...template, pubkey, id, sig };
}

/**
 * 驗證事件：
 * 1. id 必須等於重新計算的 hash（防止欄位竄改）。
 * 2. Schnorr 簽章對 (id, pubkey) 必須有效。
 */
export function verifyEvent(event: NostrEvent): boolean {
  if (getEventHash(event) !== event.id) return false;
  try {
    // @noble/curves 2.x 只收位元組（SDK ADR 0020）；不合法的 hex 在這裡丟例外 ⇒ 驗章失敗
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}
