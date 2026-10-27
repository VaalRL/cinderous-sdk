import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { NostrEvent } from "../../src/protocol/index.js";
import { describe, expect, it } from "vitest";
import type { RelayFilter } from "../../src/relay/protocol.js";
import { MAX_QUERY_ROWS, MessageStore } from "../../src/relay/message-store.js";
import { type SqlExec, SqlMessageStore } from "../../src/relay/sql-message-store.js";

// node:sqlite 太新、vite 的內建模組表尚未收錄 → 靜態 import 會解析失敗（找 "sqlite"）。
// 改以 createRequire 動態載入（繞過 vite 靜態解析），型別走 type-only import（會被抹除）。
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** 以 Node 內建 SQLite 實作 SqlExec（模擬 DO 的 ctx.storage.sql.exec，同步）。 */
function nodeSqlExec(): SqlExec {
  const db = new DatabaseSync(":memory:");
  return (query, ...bindings) => {
    const stmt = db.prepare(query);
    if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
    stmt.run(...bindings);
    return [];
  };
}

function ev(
  id: string,
  opts: { p?: string[]; kind?: number; createdAt?: number; expiration?: number } = {},
): NostrEvent {
  const tags: string[][] = (opts.p ?? []).map((r) => ["p", r]);
  if (opts.expiration !== undefined) tags.push(["expiration", String(opts.expiration)]);
  return {
    id,
    pubkey: "author",
    created_at: opts.createdAt ?? 1000,
    kind: opts.kind ?? 1059,
    tags,
    content: "",
    sig: "",
  } as NostrEvent;
}

const f = (filter: Partial<RelayFilter>): RelayFilter => filter as RelayFilter;

describe("SqlMessageStore（DO SQLite 離線留言，ADR-0056）", () => {
  it("put + 依 #p 查回；其他收件人不返回", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    expect(s.put(ev("m1", { p: ["alice"] }), 1000)).toBe(true);
    s.put(ev("m2", { p: ["bob"] }), 1000);
    expect(s.query(f({ "#p": ["alice"] }), 1000).map((e) => e.id)).toEqual(["m1"]);
  });

  it("NIP-40 過期：已過期不 put；未來過期可查、到期後不返回", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    expect(s.put(ev("old", { p: ["a"], expiration: 500 }), 1000)).toBe(false);
    s.put(ev("live", { p: ["a"], expiration: 2000 }), 1000);
    expect(s.query(f({ "#p": ["a"] }), 1000).map((e) => e.id)).toEqual(["live"]);
    expect(s.query(f({ "#p": ["a"] }), 2001).map((e) => e.id)).toEqual([]);
  });

  it("per-recipient cap 逐出最舊", () => {
    const s = new SqlMessageStore(nodeSqlExec(), { maxPerRecipient: 2 });
    s.put(ev("a", { p: ["r"], createdAt: 1 }), 1000);
    s.put(ev("b", { p: ["r"], createdAt: 2 }), 1000);
    s.put(ev("c", { p: ["r"], createdAt: 3 }), 1000);
    expect(
      s
        .query(f({ "#p": ["r"] }), 1000)
        .map((e) => e.id)
        .sort(),
    ).toEqual(["b", "c"]); // 最舊的 a 被逐出
  });

  it("prune 刪除已過期留言", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    s.put(ev("live", { p: ["a"], expiration: 5000 }), 1000);
    s.put(ev("willexpire", { p: ["a"], expiration: 1500 }), 1000);
    s.prune(2000); // willexpire 已過期
    expect(s.query(f({ "#p": ["a"] }), 1000).map((e) => e.id)).toEqual(["live"]);
  });

  it("matchFilter：依 kinds 過濾", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    s.put(ev("g", { p: ["a"], kind: 1059 }), 1000);
    s.put(ev("other", { p: ["a"], kind: 1 }), 1000);
    expect(s.query(f({ "#p": ["a"], kinds: [1059] }), 1000).map((e) => e.id)).toEqual(["g"]);
  });

  it("多 p 標籤：兩收件人查詢皆回且去重", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    s.put(ev("m", { p: ["a", "b"] }), 1000);
    expect(s.query(f({ "#p": ["a", "b"] }), 1000).map((e) => e.id)).toEqual(["m"]);
  });
});

describe("壽命上限（ADR-0065：孤兒資料不可能）", () => {
  const WEEK = 7 * 86_400;

  it("無 expiration 的事件套預設 TTL：7 天後 prune/query 都收走（修正前會永存）", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    s.put(ev("noexp", { p: ["a"] }), 1000);
    expect(s.query(f({ "#p": ["a"] }), 1000).map((e) => e.id)).toEqual(["noexp"]);
    const after = 1000 + WEEK + 1;
    expect(s.query(f({ "#p": ["a"] }), after)).toEqual([]);
    s.prune(after);
    expect(s.query(f({ "#p": ["a"] }), 1000)).toEqual([]); // 真的刪了，不是只被過濾
  });

  it("惡意超長 expiration 被截到上限（7 天）", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    s.put(ev("huge", { p: ["a"], expiration: 999_999_999 }), 1000);
    expect(s.query(f({ "#p": ["a"] }), 1000 + WEEK + 1)).toEqual([]);
  });

  it("放寬上限（ADR-0160 企業站 MAX_TTL_DAYS）：30 天章在 90 天上限站不被截；仍截超過站方上限者", () => {
    const s = new SqlMessageStore(nodeSqlExec(), { maxTtlSeconds: 90 * 86_400 });
    s.put(ev("m30", { p: ["a"], expiration: 1000 + 30 * 86_400 }), 1000);
    s.put(ev("huge", { p: ["b"], expiration: 999_999_999 }), 1000);
    // 30 天章：第 29 天仍在、第 31 天收走（未被舊的 7 天上限截斷）。
    expect(s.query(f({ "#p": ["a"] }), 1000 + 29 * 86_400).map((e) => e.id)).toEqual(["m30"]);
    expect(s.query(f({ "#p": ["a"] }), 1000 + 31 * 86_400)).toEqual([]);
    // 超長章仍被截到站方上限（90 天）——站方上限恆為權威。
    expect(s.query(f({ "#p": ["b"] }), 1000 + 89 * 86_400).map((e) => e.id)).toEqual(["huge"]);
    expect(s.query(f({ "#p": ["b"] }), 1000 + 91 * 86_400)).toEqual([]);
  });

  it("遷移：修正前殘留的 NULL 到期列，重啟（重建 store）後補上有界壽命", () => {
    const sql = nodeSqlExec();
    new SqlMessageStore(sql); // 建表
    sql(
      `INSERT INTO offline_msgs (id, recipient, expiration, created_at, json) VALUES (?, ?, NULL, ?, ?)`,
      "legacy",
      "a",
      1000,
      JSON.stringify(ev("legacy", { p: ["a"] })),
    );
    const s = new SqlMessageStore(sql); // 重啟：constructor 遷移 NULL → created_at + TTL
    s.prune(1000 + WEEK + 1);
    expect(s.query(f({ "#p": ["a"] }), 1000)).toEqual([]);
  });
});

