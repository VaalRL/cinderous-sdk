import { openWrap, sealAndWrap, TIMESTAMP_JITTER_SECONDS } from '../protocol/nip59.js';
import { meetsDurability, reportPublishRejections } from '../publish-rejections.js';
import { publishPaced, RelayEventBudget, sharedRelayEventBudget } from '../relay-budget.js';
import { openRelayMoveEvent } from './relay-move.js';
/** 名單同步的內層 rumor kind（外層 1060 或 1059） */
export const VAULT_ROSTER_KIND = 4361;
/** 與檔案塊相同的外層 kind（不從 `./sync` 匯入，免得把同步零件拉進這個子路徑） */
const FILE_WRAP_KIND = 1060;
/** NIP-59 禮物包 */
const GIFT_WRAP_KIND = 1059;
export const DEFAULT_ROSTER_OUTER_KIND = FILE_WRAP_KIND;
function outerKindOf(kind) {
    if (kind === undefined)
        return DEFAULT_ROSTER_OUTER_KIND;
    if (kind !== GIFT_WRAP_KIND && kind !== FILE_WRAP_KIND)
        throw new RangeError(`名單的外層 kind 只能是 1059 或 1060（收到 ${String(kind)}）`);
    return kind;
}
export const DEFAULT_ROSTER_TTL_SECONDS = 7 * 86_400;
const SEEN = 1024;
/** 把完整名單包成給每位收件人的事件 */
export function buildRosterEvents(membership, signer, recipients, opts = {}) {
    const kind = outerKindOf(opts.outerKind);
    const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
    const content = JSON.stringify({ v: 1, roster: membership.roster() });
    const expiration = String(nowSec + (opts.ttlSeconds ?? DEFAULT_ROSTER_TTL_SECONDS));
    return recipients.map((to) => sealAndWrap({ kind: VAULT_ROSTER_KIND, created_at: nowSec, tags: [], content }, signer, to, {
        kind,
        tags: [
            ['p', to],
            ['expiration', expiration],
        ],
    }));
}
/**
 * 給被撤銷的裝置的通知（SDK ADR 0105）：一份精簡名單，只有它自己的撤銷紀錄與舊金鑰。
 * `excludeKeyIds`：它拿不到的金鑰（撤銷時輪換出來的新金鑰）。它不在撤銷紀錄裡、或扣掉之後沒有金鑰可放（名單格式至少要一把）時回 null。
 */
export function buildRevocationNotice(membership, signer, revoked, opts) {
    const full = membership.roster();
    const record = full.revoked.find((r) => r.pubkey === revoked);
    if (!record)
        return null;
    const exclude = new Set(opts.excludeKeyIds);
    const keys = full.keys.filter((k) => !exclude.has(k.id));
    if (keys.length === 0)
        return null;
    const roster = { v: full.v, vaultId: full.vaultId, devices: [], revoked: [record], keys };
    const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
    const expiration = String(nowSec + (opts.ttlSeconds ?? DEFAULT_ROSTER_TTL_SECONDS));
    return sealAndWrap({ kind: VAULT_ROSTER_KIND, created_at: nowSec, tags: [], content: JSON.stringify({ v: 1, roster }) }, signer, revoked, {
        kind: outerKindOf(opts.outerKind),
        tags: [
            ['p', revoked],
            ['expiration', expiration],
        ],
    });
}
/**
 * 解開名單事件；不是名單、解不開、格式不對、外層不是 `outerKind`（預設 1060）回 null
 *（不驗寄件人是否為成員，那是 `merge` 的事）
 */
