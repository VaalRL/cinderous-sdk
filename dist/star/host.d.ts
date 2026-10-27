import { type SecureChannel, type SecureChannelOptions } from '../crypto/secure-channel.js';
import type { Identity } from '../identity.js';
import type { PeerChannel, PeerNode } from '../peer/peer-node.js';
import { type CreateStarInviteOptions, type StarInvite, type StarInviteInfo } from './invite.js';
import { type LinkStats, type StarChannel, type StarTransportOptions } from './link.js';
import { type StarEndReason, type StarRejectReason } from './wire.js';
export declare const DEFAULT_STAR_MAX_MEMBERS = 16;
/** 成員上限的天花板：Host 對每位成員各加密一次，人越多 Host 的 CPU 與上行越吃緊 */
export declare const STAR_MAX_MEMBERS_LIMIT = 64;
export declare const DEFAULT_STAR_MAX_PAYLOAD_BYTES: number;
export declare const STAR_MAX_PAYLOAD_LIMIT: number;
export declare const DEFAULT_STAR_JOIN_TIMEOUT_MS = 10000;
export declare const DEFAULT_STAR_APPROVE_TIMEOUT_MS = 120000;
/** 一則經 Host 排序的訊息 */
export interface StarMessage {
    /** Host 序號：全體一致的順序（同一個 Host 會話內嚴格遞增，可能跳號） */
    readonly seq: number;
    /**
     * 寄件人公鑰：**Host 宣稱的**寄件人。誠實的 Host 依通道認證過的身分填入，成員之間無法冒充彼此；
     * 但 Host 本身可以填任何值——這只在 Host 可信時成立，不是端到端的簽章。
     */
    readonly from: string;
    readonly topic: number;
    readonly payload: Uint8Array;
    /** true＝只給特定成員的單播 */
    readonly unicast: boolean;
    /** 寄件人標記為可丟棄（游標之類）：背壓時會先被丟 */
    readonly volatile: boolean;
}
export interface StarSendOptions {
    /** 只給這些成員（單播）；不給＝廣播給其他所有人 */
    to?: string[];
    /** 0–255，App 自己分類（例如 0＝Yjs 更新、1＝游標、2＝聊天） */
    topic?: number;
    /** 可丟棄：慢成員的佇列滿了時先丟這種 */
    volatile?: boolean;
}
export interface StarJoinRequest {
    pubkey: string;
    /** 成員自己報的名稱（未經認證） */
    label?: string;
    inviteId: string;
    mode: PeerChannel['mode'];
}
export type StarHostEvent = {
    type: 'joined';
    pubkey: string;
    label?: string;
    seq: number;
    inviteId: string;
} | {
    type: 'left';
    pubkey: string;
    reason: StarEndReason;
    seq: number;
} | {
    type: 'rejected';
    pubkey: string;
    reason: StarRejectReason;
};
export interface StarMemberInfo {
    pubkey: string;
    label?: string;
    mode: PeerChannel['mode'];
    joinedAt: number;
    stats: Readonly<LinkStats>;
}
export interface StarRateLimit {
    messagesPerSecond: number;
    burstMessages: number;
    bytesPerSecond: number;
    burstBytes: number;
}
export declare const DEFAULT_STAR_INBOUND_RATE: StarRateLimit;
export interface StarHostOptions extends StarTransportOptions {
    /** Host 的身分（`listen` 用它做雙棘輪握手；它的公鑰就是邀請裡的 Host） */
    identity: Pick<Identity, 'pubkey'> & Partial<Pick<Identity, 'conversationKey'>>;
    /** 成員上限（不含 Host），預設 16，最多 64 */
    maxMembers?: number;
    /** 單則酬載上限，預設 1 MiB；大檔改用 `StreamTransfer`（見 `channelOf`） */
    maxPayloadBytes?: number;
    /** 連上之後多久內要送出加入請求 */
    joinTimeoutMs?: number;
    /** 同時等待加入（含握手中）的連線上限，預設 32 */
    maxPendingJoins?: number;
    /** 邀請驗過之後，再問 App 要不要放行（例如跳出「某某要加入」）。回 false＝拒絕；邀請次數已扣 */
    approveJoin?: (request: StarJoinRequest) => boolean | Promise<boolean>;
    /** 等 `approveJoin` 最久多久（預設 2 分鐘），逾時當成拒絕 */
    approveTimeoutMs?: number;
    /** 每位成員送進來的速率上限；超過就請它離開（`rate-limit`），免得一個人灌爆所有人的佇列 */
    inboundRate?: Partial<StarRateLimit>;
}
export declare class StarHostError extends Error {
    readonly name = "StarHostError";
}
export declare class StarHost {
    #private;
    /** 這個 Host 會話的 id（隨機；成員從 WELCOME 拿到） */
    readonly sessionId: string;
    readonly hostPubkey: string;
    constructor(opts: StarHostOptions);
    get closed(): boolean;
    get maxPayloadBytes(): number;
    /** 產生邀請字串（`cinderous-star:1.…`），交給對方（QR、私訊、複製連結）。預設 10 分鐘、一次性。 */
    createInvite(opts: CreateStarInviteOptions): StarInvite;
    /** 撤銷還沒用掉的邀請；已經加入的人不受影響（要請他離開用 `kick`） */
    revokeInvite(id: string): boolean;
    invites(): StarInviteInfo[];
    /**
     * 接上 `PeerNode`：有人連進來就做雙棘輪握手，再等它送加入請求。
     * `accept` 回 false 的連線不碰（留給 App 的其他用途）；同一條 PeerChannel 只能有一方做 `secureChannel`。
     */
    listen(node: Pick<PeerNode, 'onPeer'>, opts?: {
        secure?: SecureChannelOptions;
        accept?: (pubkey: string) => boolean;
    }): () => void;
    /**
     * 交給 Host 一條已完成握手的成對通道（`secureChannel` 的結果）。對方要在時限內送出加入請求（帶邀請秘密），
     * 否則關掉。對方的身分就是通道認證過的公鑰。
     */
    attach(channel: SecureChannel | StarChannel): void;
    /** Host 自己送（廣播或單播）。回傳 Host 序號；沒有任何收件人回 undefined。 */
    send(payload: Uint8Array, opts?: StarSendOptions): number | undefined;
    /** 收到給 Host 的訊息（廣播，或單播給 Host 的），依 Host 序號的順序 */
    onMessage(listener: (message: StarMessage) => void): () => void;
    onEvent(listener: (event: StarHostEvent) => void): () => void;
    members(): StarMemberInfo[];
    has(pubkey: string): boolean;
    /**
     * 請一位成員離開：關掉它的通道，之後它送的一律不轉、也收不到任何東西。
     * 成對通道之下，其他人的通道不受影響、不必重新協商。`ban`（預設 true）：這個會話內不能再用別的邀請回來。
     */
    kick(pubkey: string, opts?: {
        ban?: boolean;
        revokeInvite?: boolean;
    }): boolean;
    unban(pubkey: string): boolean;
    /**
     * 這位成員的底層成對通道（雙棘輪）。大檔（蟲洞投影的附件）用 `StreamTransfer.for(channel)` 走同一條通道：
     * 串流的封包標記（0xCB）與星狀會話（0xC5）不同，互不干擾。注意這條路**不經 Host 轉送**，是 Host 與這位成員之間的直送。
     */
    channelOf(pubkey: string): SecureChannel | undefined;
    /** 結束會話：每位成員收到 `host-closed`，所有邀請作廢。 */
    close(): void;
}
//# sourceMappingURL=host.d.ts.map