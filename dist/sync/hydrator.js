import { TIMESTAMP_JITTER_SECONDS } from '../protocol/nip59.js';
/** 放到背景超過這麼久就主動斷線（PRD：15 秒） */
export const DEFAULT_HIDDEN_DISCONNECT_MS = 15_000;
/**
 * 沒有任何一座中繼完成查詢（都沒開、逾時、被 CLOSED、查到一半全部斷線；SDK ADR 0045，G12a）。
 * 不是「查完但沒結果」：依查詢結果推進的游標此時不得推進。`events`＝在那之前已經拿到的（已交出去的頁）。
 */
export class RelayQueryIncompleteError extends Error {
    relays;
    events;
    constructor(relays, events = []) {
        const detail = relays.map((r) => `${r.url} ${r.status}${r.reason ? `（${r.reason}）` : ''}`).join('；');
        super(`沒有任何中繼完成查詢${detail ? `：${detail}` : ''}`);
        this.name = 'RelayQueryIncompleteError';
        this.relays = relays;
        this.events = events;
    }
}
export function isRelayQueryIncompleteError(error) {
    return error instanceof RelayQueryIncompleteError || (error instanceof Error && error.name === 'RelayQueryIncompleteError');
}
/** 瀏覽器預設：`document.visibilityState`；沒有 document（Node、React Native）回 null，請自行注入 */
export function documentVisibility() {
    const doc = globalThis.document;
    if (!doc)
        return null;
    return {
        isHidden: () => doc.visibilityState === 'hidden',
        onChange(listener) {
            const handler = () => listener(doc.visibilityState === 'hidden');
            doc.addEventListener('visibilitychange', handler);
            return () => doc.removeEventListener('visibilitychange', handler);
        },
    };
}
/** 分頁取回最多翻幾頁（防惡意中繼無止盡地回更舊的事件）。每頁至多約 16 MB（中繼的 REQ 位元組預算） */
export const DEFAULT_MAX_PAGES = 64;
/**
 * 分頁取回歷史事件（SDK ADR 0029；NIP-01 `until`）：每拿到一頁、把**這一頁新的事件**交給 `onPage`。
 *
 * 為什麼要分頁：中繼一次 REQ 回傳的量有上限（Cinderous ADR-0371：16 MB 位元組預算，約 120 顆檔案塊；
 * 另有 1024 筆的筆數上限），超過的**最舊**那些不會出現在這次回應裡——而且中繼**不會告訴你**被截斷了。
 * 所以這裡不猜：以這一頁最舊的 `created_at` 當下一頁的 `until`（含邊界，同一秒的不會漏）再查，
 * 直到一頁沒有任何新事件為止。代價是每次多一個（通常是空的）REQ。
 *
 * ⚠ `pool.query` 把多座中繼的結果合在一起：各座內容不一致、又各自被截斷時，以合併後最舊的時間往回翻，
 * 可能跳過較新那座被截斷的部分。Vault 同步由協調器的摘要／索取補回；要逐座精準分頁，每座給一個 pool。
 */
export async function forEachPage(pool, filters, onPage, opts = {}) {
    const maxPages = Math.max(1, Math.floor(opts.maxPages ?? DEFAULT_MAX_PAGES));
    const seen = new Set();
    let until;
    for (let page = 0; page < maxPages; page += 1) {
        const paged = until === undefined ? filters : filters.map((f) => ({ ...f, until: Math.min(f.until ?? until, until) }));
        let events;
        if (pool.queryResult) {
            const outcome = await pool.queryResult(paged, opts.timeoutMs);
            // 一座都沒回完（G12a）：不是「翻完了」。已經交出去的頁照樣算數，但整體不算完成
            if (outcome.answered === 0)
                return { events: seen.size, complete: false, unanswered: true, relays: outcome.relays };
            events = outcome.events;
        }
        else {
            events = await pool.query(paged, opts.timeoutMs);
        }
        const fresh = events.filter((e) => !seen.has(e.id));
        if (fresh.length === 0)
            return { events: seen.size, complete: true };
        for (const e of fresh)
            seen.add(e.id);
        onPage(fresh);
        let oldest = Infinity;
        for (const e of events)
            if (e.created_at < oldest)
                oldest = e.created_at;
        // 同一秒塞滿一整頁（極少見）：往前推一秒才會前進，那一秒剩下的只能放棄——總比無限迴圈好
        const next = until !== undefined && oldest >= until ? until - 1 : oldest;
        if (next < 0)
            return { events: seen.size, complete: true };
        until = next;
    }
    return { events: seen.size, complete: false };
}
/**
 * {@link forEachPage} 的收集版：回傳所有頁的事件（去重、由新到舊）。
 * 某一頁沒有任何中繼回完時丟 {@link RelayQueryIncompleteError}（v0.36 起；帶著已拿到的事件），不再回空陣列假裝查完。
 */
