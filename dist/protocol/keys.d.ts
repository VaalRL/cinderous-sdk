/** 32-byte secp256k1 私鑰。 */
export type SecretKey = Uint8Array;
/** 32-byte x-only 公鑰的 hex 表示（Nostr pubkey）。 */
export type PubkeyHex = string;
/** 產生一把符合 secp256k1 的隨機私鑰（32 bytes）。 */
export declare function generateSecretKey(): SecretKey;
/** 由私鑰導出 Nostr 公鑰（BIP-340 x-only，hex）。 */
export declare function getPublicKey(sk: SecretKey): PubkeyHex;
/** 將公鑰（hex）編碼為 NIP-19 `npub`。 */
export declare function npubEncode(pubkey: PubkeyHex): string;
/** 將 `npub` 解碼回公鑰（hex）。 */
export declare function npubDecode(npub: string): PubkeyHex;
/** 將私鑰編碼為 NIP-19 `nsec`。 */
export declare function nsecEncode(sk: SecretKey): string;
/** 將 `nsec` 解碼回私鑰（bytes）。 */
export declare function nsecDecode(nsec: string): SecretKey;
//# sourceMappingURL=keys.d.ts.map