export declare const STAR_INVITE_PREFIX = "cinderous-star:";
export declare const STAR_INVITE_VERSION = 1;
/** 預設有效期：10 分鐘 */
export declare const DEFAULT_STAR_INVITE_TTL_MS: number;
/** 有效期上限：24 小時（長期有效的邀請等於一把長期門鑰匙） */
export declare const MAX_STAR_INVITE_TTL_MS: number;
/** 一個 Host 同時最多幾張有效邀請 */
export declare const MAX_STAR_INVITES = 256;
export declare const STAR_INVITE_MAX_RELAYS = 3;
export declare class StarInviteError extends Error {
    readonly name = "StarInviteError";
}
/** 邀請字串承載的內容 */
export interface StarInvitePayload {
    /** Host 的身分公鑰（hex）：加入者連的就是它，通道認證的對方必須是它 */
    host: string;
    secret: Uint8Array;
    /** 到期時間（unix 秒，Host 的時鐘） */
    expiresAt: number;
    relays: string[];
}
export declare function encodeStarInvite(invite: StarInvitePayload): string;
/** 解析邀請字串；格式不對丟 `StarInviteError`。不檢查到期（見 {@link isStarInviteExpired}）。 */
export declare function parseStarInvite(uri: string): StarInvitePayload;
export declare function isStarInviteExpired(invite: Pick<StarInvitePayload, 'expiresAt'>, nowMs?: number): boolean;
export interface CreateStarInviteOptions {
    /** 放進邀請字串的中繼（加入者用它們找 Host），最多 3 座 */
    relays: string[];
    /** 有效期（預設 10 分鐘，上限 24 小時） */
    ttlMs?: number;
    /** 可用幾次（預設 1＝一次性；上限 = 成員上限） */
    maxUses?: number;
    /** 只給這把公鑰用（例如經私訊送給特定的人）；其他人拿到字串也進不來 */
    forPubkey?: string;
}
export interface StarInvite {
    /** 撤銷用的 id（不是秘密） */
    readonly id: string;
    readonly uri: string;
    readonly expiresAt: number;
    readonly maxUses: number;
    readonly forPubkey?: string;
}
/** 邀請簿裡看得到的資訊：**不含邀請字串**（字串裡有秘密；只在 `createInvite` 回傳一次，安全審查 M3） */
export interface StarInviteInfo {
    readonly id: string;
    readonly expiresAt: number;
    readonly maxUses: number;
    readonly forPubkey?: string;
    readonly uses: number;
    readonly revoked: boolean;
}
export type RedeemResult = {
    ok: true;
    inviteId: string;
} | {
    ok: false;
    reason: 'invalid-invite' | 'expired' | 'revoked' | 'used';
};
export declare class InviteBook {
    #private;
    private readonly host;
    private readonly now;
    constructor(host: string, now: () => number);
    create(opts: CreateStarInviteOptions, maxUsesCap: number): StarInvite;
    revoke(id: string): boolean;
    revokeAll(): void;
    list(): StarInviteInfo[];
    /** 只驗證、不扣次數 */
    check(secret: Uint8Array, pubkey: string): RedeemResult;
    /** 驗證並**用掉一次**。先扣次數再做其他（非同步的）核准，兩個人同時拿一次性邀請也只有一個進得來。 */
    redeem(secret: Uint8Array, pubkey: string): RedeemResult;
}
//# sourceMappingURL=invite.d.ts.map