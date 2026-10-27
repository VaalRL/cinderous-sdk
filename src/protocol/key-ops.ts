// 內部工具（SDK ADR 0023 §2）：讓收 `SecretKey | NostrSigner` 的函式對兩種輸入做同一件事。
// 傳原始私鑰時走的是**與以前完全相同**的函式（finalizeEvent／nip44），不經任何轉接物件。
// 不從 `./protocol` 轉出：公開的只有 `NostrSigner` 介面與 `isNostrSigner`。
import type { EventTemplate, NostrEvent } from "./event.js";
import { getPublicKey, type PubkeyHex } from "./keys.js";
import { conversationKey } from "./nip44.js";
import { finalizeEvent } from "./sign.js";
import { isNostrSigner, type SecretKeyOrSigner } from "./signer.js";

/** 這把金鑰的公鑰 */
export function pubkeyOf(key: SecretKeyOrSigner): PubkeyHex {
  return isNostrSigner(key) ? key.pubkey : getPublicKey(key);
}

/** 補上 pubkey、id 與簽章 */
export function signWith(template: EventTemplate, key: SecretKeyOrSigner): NostrEvent {
  return isNostrSigner(key) ? key.sign(template) : finalizeEvent(template, key);
}

/** 與 `pk` 的古典 NIP-44 對話金鑰 */
export function conversationKeyOf(key: SecretKeyOrSigner, pk: PubkeyHex): Uint8Array {
  return isNostrSigner(key) ? key.conversationKey(pk) : conversationKey(key, pk);
}
