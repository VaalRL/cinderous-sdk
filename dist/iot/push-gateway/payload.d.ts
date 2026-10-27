/** iOS 通知的在地化鍵：只能是大寫英數與底線（不能夾帶任何文字） */
export declare const PUSH_IOS_LOC_KEY_PATTERN: RegExp;
/** 預設的在地化鍵：App 的 Localizable.strings 要有它（例如「有新動態」）；NSE 來不及解密時顯示的就是它 */
export declare const DEFAULT_PUSH_IOS_LOC_KEY = "CINDER_WAKE";
/** APNs 的 payload（直連 APNs 的本文；經 FCM 時放在 `apns.payload`） */
export interface IosWakePayload {
    readonly aps: {
        readonly alert: {
            readonly 'loc-key': string;
        };
        readonly 'mutable-content': 1;
    };
    readonly ref?: string;
}
export declare function iosWakePayload(locKey: string, ref?: string): IosWakePayload;
/** FCM HTTP v1 的 Android 訊息：高優先、空資料 */
export declare function androidFcmMessage(token: string): {
    message: {
        token: string;
        data: Record<string, never>;
        android: {
            priority: 'HIGH';
            ttl: string;
        };
    };
};
/** FCM HTTP v1 的 iOS 訊息（FCM 轉給 APNs）：一般推播、高優先、`mutable-content` */
export declare function iosFcmMessage(token: string, locKey: string, ref: string | undefined, nowSec: number): {
    message: Record<string, unknown>;
};
/**
 * 零知識守門（SDK ADR 0011 §6 `assertZeroKnowledgePush` 的延伸）：
 * - `android`：FCM 訊息只能有 `token`、`data`（必須是空的——沿用 `assertZeroKnowledgePush('fcm', …)`）、`android`（只有 `priority`、`ttl`）；
 * - `ios`：APNs payload 只能有 `aps`（`alert` 只有 `loc-key`、`mutable-content: 1`）與選用的 `ref`（64 位 hex）。
 */
export declare function assertContentlessPushPayload(platform: 'android' | 'ios', payload: unknown): void;
//# sourceMappingURL=payload.d.ts.map