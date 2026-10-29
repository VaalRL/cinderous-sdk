import { matchFilter } from "./filters.js";
import { ADDRESSABLE_MAX_BYTES, ADDRESSABLE_PUT_OK, addressableRejected, ADDRESSABLE_MAX_PER_AUTHOR, ADDRESSABLE_TTL_SECONDS, DEFAULT_FILE_PER_RECIPIENT, DEFAULT_MAX_TTL_SECONDS, dedupById, FILE_WRAP_KIND, batchOf, dTagOf, effectiveExpiration, getExpiration, isAddressablePurge, queryLimit, recipientsOf, shouldReplace, } from "./message-store.js";
import { BORROW_TTL_SECONDS, borrowedExpiration, borrowPerKey, decideCapacity, DROPPED_RECIPIENTS_MAX, mergeDropped, nearFullGrade, overflowBand, pickExcess, } from "./capacity.js";
/**
 * 「`column` 是這些值之一」的 SQL 片段——**整個陣列只佔一個綁定參數**（Cinderous ADR-0372；SDK ADR 0032）。
 *
 * 🔴 為什麼不是 `IN (?, ?, …)`：Durable Object 的 SQLite 每次查詢**最多 100 個綁定參數**
 * （Cloudflare 官方 Limits 頁），超過時 `sql.exec()` 直接拋例外。`relay-core.scoped()` 允許
 * `authors` 到 1024 把，`ids`／`kinds`／標籤值也沒有個別上限 ⇒ 一個 99 把作者的 REQ 就會
 * 讓查詢失敗、客戶端只收到 NOTICE「內部錯誤」、連 EOSE 都沒有。本機測試用的 node:sqlite
 * 上限是 32766，所以單元測試永遠看不出來。
 *
 * 改成把陣列序列化成**一個** JSON 字串，SQL 端用 `json_each(?)` 展開：值的數量與綁定參數
 * 脫鉤，查詢語意（IN）、排序、`LIMIT`、位元組預算全部不變，也不需要分批再在應用層合併。
 * `json_each` 本來就在用（標籤下推，ADR-0366 P1 #5），DO 上已驗證可用。
 *
 * 非陣列（惡意／錯誤的 filter）照舊拋例外——與修正前 `values.map` 拋錯的行為一致，
 * 由 `RelayCore.handle` 的例外圍籬轉成 NOTICE。
 */
function inJson(column, values) {
    if (!Array.isArray(values))
        throw new TypeError("filter 值必須是陣列");
    return { clause: `${column} IN (SELECT value FROM json_each(?))`, binding: JSON.stringify(values) };
}
/**
 * 從 filter 取出**非 `#p`** 的標籤條件（ADR-0366 P1 #5）。
 *
 * `#p` 不在此列：它有自己的 `recipient` 欄與索引（也是配額與 NIP-62 清除的鍵），
 * 走既有那條路比多存一份重複的標籤列划算。
 */
function tagFiltersOf(filter) {
    const out = [];
    for (const key in filter) {
        if (key.charCodeAt(0) !== 35 /* '#' */ || key === "#p")
            continue;
        const values = filter[key];
        if (values)
            out.push({ name: key.slice(1), values });
    }
    return out;
}
/**
 * 把標籤條件組成 SQL 的 `EXISTS(json_each(...))` 子句（ADR-0366 P1 #5）。
 *
 * ## 為什麼一定要下推，而不是留在 JS 端
 *
 * 修正前，`#t`／`#d`／`#w` 這類標籤 filter **只在 `matchFilter` 判**，而那發生在
 * `ORDER BY created_at DESC LIMIT ?` **之後**。於是「一萬顆同 kind 事件裡找某個標籤」
 * 會先取最新的 N 顆、再過濾 → **匹配不到就回空陣列**，而目標明明還在庫裡。
 * 那不是效能問題，是**正確性**問題：查詢回報「沒有」，但答案是「有，只是不在最新 N 顆裡」。
 *
 * 記憶體版（{@link MessageStore}）一直都是「先 `matchFilter` 再 limit」＝正確；
 * 兩個實作共用同一份 `OfflineStore` 契約，分歧會讓記憶體版寫的測試保證不了產線的 SQL 版。
 *
 * ## 為什麼是 `json_each` 而不是另建標籤索引表
 *
 * 索引表要在 `put`／`putAddressable`／`enforceCap`／`prune`／`vanish`／取代 這六條路徑上
 * 同步刪乾淨，漏一條就是 ADR-0065 最在意的那種孤兒列。`json_each` 是**掃描**，但它掃的是
 * **已經被 kind／pubkey／since／expiration 索引縮小過**的候選集，而每顆 DO 的資料受 7 天 TTL
 * 有界。⇒ 先把正確性補上、把代價維持有界；真的量到慢再談索引表（列為後續）。
 */
function pushTagClauses(table, filter, where, bind) {
    for (const { name, values } of tagFiltersOf(filter)) {
        // 每個標籤鍵固定 2 個綁定參數（名稱＋整串值），與值的數量無關（Cinderous ADR-0372）。
        const vals = inJson("json_extract(tg.value, '$[1]')", values);
        where.push(`EXISTS (SELECT 1 FROM json_each(${table}.json, '$.tags') AS tg
               WHERE json_extract(tg.value, '$[0]') = ?
                 AND ${vals.clause})`);
        bind.push(name, vals.binding);
    }
}
/** 附加一條「欄位屬於這串值」的 WHERE 子句——整串值只佔一個綁定參數（Cinderous ADR-0372）。 */
const pushIn = (where, bind, column, values) => {
    // 只有一個值時直接比等號（SDK ADR 0103）：`IN (json_each)` 讓 SQLite 不能順著索引的順序讀，
    // 分頁查詢（外掛啟動補拉收件匣）每一頁都得把剩下的列全部拿出來排序；`=` 讀夠一頁就停。
    const only = Array.isArray(values) && values.length === 1 ? values[0] : undefined;
    if (typeof only === "string" || typeof only === "number") {
        where.push(`${column} = ?`);
        bind.push(only);
        return;
    }
    const { clause, binding } = inJson(column, values);
    where.push(clause);
    bind.push(binding);
};
/**
 * 離線留言持久層的 SQL 版（ADR-0056）：以 DO 內建 SQLite 落地，行為對齊記憶體版
 * {@link MessageStore}（NIP-40 過期、每收件人配額、`#p` 索引），但同步、可持久。
 *
 * schema：每個 `p` 標籤一列（`(id, recipient)` 為主鍵）；無 `p` 者以 `recipient=''` 存。
 */
