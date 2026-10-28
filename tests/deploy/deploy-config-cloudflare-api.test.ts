// 設定檔 → REST 一鍵部署的參數（SDK ADR 0118）：外掛與 CLI 用同一份，秘密在這裡才從環境讀。
import { describe, expect, it } from 'vitest';

import { cloudflareApiOptionsFromConfig, type DeployConfig } from '../../src/deploy/config/index.js';

const full: DeployConfig = {
  configVersion: 1,
  target: 'cloudflare-api',
  name: 'my-relay',
  site: { relayName: 'Mine', turnKeyId: 'k1', privateLane: { $env: 'LANE' } },
  cloudflare: { accountId: { $env: 'ACC' }, compatibilityDate: '2026-09-15', workersDevSubdomain: 'alice' },
  secrets: { cloudflareApiToken: { $env: 'CF' }, turnApiToken: { $env: 'TURN' } },
};
const lane = 'x'.repeat(40);

describe('cloudflareApiOptionsFromConfig', () => {
  it('站台參數、帳號、名稱、相容日期、子網域與兩個秘密都帶上', () => {
    expect(cloudflareApiOptionsFromConfig(full, { CF: 'cf-tok', ACC: 'acc1', TURN: 'turn-tok', LANE: lane })).toEqual({
      apiToken: 'cf-tok',
      accountId: 'acc1',
      workerName: 'my-relay',
      compatibilityDate: '2026-09-15',
      workersDevSubdomain: 'alice',
      relayName: 'Mine',
      turnKeyId: 'k1',
      privateLane: lane,
      turnApiToken: 'turn-tok',
    });
  });

  it('沒有引用時讀慣用的變數名稱（CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、TURN_API_TOKEN）', () => {
    const config: DeployConfig = { configVersion: 1, target: 'cloudflare-api', site: { turnKeyId: 'k1' } };
    expect(
      cloudflareApiOptionsFromConfig(config, { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', TURN_API_TOKEN: 'turn' }),
    ).toEqual({ apiToken: 't', accountId: 'a', turnKeyId: 'k1', turnApiToken: 'turn' });
  });

  it('沒有 TURN 的 Token：不帶 turnApiToken（沿用線上的 secret）', () => {
    const options = cloudflareApiOptionsFromConfig({ ...full, secrets: { cloudflareApiToken: { $env: 'CF' } } }, { CF: 't', LANE: lane });
    expect(options).not.toHaveProperty('turnApiToken');
  });

  it('🔴 沒有 Cloudflare API Token → 丟例外，只說變數名稱（REST 沒有 wrangler login 可以退回）', () => {
    expect(() => cloudflareApiOptionsFromConfig(full, { LANE: lane })).toThrow(/CF/);
    expect(() => cloudflareApiOptionsFromConfig({ configVersion: 1, target: 'cloudflare-api' }, {})).toThrow(/CLOUDFLARE_API_TOKEN/);
  });

  it('不是 cloudflare-api 目標、或是推播閘道 → 丟例外', () => {
    expect(() => cloudflareApiOptionsFromConfig({ configVersion: 1, target: 'cloudflare' }, { CLOUDFLARE_API_TOKEN: 't' })).toThrow(/cloudflare-api/);
    expect(() =>
      cloudflareApiOptionsFromConfig({ configVersion: 1, target: 'cloudflare-api', service: 'push-gateway' }, { CLOUDFLARE_API_TOKEN: 't' }),
    ).toThrow(/中繼/);
  });
});