describe("SQL 可尋址事件（NIP-33，ADR-0071 快照）", () => {
  const snap = (opts: { d?: string; content?: string; createdAt?: number; pubkey?: string; id?: string } = {}): NostrEvent =>
    ({
      id: opts.id ?? `snap-${opts.d ?? "dev1"}-${opts.createdAt ?? 1000}`,
      pubkey: opts.pubkey ?? "author",
      created_at: opts.createdAt ?? 1000,
      kind: 30078,
      tags: [["d", opts.d ?? "dev1"]],
      content: opts.content ?? "密文快照",
      sig: "",
    }) as NostrEvent;

  it("取代語意：同 (kind,pubkey,d) 只留最新；purge（空 content）刪除", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    expect(s.putAddressable(snap({ createdAt: 1000, content: "v1" }), 1000)).toBe(true);
    expect(s.putAddressable(snap({ createdAt: 2000, content: "v2" }), 2000)).toBe(true);
    expect(s.putAddressable(snap({ createdAt: 500, content: "stale" }), 2100)).toBe(false);
    let got = s.query(f({ kinds: [30078], authors: ["author"] }), 2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.content).toBe("v2");
    expect(s.putAddressable(snap({ createdAt: 3000, content: "" }), 3000)).toBe(true); // purge
    got = s.query(f({ kinds: [30078], authors: ["author"] }), 3000);
    expect(got).toHaveLength(0);
  });

  it("purge 只限快照（Cinderous ADR-0382 §7；SDK ADR 0083）：10050／10002／kind 3 的空 content 照常存、查得到、取代", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    const list = (kind: number, createdAt: number, relay: string): NostrEvent =>
      ({ id: `list-${kind}-${createdAt}`, pubkey: "author", created_at: createdAt, kind, tags: [["relay", relay]], content: "", sig: "" }) as NostrEvent;
    for (const kind of [10050, 10002, 3]) {
      expect(s.putAddressable(list(kind, 1000, "wss://a.example/s/1"), 1000)).toBe(true);
      expect(s.query(f({ kinds: [kind], authors: ["author"] }), 1000)).toHaveLength(1);
      expect(s.putAddressable(list(kind, 2000, "wss://b.example/s/1"), 2000)).toBe(true);
      const got = s.query(f({ kinds: [kind], authors: ["author"] }), 2000);
      expect(got.map((e) => e.tags[0]?.[1])).toEqual(["wss://b.example/s/1"]);
    }
  });

  it("配額：每 (pubkey,kind) 至多 5 個 d、單顆 256KB；30 天到期 prune 收走", () => {
    const MONTH = 30 * 86_400;
    const s = new SqlMessageStore(nodeSqlExec());
    for (let i = 1; i <= 5; i++) expect(s.putAddressable(snap({ d: `dev${i}` }), 1000)).toBe(true);
    expect(s.putAddressable(snap({ d: "dev6" }), 1000)).toBe(false);
    expect(s.putAddressable(snap({ d: "dev1", createdAt: 2000 }), 2000)).toBe(true); // 既有位址可更新
    expect(s.putAddressable(snap({ d: "dev2", createdAt: 3000, content: "x".repeat(300_000) }), 3000)).toBe(false);
    s.prune(1000 + MONTH + 1);
    expect(s.query(f({ kinds: [30078], authors: ["author"] }), 1000)).toHaveLength(1); // 只剩 2000 寫入的 dev1
  });
});

