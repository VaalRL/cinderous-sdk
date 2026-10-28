/**
 * 中繼事件預算（SDK ADR 0043）：SDK 中繼以**認證身分**計數，每把公鑰每分鐘 120 則事件（`relay-core` 的 `admit()`，
 * `rateKey = authState.pubkey ?? event.pubkey`；ephemeral 也算）。同一個身分的 PeerNode 中繼框與信令、Vault 同步、
 * 名單同步都落在**同一個桶**——各自限速、加起來仍會超過。
 *
 * - {@link sharedRelayEventBudget}：同一把公鑰在這個 JS 環境裡共用一個預算（預設每分鐘 {@link DEFAULT_RELAY_EVENTS_PER_MINUTE} 則，
 *   留 20 則給私訊、心跳等沒有經過預算的發布）。PeerNode、`NostrVaultTransport`、`NostrRosterSync` 沒有指定速率時都用它。
 * - {@link relayEventsPerMinute}：從中繼的 NIP-11 `cinder_max_events_per_minute` 算出安全值（× 0.8，多座取最小）；
 *   星狀會話的 `starRelayEventsPerMinute` 是同一個函式（SSOT）。
 * - {@link publishPaced}：先取預算再發布；中繼回 `rate-limited:`（ADR 0040 詞元）就整個預算退避到計數窗結束
 *  （與 ADR 0041 健康狀態同一個長度），全部拒收時重送同一顆事件。
 *
 * 獨立成一個檔案、只依賴 `publish-rejections`：`./pairing`、`./sync/vault` 子路徑不能把連線池執行期拉進來。
 */
import { RELAY_REJECT_TOKENS } from './protocol/relay-reject.js';
import { publishRejections } from './publish-rejections.js';
/** SDK 中繼預設的每把公鑰每分鐘事件上限（鏡射 `relay/host-config` 的 `MAX_EVENTS_PER_MINUTE`；測試釘住兩者相同） */
export const RELAY_MAX_EVENTS_PER_MINUTE = 120;
/** 客戶端預設的每分鐘事件預算：低於上限，留 20 則給私訊、心跳等沒有經過預算的發布 */
export const DEFAULT_RELAY_EVENTS_PER_MINUTE = 100;
/** NIP-11 宣告值打幾折（留給同一身分其他用途） */
const NIP11_SHARE = 0.8;
/** 收到 `rate-limited:` 之後退避多久：中繼每分鐘的計數窗（與 `DEFAULT_RELAY_HEALTH_COOLDOWNS.rateLimitedMs` 相同） */
export const RELAY_RATE_LIMIT_BACKOFF_MS = 60_000;
/** `rate-limited: ip:` 是每 IP 每秒的窗 */
const IP_BACKOFF_MS = 1_000;
const WINDOW_MS = 60_000;
/**
 * 從中繼的 NIP-11 文件（或多份）算出每分鐘事件預算：`cinder_max_events_per_minute` × 0.8，多座取最小；
 * 都沒宣告就回 `fallback`。
 */
export function relayEventsPerMinute(nip11, fallback = DEFAULT_RELAY_EVENTS_PER_MINUTE) {
    const docs = Array.isArray(nip11) ? nip11 : [nip11];
    let best;
    for (const doc of docs) {
        const v = doc && typeof doc === 'object' ? doc.cinder_max_events_per_minute : undefined;
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
            const budget = Math.max(1, Math.floor(v * NIP11_SHARE));
            best = best === undefined ? budget : Math.min(best, budget);
        }
    }
    return best ?? fallback;
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * 滑動一分鐘的事件預算：任何 60 秒內最多 `perMinute` 則，所以中繼的固定計數窗（從第一則起算 60 秒）裡也不會超過。
 * `take()` 依呼叫順序排隊（先到先發），可以由同一身分的多個元件共用。
 */
