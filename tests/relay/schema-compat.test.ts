// DO SQLite 遷移相容性（SDK ADR 0029；對應 Cinderous ADR-0371 §決策 5）。
//
// ## 為什麼要有這個檔案
//
// Cinderous PR #9 會讓官方錨點改跑 SDK 的中繼。那一刻，**同一顆** Durable Object 的 SQLite
// 會從「Cinderous main 版建的 schema」直接被「SDK 版的建構子」打開——中間沒有任何人工遷移。
// 兩邊的建構子只要有一個 `CREATE`／`ALTER` 不等冪、或 SDK 少建一個索引，症狀就是：
// DO 在建構子裡丟例外（整條車道斷線），或查詢默默走全表（沒有症狀、只有帳單）。
//
// 所以這裡的起點**不是**用 SDK 自己的建構子建出來的表，而是**逐字抄下** Cinderous main
// （merge commit 73756982，ADR-0371）的建構子跑完後 `sqlite_master` 裡的內容。
// 抄法：把 Cinderous main 的 `relay/src/sql-message-store.ts` 以 esbuild 打包、對空的
// node:sqlite 跑一次建構子，再 `SELECT type, name, sql FROM sqlite_master`。
// Cinderous 那邊的 schema 若再變，這份夾具要跟著重抄——測試會先在「兩邊結構不同」那一條變紅。

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { NostrEvent } from "../../src/protocol/index.js";
import { ConnPersistence, type AttachmentSocket } from "../../src/relay/conn-persistence.js";
import { FILE_WRAP_KIND } from "../../src/relay/message-store.js";
import { type SqlExec, SqlMessageStore } from "../../src/relay/sql-message-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** Cinderous main（73756982，ADR-0371 之後）建構子跑完後的 schema——逐字抄自 `sqlite_master`。 */
const CINDEROUS_MAIN_0371_SCHEMA = [
  `CREATE TABLE addressable (
        kind INTEGER NOT NULL,
        pubkey TEXT NOT NULL,
        d TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expiration INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (kind, pubkey, d)
      )`,
  `CREATE TABLE offline_msgs (
        id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        expiration INTEGER,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL, pubkey TEXT, kind INTEGER, bytes INTEGER,
        PRIMARY KEY (id, recipient)
      )`,
  "CREATE INDEX idx_addressable_expiration ON addressable(expiration)",
  "CREATE INDEX idx_addressable_pubkey ON addressable(pubkey)",
  "CREATE INDEX idx_offline_bucket ON offline_msgs(recipient, kind, created_at, expiration, bytes)",
  "CREATE INDEX idx_offline_bytes_missing ON offline_msgs(id) WHERE bytes IS NULL",
  "CREATE INDEX idx_offline_expiration ON offline_msgs(expiration)",
  "CREATE INDEX idx_offline_kind ON offline_msgs(kind)",
  "CREATE INDEX idx_offline_pubkey ON offline_msgs(pubkey)",
];

/** Cinderous ADR-0371 之前（＝SDK v0.24.0 及更早）的 schema：沒有 bytes 欄、有 idx_offline_recipient。 */
const PRE_0371_SCHEMA = [
  CINDEROUS_MAIN_0371_SCHEMA[0]!,
  `CREATE TABLE offline_msgs (
        id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        expiration INTEGER,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL, pubkey TEXT, kind INTEGER,
        PRIMARY KEY (id, recipient)
      )`,
  "CREATE INDEX idx_addressable_expiration ON addressable(expiration)",
  "CREATE INDEX idx_addressable_pubkey ON addressable(pubkey)",
  "CREATE INDEX idx_offline_expiration ON offline_msgs(expiration)",
  "CREATE INDEX idx_offline_kind ON offline_msgs(kind)",
  "CREATE INDEX idx_offline_pubkey ON offline_msgs(pubkey)",
  "CREATE INDEX idx_offline_recipient ON offline_msgs(recipient)",
];

/**
 * SDK ADR 0042（v0.34）在 Cinderous 的 schema 之上加的東西——**逐字**。全部是相容遷移：
 * 兩個 `ADD COLUMN`（有預設值）、兩個只收借用列的部分索引、一張丟棄計數表與它的索引。
 * 舊程式（Cinderous main、SDK v0.33）打開加過的 DB 照常讀寫（capacity-compat.test.ts 以 v0.33 原樣的 store 驗證）。
 */
