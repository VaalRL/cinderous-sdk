import { type CommandRunner, type DeployStep } from './common.js';
import { type RelaySiteOptions } from './shared.js';
export { DEFAULT_COMPATIBILITY_DATE, DEFAULT_WORKER_NAME } from './shared.js';
export { renderWorkerEntry, renderWranglerToml } from './render.js';
export { type CommandRunner, defaultRunner, type DeployStep } from './common.js';
/**
 * 站台參數（白名單、站名、已知租戶車道、防濫用、保存期、檔案塊……）見 `RelaySiteOptions`（SDK ADR 0036、0037），
 * 與 REST 路徑、docker、fly 共用同一份驗證。
 */
export interface CloudflareDeployOptions extends RelaySiteOptions {
    /** Worker 名稱，也是 workers.dev 網址的第一段。預設 `cinderous-relay`。 */
    workerName?: string;
    /** Cloudflare API Token；沒給就交給 wrangler 自己的登入狀態（`wrangler login`）。 */
    apiToken?: string;
    /** Cloudflare Account ID。🔴 有多個帳號時務必給：wrangler 會沿用上次登入的帳號。 */
    accountId?: string;
    compatibilityDate?: string;
    /** 設定檔寫在哪裡。預設 `<cwd>/.cinderous/<workerName>`。 */
    workDir?: string;
    /** 只打包不上傳（`wrangler deploy --dry-run`）。 */
    dryRun?: boolean;
    onProgress?: (status: {
        step: DeployStep;
        message: string;
    }) => void;
    /** 以下供測試或特殊環境替換 */
    run?: CommandRunner;
    fetch?: typeof fetch;
    sdkDistDir?: string;
    version?: string;
    healthRetries?: number;
    healthDelayMs?: number;
}
export interface CloudflareDeployment {
    workerName: string;
    configPath: string;
    /** `https://<name>.<subdomain>.workers.dev`；dryRun 時沒有 */
    httpUrl?: string;
    /** 給客戶端連的 `wss://` 端點；dryRun 時沒有 */
    relayEndpoint?: string;
}
/** 從 `wrangler deploy` 的輸出抓出 workers.dev 網址。 */
export declare function workersDevUrlFrom(output: string): string | undefined;
/** 部署一座 Cinderous 中繼到 Cloudflare Workers（PRD 5.3.4 的程式化 API）。 */
export declare function deployCloudflareRelay(opts?: CloudflareDeployOptions): Promise<CloudflareDeployment>;
//# sourceMappingURL=cloudflare.d.ts.map