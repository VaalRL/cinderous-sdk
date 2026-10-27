// 共用 DO 的容量政策（SDK ADR 0042）：保底份額、溢位帶、粗分級預警、丟棄計數。
//
// 每一個情境都對記憶體版（`MessageStore`）與 SQL 版（`SqlMessageStore`，node:sqlite）各跑一次：
// 決策在 `capacity.ts` 共用，兩個 store 只負責執行——這裡釘住兩邊執行出來的結果一模一樣。
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { NostrEvent } from "../../src/protocol/index.js";
import {
  BORROW_TTL_SECONDS,
  decideCapacity,
  DROPPED_COUNT_MAX,
  DROPPED_RECIPIENTS_MAX,
  type CapacityInput,
  mergeDropped,
  nearFullGrade,
  pickExcess,
} from "../../src/relay/capacity.js";
import { ADDRESSABLE_PUT_OK, MessageStore, type MessageStoreOptions, type OfflineStore } from "../../src/relay/message-store.js";
import { SqlMessageStore } from "../../src/relay/sql-message-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

type Store = OfflineStore &
  Required<Pick<OfflineStore, "putResult" | "putAddressableResult" | "takeDropped" | "markDelivered" | "setInboxProbe">>;

function sqlStore(opts: MessageStoreOptions): { store: Store; db: DatabaseSyncType } {
  const db = new DatabaseSync(":memory:");
  const store = new SqlMessageStore((query, ...bindings) => {
    const stmt = db.prepare(query);
    if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
    stmt.run(...bindings);
    return [];
  }, opts);
  return { store, db };
}

const STORES: [string, (opts: MessageStoreOptions) => Store][] = [
  ["MessageStore", (opts) => new MessageStore(opts)],
  ["SqlMessageStore", (opts) => sqlStore(opts).store],
];

const NOW = 1_800_000_000;
const hex = (n: number): string => n.toString(16).padStart(64, "0");
/** 收件人／作者的公鑰（64 位 hex，大小固定） */
const key = (c: string): string => c.repeat(64);
const L = key("1"); // 輕度使用者
const H = key("2"); // 重度使用者

/** 一則寄給 `recipient` 的禮物包；每一顆大小都相同（id、時間、到期都是固定位數）。`exp` 決定淘汰順序。 */
function wrap(n: number, recipient: string, exp = NOW + 100_000 + n, created = NOW - 1000 + n): NostrEvent {
  return {
    id: hex(n),
    pubkey: key("e"),
    created_at: created,
    kind: 1059,
    tags: [
      ["p", recipient],
      ["expiration", String(exp)],
    ],
    content: "x".repeat(200),
    sig: "0".repeat(128),
  };
}
const ROW = JSON.stringify(wrap(1, L)).length;

/** 一顆可尋址事件；大小固定。 */
function addr(n: number, author: string, exp = NOW + 100_000 + n): NostrEvent {
  return {
    id: hex(n),
    pubkey: author,
    created_at: NOW - 1000 + n,
    kind: 30_100,
    tags: [
      ["d", `bucket-${String(n).padStart(4, "0")}`],
      ["expiration", String(exp)],
    ],
    content: "y".repeat(200),
    sig: "0".repeat(128),
  };
}
const ADDR = JSON.stringify(addr(1, L)).length;

const inbox = (store: OfflineStore, recipient: string, now = NOW): string[] =>
  store
    .query({ "#p": [recipient] }, now)
    .map((e) => e.id)
    .sort();
const buckets = (store: OfflineStore, author: string, now = NOW): string[] =>
  store
    .query({ authors: [author], kinds: [30_100] }, now)
    .map((e) => e.id)
    .sort();
