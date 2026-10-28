import type { RelaySiteOptions } from '../shared.js';
/** 設定檔 schema 的版號。改版時以逐版的純函式遷移（`DEPLOY_CONFIG_MIGRATIONS`、`cinderous config migrate`；SDK ADR 0118）。 */
export declare const DEPLOY_CONFIG_VERSION = 1;
/**
 * 部署目標（SDK ADR 0050 §3、§5）：
 * - `cloudflare`：Cloudflare Workers，以 wrangler 部署；
 * - `cloudflare-api`：Cloudflare Workers，以 REST API 部署（外掛用 `deployCloudflareRelayViaApi`；CLI 的 `relay deploy --config` 也走 REST，SDK ADR 0118）；
 * - `docker`：這台機器的 docker compose；
 * - `fly`：Fly.io；
 * - `home-tunnel`：家中主機＋Cloudflare Tunnel（relay 不發布埠，`cloudflared` 對外）。
 */
export declare const DEPLOY_TARGETS: readonly ["cloudflare", "cloudflare-api", "docker", "fly", "home-tunnel"];
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];
/**
 * 部署的服務（SDK ADR 0050；ADR 0049 §11.1 裁示 5、7）：
 * - `relay`（預設）：Cinderous 中繼；
 * - `push-gateway`：App 開發者的參考推播閘道（FCM／APNs 憑證只在這裡）。Workers 目標＝Workers 版，
 *   Node 目標（docker、fly、home-tunnel）＝Node 版；兩版的 iOS 都能直連 APNs（SDK ADR 0061）。
 */
export declare const DEPLOY_SERVICES: readonly ["relay", "push-gateway"];
export type DeployService = (typeof DEPLOY_SERVICES)[number];
/** 設定檔的服務（沒寫＝`relay`） */
export declare function serviceOfConfig(config: {
    service?: unknown;
}): DeployService;
/** 中繼跑在哪一種宿主：Cloudflare 版（Worker＋DO）或 Node 主機。 */
export type RelayHost = 'worker' | 'node';
export declare function hostOfTarget(target: DeployTarget): RelayHost;
/**
 * 秘密的引用（SDK ADR 0050 §4）：設定檔與部署包**只寫環境變數的名稱**，值在部署時從環境（或 `.env`）讀。
 * 例：`{ "$env": "CLOUDFLARE_API_TOKEN" }`。
 */
export interface SecretRef {
    $env: string;
}
export declare function isSecretRef(value: unknown): value is SecretRef;
/**
 * 設定檔的 `site`：與 {@link RelaySiteOptions} 相同，只有私人路徑（SDK ADR 0051）與唯讀寬限期（SDK ADR 0052）是秘密、只能寫 `{ "$env": "NAME" }`。
 * 部署時才從環境讀出值（`resolveSiteSecrets`）。
 */
