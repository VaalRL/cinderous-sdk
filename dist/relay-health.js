/**
 * 每座中繼的健康狀態（SDK ADR 0038 研究結果四 §2；實作見 ADR 0041）。
 *
 * 不是一個分數，而是依拒收分類（ADR 0040）記下「這一座對哪一類資料暫時不能用、到什麼時候」：
 *
 * | 分類 | 標記 | 範圍 | 多久 |
 * |---|---|---|---|
 * | `ceiling`／`quota` | `full`（已滿） | 那一類資料（離線留言／可尋址／可取代／ephemeral） | `fullMs`（預設 1 小時） |
 * | `policy`／`restricted`（`OK false`） | `inapplicable`（不適用） | 那個 kind | `inapplicableMs`（預設 24 小時，或 `reset`） |
 * | `too-large` | `inapplicable` | 那個 kind、**至少這麼大**的事件 | 同上 |
 * | `rate-limited` | `backoff` | 整座 | 到計數窗結束（`ip` 詞元 1 秒，其他 `rateLimitedMs` 預設 60 秒） |
 * | 關閉碼 1008 `rate-limited`／`too-many-connections` | `backoff` | 整座 | `rateLimitedMs` |
 * | 關閉碼 4003、1008 其他（車道被拒） | `inapplicable` | 整座 | `inapplicableMs` |
 * | 關閉碼 1013（`unavailable`：額度用完、儲存起不來；SDK ADR 0108） | `backoff` | 整座 | `unavailableMs`（預設 5 分鐘）；那一座回了 EOSE 就清掉 |
 * | 關閉碼 4429（`unavailable`，詞元 `iot-quota`：C′ 家庭今日額度用完；SDK ADR 0122） | `backoff` | 整座 | 到原因帶的重置時間（加最多 60 秒抖動、最多一天）；沒帶＝`unavailableMs` |
 * | `invalid`、`stale`、`pow`、`error`、`timeout`、`disconnected`、`auth-failed:` | 不標記（只記最近一次） | — | — |
 *
 * `invalid` 是自己的錯：換哪座都一樣，所以不標記、不改用、不重試。
 * 重新讀到 NIP-11 時（`revalidateRelay`，SDK ADR 0044），文件看得出原因已不成立的「不適用」立刻清掉
 *（`files-disabled` 而現在 `cinder_accepts_files: true`、`too-large` 而上限已不小於那顆、`not-allowed` 而 `restricted_writes: false`）。
 * 任何一次收下（含 `duplicate`）會清掉那一類的 `full` 與整座的 `backoff`——「任何一座收下就恢復」。
 *
 * **只記錄，不改變預設行為**：v0.32 的 `publish(event)` 照舊送給每一座開著的中繼；
 * 只有帶 `durability` 的發布（ADR 0041）才會略過被標記的中繼。
 *
 * 不持久化（ADR 0041 §2）：冷卻最長一天、中繼的狀態會自己變，重新啟動後頂多每座多挨一次拒收就重新學會；
 * 快照是純資料，應用要記錄或顯示可以自己存。
 *
 * **軟標記**（SDK ADR 0042）：`OK true "warning: near-full: <級>:"` 記在 `nearFull`（那一類資料、哪一級、何時），
 * `NOTICE "warning: dropped:"` 記在 `lastDropped`。兩者都**不是** `marks`，不影響發布、不讓 `durability` 略過那一座——
 * 事件收下了（耐久），只是提醒應用「這座快滿了」「有幾則在這座遺失了」。同一類資料下一次收下而沒帶預警就清掉 `nearFull`。
 */
