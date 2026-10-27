/**
 * 資源消耗與營運成本試算（PRD §5.4、SDK ADR 0002）：`@cinderous/client/estimator`。
 *
 * 純函式、不連網。PRD 有公式的照公式算；PRD 沒給公式的（本機儲存、耗電分級、
 * 付費方案月費）由 ADR 0002 定義，並在這裡的註解寫明——試算只是決策參考，不是帳單。
 */

export type CryptoMode = 'cinder-ek' | 'double-ratchet';
export type TargetTier = 'tier-0-public' | 'tier-1-selfhosted' | 'tier-2-serverless';
export type BatteryDrainProfile = 'negligible' | 'low' | 'moderate' | 'heavy';

export interface ConsumptionSimulationInput {
  /** 密碼引擎模式 */
  cryptoMode: CryptoMode;
  /** 是否開啟後量子混合防禦（ML-KEM-768） */
  postQuantum: boolean;
  /** 每個人擁有的裝置數（對方也以同樣台數估） */
  devicesCount: number;
  /** 群組人數（含自己）；1:1 填 1 或 2 都視為兩個人 */
  collaboratorsCount: number;
  /** 每人每日同步／編輯動作次數 */
  dailyActionsCount: number;
  /** 每次動作的平均資料量（Bytes） */
  averagePayloadBytes: number;
  /** WebRTC P2P 打洞成功率，預設 0.85；受限網路填 0 */
  p2pSuccessRate?: number;
  /** 部署環境，預設 `tier-2-serverless`（Cloudflare Workers） */
  targetTier?: TargetTier;
}

export interface ResourceEstimationReport {
  readonly crypto: {
    readonly fanoutMultiplier: number;
    readonly dailyTotalEvents: number;
    readonly wireOverheadPerMessageBytes: number;
  };
  readonly network: {
    readonly dailyP2PVolumeBytes: number;
    readonly dailyRelayVolumeBytes: number;
    readonly monthlyRelayBandwidthMB: number;
  };
  readonly infrastructure: {
    readonly cloudflareDailyRequests: number;
    readonly cloudflareFreeTierUsagePercent: number;
    readonly isExceedingFreeTier: boolean;
    readonly estimatedMonthlyCostUSD: number;
  };
  readonly device: {
    readonly monthlyLocalStorageGrowthMB: number;
    readonly batteryDrainProfile: BatteryDrainProfile;
    readonly skippedKeysMemoryCacheKB: number;
  };
  readonly architecturalAdvice: string[];
}

/** 古典 NIP-44 的每則開銷：nonce＋MAC＋填補（PRD §5.4） */
export const NIP44_OVERHEAD_BYTES = 80;
/** 雙棘輪每次 DH 步進附帶的 ML-KEM-768 公鑰＋密文（1,184＋1,088） */
export const PQ_RATCHET_STEP_BYTES = 2_272;
/** Cloudflare Workers 免費層每日請求數 */
export const CLOUDFLARE_FREE_DAILY_REQUESTS = 100_000;
/** Workers 付費方案：月費、含的請求數、超出每百萬的價格（2026 年牌價，僅供試算） */
export const CLOUDFLARE_PAID_BASE_USD = 5;
export const CLOUDFLARE_PAID_INCLUDED_MONTHLY = 10_000_000;
export const CLOUDFLARE_PAID_PER_MILLION_USD = 0.3;
/** 雙棘輪跳過金鑰上限（PRD `maxSkippedKeys` 預設）與每把的記憶體估計 */
export const MAX_SKIPPED_KEYS = 2_000;
export const SKIPPED_KEY_BYTES = 240;
/** 本機每則訊息除了密文之外的索引開銷（ADR 0002 自訂） */
export const LOCAL_INDEX_BYTES = 64;
export const DEFAULT_P2P_SUCCESS_RATE = 0.85;
const DAYS_PER_MONTH = 30;

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必須是正整數（收到 ${value}）`);
}

function requireNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 不可為負數（收到 ${value}）`);
}