export type DeploySiteOptions = Omit<RelaySiteOptions, 'privateLane' | 'readOnlyLanes'> & {
    privateLane?: SecretRef;
    /** 唯讀寬限期（SDK ADR 0052）：環境變數的值是中繼 `READONLY_LANES` 的格式（`<id>@<到期 unix 秒>`，逗號分隔） */
    readOnlyLanes?: SecretRef;
};
/** 部署要用的秘密（都只是引用）。沒給就用各工具慣用的環境變數名稱（見描述表的 `defaultEnv`）。 */
export interface DeploySecrets {
    /** Cloudflare API Token（`cloudflare`、`cloudflare-api`）。沒給：讀 `CLOUDFLARE_API_TOKEN`，再沒有就交給 `wrangler login`。 */
    cloudflareApiToken?: SecretRef;
    /** Fly API Token（`fly`）。沒給：讀 `FLY_API_TOKEN`，再沒有就交給 `fly auth login`。 */
    flyApiToken?: SecretRef;
    /** Cloudflare Tunnel Token（`home-tunnel`，必填）。 */
    tunnelToken?: SecretRef;
    /** Cloudflare TURN 的 API Token（Worker secret `TURN_API_TOKEN`；SDK ADR 0118） */
    turnApiToken?: SecretRef;
    /** C′ 的閘道私鑰（`IOT_GATEWAY_KEYS`，JSON `{ homeTag: 64 位 hex }`；SDK ADR 0121） */
    iotGatewayKeys?: SecretRef;
    /** 推播閘道私鑰（`push-gateway`；執行期秘密 `PUSH_GATEWAY_KEY`）。 */
    pushGatewayKey?: SecretRef;
    /** Firebase 服務帳號 JSON（`push-gateway`；執行期秘密 `FCM_SERVICE_ACCOUNT`）。 */
    fcmServiceAccount?: SecretRef;
    /** APNs 的 .p8 金鑰（`push-gateway` 直連 APNs，Workers 版與 Node 版；執行期秘密 `APNS_KEY`）。 */
    apnsKey?: SecretRef;
}
/** 推播閘道的選項（`service: 'push-gateway'`；ADR 0049 §11.1） */
export interface PushGatewayDeployOptions {
    /** Android（FCM 高優先空資料訊息），預設 true */
    android?: boolean;
    /**
     * iOS：`apns`（直連 APNs；**沒寫時的預設**，v0.48.0 起，SDK ADR 0062）、`fcm`（經 Firebase，兩版都已棄用）、
     * `off`（不支援 iOS：只要 Android 時不需要 Apple 金鑰）
     */
    ios?: 'fcm' | 'apns' | 'off';
    /** iOS 通知的在地化鍵（App 的 Localizable.strings 提供文字），預設 `CINDER_WAKE` */
    iosLocKey?: string;
    /** 直連 APNs：bundle id、Key ID、Team ID、環境 */
    apnsTopic?: string;
    apnsKeyId?: string;
    apnsTeamId?: string;
    apnsEnvironment?: 'production' | 'sandbox';
    /** 上限（裁示 7）：每個 token 每小時／每分鐘、時間戳誤差（秒）、登記最長天數 */
    tokenPerHour?: number;
    tokenPerMinute?: number;
    maxSkewSec?: number;
    maxRegistrationDays?: number;
}
/**
 * `cinderous.config.json`（SDK ADR 0050 §3）：所有部署選擇的單一真實來源，可提交、可 diff，每次部署帶同一份。
 * `site` 原樣沿用 {@link RelaySiteOptions}（與四條部署路徑同一份驗證）。
 */
export interface DeployConfig {
    /** 給編輯器用的 JSON Schema 位置（可省略） */
    $schema?: string;
    configVersion: typeof DEPLOY_CONFIG_VERSION;
    /** 產生這份設定的 SDK 版號；CLI 比它舊就拒絕、比它新就提醒中間影響部署的變更 */
    sdk?: string;
    target: DeployTarget;
    /** 部署哪個服務，預設 `relay` */
    service?: DeployService;
    /** Worker／容器／Fly app 名稱，預設 `cinderous-relay` */
    name?: string;
    site?: DeploySiteOptions;
    /** Node 主機（docker、fly、home-tunnel）才有的選項 */
    node?: {
        persist?: boolean;
        port?: number;
        trustProxy?: boolean;
        /** docker：只發布在這個位址（SDK ADR 0119）；沒給時 `trustProxy` 就是 `127.0.0.1`，否則所有網卡 */
        bindAddress?: string;
    };
    cloudflare?: {
        /** Account ID 不是秘密，可以直接寫；也可以用 `$env` 引用 */
        accountId?: string | SecretRef;
        compatibilityDate?: string;
        /** 只有 REST 路徑（`cloudflare-api`）用：帳號還沒有 workers.dev 子網域時要註冊的名稱 */
        workersDevSubdomain?: string;
    };
    fly?: {
        region?: string;
    };
    tunnel?: {
        /** 對外的主機名稱（例如 `relay.example.com`），在 Cloudflare 的 Tunnel 設定裡指向 `http://relay:8080` */
        hostname?: string;
        /** cloudflared 映像，預設 `cloudflare/cloudflared:latest` */
        cloudflaredImage?: string;
    };
    /** `service: 'push-gateway'` 的選項 */
    pushGateway?: PushGatewayDeployOptions;
    secrets?: DeploySecrets;
}
//# sourceMappingURL=types.d.ts.map