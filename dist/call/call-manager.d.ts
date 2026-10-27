import type { Identity } from '../identity.js';
import { type CallEndReason, type CallFailureReason, type CallMedia, type CallState } from '../protocol/call.js';
import { type VideoQuality } from '../protocol/video-quality.js';
import type { RelayTransport } from '../relay-pool.js';
import { type CallRtcFactory, type GetUserMedia, type MediaStreamLike } from './media.js';
export interface CallManagerOptions {
    identity: Identity;
    transport: RelayTransport;
    rtc?: CallRtcFactory;
    getUserMedia?: GetUserMedia;
    /** STUN／TURN；可為函式，每通電話建立連線時取當下的值 */
    iceServers?: unknown[] | (() => unknown[] | undefined);
    /** 封鎖的人打來：不響鈴、不回應 */
    isBlocked?: (pubkey: string) => boolean;
    videoQuality?: VideoQuality;
}
export declare class CallManager {
    #private;
    constructor(opts: CallManagerOptions);
    onIncoming(listener: (call: {
        peer: string;
        media: CallMedia;
    }) => void): () => void;
    onState(listener: (peer: string | null, state: CallState, media: CallMedia | null) => void): () => void;
    onLocalStream(listener: (stream: MediaStreamLike | null) => void): () => void;
    onRemoteStream(listener: (stream: MediaStreamLike | null) => void): () => void;
    /** 我在送什麼、對方在送什麼：兩者各自獨立（「我送視訊、他只送語音」是合法狀態） */
    onMedia(listener: (local: CallMedia, remote: CallMedia) => void): () => void;
    onEnded(listener: (reason: CallEndReason) => void): () => void;
    /** P2P 連不通（unreachable：多為限制網路、需要 TURN）或斷線（lost） */
    onFailed(listener: (peer: string, reason: CallFailureReason) => void): () => void;
    onError(listener: (message: string) => void): () => void;
    get state(): CallState;
    get peer(): string | null;
    get localMedia(): CallMedia | null;
    get remoteMedia(): CallMedia | null;
    startCall(peer: string, media: CallMedia): Promise<void>;
    accept(): Promise<void>;
    reject(): Promise<void>;
    hangup(): Promise<void>;
    /** 這通能不能在通話中切換語音／視訊（對方的 offer 沒有視訊 m-line 就不行；UI 據此不顯示按鈕） */
    canChangeMedia(): boolean;
    /** 通話中改變自己這一方的型態：先把相機換好，成功了才通知對方；失敗就改回去。 */
    setLocalMedia(media: CallMedia): Promise<void>;
    /** 畫質檔位：通話中呼叫立即生效（改編碼上限與擷取解析度） */
    setVideoQuality(quality: VideoQuality): void;
    close(): void;
}
//# sourceMappingURL=call-manager.d.ts.map