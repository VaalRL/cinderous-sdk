import { type DeployConfig } from './types.js';
/**
 * 私人路徑（SDK ADR 0051）放在哪個環境變數（設定檔 `site.privateLane.$env`）；沒有私人路徑回 undefined。
 * 部署包不含它的值：Workers 以 `wrangler secret put`、Fly 以 `fly secrets set`、compose 從 `.env` 代入。
 */
export declare function privateLaneEnvName(config: DeployConfig): string | undefined;
/**
 * 唯讀寬限期（SDK ADR 0052）放在哪個環境變數（設定檔 `site.readOnlyLanes.$env`）；沒有回 undefined。
 * 部署包不含它的值：Workers 以 `wrangler secret put READONLY_LANES`、Fly 以 `fly secrets set`、compose 從 `.env` 代入（沒設＝沒有）。
 */
export declare function readOnlyLanesEnvName(config: DeployConfig): string | undefined;
/** 部署包裡記錄產生內容的檔案：重新產生前比對，被手改過的檔案先擋下（ADR 0050 §5）。 */
export declare const GENERATED_MANIFEST = ".cinderous-generated";
/** 部署包裡的設定檔名 */
export declare const DEPLOY_CONFIG_FILE = "cinderous.config.json";
export interface DeployPackageContext {
    /** 產生部署包的 SDK 版號：寫進設定檔的 `sdk`、NIP-11 `version`、釘住的相依 */
    sdkVersion: string;
    /** SDK 的 LICENSE 全文（AGPL-3.0）；內嵌或以相依引用 SDK 都要附（ADR 0050 §7） */
    licenseText: string;
    /**
     * SDK 怎麼進到部署包：
     * - `embed`（預設，公開前）：複製到 `sdk/`，以 `file:./sdk` 安裝——由寫檔的一方（CLI）複製，這裡只回報 `copySdk`；
     * - `spec`：以套件相依安裝，例如 `github:VaalRL/cinderous-sdk#v0.84.0`（公開 repo；不上 npm，SDK ADR 0110）。
     */
    sdkSource?: {
        kind: 'embed';
    } | {
        kind: 'spec';
        spec: string;
    };
    /** Workers 目標：附預打包的中繼（`src/relay.mjs`），不需要安裝 SDK。需要 `relayWorkerSource`。 */
    selfContained?: boolean;
    /** 預打包的中繼 Worker 原始碼（`@cinderous/client/deploy/cloudflare-api` 的 `relayWorkerSource`） */
    relayWorkerSource?: string;
}
export type DeployPackageLicense = 'MIT-0' | 'AGPL-3.0-only' | 'text';
export interface DeployPackageFile {
    /** 相對於部署包根目錄、以 `/` 分隔 */
    path: string;
    content: string;
    /** 這個檔案的授權：產生的設定與膠水程式是 MIT-0，SDK 的目的碼是 AGPL，LICENSE 本身是文字 */
    license: DeployPackageLicense;
}
export interface DeployPackage {
    files: DeployPackageFile[];
    /** 寫檔的一方要另外把 SDK（`dist` 與執行用的 package.json）複製到 `sdk/` */
    copySdk: boolean;
}
/** 設定檔依固定的鍵順序寫出（同一份設定 → 同一份文字），並記下產生它的 SDK 版號（`relay build` 與 `cinderous init` 共用） */
export declare function renderDeployConfigFile(config: DeployConfig, sdkVersion?: string): string;
/**
 * 產生部署包（SDK ADR 0050 §5）。先驗證設定（有錯就丟例外，列出全部錯誤）；回傳的內容不含絕對路徑與秘密值，
 * 同一份設定與 ctx → 同一組檔案（逐位元組相同），可以提交、可以 diff。
 */
export declare function renderDeployPackage(config: DeployConfig, ctx: DeployPackageContext): DeployPackage;
/** 檔案內容的 SHA-256（hex）：清單用它判斷檔案有沒有被手改過 */
export declare function contentHash(content: string): string;
export interface GeneratedManifest {
    generator: 'cinderous relay build';
    sdk: string;
    target: string;
    /** 路徑 → SHA-256 */
    files: Record<string, string>;
    /** 內嵌的 SDK 資料夾（整個由產生器管理，不逐檔比對） */
    sdkDir?: string;
}
/**
 * 重新產生前的比對（ADR 0050 §5）：清單裡記錄的檔案，現在的內容跟記錄的雜湊不同＝被手改過。
 * `read(path)` 回傳現在的內容（不存在回 undefined）。回傳被手改過的路徑。
 */
export declare function modifiedGeneratedFiles(manifestText: string, read: (path: string) => string | undefined): string[];
//# sourceMappingURL=package.d.ts.map