const ids = (...ns: number[]): string[] => ns.map(hex).sort();
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("capacity.ts 的純函式（兩個 store 共用的決策）", () => {
  const base: CapacityInput = {
    max: 100,
    used: 0,
    need: 10,
    evicts: false,
    guarantee: undefined,
    band: 0,
    planeBorrows: true,
    borrowed: () => 0,
    withinGuarantee: () => true,
    excessAvailable: () => 0,
    borrowFitsPerKey: () => true,
  };
  it("放得下＝fit；單則超過天花板＝reject（v0.33 相同）", () => {
    expect(decideCapacity({ ...base, used: 90 }).type).toBe("fit");
    expect(decideCapacity({ ...base, need: 101 }).type).toBe("reject");
  });
  it("🔴 沒設任何容量選項：拒收制＝reject、淘汰制＝legacy（v0.33 的兩條路）", () => {
    expect(decideCapacity({ ...base, used: 95 }).type).toBe("reject");
    expect(decideCapacity({ ...base, used: 95, evicts: true }).type).toBe("legacy");
  });
  it("淘汰制沒有保底時溢位帶不生效（仍是 legacy，而且連借用量都不查）", () => {
    let asked = false;
    const d = decideCapacity({ ...base, used: 95, evicts: true, band: 50, borrowed: () => ((asked = true), 0) });
    expect(d.type).toBe("legacy");
    expect(asked).toBe(false);
  });
  it("正常列還放得下、只是借用列佔著＝reclaim（原訂用途收回借出去的空間）", () => {
    expect(decideCapacity({ ...base, used: 95, band: 25, borrowed: () => 10 }).type).toBe("reclaim");
  });
  it("淘汰制＋保底：寫的人在保底內＝excess（算得出來才動手），不夠＝reject", () => {
    const g = { ...base, used: 100, evicts: true, guarantee: 30 };
    expect(decideCapacity({ ...g, excessAvailable: () => 10 }).type).toBe("excess");
    expect(decideCapacity({ ...g, excessAvailable: () => 9 }).type).toBe("reject");
  });
  it("超出保底的寫入只能借用；帶子滿、每 key 上限、平面不借用都是 reject（不擠任何人）", () => {
    const over = { ...base, used: 100, evicts: true, guarantee: 30, band: 25, withinGuarantee: () => false };
    expect(decideCapacity(over).type).toBe("borrow");
    expect(decideCapacity({ ...over, used: 120 }).type).toBe("reject");
    expect(decideCapacity({ ...over, borrowFitsPerKey: () => false }).type).toBe("reject");
    expect(decideCapacity({ ...over, planeBorrows: false }).type).toBe("reject");
  });
  it("粗分級預警只有兩級：門檻與 95", () => {
    expect(nearFullGrade(79, 100, 80)).toBeUndefined();
    expect(nearFullGrade(80, 100, 80)).toBe(80);
    expect(nearFullGrade(94, 100, 80)).toBe(80);
    expect(nearFullGrade(95, 100, 80)).toBe(95);
    expect(nearFullGrade(130, 100, 80)).toBe(95);
    expect(nearFullGrade(96, 100, undefined)).toBeUndefined();
    expect(nearFullGrade(96, 100, 97)).toBeUndefined();
    expect(nearFullGrade(97, 100, 97)).toBe(97);
  });
  it("pickExcess：最快到期優先、每個 key 不低於保底、大列放不下就看下一列", () => {
    const rows = [
      { owner: "a", bytes: 30 },
      { owner: "b", bytes: 10 },
      { owner: "a", bytes: 10 },
    ];
    const usage = new Map([
      ["a", 45],
      ["b", 35],
    ]);
    const picked = pickExcess(rows, usage, 20, 100);
    expect(picked.rows).toEqual([rows[1], rows[2]]); // a 的 30 會讓 a 掉到 15 < 20，跳過；b、a 各 10 都不低於 20
    expect(picked.freed).toBe(20);
  });
  it("丟棄計數有上限、時間範圍取聯集", () => {
    const a = mergeDropped(undefined, 3, 100, 200);
    expect(mergeDropped(a, 2, 50, 150)).toEqual({ count: 5, since: 50, until: 200 });
    expect(mergeDropped(a, DROPPED_COUNT_MAX, 100, 100).count).toBe(DROPPED_COUNT_MAX);
  });
});

