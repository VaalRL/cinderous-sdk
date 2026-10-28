import type { IotEncoding, IotTopicValue } from './content.js';
/** 設備回覆指令的結果（角色檢查在 relay，設備只回這三種） */
export type IotDeviceAckStatus = 'ok' | 'rejected' | 'unknown-topic';
export declare const IOT_DEVICE_ACK_STATUSES: readonly IotDeviceAckStatus[];
export interface IotDownCommand {
    readonly type: 'cmd';
    readonly msgId: string;
    readonly topic: string;
    readonly payload: string;
    readonly enc: IotEncoding;
    readonly confirmed?: boolean;
    /** unix 秒 */
    readonly exp: number;
}
export interface IotDownQuery {
    readonly type: 'query';
    readonly msgId: string;
    readonly exp: number;
}
export type IotDownMessage = IotDownCommand | IotDownQuery;
export interface IotUpAck {
    readonly type: 'ack';
    readonly inReplyTo: string;
    readonly status: IotDeviceAckStatus;
    readonly reason?: string;
    /** 指令執行後（或查詢時）的狀態 */
    readonly topics?: Readonly<Record<string, IotTopicValue>>;
}
export interface IotUpState {
    readonly type: 'state';
    readonly topics: Readonly<Record<string, IotTopicValue>>;
    /** 設備層的遺囑（例如即將斷電） */
    readonly will?: boolean;
}
export type IotUpMessage = IotUpAck | IotUpState;
/** 解析 down 明文（設備端用）；不認得回 undefined */
export declare function parseIotDownMessage(data: Uint8Array | string): IotDownMessage | undefined;
/** 解析 up 明文（手機端用）；不認得回 undefined */
export declare function parseIotUpMessage(data: Uint8Array | string): IotUpMessage | undefined;
//# sourceMappingURL=device-message.d.ts.map