import type { DeployIssue } from './shared.js';
export interface BuildRelayPackageOptions {
    /** 剛 `JSON.parse` 出來的設定（會先驗證） */
    config: unknown;
    /** 設定檔的路徑：輸出目錄裡的 `cinderous.config.json` 就是它時，允許以正規化後的內容覆寫 */
    configPath?: string;
    outDir: string;
    /** Workers：附預打包的中繼（`src/relay.mjs`），不需要安裝 SDK */
    selfContained?: boolean;
    /** SDK 改以套件相依安裝（例如 `github:VaalRL/cinderous-sdk#v0.83.1`），不內嵌 `sdk/` */
    sdkSpec?: string;
    /** 覆寫被手改過、或不是 relay build 產生的檔案 */
    force?: boolean;
    /** 以下供測試替換 */
    sdkRoot?: string;
    version?: string;
    relayWorkerSource?: string;
}
export interface RelayPackageBuild {
    outDir: string;
    /** 寫出的檔案（相對路徑；不含 `sdk/` 底下） */
    files: string[];
    /** 移除的舊檔（上一次產生、這次不再需要，而且沒被手改過） */
    removed: string[];
    copiedSdk: boolean;
    /** 驗證的提醒（例如開放中繼、疑似 Token） */
    warnings: DeployIssue[];
}
/**
 * 產生可攜的部署包（SDK ADR 0050 §5）。設定有錯就丟例外（列出全部錯誤），什麼都不寫。
 * 🔴 重新產生前比對上一次的清單（`.cinderous-generated`）：被手改過的產生檔案、或輸出目錄裡同名但不是產生的檔案，
 * 沒加 `force` 就拒絕——不默默蓋掉別人的修改。
 */
export declare function buildRelayPackage(opts: BuildRelayPackageOptions): Promise<RelayPackageBuild>;
//# sourceMappingURL=build.d.ts.map