// 送出端的中繼帳（SDK ADR 0068）：每則經中繼送出的訊息記一筆（序號、塊數、送出的小時、收件人），
// 每位收件人各自算用量；收件人的簽收單（序號區間）劃掉它那一份，超過保存期的一律劃掉（沒有簽收時的上限）。
// 純資料結構，協調器負責持久化（`toJSON`／`parse`）與決定什麼時候 `prune`。
const HOUR_MS = 3_600_000;
/** 一份簽收單最多幾段區間（codec 也照這個上限驗） */
export const MAX_RECEIPT_RANGES = 1000;
/** 把 [lo, hi] 併進區間清單（合併重疊與相鄰的）；回傳新的清單 */
export function addRange(ranges, lo, hi) {
    const out = [];
    let cur = [lo, hi];
    let placed = false;
    for (const r of ranges) {
        if (placed || r[1] < cur[0] - 1) {
            if (!placed && r[0] > cur[1] + 1) {
                out.push(cur);
                placed = true;
            }
            out.push(r);
        }
        else if (r[0] > cur[1] + 1) {
            out.push(cur, r);
            placed = true;
        }
        else
            cur = [Math.min(cur[0], r[0]), Math.max(cur[1], r[1])];
    }
    if (!placed)
        out.push(cur);
    return out;
}
export function coversRange(ranges, n) {
    if (!ranges)
        return false;
    for (const [lo, hi] of ranges) {
        if (n < lo)
            return false;
        if (n <= hi)
            return true;
    }
    return false;
}
const isInt = (x, min = 0) => Number.isSafeInteger(x) && x >= min;
const isDevice = (x) => typeof x === 'string' && x.length > 0 && x.length <= 64;
export class RelayLedger {
    #entries = [];
    #receipts = new Map();
    /**
     * 每台第一次成為收件人的小時（SDK ADR 0107）：在那之前的廣播沒有寄給它，不算它的用量。
     * 新加入的裝置原本一開始就背著加入前所有的廣播（實機一加入就是 2430／1080 塊），批次只能走直連。
     */
    #joined = new Map();
    /**
     * 記過收件人了沒有。沒有＝舊版的帳（或全新的）：第一次 `join` 時名單上的一律從 0 算——
     * 舊的廣播照樣算它們的（寧可多算），之後才出現的才從那時算起。
     */
    #seeded = false;
    #opts;
    /**
     * 簽收、清理、合併時加一（記帳不加）。`usage` 依它、目前的小時與收件人快取；記帳時直接把塊數加到快取上（遞增）。
     * 狀態每處理一則就要算一次，帳可能有上萬筆：每次都整本重算是平方級。
     */
    #version = 0;
    #usageCache = null;
    constructor(opts) {
        this.#opts = opts;
    }
    /** 從持久化資料還原；`legacy`：舊版的 `relayUse`（`[小時, 塊數]`），轉成沒有序號的廣播帳 */
    static parse(raw, opts, legacy) {
        const l = new RelayLedger(opts);
        const data = raw && typeof raw === 'object' ? raw : {};
        for (const [hour, frames] of legacy ?? [])
            if (isInt(hour) && isInt(frames, 1))
                l.#entries.push({ rs: 0, f: frames, h: hour });
        if (Array.isArray(data.e)) {
            for (const e of data.e) {
                if (!Array.isArray(e) || !isInt(e[0]) || !isInt(e[1], 1) || !isInt(e[2]))
                    continue;
                const to = Array.isArray(e[3]) && e[3].every(isDevice) ? [...e[3]] : undefined;
                const v = Array.isArray(e[4]) && e[4].every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string') ? e[4].map(([a, b]) => [a, b]) : undefined;
                l.#entries.push({ rs: e[0], f: e[1], h: e[2], ...(to ? { to } : {}), ...(v ? { v } : {}) });
            }
        }
        if (data.k && typeof data.k === 'object') {
            for (const [device, ranges] of Object.entries(data.k)) {
                if (!isDevice(device) || !Array.isArray(ranges))
                    continue;
                let out = [];
                for (const r of ranges)
                    if (Array.isArray(r) && isInt(r[0], 1) && isInt(r[1], 1) && r[0] <= r[1])
                        out = addRange(out, r[0], r[1]);
                if (out.length > 0)
                    l.#receipts.set(device, out);
            }
        }
        if (data.j && typeof data.j === 'object') {
            l.#seeded = true;
            for (const [device, hour] of Object.entries(data.j))
                if (isDevice(device) && isInt(hour))
                    l.#joined.set(device, hour);
        }
        l.#entries.sort((a, b) => a.h - b.h || a.rs - b.rs);
        return l;
    }
    /**
     * 目前的收件人（SDK ADR 0107）：第一次看到的那幾台記下現在的小時（還沒記過任何收件人時一律從 0 算）。
     * 有新記的回 true（要存）。已經記過的不再改：被撤銷又加回來的照舊算它以前的廣播（寧可多算）。
     */
    join(devices) {
        const hour = this.#seeded ? Math.floor(this.#opts.now() / HOUR_MS) : 0;
        let changed = !this.#seeded;
        this.#seeded = true;
        for (const device of devices) {
            if (this.#joined.has(device))
                continue;
            this.#joined.set(device, hour);
            changed = true;
        }
        if (changed)
            this.#version += 1;
        return changed;
    }
    toJSON() {
        return {
            e: this.#entries.map((e) => (e.v ? [e.rs, e.f, e.h, e.to ?? 0, e.v] : e.to ? [e.rs, e.f, e.h, e.to] : [e.rs, e.f, e.h])),
            k: Object.fromEntries([...this.#receipts].sort(([a], [b]) => (a < b ? -1 : 1))),
            ...(this.#seeded ? { j: Object.fromEntries([...this.#joined].sort(([a], [b]) => (a < b ? -1 : 1))) } : {}),
        };
    }
    get size() {
        return this.#entries.length;
    }
    record(entry) {
        const h = entry.h ?? Math.floor(this.#opts.now() / HOUR_MS);
        // 快取遞增：這一筆算在哪幾台（新記的帳一定還沒過期、也還沒被簽收）
        if (this.#usageCache)
            for (const [device, used] of this.#usageCache.used)
                if (this.#counts({ rs: 0, h, ...(entry.to ? { to: entry.to } : {}) }, device))
                    this.#usageCache.used.set(device, used + entry.f);
        this.#entries.push({ rs: entry.rs, f: entry.f, h, ...(entry.to ? { to: [...entry.to] } : {}), ...(entry.v && entry.v.length > 0 ? { v: entry.v } : {}) });
    }
    /**
     * 收到 `device` 的簽收單：記下區間。回傳這次**新**劃掉、帶版本的那幾筆的版本清單（每筆一組；給「對方已收到」用）。
     */
    receipt(device, ranges) {
        this.#version += 1;
        const before = this.#receipts.get(device) ?? [];
        let after = before;
        for (const [lo, hi] of ranges)
            if (lo >= 1 && lo <= hi)
                after = addRange(after, lo, hi);
        this.#receipts.set(device, after);
        const out = [];
        for (const e of this.#entries) {
            if (e.rs === 0 || !e.v || (e.to && !e.to.includes(device)))
                continue;
            if (coversRange(after, e.rs) && !coversRange(before, e.rs))
                out.push(e.v);
        }
        return out;
    }
    #live(e) {
        return (e.h + 1) * HOUR_MS + this.#opts.windowMs() > this.#opts.now();
    }
    #counts(e, device) {
        if (device === null)
            return true;
        if (e.to && !e.to.includes(device))
            return false;
        // 廣播的：它成為收件人之前送的沒有寄給它（SDK ADR 0107；同一個小時的照算）
        if (!e.to) {
            const joined = this.#joined.get(device);
            if (joined !== undefined && e.h < joined)
                return false;
        }
        return e.rs === 0 || !coversRange(this.#receipts.get(device), e.rs);
    }
    /** 送給 `device` 還沒簽收、還沒過期的塊數；`null`＝不分收件人（不知道有哪些收件人時，舊的一本帳） */
    used(device) {
        let used = 0;
        for (const e of this.#entries)
            if (this.#live(e) && this.#counts(e, device))
                used += e.f;
        return used;
    }
    /**
     * 再送 `frames` 塊給 `device` 要等多久才不超過 `budget`（只看過期；簽收單來了會更早）。
     * 帳是空的時候一律放行：一則比整份預算還大的訊息不能永遠卡住。
     */
    wait(device, frames, budget) {
        const counting = this.#entries.filter((e) => this.#live(e) && this.#counts(e, device));
        let used = 0;
        for (const e of counting)
            used += e.f;
        if (used === 0 || used + frames <= budget)
            return 0;
        const now = this.#opts.now();
        for (const e of counting) {
            used -= e.f;
            if (used === 0 || used + frames <= budget)
                return Math.max(1, (e.h + 1) * HOUR_MS + this.#opts.windowMs() - now);
        }
        return 1;
    }
    /** `device` 簽收過的序號區間（依序、不重疊；還用得到的部分，見 `prune`）；沒有簽收過是 undefined */
    receipts(device) {
        return this.#receipts.get(device);
    }
    /** 每位收件人一列（最滿的在前，同樣多依裝置 id） */
    usage(devices) {
        const key = `${this.#version}|${Math.floor(this.#opts.now() / HOUR_MS)}|${this.#opts.windowMs()}|${devices.join(',')}`;
        if (this.#usageCache?.key !== key)
            this.#usageCache = { key, used: new Map(devices.map((device) => [device, this.used(device)])) };
        return [...this.#usageCache.used].map(([device, used]) => ({ device, used })).sort((a, b) => b.used - a.used || (a.device < b.device ? -1 : 1));
    }
    /** 丟掉過期的、`devices`（目前的收件人）每一台都簽收了的；簽收區間只留還用得到的部分 */
    prune(devices) {
        this.#version += 1;
        this.#entries = this.#entries.filter((e) => {
            if (!this.#live(e))
                return false;
            if (e.rs === 0)
                return true;
            const targets = e.to ?? devices;
            return targets.length === 0 || targets.some((d) => !coversRange(this.#receipts.get(d), e.rs));
        });
        let min = Number.POSITIVE_INFINITY;
        for (const e of this.#entries)
            if (e.rs > 0 && e.rs < min)
                min = e.rs;
        for (const [device, ranges] of [...this.#receipts]) {
            const kept = ranges.filter(([, hi]) => hi >= min).map(([lo, hi]) => [Math.max(lo, min), hi]);
            if (kept.length > 0)
                this.#receipts.set(device, kept);
            else
                this.#receipts.delete(device);
        }
    }
    /** 筆數超過 `max` 時，最舊的併成每小時一筆沒有序號的廣播帳（只會多算、不會少算） */
    compact(max) {
        if (this.#entries.length <= max)
            return;
        this.#version += 1;
        const fold = this.#entries.length - Math.floor(max / 2);
        const byHour = new Map();
        for (const e of this.#entries.slice(0, fold))
            byHour.set(e.h, (byHour.get(e.h) ?? 0) + e.f);
        const folded = [...byHour].map(([h, f]) => ({ rs: 0, f, h }));
        this.#entries = [...folded, ...this.#entries.slice(fold)];
    }
}
//# sourceMappingURL=relay-ledger.js.map