import type { Identity } from '../identity.js';
import type { PeerChannel, TransportMode } from '../peer/peer-node.js';
export declare const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;
export interface SecureChannelOptions {
    /** 要求後量子（預設 true）：對方的 hello 沒有 ML-KEM 公鑰就丟 `SecurityDowngradeError` */
    postQuantum?: boolean;
    maxSkippedKeys?: number;
    /** 後量子：每送幾則發起一輪新的 ML-KEM（1～10,000，預設 50；越小，量子攻擊者在金鑰外洩後能跟的訊息越少，頻寬越大。ADR 0033 §3） */
    pqRekeyInterval?: number;
    handshakeTimeoutMs?: number;
    /** App 的 onMessage 監聽丟了例外時通知（不影響之後的訊息） */
    onListenerError?: (error: unknown) => void;
}
export interface SecureChannel {
    readonly peerPublicKey: string;
    readonly mode: TransportMode;
    readonly engineType: 'double-ratchet';
    readonly postQuantum: boolean;
    send(data: Uint8Array): Promise<void>;
    onMessage(listener: (data: Uint8Array) => void): () => void;
    onClose(listener: () => void): () => void;
    close(): void;
}
/** 對方的 SDK 不支援我們要的後量子線路格式（例如 v0.27 以前的版本）：請雙方升級，不會退回舊格式或古典。 */
export declare class UnsupportedRatchetVersionError extends Error {
    readonly peer: string;
    /** 對方宣告的版本；空陣列＝沒宣告（v0.27 以前） */
    readonly peerFormats: readonly number[];
    readonly name = "UnsupportedRatchetVersionError";
    constructor(peer: string, 
    /** 對方宣告的版本；空陣列＝沒宣告（v0.27 以前） */
    peerFormats: readonly number[]);
}
/** 在 `channel` 上握手，回傳雙棘輪加密的通道。對方也要對同一條通道呼叫 `secureChannel`。 */
export declare function secureChannel(channel: PeerChannel, identity: Identity, opts?: SecureChannelOptions): Promise<SecureChannel>;
//# sourceMappingURL=secure-channel.d.ts.map