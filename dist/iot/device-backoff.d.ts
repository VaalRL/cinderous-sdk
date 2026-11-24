/** 斷線的分類（ADR 0049 §10.2） */
export type IotDeviceDisconnectClass = 'quota-exhausted' | 'config-error' | 'relay-error' | 'network-down' | 'replaced';
/** 設備看到的現象 */
export type IotDeviceObservation = 
/** 升級（或 HTTP 輪詢）被拒：狀態碼、標頭（名稱不分大小寫）、本文 */
{
    readonly kind: 'http';
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
}
/** WebSocket 被關（含已連上後被關） */
 | {
    readonly kind: 'close';
    readonly code: number;
    readonly reason?: string;
}
/** DNS、TCP、TLS 失敗；連不上預設閘道 */
 | {
    readonly kind: 'network';
}
/** 心跳逾時（連線已死、可能沒有 close frame） */
 | {
    readonly kind: 'heartbeat-timeout';
};
export interface IotDeviceDisconnect {
    readonly class: IotDeviceDisconnectClass;
    /** 額度重置時間（unix 秒） */
    readonly reset?: number;
    /** relay 的 `Retry-After`（秒） */
    readonly retryAfterSec?: number;
}
export interface IotDeviceRetryContext {
    /** 同一類連續失敗了幾次（第一次＝0） */
    readonly attempt: number;
    /** unix 秒 */
    readonly nowSec: number;
    /** 時鐘已同步（SNTP）；沒同步時不信 reset，改成每 60 分鐘探測 */
    readonly clockSynced: boolean;
    /** [0, 1) 的亂數（測試向量固定它） */
    readonly random: number;
}
/** 額度重置後分散重連的最大隨機延遲：20 分鐘 */
export declare const IOT_DEVICE_QUOTA_JITTER_MS: number;
/** 不知道何時重置、或設定錯誤時的探測間隔：60 分鐘 */
export declare const IOT_DEVICE_PROBE_INTERVAL_MS: number;
/** 被擠掉（4409）之後多久再試 */
export declare const IOT_DEVICE_REPLACED_RETRY_MS = 60000;
/** 任何狀態下兩次連線嘗試的最小間隔 */
export declare const IOT_DEVICE_MIN_RETRY_MS = 1000;
/** 任何狀態下最多等多久：額度每天重置，24 小時＋抖動綽綽有餘（也遠低於 setTimeout 的 2^31−1 毫秒） */
export declare const IOT_DEVICE_MAX_RETRY_MS: number;
/** 分類一次斷線或被拒（`nowSec`：unix 秒，只用來推算 reset） */
export declare function classifyIotDeviceDisconnect(obs: IotDeviceObservation, nowSec: number): IotDeviceDisconnect;
/** 下一次連線前等多久（毫秒） */
export declare function iotDeviceRetryDelayMs(d: IotDeviceDisconnect, ctx: IotDeviceRetryContext): number;
//# sourceMappingURL=device-backoff.d.ts.map