for (const [name, make] of STORES) {
  describe(`${name}：保底份額（淘汰制）`, () => {
    const opts: MessageStoreOptions = { offlineMaxTotalBytes: 10 * ROW, ceilingEvicts: true, guaranteeBytes: 3 * ROW };

    /** L 兩則（最快到期）、H 八則，剛好滿 */
    function filled(o: MessageStoreOptions): Store {
      const store = make(o);
      for (const n of [1, 2]) expect(store.putResult(wrap(n, L), NOW).ok).toBe(true);
      for (const n of range(3, 10)) expect(store.putResult(wrap(n, H), NOW).ok).toBe(true);
      return store;
    }

    it("🔴 重度收件人不能擠掉輕度收件人保底內的留言：H 再寫一則是拒收（blocked: ceiling），L 一則不少", () => {
      const store = filled(opts);
      expect(store.putResult(wrap(11, H), NOW)).toEqual({ ok: false, reason: "ceiling" });
      expect(inbox(store, L)).toEqual(ids(1, 2));
      expect(inbox(store, H)).toEqual(ids(...range(3, 10)));
    });

    it("對照：沒有保底（v0.33）時，同一則會把 L 最快到期的那則擠掉——這正是要修的", () => {
      const store = filled({ offlineMaxTotalBytes: 10 * ROW, ceilingEvicts: true });
      expect(store.putResult(wrap(11, H), NOW)).toEqual({ ok: true });
      expect(inbox(store, L)).toEqual(ids(2));
    });

    it("保底內的寫入先淘汰「超出保底」的部分：L 的第三則擠掉 H 最快到期的一則", () => {
      const store = filled(opts);
      expect(store.putResult(wrap(11, L), NOW)).toEqual({ ok: true });
      expect(inbox(store, L)).toEqual(ids(1, 2, 11));
      expect(inbox(store, H)).toEqual(ids(...range(4, 10)));
    });

    it("淘汰不會讓任何 key 低於保底；騰不出空間就拒收，而且一列都不刪（不做半套淘汰）", () => {
      const store = make(opts);
      const A = key("a");
      const B = key("b");
      const C = key("c");
      range(1, 4).forEach((n) => store.putResult(wrap(n, A), NOW)); // A 超出保底一則
      range(5, 7).forEach((n) => store.putResult(wrap(n, B), NOW));
      range(8, 10).forEach((n) => store.putResult(wrap(n, C), NOW));
      // 一則寄給兩位新收件人（兩列）：可淘汰的只有 A 的一則 ⇒ 不夠 ⇒ 拒收，A 的四則都還在
      const two = { ...wrap(11, key("d")), tags: [["p", key("d")], ["p", key("f")], ["expiration", String(NOW + 100_011)]] };
      expect(store.putResult(two, NOW)).toEqual({ ok: false, reason: "ceiling" });
      expect(inbox(store, A)).toEqual(ids(1, 2, 3, 4));
      // 一列的就夠：淘汰 A 最快到期的那則，A 剩三則＝保底
      expect(store.putResult(wrap(12, key("d")), NOW)).toEqual({ ok: true });
      expect(inbox(store, A)).toEqual(ids(2, 3, 4));
      // 大家都在保底內了 ⇒ 下一位新收件人拒收，沒有人被刪
      expect(store.putResult(wrap(13, key("f")), NOW)).toEqual({ ok: false, reason: "ceiling" });
      expect(inbox(store, A)).toEqual(ids(2, 3, 4));
    });

    it("沒有收件人的列（遊戲房間事件）以作者計保底", () => {
      const room = (n: number, author: string): NostrEvent => ({
        ...wrap(n, L),
        pubkey: author,
        kind: 1,
        tags: [["t", "room"], ["expiration", String(NOW + 100_000 + n)]],
      });
      const size = JSON.stringify(room(1, L)).length;
      const store = make({ offlineMaxTotalBytes: 10 * size, ceilingEvicts: true, guaranteeBytes: 3 * size });
      [1, 2].forEach((n) => store.putResult(room(n, L), NOW));
      range(3, 10).forEach((n) => store.putResult(room(n, H), NOW));
      expect(store.putResult(room(11, H), NOW)).toEqual({ ok: false, reason: "ceiling" });
      expect(store.putResult(room(12, L), NOW)).toEqual({ ok: true });
      const kept = store.query({ kinds: [1] }, NOW).map((e) => e.id);
      expect(kept).toContain(hex(1));
      expect(kept).not.toContain(hex(3));
    });

    it("可尋址：重度作者不能擠掉輕度作者保底內的桶；輕度作者的新桶擠掉重度作者最久沒更新的", () => {
      const store = make({ addressableMaxTotalBytes: 10 * ADDR, ceilingEvicts: true, guaranteeBytes: 3 * ADDR, addressablePerAuthor: 64 });
      [1, 2].forEach((n) => expect(store.putAddressableResult(addr(n, L), NOW).ok).toBe(true));
      range(3, 10).forEach((n) => expect(store.putAddressableResult(addr(n, H), NOW).ok).toBe(true));
      expect(store.putAddressableResult(addr(11, H), NOW)).toEqual({ ok: false, reason: "ceiling" });
      expect(buckets(store, L)).toEqual(ids(1, 2));
      // 重度作者更新既有的桶（同樣大小）不受影響：被取代的那顆不算用量
      const update = { ...addr(3, H, NOW + 200_000), id: hex(103), created_at: NOW };
      expect(store.putAddressableResult(update, NOW)).toEqual(ADDRESSABLE_PUT_OK);
      expect(store.putAddressableResult(addr(12, L), NOW)).toEqual(ADDRESSABLE_PUT_OK);
      expect(buckets(store, L)).toEqual(ids(1, 2, 12));
      expect(buckets(store, H)).toHaveLength(7);
      expect(buckets(store, H)).not.toContain(hex(4)); // 最快到期（最久沒更新）的份額外那一顆
      expect(buckets(store, H)).toContain(hex(103)); // 剛更新的留著
    });
  });

  describe(`${name}：溢位帶（借用）`, () => {
    const strict: MessageStoreOptions = { offlineMaxTotalBytes: 10 * ROW, overflowRatio: 0.5, borrowPerKeyBytes: 2 * ROW };
    const fill = (store: Store): void => {
      range(1, 10).forEach((n) => expect(store.putResult(wrap(n, key(n.toString(16))), NOW)).toEqual({ ok: true }));
    };

    it("拒收制（嚴格平面）滿了：收進溢位帶、回借用秒數；讀得到；2 小時後讀不到、prune 收走", () => {
      const store = make(strict);
      fill(store);
      const R = key("b");
      expect(store.putResult(wrap(11, R), NOW)).toEqual({ ok: true, borrowedTtlSec: BORROW_TTL_SECONDS });
      expect(inbox(store, R)).toEqual(ids(11));
      expect(inbox(store, R, NOW + BORROW_TTL_SECONDS - 1)).toEqual(ids(11));
      expect(inbox(store, R, NOW + BORROW_TTL_SECONDS)).toEqual([]);
      store.prune(NOW + BORROW_TTL_SECONDS);
      expect(store.putResult(wrap(12, R), NOW + BORROW_TTL_SECONDS)).toEqual({ ok: true, borrowedTtlSec: BORROW_TTL_SECONDS });
    });

    it("借用保存期取「原本的到期」與「2 小時」較早的那個", () => {
      const store = make(strict);
      fill(store);
      const R = key("b");
      expect(store.putResult(wrap(11, R, NOW + 60), NOW).ok).toBe(true);
      expect(inbox(store, R, NOW + 60)).toEqual([]);
    });

    it("🔴 帶子滿了：新的借用不擠舊的借用，拒收", () => {
      const store = make({ ...strict, borrowPerKeyBytes: 10 * ROW });
      fill(store);
      range(11, 15).forEach((n) => expect(store.putResult(wrap(n, key("b")), NOW).ok).toBe(true)); // 帶子 5 列
      expect(store.putResult(wrap(16, key("c")), NOW)).toEqual({ ok: false, reason: "ceiling" });
      expect(inbox(store, key("b"))).toEqual(ids(...range(11, 15)));
    });

    it("每個收件人在帶子裡有上限：超過的那位拒收，別人照樣借得到", () => {
      const store = make(strict);
      fill(store);
      const R = key("b");
      expect(store.putResult(wrap(11, R), NOW).ok).toBe(true);
      expect(store.putResult(wrap(12, R), NOW).ok).toBe(true);
      expect(store.putResult(wrap(13, R), NOW)).toEqual({ ok: false, reason: "ceiling" });
      expect(store.putResult(wrap(14, key("c")), NOW)).toEqual({ ok: true, borrowedTtlSec: BORROW_TTL_SECONDS });
    });

    it("原訂用途收回空間：正常寫入放得下但借用列佔著 ⇒ 先刪最快到期的借用列，正常收下", () => {
      const store = make(strict);
      // 十則正常列，其中三則很快到期
      range(1, 10).forEach((n) => store.putResult(wrap(n, key(n.toString(16)), n <= 3 ? NOW + 5 : NOW + 100_000 + n), NOW));
      expect(store.putResult(wrap(11, key("b")), NOW).ok).toBe(true); // 借用，到期 NOW+7200
      expect(store.putResult(wrap(12, key("c")), NOW + 1).ok).toBe(true); // 借用，到期 NOW+7201
      store.prune(NOW + 10); // 正常列剩 7、借用 2
      expect(store.putResult(wrap(13, key("d")), NOW + 10)).toEqual({ ok: true }); // 總量 10，放得下
      expect(store.putResult(wrap(14, key("f")), NOW + 10)).toEqual({ ok: true }); // 正常列 9 ≤ 10 ⇒ 刪一顆借用
      expect(inbox(store, key("b"), NOW + 10)).toEqual([]);
      expect(inbox(store, key("c"), NOW + 10)).toEqual(ids(12));
    });

    it("嚴格平面的可尋址（雲端快照）不借用：滿了照舊拒收", () => {
      const store = make({ addressableMaxTotalBytes: 3 * ADDR, overflowRatio: 0.5, addressableBorrows: false, addressablePerAuthor: 64 });
      range(1, 3).forEach((n) => expect(store.putAddressableResult(addr(n, key(n.toString(16))), NOW).ok).toBe(true));
      expect(store.putAddressableResult(addr(4, key("4")), NOW)).toEqual({ ok: false, reason: "ceiling" });
    });

    it("車道（淘汰制＋保底）：超出保底的新寫入借用閒置空間、不擠別人；保底內的寫入先刪借用列再刪份額外", () => {
      const store = make({
        offlineMaxTotalBytes: 10 * ROW,
        ceilingEvicts: true,
        guaranteeBytes: 3 * ROW,
        overflowRatio: 0.5,
        borrowPerKeyBytes: 2 * ROW,
      });
      [1, 2].forEach((n) => store.putResult(wrap(n, L), NOW));
      range(3, 10).forEach((n) => store.putResult(wrap(n, H), NOW));
      expect(store.putResult(wrap(11, H), NOW)).toEqual({ ok: true, borrowedTtlSec: BORROW_TTL_SECONDS });
      expect(inbox(store, L)).toEqual(ids(1, 2));
      expect(store.putResult(wrap(12, L), NOW)).toEqual({ ok: true });
      expect(inbox(store, L)).toEqual(ids(1, 2, 12));
      expect(inbox(store, H)).toEqual(ids(...range(4, 10))); // 借用的 11 與最快到期的 3 都刪了
    });

    it("可尋址（車道＋保底）：超出保底的作者借用，回借用秒數", () => {
      const store = make({
        addressableMaxTotalBytes: 10 * ADDR,
        ceilingEvicts: true,
        guaranteeBytes: 3 * ADDR,
        overflowRatio: 0.5,
        borrowPerKeyBytes: 2 * ADDR,
        addressablePerAuthor: 64,
      });
      range(1, 10).forEach((n) => store.putAddressableResult(addr(n, H), NOW));
      expect(store.putAddressableResult(addr(11, H), NOW)).toEqual({ ok: true, borrowedTtlSec: BORROW_TTL_SECONDS });
      expect(buckets(store, H, NOW + BORROW_TTL_SECONDS)).not.toContain(hex(11));
      // L 在保底內：先刪借用的那顆，不夠再刪 H 份額外的
      expect(store.putAddressableResult(addr(12, L), NOW)).toEqual(ADDRESSABLE_PUT_OK);
      expect(buckets(store, H)).not.toContain(hex(11));
      expect(buckets(store, H)).toHaveLength(9);
    });

    it("淘汰制沒有保底：溢位帶不生效，照 v0.33 淘汰最快到期的", () => {
      const store = make({ offlineMaxTotalBytes: 10 * ROW, ceilingEvicts: true, overflowRatio: 0.5 });
      range(1, 10).forEach((n) => store.putResult(wrap(n, L), NOW));
      expect(store.putResult(wrap(11, L), NOW)).toEqual({ ok: true });
      expect(inbox(store, L)).toEqual(ids(...range(2, 11)));
    });
  });

  describe(`${name}：粗分級預警`, () => {
    it("離線：達 80% 回 80、達 95% 回 95；沒設就不回", () => {
      const store = make({ offlineMaxTotalBytes: 10 * ROW, nearFullPercent: 80 });
      const grades = range(1, 10).map((n) => store.putResult(wrap(n, key(n.toString(16))), NOW));
      expect(grades.slice(0, 7)).toEqual(Array(7).fill({ ok: true }));
      expect(grades[7]).toEqual({ ok: true, nearFull: 80 });
      expect(grades[8]).toEqual({ ok: true, nearFull: 80 });
      expect(grades[9]).toEqual({ ok: true, nearFull: 95 });
      const plain = make({ offlineMaxTotalBytes: 10 * ROW });
      expect(range(1, 10).map((n) => plain.putResult(wrap(n, key("a")), NOW))).toEqual(Array(10).fill({ ok: true }));
    });
    it("可尋址同樣分級", () => {
      const store = make({ addressableMaxTotalBytes: 10 * ADDR, nearFullPercent: 80, addressablePerAuthor: 64 });
      const grades = range(1, 10).map((n) => store.putAddressableResult(addr(n, L), NOW));
      expect(grades[6]).toEqual(ADDRESSABLE_PUT_OK);
      expect(grades[7]).toEqual({ ok: true, nearFull: 80 });
      expect(grades[9]).toEqual({ ok: true, nearFull: 95 });
    });
  });

  describe(`${name}：丟棄計數`, () => {
    const R = key("7");
    it("FIFO 擠掉還沒送到的：累計則數與寄件時間範圍；取出後歸零", () => {
      const store = make({ maxPerRecipient: 3, countDrops: true });
      range(1, 5).forEach((n) => store.putResult(wrap(n, R), NOW));
      expect(store.takeDropped(R, NOW)).toEqual({ count: 2, since: NOW - 999, until: NOW - 998 });
      expect(store.takeDropped(R, NOW)).toBeUndefined();
    });

    it("🔴 讀收件匣時已經在庫裡的（送到過了），之後被擠掉不算", () => {
      const store = make({ maxPerRecipient: 3, countDrops: true });
      range(1, 3).forEach((n) => store.putResult(wrap(n, R), NOW));
      expect(store.takeDropped(R, NOW)).toBeUndefined(); // 讀收件匣：1–3 都送到了
      range(4, 8).forEach((n) => store.putResult(wrap(n, R), NOW)); // 擠掉 1–5：1–3 送到過、4、5 還沒
      expect(store.takeDropped(R, NOW)).toEqual({ count: 2, since: NOW - 996, until: NOW - 995 });
      // 這次讀收件匣時 6–8 在庫裡 ⇒ 之後被擠掉也不算
      range(9, 11).forEach((n) => store.putResult(wrap(n, R), NOW));
      expect(store.takeDropped(R, NOW)).toBeUndefined();
    });

    it("收件人正在線上收收件匣（即時收到了）：被擠掉不算", () => {
      const store = make({ maxPerRecipient: 1, countDrops: true });
      let online = true;
      store.setInboxProbe((r) => online && r === R);
      range(1, 3).forEach((n) => store.putResult(wrap(n, R), NOW));
      online = false;
      store.markDelivered(R, NOW);
      store.putResult(wrap(4, R), NOW); // 擠掉 3（斷線前就送到了）
      expect(store.takeDropped(R, NOW)).toBeUndefined();
    });

    it("markDelivered 只推進水位線、不清掉已經累計的", () => {
      const store = make({ maxPerRecipient: 1, countDrops: true });
      range(1, 2).forEach((n) => store.putResult(wrap(n, R), NOW));
      store.markDelivered(R, NOW);
      store.putResult(wrap(3, R), NOW); // 擠掉 2（水位線以前）⇒ 不算
      expect(store.takeDropped(R, NOW)).toEqual({ count: 1, since: NOW - 999, until: NOW - 999 });
    });

    it("借用到期、天花板淘汰都算；一般的保存期到期不算", () => {
      const store = make({ offlineMaxTotalBytes: 2 * ROW, overflowRatio: 1, borrowPerKeyBytes: 2 * ROW, countDrops: true });
      store.putResult(wrap(1, R, NOW + 10), NOW);
      store.putResult(wrap(2, key("8")), NOW);
      expect(store.putResult(wrap(3, R), NOW)).toEqual({ ok: true, borrowedTtlSec: BORROW_TTL_SECONDS });
      store.prune(NOW + BORROW_TTL_SECONDS); // 1 是一般到期（不算）、3 是借用到期（算）
      expect(store.takeDropped(R, NOW + BORROW_TTL_SECONDS)).toEqual({ count: 1, since: NOW - 997, until: NOW - 997 });
      const lane = make({ offlineMaxTotalBytes: 2 * ROW, ceilingEvicts: true, countDrops: true });
      range(1, 3).forEach((n) => lane.putResult(wrap(n, R), NOW));
      expect(lane.takeDropped(R, NOW)).toEqual({ count: 1, since: NOW - 999, until: NOW - 999 });
    });

    it("沒開 countDrops：不計、不寫任何東西（v0.33 行為）", () => {
      const store = make({ maxPerRecipient: 1 });
      range(1, 3).forEach((n) => store.putResult(wrap(n, R), NOW));
      expect(store.takeDropped(R, NOW)).toBeUndefined();
    });

    it("NIP-62 清除連丟棄計數一起刪", () => {
      const store = make({ maxPerRecipient: 1, countDrops: true });
      range(1, 3).forEach((n) => store.putResult(wrap(n, R), NOW));
      store.vanish(R, NOW);
      expect(store.takeDropped(R, NOW)).toBeUndefined();
    });
  });
}

