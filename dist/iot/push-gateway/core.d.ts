import { type IotPushTokenPayload } from '../push.js';
/** 一次要送出的喚醒（token 只在推播閘道裡出現） */
export interface PushDelivery {
    readonly platform: 'android' | 'ios';
    readonly tokenType: 'fcm' | 'apns';
    readonly token: string;
    /** iOS NSE 回中繼取用的不透明事件 id（Android 一律不帶） */
    readonly ref?: string;
}
/**
 * 送出結果。`apnsReason`：APNs 回非 200 時的 reason（白名單內的字串或 `other`；SDK ADR 0062 §6），推播閘道只寫進日誌、不寫進回應
 */
export type PushDeliveryResult = {
    readonly status: 'ok';
} | {
    readonly status: 'gone';
    readonly apnsReason?: string;
} | {
    readonly status: 'retry';
    readonly retryAfterSec: number;
    readonly apnsReason?: string;
} | {
    readonly status: 'error';
    readonly code: string;
    readonly apnsReason?: string;
};
/** 送出層（FCM、APNs）。錯誤只回代碼，不丟出含憑證或 token 的例外 */
export interface PushSender {
    send(delivery: PushDelivery): Promise<PushDeliveryResult>;
}
/**
 * iOS 怎麼送：`apns`＝直連 APNs（兩版都可以，SDK ADR 0061；**沒寫 `PUSH_IOS` 時的預設**，v0.48.0 起，SDK ADR 0062）、
 * `fcm`＝經 Firebase 轉給 APNs（仍可用但兩版都已棄用——Google 也看得到 iOS 的喚醒時間點）、`off`＝不支援 iOS（只要 Android 時不需要 Apple 金鑰）
 */
export type PushGatewayIosMode = 'fcm' | 'apns' | 'off';
/** 沒寫 `PUSH_IOS` 時的 iOS 模式（SDK ADR 0062；部署設定器的 `pushGateway.ios` 預設值由測試比對這裡） */
export declare const DEFAULT_PUSH_GATEWAY_IOS_MODE: PushGatewayIosMode;
export interface PushGatewayLimits {
    readonly tokenPerHour: number;
    readonly tokenPerMinute: number;
    readonly maxSkewSec: number;
    readonly maxRegistrationDays: number;
}
export declare const DEFAULT_PUSH_GATEWAY_LIMITS: PushGatewayLimits;
export interface PushGatewayConfig {
    /** 推播閘道私鑰（解封 token 封包） */
    readonly secretKey: Uint8Array;
    readonly pubkey: string;
    readonly android: boolean;
    readonly ios: PushGatewayIosMode;
    readonly iosLocKey: string;
    readonly limits: PushGatewayLimits;
}
/** 推播閘道讀的環境變數（Worker 是 secret／vars，Node 是環境變數或 .env） */
export declare const PUSH_GATEWAY_ENV: {
    readonly key: "PUSH_GATEWAY_KEY";
    readonly fcmServiceAccount: "FCM_SERVICE_ACCOUNT";
    readonly apnsKey: "APNS_KEY";
    readonly apnsKeyId: "APNS_KEY_ID";
    readonly apnsTeamId: "APNS_TEAM_ID";
    readonly apnsTopic: "APNS_TOPIC";
    readonly apnsEnvironment: "APNS_ENV";
    readonly ios: "PUSH_IOS";
    readonly android: "PUSH_ANDROID";
    readonly tokenPerHour: "PUSH_TOKEN_PER_HOUR";
    readonly tokenPerMinute: "PUSH_TOKEN_PER_MINUTE";
    readonly maxSkewSec: "PUSH_MAX_SKEW_SEC";
    readonly maxRegistrationDays: "PUSH_MAX_REGISTRATION_DAYS";
    readonly iosLocKey: "PUSH_IOS_LOC_KEY";
};
/** 推播閘道的上限在部署設定器裡的範圍（`DEPLOY_OPTION_SPECS` 的 `pushGateway.*` 引用這裡） */
export declare const PUSH_GATEWAY_LIMIT_RANGES: Readonly<Record<keyof PushGatewayLimits, {
    min: number;
    max: number;
    default: number;
}>>;
type Env = Readonly<Record<string, string | undefined>>;
/** 讀 `PUSH_IOS`（沒寫或空白＝`DEFAULT_PUSH_GATEWAY_IOS_MODE`）。Node 版據此決定要不要帶 HTTP/2 傳輸 */
export declare function pushGatewayIosModeFromEnv(env: Env): PushGatewayIosMode;
/**
 * 從環境變數組出設定（不含送出層的憑證：FCM／APNs 憑證由 `fcmCredentialsFromEnv`、`apnsCredentialsFromEnv` 讀）。
 * 🔴 錯誤訊息只寫變數名稱，**不寫值**。
 */
