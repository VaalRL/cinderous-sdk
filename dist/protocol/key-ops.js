import { getPublicKey } from "./keys.js";
import { conversationKey } from "./nip44.js";
import { finalizeEvent } from "./sign.js";
import { isNostrSigner } from "./signer.js";
/** 這把金鑰的公鑰 */
export function pubkeyOf(key) {
    return isNostrSigner(key) ? key.pubkey : getPublicKey(key);
}
/** 補上 pubkey、id 與簽章 */
export function signWith(template, key) {
    return isNostrSigner(key) ? key.sign(template) : finalizeEvent(template, key);
}
/** 與 `pk` 的古典 NIP-44 對話金鑰 */
export function conversationKeyOf(key, pk) {
    return isNostrSigner(key) ? key.conversationKey(pk) : conversationKey(key, pk);
}
//# sourceMappingURL=key-ops.js.map