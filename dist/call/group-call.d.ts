import type { Identity } from '../identity.js';
import type { CallMedia } from '../protocol/call.js';
import { type CameraSelection, type VideoQuality } from '../protocol/video-quality.js';
import type { RelayTransport } from '../relay-pool.js';
import { type CallRtcFactory, type CreateMediaStream, type GetUserMedia, type MediaStreamLike } from './media.js';
export interface GroupCallManagerOptions {
    identity: Identity;
    transport: RelayTransport;
    rtc?: CallRtcFactory;
    getUserMedia?: GetUserMedia;
    createStream?: CreateMediaStream;
    /** STUN／TURN；可為函式，每條連線建立時取當下的值 */
    iceServers?: unknown[] | (() => unknown[] | undefined);
    /** 封鎖的人邀我：不響鈴、不回應 */
    isBlocked?: (pubkey: string) => boolean;
    /** 另一個通話（例如一對一的 `CallManager`）進行中：群組邀請一律回忙線 */
    isBusy?: () => boolean;
    videoQuality?: VideoQuality;
    /** 含自己的人數上限，預設 `GROUP_CALL_DEFAULT_MAX`，不得超過 `GROUP_CALL_HARD_MAX` */
    maxParticipants?: number;
    /** 被邀的人多久沒回應就標 `no-answer`；收到邀請沒接聽的這一方也在這之後自己結束（毫秒，預設 45 秒） */
    ringTimeoutMs?: number;
    /**
     * 某一對加入之後多久還沒連上就當作打不通（毫秒，預設 30 秒）：offer／answer 在信令上遺失、
     * 對方送完 join 就斷線時，ICE 會永遠停在 new，不會自己變 failed。
     */
    connectTimeoutMs?: number;
}
/** 連線建立前暫存的 ICE candidate，每人最多幾則（多的丟掉：正常一對只有個位數） */
export declare const GROUP_CALL_MAX_PENDING_CANDIDATES = 32;
export type GroupCallState = 'idle' | 'incoming' | 'in-call' | 'ended';
export type GroupParticipantStatus = 'invited' | 'joined' | 'connecting' | 'connected' | 'declined' | 'busy' | 'full' | 'no-answer' | 'left' | 'failed';
export interface GroupParticipant {
    pubkey: string;
    status: GroupParticipantStatus;
    /** 對方在送什麼（對方告訴我們的；還沒說之前當作語音） */
    media: CallMedia;
}
/** left：我離開；declined：我拒接；empty：其他人都不在了；cancelled：還沒接，邀請的人就走了；no-answer：響鈴逾時我沒接 */
export type GroupCallEndReason = 'left' | 'declined' | 'empty' | 'cancelled' | 'no-answer';
export interface GroupIncomingCall {
    groupId: string;
    from: string;
    members: string[];
    media: CallMedia;
}
type Listeners = {
    incoming: (call: GroupIncomingCall) => void;
    state: (state: GroupCallState) => void;
    participants: (list: GroupParticipant[]) => void;
    localStream: (stream: MediaStreamLike | null) => void;
    remoteStream: (peer: string, stream: MediaStreamLike | null) => void;
    peerFailed: (peer: string, reason: 'unreachable' | 'lost') => void;
    ended: (reason: GroupCallEndReason) => void;
    error: (message: string) => void;
};
export declare class GroupCallManager {
    #private;
    constructor(opts: GroupCallManagerOptions);
    onIncoming(l: Listeners['incoming']): () => void;
    onState(l: Listeners['state']): () => void;
    onParticipants(l: Listeners['participants']): () => void;
    onLocalStream(l: Listeners['localStream']): () => void;
    /** 每個人一個串流；內容變了送新物件，他離開或連線失敗時送 null */
    onRemoteStream(l: Listeners['remoteStream']): () => void;
    /** 只有這一對打不通（unreachable）或斷線（lost）；其他人不受影響 */
    onPeerFailed(l: Listeners['peerFailed']): () => void;
    onEnded(l: Listeners['ended']): () => void;
    onError(l: Listeners['error']): () => void;
    get state(): GroupCallState;
    get groupId(): string | null;
    get localMedia(): CallMedia;
    get maxParticipants(): number;
    participants(): GroupParticipant[];
    /** 開一通群組通話並邀請 `peers`（不含自己）。回傳 groupId。 */
    start(peers: string[], media: CallMedia): Promise<string>;
    accept(): Promise<void>;
    reject(): Promise<void>;
    leave(): Promise<void>;
    /** 通話中再邀一位（任何已加入的人都可以）；名單變動會告訴其他人 */
    invite(peer: string): Promise<void>;
    /** 改自己這一方送什麼：對每一條連線都生效；先把相機換好，成功了才通知大家 */
    setLocalMedia(media: CallMedia): Promise<void>;
    /** 靜音：麥克風軌 `enabled=false`，對所有人生效（裝置不關，解除時不用重新取用） */
    setMuted(muted: boolean): void;
    get muted(): boolean;
    /**
     * 換鏡頭，所有連線一起換。先試著直接開新的（桌面可以同時開兩顆，沒有空窗）；
     * 🔴 遇到「鏡頭忙碌」（多數手機同時只能開一顆）就先停舊的再開。新的開不了就重開原本那顆；
     * 連原本的都開不了就降成語音並通知大家，不送一條死掉的軌（Cinderous ADR-0424）。
     */
    setCamera(selection: CameraSelection): Promise<void>;
    setVideoQuality(quality: VideoQuality): void;
    close(): void;
    /** 邀請我的人（還沒接聽時有意義） */
    get inviter(): string | null;
}
export {};
//# sourceMappingURL=group-call.d.ts.map