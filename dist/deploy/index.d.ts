/**
 * `@cinderous/client/deploy`（SDK ADR 0008、0018、0050）：部署到 Cloudflare Workers、這台機器的 Docker、Fly.io，
 * 或家中主機＋Cloudflare Tunnel；`buildRelayPackage` 依 `cinderous.config.json` 產生可攜的部署包。
 * Node／CLI 用（引用 `node:fs`、`node:child_process`）；外掛請用 `./deploy/config` 與 `./deploy/cloudflare-api`。
 */
export * from './cloudflare.js';
export { assertRelayName, type DeployProgress, type RelayDeployment, sdkVersion, waitForHealthy } from './common.js';
export { buildRelayPackage, type BuildRelayPackageOptions, type RelayPackageBuild } from './build.js';
export { CONTAINER_DB_PATH, CONTAINER_PORT, copySdkRuntime, prepareNodeRelayContext, relayEnvironment, renderDockerfile, renderServerEntry, } from './container.js';
export { DEFAULT_CLOUDFLARED_IMAGE, renderDockerignore } from './render.js';
export * from './config/index.js';
export * from './docker.js';
export * from './fly.js';
export { assertCompatibilityDate, collectRelaySiteIssues, type DeployIssue, type DeployIssueSeverity, generatePrivateLaneId, iotGatewayKeysSecret, isPrivateLaneId, laneListVar, maxFileMbVar, PRIVATE_LANE_MIN_LENGTH, privateLaneEndpoint, privateLaneFromUrl, type RelayDonationOptions, type RelayFileOptions, RELAY_SITE_LIMITS, type RelaySiteOptions, relaySiteVars, type RelayWorkerSecrets, relayWorkerSecrets, relayWorkerVars, VAULT_SYNC_MAX_FILE_MB, WORKER_ONLY_SITE_OPTIONS, } from './shared.js';
export { ACCOUNT_STORAGE_BUDGET_BYTES, computeCeilingBudget, type CeilingRow, type DoCapacity } from '../relay/host-config.js';
//# sourceMappingURL=index.d.ts.map