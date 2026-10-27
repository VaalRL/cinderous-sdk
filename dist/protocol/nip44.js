// 子路徑引用（SDK ADR 0020）：根入口 "nostr-tools" 是一整包，打包時會連 NIP-04 等用不到的一起帶進來
import * as nip44 from "nostr-tools/nip44";
import { isNostrSigner } from "./signer.js";
/**
 * NIP-44 v2 加密的薄包裝。密碼學原語委由審計過的 `nostr-tools/nip44`
 * （底層 @noble）；事件/簽章仍由本 core 自有實作（見 docs/adr/0007）。
 *
 * conversation key 具對稱性：`(senderSk, recipientPk)` 與
 * `(recipientSk, senderPk)` 導出相同金鑰。
 *
 * 私鑰的位置也可以傳 `NostrSigner`（例如 `Identity`；SDK ADR 0023），不必交出原始私鑰。
 */
export function encryptDM(plaintext, senderSk, recipientPk) {
    return encryptWithKey(plaintext, keyWith(senderSk, recipientPk));
}
/** 以收件人私鑰（或 `NostrSigner`）與寄件人公鑰解出 NIP-44 密文。金鑰不符時拋錯。 */
export function decryptDM(ciphertext, recipientSk, senderPk) {
    return decryptWithKey(ciphertext, keyWith(recipientSk, senderPk));
}
// 與 key-ops.ts 的 conversationKeyOf 相同；這裡另寫一份，避免 nip44 ↔ key-ops 互相引用
function keyWith(key, pk) {
    return isNostrSigner(key) ? key.conversationKey(pk) : conversationKey(key, pk);
}
// ── 下面三個是「把對話金鑰拆出來」的版本（後量子 EK，ADR-0365）────────────────
//
// 為什麼要拆：`encryptDM` 把 ECDH 算在函式**內部**，呼叫端沒有插手的餘地。
// 混合式模式要的是「ECDH 出來之後、餵進 NIP-44 之前，再跟 ML-KEM 的共享祕密一起過一次
// HKDF」（見 `hybrid-kem.ts`）。⇒ 必須讓呼叫端拿得到古典那一半，也餵得進最終那一把。
//
// 🔴 **這三個函式不做任何混合**，它們只是把原本藏起來的步驟露出來。
// 混合的規則單獨放在 `hybridConversationKey()`，那裡有 fail-closed 檢查；
// 分開的理由是：混合規則只有一份，不論走哪條路徑都得經過它。
/**
 * 古典 NIP-44 對話金鑰＝`ECDH(sk, pk)` 再過 HKDF-extract（32 bytes）。
 *
 * ⚠ 這是**古典那一半**，直接拿去加密就是現行行為；要後量子請再過
 * `hybridConversationKey()`。
 */
export function conversationKey(sk, pk) {
    return nip44.getConversationKey(sk, pk);
}
/** 用一把已經算好的對話金鑰加密（線路格式仍是標準 NIP-44 v2 payload）。 */
export function encryptWithKey(plaintext, key) {
    return nip44.encrypt(plaintext, key);
}
/**
 * 用一把已經算好的對話金鑰解密。
 *
 * ⚠ 金鑰不對時這裡會因 **MAC 驗證失敗**而拋——後量子路徑上，ML-KEM 的隱式拒絕
 * （密文被竄改不拋錯，只回一把不同的祕密，見 `hybrid-kem.ts`）最終就是在這裡被擋下來的。
 */
export function decryptWithKey(ciphertext, key) {
    return nip44.decrypt(ciphertext, key);
}
//# sourceMappingURL=nip44.js.map