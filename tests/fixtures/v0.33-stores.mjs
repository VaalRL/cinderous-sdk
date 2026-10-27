// 由 tests/fixtures/gen-v0.33-stores.mjs 從 v0.33.0 產生（SDK ADR 0042），不要手改。
// @ts-nocheck
// ../../../AppData/Local/Temp/sdk-v033-YYi2NS/src/relay/filters.ts
function matchFilter(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== void 0 && event.created_at < filter.since) return false;
  if (filter.until !== void 0 && event.created_at > filter.until) return false;
  for (const key in filter) {
    if (key.charCodeAt(0) !== 35) continue;
    const wanted = filter[key];
    if (!wanted) continue;
    const tagName = key.slice(1);
    const hit = event.tags.some(
      (t) => t[0] === tagName && t[1] !== void 0 && wanted.includes(t[1])
    );
    if (!hit) return false;
  }
  return true;
}

// ../../../AppData/Local/Temp/sdk-v033-YYi2NS/src/relay/message-store.ts
function getExpiration(event) {
  const tag = event.tags.find((t) => t[0] === "expiration");
  if (!tag || tag[1] === void 0) return void 0;
  const seconds = Number(tag[1]);
  return Number.isFinite(seconds) ? seconds : void 0;
}
var DEFAULT_MAX_TTL_SECONDS = 7 * 86400;
var MAX_QUERY_ROWS = 1024;
var MAX_QUERY_BYTES = 16 * 1024 * 1024;
function queryLimit(requested) {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return MAX_QUERY_ROWS;
  return Math.min(Math.floor(requested), MAX_QUERY_ROWS);
}
var FILE_WRAP_KIND = 1060;
var DEFAULT_FILE_PER_RECIPIENT = 4e3;
function effectiveExpiration(event, nowSec, maxTtlSeconds = DEFAULT_MAX_TTL_SECONDS) {
  const cap = nowSec + maxTtlSeconds;
  const tagged = getExpiration(event);
  return tagged === void 0 ? cap : Math.min(tagged, cap);
}
function dTagOf(event) {
  return event.tags.find((t) => t[0] === "d")?.[1] ?? "";
}
function shouldReplace(existing, incoming) {
  if (incoming.created_at !== existing.created_at) return incoming.created_at > existing.created_at;
  return incoming.id < existing.id;
}
var ADDRESSABLE_MAX_BYTES = 262144;
var ADDRESSABLE_MAX_PER_AUTHOR = 5;
var ADDRESSABLE_TTL_SECONDS = 30 * 86400;
var ADDRESSABLE_PUT_OK = { ok: true };
function addressableRejected(reason) {
  return { ok: false, reason };
}
function recipientsOf(event) {
  const out = [];
  for (const tag of event.tags) {
    if (tag[0] === "p" && tag[1] !== void 0) out.push(tag[1]);
  }
  return out;
}
function dedupById(events) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out;
}
var MessageStore = class {
  constructor(opts = {}) {
    this.opts = opts;
  }
  opts;
  /** 收件人 pubkey → 該收件人的留言。 */
  byRecipient = /* @__PURE__ */ new Map();
  /** 無 `p` 標籤的事件。 */
  noRecipient = [];
  /** event id → 有效到期時間（ADR-0065：每列壽命必有界）。 */
  effExp = /* @__PURE__ */ new Map();
  /** 可尋址事件（ADR-0071）：`kind\0pubkey\0d` → 最新一顆。 */
  addressable = /* @__PURE__ */ new Map();
  /** 寫入可取代／可尋址事件（取代語意＋配額；ADR-0035／0071）。可取代事件無 `d` → 每 (kind,pubkey) 一顆。 */
  putAddressable(event, nowSec) {
    return this.putAddressableResult(event, nowSec).ok;
  }
  /** 同 {@link putAddressable}，被拒時帶原因（SDK ADR 0038 P0-R2）。 */
  putAddressableResult(event, nowSec) {
    const prefix = `${event.kind}\0${event.pubkey}\0`;
    const key = prefix + dTagOf(event);
    const existing = this.addressable.get(key);
    if (existing && !shouldReplace(existing, event)) return addressableRejected("stale");
    if (event.content === "") {
      if (existing) {
        this.addressable.delete(key);
        this.effExp.delete(existing.id);
      }
      return ADDRESSABLE_PUT_OK;
    }
    const size = JSON.stringify(event).length;
    if (size > (this.opts.addressableMaxBytes ?? ADDRESSABLE_MAX_BYTES)) return addressableRejected("too-large");
    if (!existing) {
      let count = 0;
      for (const k of this.addressable.keys()) if (k.startsWith(prefix)) count++;
      if (count >= (this.opts.addressablePerAuthor ?? ADDRESSABLE_MAX_PER_AUTHOR)) return addressableRejected("address-quota");
    }
    const budget = this.opts.addressableBytesPerAuthor;
    if (budget !== void 0) {
      let used = 0;
      for (const [k, e] of this.addressable) {
        if (e.pubkey !== event.pubkey || k === key) continue;
        used += JSON.stringify(e).length;
      }
      if (used + size > budget) return addressableRejected("byte-quota");
    }
    const eff = effectiveExpiration(event, nowSec, this.opts.addressableTtlSeconds ?? ADDRESSABLE_TTL_SECONDS);
    if (eff <= nowSec) return addressableRejected("expired");
    if (!this.fitsAddressableCeiling(key, size)) return addressableRejected("ceiling");
    if (existing) this.effExp.delete(existing.id);
    this.addressable.set(key, event);
    this.effExp.set(event.id, eff);
    return ADDRESSABLE_PUT_OK;
  }
  /** 目前離線留言佔用的位元組（每位收件人各算一份，與 SQL 版的「一列」對齊）。 */
  offlineBytes() {
    let used = 0;
    for (const e of this.noRecipient) used += JSON.stringify(e).length;
    for (const bucket of this.byRecipient.values()) {
      for (const e of bucket) used += JSON.stringify(e).length;
    }
    return used;
  }
  /**
   * 這顆 DO 還放得下這筆離線留言嗎（ADR-0367 §決策 2）。
   * 放不下時：車道淘汰**最快到期**者；嚴格平面直接拒收。
   */
  fitsOfflineCeiling(size) {
    const max = this.opts.offlineMaxTotalBytes;
    if (max === void 0) return true;
    if (size > max) return false;
    let used = this.offlineBytes();
    if (used + size <= max) return true;
    if (this.opts.ceilingEvicts !== true) return false;
    const victims = [...this.effExp.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    for (const id of victims) {
      if (used + size <= max) break;
      used -= this.dropOffline(id);
    }
    return used + size <= max;
  }
  /** 從所有桶移除某個 id，回傳釋放的位元組。 */
  dropOffline(id) {
    let freed = 0;
    const keep = (e) => {
      if (e.id !== id) return true;
      freed += JSON.stringify(e).length;
      return false;
    };
    this.noRecipient = this.noRecipient.filter(keep);
    for (const [recipient, bucket] of this.byRecipient) {
      const next = bucket.filter(keep);
      if (next.length === 0) this.byRecipient.delete(recipient);
      else this.byRecipient.set(recipient, next);
    }
    if (freed > 0) this.effExp.delete(id);
    return freed;
  }
  /**
   * 這顆 DO 還放得下這筆可尋址事件嗎（ADR-0367 §決策 2）。
   * 放不下時：車道淘汰**最快到期**者直到騰出空間；嚴格平面直接回 false（拒收）。
   */
  fitsAddressableCeiling(key, size) {
    const max = this.opts.addressableMaxTotalBytes;
    if (max === void 0) return true;
    if (size > max) return false;
    let used = 0;
    for (const [k, e] of this.addressable) {
      if (k === key) continue;
      used += JSON.stringify(e).length;
    }
    if (used + size <= max) return true;
    if (this.opts.ceilingEvicts !== true) return false;
    const byExpiry = [...this.addressable.entries()].filter(([k]) => k !== key).sort((a, b) => (this.effExp.get(a[1].id) ?? 0) - (this.effExp.get(b[1].id) ?? 0));
    for (const [k, e] of byExpiry) {
      if (used + size <= max) break;
      used -= JSON.stringify(e).length;
      this.addressable.delete(k);
      this.effExp.delete(e.id);
    }
    return used + size <= max;
  }
  /** 寫入一筆留言；若已過期則拒絕並回 false。 */
  put(event, nowSec) {
    if (this.isExpired(event, nowSec)) return false;
    const recipients = recipientsOf(event);
    const copies = Math.max(1, recipients.length);
    if (!this.fitsOfflineCeiling(JSON.stringify(event).length * copies)) return false;
    this.effExp.set(event.id, effectiveExpiration(event, nowSec, this.opts.maxTtlSeconds));
    if (recipients.length === 0) {
      this.noRecipient.push(event);
      return true;
    }
    for (const recipient of recipients) {
      const bucket = this.byRecipient.get(recipient) ?? [];
      bucket.push(event);
      this.byRecipient.set(recipient, bucket);
    }
    this.enforceCap(recipients);
    return true;
  }
  /**
   * 查詢符合 filter 且未過期的留言。
   *
   * 回傳筆數與 SQL 版一樣有界（ADR-0235 C2）——兩個實作共用同一份 `OfflineStore` 契約，
   * 行為分歧會讓「用記憶體版寫的測試」保證不了產線的 SQL 版。
   */
  query(filter, nowSec, maxBytes) {
    const candidates = this.candidatesFor(filter);
    const hit = candidates.filter((e) => !this.isExpired(e, nowSec) && matchFilter(filter, e));
    const limit = queryLimit(filter.limit);
    if (hit.length <= limit && maxBytes === void 0) return hit;
    const newest = [...hit].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
    if (maxBytes === void 0) return newest;
    const out = [];
    let spent = 0;
    for (const e of newest) {
      const n = JSON.stringify(e).length;
      if (spent + n > maxBytes) break;
      spent += n;
      out.push(e);
    }
    return out;
  }
  /** 清除所有已過期留言。 */
  prune(nowSec) {
    const survivors = /* @__PURE__ */ new Set();
    for (const [recipient, bucket] of this.byRecipient) {
      const kept = bucket.filter((e) => !this.isExpired(e, nowSec));
      if (kept.length > 0) this.byRecipient.set(recipient, kept);
      else this.byRecipient.delete(recipient);
      for (const e of kept) survivors.add(e.id);
    }
    this.noRecipient = this.noRecipient.filter((e) => !this.isExpired(e, nowSec));
    for (const e of this.noRecipient) survivors.add(e.id);
    for (const [key, e] of this.addressable) {
      if (this.isExpired(e, nowSec)) this.addressable.delete(key);
      else survivors.add(e.id);
    }
    for (const id of this.effExp.keys()) {
      if (!survivors.has(id)) this.effExp.delete(id);
    }
  }
  /** NIP-62 清除（ADR-0260）：刪掉此人發的、寄給他的、以及他的可尋址事件。 */
  vanish(pubkey, _nowSec) {
    const removed = /* @__PURE__ */ new Set();
    for (const e of this.byRecipient.get(pubkey) ?? []) removed.add(e.id);
    this.byRecipient.delete(pubkey);
    for (const [recipient, bucket] of this.byRecipient) {
      const kept = bucket.filter((e) => {
        if (e.pubkey !== pubkey) return true;
        removed.add(e.id);
        return false;
      });
      if (kept.length > 0) this.byRecipient.set(recipient, kept);
      else this.byRecipient.delete(recipient);
    }
    this.noRecipient = this.noRecipient.filter((e) => {
      if (e.pubkey !== pubkey) return true;
      removed.add(e.id);
      return false;
    });
    for (const [key, e] of this.addressable) {
      if (e.pubkey !== pubkey) continue;
      removed.add(e.id);
      this.addressable.delete(key);
    }
    const survivors = /* @__PURE__ */ new Set();
    for (const bucket of this.byRecipient.values()) for (const e of bucket) survivors.add(e.id);
    for (const e of this.noRecipient) survivors.add(e.id);
    for (const e of this.addressable.values()) survivors.add(e.id);
    for (const id of removed) if (!survivors.has(id)) this.effExp.delete(id);
    return removed.size;
  }
  /** 依 filter 縮小候選集合：帶 `#p` 時僅取相關收件人桶，否則全掃。 */
  candidatesFor(filter) {
    const pValues = filter["#p"];
    if (pValues && pValues.length > 0) {
      return dedupById(pValues.flatMap((r) => this.byRecipient.get(r) ?? []));
    }
    return this.allEvents();
  }
  allEvents() {
    const all = [];
    for (const bucket of this.byRecipient.values()) all.push(...bucket);
    all.push(...this.noRecipient);
    all.push(...this.addressable.values());
    return dedupById(all);
  }
  isExpired(event, nowSec) {
    const exp = this.effExp.get(event.id) ?? getExpiration(event);
    return exp !== void 0 && exp <= nowSec;
  }
  enforceCap(recipients) {
    const cap = this.opts.maxPerRecipient;
    const fileCap = this.opts.filePerRecipient ?? DEFAULT_FILE_PER_RECIPIENT;
    for (const recipient of recipients) {
      const bucket = this.byRecipient.get(recipient);
      if (!bucket) continue;
      const sorted = [...bucket].sort((a, b) => a.created_at - b.created_at);
      const keptReversed = [];
      let chat = 0;
      let file = 0;
      for (let i = sorted.length - 1; i >= 0; i--) {
        const e = sorted[i];
        if (e.kind === FILE_WRAP_KIND) {
          if (file >= fileCap) continue;
          file++;
        } else if (cap !== void 0) {
          if (chat >= cap) continue;
          chat++;
        }
        keptReversed.push(e);
      }
      this.byRecipient.set(recipient, keptReversed.reverse());
    }
  }
};

// ../../../AppData/Local/Temp/sdk-v033-YYi2NS/src/relay/sql-message-store.ts
function inJson(column, values) {
  if (!Array.isArray(values)) throw new TypeError("filter 值必須是陣列");
  return { clause: `${column} IN (SELECT value FROM json_each(?))`, binding: JSON.stringify(values) };
}
function tagFiltersOf(filter) {
  const out = [];
  for (const key in filter) {
    if (key.charCodeAt(0) !== 35 || key === "#p") continue;
    const values = filter[key];
    if (values) out.push({ name: key.slice(1), values });
  }
  return out;
}
function pushTagClauses(table, filter, where, bind) {
  for (const { name, values } of tagFiltersOf(filter)) {
    const vals = inJson("json_extract(tg.value, '$[1]')", values);
    where.push(
      `EXISTS (SELECT 1 FROM json_each(${table}.json, '$.tags') AS tg
               WHERE json_extract(tg.value, '$[0]') = ?
                 AND ${vals.clause})`
    );
    bind.push(name, vals.binding);
  }
}
var pushIn = (where, bind, column, values) => {
  const { clause, binding } = inJson(column, values);
  where.push(clause);
  bind.push(binding);
};
var SqlMessageStore = class {
  constructor(sql, opts = {}) {
    this.sql = sql;
    this.opts = opts;
    this.sql(
      `CREATE TABLE IF NOT EXISTS offline_msgs (
        id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        expiration INTEGER,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (id, recipient)
      )`
    );
    this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_expiration ON offline_msgs(expiration)`);
    this.sql(
      `CREATE TABLE IF NOT EXISTS addressable (
        kind INTEGER NOT NULL,
        pubkey TEXT NOT NULL,
        d TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expiration INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (kind, pubkey, d)
      )`
    );
    this.sql(`CREATE INDEX IF NOT EXISTS idx_addressable_expiration ON addressable(expiration)`);
    this.sql(`CREATE INDEX IF NOT EXISTS idx_addressable_pubkey ON addressable(pubkey)`);
    this.sql(
      `UPDATE offline_msgs SET expiration = created_at + ? WHERE expiration IS NULL`,
      opts.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS
    );
    for (const ddl of [
      `ALTER TABLE offline_msgs ADD COLUMN pubkey TEXT`,
      `ALTER TABLE offline_msgs ADD COLUMN kind INTEGER`,
      // Cinderous ADR-0371 §決策 5：每列的位元組數。總量與天花板改讀這一欄（有索引），
      // 不再 `SUM(LENGTH(json))`——後者要把每一列的 json 從溢位頁讀出來（實測 260MB 約 1.4 秒）。
      `ALTER TABLE offline_msgs ADD COLUMN bytes INTEGER`
    ]) {
      try {
        this.sql(ddl);
      } catch {
      }
    }
    this.sql(
      `UPDATE offline_msgs SET pubkey = json_extract(json, '$.pubkey'), kind = json_extract(json, '$.kind')
       WHERE pubkey IS NULL OR kind IS NULL`
    );
    this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_pubkey ON offline_msgs(pubkey)`);
    this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_kind ON offline_msgs(kind)`);
    this.sql(
      `CREATE INDEX IF NOT EXISTS idx_offline_bucket ON offline_msgs(recipient, kind, created_at, expiration, bytes)`
    );
    this.sql(`DROP INDEX IF EXISTS idx_offline_recipient`);
    this.sql(`CREATE INDEX IF NOT EXISTS idx_offline_bytes_missing ON offline_msgs(id) WHERE bytes IS NULL`);
    this.sql(`UPDATE offline_msgs SET bytes = LENGTH(json) WHERE bytes IS NULL`);
  }
  sql;
  opts;
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
  bucketCounts = /* @__PURE__ */ new Map();
  /** 作廢所有快取（下次用到時從索引重算）。 */
  invalidateUsage() {
    this.offlineUsed = void 0;
    this.bucketCounts.clear();
  }
  usedOfflineBytes() {
    if (this.offlineUsed === void 0) {
      this.offlineUsed = Number(this.sql(`SELECT COALESCE(SUM(bytes), 0) AS n FROM offline_msgs`)[0]?.n ?? 0) || 0;
    }
    return this.offlineUsed;
  }
  put(event, nowSec) {
    const exp = getExpiration(event);
    if (exp !== void 0 && exp <= nowSec) return false;
    const effExp = effectiveExpiration(event, nowSec, this.opts.maxTtlSeconds);
    const recipients = recipientsOf(event);
    const targets = [...new Set(recipients.length > 0 ? recipients : [""])];
    const json = JSON.stringify(event);
    const size = json.length;
    const present = new Set(
      this.sql(`SELECT recipient FROM offline_msgs WHERE id = ?`, event.id).map((r) => r.recipient)
    );
    const fresh = targets.filter((r) => !present.has(r));
    if (fresh.length === 0) return true;
    if (!this.fitsOfflineCeiling(size * fresh.length)) return false;
    for (const recipient of fresh) {
      this.sql(
        `INSERT OR IGNORE INTO offline_msgs (id, recipient, expiration, created_at, json, pubkey, kind, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        recipient,
        effExp,
        event.created_at,
        json,
        event.pubkey,
        event.kind,
        size
      );
    }
    if (this.offlineUsed !== void 0) this.offlineUsed += size * fresh.length;
    const file = event.kind === FILE_WRAP_KIND;
    for (const recipient of fresh) {
      const key = bucketKey(recipient, file);
      const count = this.bucketCounts.get(key);
      if (count !== void 0) this.bucketCounts.set(key, count + 1);
    }
    this.enforceCap(fresh, file);
    return true;
  }
  /** 寫入可取代／可尋址事件（取代語意＋配額；ADR-0035／0071）。行為對齊記憶體版。 */
  putAddressable(event, nowSec) {
    return this.putAddressableResult(event, nowSec).ok;
  }
  /** 同 {@link putAddressable}，被拒時帶原因（SDK ADR 0038 P0-R2）。原因與記憶體版逐字對齊。 */
  putAddressableResult(event, nowSec) {
    const d = dTagOf(event);
    const existing = this.sql(
      `SELECT id, created_at, LENGTH(json) AS len FROM addressable WHERE kind = ? AND pubkey = ? AND d = ?`,
      event.kind,
      event.pubkey,
      d
    );
    const prev = existing[0];
    if (prev) {
      const prevEvent = { id: prev.id, created_at: prev.created_at };
      if (!shouldReplace(prevEvent, event)) return addressableRejected("stale");
    }
    if (event.content === "") {
      this.sql(`DELETE FROM addressable WHERE kind = ? AND pubkey = ? AND d = ?`, event.kind, event.pubkey, d);
      return ADDRESSABLE_PUT_OK;
    }
    const json = JSON.stringify(event);
    if (json.length > (this.opts.addressableMaxBytes ?? ADDRESSABLE_MAX_BYTES)) return addressableRejected("too-large");
    if (!existing[0]) {
      const count = this.sql(`SELECT COUNT(*) AS n FROM addressable WHERE kind = ? AND pubkey = ?`, event.kind, event.pubkey);
      if ((count[0]?.n ?? 0) >= (this.opts.addressablePerAuthor ?? ADDRESSABLE_MAX_PER_AUTHOR)) return addressableRejected("address-quota");
    }
    const budget = this.opts.addressableBytesPerAuthor;
    if (budget !== void 0) {
      const used = this.sql(
        `SELECT COALESCE(SUM(LENGTH(json)), 0) AS n FROM addressable
         WHERE pubkey = ? AND NOT (kind = ? AND d = ?)`,
        event.pubkey,
        event.kind,
        d
      );
      if ((used[0]?.n ?? 0) + json.length > budget) return addressableRejected("byte-quota");
    }
    const eff = effectiveExpiration(event, nowSec, this.opts.addressableTtlSeconds ?? ADDRESSABLE_TTL_SECONDS);
    if (eff <= nowSec) return addressableRejected("expired");
    if (!this.fitsAddressableCeiling(json.length, prev?.len ?? 0)) {
      return addressableRejected("ceiling");
    }
    this.sql(
      `INSERT OR REPLACE INTO addressable (kind, pubkey, d, id, created_at, expiration, json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      event.kind,
      event.pubkey,
      d,
      event.id,
      event.created_at,
      eff,
      json
    );
    return ADDRESSABLE_PUT_OK;
  }
  /**
   * 這顆 DO 還放得下這筆離線留言嗎（ADR-0367 §決策 2）。行為與記憶體版逐字對齊。
   *
   * 🔴 為什麼 FIFO 不夠：`enforceCap` 只對**真正的收件人**執行，而沒有 `p` 標籤的事件
   * 落在 `recipient = ''` ⇒ 那個桶原本只被 TTL 壓著，而遊戲的房間事件正是這個形狀。
   */
  fitsOfflineCeiling(size) {
    const max = this.opts.offlineMaxTotalBytes;
    if (max === void 0) return true;
    if (size > max) return false;
    let used = this.usedOfflineBytes();
    if (used + size <= max) return true;
    if (this.opts.ceilingEvicts !== true) return false;
    const victims = this.sql(
      `SELECT rowid AS r, bytes FROM offline_msgs ORDER BY expiration ASC LIMIT 256`
    );
    for (const row of victims) {
      if (used + size <= max) break;
      this.sql(`DELETE FROM offline_msgs WHERE rowid = ?`, row.r);
      used -= Number(row.bytes ?? 0);
    }
    this.bucketCounts.clear();
    this.offlineUsed = used;
    return used + size <= max;
  }
  /**
   * 這顆 DO 還放得下這筆可尋址事件嗎（ADR-0367 §決策 2）。行為與記憶體版逐字對齊：
   * 車道淘汰**最快到期**者直到騰出空間；嚴格平面直接拒收。
   *
   * `replacedLen` 是**即將被取代**的那一列的長度——它會被換掉，不該算進已用空間。
   */
  fitsAddressableCeiling(size, replacedLen) {
    const max = this.opts.addressableMaxTotalBytes;
    if (max === void 0) return true;
    if (size > max) return false;
    const total = this.sql(`SELECT COALESCE(SUM(LENGTH(json)), 0) AS n FROM addressable`)[0]?.n ?? 0;
    let used = total - replacedLen;
    if (used + size <= max) return true;
    if (this.opts.ceilingEvicts !== true) return false;
    const victims = this.sql(
      `SELECT kind, pubkey, d, LENGTH(json) AS len FROM addressable ORDER BY expiration ASC LIMIT 256`
    );
    for (const row of victims) {
      if (used + size <= max) break;
      this.sql(
        `DELETE FROM addressable WHERE kind = ? AND pubkey = ? AND d = ?`,
        row.kind,
        row.pubkey,
        row.d
      );
      used -= row.len ?? 0;
    }
    return used + size <= max;
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
    if (pValues && pValues.length === 0 || authors && authors.length === 0 || ids && ids.length === 0) {
      return [];
    }
    if (tagFiltersOf(filter).some((t) => t.values.length === 0)) return [];
    const where = [];
    const bind = [];
    const push = (clause, values) => {
      where.push(clause);
      bind.push(...values);
    };
    if (pValues && pValues.length > 0) pushIn(where, bind, "recipient", pValues);
    if (authors && authors.length > 0) pushIn(where, bind, "pubkey", authors);
    if (ids && ids.length > 0) pushIn(where, bind, "id", ids);
    if (kinds && kinds.length > 0) pushIn(where, bind, "kind", kinds);
    if (filter.since !== void 0) push(`created_at >= ?`, [filter.since]);
    if (filter.until !== void 0) push(`created_at <= ?`, [filter.until]);
    pushTagClauses("offline_msgs", filter, where, bind);
    where.push(`(expiration IS NULL OR expiration > ?)`);
    bind.push(nowSec);
    const limit = queryLimit(filter.limit);
    const offline = this.boundedSelect(
      "offline_msgs",
      where.join(" AND "),
      bind,
      limit,
      "COALESCE(bytes, LENGTH(json))",
      maxBytes
    );
    let rows = offline.rows;
    if (!(pValues && pValues.length > 0)) {
      const aWhere = [`expiration > ?`];
      const aBind = [nowSec];
      if (authors && authors.length > 0) pushIn(aWhere, aBind, "pubkey", authors);
      if (ids && ids.length > 0) pushIn(aWhere, aBind, "id", ids);
      if (kinds && kinds.length > 0) pushIn(aWhere, aBind, "kind", kinds);
      pushTagClauses("addressable", filter, aWhere, aBind);
      const remaining = maxBytes === void 0 ? void 0 : maxBytes - offline.spent;
      rows = rows.concat(
        this.boundedSelect("addressable", aWhere.join(" AND "), aBind, limit, "LENGTH(json)", remaining).rows
      );
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
   * 排序多一個 `rowid` 當決勝，兩步才保證挑中的是同一批列。
   */
  boundedSelect(table, where, bind, limit, sizeExpr, budget) {
    const order = "ORDER BY created_at DESC, rowid DESC";
    if (budget === void 0) {
      return { rows: this.sql(`SELECT json FROM ${table} WHERE ${where} ${order} LIMIT ?`, ...bind, limit), spent: 0 };
    }
    const sizes = this.sql(`SELECT ${sizeExpr} AS n FROM ${table} WHERE ${where} ${order} LIMIT ?`, ...bind, limit);
    let take = 0;
    let spent = 0;
    for (const row of sizes) {
      const n = Number(row.n ?? 0);
      if (spent + n > budget) break;
      spent += n;
      take += 1;
    }
    if (take === 0) return { rows: [], spent: 0 };
    return { rows: this.sql(`SELECT json FROM ${table} WHERE ${where} ${order} LIMIT ?`, ...bind, take), spent };
  }
  prune(nowSec) {
    this.invalidateUsage();
    this.sql(`DELETE FROM offline_msgs WHERE expiration IS NOT NULL AND expiration <= ?`, nowSec);
    this.sql(`DELETE FROM addressable WHERE expiration <= ?`, nowSec);
  }
  /**
   * NIP-62 清除（ADR-0260）：`pubkey = ?`（他發的）**或** `recipient = ?`（寄給他的
   * ——Gift Wrap 外層是一次性金鑰，`p` 是唯一能定位收件匣的鍵），外加他的可尋址事件。
   *
   * 兩欄都有索引（`idx_offline_pubkey`／`idx_offline_bucket` 的 recipient 前綴），故不是全表掃描。
   */
  vanish(pubkey, _nowSec) {
    const rows = this.sql(
      `SELECT COUNT(DISTINCT id) AS n FROM offline_msgs WHERE pubkey = ? OR recipient = ?`,
      pubkey,
      pubkey
    );
    const msgs = Number(rows[0]?.n ?? 0);
    const addr = Number(
      this.sql(`SELECT COUNT(*) AS n FROM addressable WHERE pubkey = ?`, pubkey)[0]?.n ?? 0
    );
    this.invalidateUsage();
    this.sql(`DELETE FROM offline_msgs WHERE pubkey = ? OR recipient = ?`, pubkey, pubkey);
    this.sql(`DELETE FROM addressable WHERE pubkey = ?`, pubkey);
    return msgs + addr;
  }
  /**
   * 分桶修剪（ADR-0162：檔案塊與聊天留言各自計數、各自由舊到新丟棄）。
   *
   * 只修剪**這次寫入落到的那一桶**：另一桶的列數沒變，不需要看（修正前兩桶每次都掃）。
   * 列數走快取，只有超量時才讀出要刪的那幾列——而且只讀 `idx_offline_bucket` 的索引項。
   */
  enforceCap(recipients, file) {
    const limit = file ? this.opts.filePerRecipient ?? DEFAULT_FILE_PER_RECIPIENT : this.opts.maxPerRecipient;
    if (limit === void 0) return;
    const bucket = file ? `kind = ${FILE_WRAP_KIND}` : `kind != ${FILE_WRAP_KIND}`;
    for (const recipient of recipients) {
      if (recipient === "") continue;
      const key = bucketKey(recipient, file);
      let count = this.bucketCounts.get(key);
      if (count === void 0) {
        count = Number(
          this.sql(`SELECT COUNT(*) AS n FROM offline_msgs WHERE recipient = ? AND ${bucket}`, recipient)[0]?.n ?? 0
        );
      }
      if (count > limit) {
        const rows = this.sql(
          `SELECT rowid AS r, bytes FROM offline_msgs WHERE recipient = ? AND ${bucket}
           ORDER BY created_at ASC LIMIT ?`,
          recipient,
          count - limit
        );
        for (const row of rows) {
          this.sql(`DELETE FROM offline_msgs WHERE rowid = ?`, row.r);
          if (this.offlineUsed !== void 0) this.offlineUsed -= Number(row.bytes ?? 0);
        }
        count -= rows.length;
      }
      this.bucketCounts.set(key, count);
    }
  }
};
function bucketKey(recipient, file) {
  return `${file ? "f" : "c"}:${recipient}`;
}
export {
  MessageStore,
  SqlMessageStore
};
