// 場景預設與自動協商（PRD 3.5.3；SDK ADR 0014）：依場景決定用哪個加密引擎。
//
// - `vault-sync`：一律 Cinder EK。離線投遞、多台裝置同步都不會失步。
// - `live-collaboration`：雙棘輪。只用在雙方都在線的即時通道（ADR 0010）；對方不在線或不支援就丟例外。
// - `auto-negotiate`：雙方在線、都支援、而且是一對一，才用雙棘輪；其餘一律 Cinder EK。
//
// 對方支援哪些引擎，看它 kind 10040 公告上的 `crypto_engines` 標籤。
import type { NostrEvent } from '../protocol/event.js';
import { EK_ANNOUNCE_KIND, FS_ROTATE_INTERVAL_MS } from '../protocol/subkey.js';
import { DEFAULT_MAX_SKIPPED_KEYS } from './double-ratchet.js';
import type { CryptoEngineType } from './types.js';

export const CRYPTO_ENGINES_TAG = 'crypto_engines';
/** SDK 支援的引擎（寫進自己的公告） */
export const SUPPORTED_ENGINES: readonly CryptoEngineType[] = ['cinder-ek', 'double-ratchet'];

export type CryptoPreset = 'vault-sync' | 'live-collaboration' | 'auto-negotiate';

/** PRD 3.5.2 */
export interface CryptoEngineConfig {
  readonly engine: CryptoEngineType;
  readonly postQuantumEnabled: boolean;
  readonly maxSkippedKeys?: number;
  readonly ekRotationIntervalSeconds?: number;
}

export class UnsupportedEngineError extends Error {
  override readonly name = 'UnsupportedEngineError';
}

/** 能力宣告標籤：`["crypto_engines", "cinder-ek", "double-ratchet"]`。放在 tags 不放 content，舊版讀者直接忽略。 */
export function engineCapabilityTag(engines: readonly CryptoEngineType[] = SUPPORTED_ENGINES): string[] {
  return [CRYPTO_ENGINES_TAG, ...engines];
}

/**
 * 讀對方公告宣告的引擎。
 * - 沒有公告 → `undefined`（什麼都不知道）
 * - 有公告但沒有這個標籤（今天的 Cinderous App）→ 只支援 Cinder EK
 * - 不認得的名稱略過（對方可能比我們新）
 */
export function readEngineCapabilities(announce: NostrEvent | undefined): CryptoEngineType[] | undefined {
  if (!announce || announce.kind !== EK_ANNOUNCE_KIND) return undefined;
  const tag = announce.tags.find((t) => t[0] === CRYPTO_ENGINES_TAG);
  if (!tag) return ['cinder-ek'];
  return tag.slice(1).filter((name): name is CryptoEngineType => (SUPPORTED_ENGINES as readonly string[]).includes(name));
}

export interface EngineChoiceContext {
  preset: CryptoPreset;
  /** 現在跟對方有開著的即時通道嗎（`connectPeer` 連上了） */
  peerOnline: boolean;
  /** 對方宣告支援的引擎；`undefined`＝不知道 */
  peerCapabilities: readonly CryptoEngineType[] | undefined;
  /** 這則要送到幾台裝置（含自己的其他裝置）：多於一台就是扇出，雙棘輪不適合 */
  recipients: number;
}

export function chooseEngine(ctx: EngineChoiceContext): CryptoEngineType {
  const peerHasRatchet = ctx.peerCapabilities?.includes('double-ratchet') === true;
  switch (ctx.preset) {
    case 'vault-sync':
      return 'cinder-ek';
    case 'live-collaboration':
      if (!ctx.peerOnline) throw new UnsupportedEngineError('live-collaboration 需要雙方都在線的即時通道');
      if (ctx.peerCapabilities !== undefined && !peerHasRatchet) {
        throw new UnsupportedEngineError('對方宣告不支援雙棘輪，無法使用 live-collaboration');
      }
      return 'double-ratchet';
    case 'auto-negotiate':
      return ctx.peerOnline && peerHasRatchet && ctx.recipients === 1 ? 'double-ratchet' : 'cinder-ek';
  }
}

/** 各引擎的預設設定（PRD 3.5.2）。 */
export function engineConfigFor(engine: CryptoEngineType): CryptoEngineConfig {
  return engine === 'double-ratchet'
    ? { engine, postQuantumEnabled: true, maxSkippedKeys: DEFAULT_MAX_SKIPPED_KEYS }
    : { engine, postQuantumEnabled: true, ekRotationIntervalSeconds: FS_ROTATE_INTERVAL_MS / 1000 };
}
