import type { NostrEvent } from '../protocol/event.js';
import type { CryptoEngineType } from './types.js';
export declare const CRYPTO_ENGINES_TAG = "crypto_engines";
/** SDK 支援的引擎（寫進自己的公告） */
export declare const SUPPORTED_ENGINES: readonly CryptoEngineType[];
export type CryptoPreset = 'vault-sync' | 'live-collaboration' | 'auto-negotiate';
/** PRD 3.5.2 */
export interface CryptoEngineConfig {
    readonly engine: CryptoEngineType;
    readonly postQuantumEnabled: boolean;
    readonly maxSkippedKeys?: number;
    readonly ekRotationIntervalSeconds?: number;
}
export declare class UnsupportedEngineError extends Error {
    readonly name = "UnsupportedEngineError";
}
/** 能力宣告標籤：`["crypto_engines", "cinder-ek", "double-ratchet"]`。放在 tags 不放 content，舊版讀者直接忽略。 */
export declare function engineCapabilityTag(engines?: readonly CryptoEngineType[]): string[];
/**
 * 讀對方公告宣告的引擎。
 * - 沒有公告 → `undefined`（什麼都不知道）
 * - 有公告但沒有這個標籤（今天的 Cinderous App）→ 只支援 Cinder EK
 * - 不認得的名稱略過（對方可能比我們新）
 */
export declare function readEngineCapabilities(announce: NostrEvent | undefined): CryptoEngineType[] | undefined;
export interface EngineChoiceContext {
    preset: CryptoPreset;
    /** 現在跟對方有開著的即時通道嗎（`connectPeer` 連上了） */
    peerOnline: boolean;
    /** 對方宣告支援的引擎；`undefined`＝不知道 */
    peerCapabilities: readonly CryptoEngineType[] | undefined;
    /** 這則要送到幾台裝置（含自己的其他裝置）：多於一台就是扇出，雙棘輪不適合 */
    recipients: number;
}
export declare function chooseEngine(ctx: EngineChoiceContext): CryptoEngineType;
/** 各引擎的預設設定（PRD 3.5.2）。 */
export declare function engineConfigFor(engine: CryptoEngineType): CryptoEngineConfig;
//# sourceMappingURL=presets.d.ts.map