import { AUTH_KIND, authChallengeOf, authRelayMatches, INBOX_ACK_KIND, inboxAckIdsOf, leadingZeroBits, VANISH_KIND, vanishTargetsRelay, verifyEvent, } from "../protocol/index.js";
import { matchFilter } from "./filters.js";
/**
 * 單一 filter 的 `authors` 上限（ADR-0123）：擋掉「用 `authors: [十萬把金鑰]` 枚舉全站」。
 * 1024 遠大於任何真實聯絡人清單／組織名冊，也遠小於枚舉所需。
 */
const MAX_AUTHORS = 1024;
/**
 * 單則客戶端訊息的原始位元組上限（ADR-0235 C3）：**在 `JSON.parse` 之前**檢查，是最便宜的
 * 一道閘。上界取自最大合法訊息——可尋址快照事件 256KB（{@link ADDRESSABLE_MAX_BYTES}）
 * 加上 1024 個 author 的 REQ（約 70KB）都落在此值內。
 */
const MAX_MESSAGE_BYTES = 384 * 1024;
/**
 * 單顆事件序列化後的大小上限（ADR-0235 C3）。原本**只有** kind 1060 有大小檢查，其餘
 * kind（含 gift wrap）完全無界。對齊可尋址事件上限 256KB——那是協定內最大的合法事件。
 */
const MAX_EVENT_BYTES = 262_144;
/**
 * 單顆事件的 tag 總數上限（ADR-0235 C3）。外層事件的 tag 極少（`p`／`expiration`／`d`），
 * 128 已是數十倍餘裕。
 */
const MAX_TAGS = 128;
/**
 * 單顆事件的 `p` tag（收件人）數上限（ADR-0235 C3）。
 *
 * 客戶端的**外層**事件一律只有 **1 個** `p`——群組是逐位成員各發一顆 Gift Wrap（ADR-0027），
 * 多重提及的 `p` 在加密 rumor 內層、中繼根本看不到。16 留給未來，同時把
 * 「一則事件 → 15,000 列 INSERT ＋ 15,000 輪 enforceCap」的放大倍率壓回個位數。
 */
const MAX_P_TAGS = 16;
// 拒收訊息（SDK ADR 0038 P0-R1／P0-R2；ADR 0040 詞元表）集中在 `reject-messages.ts`。
// `OFFLINE_CEILING_REJECT`／`EXPIRED_REJECT` 在 v0.31.1 從這裡匯出，照舊轉出。
export { EXPIRED_REJECT, OFFLINE_CEILING_REJECT } from "./reject-messages.js";
import { ADDRESSABLE_REJECT, ADDRESSABLE_REJECT_GENERIC, borrowedWarning, droppedNotice, EXPIRED_REJECT, nearFullWarning, malformedMessage, OFFLINE_CEILING_REJECT, powRejectMessage, REJECT, STORAGE_QUOTA_REJECTION, tooManyConnectionsMessage, UPGRADE_UNAVAILABLE_CLOSE_CODE, } from "./reject-messages.js";
import { FILE_EVENT_MAX_BYTES, FILE_WRAP_KIND, getExpiration, isAuthorOnlyKind, MAX_QUERY_BYTES, isReplaceableOrAddressable, recipientsOf, } from "./message-store.js";
import { parseClientMessage, } from "./protocol.js";
const EPHEMERAL_MIN = 20000;
const EPHEMERAL_MAX = 29999;
/** NIP-01：20000–29999 為 Ephemeral，中繼站不得持久化。 */
export function isEphemeral(kind) {
    return kind >= EPHEMERAL_MIN && kind <= EPHEMERAL_MAX;
}
// NIP-13 難度量測改由 core 供應並**轉引**（ADR-0366 P2 #11），與 `shard.ts` 對
// `shardPrefix` 的處理同一個做法：挖礦端（core `minePow`）與驗證端（本檔）對難度的
// 定義只要差一位元，症狀就是「客戶端算得很辛苦、中繼照樣拒收」，而且是安靜的。
export { leadingZeroBits } from "../protocol/index.js";
/** 宿主把 `Outbound.close` 換成實際的關閉碼與原因。 */
export function closeSignalOf(close) {
    return close === true ? { code: 1008, reason: "rate-limited" } : close;
}
/**
 * 傳輸無關的中繼核心：管理各連線的訂閱、驗證事件並對符合的訂閱扇出。
 * 訂閱以 kind 建立反向索引，事件進來只比對「對該 kind 有興趣」的訂閱，
 * 避免每個事件掃過全體訂閱（O(N²)）。由 Worker / Durable Object 注入收發。
 */
