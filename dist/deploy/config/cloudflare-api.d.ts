import type { CloudflareApiDeployOptions } from '../cloudflare-api/deploy.js';
import { type DeployConfig } from './types.js';
/** `cloudflareApiOptionsFromConfig` 的結果：`fetch`、`onProgress`、`workerSource` 由呼叫端自己加 */
export type CloudflareApiOptionsFromConfig = Omit<CloudflareApiDeployOptions, 'fetch' | 'onProgress' | 'workerSource'>;
/**
 * `cloudflare-api` 目標的設定檔 → `deployCloudflareRelayViaApi` 的參數。秘密在這裡才從 `env` 讀
 * （`$env` 引用；沒有引用時讀 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`TURN_API_TOKEN`）。
 *
 * - 沒有 Cloudflare API Token 就丟例外（REST 路徑沒有 `wrangler login` 可以退回）。🔴 訊息只有變數名稱，不含任何值。
 * - 沒有 TURN 的 Token：不帶 `turnApiToken`，線上已經有的 secret 照舊保留。
 * - 設定檔要先用 `validateDeployConfig` 驗過；這裡不重複驗證站台參數（部署函式會驗）。
 */
export declare function cloudflareApiOptionsFromConfig(config: DeployConfig, env: Readonly<Record<string, string | undefined>>): CloudflareApiOptionsFromConfig;
//# sourceMappingURL=cloudflare-api.d.ts.map