// ADR-0235 C2：查詢條件下推 SQL。
//
// 修正前，`query()` 在沒有 `#p` 時執行 `SELECT json FROM offline_msgs WHERE expiration > ?`
// ——**整張表**（所有使用者的離線留言）撈進記憶體、逐筆 JSON.parse，再於 JS 端 matchFilter。
// 而 relay-core 的 `scoped()` 明文允許「沒有 `#p`、但有 authors」的訂閱（快照查詢就是這個
// 形狀），連 `authors: []` 都放行。於是 `{"authors":[]}` 是零成本 payload：匹配不到任何事件，
// 卻完整跑一次全表掃描。DO 記憶體上限 128MB，重複送幾次就 OOM——而這是單一全域房間。
describe("SqlMessageStore — 查詢下推與筆數上限（ADR-0235 C2）", () => {
  /** 記錄所有 SELECT 語句，用來證明過濾**發生在 SQL 而非 JS**。 */
  function spyExec(): { exec: SqlExec; selects: string[] } {
    const inner = nodeSqlExec();
    const selects: string[] = [];
    return {
      selects,
      exec: (query, ...bindings) => {
        if (/^\s*select/i.test(query)) selects.push(query);
        return inner(query, ...bindings);
      },
    };
  }

  const authored = (id: string, pubkey: string, createdAt = 1000): NostrEvent =>
    ({ ...ev(id, { p: ["r"], createdAt }), pubkey }) as NostrEvent;

  it("authors 下推到 SQL：WHERE 帶 pubkey 條件，不是撈全表再過濾", () => {
    const { exec, selects } = spyExec();
    const s = new SqlMessageStore(exec);
    s.put(authored("m1", "alice"), 1000);
    s.put(authored("m2", "bob"), 1000);
    selects.length = 0;

    expect(s.query(f({ authors: ["alice"] }), 1000).map((e) => e.id)).toEqual(["m1"]);
    expect(selects.some((q) => /pubkey\s+(IN|=)/i.test(q))).toBe(true);
  });

  it("kinds 下推到 SQL", () => {
    const { exec, selects } = spyExec();
    const s = new SqlMessageStore(exec);
    s.put(ev("g", { p: ["r"], kind: 1059 }), 1000);
    s.put(ev("o", { p: ["r"], kind: 1060 }), 1000);
    selects.length = 0;

    expect(s.query(f({ authors: ["author"], kinds: [1060] }), 1000).map((e) => e.id)).toEqual(["o"]);
    expect(selects.some((q) => /kind\s+(IN|=)/i.test(q))).toBe(true);
  });

  it("authors 為空陣列：直接回空，完全不打 DB（最便宜的消防水管 payload）", () => {
    const { exec, selects } = spyExec();
    const s = new SqlMessageStore(exec);
    s.put(authored("m1", "alice"), 1000);
    selects.length = 0;

    expect(s.query(f({ authors: [] }), 1000)).toEqual([]);
    expect(selects).toEqual([]);
  });

  it("ids 下推到 SQL", () => {
    const { exec, selects } = spyExec();
    const s = new SqlMessageStore(exec);
    s.put(authored("m1", "alice"), 1000);
    s.put(authored("m2", "alice"), 1000);
    selects.length = 0;

    expect(s.query(f({ ids: ["m2"] }), 1000).map((e) => e.id)).toEqual(["m2"]);
    expect(selects.some((q) => /\bid\s+(IN|=)/i.test(q))).toBe(true);
  });

  // 「訂閱必須具名」是 relay-core `scoped()` 的職責（ADR-0123），不放在儲存層——儲存層若也
  // 擋，「Ephemeral 不入庫」那類**否定斷言**會變成恆真的空轉測試。這一層保證的是「有界」。
  it("不具名的 filter 仍可查（不改語意），但一律帶 LIMIT——代價有界", () => {
    const { exec, selects } = spyExec();
    const s = new SqlMessageStore(exec, { maxPerRecipient: 10_000 });
    for (let i = 0; i < 2000; i++) s.put(ev(`m${i}`, { p: ["r"], createdAt: 1000 + i }), 1000);
    selects.length = 0;

    const got = s.query(f({ kinds: [1059] }), 1000);
    expect(got.length).toBeLessThanOrEqual(MAX_QUERY_ROWS);
    expect(selects.every((q) => /LIMIT \?/.test(q))).toBe(true);
  }, 30_000); // 寫 2,000 筆進真的 SQLite：整套平行跑時會超過預設的 5 秒

  it("回傳筆數有硬上限，且取最新的", () => {
    const s = new SqlMessageStore(nodeSqlExec(), { maxPerRecipient: 10_000 });
    for (let i = 0; i < 60; i++) s.put(ev(`m${i}`, { p: ["r"], createdAt: 1000 + i }), 1000);
    const got = s.query(f({ "#p": ["r"], limit: 10 }), 1000);
    expect(got).toHaveLength(10);
    // 最新的 10 筆（created_at 1050–1059）
    expect(got.map((e) => e.created_at).sort((a, b) => a - b)[0]).toBe(1050);
  });

  it("filter.limit 超過硬上限時被夾住", () => {
    const s = new SqlMessageStore(nodeSqlExec(), { maxPerRecipient: 10_000 });
    for (let i = 0; i < 1200; i++) s.put(ev(`m${i}`, { p: ["r"], createdAt: 1000 + i }), 1000);
    expect(s.query(f({ "#p": ["r"], limit: 999_999 }), 1000).length).toBeLessThanOrEqual(MAX_QUERY_ROWS);
  }, 30_000); // 寫 1,200 筆進真的 SQLite：整套平行跑時會超過預設的 5 秒

  describe("NIP-62 vanish（ADR-0260）：行為須與記憶體版一致", () => {
    it("刪掉他發的、寄給他的、以及他的可尋址事件", () => {
      const s = new SqlMessageStore(nodeSqlExec());
      s.put(ev("toMe", { p: ["alice"] }), 1000); // 寄給 alice（外層作者是別人＝一次性金鑰）
      s.put(authored("byMe", "alice"), 1000); // alice 發的（收件人是 "r"）
      s.put(ev("other", { p: ["bob"] }), 1000); // 與 alice 無關
      const snap: NostrEvent = {
        ...ev("snap", { kind: 30078, createdAt: 1000 }),
        pubkey: "alice",
        tags: [["d", "dev1"]],
        content: "密文",
      };
      expect(s.putAddressable(snap, 1000)).toBe(true);

      expect(s.vanish("alice", 1000)).toBeGreaterThan(0);

      expect(s.query(f({ "#p": ["alice"] }), 1000)).toEqual([]);
      expect(s.query(f({ authors: ["alice"] }), 1000)).toEqual([]);
      expect(s.query(f({ "#p": ["bob"] }), 1000).map((e) => e.id)).toEqual(["other"]); // 別人的沒被波及
    });

    it("同一顆事件寄給多人：只清請求者那一份", () => {
      const s = new SqlMessageStore(nodeSqlExec());
      s.put(ev("shared", { p: ["alice", "bob"] }), 1000);

      s.vanish("alice", 1000);

      expect(s.query(f({ "#p": ["alice"] }), 1000)).toEqual([]);
      expect(s.query(f({ "#p": ["bob"] }), 1000).map((e) => e.id)).toEqual(["shared"]);
    });

    it("沒有資料時不炸、回 0", () => {
      const s = new SqlMessageStore(nodeSqlExec());
      expect(s.vanish("nobody", 1000)).toBe(0);
    });
  });

  it("舊資料（升級前寫入、無 pubkey/kind 欄）也查得到——遷移有回填", () => {
    const db = nodeSqlExec();
    // 模擬舊 schema：先由舊版建表寫入，再以新版開啟同一個 DB。
    db(`CREATE TABLE IF NOT EXISTS offline_msgs (
      id TEXT NOT NULL, recipient TEXT NOT NULL, expiration INTEGER,
      created_at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (id, recipient))`);
    db(
      `INSERT INTO offline_msgs (id, recipient, expiration, created_at, json) VALUES (?, ?, ?, ?, ?)`,
      "old1",
      "r",
      9_999_999,
      1000,
      JSON.stringify(authored("old1", "alice")),
    );
    const s = new SqlMessageStore(db);
    expect(s.query(f({ authors: ["alice"] }), 1000).map((e) => e.id)).toEqual(["old1"]);
  });
});

