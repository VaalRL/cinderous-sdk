/**
 * `@cinderous/client/iot/push-gateway/node`（SDK ADR 0049 §11.1 裁示 5）：推播閘道的 **Node 版**。
 *
 * - FCM 與 Workers 版相同（fetch＋WebCrypto RS256）；**iOS 直連 APNs**（`PUSH_IOS=apns`，v0.48.0 起是預設：`node:http2`＋ES256 provider token），不經 Google。
 *   `PUSH_IOS=fcm` 仍可用但已棄用（啟動時記 `ios-via-fcm-deprecated`；SDK ADR 0062）；`PUSH_IOS=off` 只送 Android。
 *   APNs 的請求、provider token 與回應對照與 Workers 版共用（`./apns.js`），只有傳輸不同（SDK ADR 0061）。
 * - 狀態存在記憶體（單一程序）：重啟後只收啟動之後的時間戳（重放不了重啟前的請求）；撤銷紀錄會遺失（封包仍會到期；App 每次停用都會撤銷）。
 * - 憑證只從環境變數讀（`PUSH_GATEWAY_KEY`、`FCM_SERVICE_ACCOUNT`、`APNS_KEY`…），絕不寫檔、不進日誌。
 */
import { type Server } from 'node:http';
import { type ApnsTransport } from './apns.js';
import { type PushGatewayLogEntry } from './core.js';
import { type PushGatewayInstance } from './index.js';
/**
 * 以 `node:http2` 送 APNs：每個 origin 一條長連線（Apple 建議重用連線），斷了自動重連。
 * `origin` 可以是 `http://`（測試用的 h2c 伺服器）。
 */
export declare function http2ApnsTransport(opts?: {
    timeoutMs?: number;
}): ApnsTransport;
export interface NodePushGatewayOptions {
    /** 預設 `PORT` 或 8080 */
    port?: number;
    /** 預設 `0.0.0.0` */
    host?: string;
    fetch?: typeof fetch;
    apnsTransport?: ApnsTransport;
    apnsOrigin?: string;
    now?: () => number;
    /** 預設印出 JSON 一行（只有事件與結果代碼） */
    onLog?: (entry: PushGatewayLogEntry) => void;
}
export interface NodePushGateway {
    readonly server: Server;
    readonly url: string;
    readonly pubkey: string;
    readonly instance: PushGatewayInstance;
    close(): Promise<void>;
}
/** 啟動 Node 版推播閘道（Docker 部署包的 `server.mjs` 用它）。設定錯誤在啟動時就丟出（訊息只有變數名稱） */
export declare function startNodePushGateway(env: Readonly<Record<string, string | undefined>>, opts?: NodePushGatewayOptions): Promise<NodePushGateway>;
//# sourceMappingURL=node.d.ts.map