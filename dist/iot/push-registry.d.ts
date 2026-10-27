import type { PubkeyHex } from '../protocol/keys.js';
import { type IotPushEndpoint, type IotPushLimits, type IotPushMode, type IotPushRegistration, type IotPushSpecial, type IotPushSubscription } from './push.js';
/** 登記的持久化（只在送出端本地） */
export interface IotPushStore {
    load(): readonly IotPushRegistration[] | undefined | Promise<readonly IotPushRegistration[] | undefined>;
    save(list: readonly IotPushRegistration[]): void | Promise<void>;
}
/** 記憶體版（測試，或不需要跨重開保存時） */
export declare function memoryIotPushStore(initial?: readonly IotPushRegistration[]): IotPushStore & {
    current(): readonly IotPushRegistration[] | undefined;
};
/** 驗證存檔（讀回時用；不合法丟例外——存檔壞了就不啟動，不默默丟掉別人的登記） */
export declare function parseIotPushRegistrations(raw: unknown, opts?: {
    allowPrivateHttp?: boolean;
}): IotPushRegistration[];
export type IotPushRegisterOutcome = {
    readonly ok: true;
    readonly id: string;
    readonly created: boolean;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** 某則事件該喚醒誰：每個端點一次，同一端點有多個符合的訂閱時取最急的模式 */
export interface IotPushTarget {
    readonly id: string;
    readonly mode: IotPushMode;
}
export declare class IotPushRegistry {
    #private;
    constructor(opts?: {
        limits?: Partial<IotPushLimits>;
    });
    get limits(): IotPushLimits;
    /** 換成存檔裡的清單 */
    load(list: readonly IotPushRegistration[]): void;
    /** 目前的清單（含已過期但還沒清掉的；要乾淨的先 `prune`） */
    list(): IotPushRegistration[];
    get(id: string): IotPushRegistration | undefined;
    /** 清掉過期的；回傳被清掉的 id */
    prune(nowSec: number): string[];
    /**
     * 登記或更新（以端點 id 為鍵）。`isOwner`＝登記者目前是 owner（額度預警只有 owner 能訂閱）。
     * 別人登記過的同一個端點不能蓋掉（回 `not-yours`）。
     */
    register(input: {
        owner: PubkeyHex;
        endpoint: IotPushEndpoint;
        subscriptions: readonly IotPushSubscription[];
        ttlSec?: number;
        isOwner: boolean;
    }, nowSec: number): IotPushRegisterOutcome;
    /** 移除一筆：登記者本人或 owner；回傳原因（成功回 undefined） */
    remove(id: string, by: PubkeyHex, byOwner: boolean): string | undefined;
    /** 撤銷成員：清掉他的所有端點；回傳被清掉的 id */
    removeByOwner(owner: PubkeyHex): string[];
    /**
     * 某台設備（盲化 id）或特殊項目有更新：該喚醒的端點。`allowed(owner, special)` 由呼叫端依目前的角色名單判斷
     *（成員已被移除或過期 → 不送；特殊項目只給目前仍是 owner 的人）。
     */
    targets(match: {
        dv: string;
    } | {
        special: IotPushSpecial;
    }, nowSec: number, allowed: (owner: PubkeyHex, special: boolean) => boolean): IotPushTarget[];
}
//# sourceMappingURL=push-registry.d.ts.map