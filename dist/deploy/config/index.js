/**
 * `@cinderous/client/deploy/config`（SDK ADR 0050）：部署設定檔 `cinderous.config.json` 的型別、描述表、收集式驗證、
 * JSON Schema、可攜的部署包與依選擇組合的部署說明。
 *
 * 🔴 **不碰 Node**：CLI（`cinderous relay build|deploy --config`、`cinderous config validate`）、未來的網頁設定器（P3）
 * 與 Obsidian 外掛共用同一份。守門測試：tests/deploy/deploy-config-guard.test.ts。
 * 不含打包好的中繼 Worker：`--self-contained` 的部署包由呼叫端傳入 `relayWorkerSource`。
 */
export { DEPLOY_CONFIG_VERSION, DEPLOY_SERVICES, DEPLOY_TARGETS, hostOfTarget, isSecretRef, serviceOfConfig, } from './types.js';
export { dangerConfirmWord, dangerousChoices, DEPLOY_OPTION_SPECS, PUSH_GATEWAY_LIMIT_SPECS, deployOptionSpec, isDangerousValue, SITE_OPTION_KEYS, specAppliesTo, } from './specs.js';
export { deployConfigJsonSchema, renderDeployConfigJsonSchema } from './schema.js';
export { ENV_NAME_PATTERN, findSecretLiterals, PRIVATE_LANE_PLACEHOLDER, READ_ONLY_LANE_PLACEHOLDER, resolveIotGatewayKeys, resolveIotPlaintextDeviceKeys, resolveSecret, resolveSiteSecrets, resolveStringOrSecret, siteWithPlaceholders, } from './secrets.js';
export { assertDeployConfig, compareVersions, DEPLOY_AFFECTING_CHANGES, validateDeployConfig, } from './validate.js';
export { DEPLOY_GUIDE_FILES, DEPLOY_GUIDE_LOCALES, deployEndpoints, renderDeployGuide, SDK_SOURCE_REPO, secretEnvName, } from './guide.js';
export { contentHash, DEPLOY_CONFIG_FILE, GENERATED_MANIFEST, modifiedGeneratedFiles, privateLaneEnvName, readOnlyLanesEnvName, renderDeployConfigFile, renderDeployPackage, } from './package.js';
export { PUSH_GATEWAY_DO, PUSH_GATEWAY_RUNTIME_SECRETS, pushGatewaySecrets, pushGatewayVars, pushSecretEnvName, renderPushGatewayFiles, } from './push-package.js';
export { renderPushGatewayGuide } from './push-guide.js';
// 設定檔遷移（SDK ADR 0118）
export { DEPLOY_CONFIG_MIGRATIONS, migrateDeployConfig, } from './migrate.js';
// 設定檔 → REST 一鍵部署的參數（SDK ADR 0118）
export { cloudflareApiOptionsFromConfig } from './cloudflare-api.js';
export { parseWizardAnswer, runInitWizard, WIZARD_MAX_TRIES, wizardQuestions, } from './wizard.js';
// 網頁部署設定器的模型（SDK ADR 0142）：說明網站的頁面用它；外掛或其他前端也能重用
export { setWebField, WEB_GROUP_LABELS, webBuildCommand, webEstimate, webFieldKind, webFieldText, webFormGroups, webInitialConfig, webOutputs, webSdkSpec, webSwitchTarget, webUnsupportedFields, } from './web.js';
export { collectRelaySiteIssues, generatePrivateLaneId, isPrivateLaneId, PRIVATE_LANE_MIN_LENGTH, privateLaneEndpoint, privateLaneFromUrl, READ_ONLY_GRACE_DAYS, readOnlyLanesVar, } from '../shared.js';
//# sourceMappingURL=index.js.map