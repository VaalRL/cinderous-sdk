import { type DeployIssue, type RelaySiteOptions } from '../shared.js';
import { type DeploySiteOptions, type SecretRef } from './types.js';
/** 環境變數名稱的形狀（POSIX 慣例；compose 的 `${NAME}` 代入也吃這個形狀） */
export declare const ENV_NAME_PATTERN: RegExp;
/** 從環境讀出秘密；沒有引用時讀 `defaultEnv`。都沒有回 undefined（由呼叫端決定要不要交給工具自己的登入）。 */
export declare function resolveSecret(ref: SecretRef | undefined, env: Readonly<Record<string, string | undefined>>, defaultEnv?: string): string | undefined;
/** 字串或引用（例如 Account ID）：字串原樣、引用從環境讀。 */
export declare function resolveStringOrSecret(value: string | SecretRef | undefined, env: Readonly<Record<string, string | undefined>>, defaultEnv?: string): string | undefined;
/**
 * 私人路徑（SDK ADR 0051）的佔位值：驗證設定檔與產生部署包時用它代替真正的值（部署包不含秘密）。
 * 一個合法的車道 id，產生器會把用到它的變數改寫成從環境讀。
 */
export declare const PRIVATE_LANE_PLACEHOLDER: string;
/** 唯讀寬限期（SDK ADR 0052）的佔位車道 id：與私人路徑的佔位值不同（同一條不能又可寫又唯讀） */
export declare const READ_ONLY_LANE_PLACEHOLDER: string;
/** 設定檔的 `site` → 站台參數，秘密換成佔位值（驗證規則與部署路徑相同、但不需要真的值）。 */
export declare function siteWithPlaceholders(site: DeploySiteOptions | undefined): RelaySiteOptions;
/**
 * 設定檔的 `site` → 站台參數，秘密從環境讀出（`relay deploy --config`）。私人路徑引用了卻沒有值就丟例外（訊息只有變數名稱、沒有值）；
 * 唯讀寬限期沒有值＝沒有唯讀車道，有值但格式不對就丟例外（訊息只有第幾項，不含車道 id）。
 */
export declare function resolveSiteSecrets(site: DeploySiteOptions | undefined, env: Readonly<Record<string, string | undefined>>): RelaySiteOptions;
/**
 * 掃描設定檔裡所有的字串（`$env` 引用除外），找出直接寫進去的秘密（SDK ADR 0050 §4）。
 * 確定是秘密的 → `error`（build 拒絕）；疑似 Token → `warning`（build 照做但提醒）。
 */
export declare function findSecretLiterals(config: unknown): DeployIssue[];
//# sourceMappingURL=secrets.d.ts.map