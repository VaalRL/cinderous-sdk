/** 帳號每日的 DO 請求免費額度（Cloudflare 免費方案） */
export declare const IOT_ACCOUNT_DAILY_REQUESTS = 100000;
export type IotQuotaState = 'ok' | 'warn' | 'shed' | 'exhausted';
export interface IotQuotaSnapshot {
    /** 這一天的 UTC 00:00（unix 秒） */
    readonly day: number;
    readonly used: number;
}
/** 下一個 UTC 00:00（unix 秒） */
export declare function nextUtcMidnightSec(nowMs: number): number;
/** 每家預設預算：帳號每日額度 ÷ 家庭數 × 0.5（留一半給 relay 其他流量）；`IOT_HOME_DAILY_REQUESTS` 是正整數就用它 */
export declare function iotDefaultHomeDailyRequests(homes: number, override?: string): number;
export declare class IotHomeQuota {
    #private;
    readonly limit: number;
    constructor(limit: number, now?: () => number, saved?: IotQuotaSnapshot);
    /** 計一次；`crossed`＝這一次剛好跨過哪個門檻（只回報一次），`persist`＝該寫回了 */
    add(n?: number): {
        state: IotQuotaState;
        crossed?: Exclude<IotQuotaState, 'ok'>;
        persist: boolean;
    };
    state(): IotQuotaState;
    /** 額度重置時間（下一個 UTC 00:00，unix 秒） */
    resetAt(): number;
    snapshot(): IotQuotaSnapshot;
}
//# sourceMappingURL=iot-quota.d.ts.map