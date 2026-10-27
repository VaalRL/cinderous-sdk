import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { buildSnapshotEvent, buildSnapshotPurge, openSnapshotEvent, SNAPSHOT_KIND, SNAPSHOT_TTL_SECONDS } from "../../src/sync/snapshot.js";

const sk = generateSecretKey();

describe("加密雲端快照事件（ADR-0071）", () => {
  it("往返：加密給自己、d 與 expiration 正確、只有本人解得開", () => {
    const evt = buildSnapshotEvent("{\"v\":1,\"祕密\":true}", sk, "dev1", { now: 1000 });
    expect(evt.kind).toBe(SNAPSHOT_KIND);
    expect(evt.pubkey).toBe(getPublicKey(sk));
    expect(evt.tags).toContainEqual(["d", "dev1"]);
    expect(evt.tags).toContainEqual(["expiration", String(1000 + SNAPSHOT_TTL_SECONDS)]);
    expect(evt.content).not.toContain("祕密"); // relay 只見密文
    expect(openSnapshotEvent(evt, sk)).toBe("{\"v\":1,\"祕密\":true}");
    expect(openSnapshotEvent(evt, generateSecretKey())).toBeNull(); // 他人解不開
  });

  it("purge 事件：content 空、openSnapshotEvent 回 null（不誤當內容）", () => {
    const purge = buildSnapshotPurge(sk, "dev1", { now: 1000 });
    expect(purge.kind).toBe(SNAPSHOT_KIND);
    expect(purge.content).toBe("");
    expect(purge.tags).toContainEqual(["d", "dev1"]);
    expect(openSnapshotEvent(purge, sk)).toBeNull();
  });
});
