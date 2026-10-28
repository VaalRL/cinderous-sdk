// `config migrate`（SDK ADR 0118，完成 ADR 0050 P1 §6）：把舊 SDK 產生的設定檔帶到這一版。
// 純函式、不碰檔案（CLI 與之後的網頁設定器共用）。
import { type DeployIssue, IssueList } from '../shared.js';
import { DEPLOY_CONFIG_VERSION, type DeployConfig } from './types.js';
import { compareVersions, DEPLOY_AFFECTING_CHANGES, validateDeployConfig } from './validate.js';

/** 一步格式遷移：`configVersion` 從 `from` 變成 `to`（一次只升一版） */
export interface DeployConfigMigration {
  from: number;
  to: number;
  'zh-TW': string;
  en: string;
  /** 不能改到輸入的物件；回傳新的物件（`configVersion` 由 `migrateDeployConfig` 寫） */
  migrate: (config: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

/**
 * 格式版本的遷移步驟。`configVersion` 目前只有 1，所以是空的：要改格式時，在這裡加一步、把
 * `DEPLOY_CONFIG_VERSION` 加一，舊檔就能 `config migrate` 過來（ADR 0050 §6）。
 */
export const DEPLOY_CONFIG_MIGRATIONS: readonly DeployConfigMigration[] = [];

export interface MigrateDeployConfigOptions {
  /** 執行中的 SDK 版號：寫進 `sdk`，也用來找中間影響部署的變更 */
  sdkVersion: string;
  /** 以下供測試替換 */
  migrations?: readonly DeployConfigMigration[];
  currentVersion?: number;
}

export type DeployAffectingChange = (typeof DEPLOY_AFFECTING_CHANGES)[number];

export interface DeployConfigMigrationResult {
  /** 沒有 `error`：可以寫回 */
  ok: boolean;
  /** 遷移後的設定（`ok` 為 false 時是輸入的原樣或做到一半的結果，不要寫回） */
  config: DeployConfig;
  /** 原本的 `sdk`（沒有就是 undefined） */
  fromSdk?: string;
  /** 套用的格式遷移 */
  steps: readonly Pick<DeployConfigMigration, 'from' | 'to' | 'zh-TW' | 'en'>[];
  /** `fromSdk`（不含）到 `sdkVersion`（含）之間影響部署的變更；不知道 `fromSdk` 就不列 */
  changes: readonly DeployAffectingChange[];
  /** 跟輸入有沒有不同（沒有就不必寫檔） */
  changed: boolean;
  /** 遷移後 `validateDeployConfig` 的結果，加上遷移本身的錯誤 */
  issues: DeployIssue[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 把設定檔遷移到這一版的 SDK：
 * 1. 依序套用格式遷移（`configVersion` 舊於目前的才需要），缺一步就停；
 * 2. `sdk` 改成 `sdkVersion`（🔴 設定檔由較新的 SDK 或較新的格式產生時拒絕——不降級）；
 * 3. 列出中間影響部署的變更（`DEPLOY_AFFECTING_CHANGES`）；
 * 4. 用 `validateDeployConfig` 驗證結果。
 */
export function migrateDeployConfig(input: unknown, opts: MigrateDeployConfigOptions): DeployConfigMigrationResult {
  const migrations = opts.migrations ?? DEPLOY_CONFIG_MIGRATIONS;
  const current = opts.currentVersion ?? DEPLOY_CONFIG_VERSION;
  const issues = new IssueList();
  const fail = (config: unknown): DeployConfigMigrationResult => ({
    ok: false,
    config: config as DeployConfig,
    steps: [],
    changes: [],
    changed: false,
    issues: issues.issues,
  });

  if (!isPlainObject(input)) {
    issues.error('', 'type', '設定檔必須是 JSON 物件', 'The config must be a JSON object');
    return fail(input);
  }
  const fromSdk = typeof input.sdk === 'string' && input.sdk !== '' ? input.sdk : undefined;
  if (fromSdk !== undefined && compareVersions(fromSdk, opts.sdkVersion) > 0) {
    issues.error(
      'sdk',
      'sdk-newer',
      `這份設定由較新的 SDK（${fromSdk}）產生，這個 CLI 是 ${opts.sdkVersion}：請升級 @cinderous/client，不能往回遷移`,
      `This config was produced by a newer SDK (${fromSdk}); this CLI is ${opts.sdkVersion}. Upgrade @cinderous/client; configs cannot be migrated backwards`,
    );
    return fail(input);
  }
  if (typeof input.configVersion !== 'number' || !Number.isInteger(input.configVersion)) {
    issues.error('configVersion', 'required', `缺少 configVersion（目前是 ${current}）`, `configVersion is missing (currently ${current})`);
    return fail(input);
  }
  let version: number = input.configVersion;
  if (version > current) {
    issues.error(
      'configVersion',
      'unsupported-version',
      `這份設定是第 ${version} 版格式，這個 CLI 只認得到第 ${current} 版：請升級 @cinderous/client`,
      `This config uses format version ${version}; this CLI only understands up to ${current}. Upgrade @cinderous/client`,
    );
    return fail(input);
  }

  let config: Record<string, unknown> = { ...input };
  const steps: DeployConfigMigrationResult['steps'][number][] = [];
  while (version < current) {
    const step = migrations.find((m) => m.from === version);
    if (!step) {
      issues.error(
        'configVersion',
        'no-migration',
        `沒有從第 ${version} 版格式遷移的步驟：請手動改成第 ${current} 版（見 cinderous config schema）`,
        `There is no migration from format version ${version}: update it to version ${current} by hand (see cinderous config schema)`,
      );
      return fail(config);
    }
    config = { ...step.migrate(config), configVersion: step.to };
    steps.push({ from: step.from, to: step.to, 'zh-TW': step['zh-TW'], en: step.en });
    version = step.to;
  }
  config.sdk = opts.sdkVersion;

  const changes =
    fromSdk === undefined
      ? []
      : DEPLOY_AFFECTING_CHANGES.filter((c) => compareVersions(c.version, fromSdk) > 0 && compareVersions(c.version, opts.sdkVersion) <= 0);
  const validation = validateDeployConfig(config, { sdkVersion: opts.sdkVersion });
  const all = [...issues.issues, ...validation.issues];
  return {
    ok: !all.some((issue) => issue.severity === 'error'),
    config: config as unknown as DeployConfig,
    ...(fromSdk !== undefined ? { fromSdk } : {}),
    steps,
    changes,
    changed: steps.length > 0 || fromSdk !== opts.sdkVersion,
    issues: all,
  };
}
