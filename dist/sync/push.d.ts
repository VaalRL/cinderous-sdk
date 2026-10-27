export type PushProviderType = 'disabled' | 'apns' | 'fcm' | 'unifiedpush';
export interface PushNotificationConfig {
    readonly provider: PushProviderType;
    /** 只做背景喚醒、不跳系統通知 */
    readonly silentWakeupOnly: boolean;
    readonly gatewayEndpoint?: string;
    readonly appBundleId?: string;
}
export interface IPushNotificationAdapter {
    readonly provider: PushProviderType;
    registerDevice(token: string): Promise<void>;
    unregisterDevice(): Promise<void>;
    onNotificationReceived(callback: (payload: unknown) => void): void;
}
/** 預設：不推播。完全靠 App 回到前景時的秒級水化（`FastHydrator`），零元資料外洩。 */
export declare class DisabledPushAdapter implements IPushNotificationAdapter {
    readonly provider: "disabled";
    registerDevice(_token: string): Promise<void>;
    unregisterDevice(): Promise<void>;
    onNotificationReceived(): void;
}
/** 各廠商的喚醒訊號：只有「醒來」這個意思，沒有任何內容。 */
export declare function silentTicklePayload(provider: Exclude<PushProviderType, 'disabled'> | 'disabled'): Record<string, unknown>;
/**
 * 零知識推播檢查（PRD 2.5.3）：推播內容必須**完全等於**該廠商的喚醒訊號。
 * 多一個欄位（標題、內文、寄件人、群組名）就丟例外——這些都會經過 Apple／Google 的伺服器。
 */
export declare function assertZeroKnowledgePush(provider: Exclude<PushProviderType, 'disabled'>, payload: unknown): void;
//# sourceMappingURL=push.d.ts.map