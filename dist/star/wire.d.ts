export declare const STAR_MAGIC = 197;
export declare const STAR_WIRE_VERSION = 1;
export declare const PACKET_HEADER_BYTES = 11;
export declare const RECORD_HEADER_BYTES = 5;
/** 一個封包最多幾筆紀錄 */
export declare const MAX_RECORDS_PER_PACKET = 4096;
/** 成員自己報的顯示名稱（未經認證，只是標籤）上限 */
export declare const STAR_LABEL_MAX_BYTES = 64;
/** 邀請秘密長度（128 位元） */
export declare const STAR_INVITE_SECRET_BYTES = 16;
/** 單播一次最多指定幾位收件人 */
export declare const STAR_MAX_RECIPIENTS = 64;
export declare const RecordType: {
    readonly Join: 1;
    readonly Welcome: 2;
    readonly Reject: 3;
    readonly Leave: 4;
    readonly End: 5;
    readonly Send: 6;
    readonly Deliver: 7;
    readonly Roster: 8;
};
export type RecordType = (typeof RecordType)[keyof typeof RecordType];
/** 會話結束或成員離開的原因 */
export type StarEndReason = 'left' | 'kicked' | 'overflow' | 'timeout' | 'replaced' | 'desync' | 'protocol' | 'closed' | 'host-closed' | 'rate-limit';
export declare function reasonCode(reason: StarEndReason): number;
export declare function reasonFromCode(code: number): StarEndReason | undefined;
export interface Packet {
    sequenced: boolean;
    lseq: number;
    ack: number;
    records: WireRecord[];
}
export interface WireRecord {
    type: number;
    body: Uint8Array;
}
export declare function isStarPacket(data: Uint8Array): boolean;
export declare function encodePacket(sequenced: boolean, lseq: number, ack: number, records: readonly WireRecord[]): Uint8Array;
/** 解封包；格式不對回 null（對方送什麼都不該讓我們拋例外） */
export declare function decodePacket(data: Uint8Array): Packet | null;
/** 顯示名稱：去掉控制字元、截到上限（以位元組計，不切斷字元） */
export declare function sanitizeStarLabel(label: string | undefined): string | undefined;
export declare function encodeJoin(secret: Uint8Array, label: string | undefined): WireRecord;
export declare function decodeJoin(body: Uint8Array): {
    secret: Uint8Array;
    label: string | undefined;
} | null;
export interface RosterEntry {
    pubkey: string;
    label?: string;
}
export interface Welcome {
    session: string;
    host: string;
    you: string;
    /** 你會收到的第一個 Host 序號（之後的都比它大或相等） */
    next: number;
    members: RosterEntry[];
    maxPayloadBytes: number;
}
export declare function encodeJson(type: RecordType, value: unknown): WireRecord;
export declare function decodeWelcome(body: Uint8Array): Welcome | null;
/** 加入被拒的原因 */
export type StarRejectReason = 'invalid-invite' | 'expired' | 'revoked' | 'used' | 'full' | 'banned' | 'denied' | 'closed';
export declare function decodeReason<T extends string>(body: Uint8Array, allowed: readonly T[]): T | null;
export declare const decodeReject: (body: Uint8Array) => StarRejectReason | null;
export declare const decodeEnd: (body: Uint8Array) => StarEndReason | null;
export interface SendBody {
    volatile: boolean;
    echo: boolean;
    topic: number;
    to: string[] | undefined;
    payload: Uint8Array;
}
export declare function encodeSend(s: SendBody): WireRecord;
export declare function decodeSend(body: Uint8Array): SendBody | null;
export interface DeliverBody {
    seq: number;
    from: string;
    unicast: boolean;
    volatile: boolean;
    topic: number;
    payload: Uint8Array;
}
/** 轉送紀錄：`from` 由 Host 依**通道認證過的身分**填入 */
export declare function encodeDeliver(d: DeliverBody): WireRecord;
export declare function decodeDeliver(body: Uint8Array): DeliverBody | null;
export interface RosterBody {
    seq: number;
    event: 'joined' | 'left';
    pubkey: string;
    reason: StarEndReason | undefined;
    label: string | undefined;
}
export declare function encodeRoster(r: RosterBody): WireRecord;
export declare function decodeRoster(body: Uint8Array): RosterBody | null;
//# sourceMappingURL=wire.d.ts.map