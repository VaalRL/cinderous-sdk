import { describe, expect, it } from "vitest";
import {
  APP_LANE_SHARDS,
  appLaneName,
  namedLaneName,
  LEGACY_GLOBAL_NAME,
  messageShardName,
  PRESENCE_LAYER_NAME,
  routeForPath,
  shardPath,
  shardPrefix,
} from "../../src/relay/shard.js";

/** 只取 DO 名；認不得的路徑會是 undefined，交由個別測試斷言。 */
const doOf = (path: string) => routeForPath(path)?.doName;

describe("分片路由計算（ADR-0241）", () => {
  it("shardPrefix：取 pubkey 高 nibble（16 片）", () => {
    expect(shardPrefix("ab".repeat(32))).toBe("a");
    expect(shardPrefix("00" + "ff".repeat(31))).toBe("0");
    expect(shardPrefix("F0".repeat(32))).toBe("f"); // 大寫正規化
  });

  it("shardPrefix：非法/空 → '0'（安全預設、不丟事件）", () => {
    expect(shardPrefix(undefined)).toBe("0");
    expect(shardPrefix("")).toBe("0");
    expect(shardPrefix("zz")).toBe("0"); // 非 hex
  });

  it("messageShardName / shardPath：由收件人 pubkey 直接算（免 hint）", () => {
    const pk = "3c".repeat(32);
    expect(messageShardName(pk)).toBe("shard-3");
    expect(shardPath(pk)).toBe("/s/3");
  });

  it("收件匣天然同片：同一 pubkey 的訊息片與訂閱片一致", () => {
    const me = "d4".repeat(32);
    // 我的訊息 #p:我 → shard(我)；我訂閱 #p:我 也連 shard(我)
    expect(messageShardName(me)).toBe(`shard-${shardPrefix(me)}`);
    expect(doOf(shardPath(me))).toBe(messageShardName(me));
  });

  describe("routeForPath：worker 依路徑選 DO 與政策（ADR-0366）", () => {
    it("/s/<prefix> → 訊息片（嚴格）", () => {
      expect(routeForPath("/s/a")).toEqual({ profile: "strict", doName: "shard-a" });
      expect(doOf("/s/0/")).toBe("shard-0"); // 容忍尾斜線
      expect(doOf("/s/F")).toBe("shard-f"); // 大寫正規化
    });

    it("/presence → presence 層（嚴格）", () => {
      expect(routeForPath("/presence")).toEqual({ profile: "strict", doName: PRESENCE_LAYER_NAME });
      expect(doOf("/presence/")).toBe(PRESENCE_LAYER_NAME);
    });

    it("/ → 舊全域（嚴格）：ADR-0241 的遷移回退仍在，舊客戶端不能被鎖在門外", () => {
      expect(routeForPath("/")).toEqual({ profile: "strict", doName: LEGACY_GLOBAL_NAME });
      expect(routeForPath("")).toEqual({ profile: "strict", doName: LEGACY_GLOBAL_NAME });
    });

    it("🔴 認不得的路徑一律拒絕——**不再**靜默落進舊全域", () => {
      // 這四條原本都回 LEGACY_GLOBAL_NAME。收掉 catch-all 的理由見 shard.ts 的註解：
      // 有預設值就會有「算錯分片卻靜默被接受」，而往哪個方向預設都有代價。
      expect(routeForPath("/s/zz")).toBeUndefined(); // 非 hex
      expect(routeForPath("/s/ab")).toBeUndefined(); // 多字元非單 nibble
      expect(routeForPath("/nope")).toBeUndefined();
      expect(routeForPath("/app")).toBeUndefined(); // 少了車道 id
    });

    it("/app/<laneId> → 第三方車道（寬鬆）", () => {
      const route = routeForPath("/app/elementalist");
      expect(route?.profile).toBe("app");
      expect(route).toMatchObject({ laneId: "elementalist" });
      expect(route?.doName).toBe(appLaneName("elementalist"));
      expect(doOf("/app/nagd/")).toBe(appLaneName("nagd")); // 容忍尾斜線
      expect(routeForPath("/app/LWD")).toMatchObject({ laneId: "lwd" }); // 小寫正規化
    });

    it("名單上的車道走自己的 DO；不在名單上的照常服務，只是共用雜湊分片（ADR-0366 §裁示）", () => {
      const known = new Set(["lwd", "elementalist"]);
      const mine = routeForPath("/app/lwd", known);
      expect(mine).toMatchObject({ profile: "app", laneId: "lwd", known: true });
      expect(mine?.doName).toBe(namedLaneName("lwd"));
      // 🔴 名單**不是門禁**：沒列的照樣連得上，這座站同時是公用 relay
      const stranger = routeForPath("/app/someoneelse", known);
      expect(stranger).toMatchObject({ profile: "app", laneId: "someoneelse", known: false });
      expect(stranger?.doName).toBe(appLaneName("someoneelse"));
      // 沒有名單＝全部共用分片（今日行為）
      expect(routeForPath("/app/lwd")?.doName).toBe(appLaneName("lwd"));
    });

    it("🔴 具名車道的 DO 名撞不到雜湊分片，也撞不到嚴格平面", () => {
      // 車道 id 不含冒號（LANE_ID 的形狀），所以 `app:<id>` 這個命名空間是乾淨的。
      // 若具名車道叫 `app-<id>`，一條叫做 "3" 的車道就會與分片 3 共用 DO。
      expect(namedLaneName("3")).not.toBe("app-3");
      for (let i = 0; i < APP_LANE_SHARDS; i++) {
        expect(namedLaneName(String(i))).not.toBe(`app-${i}`);
      }
      expect(namedLaneName("lwd")).not.toBe(LEGACY_GLOBAL_NAME);
    });

    it("車道 id 形狀不合法即拒絕（不清乾淨後放行——那會讓兩個字串映到同一條車道）", () => {
      expect(routeForPath("/app/has space")).toBeUndefined();
      expect(routeForPath("/app/-leading")).toBeUndefined(); // 須英數起頭
      expect(routeForPath("/app/a/b")).toBeUndefined(); // 路徑分隔不是車道 id
      expect(routeForPath(`/app/${"x".repeat(65)}`)).toBeUndefined(); // 超長
    });

    it("車道分片數有上界——亂數字串生不出無限顆冷 DO", () => {
      const names = new Set(
        Array.from({ length: 500 }, (_, i) => appLaneName(`lane${i}`)),
      );
      expect(names.size).toBeLessThanOrEqual(APP_LANE_SHARDS);
      for (const n of names) expect(n).toMatch(/^app-[0-7]$/);
    });

    it("車道雜湊是確定性的（同 id 恆為同一顆 DO）", () => {
      expect(appLaneName("elementalist")).toBe(appLaneName("elementalist"));
    });

    it("🔴 第三方車道與嚴格平面的 DO 名不可能相撞", () => {
      // 這是「寬鬆規則必須落在物理上不同的 DO」的最後一道保險。
      const strict = ["shard-a", "shard-0", PRESENCE_LAYER_NAME, LEGACY_GLOBAL_NAME];
      for (let i = 0; i < APP_LANE_SHARDS; i++) {
        expect(strict).not.toContain(`app-${i}`);
      }
    });
  });
});
