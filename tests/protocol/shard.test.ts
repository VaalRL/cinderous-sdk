import { describe, expect, it } from "vitest";
import { PRESENCE_PATH, SHARD_COUNT, shardPath, shardPrefix } from "../../src/protocol/shard.js";

// 分片計算的 SSOT（ADR-0241）：client 與 server 共用，必須一致。

describe("shardPrefix（收件人 pubkey 高 nibble，ADR-0241）", () => {
  it("取第一個 hex nibble（16 片）", () => {
    expect(SHARD_COUNT).toBe(16);
    expect(shardPrefix("ab".repeat(32))).toBe("a");
    expect(shardPrefix("0" + "f".repeat(63))).toBe("0");
    expect(shardPrefix("F0".repeat(32))).toBe("f"); // 大寫正規化
  });

  it("非法/空 → '0'（安全預設、不丟事件）", () => {
    expect(shardPrefix(undefined)).toBe("0");
    expect(shardPrefix("")).toBe("0");
    expect(shardPrefix("zz")).toBe("0");
  });
});

describe("shardPath / PRESENCE_PATH（client 連線路徑，ADR-0241）", () => {
  it("shardPath＝/s/<prefix>；同一 pubkey 的自己片與收件片一致", () => {
    const pk = "3c".repeat(32);
    expect(shardPath(pk)).toBe("/s/3");
    expect(shardPath(pk)).toBe(`/s/${shardPrefix(pk)}`);
  });
  it("PRESENCE_PATH＝/presence", () => {
    expect(PRESENCE_PATH).toBe("/presence");
  });
});
