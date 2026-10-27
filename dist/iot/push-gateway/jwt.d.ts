/** PEM（PKCS#8）→ DER；格式不對丟出不含內容的錯誤 */
export declare function pemToDer(pem: string, what: string): Uint8Array;
/** WebCrypto 的金鑰型別（DOM 與 Node 的型別宣告都適用） */
export type PushCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
/** 匯入 RS256 私鑰（FCM 服務帳號） */
export declare function importRs256Key(pem: string, what: string): Promise<PushCryptoKey>;
/** 匯入 ES256 私鑰（APNs 的 .p8） */
export declare function importEs256Key(pem: string, what: string): Promise<PushCryptoKey>;
/** 簽一顆 JWT（RS256 或 ES256；ES256 的 WebCrypto 輸出就是 JWS 要的 r‖s） */
export declare function signJwt(key: PushCryptoKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string>;
//# sourceMappingURL=jwt.d.ts.map