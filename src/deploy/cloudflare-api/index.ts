/**
 * `@cinderous/client/deploy/cloudflare-api`（SDK ADR 0021）：以 Cloudflare REST API 一鍵部署中繼。
 *
 * 不需要 Node、不需要 wrangler：Obsidian 外掛的桌面版與行動版都能用。HTTP 由呼叫端注入。
 * 🔴 這個入口的模組圖裡不得有任何 Node 內建模組（守門測試：tests/deploy/cloudflare-api-guard.test.ts）。
 * 內含打包好的中繼 Worker（約 60KB），只有匯入這個子路徑才會帶進打包結果。
 */
export {
  buildTokenCreationUrl,
  type CloudflareApiAuth,
  DEFAULT_TOKEN_NAME,
  listAccounts,
  REQUIRED_TOKEN_PERMISSIONS,
  type TokenPermission,
  type TokenStatus,
  verifyToken,
} from './auth.js';
export {
  buildMultipartBody,
  buildWorkerMetadata,
  type CloudflareApiDeployment,
  type CloudflareApiDeployOptions,
  CLOUDFLARE_DEPLOY_SUBSTEPS,
  collectCloudflareApiDeployIssues,
  deployCloudflareRelayWithWorker,
  type MigrationPayload,
  planMigrations,
  renderApiWorkerEntry,
  WORKER_ENTRY_MODULE,
  WORKER_RELAY_MODULE,
  type WorkerMetadata,
} from './deploy.js';
export {
  buildCloudflareTokenSetupGuide,
  CLOUDFLARE_TOKEN_SETUP_GUIDE,
  DEFAULT_GUIDE_APP_NAME,
  TOKEN_GUIDE_LOCALES,
  type TokenGuideLocale,
  type TokenGuideStep,
  type TokenGuideStepId,
  type TokenGuideTroubleshooting,
  type TokenSetupGuide,
} from './guide.js';
export {
  classifyCloudflareError,
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_ERROR_KINDS,
  type CloudflareAccount,
  CloudflareApiError,
  type CloudflareErrorKind,
  type HttpFetch,
  type HttpRequestInit,
  type HttpResponseLike,
} from './http.js';
export {
  buildOAuthAuthorizationUrl,
  CLOUDFLARE_OAUTH_AUTHORIZE_URL,
  CLOUDFLARE_OAUTH_TOKEN_URL,
  createOAuthState,
  createPkcePair,
  exchangeOAuthCode,
  type OAuthClientConfig,
  type OAuthTokens,
  refreshOAuthToken,
} from './oauth.js';
export { relayWorkerSource } from './relay-worker-bundle.js';
export { relayWorkerSdkVersion, relayWorkerSha256 } from './relay-worker-info.js';
// 內嵌 Worker 的部署（舊介面）與部署時才下載 Worker（SDK ADR 0094）：沒用到的那一邊會被打包工具剔除（sideEffects: false）
export { deployCloudflareRelayViaApi } from './deploy-embedded.js';
export { fetchRelayWorker, type FetchRelayWorkerOptions } from './worker-download.js';
export {
  assertCompatibilityDate,
  collectRelaySiteIssues,
  type DeployIssue,
  type DeployIssueSeverity,
  assertRelayName,
  checkCompatibilityDate,
  checkRelayName,
  DEFAULT_COMPATIBILITY_DATE,
  DEFAULT_WORKER_NAME,
  type DeployProgress,
  type DeployProgressStatus,
  type DeployStep,
  type DeploySubstep,
  generatePrivateLaneId,
  isPrivateLaneId,
  laneListVar,
  maxFileMbVar,
  PRIVATE_LANE_MIN_LENGTH,
  privateLaneEndpoint,
  privateLaneFromUrl,
  READ_ONLY_GRACE_DAYS,
  type ReadOnlyLane,
  readOnlyLanesVar,
  type RelayDonationOptions,
  type RelayFileOptions,
  RELAY_SITE_LIMITS,
  type RelaySiteOptions,
  relaySiteVars,
  type RelayWorkerSecrets,
  relayWorkerSecrets,
  relayWorkerVars,
  VAULT_SYNC_MAX_FILE_MB,
  waitForHealthy,
  WORKER_ONLY_SITE_OPTIONS,
} from '../shared.js';
// 帳號儲存預算的守門工具（SDK ADR 0042）：部署者把它放進自己的測試
export { ACCOUNT_STORAGE_BUDGET_BYTES, computeCeilingBudget, type CeilingRow, type DoCapacity } from '../../relay/host-config.js';
