import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { buildInboxAck, INBOX_ACK_MAX_IDS } from '../../protocol/inbox-ack.js';
import { openWrap, sealAndWrap, TIMESTAMP_JITTER_SECONDS } from '../../protocol/nip59.js';
import { durabilityShortfall, meetsDurability, reportPublishRejections } from '../../publish-rejections.js';
import { publishPaced, RelayEventBudget, sharedRelayEventBudget } from '../../relay-budget.js';
import { FILE_CHUNK_BYTES, FILE_WRAP_KIND, RELAY_FILE_MAX_BYTES_CAP } from '../file-relay.js';
import { forEachPage, RelayQueryIncompleteError } from '../hydrator.js';
import { decodeVaultMessage, encodeVaultMessage } from './codec.js';
import { isFileEventsDisabledReason, RelayRejectsFilesError, RelaysFullError } from './relay-check.js';
/** 協調器訊框的內層 rumor kind（外層仍是 1060）。舊客戶端不認得，直接略過。 */
export const VAULT_OP_KIND = 4360;
/** 每個訊框的位元組上限（明文），與檔案塊相同 */
export const VAULT_FRAME_BYTES = FILE_CHUNK_BYTES;
/** 中繼保留多久（秒）：與檔案塊相同，7 天 */
export const DEFAULT_VAULT_TTL_SECONDS = 7 * 86_400;
/** 補拉每一頁的逾時（以「多久沒有新資料」計；SDK ADR 0077）：實測中繼準備 151 則／15.9 MB 的一頁要約 8 秒才送出第一則 */
export const BACKFILL_PAGE_TIMEOUT_MS = 30_000;
/**
 * 一則訊息最多幾個訊框（收端防禦）：經中繼的絕對上限（64 MiB）的內容＋1 MiB 標頭 ⇒ 1,420 個。
 * v0.24 以前以 16.5 MB 為準（381 個）；30 MB 的檔案要 656 個（SDK ADR 0029）。
 */
