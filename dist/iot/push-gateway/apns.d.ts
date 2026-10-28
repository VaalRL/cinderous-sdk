import { type PushDelivery, type PushDeliveryResult, type PushSender } from './core.js';
import { type PushCryptoKey } from './jwt.js';
export declare const APNS_ORIGINS: {
    readonly production: "https://api.push.apple.com";
    readonly sandbox: "https://api.sandbox.push.apple.com";
};
export interface ApnsCredentials {
    /** .p8 的內容（PKCS#8 PEM） */
    readonly keyPem: string;
    /** 10 字元的 Key ID */
    readonly keyId: string;
    /** 10 字元的 Team ID */
    readonly teamId: string;
    /** App 的 bundle id（`apns-topic`） */
    readonly topic: string;
    readonly environment: 'production' | 'sandbox';
}
type Env = Readonly<Record<string, string | undefined>>;
/** 從環境變數讀 APNs 憑證（`APNS_KEY`、`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_TOPIC`、`APNS_ENV`）；錯誤只寫變數名稱 */
export declare function apnsCredentialsFromEnv(env: Env): ApnsCredentials;
/** APNs 的傳輸（Node：`http2ApnsTransport`；Workers：`fetchApnsTransport`；測試注入） */
export interface ApnsTransport {
    post(origin: string, path: string, headers: Record<string, string>, body: string): Promise<{
        status: number;
        body: string;
    }>;
    close?(): void;
}
/**
 * 以 `fetch()` 送 APNs（Workers 版）：Cloudflare 邊緣的子請求會與 APNs 協商 HTTP/2（ADR 0049 §11 實測：6／6 次拿到 APNs 真正的回應）。
 * Node 的 `fetch`（undici）預設只講 HTTP/1.1、APNs 不收，所以 Node 版用 `http2ApnsTransport`。失敗只丟 `network`。
 */
export declare function fetchApnsTransport(opts?: {
    fetch?: typeof fetch;
    timeoutMs?: number;
}): ApnsTransport;
export interface ApnsSenderOptions {
    credentials: ApnsCredentials;
    transport: ApnsTransport;
    now?: () => number;
    iosLocKey?: string;
    /** 測試用：換掉 APNs 的位址（例如本機的 HTTP/2 測試伺服器） */
    origin?: string;
}
/**
 * provider token 的重簽間隔（秒）。Apple：同一顆 token 最多用 1 小時，也不要比 20 分鐘更頻繁地換（否則 `TooManyProviderTokenUpdates`）。
 * 取 50 分鐘：在 20–60 分鐘之間，並留 10 分鐘給時鐘誤差。
 */
export declare const APNS_JWT_REFRESH_SEC: number;
/** 一則 APNs 請求（傳輸無關） */
export interface ApnsRequest {
    readonly origin: string;
    readonly path: string;
    readonly headers: Record<string, string>;
    readonly body: string;
}
/**
 * 組出一則 APNs 請求（純函式；兩版共用）：`POST /3/device/<token>`、`authorization: bearer <provider token>`、
 * 一般推播（`apns-push-type: alert`、高優先 10、到期＝現在＋{@link "@cinderous/client/iot"!IOT_PUSH_DELIVERY_TTL_SEC}），本文經 `iosWakePayload` 守門。
 */
export declare function buildApnsRequest(input: {
    credentials: Pick<ApnsCredentials, 'topic' | 'environment'>;
    deviceToken: string;
    providerToken: string;
    nowSec: number;
    locKey: string;
    ref?: string;
    /** 測試用：換掉主機 */
    origin?: string;
}): ApnsRequest;
/** 簽一顆 APNs provider token（ES256；header `alg`／`kid`，claims `iss`＝Team ID、`iat`） */
export declare function signApnsProviderToken(key: PushCryptoKey, credentials: Pick<ApnsCredentials, 'keyId' | 'teamId'>, nowSec: number): Promise<string>;
export declare class ApnsSender implements PushSender {
    #private;
    constructor(opts: ApnsSenderOptions);
    ready(): Promise<void>;
    send(delivery: PushDelivery): Promise<PushDeliveryResult>;
}
/**
 * Apple 文件列出的 APNs 錯誤 `reason`（Handling notification responses from APNs；依狀態碼排列）。
 * 推播閘道的日誌只記這些字串，其餘一律 `other`（SDK ADR 0062 §6）——本文是外部輸入，不原樣寫進日誌。
 */
export declare const APNS_REASONS: readonly ["BadCollapseId", "BadDeviceToken", "BadExpirationDate", "BadMessageId", "BadPriority", "BadTopic", "DeviceTokenNotForTopic", "DuplicateHeaders", "IdleTimeout", "InvalidPushType", "MissingDeviceToken", "MissingTopic", "PayloadEmpty", "TopicDisallowed", "BadCertificate", "BadCertificateEnvironment", "BadEnvironmentKeyInToken", "ExpiredProviderToken", "Forbidden", "InvalidProviderToken", "MissingProviderToken", "UnrelatedKeyIdInToken", "BadPath", "MethodNotAllowed", "ExpiredToken", "Unregistered", "PayloadTooLarge", "TooManyProviderTokenUpdates", "TooManyRequests", "InternalServerError", "ServiceUnavailable", "Shutdown"];
export type ApnsReason = (typeof APNS_REASONS)[number];
/** 日誌用的 reason：白名單內原樣、其他（含沒有本文）一律 `other` */
export declare function apnsReasonCodeOf(reason: string | undefined): ApnsReason | 'other';
/** APNs 錯誤本文的 `reason`（只取代碼） */
export declare function apnsReasonOf(body: string): string | undefined;
/**
 * APNs 的狀態碼與 reason → 送出結果。非 200 一律帶 `apnsReason`（白名單內的 reason 或 `other`），推播閘道把它寫進日誌、不寫進回應。
 * `403 BadEnvironmentKeyInToken`（金鑰限定 Sandbox 或 Production、與 `APNS_ENV` 不符）單獨給 `key-environment`，其他 403 是 `auth`。
 */
export declare function apnsResultOf(status: number, reason: string | undefined): PushDeliveryResult;
export {};
//# sourceMappingURL=apns.d.ts.map