describe("SqlMessageStore：丟棄計數表有上限、只留一個保存期", () => {
  it("收件人超過上限時刪最久沒更新的；沒開 countDrops 時表是空的", () => {
    const { store, db } = sqlStore({ countDrops: true });
    for (let i = 0; i <= DROPPED_RECIPIENTS_MAX; i += 1) store.takeDropped(hex(i + 1), NOW + i);
    const rows = db.prepare("SELECT COUNT(*) AS n, MIN(updated_at) AS oldest FROM inbox_drops").get() as { n: number; oldest: number };
    expect(rows.n).toBe(DROPPED_RECIPIENTS_MAX);
    expect(rows.oldest).toBe(NOW + 1);
    store.prune(NOW + 8 * 86_400 + 5000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM inbox_drops").get() as { n: number }).n).toBeLessThan(DROPPED_RECIPIENTS_MAX);

    const off = sqlStore({ maxPerRecipient: 1 });
    range(1, 3).forEach((n) => off.store.putResult(wrap(n, L), NOW));
    off.store.takeDropped(L, NOW);
    off.store.markDelivered(L, NOW);
    expect((off.db.prepare("SELECT COUNT(*) AS n FROM inbox_drops").get() as { n: number }).n).toBe(0);
  });

  it("借用與正常列在同一張表：borrowed 欄與部分索引只收借用列", () => {
    const { store, db } = sqlStore({ offlineMaxTotalBytes: ROW, overflowRatio: 1, borrowPerKeyBytes: ROW });
    store.putResult(wrap(1, L), NOW);
    store.putResult(wrap(2, H), NOW);
    const rows = db.prepare("SELECT id, borrowed, expiration FROM offline_msgs ORDER BY id").all() as {
      id: string;
      borrowed: number;
      expiration: number;
    }[];
    expect(rows.map((r) => [r.id, r.borrowed])).toEqual([
      [hex(1), 0],
      [hex(2), 1],
    ]);
    expect(rows[1]!.expiration).toBe(NOW + BORROW_TTL_SECONDS);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT COALESCE(SUM(bytes), 0) FROM offline_msgs WHERE borrowed = 1").all();
    expect(JSON.stringify(plan)).toContain("idx_offline_borrowed");
  });
});
