import { type IotDeviceEnvelope } from './envelope.js';
/** 設備送的應用層心跳（逐位元組固定） */
export declare const IOT_DEVICE_HEARTBEAT = "{\"t\":\"hb\"}";
/** 平台自動回覆的心跳（逐位元組固定） */
export declare const IOT_DEVICE_HEARTBEAT_ACK = "{\"t\":\"hb-ack\"}";
/** 單一設備幀上限（bytes）：一個信封（明文 16 KiB → base64 約 22 KiB）加欄位 */
export declare const IOT_DEVICE_FRAME_MAX_BYTES: number;
export type IotDeviceFrame = {
    readonly t: 'cmd' | 'query';
    readonly env: IotDeviceEnvelope;
} | {
    readonly t: 'ack' | 'state';
    readonly env: IotDeviceEnvelope;
} | {
    readonly t: 'hb';
};
/** 誰送的幀：`relay`＝relay 送給設備的，`device`＝設備送給 relay 的 */
export type IotDeviceFrameSource = 'relay' | 'device';
/** 編碼設備幀（心跳回傳固定字串） */
export declare function encodeIotDeviceFrame(frame: IotDeviceFrame): string;
/** 解析設備幀；方向、信封方向或格式不對回 undefined */
export declare function parseIotDeviceFrame(data: string | Uint8Array, source: IotDeviceFrameSource): IotDeviceFrame | undefined;
/** 設備權杖的形狀：`cit1_`（Cinder IoT token v1）＋32 bytes base64url——前綴讓秘密掃描認得出來 */
export declare const IOT_DEVICE_TOKEN_PATTERN: RegExp;
/** 產生一個設備權杖（只顯示一次；relay 只存 {@link hashIotDeviceToken} 的結果） */
export declare function generateIotDeviceToken(): string;
/** 權杖雜湊（SHA-256 hex）：relay 的設定只放這個 */
export declare function hashIotDeviceToken(token: string): string;
/** 以常數時間比較權杖與雜湊；權杖格式不對或雜湊不是 64 位 hex 直接回 false */
export declare function verifyIotDeviceToken(token: string | undefined, expectedHash: string): boolean;
//# sourceMappingURL=device-frame.d.ts.map