const SDK_0042_ADDITIONS = [
  `ALTER TABLE offline_msgs ADD COLUMN borrowed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE addressable ADD COLUMN borrowed INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX idx_offline_borrowed ON offline_msgs(recipient, pubkey, expiration, bytes, created_at) WHERE borrowed = 1`,
  `CREATE INDEX idx_addressable_borrowed ON addressable(pubkey, expiration) WHERE borrowed = 1`,
  `CREATE TABLE inbox_drops (
        recipient TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        since INTEGER,
        until INTEGER,
        mark INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`,
  `CREATE INDEX idx_inbox_drops_updated ON inbox_drops(updated_at)`,
];

/**
 * SDK ADR 0085（v0.60）：檔案塊整批淘汰的批次欄位與部分索引——**逐字**。相容遷移：可為 NULL 的欄位（舊版的 INSERT 不帶它＝NULL＝不參與整批淘汰）
 * 與只收 `batch IS NOT NULL` 的部分索引；回滾到舊版照常讀寫。移植到 Cinderous 時，Cinderous 的建構子要長出同樣兩行。
 */
const SDK_0085_ADDITIONS = [
  `ALTER TABLE offline_msgs ADD COLUMN batch INTEGER`,
  `CREATE INDEX idx_offline_batch ON offline_msgs(recipient, batch, bytes, created_at) WHERE batch IS NOT NULL`,
];

/**
 * SDK ADR 0098（Cinderous ADR-0388）：拿掉 `idx_offline_kind`——`#p` 查詢走分桶索引、`authors` 查詢走 pubkey 索引，
 * 它只會在 `authors+kinds` 時被查詢規劃器誤選（kind 的選擇性遠低於 pubkey），卻讓每次寫入與刪除各多寫一列。
 * 舊版程式打開時 `CREATE INDEX IF NOT EXISTS` 會把它建回來（等冪、回滾照常），新版再拿掉。
 */
const SDK_0098_REMOVALS = [`DROP INDEX idx_offline_kind`];

function openDb(): { db: DatabaseSyncType; exec: SqlExec } {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExec = (query, ...bindings) => {
    const stmt = db.prepare(query);
    if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
    stmt.run(...bindings);
    return [];
  };
  return { db, exec };
}

function schemaOf(db: DatabaseSyncType): { type: string; name: string; sql: string }[] {
  return db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as { type: string; name: string; sql: string }[];
}

const NOW = 1_800_000_000;
const ALICE = "a".repeat(64);

function chunk(n: number, createdAt = NOW - 100 + n): NostrEvent {
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey: "b".repeat(64),
    created_at: createdAt,
    kind: FILE_WRAP_KIND,
    tags: [["p", ALICE]],
    content: "x".repeat(1000),
    sig: "c".repeat(128),
  };
}

