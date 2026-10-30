// 主平面的反覆重連限速，DO 那一道（SDK ADR 0111；Cinderous ADR-0391）：記憶體裡的長窗口計數，不寫儲存。
import { describe, expect, it } from "vitest";
import { DEFAULT_RECONNECT_GUARD, ReconnectGuard, reconnectGuardFrom } from "../../src/relay/reconnect-guard.js";

const MIN = 60_000;

function guard(opts: Partial<{ max: number; windowMs: number; blockMs: number; maxKeys: number }> = {}) {
  let now = 1_000_000;
  const g = new ReconnectGuard({ max: 3, windowMs: 10 * MIN, blockMs: 10 * MIN, maxKeys: 100, now: () => now, ...opts });
  return { g, tick: (ms: number) => (now += ms) };
}

describe("ReconnectGuard", () => {
  it("🔴 沒認證就斷線的連線（SDK ADR 0131）：窗口內滿了就擋；擋住期間一律擋；期滿放行、重新計數", () => {
    const { g, tick } = guard();
    for (let i = 0; i < 3; i += 1) {
      expect(g.admit("1.2.3.4")).toBe(true);
      g.unauthenticated("1.2.3.4");
    }
    expect(g.admit("1.2.3.4")).toBe(false);
    tick(10 * MIN - 1);
    expect(g.admit("1.2.3.4")).toBe(false);
    tick(1);
    expect(g.admit("1.2.3.4")).toBe(true);
  });

  it("🔴 認證過的連線不算進那一道：共用 IP 後面很多人一起重連，不會被當成濫用（SDK ADR 0131）", () => {
    const { g } = guard();
    for (let i = 0; i < 9; i += 1) expect(g.admit("office"), String(i)).toBe(true);
  });

  it("所有升級另有一個總上限（預設 3 倍）：拿拋棄式金鑰認證也繞不過去", () => {
    const { g } = guard();
    for (let i = 0; i < 9; i += 1) g.admit("a");
    expect(g.admit("a")).toBe(false);
  });

  it("滑動窗口：舊的不算", () => {
    const { g, tick } = guard();
    g.admit("a");
    g.unauthenticated("a");
    g.admit("a");
    g.unauthenticated("a");
    tick(10 * MIN);
    g.admit("a");
    g.unauthenticated("a");
    expect(g.admit("a")).toBe(true);
    g.unauthenticated("a");
    expect(g.admit("a")).toBe(true);
    g.unauthenticated("a");
    expect(g.admit("a")).toBe(false);
  });

  it("🔴 不同 IP 各自計數——一個濫用者不會擋到別人", () => {
    const { g } = guard();
    for (let i = 0; i < 3; i += 1) {
      g.admit("bad");
      g.unauthenticated("bad");
    }
    expect(g.admit("bad")).toBe(false);
    expect(g.admit("good")).toBe(true);
  });

  it("🔴 記憶體有上限：滿了先丟最舊的 IP", () => {
    const { g } = guard({ maxKeys: 2 });
    g.admit("a");
    g.admit("b");
    g.admit("c");
    expect(g.size).toBe(2);
    expect(g.has("a")).toBe(false);
    expect(g.has("c")).toBe(true);
  });
});

describe("reconnectGuardFrom（RECONNECT_GUARD）", () => {
  it("未設＝預設 20 次／10 分鐘、擋 10 分鐘；off＝關掉", () => {
    expect(reconnectGuardFrom(undefined)).toEqual(DEFAULT_RECONNECT_GUARD);
    expect(DEFAULT_RECONNECT_GUARD).toEqual({ max: 20, windowMs: 600_000, blockMs: 600_000, maxTotal: 60 });
    expect(reconnectGuardFrom("off")).toBeNull();
    expect(reconnectGuardFrom(" OFF ")).toBeNull();
  });

  it("次數/窗口秒/封鎖秒；格式不對退回預設（不會因為打錯字而關掉防護）", () => {
    expect(reconnectGuardFrom("30/300/120")).toEqual({ max: 30, windowMs: 300_000, blockMs: 120_000, maxTotal: 90 });
    // 第四欄＝所有升級的總上限（SDK ADR 0131）；不能比第一欄小
    expect(reconnectGuardFrom("20/600/600/100")).toEqual({ max: 20, windowMs: 600_000, blockMs: 600_000, maxTotal: 100 });
    for (const bad of ["", "abc", "0/600/600", "20/0/600", "20/600", "-1/600/600", "1.5/600/600", "20/600/600/10", "20/600/600/0/1"]) {
      expect(reconnectGuardFrom(bad), bad).toEqual(DEFAULT_RECONNECT_GUARD);
    }
  });
});
