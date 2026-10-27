import { type DeployIssue } from '../shared.js';
import { type DeployConfig } from './types.js';
export interface ValidateDeployConfigOptions {
    /** 執行中的 SDK／CLI 版號：與設定檔的 `sdk` 比對（ADR 0050 §6）。沒給＝不比對。 */
    sdkVersion?: string;
    /**
     * false＝不驗證站台參數（`relay deploy` 的旗標路徑：站台參數照舊交給部署函式驗證，行為與 v0.37 相同）。預設 true。
     */
    checkSite?: boolean;
}
export interface DeployConfigValidation {
    /** 沒有 `error`（可以有 `warning`） */
    ok: boolean;
    issues: DeployIssue[];
}
/**
 * 影響部署的變更（ADR 0050 §6）：設定檔是舊版 SDK 產生的，CLI 列出這幾版之間要注意的事。
 * 只收「重新部署時行為會變」或「要多設一項才會動」的變更。
 */
export declare const DEPLOY_AFFECTING_CHANGES: readonly {
    version: string;
    adr: string;
    'zh-TW': string;
    en: string;
}[];
/** 比較 x.y.z（預發行標記忽略）：a < b 回負數 */
export declare function compareVersions(a: string, b: string): number;
/**
 * 驗證 `cinderous.config.json`（SDK ADR 0050 §3）：回傳**全部**問題，不丟例外。`ok`＝沒有 `error`。
 * 接受任何值（剛 `JSON.parse` 出來的東西），所以 UI 可以在使用者每改一欄就重新驗證。
 */
export declare function validateDeployConfig(input: unknown, opts?: ValidateDeployConfigOptions): DeployConfigValidation;
/** 驗證後轉型；有錯就丟例外（訊息列出全部錯誤，繁中）。給已經確定要用這份設定的呼叫端。 */
export declare function assertDeployConfig(input: unknown, opts?: ValidateDeployConfigOptions): DeployConfig;
//# sourceMappingURL=validate.d.ts.map