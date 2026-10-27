import { type PubkeyHex } from '../protocol/keys.js';
export type IotRole = 'viewer' | 'operator' | 'owner';
export declare const IOT_ROLES: readonly IotRole[];
/** 角色名單最多幾筆（防濫用；一個家庭用不到這麼多） */
export declare const IOT_ACL_MAX_ENTRIES = 256;
export interface IotAclEntry {
    /** 64 位 hex 公鑰（輸入時也收 npub） */
    readonly pubkey: PubkeyHex;
    readonly role: IotRole;
    /** 只能碰這些設備（完全相同或 `*` 結尾的前綴）；省略＝全部 */
    readonly devices?: readonly string[];
    /** 只能操作這些 topic（MQTT 樣式）；省略＝全部。查詢不看這一欄（查詢以設備為單位） */
    readonly topics?: readonly string[];
    /** 到期時間（Unix 秒）；過了自動失效 */
    readonly expiresAt?: number;
    readonly label?: string;
}
export interface IotTopicRule {
    /** MQTT 樣式 */
    readonly topic: string;
    /** 操作這些 topic 至少要這個角色（例如門鎖 `owner`） */
    readonly minRole?: IotRole;
    /** 操作前要求呼叫端明確確認（`command(…, { confirmed: true })`） */
    readonly confirm?: boolean;
}
export interface IotAcl {
    readonly entries: readonly IotAclEntry[];
    readonly rules?: readonly IotTopicRule[];
}
export type IotAclOp = {
    readonly op: 'add';
    readonly entry: IotAclEntryInput;
} | {
    readonly op: 'remove';
    readonly pubkey: string;
};
/** 輸入形狀：`pubkey` 或 `npub` 擇一 */
export type IotAclEntryInput = Omit<IotAclEntry, 'pubkey'> & {
    readonly pubkey?: string;
    readonly npub?: string;
};
/** 設定檔與選項收的名單：陣列（只有 entries）或 `{ entries, rules }`，公鑰可寫 npub */
export type IotAclInput = IotAcl | readonly IotAclEntryInput[] | {
    readonly entries: readonly IotAclEntryInput[];
    readonly rules?: readonly IotTopicRule[];
};
/** npub 或 64 位 hex → hex；不合法丟例外 */
export declare function iotPubkeyOf(value: string): PubkeyHex;
/** 驗證並正規化一筆（npub → hex）；不合法丟例外 */
export declare function normalizeIotAclEntry(raw: unknown): IotAclEntry;
/**
 * 驗證整份名單：每筆合法、公鑰不重複、筆數有上限。接受陣列（只有 entries）或 `{ entries, rules }`。
 * 不合法丟例外（設定檔寫錯就不啟動，不默默略過某一筆）。
 */
export declare function parseIotAcl(raw: unknown): IotAcl;
/** 某把公鑰目前的角色（過期＝沒有） */
export declare function iotRoleOf(acl: IotAcl, pubkey: PubkeyHex, nowSec: number): IotRole | undefined;
export declare const iotRoleAtLeast: (have: IotRole, need: IotRole) => boolean;
export interface IotAuthorizeRequest {
    readonly pubkey: PubkeyHex;
    readonly action: 'operate' | 'query';
    readonly device?: string;
    readonly topic?: string;
    readonly confirmed?: boolean;
}
export type IotAuthorization = {
    readonly ok: true;
    readonly role: IotRole;
} | {
    readonly ok: false;
    readonly status: 'not-allowed' | 'rejected';
    readonly reason: string;
};
/** 授權一次操作或查詢（ADR 0049 §2.5）。不在名單、過期、角色不足、樣式不符→`not-allowed`；缺確認→`rejected` */
export declare function authorizeIot(acl: IotAcl, req: IotAuthorizeRequest, nowSec: number): IotAuthorization;
/** 驗證 `$sys/acl` 的操作內容（JSON 字串） */
export declare function parseIotAclOp(payload: string): IotAclOp;
/**
 * 套用一次名單操作，回傳新名單（不改原本的）。`add` 以公鑰為鍵取代同一人的那一筆。
 * 🔴 不允許讓名單裡沒有任何有效的 owner（移除或降級最後一位 owner）——否則再也沒有人能改名單。
 */
export declare function applyIotAclOp(acl: IotAcl, op: IotAclOp, nowSec: number): IotAcl;
/** 角色名單的持久化（只在閘道本地；例如 `./iot/bridge` 的 `fileIotAclStore`） */
export interface IotAclStore {
    load(): IotAcl | undefined | Promise<IotAcl | undefined>;
    save(acl: IotAcl): void | Promise<void>;
}
/** 記憶體版（測試、或不需要跨重開保存時） */
export declare function memoryIotAclStore(initial?: IotAcl): IotAclStore & {
    current(): IotAcl | undefined;
};
//# sourceMappingURL=acl.d.ts.map