import { classifyRelayMessage, RELAY_REJECT_TOKENS } from './protocol/relay-reject.js';
export const DEFAULT_RELAY_HEALTH_COOLDOWNS = Object.freeze({
    fullMs: 60 * 60_000,
    inapplicableMs: 24 * 60 * 60_000,
    rateLimitedMs: 60_000,
    unavailableMs: 5 * 60_000,
});
/** 每 IP 每秒的計數窗（`rate-limited: ip:`） */
const IP_WINDOW_MS = 1000;
/** 某個 kind 在中繼上屬於哪一類（NIP-01 的 kind 範圍） */
export function relayDataPlaneOf(kind) {
    if (kind >= 30_000 && kind < 40_000)
        return 'addressable';
    if (kind >= 20_000 && kind < 30_000)
        return 'ephemeral';
    if (kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000))
        return 'replaceable';
    return 'offline';
}
/** 連線池內部用；不從主入口匯出類別本身，只匯出型別與常數 */
export class RelayHealthTracker {
    #entries = new Map();
    #now;
    #cooldowns;
    #onChange;
    constructor(opts) {
        this.#now = opts.now ?? Date.now;
        this.#cooldowns = { ...DEFAULT_RELAY_HEALTH_COOLDOWNS, ...opts.cooldowns };
        this.#onChange = opts.onChange;
    }
    #entry(url) {
        let entry = this.#entries.get(url);
        if (entry === undefined) {
            entry = { marks: [] };
            this.#entries.set(url, entry);
        }
        return entry;
    }
    /** 還有效的標記（順手清掉過期的） */
    marks(url) {
        const entry = this.#entries.get(url);
        if (entry === undefined)
            return [];
        const now = this.#now();
        entry.marks = entry.marks.filter((mark) => mark.until > now);
        return entry.marks;
    }
    snapshot(url) {
        const marks = [...this.marks(url)];
        const entry = this.#entries.get(url);
        return {
            marks,
            ...(entry?.lastRejection !== undefined ? { lastRejection: { ...entry.lastRejection } } : {}),
            ...(entry?.lastAcceptedAt !== undefined ? { lastAcceptedAt: entry.lastAcceptedAt } : {}),
            ...(entry?.lastBorrowedAt !== undefined ? { lastBorrowedAt: entry.lastBorrowedAt } : {}),
            ...(entry?.nearFull !== undefined && entry.nearFull.size > 0 ? { nearFull: [...entry.nearFull.values()] } : {}),
            ...(entry?.lastDropped !== undefined ? { lastDropped: { ...entry.lastDropped } } : {}),
        };
    }
    /**
     * 收下時的預警（SDK ADR 0042）：`percent` 有值＝這一類資料快滿了（軟標記）；undefined＝這次收下沒帶預警，清掉那一類的軟標記。
     * 只在出現、級數改變或清掉時通知。
     */
    nearFull(url, eventKind, percent) {
        const plane = relayDataPlaneOf(eventKind);
        const entry = percent === undefined ? this.#entries.get(url) : this.#entry(url);
        if (entry === undefined)
            return;
        const prev = entry.nearFull?.get(plane);
        if (percent === undefined) {
            if (prev === undefined)
                return;
            entry.nearFull.delete(plane);
            this.#onChange(url);
            return;
        }
        (entry.nearFull ??= new Map()).set(plane, { plane, percent, at: this.#now() });
        if (prev?.percent !== percent)
            this.#onChange(url);
    }
    /** 中繼說有幾則寄給你的留言在送到之前被刪掉了（`NOTICE "warning: dropped:"`；SDK ADR 0042） */
    dropped(url, notice) {
        this.#entry(url).lastDropped = { count: notice.count, since: notice.since, until: notice.until, at: this.#now() };
        this.#onChange(url);
    }
    /** 這一座現在該不該收到這一則（kind、大小）；該略過就回造成略過的標記 */
    blocking(url, eventKind, bytes) {
        const plane = relayDataPlaneOf(eventKind);
        return this.marks(url).find((mark) => mark.scope === '*' ||
            mark.scope === plane ||
            (mark.scope === `kind:${eventKind}` && (mark.minBytes === undefined || bytes >= mark.minBytes)));
    }
    /** 一次拒收（或帶關閉碼的斷線） */
    observe(url, o) {
        const entry = this.#entry(url);
        const now = this.#now();
        entry.lastRejection = { kind: o.kind, reason: o.reason, at: now };
        const c = this.#cooldowns;
        let scope;
        let state;
        let ms = 0;
        let minBytes;
        const kindScope = o.eventKind === undefined ? undefined : `kind:${o.eventKind}`;
        if (o.source === 'close') {
            scope = '*';
            if (o.kind === 'rate-limited' || /too-many-connections/i.test(o.reason))
                [state, ms] = ['backoff', c.rateLimitedMs];
            else if (o.kind === 'unavailable')
                [state, ms] = ['backoff', c.unavailableMs];
            else if (o.kind === 'restricted' || o.kind === 'policy' || o.kind === 'invalid')
                [state, ms] = ['inapplicable', c.inapplicableMs];
            else
                scope = undefined;
        }
        else if (o.kind === 'ceiling' || o.kind === 'quota') {
            if (o.eventKind !== undefined)
                [scope, state, ms] = [relayDataPlaneOf(o.eventKind), 'full', c.fullMs];
        }
        else if (o.kind === 'rate-limited') {
            [scope, state, ms] = ['*', 'backoff', o.token === 'ip' ? IP_WINDOW_MS : c.rateLimitedMs];
        }
        else if (o.kind === 'policy' || o.kind === 'restricted') {
            // `auth-failed:`（AUTH 事件本身被拒：時鐘、挑戰、relay tag）多半是暫時的，不標記；白名單外是 `restricted: not-allowed:`
            if (kindScope !== undefined && !/^auth-failed:/i.test(o.reason))
                [scope, state, ms] = [kindScope, 'inapplicable', c.inapplicableMs];
        }
        else if (o.kind === 'too-large') {
            if (kindScope !== undefined)
                [scope, state, ms, minBytes] = [kindScope, 'inapplicable', c.inapplicableMs, o.bytes];
        }
        if (scope === undefined || state === undefined)
            return;
        const existing = entry.marks.find((mark) => mark.scope === scope && mark.until > now);
        const mark = {
            scope,
            state,
            kind: o.kind,
            reason: o.reason,
            since: existing?.since ?? now,
            until: o.until !== undefined && o.until > now ? o.until : now + ms,
            ...(minBytes !== undefined ? { minBytes: Math.min(minBytes, existing?.minBytes ?? Infinity) } : {}),
        };
        entry.marks = [...entry.marks.filter((m) => m.scope !== scope && m.until > now), mark];
        // 同一個標記只是延長：不再通知（全部都滿時只回報一次，ADR 0038 §4）
        if (existing === undefined || existing.state !== state)
            this.#onChange(url);
    }
    /** 收下了（`borrowed`＝只是借用）：清掉那一類的 `full` 與整座的 `backoff`（借用不清 `full`） */
    accepted(url, eventKind, borrowed = false) {
        const entry = this.#entry(url);
        const now = this.#now();
        if (borrowed)
            entry.lastBorrowedAt = now;
        else
            entry.lastAcceptedAt = now;
        const plane = relayDataPlaneOf(eventKind);
        entry.marks = entry.marks.filter((mark) => mark.until > now);
        const before = entry.marks.length;
        entry.marks = entry.marks.filter((mark) => !(mark.scope === '*' && mark.state === 'backoff') &&
            !(!borrowed && mark.scope === plane) &&
            !(!borrowed && mark.scope === `kind:${eventKind}` && mark.minBytes === undefined));
        if (entry.marks.length !== before)
            this.#onChange(url);
    }
    /** 那一座回了 EOSE（能正常服務了）：清掉「暫時不能用」的標記（SDK ADR 0108） */
    served(url) {
        const entry = this.#entries.get(url);
        if (entry === undefined || !entry.marks.some((mark) => mark.kind === 'unavailable'))
            return;
        entry.marks = entry.marks.filter((mark) => mark.kind !== 'unavailable');
        this.#onChange(url);
    }
    /** 讀回稽核發現某座弄丟了自己的事件：把那一類標成已滿（ADR 0038 M4「發現遺失之後」） */
    markEvicted(url, eventKind) {
        this.observe(url, { kind: 'ceiling', reason: 'evicted: 讀回稽核發現事件已不在這座中繼', eventKind, source: 'ok' });
    }
    /** 清掉某座（或全部）的標記：設定改了、重新讀過 NIP-11 之後。`filter` 只清符合的（範圍、狀態；SDK ADR 0044） */
    reset(url, filter = {}) {
        const urls = url === undefined ? [...this.#entries.keys()] : [url];
        for (const u of urls) {
            const entry = this.#entries.get(u);
            if (entry === undefined || entry.marks.length === 0)
                continue;
            const before = entry.marks.length;
            entry.marks = entry.marks.filter((mark) => !((filter.scope === undefined || mark.scope === filter.scope) && (filter.state === undefined || mark.state === filter.state)));
            if (entry.marks.length !== before)
                this.#onChange(u);
        }
    }
    /**
     * 重新讀到這座的 NIP-11（SDK ADR 0044）：清掉「文件已表示原因不成立」的不適用標記，回傳清掉的那些（有清才通知）。
     * 只清在 `observedAt`（讀文件的時間）**之前**出現的標記——讀到之後才被拒，代表文件與實際不符，不清。
     */
    revalidate(url, info, observedAt = this.#now()) {
        const entry = this.#entries.get(url);
        if (entry === undefined)
            return [];
        const facts = relayInfoFacts(info);
        if (facts === undefined)
            return [];
        const live = this.marks(url);
        const cleared = live.filter((mark) => mark.since <= observedAt && markResolvedBy(mark, facts));
        if (cleared.length === 0)
            return [];
        entry.marks = live.filter((mark) => !cleared.includes(mark));
        this.#onChange(url);
        return cleared;
    }
}
const finitePositive = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
const bool = (x) => (typeof x === 'boolean' ? x : undefined);
/** 原始 NIP-11（`cinder_accepts_files`、`limitation.*`）與 `fetchRelayFilePolicy` 的結果（`acceptsFiles` 等）都收；不是物件回 undefined */
function relayInfoFacts(info) {
    if (typeof info !== 'object' || info === null || Array.isArray(info))
        return undefined;
    const doc = info;
    const limitation = typeof doc.limitation === 'object' && doc.limitation !== null ? doc.limitation : {};
    const acceptsFiles = bool(doc.cinder_accepts_files) ?? bool(doc.acceptsFiles);
    const maxMessageLength = finitePositive(limitation.max_message_length) ?? finitePositive(doc.maxMessageLength);
    const addressableMaxBytes = finitePositive(doc.cinder_addressable_max_bytes) ?? finitePositive(doc.addressableMaxBytes);
    const restrictedWrites = bool(limitation.restricted_writes) ?? bool(doc.restrictedWrites);
    return {
        ...(acceptsFiles !== undefined ? { acceptsFiles } : {}),
        ...(maxMessageLength !== undefined ? { maxMessageLength } : {}),
        ...(addressableMaxBytes !== undefined ? { addressableMaxBytes } : {}),
        ...(restrictedWrites !== undefined ? { restrictedWrites } : {}),
    };
}
/** 檔案塊（kind 1060）：Vault 同步與檔案車道的外層 */
const FILE_WRAP_KIND = 1060;
/** 拒收原因是不是「檔案事件未啟用」：`blocked: files-disabled:`，或舊中繼的 `blocked:` 前綴並提到 `MAX_FILE_MB` */
function isFilesDisabled(reason) {
    const klass = classifyRelayMessage(reason);
    return klass.prefix === 'blocked' && (klass.token === RELAY_REJECT_TOKENS.filesDisabled || /MAX_FILE_MB/.test(reason));
}
/**
 * 文件是否表示這個「不適用」的原因已不成立（SDK ADR 0044）。只認得看得出來的：
 * - `files-disabled`（kind 1060）＋ `cinder_accepts_files: true`；
 * - `too-large`（不含 1060：檔案塊的單顆上限沒有宣告）＋ 宣告的上限都不小於被拒的那顆；
 * - `not-allowed`（白名單外）＋ `limitation.restricted_writes: false`。
 * `kind-disabled`（NIP-11 沒有停用 kind 的欄位）、已滿、限速、整座的關閉碼都不動。
 */
function markResolvedBy(mark, facts) {
    if (mark.state !== 'inapplicable' || !mark.scope.startsWith('kind:'))
        return false;
    const eventKind = Number(mark.scope.slice('kind:'.length));
    if (mark.kind === 'too-large') {
        if (eventKind === FILE_WRAP_KIND || mark.minBytes === undefined)
            return false;
        const limits = [facts.maxMessageLength, relayDataPlaneOf(eventKind) === 'addressable' ? facts.addressableMaxBytes : undefined].filter((x) => x !== undefined);
        return limits.length > 0 && limits.every((limit) => limit >= mark.minBytes);
    }
    if (mark.kind !== 'policy' && mark.kind !== 'restricted')
        return false;
    if (eventKind === FILE_WRAP_KIND && isFilesDisabled(mark.reason))
        return facts.acceptsFiles === true;
    if (classifyRelayMessage(mark.reason).token === RELAY_REJECT_TOKENS.notAllowed)
        return facts.restrictedWrites === false;
    return false;
}
//# sourceMappingURL=relay-health.js.map