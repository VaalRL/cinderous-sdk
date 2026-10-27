// 去重與重放保護（SDK ADR 0049 §2.4）：閘道與客戶端都做。
//
// - 拒收 `ts` 早於現在 `maxSkewSec`（預設 30，夾 5–120）或晚於 5 秒的訊息；
// - msgId LRU 去重（預設 1,024 筆），每筆至少留 `maxSkewSec`——比這還新的不會被擠掉：滿了就拒收新的（fail-closed），
//   免得大量訊息把還在時間窗內的 msgId 擠出去、讓重放的那一則被當成新的；
// - 去重命中回傳第一次的結果（閘道重送同樣的 ack，冪等）。
export const IOT_DEFAULT_MAX_SKEW_SEC = 30;
export const IOT_MIN_MAX_SKEW_SEC = 5;
export const IOT_MAX_MAX_SKEW_SEC = 120;
/** 允許比現在晚多少（毫秒）：設備與手機的時鐘誤差 */
export const IOT_FUTURE_SKEW_MS = 5_000;
export const IOT_DEFAULT_DEDUPE_SIZE = 1024;
export function clampIot(value, fallback, min, max) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
export class IotReplayGuard {
    maxSkewMs;
    #size;
    #now;
    /** key → { 收到的時間, 結果 }（插入順序＝時間順序） */
    #seen = new Map();
    constructor(opts = {}) {
        this.maxSkewMs = clampIot(opts.maxSkewSec, IOT_DEFAULT_MAX_SKEW_SEC, IOT_MIN_MAX_SKEW_SEC, IOT_MAX_MAX_SKEW_SEC) * 1000;
        this.#size = Math.max(16, Math.floor(opts.size ?? IOT_DEFAULT_DEDUPE_SIZE));
        this.#now = opts.now ?? Date.now;
    }
    /** 檢查一則訊息；`fresh` 時已經記下（之後以 {@link settle} 補上結果） */
    check(key, tsMs) {
        const now = this.#now();
        const hit = this.#seen.get(key);
        if (hit)
            return { verdict: 'duplicate', result: hit.result };
        if (tsMs < now - this.maxSkewMs)
            return { verdict: 'too-old' };
        if (tsMs > now + IOT_FUTURE_SKEW_MS)
            return { verdict: 'too-new' };
        this.#evict(now);
        if (this.#seen.size >= this.#size)
            return { verdict: 'busy' };
        this.#seen.set(key, { at: now, result: undefined });
        return { verdict: 'fresh' };
    }
    /** 記下處理結果（去重命中時回傳） */
    settle(key, result) {
        const hit = this.#seen.get(key);
        if (hit)
            hit.result = result;
    }
    get size() {
        return this.#seen.size;
    }
    #evict(now) {
        // 只淘汰已經超出時間窗的（它們本來就會被 too-old 擋下）；再加上未來窗，留得比時間窗稍久
        const horizon = now - this.maxSkewMs - IOT_FUTURE_SKEW_MS;
        for (const [key, entry] of this.#seen) {
            if (entry.at >= horizon)
                break;
            this.#seen.delete(key);
        }
    }
}
//# sourceMappingURL=replay.js.map