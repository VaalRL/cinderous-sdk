// 設定檔 → REST 一鍵部署的參數（SDK ADR 0118）：外掛與 CLI 的 `relay deploy --config` 用同一份。
// 只有型別依賴 REST 部署本體（不會把它或打包好的 Worker 拉進 ./deploy/config）。
import type { CloudflareApiDeployOptions } from '../cloudflare-api/deploy.js';
import { resolveSecret, resolveSiteSecrets, resolveStringOrSecret } from './secrets.js';
import { secretEnvName } from './guide.js';
import { type DeployConfig, serviceOfConfig } from './types.js';

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
export function cloudflareApiOptionsFromConfig(
  config: DeployConfig,
  env: Readonly<Record<string, string | undefined>>,
): CloudflareApiOptionsFromConfig {
  if (config.target !== 'cloudflare-api') {
    throw new Error(`cloudflareApiOptionsFromConfig 只接受 cloudflare-api 目標（這份是 ${config.target}）`);
  }
  if (serviceOfConfig(config) !== 'relay') {
    throw new Error('REST 部署只有中繼：推播閘道請用 cloudflare（wrangler）目標');
  }
  const tokenEnv = secretEnvName(config, 'cloudflareApiToken');
  const apiToken = resolveSecret(config.secrets?.cloudflareApiToken, env, tokenEnv);
  if (apiToken === undefined) {
    throw new Error(`找不到 Cloudflare API Token：請在環境變數或設定檔旁邊的 .env 設定 ${tokenEnv}（REST 部署不能用 wrangler login）`);
  }
  const options: CloudflareApiOptionsFromConfig = { apiToken };
  const accountId = resolveStringOrSecret(config.cloudflare?.accountId, env, 'CLOUDFLARE_ACCOUNT_ID');
  if (accountId !== undefined) options.accountId = accountId;
  if (config.name !== undefined) options.workerName = config.name;
  if (config.cloudflare?.compatibilityDate !== undefined) options.compatibilityDate = config.cloudflare.compatibilityDate;
  if (config.cloudflare?.workersDevSubdomain !== undefined) options.workersDevSubdomain = config.cloudflare.workersDevSubdomain;
  Object.assign(options, resolveSiteSecrets(config.site, env));
  const turnApiToken = resolveSecret(config.secrets?.turnApiToken, env, secretEnvName(config, 'turnApiToken'));
  if (turnApiToken !== undefined) options.turnApiToken = turnApiToken;
  return options;
}
