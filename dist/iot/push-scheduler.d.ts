import { type IotPushLimits, type IotPushMode, type IotPushSendResult } from './push.js';
/** 計時器（預設 `setTimeout`／`clearTimeout`；測試注入假的） */
export interface IotPushTimers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}
export declare const realIotPushTimers: IotPushTimers;
export interface IotPushSchedulerOptions {
    /** 真的送出一次喚醒（`id`＝端點 id）。`ref`＝最後一個事件的不透明 id（只有 iOS 經推播閘道時會用到） */
    send(id: string, wake: {
        readonly ref?: string;
    }): Promise<IotPushSendResult>;
    limits?: Partial<Pick<IotPushLimits, 'standardPerMinute' | 'instantPerMinute'>>;
    now?: () => number;
    /** [0, 1) 的亂數；預設 `Math.random`（抖動不是安全用途） */
    random?: () => number;
    timers?: IotPushTimers;
    standardJitterMs?: number;
    instantJitterMs?: number;
    /** 一次喚醒最多送幾次（含重試），預設 3 */
    maxAttempts?: number;
    onGone?(id: string): void;
    onError?(id: string, reason: string): void;
}
export declare class IotPushScheduler {
    #private;
    constructor(opts: IotPushSchedulerOptions);
    /** 某個端點訂閱的東西有更新了：依模式排一次喚醒（或併進已經排好的那一次） */
    notify(id: string, mode: IotPushMode, ref?: string): void;
    /** 取消某個端點等待中的喚醒並忘掉它（端點被撤銷、過期） */
    cancel(id: string): void;
    /** 等待中的喚醒（測試與除錯用） */
    pending(id: string): {
        at: number;
    } | undefined;
    /** 停止：清掉所有計時器，之後的 notify 一律忽略 */
    stop(): void;
}
//# sourceMappingURL=push-scheduler.d.ts.map