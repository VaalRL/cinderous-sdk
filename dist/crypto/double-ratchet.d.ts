import { type PqKeyPair } from '../protocol/hybrid-kem.js';
import type { EncryptedEnvelope, ICryptoSession } from './types.js';
/** 跳過（亂序、遺失）的訊息金鑰最多留幾把（PRD 3.5.2） */
export declare const DEFAULT_MAX_SKIPPED_KEYS = 2000;
/** `maxSkippedKeys` 的上限：再大，對方一個假序號就能讓我們算上萬次 HMAC */
export declare const MAX_SKIPPED_KEYS_LIMIT = 10000;
/** 後量子：我每送幾則就發起一輪新的 ML-KEM（ADR 0033 §3；iMessage PQ3 也是約 50 則） */
export declare const DEFAULT_PQ_REKEY_INTERVAL = 50;
/** `pqRekeyInterval` 的上限 */
export declare const MAX_PQ_REKEY_INTERVAL = 10000;
/** 對方步進幾次、後量子輪次仍沒有進展，就視為遭遇降級（ADR 0033 §6） */
export declare const PQ_STALL_LIMIT = 16;
/**
 * 對方送來的訊息**通過 MAC** 卻違反協定（KEM 編號跳號、回報不存在的公鑰、公鑰不合法……）。
 * 只有惡意或有 bug 的對方會這樣：會話已銷毀，`secureChannel` 會關閉通道（ADR 0033 §10 #5）。
 */
export declare class RatchetProtocolError extends Error {
    readonly name = "RatchetProtocolError";
}
export interface RatchetKeyPair {
    secretKey: Uint8Array;
    /** 32 位元組 x-only */
    publicKey: Uint8Array;
}
export declare function generateRatchetKeyPair(): RatchetKeyPair;
/**
 * 從線路上的位元組讀出 header 有多長（不驗內容）；不是認得的格式就回 0。
 * `secureChannel` 用它把「header ‖ 密文」切開。
 */
export declare function ratchetHeaderLength(bytes: Uint8Array): number;
export interface RatchetInit {
    role: 'alice' | 'bob';
    /** 握手導出的共享秘密（32 位元組） */
    sharedSecret: Uint8Array;
    /** 綁定雙方身分的附加資料（每則都驗） */
    associatedData: Uint8Array;
    peerPublicKey: string;
    maxSkippedKeys?: number | undefined;
    /** 後量子：我每送幾則就發起一輪新的 ML-KEM（1～10,000，預設 50；ADR 0033 §3） */
    pqRekeyInterval?: number | undefined;
}
export declare class DoubleRatchetSession implements ICryptoSession {
    #private;
    readonly engineType: "double-ratchet";
    private constructor();
    /** 先送的一方：知道對方的初始棘輪公鑰（與 ML-KEM 公鑰）後，立刻有傳送鏈。 */
    static initAlice(init: Omit<RatchetInit, 'role'> & {
        bobRatchetPublicKey: Uint8Array;
        bobKemPublicKey?: Uint8Array | undefined;
    }): DoubleRatchetSession;
    /** 後送的一方：用握手時公布的棘輪金鑰對起步；收到對方第一則之後才有傳送鏈。 */
    static initBob(init: Omit<RatchetInit, 'role'> & {
        ratchetKeyPair: RatchetKeyPair;
        kemKeyPair?: PqKeyPair | undefined;
        kemSeed?: Uint8Array | undefined;
    }): DoubleRatchetSession;
    get peerPublicKey(): string;
    get postQuantum(): boolean;
    /** 已經可以送了嗎（後送的一方要等收到第一則） */
    get canSend(): boolean;
    encrypt(plaintext: Uint8Array): Promise<EncryptedEnvelope>;
    decrypt(envelope: EncryptedEnvelope): Promise<Uint8Array>;
    /**
     * 匯出狀態並**銷毀這個會話**（搬走，不是複製）：同一份狀態同時活在兩處，就會用同一把訊息金鑰加密兩次。
     * 匯出的內容含鏈金鑰，必須加密保存；不可複製到另一台裝置，也不要還原比較舊的那一份。
     */
    exportState(): Promise<Uint8Array>;
    /**
     * 從 `exportState` 還原。格式有任何不對就丟例外。
     * v0.27 以前匯出的古典會話（v:1）照樣還原；v0.27 以前的**後量子**會話線路格式已不同，只能重新握手。
     */
    static fromState(bytes: Uint8Array): DoubleRatchetSession;
    destroy(): void;
}
//# sourceMappingURL=double-ratchet.d.ts.map