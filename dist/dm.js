/**
 * 私訊（SDK ADR 0001；源自《沒當好爸爸》ADR 0025）：標準 NIP-17。kind 14 rumor（不簽）→ kind 13 seal（寄件人簽、NIP-44 加給收件人）
 * → kind 1059 gift wrap（一次性金鑰簽、只有 `p` 標籤）。同一份 rumor 封兩次：給對方、給自己，
 * 回來時以 rumor id 去重——任何支援 NIP-17 的客戶端都讀得到，Relay 只看得到收件人與密文。
 *
 * 不做前向保密與多裝置同步（那是 Cinderous 本體的事）；對話存在本機，Relay 上只留 7 天。
 *
 * 封裝與拆封走 `protocol/nip59`（經 `Identity.sealAndWrap`／`openWrap`）：SDK 裡禮物包只有這一份實作
 * （SDK ADR 0012）。它與 nostr-tools 的 NIP-17 雙向互通，由 `dm.test.ts` 釘住。
 */
import { StorageSlot } from './chat-storage.js';
import { durabilityShortfall, meetsDurability, reportPublishRejections, } from './publish-rejections.js';
export const DM_RUMOR_KIND = 14;
export const DM_SEAL_KIND = 13;
export const DM_WRAP_KIND = 1059;
/** 一則私訊的字數上限 */
export const DM_MAX_CHARS = 1_000;
/** 收件匣往回看多久：已知租戶車道上一般事件保存 7 天 */
export const DM_LOOKBACK_SEC = 7 * 24 * 60 * 60;
/** 每位對象在本機保留的則數、最多幾段對話 */
export const DM_HISTORY_PER_PEER = 200;
export const DM_PEERS_LIMIT = 50;
/** 對話在儲存裡的預設鍵；各應用可用 `storageKey` 沿用自己既有的鍵 */
export const DEFAULT_DM_STORAGE_KEY = 'cinderous:dm:threads';
/** 封一則私訊：回傳 [給對方的, 給自己的]。空白或超過字數丟例外。 */
export function wrapDm(request) {
    const { identity, to, nowSec } = request;
    const text = request.text.trim();
    if (text.length === 0 || text.length > DM_MAX_CHARS) {
        throw new Error(`私訊要 1～${DM_MAX_CHARS} 字`);
    }
    // 同一份 rumor（id 由內容決定，兩次相同）各封一次給對方與自己；seal 與 wrap 的時間由 nip59 往前倒填
    const rumor = { kind: DM_RUMOR_KIND, created_at: nowSec, tags: [['p', to]], content: text };
    const recipients = to === identity.pubkey ? [to] : [to, identity.pubkey];
    return recipients.map((recipient) => identity.sealAndWrap(rumor, recipient, { kind: DM_WRAP_KIND, tags: [['p', recipient]] }));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/** 解開給我的封裝；不是給我的、被改過、冒名（seal 簽章者≠rumor 作者）、形狀不對一律 `null`。 */
export function unwrapDm(identity, wrap) {
    try {
        if (wrap.kind !== DM_WRAP_KIND) {
            return null;
        }
        // 驗 seal 簽章、rumor 作者＝seal 簽章者、rumor id 與內容相符，都在 openWrap 裡
        const { sender: sealer, rumor: opened } = identity.openWrap(wrap);
        const rumor = opened;
        if (!isRecord(rumor) ||
            rumor['kind'] !== DM_RUMOR_KIND ||
            typeof rumor['content'] !== 'string' ||
            typeof rumor['created_at'] !== 'number' ||
            !Array.isArray(rumor['tags'])) {
            return null;
        }
        const text = rumor['content'].trim();
        if (text.length === 0 || text.length > DM_MAX_CHARS) {
            return null;
        }
        const mine = sealer === identity.pubkey;
        const tags = rumor['tags'];
        const pTag = tags.find((tag) => Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string');
        const peer = mine ? pTag?.[1] : sealer;
        if (peer === undefined) {
            return null;
        }
        return {
            id: opened.id,
            peer,
            text,
            at: rumor['created_at'],
            mine,
        };
    }
    catch {
        return null;
    }
}
/** 加入一則：同 id 不重複、依時間排序、每段對話與對話數各自封頂。沒變就回原陣列。 */
function withDm(threads, dm) {
    const current = threads.find((thread) => thread.peer === dm.peer);
    if (current?.lines.some((line) => line.id === dm.id)) {
        return threads;
    }
    const lines = [...(current?.lines ?? []), { id: dm.id, text: dm.text, at: dm.at, mine: dm.mine }]
        .sort((a, b) => a.at - b.at)
        .slice(-DM_HISTORY_PER_PEER);
    const thread = { peer: dm.peer, lines, lastAt: lines.at(-1)?.at ?? dm.at };
    return [thread, ...threads.filter((other) => other.peer !== dm.peer)]
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, DM_PEERS_LIMIT);
}
function parseThreads(raw) {
    try {
        const parsed = raw ? JSON.parse(raw) : [];
        // 形狀不對的對話整段丟掉（儲存可能被外部改壞），免得之後合併新訊息時才出錯
        return Array.isArray(parsed)
            ? parsed.filter((thread) => isRecord(thread) && typeof thread.peer === 'string' && Array.isArray(thread.lines))
            : [];
    }
    catch {
        return [];
    }
}
/** 私訊收件匣與對話紀錄。收件匣訂閱是 `#p` 自己，車道要先 NIP-42（RelayPool 帶身分時自動處理）。 */
export class DirectMessages {
    #transport;
    #identity;
    #now;
    #slot;
    #isBlocked;
    #onPublishRejected;
    #durability;
    #listeners = new Set();
    #threads = [];
    /** 舊對話讀回來了沒（同步儲存：建構時就讀完） */
    #loaded = false;
    /** 讀回之前被 `forget` 的對象：讀回的舊紀錄裡也要拿掉 */
    #forgottenBeforeLoad = new Set();
    constructor(options) {
        this.#transport = options.transport;
        this.#identity = options.identity;
        this.#now = options.now ?? (() => Date.now());
        this.#isBlocked = options.isBlocked ?? (() => false);
        this.#onPublishRejected = options.onPublishRejected;
        this.#durability = options.durability;
        this.#slot = new StorageSlot(options.storage, options.storageKey ?? DEFAULT_DM_STORAGE_KEY);
        this.#slot.load((raw) => this.#onLoaded(raw));
    }
    threads() {
        return this.#threads;
    }
    /** 舊對話讀回來之後完成。同步儲存（或沒有儲存）立刻完成。 */
    ready() {
        return this.#slot.ready();
    }
    /** 到目前為止的變更都寫進儲存之後完成。同步儲存（或沒有儲存）立刻完成。 */
    flush() {
        return this.#slot.flush();
    }
    /** 開收件匣；立刻回呼一次目前的對話，之後每次變動都回呼。 */
    watch(listener) {
        this.#listeners.add(listener);
        listener(this.#threads);
        const subscription = this.#transport.subscribe([
            {
                kinds: [DM_WRAP_KIND],
                '#p': [this.#identity.pubkey],
                since: Math.floor(this.#now() / 1000) - DM_LOOKBACK_SEC,
            },
        ], {
            onEvent: (event) => {
                const dm = unwrapDm(this.#identity, event);
                if (dm !== null) {
                    this.#add(dm);
                }
            },
        });
        return () => {
            this.#listeners.delete(listener);
            subscription.close();
        };
    }
    /** 送一則：本機先記下，兩份封裝都發；全部 Relay 拒收就回失敗（訊息仍留在本機紀錄）。 */
    async send(to, text) {
        let wraps;
        try {
            wraps = wrapDm({
                identity: this.#identity,
                to,
                text,
                nowSec: Math.floor(this.#now() / 1000),
            });
        }
        catch (error) {
            return { ok: false, message: error.message };
        }
        const own = unwrapDm(this.#identity, wraps.at(-1));
        if (own !== null) {
            this.#add(own);
        }
        const durability = this.#durability;
        const results = await Promise.all(wraps.map((wrap) => 
        // 沒設定耐久度時照舊只傳一個參數（v0.32 的呼叫形狀）
        (durability === undefined ? this.#transport.publish(wrap) : this.#transport.publish(wrap, { durability })).catch(() => ({ accepted: [], rejected: [] }))));
        const rejections = results.map((result, i) => reportPublishRejections(wraps[i].id, result, this.#onPublishRejected));
        // 第一份是給對方的（`wrapDm` 最後一份才是給自己的）
        const first = results[0];
        const delivery = {
            accepted: [...(first?.accepted ?? [])],
            rejected: rejections[0] ?? [],
            ...(first?.durability !== undefined ? { durability: first.durability } : {}),
        };
        const failed = results.find((result) => !meetsDurability(result, durability));
        if (failed === undefined)
            return { ok: true, message: '', ...delivery };
        const reasons = failed.rejected.map((entry) => entry.reason).join('；');
        const message = durability !== undefined && (failed.accepted.length > 0 || failed.durability?.relaysFull === true) ? durabilityShortfall(failed, durability) : reasons || '沒有中繼站收下';
        return { ok: false, message, ...delivery };
    }
    /** 拿掉和某人的整段對話（封鎖時用） */
    forget(peer) {
        if (!this.#loaded)
            this.#forgottenBeforeLoad.add(peer);
        this.#save(this.#threads.filter((thread) => thread.peer !== peer));
    }
    /**
     * 讀回舊對話。同步儲存在建構時就走到這裡（那時記憶體裡還沒有東西，結果與以前相同、也不寫回）。
     * 非同步儲存讀回之前可能已經收到新訊息或被 `forget`：把它們疊在讀回的紀錄上，再寫回一次。
     */
    #onLoaded(raw) {
        this.#loaded = true;
        let next = parseThreads(raw).filter((thread) => !this.#isBlocked(thread.peer) && !this.#forgottenBeforeLoad.has(thread.peer));
        const changedBeforeLoad = this.#threads.length > 0 || this.#forgottenBeforeLoad.size > 0;
        for (const thread of this.#threads) {
            for (const line of thread.lines)
                next = withDm(next, { ...line, peer: thread.peer });
        }
        this.#forgottenBeforeLoad.clear();
        if (changedBeforeLoad) {
            this.#save(next);
        }
        else if (next.length > 0 || this.#listeners.size > 0) {
            this.#threads = next;
            for (const listener of this.#listeners)
                listener(next);
        }
    }
    #add(dm) {
        if (this.#isBlocked(dm.peer)) {
            return;
        }
        const next = withDm(this.#threads, dm);
        if (next !== this.#threads) {
            this.#save(next);
        }
    }
    #save(next) {
        this.#threads = next;
        // 存不進去（配額、隱私模式）就只留在記憶體。非同步儲存：排隊，輪到時寫當下最新的狀態
        this.#slot.save(() => JSON.stringify(this.#threads));
        for (const listener of this.#listeners) {
            listener(next);
        }
    }
}
//# sourceMappingURL=dm.js.map