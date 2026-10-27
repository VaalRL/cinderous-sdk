import { type PubkeyHex } from '../protocol/keys.js';
/** 推播協定版本（封包與喚醒請求的 `v`） */
export declare const IOT_PUSH_VERSION = 1;
export interface IotPushLimitSpec {
    readonly default: number;
    readonly min: number;
    readonly max: number;
}
/**
 * 推播的上限（裁示 7）。送出端（閘道、設備、日後的中繼）用前四項；推播閘道用後三項。
 * - `maxEndpoints`：每個家庭最多幾個推播端點（對齊 `ROSTER_MAX_DEVICES` 的 32）；
 * - `standardPerMinute`：標準模式每個端點每分鐘最多幾次（ADR-0272：60 秒合併）；
 * - `instantPerMinute`：即時模式每個端點每分鐘最多幾次（含標準）；
 * - `registrationTtlSec`：登記的存活（ADR-0272：30 天，啟動時續期）；
 * - `gatewayTokenPerHour`／`gatewayTokenPerMinute`：推播閘道每個 token 的上限（每分鐘的上限＝即時模式的上限，縱深防禦）；
 * - `gatewayMaxSkewSec`：推播閘道接受的時間戳誤差。
 */
export declare const IOT_PUSH_LIMITS: {
    readonly maxEndpoints: {
        readonly default: 32;
        readonly min: 1;
        readonly max: 256;
    };
    readonly standardPerMinute: {
        readonly default: 1;
        readonly min: 1;
        readonly max: 6;
    };
    readonly instantPerMinute: {
        readonly default: 6;
        readonly min: 1;
        readonly max: 30;
    };
    readonly registrationTtlSec: {
        readonly default: number;
        readonly min: 3600;
        readonly max: number;
    };
    readonly gatewayTokenPerHour: {
        readonly default: 60;
        readonly min: 1;
        readonly max: 3600;
    };
    readonly gatewayTokenPerMinute: {
        readonly default: 6;
        readonly min: 1;
        readonly max: 60;
    };
    readonly gatewayMaxSkewSec: {
        readonly default: 300;
        readonly min: 30;
        readonly max: 3600;
    };
};
export type IotPushLimitKey = keyof typeof IOT_PUSH_LIMITS;
export type IotPushLimits = {
    readonly [K in IotPushLimitKey]: number;
};
/**
 * 補上預設值並檢查範圍。`strict`（設定檔用）＝超出範圍丟例外；否則夾進範圍（程式內的選項）。
 */
export declare function iotPushLimits(input?: Partial<Record<IotPushLimitKey, number>>, opts?: {
    strict?: boolean;
}): IotPushLimits;
/** 標準模式的抖動上限（毫秒）：ADR-0272 的 0–30 秒 */
export declare const IOT_PUSH_STANDARD_JITTER_MS = 30000;
/** 即時模式的抖動上限（毫秒）：裁示 2 的 0–2 秒 */
export declare const IOT_PUSH_INSTANT_JITTER_MS = 2000;
/** 推播的投遞存活（秒）：FCM `android.ttl`、APNs `apns-expiration`、UnifiedPush `TTL`；喚醒晚一小時以上就沒有意義 */
export declare const IOT_PUSH_DELIVERY_TTL_SEC = 3600;
export type IotPushEndpoint = {
    readonly type: 'unifiedpush';
    readonly url: string;
} | {
    readonly type: 'gateway';
    readonly url: string;
    readonly sealed: string;
    readonly key: string;
};
export declare const IOT_PUSH_URL_MAX = 2048;
export declare const IOT_PUSH_SEALED_MAX = 4096;
/** 區網或本機的主機（明文 http 只允許這些，例如家裡自架的 ntfy） */
export declare function isPrivateIotPushHost(hostname: string): boolean;
/**
 * 驗證推播端點（不丟出端點內容：網址本身就是能力，不進錯誤訊息）。
 * `allowPrivateHttp`：允許 `http://` 的區網主機（家中橋接器送給家裡的 ntfy）；中繼當送出端時不得開。
 */
