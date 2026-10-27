export interface RtcSessionDescriptionLike {
    type: string;
    sdp?: string;
}
export interface RtcIceCandidateLike {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
}
export interface RtcDataChannelLike {
    readonly readyState: string;
    binaryType: string;
    readonly bufferedAmount: number;
    send(data: Uint8Array): void;
    close(): void;
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onmessage: ((event: {
        data: unknown;
    }) => void) | null;
}
export interface RtcPeerConnectionLike {
    readonly iceConnectionState: string;
    createDataChannel(label: string, init?: {
        ordered?: boolean;
    }): RtcDataChannelLike;
    createOffer(): Promise<RtcSessionDescriptionLike>;
    createAnswer(): Promise<RtcSessionDescriptionLike>;
    setLocalDescription(description: RtcSessionDescriptionLike): Promise<void>;
    setRemoteDescription(description: RtcSessionDescriptionLike): Promise<void>;
    addIceCandidate(candidate: RtcIceCandidateLike): Promise<void>;
    close(): void;
    onicecandidate: ((event: {
        candidate: RtcIceCandidateLike | null;
    }) => void) | null;
    oniceconnectionstatechange: (() => void) | null;
    ondatachannel: ((event: {
        channel: RtcDataChannelLike;
    }) => void) | null;
}
export type RtcFactory = (config: {
    iceServers?: unknown[];
}) => RtcPeerConnectionLike;
/** 環境裡有全域 `RTCPeerConnection`（瀏覽器）就用它；沒有（Node）回 null＝只能走中繼。 */
export declare function defaultRtcFactory(): RtcFactory | null;
//# sourceMappingURL=rtc.d.ts.map