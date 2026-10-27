import type { PubkeyHex, SecretKey } from "./keys.js";
import { type SecretKeyOrSigner } from "./signer.js";
/**
 * NIP-44 v2 加密的薄包裝。密碼學原語委由審計過的 `nostr-tools/nip44`
 * （底層 @noble）；事件/簽章仍由本 core 自有實作（見 docs/adr/0007）。
 *
 * conversation key 具對稱性：`(senderSk, recipientPk)` 與
 * `(recipientSk, senderPk)` 導出相同金鑰。
 *
 * 私鑰的位置也可以傳 `NostrSigner`（例如 `Identity`；SDK ADR 0023），不必交出原始私鑰。
 */
export declare function encryptDM(plaintext: string, senderSk: SecretKeyOrSigner, recipientPk: PubkeyHex): string;
/** 以收件人私鑰（或 `NostrSigner`）與寄件人公鑰解出 NIP-44 密文。金鑰不符時拋錯。 */
export declare function decryptDM(ciphertext: string, recipientSk: SecretKeyOrSigner, senderPk: PubkeyHex): string;
/**
 * 古典 NIP-44 對話金鑰＝`ECDH(sk, pk)` 再過 HKDF-extract（32 bytes）。
 *
 * ⚠ 這是**古典那一半**，直接拿去加密就是現行行為；要後量子請再過
 * `hybridConversationKey()`。
 */
export declare function conversationKey(sk: SecretKey, pk: PubkeyHex): Uint8Array;
/** 用一把已經算好的對話金鑰加密（線路格式仍是標準 NIP-44 v2 payload）。 */
export declare function encryptWithKey(plaintext: string, key: Uint8Array): string;
/**
 * 用一把已經算好的對話金鑰解密。
 *
 * ⚠ 金鑰不對時這裡會因 **MAC 驗證失敗**而拋——後量子路徑上，ML-KEM 的隱式拒絕
 * （密文被竄改不拋錯，只回一把不同的祕密，見 `hybrid-kem.ts`）最終就是在這裡被擋下來的。
 */
export declare function decryptWithKey(ciphertext: string, key: Uint8Array): string;
//# sourceMappingURL=nip44.d.ts.map