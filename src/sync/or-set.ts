// 泛用 OR-Set＋墓碑（ADR-0242 階段①）：多設備「可增可刪集合」的交換律合併。
//
// 把 ADR-0224 資產庫的「LWW＋墓碑」機制**一般化**，供聯絡人／群組／封鎖清單共用一套 CRDT
// 積木（Fix-First：延伸已驗證的機制、不各自重造合併規則）。語意：
//   - 加入即成員（帶加入/更新時間 `at`）；移除留**墓碑**（帶刪除時間）。
//   - 合併時：某 key 的元素 `at` **嚴格大於**其墓碑 `at` → 存活（含「重加自動復活」）並丟棄該墓碑；
//     否則出局、保留墓碑（刪除傳得出去、蓋過過期的新增）。平手＝刪除優先。
//   - 全純函式、交換律（多台任意順序合併結果一致）；墓碑無限累積以 `tombstoneMax` 收斂。

/** OR-Set 墓碑：`key`＝元素鍵、`at`＝刪除時間（毫秒）。與 ADR-0224 資產墓碑同構。 */
export interface OrSetTombstone {
  key: string;
  at: number;
}

/** 墓碑保留上限（顆）；超過取新到舊前 N。裝置最長離線期內不得回收，否則久離線裝置漏掉刪除。 */
export const OR_SET_TOMBSTONE_MAX = 256;

/**
 * 墓碑時間保留窗（毫秒）：預設 90 天。超過此窗的墓碑可回收（時間 GC）。
 * **必須 ≥ 裝置合理最長離線期**——否則一台久未上線的裝置回來時，刪除的墓碑已被 GC，
 * 它帶著舊的（未刪）版本合併就會讓刪掉的東西**復活**。90 天涵蓋絕大多數「抽屜裡的第二台」情境。
 */
export const OR_SET_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** 丟棄早於 `olderThan`（毫秒）的墓碑（時間 GC）；`olderThan` 通常＝`now - 保留窗`。純函式。 */
export function pruneTombstonesByTime(tombstones: OrSetTombstone[], olderThan: number): OrSetTombstone[] {
  return tombstones.filter((t) => t.at >= olderThan);
}

/** 取多組墓碑中每個 key 的最新（最大 `at`）。 */
function latestByKey(lists: OrSetTombstone[][]): Map<string, number> {
  const m = new Map<string, number>();
  for (const list of lists) {
    for (const t of list) {
      const prev = m.get(t.key);
      if (prev === undefined || t.at > prev) m.set(t.key, t.at);
    }
  }
  return m;
}

export interface MergeOrSetOpts<T> {
  /** 元素去重鍵（聯絡人＝pubkey、群組＝id、封鎖＝pubkey）。 */
  keyOf: (item: T) => string;
  /** 加入/更新時間（毫秒；缺＝0 最舊，同 ADR-0224）。 */
  atOf: (item: T) => number;
  /** 同 key 兩版內容擇一；預設 `at` 大者勝、平手用 key 字典序（交換律）。 */
  pick?: (a: T, b: T) => T;
  /** 存活集合上限；超過從尾端（`at` 最小的非保護者）淘汰。未設＝不限。 */
  max?: number;
  /** 墓碑保留上限（顆）；預設 {@link OR_SET_TOMBSTONE_MAX}。 */
  tombstoneMax?: number;
  /** 受保護元素（如自建/自己）永不因 `max` 淘汰。 */
  protect?: (item: T) => boolean;
}

/**
 * 合併兩端的 OR-Set（元素＋墓碑），回傳存活元素與清理後的墓碑。純函式、交換律、不變更輸入。
 */
export function mergeOrSet<T>(
  local: T[],
  remote: T[],
  localTombstones: OrSetTombstone[],
  remoteTombstones: OrSetTombstone[],
  opts: MergeOrSetOpts<T>,
): { items: T[]; tombstones: OrSetTombstone[] } {
  const { keyOf, atOf } = opts;
  const tombstoneMax = opts.tombstoneMax ?? OR_SET_TOMBSTONE_MAX;
  const protect = opts.protect ?? ((): boolean => false);
  const pick =
    opts.pick ??
    ((a: T, b: T): T => {
      const da = atOf(a);
      const db = atOf(b);
      if (da !== db) return da > db ? a : b;
      return keyOf(a) <= keyOf(b) ? a : b; // 平手用 key 字典序＝內容中立，保證交換律
    });

  // 1) 併元素：每個 key 取 pick 勝出版本；記首見序供穩定輸出。
  const mergedByKey = new Map<string, T>();
  const order: string[] = [];
  for (const it of [...local, ...remote]) {
    const k = keyOf(it);
    const existing = mergedByKey.get(k);
    if (existing === undefined) {
      order.push(k);
      mergedByKey.set(k, it);
    } else {
      mergedByKey.set(k, pick(it, existing));
    }
  }

  // 2) 墓碑：每 key 取最新 at。
  const tombAt = latestByKey([localTombstones, remoteTombstones]);

  // 3) 存活判定＋墓碑清理：元素 at 嚴格大於墓碑 at → 存活並丟棄墓碑；否則出局、留墓碑。
  const survivors: T[] = [];
  for (const k of order) {
    const it = mergedByKey.get(k);
    if (it === undefined) continue;
    const t = tombAt.get(k);
    if (t !== undefined && atOf(it) <= t) continue; // 出局（墓碑勝平手＝刪除優先）
    if (t !== undefined) tombAt.delete(k); // 復活：丟棄過時墓碑
    survivors.push(it);
  }

  // 4) 排序（at 新到舊；平手用 key 字典序＝內容中立）＋ max 淘汰（protect 永不淘汰）。
  survivors.sort((x, y) => atOf(y) - atOf(x) || (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0));
  let items = survivors;
  if (opts.max !== undefined) {
    while (items.length > opts.max) {
      let idx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it !== undefined && !protect(it)) {
          idx = i;
          break;
        }
      }
      if (idx === -1) break; // 全受保護：不淘汰
      items = items.filter((_, i) => i !== idx);
    }
  }

  // 5) 墓碑輸出：新到舊、取前 tombstoneMax。
  const tombstones = [...tombAt.entries()]
    .map(([key, at]) => ({ key, at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, tombstoneMax);

  return { items, tombstones };
}

/** 單筆墓碑形狀是否合法（快照/外部來源逐筆過濾用）。 */
export function isWellFormedOrSetTombstone(x: unknown): x is OrSetTombstone {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return typeof t.key === "string" && typeof t.at === "number";
}