describe("🔴 標籤 filter 必須下推 SQL（ADR-0366 P1 #5）", () => {
  /** 帶任意標籤的事件。 */
  const tagged = (id: string, tags: string[][], kind = 1078, createdAt = 1000): NostrEvent =>
    ({ id, pubkey: "author", created_at: createdAt, kind, tags, content: "", sig: "" }) as NostrEvent;

  it("🔴 目標事件被更新的無關事件淹沒時，仍然查得到（修正前回空集合）", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    // 目標最舊。
    s.put(tagged("target", [["w", "world-1"]], 1078, 1), 1);
    // 同 kind 的無關事件把它擠出「最新 N 筆」。
    for (let i = 0; i < 50; i++) s.put(tagged(`noise${i}`, [["w", "other"]], 1078, 100 + i), 1);

    // 修正前：SQL 先 ORDER BY created_at DESC LIMIT 10 拿到 10 筆 noise，
    // 再於 JS 端跑 matchFilter → 全部不符 → **回空陣列**，而 target 明明存在。
    expect(s.query(f({ kinds: [1078], "#w": ["world-1"], limit: 10 }), 1).map((e) => e.id)).toEqual([
      "target",
    ]);
  });

  it("多值標籤是 OR，多個標籤之間是 AND（NIP-01 語意在 SQL 端也要成立）", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    s.put(tagged("a", [["t", "nagd"], ["g", "chess"]]), 1);
    s.put(tagged("b", [["t", "nagd"], ["g", "gomoku"]]), 1);
    s.put(tagged("c", [["t", "lwd"], ["g", "chess"]]), 1);

    const ids = (filter: Partial<RelayFilter>) =>
      s.query(f(filter), 1).map((e) => e.id).sort();
    expect(ids({ "#g": ["chess", "gomoku"] })).toEqual(["a", "b", "c"]);
    expect(ids({ "#t": ["nagd"], "#g": ["chess"] })).toEqual(["a"]);
    expect(ids({ "#t": ["nagd"] })).toEqual(["a", "b"]);
  });

  it("空的標籤陣列匹配不到任何東西——連 DB 都不必打", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    s.put(tagged("a", [["t", "nagd"]]), 1);
    expect(s.query(f({ "#t": [] }), 1)).toEqual([]);
  });

  it("可尋址事件的標籤查詢同樣下推（牌組瀏覽就是這個形狀）", () => {
    const s = new SqlMessageStore(nodeSqlExec());
    const deck = (id: string, d: string, topic: string, createdAt: number): NostrEvent =>
      ({
        id,
        pubkey: `author-${id}`,
        created_at: createdAt,
        kind: 31081,
        tags: [["d", d], ["t", topic]],
        content: "牌組",
        sig: "",
      }) as NostrEvent;

    s.putAddressable(deck("mine", "arena", "openetg-deck", 1), 1);
    for (let i = 0; i < 30; i++) s.putAddressable(deck(`other${i}`, "arena", "別的遊戲", 100 + i), 1);

    expect(
      s.query(f({ kinds: [31081], "#t": ["openetg-deck"], limit: 5 }), 1).map((e) => e.id),
    ).toEqual(["mine"]);
  });

  it("🔴 與記憶體版行為一致——兩個實作共用同一份 OfflineStore 契約", () => {
    // `MessageStore` 一直都是「先 matchFilter 再 limit」（＝正確）；SQL 版原本相反。
    // 行為分歧會讓「用記憶體版寫的測試」保證不了產線的 SQL 版（見 sql-message-store.ts 的註解）。
    const sql = new SqlMessageStore(nodeSqlExec());
    const mem = new MessageStore();
    for (const store of [sql, mem]) {
      store.put(tagged("target", [["w", "world-1"]], 1078, 1), 1);
      for (let i = 0; i < 20; i++) store.put(tagged(`n${i}`, [["w", "other"]], 1078, 100 + i), 1);
    }
    const filter = f({ kinds: [1078], "#w": ["world-1"], limit: 5 });
    expect(sql.query(filter, 1).map((e) => e.id)).toEqual(mem.query(filter, 1).map((e) => e.id));
  });
});

