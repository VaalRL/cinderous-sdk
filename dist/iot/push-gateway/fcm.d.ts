import { type PushDelivery, type PushDeliveryResult, type PushSender } from './core.js';
export declare const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export declare const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export declare const FCM_SEND_ORIGIN = "https://fcm.googleapis.com";
export interface FcmServiceAccount {
    readonly projectId: string;
    readonly clientEmail: string;
    readonly privateKeyPem: string;
    readonly privateKeyId?: string;
}
/**
 * 解析服務帳號 JSON（Firebase 主控台 → 專案設定 → 服務帳號 → 產生新的私密金鑰）。
 * 🔴 錯誤訊息不含任何內容（`JSON.parse` 的錯誤會引用原文片段，所以不轉出它）。
 */
export declare function parseFcmServiceAccount(raw: string): FcmServiceAccount;
export interface FcmSenderOptions {
    account: FcmServiceAccount;
    /** 預設全域 fetch（測試注入 mock；不會真的呼叫 Google） */
    fetch?: typeof fetch;
    now?: () => number;
    iosLocKey?: string;
}
export declare class FcmSender implements PushSender {
    #private;
    constructor(opts: FcmSenderOptions);
    /** 啟動時先匯入私鑰（壞掉就早點失敗） */
    ready(): Promise<void>;
    send(delivery: PushDelivery): Promise<PushDeliveryResult>;
}
/** FCM 的狀態碼與 errorCode → 送出結果 */
export declare function fcmResultOf(status: number, errorCode: string | undefined, retryAfter: string | null): PushDeliveryResult;
//# sourceMappingURL=fcm.d.ts.map