export class RelayEventBudget {
    #base;
    #limit;
    #now;
    #sleep;
    #sent = [];
    #pausedUntil = 0;
    #queue = Promise.resolve();
    constructor(opts = {}) {
        this.#base = Math.max(1, Math.floor(opts.perMinute ?? DEFAULT_RELAY_EVENTS_PER_MINUTE));
        this.#limit = this.#base;
        this.#now = opts.now ?? Date.now;
        this.#sleep = opts.sleep ?? defaultSleep;
    }
    /** 目前每分鐘幾則 */
    get perMinute() {
        return this.#limit;
    }
    /** 依中繼的 NIP-11 調整：取建構時的速率與宣告值 × 0.8 的較小者（每次從建構時的速率重算，不會越調越低）。回傳新的速率 */
    applyRelayInfo(nip11) {
        this.#limit = Math.min(this.#base, relayEventsPerMinute(nip11, this.#base));
        return this.#limit;
    }
    /** 中繼說限速了：到 `ms` 毫秒之後都不發（只會延長，不會縮短） */
    backoff(ms) {
        this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + Math.max(0, ms));
    }
    /** 等到可以再發一則，並把這一則記進預算 */
    take() {
        const run = this.#queue.then(async () => {
            const now = this.#now();
            let wait = this.#pausedUntil - now;
            if (this.#sent.length >= this.#limit)
                wait = Math.max(wait, this.#sent[this.#sent.length - this.#limit] + WINDOW_MS - now);
            if (wait > 0)
                await this.#sleep(wait);
            // 睡完就當作時間已經到了（注入的 sleep 可能不推進時鐘）：以「該醒的時間」記帳
            const at = Math.max(this.#now(), now + Math.max(0, wait));
            while (this.#sent.length > 0 && at - this.#sent[0] >= WINDOW_MS)
                this.#sent.shift();
            this.#sent.push(at);
            if (this.#sent.length > this.#base)
                this.#sent.splice(0, this.#sent.length - this.#base);
        });
        this.#queue = run.catch(() => { });
        return run;
    }
}
const shared = new Map();
/**
 * 同一把公鑰共用的預算（中繼以認證身分計數，所以同一身分的所有元件要共用一個桶）。第一次取用時建立，速率是預設值；
 * 要依 NIP-11 調整就 `sharedRelayEventBudget(pubkey).applyRelayInfo(docs)`。
 */
export function sharedRelayEventBudget(pubkey) {
    let budget = shared.get(pubkey);
    if (budget === undefined) {
        budget = new RelayEventBudget();
        shared.set(pubkey, budget);
    }
    return budget;
}
/** 這次發布有沒有中繼說限速；有就回退避毫秒數（`ip` 詞元 1 秒，其他一分鐘） */
export function rateLimitBackoffMs(result) {
    let ms;
    for (const r of publishRejections(result)) {
        // IoT 即時通道的「今日額度用完」（SDK ADR 0049 §10）不是短暫限速：退避重送沒用，還會拖慢同一身分的其他流量
        if (r.kind !== 'rate-limited' || r.token === RELAY_REJECT_TOKENS.iotQuota)
            continue;
        const wait = r.token === 'ip' ? IP_BACKOFF_MS : RELAY_RATE_LIMIT_BACKOFF_MS;
        ms = Math.max(ms ?? 0, wait);
    }
    return ms;
}
/**
 * 取預算 → 發布；有中繼說限速就讓整個預算退避。`done(result)` 為 false（預設：沒有任何一座收下）而且原因是限速時，
 * 退避後重送同一顆（被拒的事件不留在中繼的重放快取裡，ADR 0038 P0-R1），最多 `retries` 次。
 */
export async function publishPaced(budget, publish, opts = {}) {
    const retries = opts.retries ?? 2;
    const done = opts.done ?? ((r) => r.accepted.length > 0);
    for (let attempt = 0;; attempt += 1) {
        await budget.take();
        const result = await publish();
        opts.onAttempt?.(result);
        const backoff = rateLimitBackoffMs(result);
        if (backoff !== undefined)
            budget.backoff(backoff);
        if (backoff === undefined || done(result) || attempt >= retries)
            return result;
    }
}
//# sourceMappingURL=relay-budget.js.map