/** 照 Cinderous main 的寫法插一列（它的 `put` 一律寫 bytes）。 */
function insertLikeCinderousMain(exec: SqlExec, e: NostrEvent, withBytes = true): void {
  const json = JSON.stringify(e);
  exec(
    `INSERT INTO offline_msgs (id, recipient, expiration, created_at, json, pubkey, kind, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    e.id,
    ALICE,
    NOW + 86_400,
    e.created_at,
    json,
    e.pubkey,
    e.kind,
    withBytes ? json.length : null,
  );
}

describe("DO SQLite：從 Cinderous main 的 schema 切到 SDK 版（SDK ADR 0029）", () => {
  it("🔴 SDK 建構子打開 Cinderous main（ADR-0371 後）的 DB：不丟例外、重跑不丟例外、收斂到 SDK 從零建的 schema", () => {
    const { db, exec } = openDb();
    for (const ddl of CINDEROUS_MAIN_0371_SCHEMA) exec(ddl);
    expect(() => new SqlMessageStore(exec, {})).not.toThrow();
    const once = schemaOf(db);
    // 等冪：再開一次（DO 每次喚醒都會跑建構子）也不變
    expect(() => new SqlMessageStore(exec, {})).not.toThrow();
    expect(schemaOf(db)).toEqual(once);
    const fresh = openDb();
    new SqlMessageStore(fresh.exec, {});
    expect(once).toEqual(schemaOf(fresh.db));
  });

  it("🔴 SDK 自己從零建出來的 schema＝Cinderous main 的＋SDK ADR 0042 的相容遷移（逐字；兩邊不會各長各的）", () => {
    const main = openDb();
    for (const ddl of [...CINDEROUS_MAIN_0371_SCHEMA, ...SDK_0042_ADDITIONS, ...SDK_0085_ADDITIONS, ...SDK_0098_REMOVALS]) {
      main.exec(ddl);
    }
    const fresh = openDb();
    new SqlMessageStore(fresh.exec, {});
    expect(schemaOf(fresh.db)).toEqual(schemaOf(main.db));
  });

  it("Cinderous main 寫下的檔案塊升級後沒有批次（batch＝NULL）：不參與整批淘汰，同一個 expiration 也不會被當成同一批刪掉（SDK ADR 0085）", () => {
    const { db, exec } = openDb();
    for (const ddl of CINDEROUS_MAIN_0371_SCHEMA) exec(ddl);
    for (let i = 1; i <= 3; i += 1) insertLikeCinderousMain(exec, chunk(i));
    const store = new SqlMessageStore(exec, { filePerRecipient: 4 });
    const batches = db.prepare("SELECT batch FROM offline_msgs").all() as { batch: number | null }[];
    expect(batches.map((b) => b.batch)).toEqual([null, null, null]);
    for (let i = 10; i <= 11; i += 1) store.put(chunk(i, NOW + i), NOW); // FIFO 只刪最舊的一顆
    expect(store.query({ "#p": [ALICE] }, NOW)).toHaveLength(4);
  });

  it("Cinderous main 寫下的列升級後是正常列（borrowed＝0）、容量照舊算進去", () => {
    const { db, exec } = openDb();
    for (const ddl of CINDEROUS_MAIN_0371_SCHEMA) exec(ddl);
    for (let i = 1; i <= 3; i += 1) insertLikeCinderousMain(exec, chunk(i));
    const size = JSON.stringify(chunk(9)).length;
    const store = new SqlMessageStore(exec, { offlineMaxTotalBytes: size * 3 + 10, overflowRatio: 0.5, borrowPerKeyBytes: size * 2 });
    const flags = db.prepare("SELECT borrowed FROM offline_msgs").all() as { borrowed: number }[];
    expect(flags.map((f) => f.borrowed)).toEqual([0, 0, 0]);
    // 天花板剛好只容得下既有的 3 顆 ⇒ 第 4 顆進溢位帶（借用），不是擠掉舊的
    expect(store.putResult(chunk(9), NOW)).toEqual({ ok: true, borrowedTtlSec: 7200 });
    expect(store.query({ "#p": [ALICE] }, NOW)).toHaveLength(4);
  });

  it("既有的列照常可讀、用量與分桶配額把它們算進去（不會因為換實作而多收）", () => {
    const { exec } = openDb();
    for (const ddl of CINDEROUS_MAIN_0371_SCHEMA) exec(ddl);
    for (let i = 1; i <= 5; i += 1) insertLikeCinderousMain(exec, chunk(i));
    const store = new SqlMessageStore(exec, { filePerRecipient: 6 });
    expect(store.query({ "#p": [ALICE] }, NOW)).toHaveLength(5);
    // 配額 6：再寫兩顆 ⇒ 最舊的那顆（#1）被擠掉，總數 6
    expect(store.put(chunk(6), NOW)).toBe(true);
    expect(store.put(chunk(7), NOW)).toBe(true);
    const ids = store.query({ "#p": [ALICE] }, NOW).map((e) => e.id);
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain(chunk(1).id);
  });

  it("天花板以 bytes 欄計算，既有列（Cinderous main 寫的）一併計入", () => {
    const { exec } = openDb();
    for (const ddl of CINDEROUS_MAIN_0371_SCHEMA) exec(ddl);
    for (let i = 1; i <= 3; i += 1) insertLikeCinderousMain(exec, chunk(i));
    const size = JSON.stringify(chunk(9)).length;
    // 天花板剛好只容得下既有的 3 顆 ⇒ 第 4 顆被拒（不淘汰模式）
    const store = new SqlMessageStore(exec, { offlineMaxTotalBytes: size * 3 + 10 });
    expect(store.put(chunk(9), NOW)).toBe(false);
  });

  it("從更舊的 schema（ADR-0371 之前＝SDK v0.24.0）升上來：加 bytes 欄、回填、換索引", () => {
    const { db, exec } = openDb();
    for (const ddl of PRE_0371_SCHEMA) exec(ddl);
    const e = chunk(1);
    exec(
      `INSERT INTO offline_msgs (id, recipient, expiration, created_at, json, pubkey, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      e.id,
      ALICE,
      NOW + 86_400,
      e.created_at,
      JSON.stringify(e),
      e.pubkey,
      e.kind,
    );
    new SqlMessageStore(exec, {});
    const fresh = openDb();
    new SqlMessageStore(fresh.exec, {});
    expect(schemaOf(db)).toEqual(schemaOf(fresh.db));
    const row = db.prepare("SELECT bytes FROM offline_msgs").get() as { bytes: number };
    expect(row.bytes).toBe(JSON.stringify(e).length);
  });
});

