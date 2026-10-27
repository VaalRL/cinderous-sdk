import { type DeployIssue, type DeployProgress, type DeploySubstep, type ReadOnlyLane, type RelaySiteOptions } from '../shared.js';
import { type HttpFetch } from './http.js';
/**
 * 站台參數（白名單 `allowedPubkeys`、站名 `relayName`、已知租戶車道 `appLanes`、防濫用、保存期、檔案塊……）
 * 見 `RelaySiteOptions`（SDK ADR 0036、0037），與 wrangler、docker、fly 路徑共用同一份驗證。
 */
export interface CloudflareApiDeployOptions extends RelaySiteOptions {
    /** 使用者建立的 API Token（權限見 `REQUIRED_TOKEN_PERMISSIONS`），或 OAuth access token。由呼叫端保存。 */
    apiToken: string;
    /**
     * `apiToken` 是哪一種憑證。預設 `api-token`：先以 `/user/tokens/verify` 驗證。
     * `oauth`：OAuth access token 不能用那個端點驗證，改由後續第一個 API 呼叫判斷是否有效。
     */
    credential?: 'api-token' | 'oauth';
    /** 🔴 瀏覽器環境必須注入（Cloudflare API 沒有 CORS）；Obsidian 用 `requestUrl` 轉接器。沒給用全域 `fetch`。 */
    fetch?: HttpFetch;
    /** 沒給就列出帳號：只有一個時自動選，多個時丟 `account-ambiguous`（附 `accounts` 讓使用者選）。 */
    accountId?: string;
    /** Worker 名稱，也是網址的第一段。預設 `cinderous-relay`。 */
    workerName?: string;
    /**
     * 重新部署時允許已知租戶名單（`appLanes`）與線上那份不同。預設 false → `lane-change`，不上傳。
     * 🔴 名單改了＝那幾條車道換一顆 DO：舊 DO 裡的可尋址事件與離線留言不會搬過去（等 TTL 到期），
     * 對那幾條車道是一次冷啟動（SDK ADR 0036；Cinderous ADR-0366）。
     */
    allowLaneChange?: boolean;
    /**
     * 換私人路徑時，讓舊路徑進入唯讀寬限期（SDK ADR 0052）：`id` 是舊的車道 id、`graceDays` 1–30（預設 7）。
     * 部署出來的中繼 `APP_LANES` 只有新的、`READONLY_LANES` 加上舊的與到期時間：到期前舊網址連得上、讀得到、不收寫入
     * （其他裝置從那裡讀到搬家通知），到期後與認不得的路徑相同；舊路徑那顆 DO 的資料保留到期為止。
     * 要搭配 `privateLane`（新的）與 `allowLaneChange`。🔴 舊 id 也是秘密：錯誤訊息與進度不回顯。
     *
     * 不論有沒有給，重新部署都會**保留線上 `READONLY_LANES` 裡還沒到期的**（過期的清掉），不會把仍在寬限期的舊路徑弄丟。
     */
    retireLane?: {
        id: string;
        graceDays?: number;
    };
    /** 帳號還沒有 workers.dev 子網域時要註冊的名字。沒給而帳號又沒有 → `subdomain-missing`。 */
    workersDevSubdomain?: string;
    /**
     * 名稱已被帳號裡另一支 Worker（不是這個 SDK 部署的中繼）佔用時，是否覆蓋。預設 false → `name-conflict`。
     * 🔴 覆蓋會換掉那支 Worker 的程式碼與設定，無法復原。
     */
    replaceExisting?: boolean;
    compatibilityDate?: string;
    /** 寫進 NIP-11 `version` 的版號（部署者的版號）。預設是打包這份 Worker 的 SDK 版號。 */
    version?: string;
    onProgress?: DeployProgress;
    /**
     * 要上傳的中繼 Worker 原始碼。`deployCloudflareRelayViaApi` 沒給就用打包在 SDK 裡的那份；
     * `deployCloudflareRelayWithWorker` 必填（SDK ADR 0094：外掛部署時才用 `fetchRelayWorker` 下載）。
     */
    workerSource?: string;
    /** 以下供測試或特殊環境替換 */
    apiBase?: string;
    healthRetries?: number;
    healthDelayMs?: number;
}
export interface CloudflareApiDeployment {
    workerName: string;
    accountId: string;
    /** 帳號的 workers.dev 子網域（不含 `.workers.dev`） */
    subdomain: string;
    httpUrl: string;
    /** 給客戶端連的端點。私人路徑模式（SDK ADR 0051）是含秘密路徑的完整網址 `wss://<host>/app/<id>`——它等同密碼 */
    relayEndpoint: string;
    /** 私人路徑模式才有：這次部署用的車道 id（等於 `privateLane`） */
    privateLane?: string;
    /** 部署後中繼上的唯讀寬限期（SDK ADR 0052；含保留下來的與這次 `retireLane` 的）。沒有就不出現 */
    readOnlyLanes?: ReadOnlyLane[];
    /** 這次有沒有送 Durable Object 遷移（第一次部署是 true；重新部署是 false） */
    migrationsApplied: boolean;
}
export declare const WORKER_ENTRY_MODULE = "entry.mjs";
export declare const WORKER_RELAY_MODULE = "relay.mjs";
/** 主模組：注入版號後轉出打包好的 Worker 與 `RelayRoom`（與 wrangler 路徑的 `renderWorkerEntry` 同一個做法）。 */
export declare function renderApiWorkerEntry(version: string): string;
export interface MigrationPayload {
    old_tag?: string;
    new_tag: string;
    steps: {
        new_sqlite_classes: string[];
    }[];
}
/**
 * 依已部署 Worker 目前的遷移 tag 決定要送的遷移（與 wrangler 的做法相同）：
 * - 沒有這支 Worker，或它沒有 tag → 送全部，不帶 `old_tag`
 * - tag 是我們的最後一個 → 不送（重新部署）
 * - tag 是我們較早的某一個 → 只送它之後的，帶 `old_tag`
 * - tag 不是我們的 → `undefined` 代表「不是這個 SDK 的中繼」，由呼叫端決定要不要覆蓋
 */
