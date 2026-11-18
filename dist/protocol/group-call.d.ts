import type { CallMedia } from './call.js';
/** 預設上限（含自己）。理由見 SDK ADR 0141 的頻寬估算：4 人視訊時每人上傳 3 份 */
export declare const GROUP_CALL_DEFAULT_MAX = 4;
/** 硬上限（含自己）：網狀拓撲每人上傳 N−1 份，6 人以上連標準畫質也要 3 Mbps 上傳，行動網路撐不住 */
export declare const GROUP_CALL_HARD_MAX = 6;
/** 群組信令版本 */
export declare const GROUP_CALL_VERSION = 1;
export type GroupDeclineReason = 'declined' | 'busy' | 'full';
interface Base {
    v: 1;
    groupId: string;
}
export interface GroupInvite extends Base {
    type: 'group-invite';
    media: CallMedia;
    /** 含邀請者自己 */
    members: string[];
}
/** 我加入了（廣播給所有成員）；`ack` 是回覆別人的加入，收到 ack 不再回 ack */
export interface GroupJoin extends Base {
    type: 'group-join';
    members: string[];
    ack?: true;
}
export interface GroupDecline extends Base {
    type: 'group-decline';
    reason: GroupDeclineReason;
}
export interface GroupLeave extends Base {
    type: 'group-leave';
}
/** 有人邀了新成員：告訴其他已加入的人名單變了 */
export interface GroupMembers extends Base {
    type: 'group-members';
    members: string[];
}
export interface GroupOffer extends Base {
    type: 'group-offer';
    sdp: string;
    media: CallMedia;
}
export interface GroupAnswer extends Base {
    type: 'group-answer';
    sdp: string;
    media: CallMedia;
}
export interface GroupCandidate extends Base {
    type: 'group-candidate';
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
}
export interface GroupMediaChange extends Base {
    type: 'group-media';
    media: CallMedia;
}
export type GroupCallSignal = GroupInvite | GroupJoin | GroupDecline | GroupLeave | GroupMembers | GroupOffer | GroupAnswer | GroupCandidate | GroupMediaChange;
/** 這一對裡由誰發 offer：字典序較小的 pubkey */
export declare function groupCallOfferer(a: string, b: string): string;
/** 解析並驗證群組通話信令（信任邊界）。不是群組信令、版本不對或欄位非法一律丟例外。 */
export declare function parseGroupCallSignal(content: string): GroupCallSignal;
export {};
//# sourceMappingURL=group-call.d.ts.map