/**
 * `@cinderous/client/deploy/config`（SDK ADR 0050）：部署設定檔 `cinderous.config.json` 的型別、描述表、收集式驗證、
 * JSON Schema、可攜的部署包與依選擇組合的部署說明。
 *
 * 🔴 **不碰 Node**：CLI（`cinderous relay build|deploy --config`、`cinderous config validate`）、未來的網頁設定器（P3）
 * 與 Obsidian 外掛共用同一份。守門測試：tests/deploy/deploy-config-guard.test.ts。
 * 不含打包好的中繼 Worker：`--self-contained` 的部署包由呼叫端傳入 `relayWorkerSource`。
 */
export { DEPLOY_CONFIG_VERSION, DEPLOY_SERVICES, DEPLOY_TARGETS, hostOfTarget, isSecretRef, serviceOfConfig, } from './types.js';
export { DEPLOY_OPTION_SPECS, PUSH_GATEWAY_LIMIT_SPECS, deployOptionSpec, SITE_OPTION_KEYS, specAppliesTo, } from './specs.js';
export { deployConfigJsonSchema, renderDeployConfigJsonSchema } from './schema.js';
export { ENV_NAME_PATTERN, findSecretLiterals, PRIVATE_LANE_PLACEHOLDER, READ_ONLY_LANE_PLACEHOLDER, resolveSecret, resolveSiteSecrets, resolveStringOrSecret, siteWithPlaceholders, } from './secrets.js';
export { assertDeployConfig, compareVersions, DEPLOY_AFFECTING_CHANGES, validateDeployConfig, } from './validate.js';
export { DEPLOY_GUIDE_FILES, DEPLOY_GUIDE_LOCALES, deployEndpoints, renderDeployGuide, SDK_SOURCE_REPO, secretEnvName, } from './guide.js';
export { contentHash, DEPLOY_CONFIG_FILE, GENERATED_MANIFEST, modifiedGeneratedFiles, privateLaneEnvName, readOnlyLanesEnvName, renderDeployPackage, } from './package.js';
export { PUSH_GATEWAY_DO, PUSH_GATEWAY_RUNTIME_SECRETS, pushGatewaySecrets, pushGatewayVars, pushSecretEnvName, renderPushGatewayFiles, } from './push-package.js';
export { renderPushGatewayGuide } from './push-guide.js';
export { collectRelaySiteIssues, generatePrivateLaneId, isPrivateLaneId, PRIVATE_LANE_MIN_LENGTH, privateLaneEndpoint, privateLaneFromUrl, READ_ONLY_GRACE_DAYS, readOnlyLanesVar, } from '../shared.js';
//# sourceMappingURL=index.js.map