export const VAULT_MAX_FRAMES = Math.ceil((RELAY_FILE_MAX_BYTES_CAP + 1024 * 1024) / VAULT_FRAME_BYTES);
const MAX_FRAMES = VAULT_MAX_FRAMES;
const MAX_ASSEMBLIES = 64;
/** 重組中的訊框總共最多佔多少記憶體（超過就丟最舊的重組；正在重組的那一則不算在內） */
const MAX_ASSEMBLY_BYTES = 64 * 1024 * 1024;
const ASSEMBLY_TTL_MS = 30 * 60 * 1000;
const SEEN_EVENTS = 4096;
/** 還沒有監聽者時最多留幾則、多少位元組（SDK ADR 0075）；超過丟最舊的（沒確認，下次啟動再收） */
const MAX_EARLY_MESSAGES = 10_000;
const MAX_EARLY_BYTES = 64 * 1024 * 1024;
const HEX32 = /^[0-9a-f]{32}$/;
/** 收件確認：沒滿也在這麼久之內送出（毫秒；SDK ADR 0067 §3） */
export const INBOX_ACK_FLUSH_MS = 5 * 60_000;
/** 還沒送出的確認最多留幾個（沒有宣告的中繼、送不出去時不無限累積；丟最舊的，它們只是放滿保存期） */
const ACK_PENDING_MAX = 10 * INBOX_ACK_MAX_IDS;
function b64encode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
function b64decode(s) {
    try {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1)
            out[i] = bin.charCodeAt(i);
        return out;
    }
    catch {
        return null;
    }
}
function parseFrame(content) {
    try {
        const raw = JSON.parse(content);
        if (typeof raw.m !== 'string' || !HEX32.test(raw.m))
            return null;
        if (!Number.isInteger(raw.i) || !Number.isInteger(raw.n))
            return null;
        const i = raw.i;
        const n = raw.n;
        if (n < 1 || n > MAX_FRAMES || i < 0 || i >= n)
            return null;
        if (typeof raw.d !== 'string' || raw.d.length > Math.ceil(VAULT_FRAME_BYTES / 3) * 4 + 4)
            return null;
        const d = b64decode(raw.d);
        if (!d || d.length > VAULT_FRAME_BYTES)
            return null;
        return { m: raw.m, i, n, d };
    }
    catch {
        return null;
    }
}
/** 把一則訊息切成訊框（純函式，測試與自訂傳輸層也可以用） */
export function frameVaultMessage(message, messageId = bytesToHex(randomBytes(16))) {
    const bytes = encodeVaultMessage(message);
    const n = Math.max(1, Math.ceil(bytes.length / VAULT_FRAME_BYTES));
    const out = [];
    for (let i = 0; i < n; i += 1) {
        out.push(JSON.stringify({ m: messageId, i, n, d: b64encode(bytes.subarray(i * VAULT_FRAME_BYTES, (i + 1) * VAULT_FRAME_BYTES)) }));
    }
    return out;
}
/** 經 Nostr 中繼（kind 1060）收送協調器訊息。 */
export class NostrVaultTransport {
    #opts;
    #devices;
    #trusted;
    #now;
    #budget;
    #messageListeners = new Set();
    #statusListeners = new Set();
    /** 重組中的訊息；`ids`＝已收到的訊框的外層事件 id（收件確認用，SDK ADR 0067） */
    #assemblies = new Map();
    /** 處理完、還沒送出確認的外層 id（插入順序＝先來先送） */
    #ackPending = new Set();
    #ackRelays;
    #ackBatch;
    #ackTimer;
    #acking;
    #assemblyBytes = 0;
    #seen = new Set();
    /** 還沒有監聽者時收到的訊息（SDK ADR 0075），第一個監聽者註冊時交出 */
    #early = [];
    #earlyBytes = 0;
    #flushingEarly = false;
    #sub;
    #offPool;
    #offHealth;
    /** 主要中繼連不上、這一輪改用備援（SDK ADR 0093） */
    #fallback = false;
    #online;
    /** 下一次補拉的起點（秒）；成功補拉後前進到那一次開始的時間 */
    #backfillSince;
    #backfilling;
    /**
     * 這次啟動還沒從頭讀過收件匣（SDK ADR 0084）：應用通常把上次同步的時間當起點傳進來，一直續讀就永遠觸發不了 ADR 0081 的
     * 「收不齊也確認」。所以每個傳輸層（每次啟動）在有中繼宣告收件確認時，先不帶起點補拉一次。
     */
    #wholePending = true;
    constructor(opts) {
        this.#opts = opts;
        this.#devices = [...new Set(opts.devices)];
        this.#trusted = new Set(opts.trusted ?? [...opts.devices, opts.signer.pubkey]);
        this.#now = opts.now ?? (() => Date.now());
        this.#budget =
            opts.relayBudget ??
                (opts.eventsPerMinute !== undefined ? new RelayEventBudget({ perMinute: opts.eventsPerMinute }) : sharedRelayEventBudget(opts.signer.pubkey));
        if (opts.relayInfo !== undefined)
            this.#budget.applyRelayInfo(opts.relayInfo);
        this.#online = this.#computeOnline();
        this.#backfillSince = opts.since;
        this.#ackRelays = [...(opts.inboxAckRelays ?? [])];
        const batch = Math.floor(opts.inboxAckBatch ?? INBOX_ACK_MAX_IDS);
        this.#ackBatch = Number.isFinite(batch) ? Math.min(INBOX_ACK_MAX_IDS, Math.max(1, batch)) : INBOX_ACK_MAX_IDS;
    }
    /** 換成新的「宣告了收件確認的中繼」（SDK ADR 0067 §2）；有留著的確認就排一次送出 */
    setInboxAckRelays(urls) {
        this.#ackRelays = [...new Set(urls)];
        if (this.#ackPending.size > 0)
            this.#scheduleAck();
        // 宣告收件確認的中繼常在啟動之後才查到（NIP-11）：一到手就補做這次啟動的從頭補拉（SDK ADR 0084）
        if (this.#wholePending && this.#canAck() && this.#sub && this.#online)
            void this.backfill().catch(() => { });
    }
    /** 確認送得出去嗎：沒關掉收件確認、而且至少一座中繼宣告了 */
    #canAck() {
        return this.#opts.inboxAck !== false && this.#ackRelays.length > 0;
    }
    /**
     * 現在就把處理完的 id 送出確認（SDK ADR 0067 §3）：每則最多 {@link INBOX_ACK_MAX_IDS} 個、只送給宣告了的中繼。
     * 沒有宣告的中繼、或沒有一座收下時留著下次再送。同時呼叫多次共用同一輪。平常不必呼叫：滿 500 個、
     * 每 5 分鐘、補拉完成、`stop()` 時都會自動送。
     */
    flushInboxAcks() {
        if (this.#ackTimer !== undefined)
            clearTimeout(this.#ackTimer);
        this.#ackTimer = undefined;
        this.#acking ??= this.#sendAcks().finally(() => {
            this.#acking = undefined;
            // 送不出去的留著：排下一次（還在跑才排；`stop()` 之後不再排）
            if (this.#ackPending.size > 0 && this.#sub)
                this.#scheduleAck();
        });
        return this.#acking;
    }
    async #sendAcks() {
        while (this.#ackPending.size > 0 && this.#ackRelays.length > 0) {
            const batch = [...this.#ackPending].slice(0, this.#ackBatch);
            const relays = this.#ackRelays;
            const event = buildInboxAck(batch, this.#opts.signer, { created_at: Math.floor(this.#now() / 1000) });
            let accepted = false;
            try {
                const result = await publishPaced(this.#budget, () => this.#opts.pool.publish(event, { relays }));
                accepted = result.accepted.length > 0;
            }
            catch {
                accepted = false;
            }
            if (!accepted)
                return; // 留著，下次再送
            for (const id of batch)
                this.#ackPending.delete(id);
        }
    }
    /** 處理完的訊息：記下它的外層 id，滿一批就送、否則排定時送出 */
    #processed(ids) {
        if (this.#opts.inboxAck === false)
            return;
        for (const id of ids)
            this.#ackPending.add(id);
        while (this.#ackPending.size > ACK_PENDING_MAX)
            this.#ackPending.delete(this.#ackPending.values().next().value);
        if (this.#ackPending.size >= this.#ackBatch && this.#ackRelays.length > 0)
            void this.flushInboxAcks();
        else
            this.#scheduleAck();
    }
    #scheduleAck() {
        if (this.#ackTimer !== undefined || this.#ackRelays.length === 0)
            return;
        const timer = setTimeout(() => {
            this.#ackTimer = undefined;
            void this.flushInboxAcks();
        }, INBOX_ACK_FLUSH_MS);
        // 不為了送確認讓 Node 行程撐著不結束（`stop()` 會先送一次）
        timer.unref?.();
        this.#ackTimer = timer;
    }
    /**
     * 換成新的裝置名單（SDK ADR 0028：配對加入、撤銷後由 `VaultMembership` 的 `change` 呼叫）。
     * 之後送出的訊息只給新名單上的裝置、只收新信任名單的寄件人；`trusted` 省略時＝`devices` 加上自己。
     */
    setDevices(devices, trusted) {
        this.#devices = [...new Set(devices)];
        this.#trusted = new Set(trusted ?? [...devices, this.#opts.signer.pubkey]);
    }
    /** 訂閱 `{kinds:[1060], #p:[我]}`。 */
    start() {
        if (this.#sub)
            return;
        this.#sub = this.#opts.pool.subscribe(this.filters(), { onEvent: (event) => this.#ingest(event) });
        this.#offPool = this.#opts.pool.onStatusChange?.(() => this.#refreshOnline());
        this.#offHealth = this.#opts.pool.onRelayHealthChange?.(() => this.#refreshOnline());
        this.#refreshOnline();
        // 一座都沒連上就不補拉（SDK ADR 0080）：連上時 #refreshOnline 會補拉；否則這次查詢要等到逾時才失敗，
        // 期間應用的補拉都共用它（`#backfilling`），連上後的第一次補拉就白費了
        if (this.#online)
            void this.backfill().catch(() => { });
    }
    stop() {
        this.#sub?.close();
        this.#sub = undefined;
        this.#offPool?.();
        this.#offPool = undefined;
        this.#offHealth?.();
        this.#offHealth = undefined;
        // 停之前把處理完的確認送出去（盡力；送不出去的就讓那幾顆放滿保存期）
        if (this.#ackPending.size > 0)
            void this.flushInboxAcks();
        else if (this.#ackTimer !== undefined) {
            clearTimeout(this.#ackTimer);
            this.#ackTimer = undefined;
        }
    }
    /** 給 `FastHydrator` 用的過濾條件（喚醒時補拉） */
    filters() {
        const filter = { kinds: [FILE_WRAP_KIND], '#p': [this.#opts.signer.pubkey] };
        if (this.#opts.since !== undefined)
            filter.since = Math.max(0, this.#opts.since - TIMESTAMP_JITTER_SECONDS);
        return [filter];
    }
    /**
     * 以 `until` 分頁補拉離線期間的歷史（SDK ADR 0029），回傳拿到幾則。連上時（`start()` 時已經連上，或之後連上）會自動呼叫（SDK ADR 0080）。
     *
     * 為什麼常駐訂閱不夠：中繼一次 REQ 回傳的量有上限（Cinderous ADR-0371：16 MB，約 120 顆檔案塊），
     * 而且不會說被截斷了——離線一陣子回來、名下積了幾百塊時，訂閱只拿得到最新的那一段。
     * （v0.30 起連線池補訂閱時對 1060 自動往前退讓兩天，重連之後的即時事件不再被 since 擋掉（SDK ADR 0035）；
     * 但那一次 REQ 仍受中繼的位元組預算限制，離線期間積下來、被截掉的較舊事件要靠這裡分頁補齊。）
     * 沒有 `pool.query`（自訂的連線池）或 `backfillPages: 0` 時什麼都不做。
     *
     * 沒有任何中繼完成查詢（都沒開、逾時、查到一半全部斷線；SDK ADR 0045，G12a）時**不推進起點**，並以
     * `RelayQueryIncompleteError` reject（v0.35 以前會回 0 並把起點推到現在，之前的訊息永遠補不回來）。
     */
    backfill() {
        const pages = this.#opts.backfillPages;
        const pool = this.#opts.pool;
        const query = pool.query?.bind(pool);
        if (!query || pages === 0)
            return Promise.resolve(0);
        if (this.#backfilling)
            return this.#backfilling;
        const startedAt = Math.floor(this.#now() / 1000);
        const filter = { kinds: [FILE_WRAP_KIND], '#p': [this.#opts.signer.pubkey] };
        // 這次啟動的第一次（有中繼能確認時）不帶起點：讀過整個收件匣，收不齊的才確認得掉（SDK ADR 0084）。
        // 確認不了的話從頭讀只是白白下載，照舊從起點讀。
        const fromStart = this.#wholePending && this.#canAck();
        if (this.#backfillSince !== undefined && !fromStart)
            filter.since = Math.max(0, this.#backfillSince - TIMESTAMP_JITTER_SECONDS);
        // 沒有起點＝這次會讀過整個收件匣（SDK ADR 0081）
        const whole = filter.since === undefined;
        const queryResult = pool.queryResult
            ? async (filters, timeoutMs) => {
                // 改用備援時不等主要中繼開（它連不上），直接查開著的備援
                const result = await pool.queryResult(filters, timeoutMs, this.#fallback ? { waitForPrimary: false } : undefined);
                // 改用備援的這一輪：備援回完也算回完（平常 `answered` 只算主要中繼，SDK ADR 0093）
                return this.#fallback ? { ...result, answered: result.relays.filter((r) => r.status === 'eose').length } : result;
            }
            : pool.status
                ? async (filters, timeoutMs) => {
                    const events = await query(filters, timeoutMs);
                    // 只有 query 的自訂池：查完時一座都沒開＝沒有中繼回完（盡力判斷）
                    return { events, answered: this.#computeOnline() ? 1 : 0, relays: [] };
                }
                : undefined;
        const run = forEachPage({ query, ...(queryResult ? { queryResult } : {}) }, [filter], (events) => this.ingestEvents(events), {
            timeoutMs: this.#opts.backfillTimeoutMs ?? BACKFILL_PAGE_TIMEOUT_MS,
            ...(pages !== undefined ? { maxPages: pages } : {}),
        })
            .then((result) => {
            if (result.unanswered)
                throw new RelayQueryIncompleteError(result.relays ?? []);
            // 有中繼回完就算這次啟動從頭讀過了——撞到頁數上限也不反覆從頭（每次都整個收件匣重下載太貴）
            if (whole)
                this.#wholePending = false;
            // 撞到頁數上限就不前進（下次從同一個起點再翻），否則沒拿到的那些會被 since 永遠跳過
            if (result.complete)
                this.#backfillSince = startedAt;
            // 整個收件匣都讀過還收不齊的訊框：缺的不在任何一座回完的中繼上，永遠重組不起來（SDK ADR 0081）
            if (result.complete && whole)
                this.#ackOrphans();
            // 補拉完：這一輪處理完的一起確認（SDK ADR 0067 §3）
            if (this.#ackPending.size > 0)
                void this.flushInboxAcks();
            return result.events;
        })
            .finally(() => {
            this.#backfilling = undefined;
        });
        this.#backfilling = run;
        return run;
    }
    /** 交給 `FastHydrator` 的 `onEvents`：補拉到的事件走同一條路（重複的會被去重） */
    ingestEvents(events) {
        for (const event of events)
            this.#ingest(event);
    }
    /**
     * 依 `options` 送（SDK ADR 0058）：給了 `deviceOf` 才做得到（收件人的公鑰要對得上協調器的 deviceId）——
     * `to` 只送給那些裝置、`omitContentFor` 對那些裝置拿掉內容（只帶版本資訊）。
     */
    get targeted() {
        return this.#opts.deviceOf !== undefined;
    }
    /** 目前的收件裝置（deviceId；SDK ADR 0068）：給了 `deviceOf` 才知道 */
    recipients() {
        const deviceOf = this.#opts.deviceOf;
        if (!deviceOf)
            return undefined;
        return this.#devices.map((pk) => deviceOf(pk)).filter((d) => d !== undefined);
    }
    async send(message, options) {
        if (this.#devices.length === 0)
            return;
        const deviceOf = this.#opts.deviceOf;
        const to = deviceOf && options?.to ? new Set(options.to) : undefined;
        const omit = deviceOf && options?.omitContentFor && message.type === 'node' && message.content ? new Set(options.omitContentFor) : undefined;
        const recipients = to ? this.#devices.filter((pk) => to.has(deviceOf(pk) ?? '')) : this.#devices;
        let full;
        let trimmed;
        const nowSec = Math.floor(this.#now() / 1000);
        const expiration = nowSec + (this.#opts.ttlSeconds ?? DEFAULT_VAULT_TTL_SECONDS);
        for (const device of recipients) {
            // 輕量成員、範圍外：只帶版本資訊（每個收件人本來就各自一份禮物包）
            const strip = omit !== undefined && omit.has(deviceOf(device) ?? '');
            let frames;
            if (strip) {
                const { content: _content, ...meta } = message;
                frames = trimmed ??= frameVaultMessage(meta);
            }
            else
                frames = full ??= frameVaultMessage(message);
            for (const content of frames) {
                const event = sealAndWrap({ kind: VAULT_OP_KIND, created_at: nowSec, tags: [], content }, this.#opts.signer, device, {
                    kind: FILE_WRAP_KIND,
                    tags: [
                        ['p', device],
                        ['expiration', String(expiration)],
                    ],
                });
                const configured = this.#opts.durability;
                // 改用備援的這一輪：主要中繼只是沒連線也補發到備援（SDK ADR 0093）
                const durability = configured !== undefined && this.#fallback ? { ...configured, standbyWhenDisconnected: true } : configured;
                // 先取同一身分的事件預算；中繼說限速就退避到計數窗結束再重送這一顆（SDK ADR 0043）。
                // 沒設定耐久度時照舊只傳一個參數（v0.32 的呼叫形狀）
                const result = await publishPaced(this.#budget, () => (durability === undefined ? this.#opts.pool.publish(event) : this.#opts.pool.publish(event, { durability })), 
                // 部分拒收也回報（SDK ADR 0038 P0-C）；每一次嘗試都報（含之後重送成功的限速拒收）
                { done: (r) => meetsDurability(r, durability), onAttempt: (r) => reportPublishRejections(event.id, r, this.#opts.onPublishRejected) });
                if (!meetsDurability(result, durability)) {
                    // 被健康狀態略過的中繼不在 `rejected` 裡，但它的原因（例如檔案事件未啟用）記在 `durability.relays`
                    const refusals = result.durability?.relays
                        .filter((r) => r.outcome === 'rejected' || r.outcome === 'skipped')
                        .map((r) => ({ url: r.url, reason: r.reason ?? '' })) ?? result.rejected;
                    // 每一座都說「檔案事件未啟用」：不是暫時的問題，給明確的錯誤（SDK ADR 0027）
                    if (result.accepted.length === 0 && refusals.length > 0 && refusals.every((r) => isFileEventsDisabledReason(r.reason))) {
                        throw new RelayRejectsFilesError(refusals.map((r) => r.url));
                    }
                    if (result.durability?.relaysFull === true)
                        throw new RelaysFullError(result.durability.relays.map((r) => r.url));
                    if (durability !== undefined && result.accepted.length > 0)
                        throw new Error(durabilityShortfall(result, durability));
                    throw new Error(`沒有中繼接受：${result.rejected.map((r) => `${r.url} ${r.reason}`).join('；') || '沒有連線'}`);
                }
            }
        }
    }
    onMessage(listener) {
        this.#messageListeners.add(listener);
        // 註冊前收到的（SDK ADR 0075）：下一個微任務依序交出（讓呼叫端先拿到取消函式）
        if (this.#early.length > 0 && !this.#flushingEarly) {
            this.#flushingEarly = true;
            queueMicrotask(() => {
                this.#flushingEarly = false;
                const early = this.#early.splice(0);
                this.#earlyBytes = 0;
                for (const { message, ids } of early)
                    this.#dispatch(message, ids);
            });
        }
        return () => this.#messageListeners.delete(listener);
    }
    onStatusChange(listener) {
        this.#statusListeners.add(listener);
        return () => this.#statusListeners.delete(listener);
    }
    isOnline() {
        return this.#online;
    }
    /**
     * 主要中繼連不上時改用備援（SDK ADR 0093）：打開時「在線」也算開著的備援（只讀中繼）、送出時主要中繼沒連線也補發到備援、
     * 補拉時備援回完也算回完。應用在一輪同步發現主要中繼連不上、而且每台裝置都設了同一組備援時打開，這一輪結束就關掉——
     * 平常兩輪之間主要中繼只是沒連線，不該改送備援（SDK ADR 0078）。
     */
    setStandbyFallback(on) {
        if (this.#fallback === on)
            return;
        this.#fallback = on;
        this.#refreshOnline();
    }
    #computeOnline() {
        const status = this.#opts.pool.status?.();
        if (!status)
            return true;
        if ([...status.values()].includes('open'))
            return true;
        if (!this.#fallback)
            return false;
        // 只讀的備援不在 status() 裡（那只列主要中繼），健康狀態裡有
        for (const [url, health] of this.#opts.pool.relayHealth?.() ?? []) {
            if (!status.has(url) && health.status === 'open')
                return true;
        }
        return false;
    }
    #refreshOnline() {
        const online = this.#computeOnline();
        if (online === this.#online)
            return;
        this.#online = online;
        for (const listener of this.#statusListeners)
            listener(online);
        // 重新連上：補拉斷線期間的（分頁；SDK ADR 0029）
        if (online && this.#sub)
            void this.backfill().catch(() => { });
    }
    #ingest(event) {
        if (event.kind !== FILE_WRAP_KIND || this.#seen.has(event.id))
            return;
        this.#seen.add(event.id);
        if (this.#seen.size > SEEN_EVENTS)
            this.#seen.delete(this.#seen.values().next().value);
        let opened;
        try {
            opened = openWrap(event, this.#opts.signer);
        }
        catch {
            return; // 不是給我的、壞掉的、或是後量子封裝而我沒有 ML-KEM 私鑰
        }
        if (opened.rumor.kind !== VAULT_OP_KIND) {
            this.#opts.onOtherEvent?.(event);
            return;
        }
        if (!this.#trusted.has(opened.sender))
            return;
        const frame = parseFrame(opened.rumor.content);
        if (!frame)
            return;
        const assembled = this.#assemble(opened.sender, frame, event.id);
        if (!assembled)
            return;
        const message = decodeVaultMessage(assembled.bytes);
        if (!message)
            return;
        if (this.#opts.deviceOf && this.#opts.deviceOf(opened.sender) !== message.from)
            return;
        // 還沒有人監聽（SDK ADR 0075）：訂閱一建立就開始補送積存，應用的協調器載入狀態後才註冊——先留著，第一個監聽者來時交給它。
        // 不留的話這些事件已經記成看過、這次執行不會再收到，只能等別台看到摘要後重送
        if (this.#messageListeners.size === 0) {
            this.#early.push({ message, ids: assembled.ids, bytes: assembled.bytes.length });
            this.#earlyBytes += assembled.bytes.length;
            // 上限：丟最舊的（沒確認，留在中繼上，下次啟動再收）
            while (this.#early.length > MAX_EARLY_MESSAGES || (this.#early.length > 1 && this.#earlyBytes > MAX_EARLY_BYTES))
                this.#earlyBytes -= this.#early.shift().bytes;
            return;
        }
        this.#dispatch(message, assembled.ids);
    }
    #dispatch(message, ids) {
        // 收件確認（SDK ADR 0067 §3）：至少一個監聽者回傳 Promise、而且全部完成，才算處理完
        const confirmations = [];
        for (const listener of this.#messageListeners) {
            // 監聽者丟例外照舊往外丟（不會走到下面，不確認）
            const result = listener(message);
            if (result instanceof Promise)
                confirmations.push(result);
        }
        if (confirmations.length === 0 || this.#opts.inboxAck === false) {
            for (const p of confirmations)
                p.catch(() => { });
            return;
        }
        Promise.all(confirmations).then(() => this.#processed(ids), () => { });
    }
    #assemble(sender, frame, eventId) {
        if (frame.n === 1)
            return { bytes: frame.d, ids: [eventId] };
        const now = this.#now();
        for (const [key, asm] of this.#assemblies)
            if (now - asm.at > ASSEMBLY_TTL_MS)
                this.#dropAssembly(key);
        const key = `${sender}:${frame.m}`;
        let asm = this.#assemblies.get(key);
        if (!asm) {
            if (this.#assemblies.size >= MAX_ASSEMBLIES)
                this.#dropAssembly(this.#assemblies.keys().next().value);
            asm = { parts: new Map(), n: frame.n, at: now, bytes: 0, ids: [] };
            this.#assemblies.set(key, asm);
        }
        if (asm.n !== frame.n)
            return null;
        // 重複的訊框（同一則重送、或多座中繼各給一份不同外層的）也一起確認
        asm.ids.push(eventId);
        if (asm.parts.has(frame.i))
            return null;
        asm.parts.set(frame.i, frame.d);
        asm.bytes += frame.d.length;
        this.#assemblyBytes += frame.d.length;
        while (this.#assemblyBytes > MAX_ASSEMBLY_BYTES && this.#assemblies.size > 1) {
            const oldest = this.#assemblies.keys().next().value;
            if (oldest === key)
                break;
            this.#dropAssembly(oldest);
        }
        if (asm.parts.size < asm.n)
            return null;
        this.#dropAssembly(key);
        let total = 0;
        for (const part of asm.parts.values())
            total += part.length;
        const out = new Uint8Array(total);
        let offset = 0;
        for (let i = 0; i < asm.n; i += 1) {
            const part = asm.parts.get(i);
            out.set(part, offset);
            offset += part.length;
        }
        return { bytes: out, ids: asm.ids };
    }
    /**
     * 收不齊的訊框（SDK ADR 0081）：確認已收到的那幾顆，中繼 2 小時後刪掉，不再每次連上都下載一次。
     * 寄件端由簽收單與摘要重送（SDK ADR 0068），不靠這幾顆。重組中的仍留著：寄件端剛好還在送時，其餘的即時送到照樣重組。
     */
    #ackOrphans() {
        const ids = [];
        for (const asm of this.#assemblies.values())
            if (asm.parts.size < asm.n)
                ids.push(...asm.ids);
        if (ids.length > 0)
            this.#processed(ids);
    }
    #dropAssembly(key) {
        const asm = this.#assemblies.get(key);
        if (!asm)
            return;
        this.#assemblyBytes -= asm.bytes;
        this.#assemblies.delete(key);
    }
}
/** 建立並開始訂閱。 */
export function createNostrVaultTransport(opts) {
    const transport = new NostrVaultTransport(opts);
    transport.start();
    return transport;
}
//# sourceMappingURL=nostr-transport.js.map