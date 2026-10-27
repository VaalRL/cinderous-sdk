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
export declare const NIP44_OVERHEAD_BYTES = 80;
/** 雙棘輪每次 DH 步進附帶的 ML-KEM-768 公鑰＋密文（1,184＋1,088） */
export declare const PQ_RATCHET_STEP_BYTES = 2272;
/** Cloudflare Workers 免費層每日請求數 */
export declare const CLOUDFLARE_FREE_DAILY_REQUESTS = 100000;
/** Workers 付費方案：月費、含的請求數、超出每百萬的價格（2026 年牌價，僅供試算） */
export declare const CLOUDFLARE_PAID_BASE_USD = 5;
export declare const CLOUDFLARE_PAID_INCLUDED_MONTHLY = 10000000;
export declare const CLOUDFLARE_PAID_PER_MILLION_USD = 0.3;
/** 雙棘輪跳過金鑰上限（PRD `maxSkippedKeys` 預設）與每把的記憶體估計 */
export declare const MAX_SKIPPED_KEYS = 2000;
export declare const SKIPPED_KEY_BYTES = 240;
/** 本機每則訊息除了密文之外的索引開銷（ADR 0002 自訂） */
export declare const LOCAL_INDEX_BYTES = 64;
export declare const DEFAULT_P2P_SUCCESS_RATE = 0.85;
export declare function estimateResourceConsumption(input: ConsumptionSimulationInput): ResourceEstimationReport;
/** 給 CLI 與終端機看的文字報告 */
export declare function formatEstimationReport(input: ConsumptionSimulationInput, report: ResourceEstimationReport): string;
//# sourceMappingURL=estimator.d.ts.map