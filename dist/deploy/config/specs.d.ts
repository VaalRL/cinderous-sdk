import { type RelaySiteOptions } from '../shared.js';
import { type DeployConfig, type DeployService, type DeployTarget, type RelayHost } from './types.js';
/** 值的型別（決定驗證、JSON Schema 與表單元件） */
export type DeployOptionType = 'string' | 'integer' | 'boolean' | 'enum' | 'string-list' | 'pubkey' | 'pubkey-list' | 'https-url' | 'secret-ref' | 'string-or-secret-ref' | 'record';
/** 精靈的題組（P1 `cinderous init` 依它分組；只有 `basic`、`access`、`vault` 會在不進「進階」時詢問） */
export type DeployOptionGroup = 'basic' | 'access' | 'vault' | 'nip11' | 'limits' | 'lanes' | 'capacity' | 'host' | 'secrets' | 'push';
export interface DeployOptionSpec {
    /** 在設定檔裡的路徑，例如 `site.maxTtlDays` */
    path: string;
    type: DeployOptionType;
    enum?: readonly string[];
    range?: {
        readonly min: number;
        readonly max: number;
    };
    maxLength?: number;
    maxItems?: number;
    /** 字串（或清單每一項）要符合的正規表示式 */
    pattern?: RegExp;
    default?: string | number | boolean;
    /** 只有這些宿主支援（站台參數）；沒給＝兩種都支援 */
    hosts?: readonly RelayHost[];
    /** 只有這些目標用得到；沒給＝全部 */
    targets?: readonly DeployTarget[];
    /** 只有這些服務用得到（`relay`、`push-gateway`）；沒給＝兩種都用 */
    services?: readonly DeployService[];
    /** 某些目標必填 */
    requiredFor?: readonly DeployTarget[];
    /** 秘密：設定檔只能放 `{ "$env": "NAME" }` */
    secret?: boolean;
    /** 秘密沒給時讀的環境變數 */
    defaultEnv?: string;
    /** `cinderous relay deploy` 對應的旗標（不含 `--`）；沒有＝只能寫在設定檔 */
    flag?: string;
    /** 中繼讀的環境變數 */
    env?: string;
    group: DeployOptionGroup;
    /** 危險選項：P1 精靈要打字確認；說明裡列進安全檢查清單 */
    dangerous?: boolean;
    /** `record` 型別的 JSON Schema（其他型別由描述自動推出） */
    schema?: Readonly<Record<string, unknown>>;
    description: {
        readonly 'zh-TW': string;
        readonly en: string;
    };
}
/**
 * 推播閘道的上限（ADR 0049 §11.1 裁示 7）：與 `@cinderous/client/iot` 的 `IOT_PUSH_LIMITS` 相同的數字
 *（這個模組不能引用 `./iot`——部署設定器不帶進 IoT 程式；測試比對兩者一致）。
 */
export declare const PUSH_GATEWAY_LIMIT_SPECS: {
    readonly tokenPerHour: {
        readonly min: 1;
        readonly max: 3600;
        readonly default: 60;
    };
    readonly tokenPerMinute: {
        readonly min: 1;
        readonly max: 60;
        readonly default: 6;
    };
    readonly maxSkewSec: {
        readonly min: 30;
        readonly max: 3600;
        readonly default: 300;
    };
    readonly maxRegistrationDays: {
        readonly min: 1;
        readonly max: 30;
        readonly default: 30;
    };
};
/**
 * `pushGateway.ios` 沒寫時的值（SDK ADR 0062：v0.48.0 起是直連 APNs）。部署設定器不引用 `./iot`，
 * 由測試比對執行期的 `DEFAULT_PUSH_GATEWAY_IOS_MODE`。
 */
export declare const DEFAULT_PUSH_GATEWAY_IOS: "apns";
/** 所有設定欄位的描述表（SDK ADR 0050 §3）。站台參數在 `site.` 之下，順序與 {@link RelaySiteOptions} 的宣告相同。 */
export declare const DEPLOY_OPTION_SPECS: readonly DeployOptionSpec[];
/** 站台參數的鍵（＝ `RelaySiteOptions` 的鍵；測試比對 `WORKER_ONLY_SITE_OPTIONS` 與描述表的 `hosts`）。 */
export declare const SITE_OPTION_KEYS: readonly (keyof RelaySiteOptions)[];
export declare function deployOptionSpec(path: string): DeployOptionSpec | undefined;
/** 這個目標適用嗎（站台參數另看宿主） */
export declare function specAppliesTo(spec: DeployOptionSpec, target: DeployTarget, host: RelayHost): boolean;
/** 這個值是不是「開了危險選項」：布林 true、數字大於預設、清單不是空的；目標強制的值不算 */
export declare function isDangerousValue(spec: DeployOptionSpec, value: unknown, target: DeployTarget): boolean;
/** 設定裡開了哪些危險選項（部署說明的安全檢查清單、精靈的確認都看它） */
export declare function dangerousChoices(config: DeployConfig): DeployOptionSpec[];
/** 開危險選項要打的字：欄位名稱的最後一段（`site.openFileRelay` → `openFileRelay`） */
export declare function dangerConfirmWord(spec: DeployOptionSpec): string;
//# sourceMappingURL=specs.d.ts.map