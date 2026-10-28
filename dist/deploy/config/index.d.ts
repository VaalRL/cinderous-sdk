/**
 * `@cinderous/client/deploy/config`（SDK ADR 0050）：部署設定檔 `cinderous.config.json` 的型別、描述表、收集式驗證、
 * JSON Schema、可攜的部署包與依選擇組合的部署說明。
 *
 * 🔴 **不碰 Node**：CLI（`cinderous relay build|deploy --config`、`cinderous config validate`）、未來的網頁設定器（P3）
 * 與 Obsidian 外掛共用同一份。守門測試：tests/deploy/deploy-config-guard.test.ts。
 * 不含打包好的中繼 Worker：`--self-contained` 的部署包由呼叫端傳入 `relayWorkerSource`。
 */
export { DEPLOY_CONFIG_VERSION, DEPLOY_SERVICES, DEPLOY_TARGETS, type DeployConfig, type DeploySecrets, type DeploySiteOptions, type DeployService, type DeployTarget, hostOfTarget, isSecretRef, type PushGatewayDeployOptions, type RelayHost, type SecretRef, serviceOfConfig, } from './types.js';
export { dangerConfirmWord, dangerousChoices, DEPLOY_OPTION_SPECS, PUSH_GATEWAY_LIMIT_SPECS, type DeployOptionGroup, type DeployOptionSpec, type DeployOptionType, deployOptionSpec, isDangerousValue, SITE_OPTION_KEYS, specAppliesTo, } from './specs.js';
export { deployConfigJsonSchema, renderDeployConfigJsonSchema } from './schema.js';
export { ENV_NAME_PATTERN, findSecretLiterals, PRIVATE_LANE_PLACEHOLDER, READ_ONLY_LANE_PLACEHOLDER, resolveSecret, resolveSiteSecrets, resolveStringOrSecret, siteWithPlaceholders, } from './secrets.js';
export { assertDeployConfig, compareVersions, DEPLOY_AFFECTING_CHANGES, type DeployConfigValidation, validateDeployConfig, type ValidateDeployConfigOptions, } from './validate.js';
export { DEPLOY_GUIDE_FILES, DEPLOY_GUIDE_LOCALES, type DeployGuideContext, type DeployGuideLocale, deployEndpoints, renderDeployGuide, SDK_SOURCE_REPO, secretEnvName, } from './guide.js';
export { contentHash, DEPLOY_CONFIG_FILE, type DeployPackage, type DeployPackageContext, type DeployPackageFile, type DeployPackageLicense, GENERATED_MANIFEST, type GeneratedManifest, modifiedGeneratedFiles, privateLaneEnvName, readOnlyLanesEnvName, renderDeployConfigFile, renderDeployPackage, } from './package.js';
export { PUSH_GATEWAY_DO, PUSH_GATEWAY_RUNTIME_SECRETS, pushGatewaySecrets, pushGatewayVars, pushSecretEnvName, renderPushGatewayFiles, } from './push-package.js';
export { renderPushGatewayGuide } from './push-guide.js';
export { type DeployAffectingChange, DEPLOY_CONFIG_MIGRATIONS, type DeployConfigMigration, type DeployConfigMigrationResult, migrateDeployConfig, type MigrateDeployConfigOptions, } from './migrate.js';
export { cloudflareApiOptionsFromConfig, type CloudflareApiOptionsFromConfig } from './cloudflare-api.js';
export { type InitWizardOptions, type InitWizardResult, parseWizardAnswer, runInitWizard, type WizardAnswer, type WizardIo, WIZARD_MAX_TRIES, wizardQuestions, } from './wizard.js';
export { collectRelaySiteIssues, type DeployIssue, type DeployIssueSeverity, generatePrivateLaneId, isPrivateLaneId, PRIVATE_LANE_MIN_LENGTH, privateLaneEndpoint, privateLaneFromUrl, READ_ONLY_GRACE_DAYS, type ReadOnlyLane, readOnlyLanesVar, type RelaySiteOptions, } from '../shared.js';
//# sourceMappingURL=index.d.ts.map