export declare function pushGatewayConfigFromEnv(env: Env, _host: 'worker' | 'node'): PushGatewayConfig;
/** 一個 token 的狀態 */
export interface PushTokenState {
    /** 最近一小時送出的時間（毫秒，遞增） */
    hits: number[];
    /** 登記 id → 最後接受的時間戳、封包到期（秒）、是否已撤銷 */
    regs: Record<string, {
        last: number;
        exp: number;
        revoked?: true;
    }>;
}
export interface PushAdmitRequest {
    readonly tokenKey: string;
    readonly regId: string;
    /** 喚醒請求的時間戳（毫秒） */
    readonly ts: number;
    /** 封包到期（秒） */
    readonly exp: number;
    /** 推播閘道現在的時間（毫秒） */
    readonly now: number;
}
export type PushAdmitVerdict = {
    readonly verdict: 'ok';
} | {
    readonly verdict: 'replay';
} | {
    readonly verdict: 'revoked';
} | {
    readonly verdict: 'busy';
} | {
    readonly verdict: 'rate-limited';
    readonly retryAfterSec: number;
};
/** 一個 token 最多記幾個登記（每個送出端一個；撤銷的要留到到期，否則撤銷會失效） */
export declare const PUSH_MAX_REGS_PER_TOKEN = 256;
/**
 * 決定這一次喚醒能不能送（並記下）。`floorTs`＝沒見過的登記的時間戳下限（Node 版是啟動時間：重啟後重放不了重啟前的請求）。
 * 時間窗由呼叫端先檢查。
 */
export declare function admitPushWake(state: PushTokenState, req: PushAdmitRequest, limits: PushGatewayLimits, floorTs?: number): PushAdmitVerdict;
/** 撤銷一個登記（直到封包到期） */
export declare function revokePushRegistration(state: PushTokenState, req: PushAdmitRequest, floorTs?: number): 'ok' | 'replay' | 'busy';
/** 狀態的保存（Node：記憶體；Workers：每個 token 一顆 DO） */
export interface PushGatewayStore {
    admit(req: PushAdmitRequest, limits: PushGatewayLimits): Promise<PushAdmitVerdict>;
    revoke(req: PushAdmitRequest): Promise<'ok' | 'replay' | 'busy'>;
}
/** 記憶體版（Node 版、測試）。重啟後：沒見過的登記只收啟動之後的時間戳（重放不了重啟前的請求），撤銷紀錄會遺失（文件註明） */
export declare function memoryPushGatewayStore(opts?: {
    now?: () => number;
    maxTokens?: number;
}): PushGatewayStore & {
    size(): number;
};
/** 日誌：只有事件與結果代碼，沒有 token、封包、密鑰、網址 */
export interface PushGatewayLogEntry {
    readonly event: 'wake' | 'revoke' | 'config';
    readonly result: string;
    readonly platform?: 'android' | 'ios';
    /** APNs 回非 200 時的 reason（`APNS_REASONS` 之一或 `other`；SDK ADR 0062 §6）。只有代碼，不含 token、JWT 或金鑰 */
    readonly apnsReason?: string;
}
export interface PushGatewayOptions {
    config: PushGatewayConfig;
    senders: {
        fcm?: PushSender;
        apns?: PushSender;
    };
    store: PushGatewayStore;
    now?: () => number;
    onLog?: (entry: PushGatewayLogEntry) => void;
}
/** 喚醒與撤銷請求本文的上限（封包 ≤ 4 KB） */
export declare const PUSH_GATEWAY_MAX_BODY_BYTES: number;
/** token 的鍵（速率限制與狀態以它分組；只存雜湊） */
export declare function pushTokenKey(payload: Pick<IotPushTokenPayload, 'tt' | 't'>): string;
/** 以推播閘道私鑰解開封包；解不開或形狀不對回 undefined */
export declare function openIotPushToken(secretKey: Uint8Array, sealed: string): IotPushTokenPayload | undefined;
/** 建立推播閘道的 HTTP 處理函式（`(Request) => Response`；Workers 直接用，Node 版轉接） */
export declare function createPushGatewayHandler(opts: PushGatewayOptions): (request: Request) => Promise<Response>;
export {};
//# sourceMappingURL=core.d.ts.map