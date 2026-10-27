export declare const FRAME_VERSION = 1;
export declare const FRAME_HEADER_BYTES = 17;
/** DataChannel 每框承載 16 KB（ADR 0006）：瀏覽器之間相容性最好的訊息大小。 */
export declare const FRAME_PAYLOAD_BYTES: number;
/**
 * 中繼軌每框承載 48,000 B（ADR 0006，同 Cinderous 的檔案塊 kind 1060）。
 * 包兩層 NIP-44 後約 131 KB，低於中繼單則上限 262,144 B（ADR 0009 更正）。
 */
export declare const RELAY_FRAME_PAYLOAD_BYTES = 48000;
/** 收端接受的單框承載上限：兩條軌道中較大的那個。 */
export declare const MAX_FRAME_PAYLOAD_BYTES = 48000;
/** 一則訊息預設上限 64 MB：對方宣稱的總數超過就整則不收。 */
export declare const DEFAULT_MAX_MESSAGE_BYTES: number;
/** 組到一半的訊息預設 60 秒沒收齊就丟掉。 */
export declare const DEFAULT_ASSEMBLY_TIMEOUT_MS = 60000;
export interface DecodedFrame {
    /** 訊息 id（hex） */
    id: string;
    seq: number;
    total: number;
    payload: Uint8Array;
}
/** 把一則訊息切成框。空資料也是一框，對方才收得到「空訊息」。 */
export declare function encodeFrames(data: Uint8Array, payloadBytes?: number): Uint8Array[];
/** 解開一框；格式不對就回 null（對方送什麼都不該讓我們拋例外）。 */
export declare function decodeFrame(frame: Uint8Array): DecodedFrame | null;
export interface FrameAssemblerOptions {
    maxMessageBytes?: number;
    timeoutMs?: number;
    now?: () => number;
}
/** 把框組回訊息：亂序可、重複可，逾時或過大的整則丟掉。 */
export declare class FrameAssembler {
    #private;
    constructor(opts?: FrameAssemblerOptions);
    get pendingCount(): number;
    /** 收一框；收齊時回傳整則訊息，否則回 undefined。 */
    push(raw: Uint8Array): Uint8Array | undefined;
}
//# sourceMappingURL=frames.d.ts.map