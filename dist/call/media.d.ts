export interface MediaTrackLike {
    readonly kind: string;
    /** 靜音用（SDK ADR 0141）：設 false＝送靜音／黑畫面，但裝置還開著 */
    enabled?: boolean;
    stop(): void;
    applyConstraints?(constraints: unknown): Promise<void>;
}
export interface MediaStreamLike {
    getTracks(): MediaTrackLike[];
    getVideoTracks(): MediaTrackLike[];
    addTrack?(track: MediaTrackLike): void;
    removeTrack?(track: MediaTrackLike): void;
}
export interface RtpSenderLike {
    readonly track: MediaTrackLike | null;
    replaceTrack(track: MediaTrackLike | null): Promise<void>;
    getParameters?(): {
        encodings?: Record<string, unknown>[];
    };
    setParameters?(params: unknown): Promise<void>;
    /** 補綁 msid（SDK ADR 0141）：舊版對端的 `ontrack` 才拿得到 stream */
    setStreams?(...streams: MediaStreamLike[]): void;
}
export interface RtpTransceiverLike {
    direction: string;
    /**
     * 協商過才有（SDK ADR 0141，Cinderous ADR-0424）：自己 `addTransceiver`、卻沒被遠端 offer 採用的那條恆為 `null`，
     * 從它送出去的畫格對方收不到。沒有這個欄位的環境當作都協商過。
     */
    readonly mid?: string | null;
    stop?(): void;
    readonly sender: RtpSenderLike;
    readonly receiver: {
        readonly track: MediaTrackLike | null;
    };
}
export interface CallPeerConnectionLike {
    readonly connectionState: string;
    createOffer(): Promise<{
        type: string;
        sdp?: string;
    }>;
    createAnswer(): Promise<{
        type: string;
        sdp?: string;
    }>;
    setLocalDescription(description: {
        type: string;
        sdp?: string;
    }): Promise<void>;
    setRemoteDescription(description: {
        type: string;
        sdp: string;
    }): Promise<void>;
    addIceCandidate(candidate: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
    }): Promise<void>;
    addTrack(track: MediaTrackLike, stream: MediaStreamLike): unknown;
    addTransceiver(kind: string, init: {
        direction: string;
        streams?: MediaStreamLike[];
    }): unknown;
    getTransceivers(): RtpTransceiverLike[];
    getSenders(): RtpSenderLike[];
    close(): void;
    onicecandidate: ((event: {
        candidate: {
            candidate: string;
            sdpMid?: string | null;
            sdpMLineIndex?: number | null;
        } | null;
    }) => void) | null;
    /** 🔴 `streams` 可能是空的（對方的 transceiver 沒綁 stream）：一定要看 `track`（Cinderous ADR-0424） */
    ontrack: ((event: {
        streams: readonly MediaStreamLike[];
        track?: MediaTrackLike;
    }) => void) | null;
    onconnectionstatechange: (() => void) | null;
}
export type CallRtcFactory = (config: {
    iceServers?: unknown[];
}) => CallPeerConnectionLike;
export type GetUserMedia = (constraints: {
    audio: boolean;
    video: unknown;
}) => Promise<MediaStreamLike>;
/** 用一組軌建一個新的串流物件（瀏覽器是 `new MediaStream(tracks)`） */
export type CreateMediaStream = (tracks: MediaTrackLike[]) => MediaStreamLike;
/** 瀏覽器預設 `new MediaStream(tracks)`；沒有就用最小實作 */
export declare function defaultCreateMediaStream(): CreateMediaStream;
/** 鏡頭忙碌（多數手機不能同時開兩顆）：只有這類錯誤才值得「先關舊的再開新的」（Cinderous ADR-0424） */
export declare function isCameraBusy(error: unknown): boolean;
/** 協商過（或環境沒有 mid 可看）、還沒停的 transceiver */
export declare function isNegotiated(t: RtpTransceiverLike): boolean;
/** 瀏覽器預設；沒有就回 null，建構 `CallManager` 時要自己注入 */
export declare function defaultCallRtc(): CallRtcFactory | null;
export declare function defaultGetUserMedia(): GetUserMedia | null;
//# sourceMappingURL=media.d.ts.map