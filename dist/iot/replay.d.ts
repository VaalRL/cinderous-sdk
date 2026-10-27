export declare const IOT_DEFAULT_MAX_SKEW_SEC = 30;
export declare const IOT_MIN_MAX_SKEW_SEC = 5;
export declare const IOT_MAX_MAX_SKEW_SEC = 120;
/** 允許比現在晚多少（毫秒）：設備與手機的時鐘誤差 */
export declare const IOT_FUTURE_SKEW_MS = 5000;
export declare const IOT_DEFAULT_DEDUPE_SIZE = 1024;
export declare function clampIot(value: number | undefined, fallback: number, min: number, max: number): number;
export type IotReplayVerdict<T> = {
    readonly verdict: 'fresh';
} | {
    readonly verdict: 'duplicate';
    readonly result: T | undefined;
} | {
    readonly verdict: 'too-old';
} | {
    readonly verdict: 'too-new';
} | {
    readonly verdict: 'busy';
};
export interface IotReplayGuardOptions {
    maxSkewSec?: number;
    size?: number;
    now?: () => number;
}
export declare class IotReplayGuard<T = unknown> {
    #private;
    readonly maxSkewMs: number;
    constructor(opts?: IotReplayGuardOptions);
    /** 檢查一則訊息；`fresh` 時已經記下（之後以 {@link settle} 補上結果） */
    check(key: string, tsMs: number): IotReplayVerdict<T>;
    /** 記下處理結果（去重命中時回傳） */
    settle(key: string, result: T): void;
    get size(): number;
}
//# sourceMappingURL=replay.d.ts.map