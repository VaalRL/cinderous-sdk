import type { DeployIssue } from '../shared.js';
import type { DeployGuideLocale } from './guide.js';
import { type DeployOptionSpec } from './specs.js';
import { type DeployConfig, type DeployTarget } from './types.js';
export interface WizardIo {
    /** 問一題，回傳使用者輸入的那一行（直接 Enter＝空字串） */
    ask(question: string): Promise<string>;
    say(line: string): void;
}
export interface InitWizardOptions {
    /** 題目與說明的語言，預設 zh-TW */
    locale?: DeployGuideLocale;
    /** 先選好的目標（`--provider`）；沒給就問 */
    target?: DeployTarget;
    /** 連進階題組（NIP-11、上限、車道、容量、宿主、秘密）也問 */
    advanced?: boolean;
    /** 寫進設定檔的 `sdk`，也拿來做版本比對 */
    sdkVersion?: string;
}
export interface InitWizardResult {
    config: DeployConfig;
    /** 問完之後 `validateDeployConfig` 的結果（可能還有提醒，或重問之後仍然存在的錯誤） */
    issues: DeployIssue[];
}
/** 同一題最多問幾次（不互動模式每題都回空字串，必填題不能無限重問） */
export declare const WIZARD_MAX_TRIES = 3;
type Text = {
    readonly 'zh-TW': string;
    readonly en: string;
};
/** 這個目標要問哪些題（依描述表的順序） */
export declare function wizardQuestions(target: DeployTarget, advanced?: boolean): DeployOptionSpec[];
export type WizardAnswer = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    message: Text;
};
/**
 * 把輸入的一行轉成這個欄位的值：空字串＝不設（用預設）。這裡只處理「看得懂嗎」，範圍與格式交給 `validateDeployConfig`。
 * 秘密欄位收的是**環境變數的名稱**，不是值（ADR 0050 §4）；`string-or-secret-ref` 用 `$env:NAME` 表示環境變數。
 */
export declare function parseWizardAnswer(spec: DeployOptionSpec, raw: string): WizardAnswer;
/**
 * 逐題問完，回傳設定與驗證結果（不寫檔）。
 * - 看不懂或只跟這一題有關的錯誤：當場重問，最多 {@link WIZARD_MAX_TRIES} 次，之後丟錯。
 * - 跨欄位的錯誤：先提醒，問完一輪再回頭重問那些題（一次）。
 * - 危險選項（描述表的 `dangerous`）：印出說明，要打 {@link dangerConfirmWord} 才開；打錯或直接 Enter＝不開。
 */
export declare function runInitWizard(io: WizardIo, opts?: InitWizardOptions): Promise<InitWizardResult>;
export {};
//# sourceMappingURL=wizard.d.ts.map