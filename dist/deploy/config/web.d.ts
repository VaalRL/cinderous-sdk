import { type ConsumptionSimulationInput, type ResourceEstimationReport, type TargetTier } from '../../estimator.js';
import { type DeployPackageFile } from './package.js';
import { type DeployOptionGroup, type DeployOptionSpec } from './specs.js';
import { type DeployConfig, type DeployTarget } from './types.js';
type Text = {
    readonly 'zh-TW': string;
    readonly en: string;
};
/** 題組的顯示名稱（順序＝表單上的順序） */
export declare const WEB_GROUP_LABELS: Readonly<Record<DeployOptionGroup, Text>>;
export type WebFieldKind = 'checkbox' | 'number' | 'select' | 'list' | 'env-name' | 'text-or-env' | 'text';
export interface WebField {
    spec: DeployOptionSpec;
    kind: WebFieldKind;
    /** 這個目標必填 */
    required: boolean;
    /** 開了就要打字確認（{@link dangerConfirmWord}） */
    dangerous: boolean;
}
export interface WebFieldGroup {
    group: DeployOptionGroup;
    label: Text;
    /** 進階題組：表單上預設收合 */
    advanced: boolean;
    fields: WebField[];
}
/** 欄位用什麼表單元件 */
export declare function webFieldKind(spec: DeployOptionSpec): WebFieldKind;
/** 這個目標的表單：精靈的題目（`advanced` 時連進階題組），依題組分好；目標本身另外選，不在這裡 */
export declare function webFormGroups(target: DeployTarget, advanced: boolean): WebFieldGroup[];
/** 表單不提供的欄位（物件型別：容量設定、贊助管道、IoT 家庭等），要直接改設定檔；頁面照實列出 */
export declare function webUnsupportedFields(target: DeployTarget): DeployOptionSpec[];
/** 新設定的起點：格式版號、SDK 版號、目標 */
export declare function webInitialConfig(target: DeployTarget, sdkVersion: string): Record<string, unknown>;
/**
 * 換部署目標（SDK ADR 0142）：新目標也有的欄位照原值重新套用，新目標沒有的丟掉並回報。
 * 實測發現原本換目標就整份重來，已填的名稱、白名單全清掉。
 * 🔴 危險選項照樣要過確認：`confirmed` 沒有對的確認字就不帶過去（不能藉換目標繞過）。
 */
export declare function webSwitchTarget(config: Record<string, unknown>, target: DeployTarget, confirmed: Readonly<Record<string, string>>): {
    config: Record<string, unknown>;
    dropped: string[];
};
/** 欄位目前的值，轉成表單上顯示的文字（與 {@link setWebField} 收的格式相同）；沒設＝空字串 */
export declare function webFieldText(config: unknown, spec: DeployOptionSpec): string;
export type WebFieldUpdate = {
    ok: true;
    config: Record<string, unknown>;
}
/** `confirmWord`：危險選項還沒確認，要使用者打這個字 */
 | {
    ok: false;
    message: Text;
    confirmWord?: string;
};
/**
 * 改一個欄位：與精靈同一套——空字串＝不設、看不懂或只跟這一欄有關的錯誤當場擋下（不改設定）；
 * 危險選項要 `confirm` 等於 {@link dangerConfirmWord} 才開。跨欄位的錯誤不在這裡擋（由 `validateDeployConfig` 整體列出）。
 */
export declare function setWebField(config: Record<string, unknown>, spec: DeployOptionSpec, raw: string, confirm?: string): WebFieldUpdate;
/** 部署包以這個相依引用 SDK（公開 repo 的 tag；不上 npm，SDK ADR 0110） */
export declare function webSdkSpec(sdkVersion: string): string;
/** 在自己電腦上產生同一份部署包的一行指令（設定檔放在目前目錄、輸出到 deploy/） */
export declare function webBuildCommand(sdkVersion: string, opts?: {
    selfContained?: boolean;
}): string;
export interface WebOutputContext {
    sdkVersion: string;
    /** SDK 的 LICENSE 全文（網站建置時內嵌，不在瀏覽器裡抓） */
    licenseText: string;
    /** Workers：附預打包的中繼（同 `relay build --self-contained`） */
    selfContained?: boolean;
    /** 預打包的中繼 Worker 原始碼（`relayWorkerSource`）；`selfContained` 時必填 */
    relayWorkerSource?: string;
    /** zip 裡檔案的修改時間（預設現在） */
    date?: Date;
}
export interface WebOutputs {
    /** `cinderous.config.json` 的內容 */
    configText: string;
    files: DeployPackageFile[];
    /** 整個部署包的 zip（檔案在 `<name>/` 底下） */
    zip: Uint8Array;
    zipName: string;
    command: string;
}
/** 產出設定檔、部署包與 zip。設定有錯就丟例外（列出全部錯誤）——頁面只在沒有錯誤時讓人下載。 */
export declare function webOutputs(config: DeployConfig, ctx: WebOutputContext): WebOutputs;
export type WebEstimateInput = Pick<ConsumptionSimulationInput, 'devicesCount' | 'collaboratorsCount' | 'dailyActionsCount' | 'averagePayloadBytes'> & Partial<Pick<ConsumptionSimulationInput, 'cryptoMode' | 'postQuantum' | 'p2pSuccessRate'>>;
/** 依部署目標試算（SDK `./estimator`，只在本機算）。輸入不合法回 `error`，不丟例外——表單一邊打一邊算。 */
export declare function webEstimate(target: DeployTarget, input: WebEstimateInput): {
    tier: TargetTier;
    report?: ResourceEstimationReport;
    error?: string;
};
export {};
//# sourceMappingURL=web.d.ts.map