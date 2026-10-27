import { describe, expect, it } from "vitest";
import { mergeOrSet, type OrSetTombstone, pruneTombstonesByTime } from "../../src/sync/or-set.js";

// OR-Set＋墓碑（ADR-0242 階段①）：泛用「可增可刪集合」的交換律合併，複用 ADR-0224 資產墓碑機制。
// 用一個最小元素型別（key＋at＋payload）驗證核心語意。

interface Item {
  k: string;
  at: number;
  v?: string;
}
const opts = {
  keyOf: (i: Item) => i.k,
  atOf: (i: Item) => i.at,
};
const merge = (l: Item[], r: Item[], lt: OrSetTombstone[] = [], rt: OrSetTombstone[] = []) =>
  mergeOrSet(l, r, lt, rt, opts);
const keys = (items: Item[]) => items.map((i) => i.k).sort();

describe("mergeOrSet（OR-Set＋墓碑，ADR-0242）", () => {
  it("聯集：兩端各有的元素都保留", () => {
    const { items } = merge([{ k: "a", at: 1 }], [{ k: "b", at: 1 }]);
    expect(keys(items)).toEqual(["a", "b"]);
  });

  it("刪除傳播：一端刪（墓碑 at 較新）→ 另一端仍有也出局", () => {
    // 本地仍有 a（at:1），遠端把 a 刪了（墓碑 at:2）→ a 出局。
    const { items, tombstones } = merge([{ k: "a", at: 1 }], [], [], [{ key: "a", at: 2 }]);
    expect(keys(items)).toEqual([]);
    expect(tombstones).toEqual([{ key: "a", at: 2 }]); // 墓碑保留（繼續傳播刪除）
  });

  it("重加復活：刪除後又加入（元素 at 嚴格大於墓碑）→ 復活並丟棄過時墓碑", () => {
    const { items, tombstones } = merge([{ k: "a", at: 3 }], [], [], [{ key: "a", at: 2 }]);
    expect(keys(items)).toEqual(["a"]);
    expect(tombstones).toEqual([]); // 復活 → 過時墓碑清掉
  });

  it("平手（元素 at == 墓碑 at）→ 刪除優先（墓碑勝平手）", () => {
    const { items } = merge([{ k: "a", at: 2 }], [], [], [{ key: "a", at: 2 }]);
    expect(keys(items)).toEqual([]);
  });

  it("解封語意（G-Set→OR-Set）：一端解封（墓碑）→ 聯集不再把它加回", () => {
    // 舊「聯集」語意下 a 會永遠留著；OR-Set 下遠端的解封墓碑（at:5）蓋過本地的封鎖（at:1）。
    const { items } = merge([{ k: "a", at: 1 }], [{ k: "a", at: 1 }], [], [{ key: "a", at: 5 }]);
    expect(keys(items)).toEqual([]);
  });

  it("交換律：merge(A,B) 與 merge(B,A) 的存活集合與墓碑一致", () => {
    const A: Item[] = [{ k: "a", at: 3 }, { k: "c", at: 1 }];
    const B: Item[] = [{ k: "b", at: 2 }];
    const At: OrSetTombstone[] = [{ key: "b", at: 1 }]; // A 認為 b 於 at:1 被刪（但 B 的 b 是 at:2 → 復活）
    const Bt: OrSetTombstone[] = [{ key: "c", at: 4 }]; // B 認為 c 於 at:4 被刪（蓋過 A 的 c at:1 → 出局）
    const ab = mergeOrSet(A, B, At, Bt, opts);
    const ba = mergeOrSet(B, A, Bt, At, opts);
    expect(keys(ab.items)).toEqual(keys(ba.items));
    expect(keys(ab.items)).toEqual(["a", "b"]); // c 出局、b 復活
    const norm = (t: OrSetTombstone[]) => [...t].sort((x, y) => (x.key < y.key ? -1 : 1));
    expect(norm(ab.tombstones)).toEqual(norm(ba.tombstones));
    expect(norm(ab.tombstones)).toEqual([{ key: "c", at: 4 }]); // 只剩 c 的墓碑（b 復活丟棄）
  });

  it("冪等：與自己合併不變（同集合、空墓碑）", () => {
    const S: Item[] = [{ k: "a", at: 1 }, { k: "b", at: 2 }];
    const { items } = mergeOrSet(S, S, [], [], opts);
    expect(keys(items)).toEqual(["a", "b"]);
  });

  it("同 key 取較新內容（pick 預設：at 大者勝）", () => {
    const { items } = merge([{ k: "a", at: 1, v: "old" }], [{ k: "a", at: 2, v: "new" }]);
    expect(items).toEqual([{ k: "a", at: 2, v: "new" }]);
  });

  it("protect：max 淘汰時受保護者永不淘汰", () => {
    const items = [
      { k: "keep", at: 1 },
      { k: "x", at: 5 },
      { k: "y", at: 4 },
    ];
    const { items: out } = mergeOrSet(items, [], [], [], { ...opts, max: 2, protect: (i) => i.k === "keep" });
    expect(out.map((i) => i.k).sort()).toEqual(["keep", "x"]); // y 被淘汰（at 最小的非保護）、keep 留著
  });

  it("墓碑 GC：超過 tombstoneMax 取新到舊前 N", () => {
    const tombs: OrSetTombstone[] = [
      { key: "t1", at: 1 },
      { key: "t2", at: 3 },
      { key: "t3", at: 2 },
    ];
    const { tombstones } = mergeOrSet([], [], tombs, [], { ...opts, tombstoneMax: 2 });
    expect(tombstones).toEqual([
      { key: "t2", at: 3 },
      { key: "t3", at: 2 },
    ]);
  });
});

describe("pruneTombstonesByTime（時間 GC，ADR-0242）", () => {
  it("丟棄早於門檻的墓碑、保留門檻（含）之後的", () => {
    const tombs: OrSetTombstone[] = [
      { key: "old", at: 100 },
      { key: "edge", at: 200 },
      { key: "fresh", at: 300 },
    ];
    expect(pruneTombstonesByTime(tombs, 200).map((t) => t.key)).toEqual(["edge", "fresh"]);
  });
  it("門檻極早 → 全保留（保留窗夠長時不誤刪，久離線裝置的刪除不丟）", () => {
    const tombs: OrSetTombstone[] = [{ key: "a", at: 100 }];
    expect(pruneTombstonesByTime(tombs, 0)).toEqual(tombs);
  });
});
