import type { NostrEvent } from "./event.js";
import type { PubkeyHex } from "./keys.js";
import type { SecretKeyOrSigner } from "./signer.js";
/** WebRTC 信令使用的 ephemeral kind（21000-21999，NIP-59 包封）。 */
export declare const SDP_SIGNAL_KIND = 21000;
export interface OfferAnswerSignal {
    type: "offer" | "answer";
    sdp: string;
}
/** 單一 ICE candidate 的資料。 */
export interface IceCandidateData {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
}
export interface CandidateSignal extends IceCandidateData {
    type: "candidate";
}
/** 批次 ICE candidate（A6：把一陣爆發的候選合併成單一信令，減少中繼發佈數）。 */
export interface CandidatesSignal {
    type: "candidates";
    candidates: IceCandidateData[];
}
/** WebRTC 信令內容（SDP offer/answer 或 ICE candidate，單一或批次）。 */
export type Signal = OfferAnswerSignal | CandidateSignal | CandidatesSignal;
export interface ReceivedSignal {
    /** 經身分驗證的寄件人公鑰。 */
    sender: PubkeyHex;
    signal: Signal;
}
/**
 * 將 WebRTC 信令封成 NIP-59 ephemeral 事件（kind 21000）。
 * 以 Gift Wrap 隱藏收發雙方，避免中繼站得知「誰在呼叫誰」；
 * 不帶 NIP-40 過期，僅供即時記憶體轉發。
 */
export declare function createSignal(signal: Signal, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
senderSk: SecretKeyOrSigner, recipientPk: PubkeyHex, opts?: {
    now?: number;
}): NostrEvent;
/** 解開並驗證信令事件，回傳寄件人與信令內容。內容結構非法時拋錯。 */
export declare function readSignal(event: NostrEvent, recipientSk: SecretKeyOrSigner): ReceivedSignal;
/** 解析並驗證信令內容結構（信任邊界檢查，避免後續 undefined 連鎖）。 */
export declare function parseSignal(content: string): Signal;
/**
 * ICE candidate 批次緩衝（A6）：短時間累積候選，`drain()` 一次取出為單一
 * {@link CandidatesSignal}，讓執行期以一則信令送出多個候選，減少中繼發佈數。
 */
export declare class CandidateBatch {
    private buf;
    add(candidate: IceCandidateData): void;
    get size(): number;
    /** 取出目前緩衝為批次信令並清空；空時回傳 null。 */
    drain(): CandidatesSignal | null;
}
//# sourceMappingURL=signaling.d.ts.map