export declare function parseIotPushEndpoint(raw: unknown, opts?: {
    allowPrivateHttp?: boolean;
}): IotPushEndpoint;
/** 端點的 id（22 字元）：同一個端點登記兩次是同一筆（更新） */
export declare function iotPushEndpointId(endpoint: IotPushEndpoint): string;
/** 封包的登記 id（推播閘道以它防重放與撤銷；22 字元） */
export declare function iotPushRegId(sealed: string): string;
export type IotPushPlatform = 'android' | 'ios';
/** token 的種類：`fcm`（Android，或 iOS 經 Firebase SDK）、`apns`（iOS 直連 APNs 的裝置 token） */
export type IotPushTokenType = 'fcm' | 'apns';
/** 封包裡的明文（只有推播閘道解得開） */
export interface IotPushTokenPayload {
    readonly v: 1;
    readonly p: IotPushPlatform;
    readonly tt: IotPushTokenType;
    /** FCM registration token 或 APNs 裝置 token */
    readonly t: string;
    /** 每次登記獨有的密鑰（64 位 hex） */
    readonly k: string;
    /** 產生時間與到期時間（Unix 秒） */
    readonly iat: number;
    readonly exp: number;
}
/** 檢查封包明文的形狀（推播閘道解開後用；不合法回 undefined） */
export declare function parseIotPushTokenPayload(raw: unknown): IotPushTokenPayload | undefined;
export interface SealIotPushTokenInput {
    readonly platform: IotPushPlatform;
    /** FCM registration token，或（iOS 直連 APNs 時）APNs 裝置 token 的 hex */
    readonly token: string;
    /** 預設：android → fcm；ios → fcm（推播閘道 `GET /v1/info` 的 `ios` 是 `apns` 時改給 `apns`） */
    readonly tokenType?: IotPushTokenType;
    /** 存活（秒），預設 30 天，夾 1 小時–30 天 */
    readonly ttlSec?: number;
    /** 現在（毫秒），測試用 */
    readonly now?: number;
}
/**
 * App 端：把推播 token 封給推播閘道（ephemeral secp256k1 × 推播閘道公鑰 → NIP-44 v2），並產生「每次登記獨有密鑰」。
 * 回傳的 `{ sealed, key }` 連同推播閘道網址就是一個 `gateway` 端點。**每登記一個送出端就封一次**（各自的密鑰：
 * 一個送出端外洩，不影響其他送出端的簽章，推播閘道也能逐一撤銷）。
 */
export declare function sealIotPushToken(gatewayPubkey: string, input: SealIotPushTokenInput): {
    sealed: string;
    key: string;
    expiresAt: number;
};
/** 拆開封包外框（推播閘道用）：`{ epk, ciphertext }`；不是封包回 undefined */
export declare function splitIotPushSealed(sealed: string): {
    epk: PubkeyHex;
    ciphertext: string;
} | undefined;
/** iOS NSE 回中繼取用的不透明事件 id：只能是 Nostr 事件 id（64 位小寫 hex），不能夾帶任何其他東西 */
export declare const IOT_PUSH_REF_PATTERN: RegExp;
/** 要簽的字串：時間戳（毫秒）、`ref`、登記 id；換行分隔 */
export declare function iotPushWakeMessage(regId: string, ts: number, ref?: string): string;
export declare function iotPushRevokeMessage(regId: string, ts: number): string;
/** HMAC-SHA256（hex）：以「每次登記獨有密鑰」簽 */
export declare function iotPushSign(keyHex: string, message: string): string;
/** 送給推播閘道的喚醒請求本文：只有封包、時間戳、簽章與選用的 `ref`（{@link assertEmptyIotPushWake} 守門） */
export interface IotPushWakeBody {
    readonly v: 1;
    readonly sealed: string;
    /** 毫秒；同一個登記必須嚴格遞增（推播閘道以它防重放） */
    readonly ts: number;
    readonly sig: string;
    readonly ref?: string;
}
export interface IotPushRevokeBody {
    readonly v: 1;
    readonly sealed: string;
    readonly ts: number;
    readonly sig: string;
}
/**
 * 喚醒請求一律是空的（裁示 3）：本文只能有 `v`、`sealed`、`ts`、`sig`、選用的 `ref`（64 位 hex）。
 * 多一個欄位（設備、類別、內容、標題）就丟例外——送出端與推播閘道都呼叫它。
 */
