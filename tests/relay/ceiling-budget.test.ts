// 每顆 DO 的天花板（Cinderous ADR-0377 移植）與帳號儲存預算（SDK ADR 0042）。
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STORAGE_BUDGET_BYTES,
  ceilingClassOf,
  computeCeilingBudget,
  DEFAULT_DO_CEILINGS,
  doCapacityFor,
  doCapacitySettings,
  doCeilingFor,
  doCeilings,
  MIB,
  storeOptions,
  worstCaseStorage,
} from "../../src/relay/host-config.js";
import { allDoNames, routeForPath } from "../../src/relay/shard.js";

/** Cinderous 錨點 relay/wrangler.toml（origin/main 22e3860c，ADR-0377）的四個變數——逐字 */
const ANCHOR = {
  APP_LANES: "lwd,elementalist,nagd,soleague,dochost,cindersync,cinder-coffice",
  MAX_FILE_MB: "30",
  FILE_LANES: "cindersync,cinder-coffice",
  DO_CEILINGS_MIB:
    "strict=24/24,global=64/64,presence=16/16,shard-a=96/64,shard-1=96/64,shard-f=96/64,shard-7=96/64,public=16/16,lane=32/32,app:dochost=64/512,file=512/32",
};

describe("allDoNames：路由會建立的每一顆 DO（Cinderous ADR-0377）", () => {
  it("路由出來的 DO 名都在清單上，清單上每一顆也真的有路徑打得到", () => {
    const known = new Set(["lwd", "dochost"]);
    const names = new Set(allDoNames(known));
    const hit = new Set<string>();
    const paths = ["/", "/presence", ...Array.from({ length: 16 }, (_, i) => `/s/${i.toString(16)}`), "/app/lwd", "/app/dochost"];
    for (let i = 0; i < 2000; i += 1) paths.push(`/app/lane${i}`);
    for (const p of paths) {
      const route = routeForPath(p, known)!;
      expect(names.has(route.doName), p).toBe(true);
      hit.add(route.doName);
    }
    expect([...names].sort()).toEqual([...hit].sort());
    expect(names.size).toBe(1 + 1 + 16 + 8 + 2);
  });
});

describe("DO_CEILINGS_MIB（Cinderous ADR-0377 逐字移植）", () => {
  it("沒設＝與以前相同（128/128 MiB、檔案車道離線 1 GiB），storeOptions 不帶容量＝v0.33 的物件", () => {
    expect(doCeilingFor({}, "shard-a")).toEqual(DEFAULT_DO_CEILINGS.strict);
    expect(doCeilingFor(ANCHOR as never, "app:cindersync").offlineMaxBytes).toBe(512 * MIB);
    expect(doCeilingFor({ ...ANCHOR, DO_CEILINGS_MIB: undefined }, "app:cindersync")).toEqual(DEFAULT_DO_CEILINGS.file);
    // 只給天花板（Cinderous 的簽名）：只換兩個數字，不多出任何欄位
    expect(storeOptions(undefined, "strict", false, undefined, doCeilingFor({}, "global"))).toEqual(storeOptions(undefined));
  });
  it("單顆 DO 名優先於類別、類別優先於預設；類別由 DO 名決定", () => {
    expect(ceilingClassOf(ANCHOR, "global")).toBe("strict");
    expect(ceilingClassOf(ANCHOR, "app-3")).toBe("public");
    expect(ceilingClassOf(ANCHOR, "app:lwd")).toBe("lane");
    expect(ceilingClassOf(ANCHOR, "app:cindersync")).toBe("file");
    expect(doCeilingFor(ANCHOR, "shard-a")).toEqual({ offlineMaxBytes: 96 * MIB, addressableMaxBytes: 64 * MIB });
    expect(doCeilingFor(ANCHOR, "shard-b")).toEqual({ offlineMaxBytes: 24 * MIB, addressableMaxBytes: 24 * MIB });
    expect(doCeilingFor(ANCHOR, "app:dochost").addressableMaxBytes).toBe(512 * MIB);
  });
  it("設錯的項目不生效、列在 ignored", () => {
    const bad = doCeilings({ APP_LANES: "lwd", DO_CEILINGS_MIB: "shard-z=1/1,app:nope=1/1,strict=0/1,lane=9000/1,lane=1/1,lane=2/2,oops" });
    expect(bad.ignored).toEqual(["shard-z=1/1", "app:nope=1/1", "strict=0/1", "lane=9000/1", "lane=2/2", "oops"]);
    expect([...bad.entries.keys()]).toEqual(["lane"]);
  });
});

