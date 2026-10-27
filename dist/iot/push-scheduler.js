// 送出端的「合併＋抖動」排程器（SDK ADR 0049 §11.1 裁示 2；沿用 Cinderous ADR-0272 §決策 2）：純邏輯，時鐘、亂數、計時器都可注入。
//
// - 標準（預設）：同一個端點每 `60 / standardPerMinute` 秒最多一次（預設 60 秒），再加 0–30 秒隨機延遲；
//   等待期間的事件全部合併成一次喚醒（第三方只看得到「這個時間窗有活動」）。
// - 即時：不合併、0–2 秒抖動；但每個端點每分鐘最多 `instantPerMinute` 次（預設 6，含標準的那幾次），超過就等到視窗空出來。
// - 即時送出時，等待中的標準喚醒一併滿足（App 醒來會讀所有訂閱的狀態），不另外再送。
// - 對方回 `gone`：交給 `onGone` 刪掉端點；回 `retry`：在 `Retry-After` 之前不送，這次的喚醒延後；`error`：照標準間隔重試，最多 `maxAttempts` 次。
import { IOT_PUSH_INSTANT_JITTER_MS, IOT_PUSH_STANDARD_JITTER_MS, iotPushLimits } from './push.js';
export const realIotPushTimers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle),
};
const WINDOW_MS = 60_000;
export class IotPushScheduler {
    #o;
    #now;
    #random;
    #timers;
    #standardIntervalMs;
    #instantPerMinute;
    #standardJitterMs;
    #instantJitterMs;
    #maxAttempts;
    #state = new Map();
    #stopped = false;
    constructor(opts) {
        this.#o = opts;
        const limits = iotPushLimits(opts.limits);
        this.#standardIntervalMs = Math.ceil(WINDOW_MS / limits.standardPerMinute);
        this.#instantPerMinute = limits.instantPerMinute;
        this.#now = opts.now ?? Date.now;
        this.#random = opts.random ?? Math.random;
        this.#timers = opts.timers ?? realIotPushTimers;
        this.#standardJitterMs = Math.max(0, opts.standardJitterMs ?? IOT_PUSH_STANDARD_JITTER_MS);
        this.#instantJitterMs = Math.max(0, opts.instantJitterMs ?? IOT_PUSH_INSTANT_JITTER_MS);
        this.#maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3));
    }
    /** 某個端點訂閱的東西有更新了：依模式排一次喚醒（或併進已經排好的那一次） */
    notify(id, mode, ref) {
        if (this.#stopped)
            return;
        const state = this.#get(id);
        const pending = state.pending;
        if (pending) {
            if (ref !== undefined)
                pending.ref = ref;
            if (mode === 'standard')
                return; // 合併
            const at = this.#earliest(state, 'instant');
            if (at < pending.at)
                this.#schedule(id, state, at, pending.ref, pending.attempts);
            return;
        }
        this.#schedule(id, state, this.#earliest(state, mode), ref, 0);
    }
    /** 取消某個端點等待中的喚醒並忘掉它（端點被撤銷、過期） */
    cancel(id) {
        const state = this.#state.get(id);
        if (state?.pending)
            this.#timers.clear(state.pending.handle);
        this.#state.delete(id);
    }
    /** 等待中的喚醒（測試與除錯用） */
    pending(id) {
        const p = this.#state.get(id)?.pending;
        return p ? { at: p.at } : undefined;
    }
    /** 停止：清掉所有計時器，之後的 notify 一律忽略 */
    stop() {
        this.#stopped = true;
        for (const state of this.#state.values())
            if (state.pending)
                this.#timers.clear(state.pending.handle);
        this.#state.clear();
    }
    #get(id) {
        let state = this.#state.get(id);
        if (!state)
            this.#state.set(id, (state = { sent: [] }));
        return state;
    }
    /** 這個模式最早可以送的時間（含抖動） */
    #earliest(state, mode) {
        const now = this.#now();
        state.sent = state.sent.filter((t) => t > now - WINDOW_MS);
        let at = Math.max(now, state.blockedUntil ?? 0);
        const last = state.sent[state.sent.length - 1];
        if (mode === 'standard' && last !== undefined)
            at = Math.max(at, last + this.#standardIntervalMs);
        if (state.sent.length >= this.#instantPerMinute)
            at = Math.max(at, state.sent[state.sent.length - this.#instantPerMinute] + WINDOW_MS);
        const jitter = mode === 'standard' ? this.#standardJitterMs : this.#instantJitterMs;
        return at + Math.floor(this.#random() * jitter);
    }
    #schedule(id, state, at, ref, attempts) {
        if (state.pending)
            this.#timers.clear(state.pending.handle);
        const handle = this.#timers.set(() => void this.#fire(id), Math.max(0, at - this.#now()));
        state.pending = { at, handle, attempts, ...(ref !== undefined ? { ref } : {}) };
    }
    async #fire(id) {
        const state = this.#state.get(id);
        const pending = state?.pending;
        if (!state || !pending || this.#stopped)
            return;
        state.pending = undefined;
        const sentAt = this.#now();
        state.sent.push(sentAt);
        let result;
        try {
            result = await this.#o.send(id, pending.ref !== undefined ? { ref: pending.ref } : {});
        }
        catch {
            result = { status: 'error', reason: 'send-threw' };
        }
        if (this.#stopped || this.#state.get(id) !== state)
            return;
        if (result.status === 'ok')
            return;
        if (result.status === 'gone') {
            this.cancel(id);
            this.#o.onGone?.(id);
            return;
        }
        const attempts = pending.attempts + 1;
        if (result.status === 'retry')
            state.blockedUntil = this.#now() + Math.max(0, result.retryAfterMs);
        if (attempts >= this.#maxAttempts) {
            this.#o.onError?.(id, result.status === 'retry' ? 'retry-exhausted' : result.reason);
            return;
        }
        if (state.pending)
            return; // 送出期間又來了新的事件，已經排好
        const delayed = result.status === 'retry' ? state.blockedUntil : sentAt + this.#standardIntervalMs;
        this.#schedule(id, state, Math.max(delayed, this.#now()) + Math.floor(this.#random() * this.#standardJitterMs), pending.ref, attempts);
    }
}
//# sourceMappingURL=push-scheduler.js.map