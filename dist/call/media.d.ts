export interface MediaTrackLike {
    readonly kind: string;
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
}
export interface RtpTransceiverLike {
    direction: string;
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
    ontrack: ((event: {
        streams: readonly MediaStreamLike[];
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
/** 瀏覽器預設；沒有就回 null，建構 `CallManager` 時要自己注入 */
export declare function defaultCallRtc(): CallRtcFactory | null;
export declare function defaultGetUserMedia(): GetUserMedia | null;
//# sourceMappingURL=media.d.ts.map