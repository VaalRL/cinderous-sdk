// 容量政策的向下相容與回滾（SDK ADR 0042）。
//
// 對照組是 **v0.33.0 的 store 原樣**（`tests/fixtures/v0.33-stores.mjs`，由 gen-v0.33-stores.mjs 從 tag 打包）：
// 1. 不設任何容量選項時，同一串寫入交給 v0.33 與現在的 store，每一則的結果、每一次的庫存都一模一樣。
// 2. 現在的建構子遷移過的 DB（borrowed 欄、部分索引、inbox_drops）交給 v0.33 的程式：照常讀寫，新欄位被忽略。
//    v0.33 的 schema 與 Cinderous main（ADR-0375／0376／0377）逐字相同（schema-compat.test.ts），所以這也是錨點的回滾路徑。
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { NostrEvent } from "../../src/protocol/index.js";
import { MessageStore, type MessageStoreOptions, type OfflineStore } from "../../src/relay/message-store.js";
import { type SqlExec, SqlMessageStore } from "../../src/relay/sql-message-store.js";
import * as v033 from "../fixtures/v0.33-stores.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

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

/** 可重現的亂數（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = 1_800_000_000;
const PEOPLE = ["1", "2", "3", "4", "5", "6"].map((c) => c.repeat(64));
const hex = (n: number): string => n.toString(16).padStart(64, "0");

type Op =
  | { type: "put"; event: NostrEvent; now: number }
  | { type: "addr"; event: NostrEvent; now: number }
  | { type: "prune"; now: number }
  | { type: "vanish"; pubkey: string; now: number };

/** 一串混合的寫入：禮物包（多收件人、無收件人、檔案塊、已過期）、可尋址（取代、較舊、清除）、prune、NIP-62 */
function workload(seed: number, count: number): Op[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const ops: Op[] = [];
  let now = T0;
  for (let i = 1; i <= count; i += 1) {
    now += Math.floor(r() * 30);
    const roll = r();
    if (roll < 0.55) {
      const recipients = r() < 0.15 ? [] : r() < 0.2 ? [pick(PEOPLE), pick(PEOPLE)] : [pick(PEOPLE)];
      const tags = recipients.map((p) => ["p", p]);
      if (r() < 0.7) tags.push(["expiration", String(now + Math.floor(r() * 4000) - 200)]);
      ops.push({
        type: "put",
        now,
        event: {
          id: hex(i),
          pubkey: pick(PEOPLE),
          created_at: now - Math.floor(r() * 500),
          kind: r() < 0.2 ? 1060 : r() < 0.5 ? 1 : 1059,
          tags,
          content: "x".repeat(50 + Math.floor(r() * 1500)),
          sig: "0".repeat(128),
        },
      });
    } else if (roll < 0.9) {
      const author = pick(PEOPLE);
      const kind = pick([30_078, 30_100, 10_037]);
      ops.push({
        type: "addr",
        now,
        event: {
          id: hex(i),
          pubkey: author,
          created_at: now - Math.floor(r() * 50),
          kind,
          tags: [["d", `d${Math.floor(r() * 5)}`]],
          // 空 content 只給快照：其他 kind 的空 content 在 ADR 0083 之後是普通內容、不再是 purge——
          // 那是刻意的行為差異，不屬於這裡要比對的容量政策
          content: kind === 30_078 && r() < 0.05 ? "" : "y".repeat(50 + Math.floor(r() * 1500)),
          sig: "0".repeat(128),
        },
      });
    } else if (roll < 0.98) {
      ops.push({ type: "prune", now });
    } else {
      ops.push({ type: "vanish", pubkey: pick(PEOPLE), now });
    }
  }
  return ops;
}

/** 庫裡的全部內容（每位收件人的收件匣＋每位作者的一般與可尋址事件） */
function snapshot(store: { query: OfflineStore["query"] }, now: number): string[] {
  const out: string[] = [];
  for (const p of PEOPLE) {
    out.push(`p:${p[0]}:${store.query({ "#p": [p] }, now).map((e) => e.id).sort().join(",")}`);
    out.push(`a:${p[0]}:${store.query({ authors: [p] }, now).map((e) => e.id).sort().join(",")}`);
  }
  return out;
}

/** 與 v0.33 的 v0.33 選項（沒有任何 SDK ADR 0042 的欄位） */
const VARIANTS: [string, MessageStoreOptions][] = [
  ["嚴格平面（拒收）", { maxPerRecipient: 6, filePerRecipient: 4, offlineMaxTotalBytes: 25_000, addressableMaxTotalBytes: 18_000, addressableBytesPerAuthor: 6_000, maxTtlSeconds: 3_000 }],
  [
    "車道（淘汰）",
    { maxPerRecipient: 6, filePerRecipient: 4, offlineMaxTotalBytes: 25_000, addressableMaxTotalBytes: 18_000, ceilingEvicts: true, addressablePerAuthor: 3, addressableTtlSeconds: 2_000 },
  ],
  ["沒有天花板", { maxPerRecipient: 3 }],
];