describe("SQL 版的可尋址容量閘與記憶體版一致（ADR-0366 §容量二）", () => {
  const sized = (pubkey: string, d: string, bytes: number, kind = 31081): NostrEvent => {
    const id = `${pubkey}-${kind}-${d}`;
    const shell = JSON.stringify({
      id,
      pubkey,
      created_at: 1000,
      kind,
      tags: [["d", d]],
      content: "",
      sig: "",
    }).length;
    return {
      id,
      pubkey,
      created_at: 1000,
      kind,
      tags: [["d", d]],
      content: "x".repeat(Math.max(0, bytes - shell)),
      sig: "",
    } as NostrEvent;
  };

  const opts = {
    addressableMaxBytes: 4_096,
    addressablePerAuthor: 64,
    addressableBytesPerAuthor: 10_000,
  };

  it("兩個實作對同一串寫入給出同一串答案", () => {
    const sql = new SqlMessageStore(nodeSqlExec(), opts);
    const mem = new MessageStore(opts);
    const writes: NostrEvent[] = [
      sized("a", "d1", 4_000, 31081),
      sized("a", "d2", 4_000, 31082), // 換 kind 仍算進同一個作者
      sized("a", "d3", 4_000, 31083), // 超過總量 → false
      sized("a", "big", 8_000, 31081), // 超過單顆上限 → false
      sized("b", "d1", 4_000, 31081), // 別的作者不受影響
      { ...sized("a", "d1", 4_000, 31081), id: "a-31081-d1-v2", created_at: 2000 } as NostrEvent, // 取代＝算差額
    ];
    const results = (store: SqlMessageStore | MessageStore): boolean[] =>
      writes.map((e) => store.putAddressable(e, 1000));
    expect(results(sql)).toEqual(results(mem));
    expect(results(new SqlMessageStore(nodeSqlExec(), opts))).toEqual([
      true,
      true,
      false,
      false,
      true,
      true,
    ]);
  });
});

describe("SQL 版的 DO 天花板與記憶體版一致（ADR-0367 §決策 2）", () => {
  const sized2 = (pubkey: string, d: string, bytes: number, expiresAt: number): NostrEvent =>
    ({
      id: `${pubkey}-${d}`,
      pubkey,
      created_at: 1000,
      kind: 31081,
      tags: [["d", d], ["expiration", String(expiresAt)]],
      content: "x".repeat(bytes),
      sig: "",
    }) as NostrEvent;

  const writes: NostrEvent[] = [
    sized2("a", "soon", 200, 2000),
    sized2("a", "later", 200, 5000),
    sized2("a", "latest", 200, 9000),
    sized2("a", "new", 200, 9000), // 觸發淘汰
    sized2("b", "huge", 5_000, 9000), // 單顆就超過 → 拒收
  ];

  /** 容量用實際序列化長度算：取「最大的 n 筆」（四顆事件的 `d` 長度不同）。 */
  const roomFor = (n: number): number =>
    writes
      .slice(0, 4)
      .map((e) => JSON.stringify(e).length)
      .sort((a, b) => b - a)
      .slice(0, n)
      .reduce((sum, len) => sum + len, 0);

  it("淘汰模式：兩個實作對同一串寫入給出同一串答案與同一批倖存者", () => {
    const opts = {
      addressableMaxTotalBytes: roomFor(3),
      ceilingEvicts: true,
      addressablePerAuthor: 64,
    };
    const sql = new SqlMessageStore(nodeSqlExec(), opts);
    const mem = new MessageStore(opts);
    const sqlR = writes.map((e) => sql.putAddressable(e, 1000));
    const memR = writes.map((e) => mem.putAddressable(e, 1000));
    expect(sqlR).toEqual(memR);
    expect(sqlR).toEqual([true, true, true, true, false]);

    const survivors = (s: SqlMessageStore | MessageStore): string[] =>
      s
        .query(f({ kinds: [31081], authors: ["a", "b"] }), 1000)
        .map((e) => e.tags.find((t) => t[0] === "d")?.[1] ?? "")
        .sort();
    expect(survivors(sql)).toEqual(survivors(mem));
    expect(survivors(sql)).toEqual(["later", "latest", "new"]);
  });

  it("拒收模式：兩個實作都不動既有資料", () => {
    const opts = { addressableMaxTotalBytes: roomFor(3), addressablePerAuthor: 64 };
    const sql = new SqlMessageStore(nodeSqlExec(), opts);
    const mem = new MessageStore(opts);
    // ⚠ 每個 store 只跑一次——再跑一次是在已經有資料的 store 上寫，答案當然不同。
    const sqlResults = writes.map((e) => sql.putAddressable(e, 1000));
    const memResults = writes.map((e) => mem.putAddressable(e, 1000));
    expect(sqlResults).toEqual(memResults);
    expect(sqlResults).toEqual([true, true, true, false, false]);
  });
});

describe("SQL 版的離線留言天花板與記憶體版一致（ADR-0367 §決策 2）", () => {
  const roomEvent = (id: string, bytes: number, expiresAt: number): NostrEvent =>
    ({
      id,
      pubkey: "a",
      created_at: 1000,
      kind: 1078,
      tags: [["t", "lwd"], ["expiration", String(expiresAt)]],
      content: "x".repeat(bytes),
      sig: "",
    }) as NostrEvent;

  const four = [
    roomEvent("soon", 200, 2000),
    roomEvent("later", 200, 5000),
    roomEvent("latest", 200, 9000),
    roomEvent("fresh", 200, 9000),
  ];
  const roomFor = (n: number): number =>
    four
      .map((e) => JSON.stringify(e).length)
      .sort((a, b) => b - a)
      .slice(0, n)
      .reduce((sum, len) => sum + len, 0);

  it("兩個實作的答案與倖存者名單一致（淘汰模式）", () => {
    const opts = { offlineMaxTotalBytes: roomFor(3), ceilingEvicts: true };
    const sql = new SqlMessageStore(nodeSqlExec(), opts);
    const mem = new MessageStore(opts);
    expect(four.map((e) => sql.put(e, 1000))).toEqual(four.map((e) => mem.put(e, 1000)));
    const kept = (s: SqlMessageStore | MessageStore): string[] =>
      s
        .query(f({ kinds: [1078] }), 1000)
        .map((e) => e.id)
        .sort();
    expect(kept(sql)).toEqual(kept(mem));
    expect(kept(sql)).toEqual(["fresh", "later", "latest"]);
  });
});

