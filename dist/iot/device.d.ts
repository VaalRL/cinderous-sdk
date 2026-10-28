import { type IotDeviceAckStatus } from './device-message.js';
import type { IotEncoding } from './content.js';
export { parseIotDownMessage, parseIotUpMessage, IOT_DEVICE_ACK_STATUSES } from './device-message.js';
export type { IotDeviceAckStatus, IotDownCommand, IotDownMessage, IotDownQuery, IotUpAck, IotUpMessage, IotUpState } from './device-message.js';
export { generateIotDeviceToken, hashIotDeviceToken, IOT_DEVICE_HEARTBEAT, IOT_DEVICE_HEARTBEAT_ACK } from './device-frame.js';
export { deriveIotDeviceKeyDown, iotKid } from './envelope.js';
export declare const IOT_DEVICE_DEFAULT_HEARTBEAT_SEC = 30;
export declare const IOT_DEVICE_DEFAULT_HEARTBEAT_TIMEOUT_SEC = 10;
/** 設備端的時間窗（秒）：一般設備 ±60；門類建議設 15（§9.4） */
export declare const IOT_DEVICE_DEFAULT_MAX_SKEW_SEC = 60;
/** 最小的 WebSocket 介面（瀏覽器、Node 22+ 內建、`ws` 都符合） */
export interface IotDeviceSocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: {
        data: unknown;
    }) => void) | null;
    onclose: ((ev: {
        code: number;
        reason: string;
    }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
}
/** 開一條帶標頭的 WebSocket。預設用全域 `WebSocket`（Node 22+ 支援 `headers`；瀏覽器設不了 Authorization，要自己給） */
export type IotDeviceSocketFactory = (url: string, headers: Record<string, string>) => IotDeviceSocket;
/** up 計數器的持久化：`load` 回上次存的值（沒有＝0）；`save` 要真的寫到不會掉的地方再回來 */
export interface IotDeviceCounterStore {
    load(): number | Promise<number>;
    save(ctr: number): void | Promise<void>;
}
/** 測試與開發用：只在記憶體（重開機會從 0 開始——正式設備不要用） */
export declare function memoryIotDeviceCounterStore(initial?: number): IotDeviceCounterStore & {
    readonly value: number;
};
export interface IotDeviceCommand {
    readonly msgId: string;
    readonly topic: string;
    readonly payload: string;
    readonly enc: IotEncoding;
    readonly confirmed?: boolean;
}
/** topic → 值：字串＝utf8 酬載；物件可指定 `enc` */
export type IotDeviceStateInput = Readonly<Record<string, string | {
    readonly payload: string;
    readonly enc?: IotEncoding;
}>>;
export interface IotDeviceCommandResult {
    readonly status: IotDeviceAckStatus;
    readonly reason?: string;
    /** 執行後的狀態（會跟著 ack 一起回給下指令的人） */
    readonly state?: IotDeviceStateInput;
}
export type IotDeviceLinkState = 'connecting' | 'connected' | 'reconnecting' | 'quota-exhausted' | 'replaced' | 'relay-error' | 'closed';
export interface IotDeviceLinkInfo {
    readonly url: string;
    /** `quota-exhausted`：額度重置時間（unix 秒） */
    readonly reset?: number;
    /** 斷線的 close code */
    readonly code?: number;
    /** 下一次重連前等多久（毫秒） */
    readonly retryInMs?: number;
}
export interface IotDeviceOptions {
    url: string;
    /** 備援站（另一個 Cloudflare 帳號或家中 Node relay，§10.4）：斷線或額度用完時輪流換 */
    standbyUrls?: readonly string[];
    /** 設備權杖（`cit1_…`） */
    token: string;
    /** up 方向（以及 `query` 幀）的金鑰＝`deriveIotHome(homeSecret).deviceKey(id, epoch)` */
    deviceKey: Uint8Array;
    /** 門鎖類：`cmd` 幀的金鑰＝`deriveIotDeviceKeyDown(operatorSecret, id, epoch)`；沒給＝`cmd` 也用 `deviceKey` */
    deviceKeyDown?: Uint8Array;
    /** `<設備 id>.<epoch>` */
    kid: string;
    heartbeat?: {
        intervalSec?: number;
        timeoutSec?: number;
    };
    /** 信封時間窗（秒），預設 60；門類建議 15 */
    maxSkewSec?: number;
    counterStore: IotDeviceCounterStore;
    /** 時鐘同步了沒（SNTP）；回 false 時拒絕所有指令（fail-closed，§9.4）。沒給＝視為已同步 */
    clockSynced?: () => boolean;
    onCommand(cmd: IotDeviceCommand): IotDeviceCommandResult | Promise<IotDeviceCommandResult>;
    /** 回答查詢：目前所有 topic 的值。沒給＝查詢回 `ok`、不帶狀態 */
    onQuery?: () => IotDeviceStateInput | Promise<IotDeviceStateInput>;
    onLinkState?: (state: IotDeviceLinkState, info: IotDeviceLinkInfo) => void;
    onError?: (error: unknown) => void;
    webSocket?: IotDeviceSocketFactory;
    /** 毫秒 */
    now?: () => number;
    /** 重連退避（毫秒），預設 1,000–60,000 */
    reconnect?: {
        minMs?: number;
        maxMs?: number;
    };
}
export interface IotDeviceConnection {
    readonly state: IotDeviceLinkState;
    /** 回報狀態（25172；relay 另外每 5 分鐘最多寫一次 retained）。沒有連線時回 false（即時通道不排隊） */
    publishState(state: IotDeviceStateInput, opts?: {
        will?: boolean;
    }): Promise<boolean>;
    close(): void;
}
/** 連上 relay 的 C′ 設備通道 */
export declare function connectIotDevice(opts: IotDeviceOptions): IotDeviceConnection;
//# sourceMappingURL=device.d.ts.map