import { describe, expect, it } from "vitest";
import { DeviceSyncState, type SyncDelta } from "../../src/sync/sync.js";

const msg = (id: string) => ({ id });

describe("多設備增量同步對帳", () => {
  it("訊息以 id 去重", () => {
    const d = new DeviceSyncState();
    d.apply({ messages: [msg("a"), msg("b")] });
    d.apply({ messages: [msg("b"), msg("c")] });
    expect(d.messageIds().sort()).toEqual(["a", "b", "c"]);
  });

  it("可變狀態採 last-writer-wins（較新 updatedAt 勝）", () => {
    const d = new DeviceSyncState();
    d.apply({ state: { nickname: { value: "舊", updatedAt: 100 } } });
    d.apply({ state: { nickname: { value: "新", updatedAt: 200 } } });
    expect(d.get("nickname")).toBe("新");
    // 較舊的更新不應覆蓋
    d.apply({ state: { nickname: { value: "更舊", updatedAt: 50 } } });
    expect(d.get("nickname")).toBe("新");
  });

  it("不同套用順序最終收斂一致（commutative）", () => {
    const deltaA: SyncDelta = {
      messages: [msg("a"), msg("b")],
      state: { read: { value: "10", updatedAt: 1 }, block: { value: "bob", updatedAt: 5 } },
    };
    const deltaB: SyncDelta = {
      messages: [msg("b"), msg("c")],
      state: { read: { value: "20", updatedAt: 9 }, block: { value: "none", updatedAt: 2 } },
    };

    const d1 = new DeviceSyncState();
    d1.apply(deltaA);
    d1.apply(deltaB);

    const d2 = new DeviceSyncState();
    d2.apply(deltaB);
    d2.apply(deltaA);

    expect(d1.messageIds().sort()).toEqual(d2.messageIds().sort());
    expect(d1.get("read")).toBe(d2.get("read"));
    expect(d1.get("block")).toBe(d2.get("block"));
    // LWW 結果：read 取 updatedAt=9 的 "20"，block 取 updatedAt=5 的 "bob"
    expect(d1.get("read")).toBe("20");
    expect(d1.get("block")).toBe("bob");
  });
});

describe("多設備同步上限（A5：防撐爆記憶體）", () => {
  it("訊息 id 超過上限時逐出最舊、保留最新", () => {
    const d = new DeviceSyncState({ maxMessages: 3 });
    d.apply({ messages: [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")] });
    expect(d.messageIds()).toEqual(["c", "d", "e"]); // a、b 被逐出
    // 被逐出的舊 id 再現會被視為新（去重窗口已滑動）——記憶體有界的取捨
    d.apply({ messages: [msg("a")] });
    expect(d.messageIds()).toEqual(["d", "e", "a"]);
  });

  it("可變狀態鍵數超過上限時逐出最舊更新者", () => {
    const d = new DeviceSyncState({ maxStateKeys: 2 });
    d.apply({ state: { k1: { value: "1", updatedAt: 10 } } });
    d.apply({ state: { k2: { value: "2", updatedAt: 20 } } });
    d.apply({ state: { k3: { value: "3", updatedAt: 30 } } }); // 逐出 k1（updatedAt 最舊）
    expect(d.get("k1")).toBeUndefined();
    expect(d.get("k2")).toBe("2");
    expect(d.get("k3")).toBe("3");
  });

  it("既有鍵的更新不觸發逐出（不算新增）", () => {
    const d = new DeviceSyncState({ maxStateKeys: 1 });
    d.apply({ state: { k1: { value: "a", updatedAt: 1 } } });
    d.apply({ state: { k1: { value: "b", updatedAt: 2 } } });
    expect(d.get("k1")).toBe("b");
  });
});
