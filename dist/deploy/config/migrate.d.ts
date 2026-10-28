import { type DeployIssue } from '../shared.js';
import { type DeployConfig } from './types.js';
import { DEPLOY_AFFECTING_CHANGES } from './validate.js';
/** 一步格式遷移：`configVersion` 從 `from` 變成 `to`（一次只升一版） */
export interface DeployConfigMigration {
    from: number;
    to: number;
    'zh-TW': string;
    en: string;
    /** 不能改到輸入的物件；回傳新的物件（`configVersion` 由 `migrateDeployConfig` 寫） */
    migrate: (config: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}
/**
 * 格式版本的遷移步驟。`configVersion` 目前只有 1，所以是空的：要改格式時，在這裡加一步、把
 * `DEPLOY_CONFIG_VERSION` 加一，舊檔就能 `config migrate` 過來（ADR 0050 §6）。
 */
export declare const DEPLOY_CONFIG_MIGRATIONS: readonly DeployConfigMigration[];
export interface MigrateDeployConfigOptions {
    /** 執行中的 SDK 版號：寫進 `sdk`，也用來找中間影響部署的變更 */
    sdkVersion: string;
    /** 以下供測試替換 */
    migrations?: readonly DeployConfigMigration[];
    currentVersion?: number;
}
export type DeployAffectingChange = (typeof DEPLOY_AFFECTING_CHANGES)[number];
export interface DeployConfigMigrationResult {
    /** 沒有 `error`：可以寫回 */
    ok: boolean;
    /** 遷移後的設定（`ok` 為 false 時是輸入的原樣或做到一半的結果，不要寫回） */
    config: DeployConfig;
    /** 原本的 `sdk`（沒有就是 undefined） */
    fromSdk?: string;
    /** 套用的格式遷移 */
    steps: readonly Pick<DeployConfigMigration, 'from' | 'to' | 'zh-TW' | 'en'>[];
    /** `fromSdk`（不含）到 `sdkVersion`（含）之間影響部署的變更；不知道 `fromSdk` 就不列 */
    changes: readonly DeployAffectingChange[];
    /** 跟輸入有沒有不同（沒有就不必寫檔） */
    changed: boolean;
    /** 遷移後 `validateDeployConfig` 的結果，加上遷移本身的錯誤 */
    issues: DeployIssue[];
}
/**
 * 把設定檔遷移到這一版的 SDK：
 * 1. 依序套用格式遷移（`configVersion` 舊於目前的才需要），缺一步就停；
 * 2. `sdk` 改成 `sdkVersion`（🔴 設定檔由較新的 SDK 或較新的格式產生時拒絕——不降級）；
 * 3. 列出中間影響部署的變更（`DEPLOY_AFFECTING_CHANGES`）；
 * 4. 用 `validateDeployConfig` 驗證結果。
 */
export declare function migrateDeployConfig(input: unknown, opts: MigrateDeployConfigOptions): DeployConfigMigrationResult;
//# sourceMappingURL=migrate.d.ts.map