/**
 * Cinderous PR #12（ADR-0372）＋ PR #13（ADR-0373）套用後的 schema（SDK ADR 0032）。
 *
 * **也就是 Cinderous main 目前的 schema**（22e3860c，含 ADR-0375／0376／0377）：那三個 ADR 只改程式與 DO 的 key-value
 * （ADR-0377 的 `cinder:do-name`），不動 SQLite。2026-09-30 以同一個抄法重抄比對過，逐字相同。
 *
 * PR #12 只改查詢、不動 schema；PR #13 新增 `ws_subs`。抄法同上：把 `claude/relay-ws-attachment-limit` 的
 * `relay/src` 疊上 `claude/relay-sql-param-limit` 的 `sql-message-store.ts`，以 esbuild 打包、在 node:sqlite 上
 * 跑它的 `RelayRoom`（建構子＋一條溢位訂閱）後 dump `sqlite_master`——`sub_id` 後面的兩個空白也是原樣。
 */
const CINDEROUS_WS_SUBS_DDL = `CREATE TABLE ws_subs (
        conn_id TEXT NOT NULL,
        sub_id  TEXT NOT NULL,
        filters TEXT NOT NULL,
        PRIMARY KEY (conn_id, sub_id)
      )`;
const CINDEROUS_0372_0373_SCHEMA = [...CINDEROUS_MAIN_0371_SCHEMA, CINDEROUS_WS_SUBS_DDL];

/** DO 建構子在 SDK 版會開的兩樣東西（與 `RelayRoom` 的建構子相同）。 */
function openLikeSdkRoom(exec: SqlExec): ConnPersistence {
  new SqlMessageStore(exec, {});
  return new ConnPersistence(exec);
}

/** 只有 attachment 的假 WebSocket。 */
function socketWith(attachment: unknown): AttachmentSocket {
  let att = attachment;
  return {
    serializeAttachment: (o) => {
      att = o;
    },
    deserializeAttachment: () => att,
  };
}

