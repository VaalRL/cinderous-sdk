import { type SecureChannel, type SecureChannelOptions } from '../crypto/secure-channel.js';
import type { Identity } from '../identity.js';
import type { PeerNode } from '../peer/peer-node.js';
import { type StarMessage, type StarSendOptions } from './host.js';
import { type StarInvitePayload } from './invite.js';
import { type LinkStats, type StarChannel, type StarTransportOptions } from './link.js';
import { type RosterEntry, type StarEndReason, type StarRejectReason } from './wire.js';
/** 加入失敗的原因：Host 拒絕的理由，或連線層的失敗 */
export type StarJoinFailure = StarRejectReason | 'timeout' | 'closed' | 'wrong-host' | 'protocol' | 'kicked' | 'host-closed';
export declare class StarJoinError extends Error {
    readonly reason: StarJoinFailure;
    readonly name = "StarJoinError";
    constructor(reason: StarJoinFailure, message?: string);
}
export type StarMemberErrorCode = 'closed' | 'too-large' | 'backpressure' | 'bad-argument';
export declare class StarMemberError extends Error {
    readonly code: StarMemberErrorCode;
    readonly name = "StarMemberError";
    constructor(code: StarMemberErrorCode, message: string);
}
/** Host 斷線的原因（成員這端觀察到的） */
export type StarHostLostReason = 'timeout' | 'closed' | 'desync' | 'protocol';
export type StarMemberEvent = {
    type: 'joined';
    pubkey: string;
    label?: string;
    seq: number;
} | {
    type: 'left';
    pubkey: string;
    reason: StarEndReason | undefined;
    seq: number;
}
/** Host 明確結束了你的參與（踢出、Host 關閉會話、你太慢被請離開、被同一身分的新連線取代……） */
 | {
    type: 'ended';
    reason: StarEndReason;
}
/** 跟 Host 斷了（通道關閉、太久沒消息、失步）。SDK 不會自動換 Host；要繼續就拿新邀請重新加入 */
 | {
    type: 'host-lost';
    reason: StarHostLostReason;
};
export interface StarMemberOptions extends StarTransportOptions {
    /** 邀請字串或解析後的內容 */
    invite: string | StarInvitePayload;
    /** 給其他人看的名稱（未經認證，Host 照轉） */
    label?: string;
    /** 等 Host 回覆加入請求多久（預設 15 秒；Host 要人工核准時請拉長） */
    joinTimeoutMs?: number;
}
export interface StarJoinOptions extends StarMemberOptions {
    identity: Identity;
    node: Pick<PeerNode, 'connectPeer'>;
    secure?: SecureChannelOptions;
}
export declare class StarMember {
    #private;
    readonly hostPubkey: string;
    /** 經 `PeerNode` 連到邀請裡的 Host、做雙棘輪握手、送出加入請求。 */
    static join(opts: StarJoinOptions): Promise<StarMember>;
    /** 在一條已完成握手、對方是 Host 的成對通道上加入。 */
    static over(channel: SecureChannel | StarChannel, opts: StarMemberOptions): Promise<StarMember>;
    private constructor();
    /** 我的公鑰（Host 認得的身分） */
    get me(): string;
    get sessionId(): string;
    get maxPayloadBytes(): number;
    get closed(): boolean;
    /** 結束的原因（還在會話裡時是 undefined） */
    get endedBy(): StarMemberEvent | undefined;
    /** 最後處理到的 Host 序號 */
    get lastSeq(): number;
    get stats(): Readonly<LinkStats>;
    /** 目前的其他參與者（含 Host，不含自己） */
    members(): RosterEntry[];
    /**
     * 送出（經 Host 轉送）。佇列滿了丟 `StarMemberError('backpressure')`（`volatile` 的則默默丟掉）。
     * `echo`：也送回給自己，拿到這則的 Host 序號（例如聊天要照全體順序顯示）。
     */
    send(payload: Uint8Array, opts?: StarSendOptions & {
        echo?: boolean;
    }): void;
    /** 佇列裡還沒送出的位元組（App 可以據此自己節流） */
    get bufferedAmount(): number;
    /** 收到的訊息（依 Host 序號遞增）；註冊前到的會在註冊當下交出 */
    onMessage(listener: (message: StarMessage) => void): () => void;
    /** 成員名單變動與結束事件；註冊前發生的會在註冊當下交出 */
    onEvent(listener: (event: StarMemberEvent) => void): () => void;
    /** 與 Host 之間的成對通道（大檔可用 `StreamTransfer.for(channel)`；那是與 Host 的直送，不經轉送） */
    get channel(): SecureChannel;
    /** 離開會話：告訴 Host、送完就關。 */
    leave(): Promise<void>;
}
//# sourceMappingURL=member.d.ts.map