export class SqlMessageStore {
    sql;
    opts;
    constructor(sql, opts = {}) {
        this.sql = sql;
        this.opts = opts;
        this.sql(`CREATE TABLE IF NOT EXISTS offline_msgs (
        id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        expiration INTEGER,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (id, recipient)
      )`);
        this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_expiration ON offline_msgs(expiration)`);
        // 可尋址事件（NIP-33，ADR-0071 快照）：每 (kind, pubkey, d) 一列、新的取代舊的。
        this.sql(`CREATE TABLE IF NOT EXISTS addressable (
        kind INTEGER NOT NULL,
        pubkey TEXT NOT NULL,
        d TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expiration INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (kind, pubkey, d)
      )`);
        this.sql(`CREATE INDEX IF NOT EXISTS idx_addressable_expiration ON addressable(expiration)`);
        // 每作者總量查詢用（ADR-0366 §容量二）：主鍵是 (kind, pubkey, d)，前綴是 kind，
        // 所以 `WHERE pubkey = ?` 走不到主鍵 ⇒ 沒有這個索引就是每次寫入掃全表。
        this.sql(`CREATE INDEX IF NOT EXISTS idx_addressable_pubkey ON addressable(pubkey)`);
        // ADR-0065 遷移：修正前寫入的無到期列（NULL）補上有界壽命，讓 prune 能收走。
        this.sql(`UPDATE offline_msgs SET expiration = created_at + ? WHERE expiration IS NULL`, opts.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS);
        // ADR-0235 C2 遷移：新增 `pubkey`／`kind` 欄與索引，讓 authors/kinds 過濾能下推到 SQL。
        // 舊 DB 沒有這兩欄；`ADD COLUMN` 已存在時會拋，吞掉即可（等冪）。回填由 json 抽出。
        for (const ddl of [
            `ALTER TABLE offline_msgs ADD COLUMN pubkey TEXT`,
            `ALTER TABLE offline_msgs ADD COLUMN kind INTEGER`,
            // Cinderous ADR-0371 §決策 5：每列的位元組數。總量與天花板改讀這一欄（有索引），
            // 不再 `SUM(LENGTH(json))`——後者要把每一列的 json 從溢位頁讀出來（實測 260MB 約 1.4 秒）。
            `ALTER TABLE offline_msgs ADD COLUMN bytes INTEGER`,
        ]) {
            try {
                this.sql(ddl);
            }
            catch {
                /* 欄位已存在 */
            }
        }
        // 🔴 先建索引、條件只看 `pubkey`（SDK ADR 0126）：這段每次建 store 都跑（DO 每次喚醒建兩次），
        // 原本的 `pubkey IS NULL OR kind IS NULL` 用不到任何索引、每次都掃全表——2026-10-22 錨點 1 讀取額度用完的來源之一。
        // 兩欄一直是一起寫的（這段回填與每一次 INSERT），只看 `pubkey` 不會漏；`IS NULL` 走 pubkey 索引，沒有舊列時讀 0 列。
        this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_pubkey ON offline_msgs(pubkey)`);
        this.sql(`UPDATE offline_msgs SET pubkey = json_extract(json, '$.pubkey'), kind = json_extract(json, '$.kind')
       WHERE pubkey IS NULL`);
        // SDK ADR 0098（Cinderous ADR-0388）：`idx_offline_kind` 拿掉了。`#p` 查詢走分桶索引、`authors` 查詢走 pubkey 索引；
        // 它只會在 `authors+kinds` 時被規劃器誤選（kind 的選擇性遠低於 pubkey），卻讓每次寫入與刪除各多寫一列（DO 依寫入列數計費）。
        // 舊版程式打開時會把它建回來（`IF NOT EXISTS`，回滾照常），這裡再拿掉。
        this.sql(`DROP INDEX IF EXISTS idx_offline_kind`);
        // Cinderous ADR-0371 §決策 5：分桶索引——分桶修剪、`#p` 查詢與總量加總都只讀索引，不碰 json。
        //
        // 🔴 為什麼要把欄位塞進索引：`kind`／`bytes` 是後來 `ADD COLUMN` 加的，在列裡排在 json
        // **後面**。一顆檔案塊的 json 約 131KB、落在溢位頁上，讀它後面的欄位就得把整串溢位頁走完
        // ——修正前每次寫入都對該收件人的每一列這樣做（實測 1500 列約 0.4 秒）。
        // 它以 `recipient` 開頭，取代原本的 `idx_offline_recipient`（少一個索引＝每次寫入少寫一列）。
        this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_bucket ON offline_msgs(recipient, kind, created_at, expiration, bytes)`);
        this.sql(`DROP INDEX IF EXISTS idx_offline_recipient`);
        // 回填升級前的列。部分索引只收 `bytes IS NULL` 的列（新列一律有值 ⇒ 它恆為空、不增加寫入），
        // 讓這條 UPDATE 在每次喚醒時都不必掃全表。
        this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_bytes_missing ON offline_msgs(id) WHERE bytes IS NULL`);
        this.sql(`UPDATE offline_msgs SET bytes = LENGTH(json) WHERE bytes IS NULL`);
        // SDK ADR 0042：溢位帶的借用標記與丟棄計數。全部是「加欄位（有預設值）／加索引／加表」——
        // 舊版程式（Cinderous main、SDK v0.33）打開同一顆 DO 照常讀寫：它的 INSERT 不帶 `borrowed`，得到預設 0；
        // 新表它不認得、不碰。借用列的到期時間本來就寫在 `expiration`（2 小時），回滾後照樣會被 prune 收走。
        for (const ddl of [
            `ALTER TABLE offline_msgs ADD COLUMN borrowed INTEGER NOT NULL DEFAULT 0`,
            `ALTER TABLE addressable ADD COLUMN borrowed INTEGER NOT NULL DEFAULT 0`,
        ]) {
            try {
                this.sql(ddl);
            }
            catch {
                /* 欄位已存在 */
            }
        }
        // 部分索引：只收借用列（通常是零列）⇒ 正常寫入不多寫任何索引項。借用量、借用列淘汰、借用到期的丟棄計數都只讀它。
        // 欄位要涵蓋那幾條查詢（recipient、pubkey、expiration、bytes、created_at）：不回大表讀排在 json 後面的欄位。
        this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_borrowed ON offline_msgs(recipient, pubkey, expiration, bytes, created_at) WHERE borrowed = 1`);
        this.sql(`CREATE INDEX IF NOT EXISTS idx_addressable_borrowed ON addressable(pubkey, expiration) WHERE borrowed = 1`);
        // SDK ADR 0085：檔案塊的批次（`expiration` 標籤的原始值；借用列的 `expiration` 欄會被改成 2 小時，不能拿它當批次）。
        // 加欄位（可為 NULL）＋部分索引：舊版程式的 INSERT 不帶它（NULL＝不參與整批淘汰），回滾照常讀寫。
        // 索引涵蓋整批淘汰要讀的欄位——`batch` 是 ADD COLUMN 加的、排在 json 後面，讀大表就要走完檔案塊的溢位頁。
        try {
            this.sql(`ALTER TABLE offline_msgs ADD COLUMN batch INTEGER`);
        }
        catch {
            /* 欄位已存在 */
        }
        this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_batch ON offline_msgs(recipient, batch, bytes, created_at) WHERE batch IS NOT NULL`);
        // 每位收件人的丟棄計數與水位線（`mark`＝上次讀收件匣時的 offline_msgs 最大 rowid）。
        this.sql(`CREATE TABLE IF NOT EXISTS inbox_drops (
        recipient TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        since INTEGER,
        until INTEGER,
        mark INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`);
        this.sql(`CREATE INDEX IF NOT EXISTS idx_inbox_drops_updated ON inbox_drops(updated_at)`);
    }
    /**
     * 離線留言目前佔用的位元組（快取；`undefined`＝下次用到時重算一次）。Cinderous ADR-0371 §決策 5。
     *
     * 🔴 為什麼要快取：天花板每次寫入都要問「現在用了多少」。就算改讀索引，`SUM` 仍要掃過
     * **每一列**的索引項，而 Cloudflare 以「讀取列數」計費（免費層每日 500 萬列）——一顆滿載的
     * 檔案車道 DO 有數千列，上傳一個 30MB 檔（656 塊）就會把一整天的額度讀光。
     * 寫入時加、刪除時減；刪除路徑算不出確切數字的（prune、vanish）直接作廢，下次重算。
     */
    offlineUsed;
    /** 每個（收件人, 桶）目前的列數（快取，理由同上）。鍵見 {@link bucketKey}。 */
    bucketCounts = new Map();
    /** 借用列的總量（快取；SDK ADR 0042）。只在天花板滿了才用得到，從部分索引算、很便宜。 */
    offlineBorrowed;
    /**
     * 每個 key（收件人；沒有收件人的列＝作者）的**正常列**用量（快取；SDK ADR 0042 保底份額）。
     * 只有設了保底、而且天花板滿了才建（一次掃過分桶索引），之後寫入時加、刪除時減或重算那一個 key。
     */
    ownerNormal;
    /** 丟棄計數表的列數（快取；上限 `DROPPED_RECIPIENTS_MAX`）。 */
    dropRows;
    /** 誰正在線上收自己的收件匣（`RelayCore` 設定；SDK ADR 0042）。 */
    inboxProbe = () => false;
    /** 作廢所有快取（下次用到時從索引重算）。 */
    invalidateUsage() {
        this.offlineUsed = undefined;
        this.offlineBorrowed = undefined;
        this.ownerNormal = undefined;
        this.bucketCounts.clear();
    }
    setInboxProbe(probe) {
        this.inboxProbe = probe;
    }
    /**
     * 資料庫大小證明「加上 `need` 也不超過 `limit`」嗎（SDK ADR 0126）。沒給上界＝證明不了。
     * 只在快取是空的時候用得到（喚醒後）：快取在，精算本來就不必讀任何一列。
     */
    boundedUnder(need, limit) {
        const bound = this.upperBound();
        return bound !== undefined && bound + need <= limit;
    }
    /** 宿主給的上界；沒給或不是有限的非負數（測試替身、宿主不支援）＝沒有上界，照舊精算。 */
    upperBound() {
        const bound = this.opts.sizeUpperBound?.();
        return typeof bound === "number" && Number.isFinite(bound) && bound >= 0 ? bound : undefined;
    }
    /** 寫入後的預警等級；上界證明沒到預警線就不精算（SDK ADR 0126）。 */
    offlineNearFull() {
        const { offlineMaxTotalBytes: max, nearFullPercent: percent } = this.opts;
        const bound = this.offlineUsed === undefined ? this.upperBound() : undefined;
        if (bound !== undefined && nearFullGrade(bound, max, percent) === undefined)
            return undefined;
        return nearFullGrade(this.usedOfflineBytes(), max, percent);
    }
    usedOfflineBytes() {
        if (this.offlineUsed === undefined) {
            this.offlineUsed =
                Number(this.sql(`SELECT COALESCE(SUM(bytes), 0) AS n FROM offline_msgs`)[0]?.n ?? 0) || 0;
        }
        return this.offlineUsed;
    }
    /** 借用列的總量（部分索引 `idx_offline_borrowed`，只掃借用列）。 */
    borrowedOfflineBytes() {
        if (this.offlineBorrowed === undefined) {
            this.offlineBorrowed =
                Number(this.sql(`SELECT COALESCE(SUM(bytes), 0) AS n FROM offline_msgs WHERE borrowed = 1`)[0]?.n ?? 0) || 0;
        }
        return this.offlineBorrowed;
    }
    /** 某個 key 的借用量（部分索引）。 */
    ownerBorrowedBytes(owner) {
        return (Number(this.sql(`SELECT COALESCE(SUM(bytes), 0) AS n FROM offline_msgs
           WHERE borrowed = 1 AND (recipient = ? OR (recipient = '' AND pubkey = ?))`, owner, owner)[0]?.n ?? 0) || 0);
    }
    /**
     * 每個 key 的正常列用量（SDK ADR 0042）。
     *
     * 🔴 刻意不在大表上讀 `borrowed` 欄：它是 `ADD COLUMN` 加的、排在 json 後面，檔案塊的 json 在溢位頁上，
     * 讀它要把整串溢位頁走完（Cinderous ADR-0371 §決策 5 的教訓）。所以用「分桶索引上的總量 − 部分索引上的借用量」。
     */
    ownerNormalUsage() {
        if (this.ownerNormal !== undefined)
            return this.ownerNormal;
        const usage = new Map();
        const add = (rows, sign) => {
            for (const row of rows) {
                const owner = String(row.o);
                usage.set(owner, (usage.get(owner) ?? 0) + sign * (Number(row.n ?? 0) || 0));
            }
        };
        add(this.sql(`SELECT recipient AS o, SUM(bytes) AS n FROM offline_msgs WHERE recipient != '' GROUP BY recipient`), 1);
        add(this.sql(`SELECT pubkey AS o, SUM(bytes) AS n FROM offline_msgs WHERE recipient = '' GROUP BY pubkey`), 1);
        add(this.sql(`SELECT CASE WHEN recipient = '' THEN pubkey ELSE recipient END AS o, SUM(bytes) AS n
         FROM offline_msgs WHERE borrowed = 1 GROUP BY o`), -1);
        this.ownerNormal = usage;
        return usage;
    }
    put(event, nowSec) {
        return this.putResult(event, nowSec).ok;
    }
    /** 同 {@link put}，說出結果的細節（SDK ADR 0042）。行為與記憶體版對齊。 */
    putResult(event, nowSec) {
        const exp = getExpiration(event);
        if (exp !== undefined && exp <= nowSec)
            return { ok: false, reason: "expired" };
        // ADR-0065：一律存「有效到期時間」（無標籤給預設 TTL、超長標籤截到上限）——每列壽命必有界。
        const effExp = effectiveExpiration(event, nowSec, this.opts.maxTtlSeconds);
        const recipients = recipientsOf(event);
        // 去重：重複的 `p` 標籤在表裡只會是一列（主鍵 (id, recipient)），快取也只能算一份。
        const targets = [...new Set(recipients.length > 0 ? recipients : [""])];
        const json = JSON.stringify(event);
        const size = json.length;
        // 已經存過的那幾列不再計入（`INSERT OR IGNORE` 會略過它們；快取不能把它們算兩次）。
        const present = new Set(this.sql(`SELECT recipient FROM offline_msgs WHERE id = ?`, event.id).map((r) => r.recipient));
        const fresh = targets.filter((r) => !present.has(r));
        if (fresh.length === 0)
            return { ok: true };
        // 天花板照「列」算：每位收件人各一列（無 `p` 者一列，`recipient = ''`）。保底的 key：收件人，沒有收件人＝作者。
        const owners = [...new Set(fresh.map((r) => (r === "" ? event.pubkey : r)))];
        const placed = this.placeOffline(size, fresh.length, owners, nowSec);
        if (placed === undefined)
            return { ok: false, reason: "ceiling" };
        const ttl = this.opts.borrowTtlSeconds ?? BORROW_TTL_SECONDS;
        const expiration = placed.borrowed ? borrowedExpiration(effExp, nowSec, ttl) : effExp;
        for (const recipient of fresh) {
            this.sql(`INSERT OR IGNORE INTO offline_msgs (id, recipient, expiration, created_at, json, pubkey, kind, bytes, borrowed, batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, event.id, recipient, expiration, event.created_at, json, event.pubkey, event.kind, size, placed.borrowed ? 1 : 0, batchOf(event) ?? null);
        }
        if (this.offlineUsed !== undefined)
            this.offlineUsed += size * fresh.length;
        if (placed.borrowed) {
            if (this.offlineBorrowed !== undefined)
                this.offlineBorrowed += size * fresh.length;
        }
        else if (this.ownerNormal !== undefined) {
            for (const recipient of fresh) {
                const owner = recipient === "" ? event.pubkey : recipient;
                this.ownerNormal.set(owner, (this.ownerNormal.get(owner) ?? 0) + size);
            }
        }
        const file = event.kind === FILE_WRAP_KIND;
        for (const recipient of fresh) {
            const key = bucketKey(recipient, file);
            const count = this.bucketCounts.get(key);
            if (count !== undefined)
                this.bucketCounts.set(key, count + 1);
        }
        // 無條件呼叫（與記憶體版一致）：聊天桶沒設上限時 `enforceCap` 自己略過，檔案桶恆有上限。
        this.enforceCap(fresh, file, nowSec);
        if (placed.borrowed)
            return { ok: true, borrowedTtlSec: ttl };
        if (this.opts.nearFullPercent === undefined)
            return { ok: true };
        const nearFull = this.offlineNearFull();
        return nearFull === undefined ? { ok: true } : { ok: true, nearFull };
    }
    /** 寫入可取代／可尋址事件（取代語意＋配額；ADR-0035／0071）。行為對齊記憶體版。 */
    putAddressable(event, nowSec) {
        return this.putAddressableResult(event, nowSec).ok;
    }
    /** 同 {@link putAddressable}，被拒時帶原因（SDK ADR 0038 P0-R2）；收下時帶借用與預警（SDK ADR 0042）。原因與記憶體版逐字對齊。 */
    putAddressableResult(event, nowSec) {
        const d = dTagOf(event); // 可取代事件無 `d` → 空字串 → 每 (kind,pubkey) 只留一顆
        const existing = this.sql(`SELECT id, created_at, LENGTH(json) AS len, borrowed FROM addressable WHERE kind = ? AND pubkey = ? AND d = ?`, event.kind, event.pubkey, d);
        const prev = existing[0];
        if (prev) {
            // NIP-01 決勝：較新者勝；同時則保留 id 字典序較小者（各中繼站收斂到同一顆）。
            const prevEvent = { id: prev.id, created_at: prev.created_at };
            if (!shouldReplace(prevEvent, event))
                return addressableRejected("stale");
        }
        if (isAddressablePurge(event)) {
            // purge：關閉備份時「已關閉」必須立即為真（ADR-0071）；只限快照（ADR 0083）。
            this.sql(`DELETE FROM addressable WHERE kind = ? AND pubkey = ? AND d = ?`, event.kind, event.pubkey, d);
            return ADDRESSABLE_PUT_OK;
        }
        const json = JSON.stringify(event);
        if (json.length > (this.opts.addressableMaxBytes ?? ADDRESSABLE_MAX_BYTES))
            return addressableRejected("too-large");
        if (!existing[0]) {
            const count = this.sql(`SELECT COUNT(*) AS n FROM addressable WHERE kind = ? AND pubkey = ?`, event.kind, event.pubkey);
            if ((count[0]?.n ?? 0) >= (this.opts.addressablePerAuthor ?? ADDRESSABLE_MAX_PER_AUTHOR))
                return addressableRejected("address-quota");
        }
        const budget = this.opts.addressableBytesPerAuthor;
        if (budget !== undefined) {
            // 取代既有位址算**差額**：把要被取代的那一列先排除掉（行為與記憶體版逐字對齊）。
            const used = this.sql(`SELECT COALESCE(SUM(LENGTH(json)), 0) AS n FROM addressable
         WHERE pubkey = ? AND NOT (kind = ? AND d = ?)`, event.pubkey, event.kind, d);
            if ((used[0]?.n ?? 0) + json.length > budget)
                return addressableRejected("byte-quota");
        }
        let eff = effectiveExpiration(event, nowSec, this.opts.addressableTtlSeconds ?? ADDRESSABLE_TTL_SECONDS);
        if (eff <= nowSec)
            return addressableRejected("expired");
        const placed = this.placeAddressable(event, d, json.length, prev?.len ?? 0, Number(prev?.borrowed ?? 0) === 1);
        if (placed === undefined)
            return addressableRejected("ceiling");
        const ttl = this.opts.borrowTtlSeconds ?? BORROW_TTL_SECONDS;
        if (placed.borrowed)
            eff = borrowedExpiration(eff, nowSec, ttl);
        this.sql(`INSERT OR REPLACE INTO addressable (kind, pubkey, d, id, created_at, expiration, json, borrowed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, event.kind, event.pubkey, d, event.id, event.created_at, eff, json, placed.borrowed ? 1 : 0);
        if (placed.borrowed)
            return { ok: true, borrowedTtlSec: ttl };
        const nearFull = nearFullGrade(placed.usedAfter, this.opts.addressableMaxTotalBytes, this.opts.nearFullPercent);
        return nearFull === undefined ? ADDRESSABLE_PUT_OK : { ok: true, nearFull };
    }
    /**
     * 這顆 DO 放不放得下這筆離線留言、怎麼放（ADR-0367 §決策 2；SDK ADR 0042 的保底與溢位帶）。行為與記憶體版逐字對齊。
     * 回 undefined＝拒收；`borrowed`＝放進溢位帶。決策由 `capacity.ts` 的 `decideCapacity` 做，這裡只執行。
     *
     * 🔴 為什麼 FIFO 不夠：`enforceCap` 只對**真正的收件人**執行，而沒有 `p` 標籤的事件
     * 落在 `recipient = ''` ⇒ 那個桶原本只被 TTL 壓著，而遊戲的房間事件正是這個形狀。
     */
    placeOffline(size, copies, owners, nowSec) {
        const max = this.opts.offlineMaxTotalBytes;
        if (max === undefined)
            return { borrowed: false };
        const need = size * copies;
        // 喚醒後快取是空的：資料庫大小證明放得下就不 SUM 整張表（SDK ADR 0126）——與 `decideCapacity` 的 "fit" 同一個結果
        if (this.offlineUsed === undefined && this.boundedUnder(need, max))
            return { borrowed: false };
        let used = this.usedOfflineBytes();
        const guarantee = this.opts.guaranteeBytes;
        const band = overflowBand(max, this.opts.overflowRatio);
        let plan = [];
        const decision = decideCapacity({
            max,
            used,
            need,
            evicts: this.opts.ceilingEvicts === true,
            guarantee,
            band,
            planeBorrows: true,
            borrowed: () => this.borrowedOfflineBytes(),
            withinGuarantee: () => {
                const usage = this.ownerNormalUsage();
                return owners.every((o) => (usage.get(o) ?? 0) + size <= guarantee);
            },
            excessAvailable: () => {
                const usage = this.ownerNormalUsage();
                const mine = new Set(owners);
                const over = [...usage].filter(([o, n]) => n > guarantee && !mine.has(o)).map(([o]) => o);
                if (over.length === 0)
                    return 0;
                // 借用列不當候選（稍後整批刪掉）。讀部分索引拿它們的 rowid，不在大表上讀 `borrowed` 欄（見 ownerNormalUsage）。
                const borrowedRows = new Set(this.sql(`SELECT rowid AS r FROM offline_msgs WHERE borrowed = 1`).map((row) => Number(row.r)));
                const list = JSON.stringify(over);
                const candidates = this.sql(`SELECT rowid AS r, recipient, CASE WHEN recipient = '' THEN pubkey ELSE recipient END AS o, bytes, created_at
           FROM offline_msgs
           WHERE recipient IN (SELECT value FROM json_each(?)) OR (recipient = '' AND pubkey IN (SELECT value FROM json_each(?)))
           ORDER BY expiration ASC, rowid ASC LIMIT ?`, list, list, EXCESS_CANDIDATES + borrowedRows.size)
                    .filter((row) => !borrowedRows.has(Number(row.r)))
                    .map((row) => ({
                    r: Number(row.r),
                    owner: String(row.o),
                    bytes: Number(row.bytes ?? 0),
                    recipient: String(row.recipient),
                    created: Number(row.created_at),
                }));
                const picked = pickExcess(candidates, usage, guarantee, used - this.borrowedOfflineBytes() + need - max);
                plan = picked.rows;
                return picked.freed;
            },
            borrowFitsPerKey: () => {
                const perKey = borrowPerKey(band, this.opts.borrowPerKeyBytes);
                return owners.every((o) => this.ownerBorrowedBytes(o) + size <= perKey);
            },
        });
        switch (decision.type) {
            case "fit":
                return { borrowed: false };
            case "borrow":
                return { borrowed: true };
            case "reject":
                return undefined;
            case "reclaim":
            case "excess": {
                // 借用列最先淘汰（最快到期優先）。`reclaim` 刪到放得下為止；`excess` 全部刪掉，再刪計畫好的份額外列。
                // 🔴 指定部分索引（SDK ADR 0102）：不指定時規劃器為了省掉排序，改走整個到期索引——那是每一列，
                // 塞滿的檔案車道每次讀約 4,300 列；借用列通常只有幾十到幾百列，讀出來再排序便宜得多。
                const borrowedRows = this.sql(`SELECT rowid AS r, recipient, bytes, created_at FROM offline_msgs INDEXED BY idx_offline_borrowed
           WHERE borrowed = 1 ORDER BY expiration ASC, rowid ASC`);
                const dropped = [];
                // 先決定要刪哪幾列借用列（reclaim 刪到放得下為止），只查那幾列與計畫列的批次與桶別（SDK ADR 0102：不掃整個索引）
                const borrowedVictims = [];
                let room = used;
                for (const row of borrowedRows) {
                    if (decision.type === "reclaim" && room + need <= max)
                        break;
                    borrowedVictims.push(row);
                    room -= Number(row.bytes ?? 0);
                }
                const info = this.describeRows([
                    ...borrowedVictims.map((row) => Number(row.r)),
                    ...(decision.type === "excess" ? plan.map((row) => row.r) : []),
                ]);
                const batches = batchKeysOf(info);
                for (const row of borrowedVictims) {
                    this.sql(`DELETE FROM offline_msgs WHERE rowid = ?`, Number(row.r));
                    used -= Number(row.bytes ?? 0);
                    if (this.offlineBorrowed !== undefined)
                        this.offlineBorrowed -= Number(row.bytes ?? 0);
                    dropped.push({ r: Number(row.r), recipient: String(row.recipient), created: Number(row.created_at) });
                }
                if (decision.type === "excess") {
                    for (const row of plan) {
                        this.sql(`DELETE FROM offline_msgs WHERE rowid = ?`, row.r);
                        used -= row.bytes;
                        this.ownerNormal?.set(row.owner, (this.ownerNormal.get(row.owner) ?? 0) - row.bytes);
                        dropped.push(row);
                    }
                }
                // 刪掉的列照實從各桶扣掉（SDK ADR 0102：原本整個清掉，下一次寫入要重數上千列）
                this.forgetRows(dropped.map((row) => info.get(row.r)));
                this.offlineUsed = used;
                this.recordDrops(dropped, nowSec);
                this.dropBatchMates(dropped.map((row) => batches.get(row.r)), nowSec);
                return { borrowed: false };
            }
            case "legacy": {
                // v0.33 原樣：依到期時間由近而遠淘汰（一批最多 256 列），直到騰得出空間
                const victims = this.sql(`SELECT rowid AS r, recipient, bytes, created_at FROM offline_msgs ORDER BY expiration ASC LIMIT 256`);
                const info = this.describeRows(victims.map((row) => Number(row.r)));
                const batches = batchKeysOf(info);
                const dropped = [];
                for (const row of victims) {
                    if (used + need <= max)
                        break;
                    if (!this.sql(`SELECT 1 AS x FROM offline_msgs WHERE rowid = ?`, row.r).length)
                        continue; // 已隨整批刪掉
                    this.sql(`DELETE FROM offline_msgs WHERE rowid = ?`, row.r);
                    used -= Number(row.bytes ?? 0);
                    dropped.push({ r: Number(row.r), recipient: String(row.recipient), created: Number(row.created_at) });
                    this.forgetRows([info.get(Number(row.r))]);
                    // 整批淘汰（SDK ADR 0085）
                    this.offlineUsed = used;
                    used -= this.dropBatchMates([batches.get(Number(row.r))], nowSec);
                }
                // 分桶列數已逐列扣掉（SDK ADR 0102）；借用量與保底用量也照實扣掉（SDK ADR 0103）
                this.forgetUsage(dropped.map((row) => info.get(row.r)));
                this.offlineUsed = used;
                this.recordDrops(dropped, nowSec);
                return used + need <= max ? { borrowed: false } : undefined;
            }
        }
    }
    /**
     * 可尋址那一側的同一套決策（ADR-0367 §決策 2；SDK ADR 0042）。行為與記憶體版逐字對齊。
     * `replacedLen`／`replacedBorrowed` 是**即將被取代**的那一列——它會被換掉，不該算進已用空間。
     */
    placeAddressable(event, d, size, replacedLen, replacedBorrowed) {
        const max = this.opts.addressableMaxTotalBytes;
        if (max === undefined)
            return { borrowed: false, usedAfter: 0 };
        if (size > max)
            return undefined; // 單顆就超過：淘汰也救不了，別把整顆 DO 清空
        // 可尋址的總量沒有快取、每次寫入都 SUM 整張表（SDK ADR 0126）：資料庫大小證明放得下、也沒到預警線，就照 "fit" 回。
        // `usedAfter` 回上界：呼叫端只拿它判預警，而上界已證明沒到預警線。
        const bound = this.upperBound();
        if (bound !== undefined && bound + size <= max && nearFullGrade(bound + size, max, this.opts.nearFullPercent) === undefined) {
            return { borrowed: false, usedAfter: bound + size };
        }
        const total = this.sql(`SELECT COALESCE(SUM(LENGTH(json)), 0) AS n FROM addressable`)[0]?.n ?? 0;
        let used = total - replacedLen;
        const guarantee = this.opts.guaranteeBytes;
        const band = overflowBand(max, this.opts.overflowRatio);
        const sameAddress = (row) => Number(row.kind) === event.kind && row.pubkey === event.pubkey && row.d === d;
        let borrowedTotal;
        const borrowed = () => (borrowedTotal ??=
            (Number(this.sql(`SELECT COALESCE(SUM(LENGTH(json)), 0) AS n FROM addressable WHERE borrowed = 1`)[0]?.n ?? 0) || 0) -
                (replacedBorrowed ? replacedLen : 0));
        let plan = [];
        const decision = decideCapacity({
            max,
            used,
            need: size,
            evicts: this.opts.ceilingEvicts === true,
            guarantee,
            band,
            planeBorrows: this.opts.addressableBorrows !== false,
            borrowed,
            withinGuarantee: () => {
                const mine = this.sql(`SELECT COALESCE(SUM(LENGTH(json)), 0) AS n FROM addressable
           WHERE pubkey = ? AND borrowed = 0 AND NOT (kind = ? AND d = ?)`, event.pubkey, event.kind, d);
                return (Number(mine[0]?.n ?? 0) || 0) + size <= guarantee;
            },
            excessAvailable: () => {
                const over = this.sql(`SELECT pubkey, SUM(LENGTH(json)) AS n FROM addressable
           WHERE borrowed = 0 AND pubkey != ? GROUP BY pubkey HAVING SUM(LENGTH(json)) > ?`, event.pubkey, guarantee);
                if (over.length === 0)
                    return 0;
                const usage = new Map(over.map((row) => [String(row.pubkey), Number(row.n ?? 0)]));
                const candidates = this.sql(`SELECT kind, pubkey, d, LENGTH(json) AS len FROM addressable
           WHERE borrowed = 0 AND pubkey IN (SELECT value FROM json_each(?))
           ORDER BY expiration ASC, rowid ASC LIMIT ?`, JSON.stringify([...usage.keys()]), EXCESS_CANDIDATES).map((row) => ({
                    kind: Number(row.kind),
                    pubkey: String(row.pubkey),
                    d: String(row.d),
                    owner: String(row.pubkey),
                    bytes: Number(row.len ?? 0),
                }));
                const picked = pickExcess(candidates, usage, guarantee, used - borrowed() + size - max);
                plan = picked.rows;
                return picked.freed;
            },
            borrowFitsPerKey: () => {
                const mine = this.sql(`SELECT COALESCE(SUM(LENGTH(json)), 0) AS n FROM addressable
           WHERE borrowed = 1 AND pubkey = ? AND NOT (kind = ? AND d = ?)`, event.pubkey, event.kind, d);
                return (Number(mine[0]?.n ?? 0) || 0) + size <= borrowPerKey(band, this.opts.borrowPerKeyBytes);
            },
        });
        const drop = (kind, pubkey, dd) => {
            this.sql(`DELETE FROM addressable WHERE kind = ? AND pubkey = ? AND d = ?`, kind, pubkey, dd);
        };
        switch (decision.type) {
            case "fit":
                return { borrowed: false, usedAfter: used + size };
            case "borrow":
                return { borrowed: true, usedAfter: used + size };
            case "reject":
                return undefined;
            case "reclaim":
            case "excess": {
                const borrowedRows = this.sql(`SELECT kind, pubkey, d, LENGTH(json) AS len FROM addressable WHERE borrowed = 1 ORDER BY expiration ASC, rowid ASC`);
                for (const row of borrowedRows) {
                    if (sameAddress(row))
                        continue; // 即將被取代的那一列，已經不算在用量裡
                    if (decision.type === "reclaim" && used + size <= max)
                        break;
                    drop(Number(row.kind), String(row.pubkey), String(row.d));
                    used -= Number(row.len ?? 0);
                }
                if (decision.type === "excess") {
                    for (const row of plan) {
                        drop(row.kind, row.pubkey, row.d);
                        used -= row.bytes;
                    }
                }
                return { borrowed: false, usedAfter: used + size };
            }
            case "legacy": {
                // v0.33 原樣：依到期時間由近而遠淘汰。一次取一批（而非逐列查），避免極端情況下打上百次查詢。
                const victims = this.sql(`SELECT kind, pubkey, d, LENGTH(json) AS len FROM addressable ORDER BY expiration ASC LIMIT 256`);
                for (const row of victims) {
                    if (used + size <= max)
                        break;
                    drop(row.kind, row.pubkey, row.d);
                    used -= row.len ?? 0;
                }
                return used + size <= max ? { borrowed: false, usedAfter: used + size } : undefined;
            }
        }
    }
    /**
     * 被刪掉的離線列記進丟棄計數（SDK ADR 0042；ADR 0038 M8）。
     *
     * 不計：沒開 `countDrops`、沒有收件人的列、收件人正在線上收收件匣（即時收到了）、
     * rowid 不超過那位收件人上次讀收件匣時的水位線（那時就在庫裡，已經送到過）。
     */
    recordDrops(rows, nowSec) {
        if (this.opts.countDrops !== true || rows.length === 0)
            return;
        const byRecipient = new Map();
        for (const row of rows) {
            if (row.recipient === "")
                continue;
            const list = byRecipient.get(row.recipient);
            if (list)
                list.push(row);
            else
                byRecipient.set(row.recipient, [row]);
        }
        for (const [recipient, list] of byRecipient) {
            if (this.inboxProbe(recipient))
                continue;
            const prev = this.sql(`SELECT count, since, until, mark FROM inbox_drops WHERE recipient = ?`, recipient)[0];
            const mark = Number(prev?.mark ?? 0);
            const counted = list.filter((row) => row.r > mark);
            if (counted.length === 0)
                continue;
            const created = counted.map((row) => row.created);
            const merged = mergeDropped(prev && Number(prev.count) > 0
                ? { count: Number(prev.count), since: Number(prev.since), until: Number(prev.until) }
                : undefined, counted.length, Math.min(...created), Math.max(...created));
            this.sql(`INSERT OR REPLACE INTO inbox_drops (recipient, count, since, until, mark, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, recipient, merged.count, merged.since, merged.until, mark, nowSec);
            if (prev === undefined)
                this.noteNewDropRow();
        }
    }
    /** 丟棄計數表多了一列：超過上限就刪最久沒更新的（收件人可以亂編，表不能無限長）。 */
    noteNewDropRow() {
        // 呼叫時新的那一列已經寫進去了：第一次從表裡數（已含它），之後加一
        if (this.dropRows === undefined)
            this.dropRows = Number(this.sql(`SELECT COUNT(*) AS n FROM inbox_drops`)[0]?.n ?? 0);
        else
            this.dropRows += 1;
        if (this.dropRows > DROPPED_RECIPIENTS_MAX) {
            const extra = this.dropRows - DROPPED_RECIPIENTS_MAX;
            this.sql(`DELETE FROM inbox_drops WHERE recipient IN (SELECT recipient FROM inbox_drops ORDER BY updated_at ASC LIMIT ?)`, extra);
            this.dropRows = DROPPED_RECIPIENTS_MAX;
        }
    }
    /** 目前離線表的最大 rowid：丟棄計數的水位線（這之前存的都送到了）。 */
    deliveredMark() {
        return Number(this.sql(`SELECT COALESCE(MAX(rowid), 0) AS m FROM offline_msgs`)[0]?.m ?? 0);
    }
    takeDropped(recipient, nowSec) {
        if (this.opts.countDrops !== true)
            return undefined;
        const prev = this.sql(`SELECT count, since, until FROM inbox_drops WHERE recipient = ?`, recipient)[0];
        this.sql(`INSERT OR REPLACE INTO inbox_drops (recipient, count, since, until, mark, updated_at) VALUES (?, 0, NULL, NULL, ?, ?)`, recipient, this.deliveredMark(), nowSec);
        if (prev === undefined) {
            this.noteNewDropRow();
            return undefined;
        }
        const count = Number(prev.count ?? 0);
        return count > 0 ? { count, since: Number(prev.since), until: Number(prev.until) } : undefined;
    }
    markDelivered(recipient, nowSec) {
        if (this.opts.countDrops !== true)
            return;
        const prev = this.sql(`SELECT 1 AS x FROM inbox_drops WHERE recipient = ?`, recipient)[0];
        this.sql(`INSERT INTO inbox_drops (recipient, count, since, until, mark, updated_at) VALUES (?, 0, NULL, NULL, ?, ?)
       ON CONFLICT(recipient) DO UPDATE SET mark = excluded.mark, updated_at = excluded.updated_at`, recipient, this.deliveredMark(), nowSec);
        if (prev === undefined)
            this.noteNewDropRow();
    }
    /**
     * 查詢符合 filter 且未過期的留言。
     *
     * ## 為什麼過濾條件必須下推到 SQL（ADR-0235 C2）
     *
     * 修正前，沒有 `#p` 的 filter 會走
     * `SELECT json FROM offline_msgs WHERE expiration > ?`——**整張表**（所有使用者的離線留言）
     * 撈進記憶體、逐筆 `JSON.parse`，再於 JS 端 `matchFilter` 過濾。
     *
     * 而 `relay-core` 的 `scoped()` 明文允許「沒有 `#p`、但有 `authors`」的訂閱（ADR-0071 的
     * 快照查詢正是這個形狀），連 `authors: []` 都放行——它匹配不到任何事件，卻會完整跑一次
     * 全表掃描。也就是說 `{"authors":[]}` 是一個**零成本、零收穫、全代價**的 payload。
     * Durable Object 記憶體上限 128MB，而這是**單一全域房間**：重複送幾次就 OOM，全站掉線。
     *
     * 現在 `#p`／`authors`／`ids`／`kinds`／`since`／`until` 全部進 WHERE（有索引），並一律帶
     * `LIMIT`。`matchFilter` 仍是最終權威（`#e` 等標籤 filter 只能在 JS 判），但它現在跑在
     * **有界且已縮小**的候選集上。
     *
     * 「訂閱必須具名」則**不**在這一層——那是 `relay-core.scoped()` 的職責（ADR-0123）。
     * 儲存層若也擋，會讓「Ephemeral 不入庫」這類**否定斷言**變成恆真的空轉測試。
     * 這裡只負責一件事：**任何查詢的代價都有界**。
     */
    query(filter, nowSec, maxBytes) {
        const pValues = filter["#p"];
        const { authors, ids, kinds } = filter;
        // 空陣列＝匹配不到任何事件（`matchFilter` 語意）。提前回傳，連 DB 都不用打
        // ——`{"authors":[]}` 正是最便宜的消防水管 payload。
        if ((pValues && pValues.length === 0) || (authors && authors.length === 0) || (ids && ids.length === 0)) {
            return [];
        }
        // 標籤同理：`{"#t":[]}` 匹配不到任何東西（`matchFilter` 語意），連 DB 都不用打。
        if (tagFiltersOf(filter).some((t) => t.values.length === 0))
            return [];
        const where = [];
        const bind = [];
        const push = (clause, values) => {
            where.push(clause);
            bind.push(...values);
        };
        // 綁定參數總數與 filter 陣列的長度無關（Cinderous ADR-0372）：這裡最多 9 個，加上每個標籤鍵 2 個。
        if (pValues && pValues.length > 0)
            pushIn(where, bind, "recipient", pValues);
        if (authors && authors.length > 0)
            pushIn(where, bind, "pubkey", authors);
        if (ids && ids.length > 0)
            pushIn(where, bind, "id", ids);
        if (kinds && kinds.length > 0)
            pushIn(where, bind, "kind", kinds);
        if (filter.since !== undefined)
            push(`created_at >= ?`, [filter.since]);
        if (filter.until !== undefined)
            push(`created_at <= ?`, [filter.until]);
        pushTagClauses("offline_msgs", filter, where, bind);
        where.push(`(expiration IS NULL OR expiration > ?)`);
        bind.push(nowSec);
        const limit = queryLimit(filter.limit);
        const offline = this.boundedSelect("offline_msgs", where.join(" AND "), bind, limit, "COALESCE(bytes, LENGTH(json))", maxBytes);
        let rows = offline.rows;
        // 快照（可尋址）走 authors+kinds 查詢、不帶 `#p`——它是獨立的表，同樣把條件下推＋LIMIT。
        if (!(pValues && pValues.length > 0)) {
            const aWhere = [`expiration > ?`];
            const aBind = [nowSec];
            if (authors && authors.length > 0)
                pushIn(aWhere, aBind, "pubkey", authors);
            if (ids && ids.length > 0)
                pushIn(aWhere, aBind, "id", ids);
            if (kinds && kinds.length > 0)
                pushIn(aWhere, aBind, "kind", kinds);
            pushTagClauses("addressable", filter, aWhere, aBind);
            const remaining = maxBytes === undefined ? undefined : maxBytes - offline.spent;
            rows = rows.concat(this.boundedSelect("addressable", aWhere.join(" AND "), aBind, limit, "LENGTH(json)", remaining).rows);
        }
        const events = dedupById(rows.map((r) => JSON.parse(r.json)));
        return events.filter((e) => matchFilter(filter, e)).slice(0, limit);
    }
    /**
     * 取出最新的列，但**累計大小不超過 `budget`**（Cinderous ADR-0371 §決策 6）。沒給預算＝與過去相同。
     *
     * 🔴 為什麼要分兩步：`toArray()` 一次把結果全部搬進記憶體，而 DO 的記憶體上限是 128MB。
     * 一位收件人名下的檔案塊可能有上千顆、每顆約 131KB——一次 REQ 就是上百 MB，DO 當場重置。
     * 先只讀大小（分桶索引上就有）算出放得下幾列，再取那幾列的 json。
     * 排序要是**全序**（同一秒的列也排得出先後），兩步才保證挑中的是同一批列。
     *
     * 🔴 全序要照索引的順序排（SDK ADR 0126）：離線留言用 `created_at, expiration, bytes, rowid`，
     * 正好是分桶索引 `(recipient, kind, created_at, expiration, bytes)` 加上隱含的 rowid——`#p`＋單一 kind 的查詢
     * 順著索引倒著讀，讀滿 LIMIT 就停。原本的 `created_at, rowid` 跳過了中間兩欄，SQLite 只好把整個桶讀出來排序：
     * 補拉收件匣每一頁都讀全桶、兩步各一次（miniflare 實測 LIMIT 1024 讀 2049 列×2）。
     */
    boundedSelect(table, where, bind, limit, sizeExpr, budget) {
        const order = table === "offline_msgs"
            ? "ORDER BY created_at DESC, expiration DESC, bytes DESC, rowid DESC"
            : "ORDER BY created_at DESC, rowid DESC";
        if (budget === undefined) {
            return { rows: this.sql(`SELECT json FROM ${table} WHERE ${where} ${order} LIMIT ?`, ...bind, limit), spent: 0 };
        }
        const sizes = this.sql(`SELECT ${sizeExpr} AS n FROM ${table} WHERE ${where} ${order} LIMIT ?`, ...bind, limit);
        let take = 0;
        let spent = 0;
        for (const row of sizes) {
            const n = Number(row.n ?? 0);
            if (spent + n > budget)
                break;
            spent += n;
            take += 1;
        }
        if (take === 0)
            return { rows: [], spent: 0 };
        return { rows: this.sql(`SELECT json FROM ${table} WHERE ${where} ${order} LIMIT ?`, ...bind, take), spent };
    }
    prune(nowSec) {
        this.invalidateUsage();
        // 借用列到期（2 小時）：同一批正常存放的也一起刪（SDK ADR 0085）。先查它們的批次，刪完再刪同批。
        // 🔴 從借用列的部分索引找出到期的那幾列、再以 rowid 查批次（SDK ADR 0102）：原本指定 idx_offline_batch，
        // 規劃器只能把整個批次索引掃一遍（每顆檔案塊都在裡面），每小時約 4,200 列。
        const borrowedBatches = this.sql(`SELECT recipient, batch FROM offline_msgs
       WHERE rowid IN (SELECT rowid FROM offline_msgs INDEXED BY idx_offline_borrowed
                       WHERE borrowed = 1 AND expiration IS NOT NULL AND expiration <= ?)
         AND batch IS NOT NULL`, nowSec).map((row) => ({ recipient: String(row.recipient), batch: Number(row.batch) }));
        // 借用列到期算丟棄（SDK ADR 0042）；一般的保存期到期不算——那是宣告過的契約。只讀部分索引。
        if (this.opts.countDrops === true) {
            const expired = this.sql(`SELECT rowid AS r, recipient, created_at FROM offline_msgs
         WHERE borrowed = 1 AND recipient != '' AND expiration IS NOT NULL AND expiration <= ?`, nowSec);
            this.recordDrops(expired.map((row) => ({ r: Number(row.r), recipient: String(row.recipient), created: Number(row.created_at) })), nowSec);
        }
        this.sql(`DELETE FROM offline_msgs WHERE expiration IS NOT NULL AND expiration <= ?`, nowSec);
        this.dropBatchMates(borrowedBatches, nowSec);
        this.sql(`DELETE FROM addressable WHERE expiration <= ?`, nowSec);
        // 丟棄計數只留一個保存期：更久沒動的收件人，那些留言本來也會到期
        this.sql(`DELETE FROM inbox_drops WHERE updated_at <= ?`, nowSec - (this.opts.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS));
        this.dropRows = undefined;
    }
    /**
     * 收件確認（SDK ADR 0067）：同 {@link OfflineStore.ackInbox}。走主鍵 `(id, recipient)`，不讀 json。
     * 「只寄給一人」以**庫裡還有沒有同 id、別的收件人的列**判斷（讀 json 的標籤要走溢位頁，檔案塊一顆約 131KB）。
     */
    ackInbox(recipient, ids, expiresAt, nowSec) {
        if (ids.length === 0)
            return 0;
        const set = inJson("id", ids);
        const where = `recipient = ? AND ${set.clause}
       AND (expiration IS NULL OR expiration > ?) AND (expiration IS NULL OR expiration > ?)
       AND NOT EXISTS (SELECT 1 FROM offline_msgs o2 WHERE o2.id = offline_msgs.id AND o2.recipient != ?)`;
        const binds = [recipient, set.binding, expiresAt, nowSec, recipient];
        const n = Number(this.sql(`SELECT COUNT(*) AS n FROM offline_msgs WHERE ${where}`, ...binds)[0]?.n ?? 0);
        if (n > 0)
            this.sql(`UPDATE offline_msgs SET expiration = ? WHERE ${where}`, expiresAt, ...binds);
        return n;
    }
    /**
     * NIP-62 清除（ADR-0260）：`pubkey = ?`（他發的）**或** `recipient = ?`（寄給他的
     * ——Gift Wrap 外層是一次性金鑰，`p` 是唯一能定位收件匣的鍵），外加他的可尋址事件。
     *
     * 兩欄都有索引（`idx_offline_pubkey`／`idx_offline_bucket` 的 recipient 前綴），故不是全表掃描。
     */
    vanish(pubkey, _nowSec) {
        const rows = this.sql(`SELECT COUNT(DISTINCT id) AS n FROM offline_msgs WHERE pubkey = ? OR recipient = ?`, pubkey, pubkey);
        const msgs = Number(rows[0]?.n ?? 0);
        const addr = Number(this.sql(`SELECT COUNT(*) AS n FROM addressable WHERE pubkey = ?`, pubkey)[0]?.n ?? 0);
        this.invalidateUsage();
        this.sql(`DELETE FROM offline_msgs WHERE pubkey = ? OR recipient = ?`, pubkey, pubkey);
        this.sql(`DELETE FROM addressable WHERE pubkey = ?`, pubkey);
        // 他的丟棄計數（SDK ADR 0042）：清除就是一切
        this.sql(`DELETE FROM inbox_drops WHERE recipient = ?`, pubkey);
        this.dropRows = undefined;
        return msgs + addr;
    }
    /**
     * 這幾列的收件人、批次（SDK ADR 0085）與桶別：**以 rowid 逐列查**，只讀要刪的那幾列（SDK ADR 0102）。
     *
     * 🔴 原本寫成 `INDEXED BY idx_offline_batch ... rowid IN (...)`，想「只讀索引、不碰 json 溢位頁」，
     * 但部分索引不是以 rowid 排序——SQLite 只能把整個索引掃一遍（每顆檔案塊都在裡面），
     * 塞滿的檔案車道每次淘汰讀約 4,400 列，2026-10-19 一小時把錨點 1 的讀取額度用完。
     * 改成 rowid 查詢：要讀這幾列在大表上的欄位（`batch`／`kind` 在 json 後面，要走溢位頁），但只有這幾列。
     */
    describeRows(rowids) {
        const out = new Map();
        if (rowids.length === 0)
            return out;
        for (const row of this.sql(`SELECT rowid AS r, recipient, pubkey, bytes, borrowed, batch, kind FROM offline_msgs WHERE rowid IN (SELECT value FROM json_each(?))`, JSON.stringify(rowids))) {
            out.set(Number(row.r), {
                recipient: String(row.recipient),
                owner: String(row.recipient) !== "" ? String(row.recipient) : String(row.pubkey ?? ""),
                bytes: Number(row.bytes ?? 0),
                borrowed: Number(row.borrowed) === 1,
                file: Number(row.kind) === FILE_WRAP_KIND,
                ...(row.batch === null || row.batch === undefined ? {} : { batch: Number(row.batch) }),
            });
        }
        return out;
    }
    /**
     * 這幾列被刪掉了：借用量與每個人的正常列用量照實扣掉（SDK ADR 0103）。原本整個作廢，
     * 下一次要判斷保底時以 `GROUP BY` 掃過整個分桶索引重建（塞滿的檔案車道每次約 4,200 列）。
     */
    forgetUsage(rows) {
        for (const row of rows) {
            if (row === undefined)
                continue;
            if (row.borrowed) {
                if (this.offlineBorrowed !== undefined)
                    this.offlineBorrowed -= row.bytes;
            }
            else if (this.ownerNormal !== undefined) {
                this.ownerNormal.set(row.owner, (this.ownerNormal.get(row.owner) ?? 0) - row.bytes);
            }
        }
    }
    /** 這幾列被刪掉了：從各自那一桶的列數快取扣掉（沒快取的桶下次照舊重數）。SDK ADR 0102 */
    forgetRows(rows) {
        for (const row of rows) {
            if (row === undefined)
                continue;
            const key = bucketKey(row.recipient, row.file);
            const count = this.bucketCounts.get(key);
            if (count !== undefined)
                this.bucketCounts.set(key, Math.max(0, count - 1));
        }
    }
    /**
     * 整批淘汰（SDK ADR 0085）：被刪掉的檔案塊所屬的那一批（同收件人、同 `batch`）其餘的列一起刪，回傳釋放的位元組；記進丟棄計數。
     * 只刪一部分會切出永遠收不齊的孤兒。行為與記憶體版逐字對齊。
     */
    dropBatchMates(keys, nowSec) {
        const unique = new Map();
        for (const k of keys)
            if (k && k.recipient !== "")
                unique.set(`${k.recipient}\n${k.batch}`, k);
        if (unique.size === 0)
            return 0;
        let freed = 0;
        const dropped = [];
        for (const { recipient, batch } of unique.values()) {
            // borrowed／pubkey 不在批次索引上，要讀大表的這幾列（SDK ADR 0103：換來不必整個重建保底用量）
            const mates = this.sql(`SELECT rowid AS r, bytes, created_at, borrowed, pubkey FROM offline_msgs INDEXED BY idx_offline_batch WHERE recipient = ? AND batch = ?`, recipient, batch);
            if (mates.length === 0)
                continue;
            this.sql(`DELETE FROM offline_msgs WHERE recipient = ? AND batch = ?`, recipient, batch);
            // 有批次的列一定是這位收件人的檔案塊（SDK ADR 0102：照實扣掉，不清整個快取）
            const key = bucketKey(recipient, true);
            const count = this.bucketCounts.get(key);
            if (count !== undefined)
                this.bucketCounts.set(key, Math.max(0, count - mates.length));
            for (const m of mates) {
                freed += Number(m.bytes ?? 0);
                dropped.push({ r: Number(m.r), recipient, created: Number(m.created_at) });
            }
            this.forgetUsage(mates.map((m) => ({
                recipient,
                owner: recipient,
                bytes: Number(m.bytes ?? 0),
                borrowed: Number(m.borrowed) === 1,
                file: true,
            })));
        }
        if (freed > 0 && this.offlineUsed !== undefined)
            this.offlineUsed -= freed;
        this.recordDrops(dropped, nowSec);
        return freed;
    }
    /**
     * 分桶修剪（ADR-0162：檔案塊與聊天留言各自計數、各自由舊到新丟棄）。
     *
     * 只修剪**這次寫入落到的那一桶**：另一桶的列數沒變，不需要看（修正前兩桶每次都掃）。
     * 列數走快取，只有超量時才讀出要刪的那幾列——而且只讀 `idx_offline_bucket` 的索引項。
     */
    enforceCap(recipients, file, nowSec) {
        const limit = file
            ? (this.opts.filePerRecipient ?? DEFAULT_FILE_PER_RECIPIENT)
            : this.opts.maxPerRecipient;
        if (limit === undefined)
            return;
        const bucket = file ? `kind = ${FILE_WRAP_KIND}` : `kind != ${FILE_WRAP_KIND}`;
        for (const recipient of recipients) {
            if (recipient === "")
                continue; // 無收件人的桶不做 FIFO（由天花板與 TTL 管）
            const key = bucketKey(recipient, file);
            let count = this.bucketCounts.get(key);
            if (count === undefined) {
                count = Number(this.sql(`SELECT COUNT(*) AS n FROM offline_msgs WHERE recipient = ? AND ${bucket}`, recipient)[0]?.n ?? 0);
            }
            if (count > limit) {
                const rows = this.sql(`SELECT rowid AS r, bytes, created_at FROM offline_msgs WHERE recipient = ? AND ${bucket}
           ORDER BY created_at ASC LIMIT ?`, recipient, count - limit);
                const info = this.describeRows(rows.map((row) => Number(row.r)));
                const batches = file ? batchKeysOf(info) : new Map();
                for (const row of rows) {
                    this.sql(`DELETE FROM offline_msgs WHERE rowid = ?`, row.r);
                    if (this.offlineUsed !== undefined)
                        this.offlineUsed -= Number(row.bytes ?? 0);
                }
                count -= rows.length;
                // 刪掉的可能有借用列（分桶索引上看不出來）：借用量作廢、這位收件人的保底用量重算（SDK ADR 0042）
                if (rows.length > 0) {
                    // 借用量與這位收件人的保底用量照實扣掉（SDK ADR 0103：原本逐人重算，每次約 1,400 列）
                    this.forgetUsage(rows.map((row) => info.get(Number(row.r))));
                    this.recordDrops(rows.map((row) => ({ r: Number(row.r), recipient, created: Number(row.created_at) })), nowSec);
                    // 整批淘汰（SDK ADR 0085）：刪到某一批的一部分，那批其餘的一起刪；dropBatchMates 會從快取扣掉（SDK ADR 0102，不再重數）
                    this.bucketCounts.set(key, count);
                    this.dropBatchMates(rows.map((row) => batches.get(Number(row.r))), nowSec);
                    count = this.bucketCounts.get(key) ?? count;
                }
            }
            this.bucketCounts.set(key, count);
        }
    }
}
/** 分桶快取的鍵：收件人 ＋ 桶別（檔案塊／其他）。 */
function bucketKey(recipient, file) {
    return `${file ? "f" : "c"}:${recipient}`;
}
/** 保底份額淘汰一次最多看幾列候選（每列只讀索引欄位）。 */
const EXCESS_CANDIDATES = 1024;
/** `describeRows` 的結果裡有批次的那些列 → 批次鍵（SDK ADR 0085）。 */
function batchKeysOf(info) {
    const out = new Map();
    for (const [r, row] of info)
        if (row.batch !== undefined)
            out.set(r, { recipient: row.recipient, batch: row.batch });
    return out;
}
//# sourceMappingURL=sql-message-store.js.map