export class RelayCore {
    opts;
    /** connId -> (subId -> entry)，權威來源。 */
    subs = new Map();
    /** kind -> 對該 kind 有興趣的訂閱。 */
    byKind = new Map();
    /** 未限制 kind（可匹配任何 kind）的訂閱。 */
    anyKindSubs = new Set();
    /** 已處理事件 id → created_at（重放窗內去重，防重放）。 */
    seenIds = new Map();
    /** pubkey → 該時間窗內的發布數與窗起點（ADR-0235 H1 速率限制）。 */
    rate = new Map();
    /** connId → 該時間窗內的進站訊息數與窗起點（ADR-0366 §容量）。 */
    connRate = new Map();
    /** 企業封閉模式的發布 allowlist（hex pubkey）；undefined＝開放（ADR-0044）。 */
    allowed;
    /** 企業政策的事件類型 allowlist（kind）；undefined＝不限制（ADR-0048）。 */
    allowedKinds;
    /** connId → NIP-42 認證狀態（挑戰、已認證 pubkey、本站主機）；ADR-0057／0235 H2。 */
    authState = new Map();
    /** connId → 客戶端 IP（宿主有給才有；SDK ADR 0013） */
    connIp = new Map();
    /** IP → 這一秒的訊息數 */
    ipRate = new Map();
    /**
     * connId → 本次連線打到的主機。**與 AUTH 狀態分離**（ADR-0260）：`authState` 只在
     * `requireAuth` 時才建立，但 NIP-62 的「這份清除請求是不是給本站的」在**沒有 AUTH 的
     * 自架站**同樣需要主機資訊——不分離的話，那些站會只認 `ALL_RELAYS`。
     */
    connHost = new Map();
    /** 是否要求 NIP-42 AUTH（開放中繼；ADR-0057）。 */
    requireAuth;
    /** pubkey → 正在讀他自己收件匣的訂閱數（SDK ADR 0042 丟棄計數）。 */
    inboxSubs = new Map();
    constructor(opts = {}) {
        this.opts = opts;
        this.allowed = opts.allowedAuthors ? new Set(opts.allowedAuthors) : undefined;
        this.allowedKinds = opts.allowedKinds ? new Set(opts.allowedKinds) : undefined;
        this.requireAuth = opts.requireAuth === true;
        // 丟棄計數：正在線上收自己收件匣的人，他的留言被刪掉不算丟棄（SDK ADR 0042）
        opts.store?.setInboxProbe?.((recipient) => this.inboxSubs.has(recipient));
    }
    newChallenge() {
        return (this.opts.authChallenge ?? (() => crypto.randomUUID()))();
    }
    isAuthed(connId) {
        return this.authState.get(connId)?.pubkey !== undefined;
    }
    /** 這條連線完成 NIP-42 認證了嗎（SDK ADR 0111 的診斷用：認證過的連線一律不記） */
    isAuthenticated(connId) {
        return this.isAuthed(connId);
    }
    now() {
        return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
    }
    /**
     * 建立連線；`requireAuth` 時回 NIP-42 AUTH 挑戰供宿主送出（否則空）。
     *
     * `relayHost`＝**本次請求打到的主機**（宿主從 request 取得）。給了它，AUTH 就會驗證
     * `relay` tag 指向本站（ADR-0235 H2）；不給則不強制（自架／測試維持原行為）。
     * 由宿主提供而非設定檔：同一份 Worker 可能同時服務多個網域，寫死會誤擋。
     */
    connect(connId, relayHost, clientIp) {
        if (!this.subs.has(connId))
            this.subs.set(connId, new Map());
        if (clientIp)
            this.connIp.set(connId, clientIp);
        // 主機先記（ADR-0260）：無 AUTH 的站也要能判斷 NIP-62 的目標是不是自己。
        if (relayHost)
            this.connHost.set(connId, relayHost);
        // 車道也發挑戰，但**不強制**（ADR-0369）：`#p` 只能是自己，而「自己」只有 AUTH 證明得了；
        // 不發挑戰的話，車道上的 `#p` 訂閱就一條也過不了。不處理 AUTH 的客戶端會直接忽略它。
        if (!this.requireAuth && !this.opts.publicLane)
            return [];
        // 已有挑戰（含已認證）者只重發、不重置——避免重複呼叫把認證狀態洗掉。
        const existing = this.authState.get(connId);
        if (existing)
            return [{ to: connId, message: ["AUTH", existing.challenge] }];
        const challenge = this.newChallenge();
        this.authState.set(connId, { challenge, ...(relayHost ? { relayHost } : {}) });
        return [{ to: connId, message: ["AUTH", challenge] }];
    }
    disconnect(connId) {
        const conn = this.subs.get(connId);
        if (conn)
            for (const entry of conn.values())
                this.unindex(entry);
        this.subs.delete(connId);
        this.authState.delete(connId);
        this.connHost.delete(connId);
        this.connRate.delete(connId);
        this.connIp.delete(connId);
    }
    /**
     * 匯出某連線的可序列化狀態（訂閱＋認證）；供 DO 休眠後從 WebSocket attachment 還原
     * （ADR-0059）。休眠會清空記憶體，故每次狀態變動後宿主應存回此快照。
     */
    exportConn(connId) {
        const auth = this.authState.get(connId);
        const conn = this.subs.get(connId);
        const subs = conn ? [...conn.values()].map((e) => ({ subId: e.subId, filters: e.filters })) : [];
        return {
            connId,
            ...(auth?.challenge !== undefined ? { challenge: auth.challenge } : {}),
            ...(auth?.pubkey !== undefined ? { pubkey: auth.pubkey } : {}),
            ...(this.connIp.has(connId) ? { ip: this.connIp.get(connId) } : {}),
            // 少了這一行，DO 休眠喚醒後 `relayHost` 就消失 → relay tag 檢查靜默失效（ADR-0235 H2）。
            // 退回 `connHost`：無 AUTH 的站沒有 authState，但 NIP-62 仍需要主機（ADR-0260）。
            ...(auth?.relayHost ?? this.connHost.get(connId) ? { relayHost: (auth?.relayHost ?? this.connHost.get(connId)) } : {}),
            subs,
        };
    }
    /**
     * 移除某連線的一條訂閱（不送任何訊息；回傳是否真的有這條）。
     *
     * 客戶端 `CLOSE` 走這裡；宿主也用它關掉**無法持久化**的訂閱（Cinderous ADR-0373）——
     * 留著它的話，它在記憶體裡看起來能用，DO 休眠一次就無聲消失。
     */
    dropSubscription(connId, subId) {
        const conn = this.subs.get(connId);
        const entry = conn?.get(subId);
        if (!entry)
            return false;
        this.unindex(entry);
        conn.delete(subId);
        return true;
    }
    /** 從快照還原連線狀態（重建訂閱索引與認證，不觸發任何送出）；休眠喚醒時呼叫（ADR-0059）。 */
    rehydrate(snapshot) {
        if (!this.subs.has(snapshot.connId))
            this.subs.set(snapshot.connId, new Map());
        const conn = this.subs.get(snapshot.connId);
        if (snapshot.relayHost !== undefined)
            this.connHost.set(snapshot.connId, snapshot.relayHost);
        if (snapshot.ip !== undefined)
            this.connIp.set(snapshot.connId, snapshot.ip);
        if (snapshot.challenge !== undefined || snapshot.pubkey !== undefined || snapshot.relayHost !== undefined) {
            this.authState.set(snapshot.connId, {
                challenge: snapshot.challenge ?? "",
                ...(snapshot.pubkey !== undefined ? { pubkey: snapshot.pubkey } : {}),
                ...(snapshot.relayHost !== undefined ? { relayHost: snapshot.relayHost } : {}),
            });
        }
        for (const { subId, filters } of snapshot.subs) {
            const entry = buildEntry(snapshot.connId, subId, filters);
            conn.set(subId, entry);
            this.index(entry);
        }
    }
    /**
     * 客戶端訊息入口。**整段包在例外圍籬內**（ADR-0235 C1）：`RelayCore` 是傳輸無關核心，
     * 宿主（Cloudflare DO / Node ws）各自 try/catch 只會漏掉其中一邊，且 DO 的未捕捉例外
     * 會中止整個 Durable Object——那是**單一全域房間**，等於全站連線一起斷。圍籬放在唯一
     * 入口，兩個宿主自動受保護。
     */
    handle(connId, raw) {
        try {
            // 🔴 最前面：這一關要在 JSON.parse **與**長度檢查之前，因為它擋的不是內容而是**次數**。
            const perIp = this.opts.maxMessagesPerSecondPerIp;
            const ip = this.connIp.get(connId);
            if (perIp !== undefined && ip !== undefined && !this.allowIpRate(ip, this.now(), perIp)) {
                return [
                    {
                        to: connId,
                        message: ["NOTICE", REJECT.ipRateLimited],
                        close: { code: 1008, reason: "rate-limited" },
                    },
                ];
            }
            const perMinute = this.opts.maxMessagesPerMinute;
            if (perMinute !== undefined && !this.allowConnRate(connId, this.now(), perMinute)) {
                return [
                    {
                        to: connId,
                        message: ["NOTICE", REJECT.messagesRateLimited],
                        close: true,
                    },
                ];
            }
            return this.dispatch(connId, raw);
        }
        catch (error) {
            if (this.opts.isStorageExhausted?.(error))
                return storageExhausted(connId, raw);
            // 不回傳例外細節（不給探測訊號）；宿主連線維持存活。
            return [{ to: connId, message: ["NOTICE", REJECT.internal] }];
        }
    }
    /** 這條連線是不是唯讀（SDK ADR 0052） */
    isReadOnly(connId) {
        const readOnly = this.opts.readOnly;
        return typeof readOnly === "function" ? readOnly(connId) : readOnly === true;
    }
    dispatch(connId, raw) {
        // 最便宜的一道閘（ADR-0235 C3）：在 JSON.parse 之前擋掉超大訊息。
        if (raw.length > MAX_MESSAGE_BYTES) {
            return [{ to: connId, message: ["NOTICE", REJECT.messageTooLarge] }];
        }
        const msg = parseClientMessage(raw);
        switch (msg.type) {
            case "AUTH":
                return this.handleAuth(connId, msg.event);
            case "EVENT":
                if (this.isReadOnly(connId))
                    return [{ to: connId, message: ["OK", msg.event.id, false, REJECT.readOnly] }];
                if (this.requireAuth && !this.isAuthed(connId)) {
                    return this.authRequired(connId, ["OK", msg.event.id, false, REJECT.authRequired]);
                }
                return this.handleEvent(connId, msg.event);
            case "REQ":
                if (this.requireAuth && !this.isAuthed(connId)) {
                    return this.authRequired(connId, ["CLOSED", msg.subId, REJECT.authRequired]);
                }
                // 🔴 車道**不要求** AUTH，但範圍檢查照做（ADR-0369）。原本這裡只有 `requireAuth`，
                // 於是 `requireAuth: false` 的車道完全不檢查——ADR-0366 §決策 5 說要擋的裸 filter 與
                // 別人的 `#p` 全部放行，而只用 `requireAuth: true` 組的測試看不出來。
                // 車道上還沒認證就送 `#p`（SDK ADR 0076）：「只能是自己」要認證後才判斷得了——回 auth-required（附挑戰），
                // 客戶端認證後會重送；回 restricted 的話，標準的客戶端會當成永久拒絕、不再重送
                if (this.opts.publicLane &&
                    !this.isAuthed(connId) &&
                    msg.filters.some((f) => Array.isArray(f["#p"]) && f["#p"].length > 0) &&
                    !this.scoped(connId, msg.filters)) {
                    return this.authRequired(connId, ["CLOSED", msg.subId, REJECT.authRequired]);
                }
                if ((this.requireAuth || this.opts.publicLane) && !this.scoped(connId, msg.filters)) {
                    // 訊息要**說得出原因**（ADR-0123）：沉默的空回應會讓實作者以為「這個中繼沒有資料」，
                    // 然後跑去別的地方找 bug。車道的讀者是第三方開發者，故用英文。
                    return [
                        {
                            to: connId,
                            message: [
                                "CLOSED",
                                msg.subId,
                                this.opts.publicLane ? REJECT.scopeLane : REJECT.scopeStrict,
                            ],
                        },
                    ];
                }
                return this.handleReq(connId, msg.subId, msg.filters);
            case "CLOSE":
                this.dropSubscription(connId, msg.subId);
                return [{ to: connId, message: ["CLOSED", msg.subId, ""] }];
            case "INVALID":
                return [{ to: connId, message: ["NOTICE", malformedMessage(msg.reason)] }];
        }
    }
    /**
     * 處理客戶端的 NIP-42 AUTH 回應：驗簽 ＋ kind ＋ 挑戰相符 ＋ **`relay` tag 指向本站**
     * ＋ 事件新鮮度 → 標記此連線認證身分。
     *
     * `relay` tag 那一項是 NIP-42 規範要求、而修正前**沒有做**的檢查（ADR-0235 H2）。
     * 少了它，惡意中繼 M 可以：連上真中繼 R 取得挑戰 C → 把 C 當成自己的挑戰丟給受害者 →
     * 受害者簽名回給 M → M 轉送給 R → **以受害者身分通過 R 的認證**，進而訂閱其加密收件匣。
     * 內容仍是密文，但「誰在何時收到幾則」已是完整的流量分析輸入。
     */
    handleAuth(connId, event) {
        const state = this.authState.get(connId);
        if (!state) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.authNoChallenge] }];
        }
        if (event.kind !== AUTH_KIND || !verifyEvent(event) || authChallengeOf(event) !== state.challenge) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.authBadEvent] }];
        }
        if (state.relayHost !== undefined && !authRelayMatches(event, state.relayHost)) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.authRelayTag] }];
        }
        const maxAge = this.opts.authMaxAgeSec;
        if (maxAge !== undefined && Math.abs(this.now() - event.created_at) > maxAge) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.authTooOld] }];
        }
        // 白名單外的人：認證本身沒問題，但這座站不收他——直接斷線，不讓他佔著連線（PRD 3.3；SDK ADR 0013）
        if (this.allowed && !this.allowed.has(event.pubkey)) {
            return [
                {
                    to: connId,
                    message: ["OK", event.id, false, REJECT.notOnWhitelist],
                    close: { code: 4003, reason: "restricted" },
                },
            ];
        }
        const maxConns = this.opts.maxConnectionsPerPubkey;
        if (maxConns !== undefined) {
            let open = 0;
            for (const [id, other] of this.authState)
                if (id !== connId && other.pubkey === event.pubkey)
                    open += 1;
            if (open >= maxConns) {
                return [
                    {
                        to: connId,
                        message: ["OK", event.id, false, tooManyConnectionsMessage(maxConns)],
                        close: { code: 1008, reason: "too-many-connections" },
                    },
                ];
            }
        }
        state.pubkey = event.pubkey;
        return [{ to: connId, message: ["OK", event.id, true, ""] }];
    }
    /** 未認證時回拒絕訊息並（重）發此連線的 AUTH 挑戰。 */
    authRequired(connId, rejection) {
        const out = [{ to: connId, message: rejection }];
        const state = this.authState.get(connId);
        if (state)
            out.push({ to: connId, message: ["AUTH", state.challenge] });
        return out;
    }
    /**
     * 訂閱必須**具名**（ADR-0123）：帶 `#p`（等於自己）或帶非空且有界的 `authors`。
     *
     * ## 修正前的缺口
     *
     * 舊版只檢查「有 `#p` 的 filter」：
     *
     * ```ts
     * const pValues = filter["#p"];
     * if (pValues && pValues.length > 0 && !pValues.every((v) => v === self)) return false;
     * ```
     *
     * **`pValues` 是 undefined 就直接放行。** 於是 `{"kinds":[20000]}`——沒有 `#p`、沒有
     * `authors`——完全合法，任何通過 AUTH 的人（隨手產一把金鑰就能通過）都能拿到**全站每一則
     * 心跳**：每個在線者的 pubkey、狀態訊息、正在聽什麼（ADR-0088 F5 把音樂併進了心跳）。
     *
     * 那不是「洩漏某個人的元資料」，是把整個使用者名冊連同即時線上狀態做成一支**消防水管**
     * ——攻擊者不需要事先知道任何 pubkey。`{"kinds":[1059]}` 同理：拿不到明文，但拿得到
     * 全站的收件人 p-tag 與時間分布（流量分析的完美輸入）。
     *
     * ## 為什麼可以直接擋掉
     *
     * 合法客戶端**從不**送這種 filter——引擎的 9 個 filter 全部帶 `#p` 或 `authors`。
     * 一個不會影響任何合法用法的限制，就該加上去。
     *
     * 「具名」的意思是：**你得先知道要問誰**。這不是完美的隱私（仍可訂閱任何已知 pubkey 的
     * 心跳——那是 Nostr 廣播式 presence 的固有性質，見 ADR-0120/0123 的已知限制），
     * 但它把攻擊從「一鍵拿到整個名冊」降級為「一次問一個你已經知道的人」。
     */
    scoped(connId, filters) {
        const self = this.authState.get(connId)?.pubkey;
        for (const filter of filters) {
            const pValues = filter["#p"];
            if (pValues && pValues.length > 0) {
                if (!pValues.every((v) => v === self))
                    return false; // 只能查自己的收件匣（ADR-0057）
                continue;
            }
            // 第三方車道（ADR-0366 §決策 5）：**任一個**非 `#p` 的標籤 filter 也算具名。
            //
            // 為什麼這對車道是安全的、對訊息平面不是：這兩者是**物理上不同的 DO**
            //（`routeForPath` 在選 DO 之前就分流了），車道那顆 DO 的儲存裡從頭到尾
            // 沒有任何一顆 Cinderous 事件 ⇒ 放寬它讀不到任何本來讀不到的東西。
            //
            // ⚠ 仍然擋掉裸的 `{"kinds":[…]}` 與 `{}`——那是 ADR-0123 的消防水管，
            // 換到哪條車道都還是消防水管（只是被沖的人不同）。`#p` 的「只能是自己」
            // 也**刻意保留**：遊戲的指名信令本來就只讀自己的收件匣，放寬它零收益。
            if (this.opts.publicLane && hasTagScope(filter))
                continue;
            const authors = filter.authors;
            // 該擋的是 `authors` **不存在**（＝不過濾作者＝全站）。
            //
            // `authors: []` 是**合法且無害的**：`matchFilter` 的 `!filter.authors.includes(pubkey)`
            // 對空陣列恆為真 → 匹配不到任何事件。而引擎在「還沒有任何聯絡人」時送出的正是它
            //（心跳訂閱的 authors 就是聯絡人清單）。把它當成消防水管擋下來，會讓新使用者
            //**整個 REQ 被拒 → 什麼都收不到**。
            if (!authors)
                return false; // ← 消防水管
            // 也不准用 `authors: [十萬把金鑰]` 繞過——那等價於枚舉全站。
            // 1024 遠大於任何真實聯絡人清單／組織名冊。
            if (authors.length > MAX_AUTHORS)
                return false;
        }
        return true;
    }
    handleReq(connId, subId, filters) {
        if (!this.subs.has(connId))
            this.subs.set(connId, new Map()); // 確保連線存在，不碰 AUTH 狀態
        const conn = this.subs.get(connId);
        const cap = this.opts.maxSubscriptions;
        if (cap !== undefined && !conn.has(subId) && conn.size >= cap) {
            return [{ to: connId, message: ["CLOSED", subId, REJECT.subscriptionsLimit] }];
        }
        const previous = conn.get(subId);
        if (previous)
            this.unindex(previous, false);
        const entry = buildEntry(connId, subId, filters);
        conn.set(subId, entry);
        this.index(entry);
        // 同一個 id 換成不是收件匣的訂閱：原本那條收件匣訂閱就此結束（SDK ADR 0042）
        if (previous?.inbox !== undefined && !this.inboxSubs.has(previous.inbox)) {
            this.opts.store?.markDelivered?.(previous.inbox, this.now());
        }
        const out = [];
        if (this.opts.store) {
            const nowSec = this.now();
            const seen = new Set();
            const self = this.authState.get(connId)?.pubkey;
            // 位元組預算（Cinderous ADR-0371 §決策 6）：整個 REQ 共用一份，逐 filter 扣掉已回的量。
            let budget = this.opts.maxQueryBytes ?? MAX_QUERY_BYTES;
            for (const filter of filters) {
                if (budget <= 0)
                    break;
                for (const event of this.opts.store.query(filter, nowSec, budget)) {
                    budget -= JSON.stringify(event).length;
                    if (seen.has(event.id))
                        continue;
                    // ADR-0071：快照只回給作者本人（requireAuth 時）——不論 filter 形狀。
                    // ADR-0366 §決策 5：閘門收窄到 `SNAPSHOT_KIND`，不再涵蓋整個可尋址區間。
                    if (this.requireAuth && isAuthorOnlyKind(event.kind) && event.pubkey !== self)
                        continue;
                    seen.add(event.id);
                    out.push({ to: connId, message: ["EVENT", subId, event] });
                }
            }
            // 丟棄計數（SDK ADR 0042；ADR 0038 M8）：收件人讀自己的收件匣時，在 EOSE 之前告訴他有幾則在送到之前被刪掉了。
            // 取出即歸零，並記下水位線（這之前存的都算送到了）。只給已認證的本人；只有數量與時間範圍。
            if (entry.inbox !== undefined) {
                const dropped = this.opts.store.takeDropped?.(entry.inbox, nowSec);
                if (dropped !== undefined)
                    out.push({ to: connId, message: ["NOTICE", droppedNotice(dropped)] });
            }
        }
        out.push({ to: connId, message: ["EOSE", subId] });
        return out;
    }
    handleEvent(connId, event) {
        // 資源上限（ADR-0235 C3）擺在**驗簽之前**——這些檢查比 Schnorr 驗證便宜一個數量級，
        // 讓灌大量垃圾的攻擊者付不出放大效果。
        if (event.tags.length > MAX_TAGS) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.tooManyTags] }];
        }
        if (recipientsOf(event).length > MAX_P_TAGS) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.tooManyRecipients] }];
        }
        if (JSON.stringify(event).length > MAX_EVENT_BYTES) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.eventTooLarge] }];
        }
        if (!verifyEvent(event)) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.badSignature] }];
        }
        // 企業封閉模式（ADR-0044）：非 allowlist 成員一律拒收（含心跳），永久性拒絕。
        //
        // 🔴 例外（SDK ADR 0028 §7）：這條連線已經以名單上的身分通過 NIP-42 認證，而且事件是**禮物包類**
        //（1059、1060、ephemeral 20000–29999）⇒ 放行。這些事件的外層作者是每則一把的一次性金鑰，永遠不在名單上；
        // 只看 `event.pubkey` 會讓白名單站擋掉所有禮物包——包括 Vault 同步（ADR 0025、0027 要求它跑在白名單站上）。
        // 認證身分是經證明的真實寄件人（速率限制也以它計數），名單外的人在 AUTH 時就已被 4003 斷線。
        // 其他會被保存的一般／可取代事件照舊只收名單上的作者：成員不能把白名單站變成外人事件的儲存空間（安全審查 #6）。
        const authedAs = this.authState.get(connId)?.pubkey;
        const wrapLike = event.kind === 1059 || event.kind === FILE_WRAP_KIND || (event.kind >= EPHEMERAL_MIN && event.kind <= EPHEMERAL_MAX);
        if (this.allowed && !this.allowed.has(event.pubkey) && !(wrapLike && authedAs !== undefined && this.allowed.has(authedAs))) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.notAllowed] }];
        }
        // 企業政策（ADR-0048）：kind 不在允許名單一律拒收（停用檔案/通話等）。
        if (this.allowedKinds && !this.allowedKinds.has(event.kind)) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.kindDisabled] }];
        }
        // 時鐘窗（非對稱，ADR-0235 H1）＋重放去重（近期事件才進快取）。
        const now = this.now();
        const future = this.opts.maxFutureSkewSec ?? this.opts.maxClockSkewSec;
        const past = this.opts.maxPastSkewSec ?? this.opts.maxClockSkewSec;
        if ((future !== undefined && event.created_at - now > future) ||
            (past !== undefined && now - event.created_at > past)) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.clockSkew] }];
        }
        // 舊的 `maxClockSkewSec` 同時兼具「時鐘窗」與「去重窗」兩種語意——沿用它作為
        // `replayWindowSec` 的預設值，既有呼叫端行為不變。
        const replayWindow = this.opts.replayWindowSec ?? this.opts.maxClockSkewSec;
        let markedSeen = false;
        if (replayWindow !== undefined && Math.abs(event.created_at - now) <= replayWindow) {
            if (this.seenIds.has(event.id)) {
                // NIP-01 的範例是 `OK true "duplicate: …"`（SDK ADR 0038 決策 3）：本站已經有這顆。
                // v0.31.1 起被拒的事件不留在重放快取，所以留在這裡的都是真的收下過（或已轉發過的 Ephemeral）。
                // 不再扇出、不再寫庫——第一次已經做過了。
                return [{ to: connId, message: ["OK", event.id, true, REJECT.duplicate] }];
            }
            this.seenIds.set(event.id, event.created_at);
            markedSeen = true;
            if (this.seenIds.size > 4096)
                this.pruneSeen(now - replayWindow);
        }
        // 🔴 以下每一種拒收都要把這顆從重放快取拿掉（SDK ADR 0038 P0-R1）：`duplicate` 的意思是
        // 「本站已經有這顆」。沒收下卻記成見過，客戶端之後重送同一顆（天花板騰出空間、限速窗過了）
        // 就只會拿到 `duplicate`——而 NIP-01 的客戶端會把它當成已送達，又是一次靜默遺失。
        const reject = (reason) => {
            if (markedSeen)
                this.seenIds.delete(event.id);
            return [{ to: connId, message: ["OK", event.id, false, reason] }];
        };
        // 🔴 store 丟例外（SQLite 滿了、DO 被重設）也一樣：外層圍籬回 `NOTICE error:`，這顆不能留在快取裡。
        try {
            return this.admit(connId, event, now, reject);
        }
        catch (error) {
            if (markedSeen)
                this.seenIds.delete(event.id);
            throw error;
        }
    }
    /** 通過驗簽、時鐘窗與重放檢查之後：限速、政策、寫庫，收下才扇出。拒收一律經過 `reject`。 */
    admit(connId, event, now, reject) {
        // 速率限制（ADR-0235 H1）：以**認證連線的身分**計數，不是事件作者。
        //
        // 🔴 為什麼不能用 `event.pubkey`：Gift Wrap（kind 1059）的外層作者是一次性臨時金鑰，
        // 每則訊息一把不同的 pubkey——per-author 的速率桶對它們形同虛設，一個認證身分可無限灌。
        // 改用 `authState.pubkey`（requireAuth 時必存在，且是經證明的真實寄件人）→ 換連線也繞不過
        // （重連須以同身分重新 AUTH，落回同一個桶）。開放中繼（無 AUTH）退回事件作者，維持原行為。
        const perMinute = this.opts.maxEventsPerMinute;
        const rateKey = this.authState.get(connId)?.pubkey ?? event.pubkey;
        if (perMinute !== undefined && !this.allowRate(rateKey, now, perMinute)) {
            return reject(REJECT.eventsRateLimited);
        }
        // 宿主接手（SDK ADR 0049 §7）：放在速率限制之後——被接手的事件同樣受速率桶約束
        const handled = this.opts.intercept?.(connId, event, this.authState.get(connId)?.pubkey);
        if (handled !== undefined)
            return handled;
        // NIP-62 清除請求（ADR-0260）：這是**命令**不是留言——不寫庫、不扇出，執行完就回 OK。
        // 位置在速率限制**之後**（清除是昂貴操作，同樣要受速率桶約束）、寫庫之前（kind 62 落在
        // 一般持久化區間，不攔就會被當成留言存起來）。
        if (event.kind === VANISH_KIND) {
            const result = this.handleVanish(connId, event);
            return result[0]?.message[2] === false ? reject(String(result[0].message[3])) : result;
        }
        // 收件確認（SDK ADR 0067）：同樣是**命令**——不存、不扇出。位置與 NIP-62 相同（速率限制之後）。
        if (event.kind === INBOX_ACK_KIND && this.opts.inboxAckGraceSec !== undefined && this.opts.store?.ackInbox) {
            const self = this.authState.get(connId)?.pubkey;
            if (self === undefined) {
                // 車道不強制 AUTH，但「自己的收件匣」只有 AUTH 證明得了（同 ADR-0369 的 `#p`）
                const out = reject(REJECT.authRequired);
                const state = this.authState.get(connId);
                if (state)
                    out.push({ to: connId, message: ["AUTH", state.challenge] });
                return out;
            }
            if (self !== event.pubkey)
                return reject(REJECT.ackSelfOnly);
            const ids = inboxAckIdsOf(event);
            if (ids === null)
                return reject(REJECT.ackMalformed);
            this.opts.store.ackInbox(self, ids, now + this.opts.inboxAckGraceSec, now);
            return [{ to: connId, message: ["OK", event.id, true, ""] }];
        }
        // 檔案塊（FILE_WRAP=1060，ADR-0162）：企業限定——`acceptFileEvents` 未啟用整類拒收
        //（公共站零儲存風險）；啟用後仍有單顆大小 sanity 上限。
        if (event.kind === FILE_WRAP_KIND) {
            if (!this.opts.acceptFileEvents) {
                return reject(REJECT.filesDisabled);
            }
            if (JSON.stringify(event).length > FILE_EVENT_MAX_BYTES) {
                return reject(REJECT.fileChunkTooLarge);
            }
        }
        // Ephemeral 純轉發、不寫 D1；其餘（持久化）需通過 PoW 並寫入持久層。
        /** `OK true` 的說明：借用或接近天花板時帶 `warning:`（SDK ADR 0042），其他情況是空字串（與 v0.33 相同）。 */
        let note = "";
        if (!isEphemeral(event.kind)) {
            const minPow = this.opts.minPowDifficulty ?? 0;
            if (minPow > 0 && leadingZeroBits(event.id) < minPow) {
                return reject(powRejectMessage(minPow));
            }
            if (isReplaceableOrAddressable(event.kind)) {
                // 取代語意（ADR-0035 可取代／0071 可尋址）：每 (kind, pubkey, d) 只留最新一顆。
                // 沒有這條，relay 清單（10037）這類事件會不斷累積——cron 每小時發一次，
                // 客戶端每次連線就得下載上百份重複。遭拒＝OK false（不扇出）。
                // 被拒的原因拆開回報（SDK ADR 0038 P0-R2）：較舊、太大、位址數、總量、已過期、DO 天花板。
                // 只實作 boolean 的自訂 store 說不出原因，回舊的那一句。
                const store = this.opts.store;
                if (store?.putAddressableResult) {
                    const result = store.putAddressableResult(event, this.now());
                    if (!result.ok)
                        return reject(ADDRESSABLE_REJECT[result.reason]);
                    note = okNote(result);
                }
                else if (store && !store.putAddressable(event, this.now())) {
                    return reject(ADDRESSABLE_REJECT_GENERIC);
                }
            }
            else if (this.opts.store) {
                // 離線留言（SDK ADR 0038 P0-R1）：`put()` 回 false 只有兩種原因——事件自帶的 `expiration`
                // 已經過了，或這顆 DO 的離線天花板滿了而這個平面不淘汰（嚴格平面，Cinderous ADR-0367 §決策 2）。
                // 兩種都回 `OK false`、**不扇出**：NIP-01 的 `false` 就是「沒收下」，轉送一顆沒收下的事件會讓
                // 在線收件人收到、離線的裝置收不到，寄件端再依 `false` 重送時在線的那台還會收到第二次。
                // 每收件人 FIFO 與車道淘汰是「收下新的、刪掉舊的」，`put()` 回 true，不走這裡。
                const expiration = getExpiration(event);
                if (expiration !== undefined && expiration <= now)
                    return reject(EXPIRED_REJECT);
                const store = this.opts.store;
                if (store.putResult) {
                    // SDK ADR 0042：收下時可能是借用（溢位帶）或接近天花板——`OK true` 帶 `warning:` 說清楚，照常扇出（收下了）。
                    const result = store.putResult(event, this.now());
                    if (!result.ok)
                        return reject(result.reason === "expired" ? EXPIRED_REJECT : OFFLINE_CEILING_REJECT);
                    note = okNote(result);
                }
                else if (!store.put(event, this.now())) {
                    return reject(OFFLINE_CEILING_REJECT);
                }
            }
        }
        return [{ to: connId, message: ["OK", event.id, true, note] }, ...this.deliver(event)];
    }
    /**
     * 宿主自己產生的事件（SDK ADR 0049 C′：relay 以閘道金鑰簽的 ack、狀態、retained）：可尋址與一般事件照取代／離線語意寫庫，
     * 再扇出給符合的訂閱。不經速率限制與白名單（是宿主自己簽的，不是哪條連線送來的）；寫庫被拒就不扇出、回空陣列。
     */
    publishLocal(event) {
        const now = this.now();
        if (!isEphemeral(event.kind) && this.opts.store) {
            const store = this.opts.store;
            if (isReplaceableOrAddressable(event.kind)) {
                const ok = store.putAddressableResult ? store.putAddressableResult(event, now).ok : store.putAddressable(event, now);
                if (!ok)
                    return [];
            }
            else {
                const ok = store.putResult ? store.putResult(event, now).ok : store.put(event, now);
                if (!ok)
                    return [];
            }
        }
        this.seenIds.set(event.id, event.created_at);
        return this.deliver(event);
    }
    /** 對符合的訂閱扇出（不含給寄件人的 OK） */
    deliver(event) {
        const out = [];
        const candidates = new Set(this.byKind.get(event.kind));
        for (const entry of this.anyKindSubs)
            candidates.add(entry);
        for (const entry of candidates) {
            // ADR-0071：快照只回給作者本人——requireAuth 時即時扇出也閘門（ADR-0366 §決策 5 收窄）。
            if (this.requireAuth && isAuthorOnlyKind(event.kind) && this.authState.get(entry.connId)?.pubkey !== event.pubkey) {
                continue;
            }
            if (entry.filters.some((f) => matchFilter(f, event))) {
                out.push({ to: entry.connId, message: ["EVENT", entry.subId, event] });
            }
        }
        return out;
    }
    /**
     * NIP-62 Request to Vanish（ADR-0260）：清除此 pubkey 在本站的一切。
     *
     * 三道閘，順序即嚴格程度：
     *
     * 1. **身分**：`requireAuth` 時要求已認證身分＝事件作者。簽章本身已證明作者身分，這一條擋的
     *    是**重放**——側錄到一顆舊的 vanish 事件（它是公開的、任何連上的人都可能看到），日後拿來
     *    重送。重放者過不了以該身分進行的 NIP-42 AUTH。（`seenIds` 只覆蓋近一小時。）
     * 2. **目標**：`relay` tag 必須是本站或 `ALL_RELAYS`（`vanishTargetsRelay` 對缺主機資訊時
     *    **fail-closed**，見 core `vanish.ts`）。
     * 3. **執行**：交給 store 刪除，不寫庫、不扇出。
     *
     * **刻意不扇出**：把「某某人要求清除資料」廣播給所有訂閱者，等於用一則公開事件宣告這個人的
     * 動作與時間點——與 Gift Wrap 藏元資料的整個立場相反。客戶端本來就是直接對每座 relay 送出
     * 請求（見 engine `requestVanish`），不需要靠中繼轉發。
     */
    handleVanish(connId, event) {
        const state = this.authState.get(connId);
        if (this.requireAuth && state?.pubkey !== event.pubkey) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.vanishSelfOnly] }];
        }
        if (!vanishTargetsRelay(event, this.connHost.get(connId))) {
            return [{ to: connId, message: ["OK", event.id, false, REJECT.vanishRelayTag] }];
        }
        this.opts.store?.vanish(event.pubkey, this.now());
        return [{ to: connId, message: ["OK", event.id, true, ""] }];
    }
    index(entry) {
        const self = this.authState.get(entry.connId)?.pubkey;
        if (self !== undefined && readsOwnInbox(entry.filters, self)) {
            entry.inbox = self;
            this.inboxSubs.set(self, (this.inboxSubs.get(self) ?? 0) + 1);
        }
        for (const kind of entry.kinds) {
            let set = this.byKind.get(kind);
            if (!set) {
                set = new Set();
                this.byKind.set(kind, set);
            }
            set.add(entry);
        }
        if (entry.anyKind)
            this.anyKindSubs.add(entry);
    }
    /** 移除重放窗外、不再可能重放的已見 id，避免無限成長。 */
    pruneSeen(cutoffSec) {
        for (const [id, createdAt] of this.seenIds) {
            if (createdAt < cutoffSec)
                this.seenIds.delete(id);
        }
    }
    /**
     * 固定時間窗計數（ADR-0235 H1）：同一 pubkey 在 60 秒窗內超過上限即拒。
     *
     * 刻意用固定窗而非令牌桶：DO 會在訊息之間休眠，記憶體狀態隨時可能消失——複雜的
     * 累積式演算法在這種環境下只是假象。固定窗即使被休眠重置，也仍然把「單次爆量」
     * 壓在上限以內，而那正是要防的東西。
     */
    /**
     * 每連線的固定窗計數（ADR-0366 §容量）。與 {@link allowRate} 同一套演算法與同一個理由：
     * DO 會休眠、記憶體會被清空，滑動窗在這種環境下只是假象；固定窗即使被休眠重置，
     * 也仍然把**單次爆量**壓在上限以內，而那正是要防的東西。
     */
    /** 每 IP、每秒的固定視窗計數（SDK ADR 0013）。 */
    allowIpRate(ip, nowSec, perSecond) {
        const entry = this.ipRate.get(ip);
        if (!entry || entry.second !== nowSec) {
            this.ipRate.set(ip, { second: nowSec, count: 1 });
            // 表格只留目前這一秒的 IP：舊的一秒一到就沒用了，不讓它無限長大
            if (this.ipRate.size > 10_000)
                for (const [key, value] of this.ipRate)
                    if (value.second !== nowSec)
                        this.ipRate.delete(key);
            return true;
        }
        entry.count += 1;
        return entry.count <= perSecond;
    }
    allowConnRate(connId, nowSec, perMinute) {
        const entry = this.connRate.get(connId);
        if (!entry || nowSec - entry.windowStart >= 60) {
            this.connRate.set(connId, { windowStart: nowSec, count: 1 });
            return true;
        }
        if (entry.count >= perMinute)
            return false;
        entry.count += 1;
        return true;
    }
    allowRate(pubkey, nowSec, perMinute) {
        const entry = this.rate.get(pubkey);
        if (!entry || nowSec - entry.windowStart >= 60) {
            this.rate.set(pubkey, { windowStart: nowSec, count: 1 });
            // 順帶清掉早已過窗的條目，避免 map 隨著陌生 pubkey 無限成長。
            if (this.rate.size > 4096) {
                for (const [pk, e] of this.rate)
                    if (nowSec - e.windowStart >= 60)
                        this.rate.delete(pk);
            }
            return true;
        }
        if (entry.count >= perMinute)
            return false;
        entry.count += 1;
        return true;
    }
    /**
     * 從索引拿掉一條訂閱。`delivered`：這條訂閱就此結束（CLOSE、斷線）——它若是收件匣訂閱、又是那人最後一條，
     * 記下「到這裡為止的留言都即時送到了」（SDK ADR 0042 丟棄計數的水位線）。同一個 id 換新訂閱時傳 false。
     */
    unindex(entry, delivered = true) {
        if (entry.inbox !== undefined) {
            const left = (this.inboxSubs.get(entry.inbox) ?? 1) - 1;
            if (left > 0)
                this.inboxSubs.set(entry.inbox, left);
            else {
                this.inboxSubs.delete(entry.inbox);
                if (delivered)
                    this.opts.store?.markDelivered?.(entry.inbox, this.now());
            }
        }
        for (const kind of entry.kinds) {
            const set = this.byKind.get(kind);
            if (set) {
                set.delete(entry);
                if (set.size === 0)
                    this.byKind.delete(kind);
            }
        }
        this.anyKindSubs.delete(entry);
    }
}
/**
 * filter 是否帶了**非 `#p`** 的標籤條件（ADR-0366 §決策 5 的「具名」放寬）。
 *
 * 空陣列不算——`{"#t":[]}` 匹配不到任何東西，放行它等於放行裸 filter 的成本
 * 而沒有任何收穫（同 ADR-0123 對 `authors: []` 的推理，只是方向相反：
 * 那裡放行是因為新使用者真的會送出它，這裡沒有任何合法客戶端會送 `#t: []`）。
 */
