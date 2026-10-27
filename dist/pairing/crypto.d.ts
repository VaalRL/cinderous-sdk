import type { NostrSigner } from '../protocol/signer.js';
export declare const PAIRING_LABEL = "cinderous/pair/v1";
export interface PairingKeys {
    confirm: Uint8Array;
    memberToJoiner: Uint8Array;
    sas: Uint8Array;
}
/** 一次配對的識別碼（32 位 hex）。 */
export declare function pairingId(secret: Uint8Array): string;
export interface EphemeralKeyPair {
    secretKey: Uint8Array;
    /** x-only（32 bytes）hex */
    publicKey: string;
}
export declare function generateEphemeral(): EphemeralKeyPair;
/** 合法的 x-only 公鑰（在曲線上） */
export declare function isPoint(hex: unknown): hex is string;
export interface TranscriptInput {
    role: 'invite' | 'join';
    displayer: string;
    scanner: string;
    pid: string;
    scannerEphemeral: string;
    displayerEphemeral: string;
    scannerDevice: {
        deviceId: string;
        label: string;
    };
    displayerDevice: {
        deviceId: string;
        label: string;
    };
}
export declare function transcriptHash(t: TranscriptInput): Uint8Array;
export declare function deriveKeys(opts: {
    ephemeral: EphemeralKeyPair;
    peerEphemeral: string;
    signer: NostrSigner;
    peer: string;
    secret: Uint8Array;
    transcript: Uint8Array;
}): PairingKeys;
/** 確認 MAC（hex） */
export declare function confirmMac(keys: PairingKeys, label: string, transcript: Uint8Array): string;
/** 定時比較兩個 hex 字串 */
export declare function macEquals(a: unknown, b: string): boolean;
/** 6 位數短驗證碼（兩台螢幕比對用） */
export declare function sasCode(keys: PairingKeys): string;
/** XChaCha20-Poly1305；輸出 base64(nonce ‖ 密文) */
export declare function sealPayload(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): string;
export declare function openPayload(key: Uint8Array, sealed: unknown, aad: Uint8Array): Uint8Array | null;
//# sourceMappingURL=crypto.d.ts.map