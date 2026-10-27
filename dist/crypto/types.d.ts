export type CryptoEngineType = 'cinder-ek' | 'double-ratchet';
export interface EncryptedEnvelope {
    readonly engineType: CryptoEngineType;
    readonly kemAlgorithm?: 'cinder-ek-pq-v1' | 'pq-double-ratchet-v1' | 'pq-double-ratchet-v2';
    /** DH 公鑰、訊息序號；後量子時另有 KEM 回報與輪次，偶爾附 ML-KEM 公鑰或封裝密文（ADR 0033） */
    readonly header: Uint8Array;
    readonly ciphertext: Uint8Array;
}
export interface ICryptoSession {
    readonly engineType: CryptoEngineType;
    readonly peerPublicKey: string;
    encrypt(plaintext: Uint8Array): Promise<EncryptedEnvelope>;
    /** 解不開（竄改、重放、不是這個會話的）就丟例外，而且會話狀態不變 */
    decrypt(envelope: EncryptedEnvelope): Promise<Uint8Array>;
    /** 會話狀態（含鏈金鑰）：要保存就必須加密；不可複製到另一台裝置 */
    exportState(): Promise<Uint8Array>;
    /** 清掉記憶體裡的金鑰；之後不能再用 */
    destroy(): void;
}
//# sourceMappingURL=types.d.ts.map