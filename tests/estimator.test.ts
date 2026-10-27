import { describe, expect, it } from 'vitest';

import { estimateResourceConsumption, formatEstimationReport } from '../src/estimator.js';

/** PRD §5.4 的範例：15 人協同、5 台裝置、每天 500 次、每次 20KB、雙棘輪＋後量子 */
const prdExample = {
  cryptoMode: 'double-ratchet' as const,
  postQuantum: true,
  devicesCount: 5,
  collaboratorsCount: 15,
  dailyActionsCount: 500,
  averagePayloadBytes: 20_000,
};

describe('estimateResourceConsumption（PRD §5.4、SDK ADR 0002）', () => {
  it('PRD 範例：扇出 74 倍、每天 37,000 個事件、每則 2,352 B 開銷', () => {
    const report = estimateResourceConsumption(prdExample);
    expect(report.crypto).toEqual({
      fanoutMultiplier: 74,
      dailyTotalEvents: 37_000,
      wireOverheadPerMessageBytes: 2_352,
    });
  });

  it('PRD 範例：P2P 629 MB／天；中繼照公式是 124.05 MB（PRD 寫 123.8，四捨五入有誤）', () => {
    const { network } = estimateResourceConsumption(prdExample);
    expect(network.dailyP2PVolumeBytes).toBe(629_000_000);
    expect(network.dailyRelayVolumeBytes).toBe(124_053_600);
    expect(network.monthlyRelayBandwidthMB).toBeCloseTo(3721.6, 1);
  });

  it('PRD 範例：Cloudflare 免費層佔 37%、不收費；跳過金鑰約 480 KB；中度耗電', () => {
    const report = estimateResourceConsumption(prdExample);
    expect(report.infrastructure).toEqual({
      cloudflareDailyRequests: 37_000,
      cloudflareFreeTierUsagePercent: 37,
      isExceedingFreeTier: false,
      estimatedMonthlyCostUSD: 0,
    });
    expect(report.device.skippedKeysMemoryCacheKB).toBe(480);
    expect(report.device.batteryDrainProfile).toBe('moderate');
  });

  it('PRD 範例的建議：改用 Cinder EK，事件由 37,000 降到 1,000（少 97.3%）', () => {
    const [advice] = estimateResourceConsumption(prdExample).architecturalAdvice;
    expect(advice).toMatch(/cinder-ek/);
    expect(advice).toMatch(/37,000/);
    expect(advice).toMatch(/1,000/);
    expect(advice).toMatch(/97\.3%/);
  });

  it('Cinder EK：扇出固定 2（自封副本＋遠端），後量子不增加每則開銷，沒有跳過金鑰', () => {
    const report = estimateResourceConsumption({ ...prdExample, cryptoMode: 'cinder-ek' });
    expect(report.crypto).toEqual({ fanoutMultiplier: 2, dailyTotalEvents: 1_000, wireOverheadPerMessageBytes: 80 });
    expect(report.device.skippedKeysMemoryCacheKB).toBe(0);
    expect(report.device.batteryDrainProfile).toBe('negligible');
    expect(report.architecturalAdvice).toEqual([]);
  });

  it('1:1（協同人數填 1）當作兩個人：扇出＝對方的裝置＋自己其他裝置', () => {
    const report = estimateResourceConsumption({ ...prdExample, collaboratorsCount: 1, devicesCount: 3 });
    expect(report.crypto.fanoutMultiplier).toBe(3 + 2);
  });

  it('超過 Cloudflare 免費層：標記超出、估付費方案月費、給建議', () => {
    const report = estimateResourceConsumption({ ...prdExample, dailyActionsCount: 5_000 });
    expect(report.infrastructure.isExceedingFreeTier).toBe(true);
    // 370,000／天 × 30 ＝ 11.1M／月：付費方案 $5 含 10M，超出 1.1M × $0.30
    expect(report.infrastructure.estimatedMonthlyCostUSD).toBe(5.33);
    expect(report.architecturalAdvice.some((line) => /免費層/.test(line))).toBe(true);
  });

  it('不走 Cloudflare（公共或自架中繼）：沒有請求數與費用', () => {
    const report = estimateResourceConsumption({ ...prdExample, targetTier: 'tier-1-selfhosted' });
    expect(report.infrastructure.cloudflareDailyRequests).toBe(0);
    expect(report.infrastructure.estimatedMonthlyCostUSD).toBe(0);
  });

  it('無效輸入直接拒絕', () => {
    expect(() => estimateResourceConsumption({ ...prdExample, devicesCount: 0 })).toThrow(/devicesCount/);
    expect(() => estimateResourceConsumption({ ...prdExample, p2pSuccessRate: 1.5 })).toThrow(/p2pSuccessRate/);
    expect(() => estimateResourceConsumption({ ...prdExample, averagePayloadBytes: -1 })).toThrow(/averagePayloadBytes/);
  });

  it('文字報告：情境、扇出、事件數、建議都在', () => {
    const text = formatEstimationReport(prdExample, estimateResourceConsumption(prdExample));
    expect(text).toMatch(/74\.0x/);
    expect(text).toMatch(/37,000 events/);
    expect(text).toMatch(/cinder-ek/);
  });
});
