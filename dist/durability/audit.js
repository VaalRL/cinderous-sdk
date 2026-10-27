const DEFAULT_BATCH = 64;
/** 依「最久沒更新」排序（沒給時間的最優先） */
function byStaleness(a, b) {
    return (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
}
function isAuditable(target, self) {
    if (target.type === 'addressable')
        return true;
    if (target.recipient !== undefined)
        return target.recipient === self;
    return (target.author ?? self) === self;
}
/** 一批目標 → filters（可尋址依 (kind, pubkey) 合併 `#d`；一般事件依 `authors`／`#p` 合併 `ids`） */
function filtersFor(batch, self) {
    const addressable = new Map();
    const byAuthor = [];
    const byRecipient = [];
    for (const target of batch) {
        if (target.type === 'addressable') {
            const key = `${target.kind}:${target.pubkey}`;
            const group = addressable.get(key) ?? { kind: target.kind, pubkey: target.pubkey, d: new Set() };
            group.d.add(target.d);
            addressable.set(key, group);
        }
        else if (target.recipient !== undefined)
            byRecipient.push(target.id);
        else
            byAuthor.push(target.id);
    }
    const filters = [...addressable.values()].map((g) => ({ kinds: [g.kind], authors: [g.pubkey], '#d': [...g.d], limit: g.d.size }));
    if (byAuthor.length > 0)
        filters.push({ ids: byAuthor, authors: [self], limit: byAuthor.length });
    if (byRecipient.length > 0)
        filters.push({ ids: byRecipient, '#p': [self], limit: byRecipient.length });
    return filters;
}
function dOf(event) {
    return event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
}
/**
 * 一次讀回稽核：抽樣（最久沒更新的優先）、分批、逐座查。只把「那一座完整回了 EOSE 而且沒有」算成遺失；
 * 逾時、被 CLOSED、斷線的中繼列在 `inconclusive`。
 */
export function auditOwnEvents(pool, targets, options) {
    return auditInOrder(pool, [...targets].sort(byStaleness), options);
}
/** 依給定順序抽樣（`auditOwnEvents` 先依最久沒更新排好；`OwnEventAuditor` 另外把剛查過的往後排） */
async function auditInOrder(pool, targets, options) {
    const { self } = options;
    const unauditable = targets.filter((t) => !isAuditable(t, self));
    const auditable = targets.filter((t) => isAuditable(t, self));
    const limit = options.sample === undefined ? auditable.length : Math.max(0, Math.floor(options.sample));
    const checked = auditable.slice(0, limit);
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH));
    const missing = new Map();
    const outdated = [];
    const inconclusive = new Map();
    const verified = [];
    for (let i = 0; i < checked.length; i += batchSize) {
        const batch = checked.slice(i, i + batchSize);
        const queryOptions = {
            ...(options.relays !== undefined ? { relays: options.relays } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        };
        const results = await pool.queryEach(filtersFor(batch, self), queryOptions);
        if (results.some((result) => result.status === 'eose'))
            verified.push(...batch);
        for (const result of results) {
            if (result.status !== 'eose') {
                if (!inconclusive.has(result.url)) {
                    inconclusive.set(result.url, { url: result.url, status: result.status, ...(result.reason !== undefined ? { reason: result.reason } : {}) });
                }
                continue;
            }
            const ids = new Set(result.events.map((e) => e.id));
            for (const target of batch) {
                if (target.type === 'event') {
                    if (!ids.has(target.id))
                        addMissing(missing, target, result.url);
                    continue;
                }
                const found = result.events
                    .filter((e) => e.kind === target.kind && e.pubkey === target.pubkey && dOf(e) === target.d)
                    .sort((a, b) => b.created_at - a.created_at)[0];
                if (found === undefined)
                    addMissing(missing, target, result.url);
                else if (target.createdAt !== undefined && found.created_at < target.createdAt && found.id !== target.id) {
                    outdated.push({ target, relay: result.url, found: { id: found.id, created_at: found.created_at } });
                }
            }
        }
    }
    const findings = [...missing].map(([target, relays]) => ({ target, relays }));
    if (options.markEvicted !== false && pool.markEvicted !== undefined) {
        for (const { target, relays } of findings) {
            const kind = target.kind;
            if (kind !== undefined)
                for (const url of relays)
                    pool.markEvicted(url, kind);
        }
        for (const { target, relay } of outdated)
            if (target.kind !== undefined)
                pool.markEvicted(relay, target.kind);
    }
    return {
        checked,
        verified,
        deferred: auditable.length - checked.length,
        unauditable,
        missing: findings,
        outdated,
        inconclusive: [...inconclusive.values()],
    };
}
function addMissing(map, target, url) {
    const list = map.get(target);
    if (list === undefined)
        map.set(target, [url]);
    else
        list.push(url);
}
/**
 * 有速率限制、會輪流的稽核器：每輪抽樣 `sample` 個，最久沒更新的優先，但剛查過的往後排；
 * 兩輪之間至少隔 `minIntervalMs`。同時只跑一輪（重複呼叫拿到同一個結果）。
 */
export class OwnEventAuditor {
    #opts;
    #now;
    #checkedAt = new Map();
    #lastRunAt;
    #running;
    constructor(opts) {
        this.#opts = opts;
        this.#now = opts.now ?? Date.now;
    }
    /** 下一輪最早什麼時候可以跑（毫秒） */
    nextRunAt() {
        return this.#lastRunAt === undefined ? 0 : this.#lastRunAt + (this.#opts.minIntervalMs ?? 10 * 60_000);
    }
    run(targets) {
        if (this.#running !== undefined)
            return this.#running;
        const now = this.#now();
        if (now < this.nextRunAt())
            return Promise.resolve({ skipped: 'rate-limited', nextRunAt: this.nextRunAt() });
        const previousRunAt = this.#lastRunAt;
        this.#lastRunAt = now;
        const recheck = this.#opts.recheckAfterMs ?? 6 * 60 * 60_000;
        const recent = (t) => {
            const at = this.#checkedAt.get(keyOf(t));
            return at !== undefined && now - at < recheck ? 1 : 0;
        };
        // 先排「最近沒查過」的，同一組內最久沒更新的優先
        const ordered = [...targets].sort((a, b) => recent(a) - recent(b) || byStaleness(a, b));
        const { pool, minIntervalMs: _i, recheckAfterMs: _r, now: _n, sample, ...rest } = this.#opts;
        const run = auditInOrder(pool, ordered, { ...rest, sample: sample ?? DEFAULT_BATCH })
            .then((report) => {
            // 只有真的有中繼回完的才算查過（G12a）；一個都沒查到時不佔速率限制，連上之後可以馬上再跑
            for (const target of report.verified)
                this.#checkedAt.set(keyOf(target), now);
            if (report.checked.length > 0 && report.verified.length === 0 && this.#lastRunAt === now)
                this.#lastRunAt = previousRunAt;
            return report;
        })
            .finally(() => {
            this.#running = undefined;
        });
        this.#running = run;
        return run;
    }
}
function keyOf(target) {
    return target.type === 'addressable' ? `a:${target.kind}:${target.pubkey}:${target.d}` : `e:${target.id}`;
}
//# sourceMappingURL=audit.js.map