/** 耗電分級：只看每日事件數——每個事件都是一次加解密與一次網路往返 */
function batteryProfile(dailyEvents: number): BatteryDrainProfile {
  if (dailyEvents <= 1_000) return 'negligible';
  if (dailyEvents <= 10_000) return 'low';
  if (dailyEvents <= 100_000) return 'moderate';
  return 'heavy';
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));
const grouped = (value: number) => value.toLocaleString('en-US');

export function estimateResourceConsumption(input: ConsumptionSimulationInput): ResourceEstimationReport {
  requirePositiveInteger(input.devicesCount, 'devicesCount');
  requirePositiveInteger(input.collaboratorsCount, 'collaboratorsCount');
  requireNonNegative(input.dailyActionsCount, 'dailyActionsCount');
  requireNonNegative(input.averagePayloadBytes, 'averagePayloadBytes');
  const p2pRate = input.p2pSuccessRate ?? DEFAULT_P2P_SUCCESS_RATE;
  if (!Number.isFinite(p2pRate) || p2pRate < 0 || p2pRate > 1) {
    throw new Error(`p2pSuccessRate 必須介於 0 與 1（收到 ${p2pRate}）`);
  }
  const tier = input.targetTier ?? 'tier-2-serverless';
  const people = Math.max(2, input.collaboratorsCount);
  const devices = input.devicesCount;
  const actions = input.dailyActionsCount;

  // 扇出（PRD §5.4）：EK 是一份 payload＋槽位，固定兩份（自封副本＋遠端）；
  // 雙棘輪是每一台對方裝置與自己其他裝置各一份
  const fanout = input.cryptoMode === 'cinder-ek' ? 2 : (people - 1) * devices + (devices - 1);
  const dailyEvents = actions * fanout;
  // 後量子只讓雙棘輪每則變重；EK 的 ML-KEM 密文只在金鑰公告時出現，攤到每則可忽略
  const wire =
    NIP44_OVERHEAD_BYTES + (input.postQuantum && input.cryptoMode === 'double-ratchet' ? PQ_RATCHET_STEP_BYTES : 0);

  // 直連只算內容本身（DataChannel 的 DTLS 開銷另計）；走中繼的每則要帶上整個加密包裝
  const dailyP2P = Math.round(dailyEvents * p2pRate * input.averagePayloadBytes);
  const dailyRelay = Math.round(dailyEvents * (1 - p2pRate) * (input.averagePayloadBytes + wire));

  const requests = tier === 'tier-2-serverless' ? dailyEvents : 0;
  const exceeding = requests > CLOUDFLARE_FREE_DAILY_REQUESTS;
  const monthlyRequests = requests * DAYS_PER_MONTH;
  const cost = exceeding
    ? round(
        CLOUDFLARE_PAID_BASE_USD +
          (Math.max(0, monthlyRequests - CLOUDFLARE_PAID_INCLUDED_MONTHLY) / 1_000_000) *
            CLOUDFLARE_PAID_PER_MILLION_USD,
        2,
      )
    : 0;

  const advice: string[] = [];
  if (input.cryptoMode === 'double-ratchet' && people >= 10) {
    const ekEvents = actions * 2;
    const cut = round(((dailyEvents - ekEvents) / dailyEvents) * 100, 1);
    advice.push(
      `協同人數 ${people} 人且使用雙棘輪，扇出高達 ${fanout} 倍。若是個人筆記多端同步這類場景，` +
        `建議改用 'cinder-ek'：每日事件由 ${grouped(dailyEvents)} 降到 ${grouped(ekEvents)}（少 ${cut}%）。`,
    );
  }
  if (exceeding) {
    advice.push(
      `每日 ${grouped(requests)} 次請求超過 Cloudflare 免費層 ${grouped(CLOUDFLARE_FREE_DAILY_REQUESTS)}：` +
        `考慮自架中繼（tier-1）、降低同步頻率，或改用扇出較小的密碼模式。`,
    );
  }
  if (p2pRate === 0 && input.averagePayloadBytes > 256 * 1024) {
    advice.push('P2P 打洞率為 0 且單次資料超過 256KB：所有大檔都會壓在中繼上，建議開 TURN 或分塊續傳。');
  }

  return {
    crypto: { fanoutMultiplier: fanout, dailyTotalEvents: dailyEvents, wireOverheadPerMessageBytes: wire },
    network: {
      dailyP2PVolumeBytes: dailyP2P,
      dailyRelayVolumeBytes: dailyRelay,
      monthlyRelayBandwidthMB: round((dailyRelay * DAYS_PER_MONTH) / 1_000_000, 1),
    },
    infrastructure: {
      cloudflareDailyRequests: requests,
      cloudflareFreeTierUsagePercent: round((requests / CLOUDFLARE_FREE_DAILY_REQUESTS) * 100, 1),
      isExceedingFreeTier: exceeding,
      estimatedMonthlyCostUSD: cost,
    },
    device: {
      // 自己送出的每則都要留一份密文加索引（ADR 0002 自訂；PRD 沒有公式）
      monthlyLocalStorageGrowthMB: round((actions * DAYS_PER_MONTH * (wire + LOCAL_INDEX_BYTES)) / 1_000_000, 1),
      batteryDrainProfile: batteryProfile(dailyEvents),
      skippedKeysMemoryCacheKB:
        input.cryptoMode === 'double-ratchet' ? (MAX_SKIPPED_KEYS * SKIPPED_KEY_BYTES) / 1_000 : 0,
    },
    architecturalAdvice: advice,
  };
}