export declare function assertEmptyIotPushWake(body: unknown): asserts body is IotPushWakeBody;
export declare function buildIotPushWakeBody(endpoint: Extract<IotPushEndpoint, {
    type: 'gateway';
}>, wake: {
    ts: number;
    ref?: string;
}): IotPushWakeBody;
/** App 端停用推播時：請推播閘道撤銷這個登記（直到封包到期） */
export declare function buildIotPushRevokeBody(endpoint: Extract<IotPushEndpoint, {
    type: 'gateway';
}>, ts: number): IotPushRevokeBody;
/** 一則要送出的 HTTP 請求（`fetch` 的參數；也給設備端照抄） */
export interface IotPushRequest {
    readonly url: string;
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
}
/**
 * 喚醒請求：
 * - `unifiedpush`：`POST <網址>`，本文**空的**（RFC 8030 §5 沒有內容的推播），`TTL`＋`Urgency: high`；`ref` 不送；
 * - `gateway`：`POST <推播閘道>/v1/wake`，本文 {@link IotPushWakeBody}。
 */
export declare function buildIotPushRequest(endpoint: IotPushEndpoint, wake: {
    ts: number;
    ref?: string;
}): IotPushRequest;
/** 送出結果：`gone`＝端點已失效（送出端刪掉它）；`retry`＝對方要求晚點再送 */
export type IotPushSendResult = {
    readonly status: 'ok';
} | {
    readonly status: 'gone';
} | {
    readonly status: 'retry';
    readonly retryAfterMs: number;
} | {
    readonly status: 'error';
    readonly reason: string;
};
/** 送出一次喚醒（可注入；預設 {@link fetchIotPushSend}） */
export type IotPushSend = (endpoint: IotPushEndpoint, wake: {
    readonly ts: number;
    readonly ref?: string;
}) => Promise<IotPushSendResult>;
/** `Retry-After`（秒數或 HTTP 日期）→ 毫秒；沒有或看不懂回 `fallbackMs` */
export declare function retryAfterMs(header: string | null | undefined, nowMs: number, fallbackMs?: number): number;
/** HTTP 狀態 → 送出結果（UnifiedPush 與推播閘道共用） */
export declare function iotPushResultOf(status: number, retryAfter: string | null, nowMs: number): IotPushSendResult;
/**
 * 預設的送出函式：以 `fetch` 送 {@link buildIotPushRequest}。錯誤原因只有狀態碼或 `network`／`timeout`——
 * **不含網址**（UnifiedPush 網址本身就是能力，不能進日誌）。
 */
export declare function fetchIotPushSend(fetchImpl?: typeof fetch, opts?: {
    timeoutMs?: number;
    now?: () => number;
}): IotPushSend;
export type IotPushMode = 'standard' | 'instant';
export declare const IOT_PUSH_MODES: readonly IotPushMode[];
/** 特殊的可訂閱項目：額度預警（只有 owner；ADR 0049 §10、§11.1 裁示 1） */
export type IotPushSpecial = 'quota';
export declare const IOT_PUSH_SPECIALS: readonly IotPushSpecial[];
/** 一個登記最多幾個訂閱 */
export declare const IOT_PUSH_MAX_SUBSCRIPTIONS = 64;
export type IotPushSubscription = {
    readonly dv: string;
    readonly mode: IotPushMode;
} | {
    readonly special: IotPushSpecial;
    readonly mode: IotPushMode;
};
/** 驗證訂閱清單：`dv` 是盲化 id、`mode` 預設 standard、不重複 */
export declare function parseIotPushSubscriptions(raw: unknown): IotPushSubscription[];
/** `$sys/push` 的操作（指令的 payload，JSON） */
export type IotPushOp = {
    readonly op: 'register';
    /** 端點（{@link IotPushEndpoint} 的 JSON）以 NIP-44 加密給送出端（成員私鑰 × 送出端公鑰） */
    readonly endpoint: string;
    readonly subscriptions: readonly IotPushSubscription[];
    /** 存活（秒），預設 30 天 */
    readonly ttlSec?: number;
} | {
    readonly op: 'remove';
    readonly id: string;
};
/** 驗證 `$sys/push` 的操作內容；不合法丟例外 */
export declare function parseIotPushOp(payload: string): IotPushOp;
/** 送出端保存的一筆登記（帶 TTL；裁示 3） */
export interface IotPushRegistration {
    readonly id: string;
    /** 登記的成員（外層事件的簽章者） */
    readonly owner: PubkeyHex;
    readonly endpoint: IotPushEndpoint;
    readonly subscriptions: readonly IotPushSubscription[];
    /** Unix 秒 */
    readonly createdAt: number;
    readonly expiresAt: number;
}
//# sourceMappingURL=push.d.ts.map