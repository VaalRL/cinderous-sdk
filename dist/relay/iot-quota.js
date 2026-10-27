// 家庭預算（SDK ADR 0049 §10.3）：每顆家庭 DO 自己計本 UTC 日的近似用量（升級、喚醒 DO 的訊息、alarm 各計 1）。
//
// 為什麼要自己計：Cloudflare 免費方案不會在 100% 準時擋下，擋下時也不一定給可辨識的錯誤（R0 實測結果四）；
// 「一個家庭燒光整個帳號」只能靠這一道。它是**每顆 DO 的局部近似**，不知道整個帳號的用量。
// 平台自動回覆的心跳不會走到 DO，不計（R0 實測結果一、二）。純函式、零 Node 內建模組、不用計時器。
/** 帳號每日的 DO 請求免費額度（Cloudflare 免費方案） */
export const IOT_ACCOUNT_DAILY_REQUESTS = 100_000;
const WARN = 0.8;
const SHED = 0.95;
/** 每累計幾次才寫回一次（計數本身不能吃掉 SQLite 的寫入額度） */
const PERSIST_EVERY = 64;
/** 下一個 UTC 00:00（unix 秒） */
export function nextUtcMidnightSec(nowMs) {
    return Math.floor(nowMs / 86_400_000) * 86_400 + 86_400;
}
function dayOf(nowMs) {
    return Math.floor(nowMs / 86_400_000) * 86_400;
}
/** 每家預設預算：帳號每日額度 ÷ 家庭數 × 0.5（留一半給 relay 其他流量）；`IOT_HOME_DAILY_REQUESTS` 是正整數就用它 */
export function iotDefaultHomeDailyRequests(homes, override) {
    const n = override === undefined ? NaN : Number(override);
    if (Number.isSafeInteger(n) && n > 0)
        return n;
    return Math.max(1, Math.floor((IOT_ACCOUNT_DAILY_REQUESTS / Math.max(1, homes)) * 0.5));
}
export class IotHomeQuota {
    limit;
    #now;
    #day;
    #used;
    #sincePersist = 0;
    constructor(limit, now = Date.now, saved) {
        this.limit = Math.max(1, Math.floor(limit));
        this.#now = now;
        this.#day = dayOf(now());
        this.#used = saved && saved.day === this.#day ? saved.used : 0;
    }
    /** 計一次；`crossed`＝這一次剛好跨過哪個門檻（只回報一次），`persist`＝該寫回了 */
    add(n = 1) {
        this.#roll();
        const before = this.#stateOf(this.#used);
        this.#used += n;
        this.#sincePersist += n;
        const state = this.#stateOf(this.#used);
        const crossed = state !== before && state !== 'ok' ? state : undefined;
        const persist = crossed !== undefined || this.#sincePersist >= PERSIST_EVERY;
        if (persist)
            this.#sincePersist = 0;
        return crossed ? { state, crossed, persist } : { state, persist };
    }
    state() {
        this.#roll();
        return this.#stateOf(this.#used);
    }
    /** 額度重置時間（下一個 UTC 00:00，unix 秒） */
    resetAt() {
        return nextUtcMidnightSec(this.#now());
    }
    snapshot() {
        this.#roll();
        return { day: this.#day, used: this.#used };
    }
    #roll() {
        const day = dayOf(this.#now());
        if (day !== this.#day) {
            this.#day = day;
            this.#used = 0;
            this.#sincePersist = 0;
        }
    }
    #stateOf(used) {
        if (used >= this.limit)
            return 'exhausted';
        if (used >= this.limit * SHED)
            return 'shed';
        if (used >= this.limit * WARN)
            return 'warn';
        return 'ok';
    }
}
//# sourceMappingURL=iot-quota.js.map