describe("檔案車道的儲存層前提（Cinderous ADR-0371 §決策 5／6）", () => {
  /** 記錄所有 SELECT 語句。 */
  function spyExec(): { exec: SqlExec; selects: string[] } {
    const inner = nodeSqlExec();
    const selects: string[] = [];
    return {
      selects,
      exec: (query, ...bindings) => {
        if (/^\s*select/i.test(query)) selects.push(query);
        return inner(query, ...bindings);
      },
    };
  }

  const sized = (id: string, bytes: number, o: { p?: string; kind?: number; createdAt?: number; exp?: number } = {}): NostrEvent =>
    ({
      id,
      pubkey: "a",
      created_at: o.createdAt ?? 1000,
      kind: o.kind ?? 1060,
      tags: [
        ...(o.p === undefined ? [] : [["p", o.p]]),
        ...(o.exp === undefined ? [] : [["expiration", String(o.exp)]]),
      ],
      content: "x".repeat(bytes),
      sig: "",
    }) as NostrEvent;
  const len = (e: NostrEvent): number => JSON.stringify(e).length;

  it("🔴 查詢有位元組預算：只回最新、累計不超過預算的那幾顆（兩個實作一致）", () => {
    const events = Array.from({ length: 10 }, (_, i) => sized(`f${i}`, 1000, { p: "r", createdAt: 1000 + i }));
    const budget = len(events[0]!) * 3 + 10;
    for (const s of [new SqlMessageStore(nodeSqlExec()), new MessageStore()]) {
      for (const e of events) s.put(e, 1000);
      const got = s.query(f({ "#p": ["r"] }), 1000, budget).map((e) => e.id);
      expect(got.sort()).toEqual(["f7", "f8", "f9"]);
      // 以 `until` 分頁拿得到更舊的（NIP-01 的標準做法）
      const older = s.query(f({ "#p": ["r"], until: 1006 }), 1000, budget).map((e) => e.id);
      expect(older.sort()).toEqual(["f4", "f5", "f6"]);
      // 預算連一顆都放不下 → 空（呼叫端據此停止，而不是把整顆 DO 撈進記憶體）
      expect(s.query(f({ "#p": ["r"] }), 1000, 10)).toEqual([]);
      // 沒給預算＝與過去相同
      expect(s.query(f({ "#p": ["r"] }), 1000)).toHaveLength(10);
    }
  });

  it("🔴 寫入不再每次掃全表算總量、也不再逐列解 JSON 算分桶（快取＋覆蓋索引）", () => {
    const { exec, selects } = spyExec();
    const s = new SqlMessageStore(exec, { maxPerRecipient: 500, offlineMaxTotalBytes: 10_000_000 });
    s.put(sized("w0", 100, { p: "r" }), 1000); // 暖機：第一次允許算一次總量
    selects.length = 0;
    for (let i = 1; i < 20; i++) s.put(sized(`w${i}`, 100, { p: "r" }), 1000);
    expect(selects.filter((q) => /SUM\(/i.test(q))).toEqual([]);
    expect(selects.filter((q) => /json_extract\(json/i.test(q))).toEqual([]);
    expect(selects.filter((q) => /LENGTH\(json\)/i.test(q))).toEqual([]);
  });

  it("重複寫入同一顆不重複計入總量", () => {
    const a = sized("a", 500, { p: "r" });
    const b = sized("b", 500, { p: "r" });
    const s = new SqlMessageStore(nodeSqlExec(), { offlineMaxTotalBytes: len(a) + len(b) });
    expect(s.put(a, 1000)).toBe(true);
    expect(s.put(a, 1000)).toBe(true);
    expect(s.put(b, 1000)).toBe(true); // 若 a 被算了兩次，這裡會被拒
  });

  it("刪除路徑（分桶修剪／prune／vanish）都會把空間還回來", () => {
    const one = sized("x0", 500, { p: "r" });
    const room = len(one) * 2;
    // 分桶修剪：檔案配額 1 → 第二顆把第一顆擠掉，第三顆仍放得下
    const trim = new SqlMessageStore(nodeSqlExec(), { maxPerRecipient: 500, filePerRecipient: 1, offlineMaxTotalBytes: room });
    for (const id of ["t1", "t2", "t3"]) expect(trim.put(sized(id, 500, { p: "r" }), 1000)).toBe(true);
    // prune：過期的收走之後空間回來
    const pr = new SqlMessageStore(nodeSqlExec(), { offlineMaxTotalBytes: room });
    pr.put(sized("p1", 500, { p: "r", exp: 1500 }), 1000);
    pr.put(sized("p2", 500, { p: "r" }), 1000);
    expect(pr.put(sized("p3", 500, { p: "r" }), 1000)).toBe(false);
    pr.prune(2000);
    expect(pr.put(sized("p3", 500, { p: "r" }), 2000)).toBe(true);
    // vanish
    const va = new SqlMessageStore(nodeSqlExec(), { offlineMaxTotalBytes: room });
    va.put(sized("v1", 500, { p: "gone" }), 1000);
    va.put(sized("v2", 500, { p: "r" }), 1000);
    va.vanish("gone", 1000);
    expect(va.put(sized("v3", 500, { p: "r" }), 1000)).toBe(true);
  });

  it("升級前寫入的列（沒有 bytes 欄）也算進總量——遷移有回填", () => {
    const db = nodeSqlExec();
    db(`CREATE TABLE IF NOT EXISTS offline_msgs (
      id TEXT NOT NULL, recipient TEXT NOT NULL, expiration INTEGER,
      created_at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (id, recipient))`);
    const old = sized("old", 500, { p: "r" });
    db(
      `INSERT INTO offline_msgs (id, recipient, expiration, created_at, json) VALUES (?, ?, ?, ?, ?)`,
      "old",
      "r",
      9_999_999,
      1000,
      JSON.stringify(old),
    );
    const s = new SqlMessageStore(db, { offlineMaxTotalBytes: len(old) * 2 });
    expect(s.put(sized("n1", 500, { p: "r" }), 1000)).toBe(true);
    expect(s.put(sized("n2", 500, { p: "r" }), 1000)).toBe(false); // old 有算進去
  });

  it("檔案桶與聊天桶仍各自修剪（改用欄位與索引後語意不變）", () => {
    const s = new SqlMessageStore(nodeSqlExec(), { maxPerRecipient: 2, filePerRecipient: 3 });
    for (let i = 0; i < 5; i++) s.put(sized(`c${i}`, 10, { p: "r", kind: 1059, createdAt: 1000 + i }), 1000);
    for (let i = 0; i < 5; i++) s.put(sized(`f${i}`, 10, { p: "r", kind: 1060, createdAt: 1000 + i }), 1000);
    const ids = s.query(f({ "#p": ["r"] }), 1000).map((e) => e.id).sort();
    expect(ids).toEqual(["c3", "c4", "f2", "f3", "f4"]);
  });
});

describe("審查修正（Cinderous ADR-0371）", () => {
  const dupP = (id: string): NostrEvent =>
    ({ id, pubkey: "a", created_at: 1000, kind: 1060, tags: [["p", "r"], ["p", "r"]], content: "x".repeat(500), sig: "" }) as NostrEvent;

  it("🔴 重複的 p 標籤不會讓用量快取多算（否則天花板會誤拒、車道會誤淘汰）", () => {
    const one = JSON.stringify(dupP("d1")).length;
    const s = new SqlMessageStore(nodeSqlExec(), { maxPerRecipient: 500, offlineMaxTotalBytes: one * 2 });
    expect(s.put(dupP("d1"), 1000)).toBe(true);
    expect(s.put(dupP("d2"), 1000)).toBe(true); // 若 d1 被算成兩份，這裡會被拒
  });

  it("沒設 maxPerRecipient 時檔案桶照樣受配額限制（與記憶體版一致）", () => {
    const s = new SqlMessageStore(nodeSqlExec(), { filePerRecipient: 2 });
    const m = new MessageStore({ filePerRecipient: 2 });
    for (const store of [s, m]) {
      for (let i = 0; i < 4; i++) store.put(ev(`f${i}`, { p: ["r"], kind: 1060, createdAt: 1000 + i }), 1000);
      expect(store.query(f({ "#p": ["r"] }), 1000).map((e) => e.id).sort()).toEqual(["f2", "f3"]);
    }
  });
});

describe("🔴 DO SQLite 每次查詢最多 100 個綁定參數（Cinderous ADR-0372；SDK ADR 0032）", () => {
  /**
   * 模擬 Durable Object SQLite 的「每次查詢最多 100 個綁定參數」上限。
   * node:sqlite 的上限是 32766，不包這一層的話本機測試永遠看不出來。
   */
  const DO_MAX_BINDINGS = 100;
  function limitedExec(): { exec: SqlExec; maxSeen: () => number } {
    const inner = nodeSqlExec();
    let max = 0;
    return {
      maxSeen: () => max,
      exec: (query, ...bindings) => {
        max = Math.max(max, bindings.length);
        if (bindings.length > DO_MAX_BINDINGS) {
          throw new Error(`too many SQL variables: ${bindings.length} > ${DO_MAX_BINDINGS}`);
        }
        return inner(query, ...bindings);
      },
    };
  }

  const key = (prefix: string, i: number): string => `${prefix}${String(i).padStart(4, "0")}`;
  /** 作者 a0000…、收件人 r0000…、id e0000…，每顆帶一個 `e` 與一個 `t` 標籤。 */
  const post = (i: number, kind = 1059): NostrEvent =>
    ({
      id: key("e", i),
      pubkey: key("a", i),
      created_at: 1000 + i,
      kind,
      tags: [["p", key("r", i)], ["e", key("ref", i)], ["t", key("topic", i)]],
      content: "",
      sig: "",
    }) as NostrEvent;

  /** 同一串寫入分別灌進受限的 SQL 版與記憶體版。 */
  function seeded(n: number): { sql: SqlMessageStore; mem: MessageStore; maxSeen: () => number } {
    const { exec, maxSeen } = limitedExec();
    const sql = new SqlMessageStore(exec);
    const mem = new MessageStore();
    for (let i = 0; i < n; i++) {
      sql.put(post(i), 2000);
      mem.put(post(i), 2000);
    }
    return { sql, mem, maxSeen };
  }

  const range = (n: number, prefix: string): string[] => Array.from({ length: n }, (_, i) => key(prefix, i));
  const ids = (events: NostrEvent[]): string[] => events.map((e) => e.id);
  /**
   * 與記憶體版同一組結果，且 SQL 版依 created_at 由新到舊（修正前的 `ORDER BY` 語意）。
   * 記憶體版在沒截斷時保留插入順序，所以集合比對、順序另外斷言。
   */
  const expectSameAsMemory = (got: string[], mem: MessageStore, filter: RelayFilter): void => {
    expect([...got].sort()).toEqual(ids(mem.query(filter, 2000)).sort());
    expect(got).toEqual([...got].sort().reverse()); // id 與 created_at 同序（見 post()）
  };

  for (const n of [101, 150, 1024]) {
    it(`authors ${n} 把：查得到、與記憶體版一致`, () => {
      const { sql, mem } = seeded(Math.min(n, 300));
      const filter = f({ authors: range(n, "a"), limit: 1000 });
      const got = ids(sql.query(filter, 2000));
      expect(got.length).toBe(Math.min(n, 300));
      expectSameAsMemory(got, mem, filter);
    });
  }

  it("ids 150 個：查得到、與記憶體版一致", () => {
    const { sql, mem } = seeded(200);
    const filter = f({ ids: range(150, "e") });
    const got = ids(sql.query(filter, 2000));
    expect(got.length).toBe(150);
    expectSameAsMemory(got, mem, filter);
  });

  it("#p 150 個：查得到、與記憶體版一致", () => {
    const { sql, mem } = seeded(200);
    const filter = f({ "#p": range(150, "r") });
    const got = ids(sql.query(filter, 2000));
    expect(got.length).toBe(150);
    expectSameAsMemory(got, mem, filter);
  });

  it("kinds 150 個：查得到、與記憶體版一致", () => {
    const { sql, mem } = seeded(20);
    const filter = f({ kinds: Array.from({ length: 150 }, (_, i) => 1000 + i) });
    const got = ids(sql.query(filter, 2000));
    expect(got.length).toBe(20);
    expectSameAsMemory(got, mem, filter);
  });

  it("標籤值（#e）150 個：查得到、與記憶體版一致", () => {
    const { sql, mem } = seeded(200);
    const filter = f({ "#e": range(150, "ref") });
    const got = ids(sql.query(filter, 2000));
    expect(got.length).toBe(150);
    expectSameAsMemory(got, mem, filter);
  });

  it("全部欄位一起放大（authors／ids 1024、#p／#e／#t 各 150、kinds 150）＋ limit：語意不變", () => {
    const { sql, mem, maxSeen } = seeded(300);
    const filter = f({
      authors: range(1024, "a"),
      ids: range(1024, "e"),
      kinds: [1059, ...Array.from({ length: 149 }, (_, i) => 2000 + i)],
      "#p": range(150, "r"),
      "#e": range(150, "ref"),
      "#t": range(150, "topic"),
      since: 1010,
      until: 1200,
      limit: 25,
    });
    const got = ids(sql.query(filter, 2000));
    // 150 個候選（i < 150）∩ since/until（10..150）→ 取最新 25 顆。
    expect(got).toEqual(Array.from({ length: 25 }, (_, i) => key("e", 149 - i)));
    expect(got).toEqual(ids(mem.query(filter, 2000)));
    expect(maxSeen()).toBeLessThanOrEqual(DO_MAX_BINDINGS);
  });

  it("位元組預算與 limit 在大 filter 下語意不變（ADR-0371 §決策 6）", () => {
    const { sql, mem } = seeded(300);
    const one = JSON.stringify(post(0)).length;
    const filter = f({ authors: range(300, "a"), limit: 200 });
    const got = ids(sql.query(filter, 2000, one * 7 + 3));
    expect(got).toEqual(Array.from({ length: 7 }, (_, i) => key("e", 299 - i)));
    expect(got).toEqual(ids(mem.query(filter, 2000, one * 7 + 3)));
  });

  it("可尋址表同樣放得下大 filter（authors 1024 ＋ #d 200）", () => {
    const { exec } = limitedExec();
    const s = new SqlMessageStore(exec);
    const snap = (i: number): NostrEvent =>
      ({
        id: key("s", i),
        pubkey: key("a", i),
        created_at: 1000 + i,
        kind: 30078,
        tags: [["d", key("d", i)]],
        content: "x",
        sig: "",
      }) as NostrEvent;
    for (let i = 0; i < 200; i++) s.putAddressable(snap(i), 1000);
    const got = ids(s.query(f({ kinds: [30078], authors: range(1024, "a"), "#d": range(200, "d"), limit: 500 }), 1000));
    expect(got.length).toBe(200);
    expect(got[0]).toBe(key("s", 199));
  });

  it("寫入與刪除路徑（多 p 標籤的 put、vanish、prune、天花板淘汰）都不超過上限", () => {
    const { exec, maxSeen } = limitedExec();
    const s = new SqlMessageStore(exec, { maxPerRecipient: 2, offlineMaxTotalBytes: 330_000, ceilingEvicts: true });
    const wide = {
      id: "wide",
      pubkey: "a",
      created_at: 1000,
      kind: 1059,
      tags: range(150, "r").map((r) => ["p", r]),
      content: "",
      sig: "",
    } as NostrEvent;
    expect(s.put(wide, 1000)).toBe(true);
    for (let i = 0; i < 20; i++) s.put(post(i), 1000);
    s.prune(1000);
    s.vanish("a", 1000);
    expect(maxSeen()).toBeLessThanOrEqual(DO_MAX_BINDINGS);
  });

  it("多個不同標籤鍵（40 個）也放得下", () => {
    const { exec } = limitedExec();
    const s = new SqlMessageStore(exec);
    const tags = Array.from({ length: 40 }, (_, i) => [`x${i}`, "v"]);
    s.put({ id: "many", pubkey: "a", created_at: 1, kind: 1078, tags, content: "", sig: "" } as NostrEvent, 1);
    const filter: Record<string, unknown> = { authors: range(1024, "a").concat("a") };
    for (let i = 0; i < 40; i++) filter[`#x${i}`] = ["v", ...range(100, "z")];
    expect(ids(s.query(filter as RelayFilter, 1))).toEqual(["many"]);
  });
});
