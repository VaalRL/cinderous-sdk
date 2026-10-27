import { EK_ANNOUNCE_KIND, FS_ROTATE_INTERVAL_MS } from '../protocol/subkey.js';
import { DEFAULT_MAX_SKIPPED_KEYS } from './double-ratchet.js';
export const CRYPTO_ENGINES_TAG = 'crypto_engines';
/** SDK 支援的引擎（寫進自己的公告） */
export const SUPPORTED_ENGINES = ['cinder-ek', 'double-ratchet'];
export class UnsupportedEngineError extends Error {
    name = 'UnsupportedEngineError';
}
/** 能力宣告標籤：`["crypto_engines", "cinder-ek", "double-ratchet"]`。放在 tags 不放 content，舊版讀者直接忽略。 */
export function engineCapabilityTag(engines = SUPPORTED_ENGINES) {
    return [CRYPTO_ENGINES_TAG, ...engines];
}
/**
 * 讀對方公告宣告的引擎。
 * - 沒有公告 → `undefined`（什麼都不知道）
 * - 有公告但沒有這個標籤（今天的 Cinderous App）→ 只支援 Cinder EK
 * - 不認得的名稱略過（對方可能比我們新）
 */
export function readEngineCapabilities(announce) {
    if (!announce || announce.kind !== EK_ANNOUNCE_KIND)
        return undefined;
    const tag = announce.tags.find((t) => t[0] === CRYPTO_ENGINES_TAG);
    if (!tag)
        return ['cinder-ek'];
    return tag.slice(1).filter((name) => SUPPORTED_ENGINES.includes(name));
}
export function chooseEngine(ctx) {
    const peerHasRatchet = ctx.peerCapabilities?.includes('double-ratchet') === true;
    switch (ctx.preset) {
        case 'vault-sync':
            return 'cinder-ek';
        case 'live-collaboration':
            if (!ctx.peerOnline)
                throw new UnsupportedEngineError('live-collaboration 需要雙方都在線的即時通道');
            if (ctx.peerCapabilities !== undefined && !peerHasRatchet) {
                throw new UnsupportedEngineError('對方宣告不支援雙棘輪，無法使用 live-collaboration');
            }
            return 'double-ratchet';
        case 'auto-negotiate':
            return ctx.peerOnline && peerHasRatchet && ctx.recipients === 1 ? 'double-ratchet' : 'cinder-ek';
    }
}
/** 各引擎的預設設定（PRD 3.5.2）。 */
export function engineConfigFor(engine) {
    return engine === 'double-ratchet'
        ? { engine, postQuantumEnabled: true, maxSkippedKeys: DEFAULT_MAX_SKIPPED_KEYS }
        : { engine, postQuantumEnabled: true, ekRotationIntervalSeconds: FS_ROTATE_INTERVAL_MS / 1000 };
}
//# sourceMappingURL=presets.js.map