describe("向下相容：沒設容量選項時，與 v0.33.0 的 store 逐則相同（SDK ADR 0042）", () => {
  for (const [name, opts] of VARIANTS) {
    for (const seed of [1, 2, 3]) {
      it(`${name}・seed ${seed}：SqlMessageStore`, () => {
        const oldDb = openDb();
        const newDb = openDb();
        const before = new v033.SqlMessageStore(oldDb.exec, opts);
        const after = new SqlMessageStore(newDb.exec, opts);
        replay(before, after, workload(seed, 400), name.startsWith("嚴格"));
      });
      it(`${name}・seed ${seed}：MessageStore`, () => {
        replay(new v033.MessageStore(opts), new MessageStore(opts), workload(seed, 400), name.startsWith("嚴格"));
      });
    }
  }

  function replay(before: v033.V033Store, after: OfflineStore, ops: Op[], strict = false): void {
    let checked = 0;
    let rejected = 0;
    for (const [i, op] of ops.entries()) {
      if (op.type === "put") {
        const got = after.putResult!(op.event, op.now);
        if (!got.ok && got.reason === "ceiling") rejected += 1;
        expect(got.ok, `第 ${i} 則`).toBe(before.put(op.event, op.now));
        // 沒設容量選項：收下的結果沒有任何附帶欄位（OK true 的訊息仍是空字串）
        if (got.ok) expect(got).toEqual({ ok: true });
      } else if (op.type === "addr") {
        const got = after.putAddressableResult!(op.event, op.now);
        expect(got.ok, `第 ${i} 則`).toBe(before.putAddressable(op.event, op.now));
        if (got.ok) expect(got).toEqual({ ok: true });
      } else if (op.type === "prune") {
        before.prune(op.now);
        after.prune(op.now);
      } else {
        expect(after.vanish(op.pubkey, op.now)).toBe(before.vanish(op.pubkey, op.now));
      }
      if (i % 25 === 0) {
        expect(snapshot(after, op.now)).toEqual(snapshot(before, op.now));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
    // 拒收制的變體真的撞到天花板（不是一串永遠放得下的寫入）
    if (strict) expect(rejected).toBeGreaterThan(50);
  }
});

describe("回滾：新版遷移過的 DB 交給 v0.33 的程式（SDK ADR 0042）", () => {
  const R = "7".repeat(64);
  const wrapTo = (n: number, recipient: string): NostrEvent => ({
    id: hex(n),
    pubkey: "e".repeat(64),
    created_at: T0,
    kind: 1059,
    tags: [["p", recipient]],
    content: "x".repeat(300),
    sig: "0".repeat(128),
  });
  const size = JSON.stringify(wrapTo(1, R)).length;

  it("🔴 v0.33 的建構子打開新 schema 不丟例外；借用列照樣讀得到、照樣會到期；它寫的列在新版是正常列", () => {
    const { db, exec } = openDb();
    const store = new SqlMessageStore(exec, {
      offlineMaxTotalBytes: 2 * size,
      overflowRatio: 1,
      borrowPerKeyBytes: 2 * size,
      countDrops: true,
      maxPerRecipient: 10,
    });
    store.putResult(wrapTo(1, R), T0);
    store.putResult(wrapTo(2, R), T0);
    expect(store.putResult(wrapTo(3, R), T0)).toMatchObject({ ok: true, borrowedTtlSec: 7200 });
    store.takeDropped(R, T0);

    // 回滾：舊程式打開同一顆 DB
    let old: v033.V033Store | undefined;
    expect(() => (old = new v033.SqlMessageStore(exec, { maxPerRecipient: 10 }))).not.toThrow();
    expect(old!.query({ "#p": [R] }, T0).map((e) => e.id).sort()).toEqual([hex(1), hex(2), hex(3)]);
    expect(old!.put(wrapTo(4, R), T0)).toBe(true);
    expect(old!.putAddressable({ ...wrapTo(5, R), kind: 30_078, tags: [["d", "x"]] }, T0)).toBe(true);
    // 借用列的到期時間本來就寫在 expiration：舊程式的 prune 照樣收走它
    old!.prune(T0 + 7200);
    expect(old!.query({ "#p": [R] }, T0 + 7200).map((e) => e.id).sort()).toEqual([hex(1), hex(2), hex(4)]);

    // 再升級回來：冪等、舊程式寫的列是正常列（borrowed 預設 0）
    expect(() => new SqlMessageStore(exec, {})).not.toThrow();
    const flags = db.prepare("SELECT id, borrowed FROM offline_msgs ORDER BY id").all() as { id: string; borrowed: number }[];
    expect(flags.map((f) => f.borrowed)).toEqual([0, 0, 0]);
    const addrFlag = db.prepare("SELECT borrowed FROM addressable").get() as { borrowed: number };
    expect(addrFlag.borrowed).toBe(0);
  });
});