const MODE_LABEL: Record<CryptoMode, string> = { 'cinder-ek': 'Cinder EK', 'double-ratchet': '雙棘輪' };

/** 給 CLI 與終端機看的文字報告 */
export function formatEstimationReport(
  input: ConsumptionSimulationInput,
  report: ResourceEstimationReport,
): string {
  const rule = '='.repeat(72);
  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
  const lines = [
    rule,
    'Cinderous SDK 資源與營運成本試算',
    rule,
    `[情境] ${MODE_LABEL[input.cryptoMode]}${input.postQuantum ? '（後量子）' : ''} | ${input.collaboratorsCount} 人 | ` +
      `${input.devicesCount} 台裝置 | 每日 ${grouped(input.dailyActionsCount)} 次（${(input.averagePayloadBytes / 1000).toFixed(0)} KB）`,
    '',
    `扇出乘數：${report.crypto.fanoutMultiplier.toFixed(1)}x`,
    `每日事件：${grouped(report.crypto.dailyTotalEvents)} events / 天`,
    `每則開銷：${grouped(report.crypto.wireOverheadPerMessageBytes)} Bytes`,
    `P2P 直連：${mb(report.network.dailyP2PVolumeBytes)} / 天`,
    `中繼流量：${mb(report.network.dailyRelayVolumeBytes)} / 天（每月 ${report.network.monthlyRelayBandwidthMB.toFixed(1)} MB）`,
    `Cloudflare：${grouped(report.infrastructure.cloudflareDailyRequests)} / ${grouped(CLOUDFLARE_FREE_DAILY_REQUESTS)} 請求（${report.infrastructure.cloudflareFreeTierUsagePercent}%）` +
      `，月費約 $${report.infrastructure.estimatedMonthlyCostUSD.toFixed(2)}`,
    `本機儲存：每月 ${report.device.monthlyLocalStorageGrowthMB.toFixed(1)} MB；跳過金鑰 ~${report.device.skippedKeysMemoryCacheKB} KB；耗電 ${report.device.batteryDrainProfile}`,
  ];
  if (report.architecturalAdvice.length > 0) {
    lines.push('', '建議：', ...report.architecturalAdvice.map((line) => `  - ${line}`));
  }
  lines.push(rule);
  return lines.join('\n');
}