export declare function planMigrations(currentTag: string | undefined): {
    payload?: MigrationPayload;
    foreign: boolean;
};
export interface WorkerMetadata {
    main_module: string;
    compatibility_date: string;
    bindings: ({
        type: 'durable_object_namespace';
        name: string;
        class_name: string;
    } | {
        type: 'plain_text';
        name: string;
        text: string;
    })[];
    /** 儀表板上另外設的 secret（例如 TURN 的 Token）重新部署時保留 */
    keep_bindings: string[];
    observability: {
        enabled: boolean;
    };
    migrations?: MigrationPayload;
}
export declare function buildWorkerMetadata(opts: {
    compatibilityDate: string;
    vars: Record<string, string>;
    migrations?: MigrationPayload;
}): WorkerMetadata;
/**
 * 自己組 multipart/form-data 本文（Obsidian 的 `requestUrl` 不收 `FormData`）：
 * `metadata`（application/json）與每個 ES module（application/javascript+module）。
 */
export declare function buildMultipartBody(parts: {
    name: string;
    contentType: string;
    content: string;
    filename?: string;
}[], boundary?: string): {
    body: Uint8Array<ArrayBuffer>;
    contentType: string;
};
/**
 * 部署一座 Cinderous 中繼到 Cloudflare Workers，全程走 REST API（可在 Obsidian 桌面與行動版執行）。
 * Worker 由呼叫端給（SDK ADR 0094）：只 import 這個函式不會把 117 KB 的 Worker 本體打包進去。
 * 要用 SDK 內嵌的那份就呼叫 `deployCloudflareRelayViaApi`。
 */
export declare function deployCloudflareRelayWithWorker(opts: CloudflareApiDeployOptions & {
    workerSource: string;
}): Promise<CloudflareApiDeployment>;
/**
 * REST 部署之前一次列出所有問題（SDK ADR 0055；CinderSync G20）：Worker 名稱、workers.dev 子網域、相容日期、`retireLane`，
 * 再加上站台參數（`collectRelaySiteIssues(opts, 'worker')`），全部雙語、不丟例外。空陣列＝可以部署。
 * 規則與 `deployCloudflareRelayViaApi` 開頭的檢查相同（它丟第一個錯誤的中文訊息）。不檢查 Token 與帳號（那要連網）。
 */
export declare function collectCloudflareApiDeployIssues(opts: CloudflareApiDeployOptions): DeployIssue[];
/** REST 部署的子步驟（依出現順序；SDK ADR 0055） */
export declare const CLOUDFLARE_DEPLOY_SUBSTEPS: readonly DeploySubstep[];
//# sourceMappingURL=deploy.d.ts.map