describe("🔴 帳號儲存預算（computeCeilingBudget；SDK ADR 0042）", () => {
  it("Cinderous 錨點的設定：與 ADR-0377 的表逐位元相同（3552 MiB＝3,724,541,952 bytes）、在預算內、還能加 4 條車道", () => {
    const b = computeCeilingBudget(ANCHOR);
    expect(b.ignored).toEqual([]);
    expect(b.rows).toHaveLength(33);
    expect(b.totalBytes).toBe(3_724_541_952);
    expect(b.withinBudget).toBe(true);
    expect(b.laneCostBytes).toBe(64 * MIB);
    expect(b.lanesLeft).toBe(4);
    expect(b.budgetBytes).toBe(ACCOUNT_STORAGE_BUDGET_BYTES);
  });
  it("沒設天花板：預設值本身就超過免費額度（ADR 0039 研究結果一）——工具要說出來", () => {
    const b = computeCeilingBudget({ APP_LANES: ANCHOR.APP_LANES, FILE_LANES: ANCHOR.FILE_LANES, MAX_FILE_MB: "30" });
    expect(b.totalBytes).toBe(10 * 1024 * MIB);
    expect(b.withinBudget).toBe(false);
    expect(b.lanesLeft).toBe(0);
  });
  it("溢位帶算進最壞量：嚴格平面只算離線那一側；淘汰制沒有保底時不算（帶子不生效）", () => {
    const strict = worstCaseStorage({ ...ANCHOR, DO_BORROW_PERCENT: "strict=25" });
    const base = worstCaseStorage(ANCHOR);
    // 18 顆嚴格 DO 的離線天花板 × 25%
    const offline = allDoNames(new Set()).filter((n) => ceilingClassOf(ANCHOR, n) === "strict").reduce((s, n) => s + doCeilingFor(ANCHOR, n).offlineMaxBytes, 0);
    expect(strict.totalBytes - base.totalBytes).toBe(offline / 4);
    expect(worstCaseStorage({ ...ANCHOR, DO_BORROW_PERCENT: "lane=25" }).totalBytes).toBe(base.totalBytes);
    const lane = worstCaseStorage({ ...ANCHOR, DO_BORROW_PERCENT: "lane=25", DO_GUARANTEE_KIB: "lane=2048" });
    expect(lane.totalBytes - base.totalBytes).toBe(5 * 64 * MIB / 4 + (576 - 64) * MIB / 4); // 4 條 lane＋dochost
    expect(lane.laneCostBytes).toBe(80 * MIB);
    // 錨點若照 ADR 0042 的建議開溢位帶：仍在預算內
    expect(computeCeilingBudget({ ...ANCHOR, DO_BORROW_PERCENT: "strict=25" }).withinBudget).toBe(true);
  });
  it("自己的預算（付費方案）", () => {
    expect(computeCeilingBudget({}, 20 * 1024 * MIB).withinBudget).toBe(true);
  });
});

describe("容量設定（DO_GUARANTEE_KIB／DO_BORROW_PERCENT／DO_NEAR_FULL_PERCENT／DO_DROP_NOTICES）", () => {
  const env = {
    ...ANCHOR,
    DO_GUARANTEE_KIB: "lane=2048,app:dochost=4096,strict=100,global=100",
    DO_BORROW_PERCENT: "strict=25,app:dochost=50",
    DO_NEAR_FULL_PERCENT: "lane=80,strict=49",
    DO_DROP_NOTICES: "strict,app:nope",
  };
  it("保底只能設在淘汰制；範圍外、對象不存在的不生效", () => {
    expect(doCapacitySettings(env).ignored).toEqual([
      "DO_GUARANTEE_KIB: strict=100",
      "DO_GUARANTEE_KIB: global=100",
      "DO_NEAR_FULL_PERCENT: strict=49",
      "DO_DROP_NOTICES: app:nope",
    ]);
  });
  it("逐顆 DO 解析：單顆優先於類別", () => {
    expect(doCapacityFor(env, "app:dochost")).toMatchObject({ guaranteeBytes: 4096 * 1024, overflowRatio: 0.5, nearFullPercent: 80 });
    expect(doCapacityFor(env, "app:lwd")).toMatchObject({ guaranteeBytes: 2048 * 1024, nearFullPercent: 80 });
    expect(doCapacityFor(env, "app:lwd").overflowRatio).toBeUndefined();
    expect(doCapacityFor(env, "shard-a")).toMatchObject({ overflowRatio: 0.25, countDrops: true });
    expect(doCapacityFor(env, "shard-a").guaranteeBytes).toBeUndefined();
  });
  it("storeOptions：嚴格平面開溢位帶時可尋址不借用、保底不帶進拒收制", () => {
    const strict = storeOptions(undefined, "strict", false, undefined, doCapacityFor(env, "shard-a"));
    expect(strict).toMatchObject({ overflowRatio: 0.25, addressableBorrows: false, countDrops: true });
    expect(strict.guaranteeBytes).toBeUndefined();
    const lane = storeOptions(undefined, "app", true, undefined, doCapacityFor(env, "app:dochost"));
    expect(lane).toMatchObject({ ceilingEvicts: true, guaranteeBytes: 4096 * 1024, overflowRatio: 0.5, addressableMaxTotalBytes: 512 * MIB });
    expect(lane.addressableBorrows).toBeUndefined();
  });
});
