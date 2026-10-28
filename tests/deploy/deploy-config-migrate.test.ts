// `config migrate`（SDK ADR 0118，完成 ADR 0050 P1）：把舊 SDK 產生的設定檔帶到這一版。
// 純函式：不碰檔案；格式版本的遷移步驟登記在 DEPLOY_CONFIG_MIGRATIONS（v1 還沒有任何一步）。
import { describe, expect, it } from 'vitest';

import {
  DEPLOY_AFFECTING_CHANGES,
  DEPLOY_CONFIG_MIGRATIONS,
  DEPLOY_CONFIG_VERSION,
  type DeployConfigMigration,
  migrateDeployConfig,
} from '../../src/deploy/config/index.js';

const SDK = '0.79.0';

describe('migrateDeployConfig', () => {
  it('v1 沒有格式遷移；只把 sdk 換成這一版，並列出中間影響部署的變更', () => {
    expect(DEPLOY_CONFIG_MIGRATIONS).toEqual([]);
    const result = migrateDeployConfig({ configVersion: 1, target: 'docker', sdk: '0.33.0' }, { sdkVersion: SDK });
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({ configVersion: 1, target: 'docker', sdk: SDK });
    expect(result.fromSdk).toBe('0.33.0');
    expect(result.steps).toEqual([]);
    const expected = DEPLOY_AFFECTING_CHANGES.filter((c) => c.version === '0.34.0' || c.version === '0.38.0').map((c) => c.version);
    for (const version of expected) expect(result.changes.map((c) => c.version)).toContain(version);
    expect(result.changes.map((c) => c.version)).not.toContain('0.31.0');
    expect(result.changed).toBe(true);
  });

  it('已經是這一版：沒有變更（changed false）', () => {
    const result = migrateDeployConfig({ configVersion: 1, target: 'docker', sdk: SDK }, { sdkVersion: SDK });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it('沒有 sdk 欄位：補上這一版；不知道從哪一版來，所以不列變更', () => {
    const result = migrateDeployConfig({ configVersion: 1, target: 'docker' }, { sdkVersion: SDK });
    expect(result.config.sdk).toBe(SDK);
    expect(result.fromSdk).toBeUndefined();
    expect(result.changes).toEqual([]);
    expect(result.changed).toBe(true);
  });

  it('🔴 較新的 SDK 或較新的格式版本產生的 → 拒絕（不降級，不改檔）', () => {
    const newerSdk = migrateDeployConfig({ configVersion: 1, target: 'docker', sdk: '9.0.0' }, { sdkVersion: SDK });
    expect(newerSdk.ok).toBe(false);
    expect(newerSdk.issues.map((i) => i.code)).toContain('sdk-newer');
    const newerFormat = migrateDeployConfig({ configVersion: DEPLOY_CONFIG_VERSION + 1, target: 'docker' }, { sdkVersion: SDK });
    expect(newerFormat.ok).toBe(false);
    expect(newerFormat.issues.map((i) => i.code)).toContain('unsupported-version');
  });

  it('不是物件、沒有 configVersion → 拒絕', () => {
    expect(migrateDeployConfig([], { sdkVersion: SDK }).ok).toBe(false);
    expect(migrateDeployConfig({ target: 'docker' }, { sdkVersion: SDK }).issues.map((i) => i.code)).toContain('required');
  });

  it('遷移後還有錯（例如不認得的鍵）：照實回報，ok false', () => {
    const result = migrateDeployConfig({ configVersion: 1, target: 'docker', node: { prot: 1 } }, { sdkVersion: SDK });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'node.prot')).toBe(true);
  });

  it('格式遷移依序套用（以注入的遷移步驟測），不改到輸入的物件', () => {
    const migrations: DeployConfigMigration[] = [
      {
        from: 0,
        to: 1,
        'zh-TW': 'relayName 搬到 site',
        en: 'relayName moved into site',
        migrate: (config) => {
          const { relayName, ...rest } = config;
          return { ...rest, site: { relayName } };
        },
      },
    ];
    const input = { configVersion: 0, target: 'docker', relayName: 'Mine' };
    const result = migrateDeployConfig(input, { sdkVersion: SDK, migrations, currentVersion: 1 });
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({ configVersion: 1, target: 'docker', site: { relayName: 'Mine' }, sdk: SDK });
    expect(result.steps.map((s) => s.en)).toEqual(['relayName moved into site']);
    expect(input).toEqual({ configVersion: 0, target: 'docker', relayName: 'Mine' });
  });

  it('舊格式卻沒有對應的遷移步驟 → 拒絕', () => {
    const result = migrateDeployConfig({ configVersion: 0, target: 'docker' }, { sdkVersion: SDK });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('no-migration');
  });
});