export function openRosterEvent(event, signer, opts = {}) {
    if (event.kind !== outerKindOf(opts.outerKind))
        return null;
    try {
        const opened = openWrap(event, signer);
        if (opened.rumor.kind !== VAULT_ROSTER_KIND)
            return null;
        const body = JSON.parse(opened.rumor.content);
        if (body.v !== 1)
            return null;
        // 寄出時間：內層 rumor 的時間（外層被 NIP-59 往前推過）；SDK ADR 0053 §G17
        return { sender: opened.sender, roster: body.roster, sentAt: opened.rumor.created_at * 1000 };
    }
    catch {
        return null;
    }
}
/** 名單的收送。`start()` 後，名單變動會自動送出；收到其他成員的名單會自動合併。 */
export class NostrRosterSync {
    #opts;
    #outerKind;
    #budget;
    #seen = new Set();
    #sub;
    #started = false;
    #offChange;
    #offStatus;
    #sending = Promise.resolve();
    #pending = false;
    #retrying;
    constructor(opts) {
        this.#opts = opts;
        this.#outerKind = outerKindOf(opts.outerKind);
        this.#budget =
            opts.relayBudget ??
                (opts.eventsPerMinute !== undefined ? new RelayEventBudget({ perMinute: opts.eventsPerMinute }) : sharedRelayEventBudget(opts.signer.pubkey));
    }
    /** 這個同步器用的外層 kind */
    get outerKind() {
        return this.#outerKind;
    }
    /** 有沒有送不出去、還沒完整送達的名單變動（SDK ADR 0045，G12d） */
    get pending() {
        return this.#pending;
    }
    /** 訂閱、開始監聽名單變動；`announce` 為 true（預設）時先把目前的名單送一次（給離線超過中繼保留期的成員補齊） */
    start(opts = {}) {
        if (this.#started)
            return;
        this.#started = true;
        if (this.#opts.subscribe !== false)
            this.#sub = this.#opts.pool.subscribe(this.filters(), { onEvent: (event) => this.#ingest(event) });
        this.#offChange = this.#opts.membership.onChange((change) => this.#onChange(change));
        if (this.#opts.retryOnReconnect) {
            this.#offStatus = this.#opts.pool.onStatusChange?.((_url, status) => {
                if (status === 'open' && this.#pending)
                    void this.retryPending().catch(() => { });
            });
        }
        const store = this.#opts.pendingStore;
        if (store) {
            // 上次沒送到的標記：讀回來（讀到之前本次已經記下的不會被蓋掉）
            void Promise.resolve()
                .then(() => store.load())
                .then((pending) => {
                if (pending === true && this.#started)
                    this.#pending = true;
            })
                .catch((error) => this.#opts.onError?.(error));
        }
        if (opts.announce !== false)
            void this.announce().catch(() => { });
    }
    stop() {
        this.#started = false;
        this.#sub?.close();
        this.#sub = undefined;
        this.#offChange?.();
        this.#offChange = undefined;
        this.#offStatus?.();
        this.#offStatus = undefined;
    }
    /**
     * 有未送出的名單變動就重送整份名單（SDK ADR 0045，G12d）；回傳有沒有送。送不出去時 reject（標記留著）。
     * 同時呼叫共用同一次。
     */
    retryPending() {
        if (!this.#pending)
            return Promise.resolve(false);
        if (this.#retrying)
            return this.#retrying;
        const run = this.announce()
            .then(() => true)
            .finally(() => {
            this.#retrying = undefined;
        });
        this.#retrying = run;
        return run;
    }
    #setPending(pending) {
        if (this.#pending === pending)
            return;
        this.#pending = pending;
        const store = this.#opts.pendingStore;
        if (store) {
            void Promise.resolve()
                .then(() => store.save(pending))
                .catch((error) => this.#opts.onError?.(error));
        }
    }
    /** 1059、1060 都是會被倒填時間的 kind：`since` 往前退讓兩天，連線池補訂閱時也會（G8，SDK ADR 0035） */
    filters() {
        const filter = { kinds: [this.#outerKind], '#p': [this.#opts.signer.pubkey] };
        if (this.#opts.since !== undefined)
            filter.since = Math.max(0, this.#opts.since - TIMESTAMP_JITTER_SECONDS);
        return [filter];
    }
    /** 補拉到的事件（例如 `FastHydrator`）走同一條路 */
    ingestEvents(events) {
        for (const event of events)
            this.#ingest(event);
    }
    /** 把目前的名單送給所有有效的其他成員（或指定的收件人）。依序送出；每位收件人至少一座中繼接受才算成功。 */
    announce(recipients) {
        const toAll = recipients === undefined;
        const run = this.#sending.then(async () => {
            const m = this.#opts.membership;
            if (!m.active)
                return;
            const to = (recipients ?? m.peerPubkeys()).filter((pk) => m.isMember(pk) && pk !== m.self);
            if (to.length === 0)
                return;
            const events = buildRosterEvents(m, this.#opts.signer, to, {
                now: (this.#opts.now ?? Date.now)(),
                ttlSeconds: this.#opts.ttlSeconds,
                outerKind: this.#outerKind,
            });
            const failed = [];
            for (const [i, event] of events.entries()) {
                const durability = this.#opts.durability;
                const signed = event;
                // 同一身分的事件預算；限速就退避再重送（SDK ADR 0043）。沒設定耐久度時照舊只傳一個參數（v0.32 的呼叫形狀）
                const result = await publishPaced(this.#budget, () => (durability === undefined ? this.#opts.pool.publish(signed) : this.#opts.pool.publish(signed, { durability })), 
                // 部分拒收也回報（SDK ADR 0038 P0-C）；每一次嘗試都報（含之後重送成功的限速拒收）
                { done: (r) => meetsDurability(r, durability), onAttempt: (r) => reportPublishRejections(event.id, r, this.#opts.onPublishRejected) });
                if (!meetsDurability(result, durability))
                    failed.push(to[i]);
            }
            if (failed.length > 0)
                throw new Error(`名單送不出去（${failed.length} 台）`);
        });
        this.#sending = run.then(
        // 完整送給全部成員才清掉「未送出」標記；只送給指定收件人的不算（G12d）
        () => {
            if (toAll)
                this.#setPending(false);
        }, (error) => {
            this.#setPending(true);
            this.#opts.onError?.(error);
        });
        return run;
    }
    #onChange(change) {
        if (change.selfRevoked)
            return; // 被撤銷了：不再送任何東西
        // 這台撤銷的：通知被撤銷的裝置（SDK ADR 0105）。當下就包好——撤銷時輪換出來的新金鑰是現在的金鑰，不能放進去。
        // 從別台合併得知的撤銷不送（撤銷的那台送過了）
        if (change.reason === 'revoke' && change.revoked.length > 0)
            this.#notifyRevoked(change.revoked);
        void this.announce().catch(() => { });
    }
    #notifyRevoked(revoked) {
        const m = this.#opts.membership;
        const exclude = [m.currentKey().id];
        const now = (this.#opts.now ?? Date.now)();
        for (const pk of revoked) {
            const event = buildRevocationNotice(m, this.#opts.signer, pk, { excludeKeyIds: exclude, now, ttlSeconds: this.#opts.ttlSeconds, outerKind: this.#outerKind });
            if (!event)
                continue;
            const signed = event;
            const durability = this.#opts.durability;
            // 盡力而為：送不到只回報，不記成「有未送出的名單變動」（那是給還是成員的裝置的）
            void publishPaced(this.#budget, () => (durability === undefined ? this.#opts.pool.publish(signed) : this.#opts.pool.publish(signed, { durability })), { done: (r) => meetsDurability(r, durability), onAttempt: (r) => reportPublishRejections(event.id, r, this.#opts.onPublishRejected) }).catch((error) => this.#opts.onError?.(error));
        }
    }
    #ingest(event) {
        if (event.kind !== this.#outerKind || this.#seen.has(event.id))
            return;
        this.#seen.add(event.id);
        if (this.#seen.size > SEEN)
            this.#seen.delete(this.#seen.values().next().value);
        const opened = openRosterEvent(event, this.#opts.signer, { outerKind: this.#outerKind });
        if (!opened) {
            // 中繼搬家通知（SDK ADR 0052）：寄件人必須是本機名單上的有效成員（非成員偽造的不交出）
            const onMove = this.#opts.onRelayMove;
            if (!onMove && !this.#opts.onMemberActivity)
                return;
            const move = openRelayMoveEvent(event, this.#opts.signer, { outerKind: this.#outerKind });
            if (move && this.#opts.membership.isMember(move.sender)) {
                this.#activity(move.sender, move.at);
                onMove?.(move);
            }
            return;
        }
        // 合併之前先看：這則可能正好撤銷了寄件人以外的人，寄件人本身要是收到時的有效成員
        const member = this.#opts.membership.isMember(opened.sender);
        this.#opts.membership.merge(opened.roster, opened.sender);
        if (member)
            this.#activity(opened.sender, opened.sentAt);
    }
    #activity(pubkey, at) {
        const listener = this.#opts.onMemberActivity;
        if (!listener)
            return;
        const deviceId = this.#opts.membership.deviceIdOf(pubkey);
        try {
            listener({ pubkey, ...(deviceId !== undefined ? { deviceId } : {}), at });
        }
        catch (error) {
            this.#opts.onError?.(error);
        }
    }
}
//# sourceMappingURL=roster-sync.js.map