function hasTagScope(filter) {
    for (const key in filter) {
        if (key.charCodeAt(0) !== 35 /* '#' */)
            continue;
        if (key === "#p")
            continue;
        const values = filter[key];
        if (values && values.length > 0)
            return true;
    }
    return false;
}
/**
 * 這組 filter 是 `self` 在讀自己的收件匣嗎（SDK ADR 0042）：某個 filter 的 `#p` 含 `self`，而且那個 filter 不只收 ephemeral
 *（通話信令這類只收 ephemeral 的訂閱不會讀到離線留言，不該拿走丟棄計數）。
 */
function readsOwnInbox(filters, self) {
    return filters.some((f) => f["#p"]?.includes(self) === true && (f.kinds === undefined || f.kinds.length === 0 || f.kinds.some((k) => !isEphemeral(k))));
}
/** `OK true` 的說明文字（SDK ADR 0042）：借用優先於接近天花板；都不是就是空字串。 */
function okNote(result) {
    if (result.borrowedTtlSec !== undefined)
        return borrowedWarning(result.borrowedTtlSec);
    if (result.nearFull !== undefined)
        return nearFullWarning(result.nearFull);
    return "";
}
function buildEntry(connId, subId, filters) {
    const kinds = new Set();
    let anyKind = false;
    for (const filter of filters) {
        if (filter.kinds && filter.kinds.length > 0) {
            for (const kind of filter.kinds)
                kinds.add(kind);
        }
        else {
            anyKind = true;
        }
    }
    return { connId, subId, filters, kinds: [...kinds], anyKind };
}
/**
 * 儲存額度用完時給這條連線的回覆（SDK ADR 0127）：先結案它這一則（EVENT→`OK false`、REQ→`CLOSED`），
 * 再一則 NOTICE 並以 1013 關閉。從原始訊息只取 EVENT 的 id 與 REQ 的訂閱 id，取不到就只送 NOTICE。
 */
export function storageExhausted(connId, raw) {
    const { notice, reason } = STORAGE_QUOTA_REJECTION;
    const out = [];
    try {
        const msg = JSON.parse(raw);
        if (Array.isArray(msg) && msg[0] === "EVENT" && typeof msg[1]?.id === "string") {
            out.push({ to: connId, message: ["OK", msg[1].id, false, notice] });
        }
        else if (Array.isArray(msg) && msg[0] === "REQ" && typeof msg[1] === "string") {
            out.push({ to: connId, message: ["CLOSED", msg[1], notice] });
        }
    }
    catch {
        /* 解析不了：只送 NOTICE */
    }
    out.push({ to: connId, message: ["NOTICE", notice], close: { code: UPGRADE_UNAVAILABLE_CLOSE_CODE, reason } });
    return out;
}
//# sourceMappingURL=relay-core.js.map