describe("DO SQLite：從 Cinderous（PR #12＋#13）的 schema 切到 SDK 版（SDK ADR 0032）", () => {
  it("🔴 SDK 打開 Cinderous main（含 ADR-0375／0376／0377）的 DB：不丟例外、重跑不丟例外、收斂到 SDK 從零建的 schema", () => {
    const { db, exec } = openDb();
    for (const ddl of CINDEROUS_0372_0373_SCHEMA) exec(ddl);
    expect(() => openLikeSdkRoom(exec)).not.toThrow();
    const once = schemaOf(db);
    expect(() => openLikeSdkRoom(exec)).not.toThrow();
    expect(schemaOf(db)).toEqual(once);
    const fresh = openDb();
    openLikeSdkRoom(fresh.exec);
    expect(once).toEqual(schemaOf(fresh.db));
  });

  it("🔴 SDK 從零建出來的 schema＝Cinderous main（含 ws_subs）＋SDK ADR 0042 的相容遷移（逐字）", () => {
    const cin = openDb();
    for (const ddl of [...CINDEROUS_0372_0373_SCHEMA, ...SDK_0042_ADDITIONS, ...SDK_0085_ADDITIONS, ...SDK_0098_REMOVALS]) {
      cin.exec(ddl);
    }
    const fresh = openDb();
    openLikeSdkRoom(fresh.exec);
    expect(schemaOf(fresh.db)).toEqual(schemaOf(cin.db));
  });

  it("從 Cinderous main（ADR-0371，還沒有 ws_subs）升上來：補建 ws_subs，收斂到同一份", () => {
    const old = openDb();
    for (const ddl of CINDEROUS_MAIN_0371_SCHEMA) old.exec(ddl);
    openLikeSdkRoom(old.exec);
    const fresh = openDb();
    openLikeSdkRoom(fresh.exec);
    expect(schemaOf(old.db)).toEqual(schemaOf(fresh.db));
  });

  it("Cinderous 寫下的溢位列與 attachment 由 SDK 還原；孤兒列清掉", () => {
    const { db, exec } = openDb();
    for (const ddl of CINDEROUS_0372_0373_SCHEMA) exec(ddl);
    const hb = [{ kinds: [20000], authors: Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(64, "0")) }];
    exec(`INSERT INTO ws_subs (conn_id, sub_id, filters) VALUES (?, ?, ?)`, "c1", "hb", JSON.stringify(hb));
    exec(`INSERT INTO ws_subs (conn_id, sub_id, filters) VALUES (?, ?, ?)`, "gone", "hb", JSON.stringify(hb));
    // Cinderous 的 attachment 形狀（欄位順序照抄）：沒有 SDK 才有的 ip 欄
    const ws = socketWith({
      connId: "c1",
      challenge: "ch",
      pubkey: ALICE,
      relayHost: "relay.example",
      subs: [{ subId: "small", filters: [{ kinds: [20000], authors: [ALICE] }] }],
      spilled: ["hb"],
    });
    const { snapshots, lost } = openLikeSdkRoom(exec).load([ws]);
    expect(lost).toEqual([]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.pubkey).toBe(ALICE);
    expect(snapshots[0]!.subs.map((s) => s.subId).sort()).toEqual(["hb", "small"]);
    expect(snapshots[0]!.subs.find((s) => s.subId === "hb")!.filters).toEqual(hb);
    expect(db.prepare("SELECT conn_id FROM ws_subs").all().map((r) => (r as { conn_id: string }).conn_id)).toEqual(["c1"]);
  });
});

describe("離線留言查詢的索引（SDK ADR 0098；Cinderous ADR-0388）", () => {
  /** 記下 `query()` 對 offline_msgs 下的 SELECT，再用同樣的綁定值看查詢計畫。 */
  function plansOf(filter: Parameters<SqlMessageStore["query"]>[0]): string[] {
    const { db, exec } = openDb();
    const seen: { query: string; bindings: unknown[] }[] = [];
    const store = new SqlMessageStore((query, ...bindings) => {
      if (/FROM offline_msgs/.test(query) && /^\s*select/i.test(query)) seen.push({ query, bindings });
      return exec(query, ...bindings);
    });
    seen.length = 0;
    store.query(filter, NOW);
    expect(seen.length).toBeGreaterThan(0);
    return seen.map(({ query, bindings }) =>
      JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(bindings as never[]))),
    );
  }

  it("🔴 `#p`（＋kinds＋since）走分桶索引", () => {
    for (const plan of plansOf({ "#p": [ALICE], kinds: [FILE_WRAP_KIND, 1], since: NOW - 60 })) {
      expect(plan).toContain("idx_offline_bucket");
    }
  });

  it("🔴 `authors`＋kinds 走 pubkey 索引（修正前被規劃器誤選成選擇性很低的 idx_offline_kind）", () => {
    for (const plan of plansOf({ authors: ["b".repeat(64)], kinds: [30_078] })) {
      expect(plan).toContain("idx_offline_pubkey");
      expect(plan).not.toContain("idx_offline_kind");
    }
  });
});
