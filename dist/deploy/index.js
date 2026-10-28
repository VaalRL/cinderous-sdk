/**
 * `@cinderous/client/deploy`（SDK ADR 0008、0018、0050）：部署到 Cloudflare Workers、這台機器的 Docker、Fly.io，
 * 或家中主機＋Cloudflare Tunnel；`buildRelayPackage` 依 `cinderous.config.json` 產生可攜的部署包。
 * Node／CLI 用（引用 `node:fs`、`node:child_process`）；外掛請用 `./deploy/config` 與 `./deploy/cloudflare-api`。
 */
export * from './cloudflare.js';
export { assertRelayName, sdkVersion, waitForHealthy } from './common.js';
export { buildRelayPackage } from './build.js';
export { CONTAINER_DB_PATH, CONTAINER_PORT, copySdkRuntime, prepareNodeRelayContext, relayEnvironment, renderDockerfile, renderServerEntry, } from './container.js';
export { DEFAULT_CLOUDFLARED_IMAGE, renderDockerignore } from './render.js';
// 設定檔驅動的部署（SDK ADR 0050）：不碰 Node 的部分在 ./deploy/config，這裡一併轉出
export * from './config/index.js';
export * from './docker.js';
export * from './fly.js';
export { assertCompatibilityDate, collectRelaySiteIssues, generatePrivateLaneId, isPrivateLaneId, laneListVar, maxFileMbVar, PRIVATE_LANE_MIN_LENGTH, privateLaneEndpoint, privateLaneFromUrl, RELAY_SITE_LIMITS, relaySiteVars, relayWorkerSecrets, relayWorkerVars, VAULT_SYNC_MAX_FILE_MB, WORKER_ONLY_SITE_OPTIONS, } from './shared.js';
// 帳號儲存預算的守門工具（SDK ADR 0042）：部署者把它放進自己的測試
export { ACCOUNT_STORAGE_BUDGET_BYTES, computeCeilingBudget } from '../relay/host-config.js';
//# sourceMappingURL=index.js.map