export async function queryPaged(pool, filters, opts = {}) {
    const all = [];
    const result = await forEachPage(pool, filters, (events) => all.push(...events), opts);
    all.sort((a, b) => b.created_at - a.created_at);
    if (result.unanswered)
        throw new RelayQueryIncompleteError(result.relays ?? [], all);
    return all;
}
export class FastHydrator {
    #opts;
    #visibility;
    #offVisibility;
    #hiddenTimer;
    #disconnected = false;
    constructor(opts) {
        this.#opts = opts;
        this.#visibility = opts.visibility === undefined ? documentVisibility() : opts.visibility;
    }
    /** 開始監看可見性，並立刻拉一次增量。 */
    async start() {
        this.#offVisibility = this.#visibility?.onChange((hidden) => (hidden ? this.#onHidden() : void this.#onVisible()));
        await this.resume().catch(() => { });
    }
    stop() {
        this.#offVisibility?.();
        this.#offVisibility = undefined;
        clearTimeout(this.#hiddenTimer);
    }
    /**
     * 拉一次增量；回傳拿到幾則。失敗時不更新同步時間（下次重拉，不會漏）。
     * 沒有任何中繼回完（池有 `queryResult` 時才分辨得出；SDK ADR 0045）也是失敗：拿到的頁照樣交出去，
     * 但不更新同步時間，並丟 {@link RelayQueryIncompleteError}。
     */
    async resume() {
        const startedAt = Math.floor(Date.now() / 1000);
        const last = this.#opts.lastSyncAt();
        const slack = this.#opts.sinceSlackSeconds ?? TIMESTAMP_JITTER_SECONDS;
        const filters = last === undefined ? this.#opts.filters : this.#opts.filters.map((f) => ({ ...f, since: Math.max(0, last - slack) }));
        // 分頁取回（SDK ADR 0029）：一頁一頁交出去，不必等全部翻完、也不必全部放在記憶體裡
        const opts = {};
        if (this.#opts.queryTimeoutMs !== undefined)
            opts.timeoutMs = this.#opts.queryTimeoutMs;
        if (this.#opts.maxPages !== undefined)
            opts.maxPages = this.#opts.maxPages;
        let first = true;
        const result = await forEachPage(this.#opts.pool, filters, (events) => {
            first = false;
            this.#opts.onEvents(events);
        }, opts);
        if (result.unanswered)
            throw new RelayQueryIncompleteError(result.relays ?? []);
        if (first)
            this.#opts.onEvents([]); // 與 v0.24 一致：沒有新事件也呼叫一次
        // 用「開始查詢」的時間：查詢途中到的訊息下次還會被拉到。
        // 撞到頁數上限（更舊的可能還沒拿）就不前進——前進了，下次的 since 會把沒拿到的那些永遠跳過
        if (result.complete)
            this.#opts.setLastSyncAt(startedAt);
        return result.events;
    }
    #onHidden() {
        clearTimeout(this.#hiddenTimer);
        this.#hiddenTimer = setTimeout(() => {
            this.#opts.pool.close();
            this.#disconnected = true;
        }, this.#opts.hiddenDisconnectMs ?? DEFAULT_HIDDEN_DISCONNECT_MS);
    }
    async #onVisible() {
        clearTimeout(this.#hiddenTimer);
        if (this.#disconnected) {
            this.#disconnected = false;
            this.#opts.pool.connect();
        }
        await this.resume().catch(() => { });
    }
}
//# sourceMappingURL=hydrator.js.map