import { describe, expect, it } from "vitest";
import { generateSecretKey } from "../../src/protocol/keys.js";
import {
  buildDeviceDirectory,
  DEVICE_DIRECTORY_KIND,
  DEVICE_DIRECTORY_MAX,
  directoryConflict,
  inDirectory,
  readDeviceDirectory,
  withDevice,
  withoutDevice,
  deviceIdInDirectory,
  classifyDirectory,
  incomingWins,
} from "../../src/protocol/device-directory.js";

const sk = generateSecretKey();
const dev = (n: string, at = 1): { pk: string; at: number } => ({ pk: n.repeat(64).slice(0, 64), at });

describe("裝置目錄事件（ADR-0322 S1）", () => {
  it("build → read 往返；kind 正確、可取代（無 d tag）", () => {
    const dir = { v: 1, devices: [dev("a"), { ...dev("b", 2), label: "手機" }] };
    const ev = buildDeviceDirectory(sk, dir, { now: 100 });
    expect(ev.kind).toBe(DEVICE_DIRECTORY_KIND);
    expect(ev.tags).toEqual([]);
    expect(readDeviceDirectory(ev, sk)).toEqual(dir);
  });

  it("🔴 內容加密給自己：中繼與公眾**數不出基數**", () => {
    const ev = buildDeviceDirectory(sk, { v: 1, devices: [dev("a"), dev("b"), dev("c")] }, { now: 1 });
    expect(ev.content).not.toContain("aaaa"); // 密文裡看不到裝置公鑰
    expect(ev.content).not.toContain("devices");
    expect(readDeviceDirectory(ev, generateSecretKey())).toBeNull(); // 別人解不開
  });

  it("不信任網路來源：壞簽章／錯 kind／別人的／畸形內容一律 null", () => {
    const ev = buildDeviceDirectory(sk, { v: 1, devices: [dev("a")] }, { now: 1 });
    expect(readDeviceDirectory({ ...ev, sig: "00".repeat(32) }, sk)).toBeNull();
    expect(readDeviceDirectory({ ...ev, kind: 1 }, sk)).toBeNull();
    expect(readDeviceDirectory({ ...ev, content: "not-encrypted" }, sk)).toBeNull();
    const other = buildDeviceDirectory(generateSecretKey(), { v: 1, devices: [] }, { now: 1 });
    expect(readDeviceDirectory(other, sk)).toBeNull(); // 非自己所發
  });

  it("畸形項整筆丟棄，不做「盡量修好」", () => {
    for (const bad of [
      { v: -1, devices: [] },
      { v: 1.5, devices: [] },
      { v: 1, devices: [{ pk: "zz", at: 1 }] }, // 非法 pk
      { v: 1, devices: [{ pk: dev("a").pk }] }, // 缺 at
      { v: 1, devices: [dev("a"), dev("a")] }, // 重複 pk
      { v: 1, devices: [{ ...dev("a"), label: "x".repeat(41) }] }, // 標籤超長
    ]) {
      const ev = buildDeviceDirectory(sk, bad as never, { now: 1 });
      expect(readDeviceDirectory(ev, sk)).toBeNull();
    }
  });
});

describe("withDevice（純函式）", () => {
  it("加入即 bump 版本；已在其中＝冪等、不無謂 bump", () => {
    const a = withDevice(null, dev("a"));
    expect(a).toEqual({ v: 1, devices: [dev("a")] });
    expect(withDevice(a, dev("a"))).toBe(a); // 同一個物件＝完全沒動
    expect(withDevice(a, dev("b")).v).toBe(2);
  });

  it("超過上限時不加（回原目錄，由呼叫端決定要不要提示）", () => {
    let dir = { v: 0, devices: [] as { pk: string; at: number }[] };
    for (let i = 0; i < DEVICE_DIRECTORY_MAX; i++) {
      dir = withDevice(dir, { pk: i.toString(16).padStart(64, "0"), at: 1 });
    }
    expect(dir.devices).toHaveLength(DEVICE_DIRECTORY_MAX);
    expect(withDevice(dir, dev("f"))).toBe(dir);
  });

  it("inDirectory", () => {
    expect(inDirectory(withDevice(null, dev("a")), dev("a").pk)).toBe(true);
    expect(inDirectory(null, dev("a").pk)).toBe(false);
  });
});

describe("directoryConflict（S4 語意於 2026-08-03 修正）", () => {
  const a = { v: 2, devices: [dev("a")] };

  it("🔴 同版本、內容不同**不再**算 conflict——判不出是加還是減，誤報會製造假警報", () => {
    expect(directoryConflict(a, { v: 2, devices: [dev("b")] })).toBe(false);
  });

  it("🔴 版本倒退才是 conflict", () => {
    expect(directoryConflict(a, { v: 1, devices: [dev("a")] })).toBe(true);
  });

  it("正常前進不是衝突；順序不同不算不同（交換律）", () => {
    expect(directoryConflict(a, { v: 3, devices: [dev("a"), dev("b")] })).toBe(false);
    expect(directoryConflict(a, { v: 2, devices: [dev("a")] })).toBe(false);
    const two = { v: 5, devices: [dev("a"), dev("b")] };
    expect(directoryConflict(two, { v: 5, devices: [dev("b"), dev("a")] })).toBe(false);
  });

  it("本機還沒有目錄時，收到任何一份都不算衝突", () => {
    expect(directoryConflict(null, { v: 9, devices: [] })).toBe(false);
  });
});

describe("🔴 分歧判定不得受欄位順序影響（S1 整合測試抓到的 bug）", () => {
  it("同內容、不同屬性插入順序 → **不是**分歧（否則自己發的目錄回流就會誤報）", () => {
    const inMemory = { v: 1, devices: [{ pk: dev("a").pk, id: "d1", at: 5 }] }; // withDevice 建的順序
    const roundTripped = { v: 1, devices: [{ pk: dev("a").pk, at: 5, id: "d1" }] }; // parseDirectory 建的順序
    expect(classifyDirectory(inMemory, roundTripped).kind).toBe("none"); // 完全相同 ⇒ 不是分歧
  });

  it("內容真的不同時分類為 concurrent（不是 none，也不是 conflict）", () => {
    const a = { v: 1, devices: [{ pk: dev("a").pk, id: "d1", at: 5 }] };
    expect(classifyDirectory(a, { v: 1, devices: [{ pk: dev("b").pk, id: "d2", at: 5 }] }).kind).toBe("concurrent");
  });
});

describe("deviceIdInDirectory 三態（E：無法證明 ≠ 不在目錄）", () => {
  const withId = { v: 1, devices: [{ pk: dev("a").pk, id: "d1", at: 1 }] };
  const noId = { v: 1, devices: [{ pk: dev("a").pk, at: 1 }] };

  it("目錄未建立＝未知", () => {
    expect(deviceIdInDirectory(null, "d1")).toBeNull();
  });

  it("找到＝true", () => {
    expect(deviceIdInDirectory(withId, "d1")).toBe(true);
  });

  it("🔴 找不到但目錄有項目沒帶 id ⇒ **未知**（不得誤報一台合法登記過的裝置）", () => {
    expect(deviceIdInDirectory(noId, "d9")).toBeNull();
  });

  it("找不到且每項都帶 id ⇒ 這才是可證的 false", () => {
    expect(deviceIdInDirectory(withId, "d9")).toBe(false);
  });
});

describe("withoutDevice（S3 移除）", () => {
  it("移除即 bump 版本；不在其中＝冪等", () => {
    const two = withDevice(withDevice(null, dev("a")), dev("b"));
    const out = withoutDevice(two, dev("a").pk);
    expect(out.devices.map((d) => d.pk)).toEqual([dev("b").pk]);
    expect(out.v).toBe(three(two.v));
    expect(withoutDevice(out, dev("a").pk)).toBe(out);
  });
});
const three = (n: number): number => n + 1;

describe("分歧分類（ADR-0322 S4／S5）：同版本判不出方向，故不合併、改決勝", () => {
  const A = { pk: dev("a").pk, at: 1 };
  const B = { pk: dev("b").pk, at: 2 };
  const C = { pk: dev("c").pk, at: 3 };

  it("🔴 同版本、集合不同 → concurrent（**不合併**——合併等於讓自我登記從另一扇門回來）", () => {
    expect(classifyDirectory({ v: 1, devices: [A, B] }, { v: 1, devices: [A, C] }).kind).toBe("concurrent");
    expect(classifyDirectory({ v: 2, devices: [A, B] }, { v: 2, devices: [A] }).kind).toBe("concurrent");
  });

  it("🔴 版本倒退才是 conflict（那不含糊：只可能來自重放或倒退）", () => {
    expect(classifyDirectory({ v: 3, devices: [A] }, { v: 1, devices: [A] })).toEqual({
      kind: "conflict",
      reason: "rollback",
    });
  });

  it("正常前進、內容相同、本機無目錄 → none", () => {
    expect(classifyDirectory({ v: 1, devices: [A] }, { v: 2, devices: [A, B] }).kind).toBe("none");
    expect(classifyDirectory({ v: 1, devices: [A] }, { v: 1, devices: [A] }).kind).toBe("none");
    expect(classifyDirectory(null, { v: 9, devices: [] }).kind).toBe("none");
  });
});

describe("incomingWins（ADR-0099 §2 的既有決勝規則，不另發明）", () => {
  it("created_at 較新者勝", () => {
    expect(incomingWins({ created_at: 10, id: "a" }, { created_at: 11, id: "z" })).toBe(true);
    expect(incomingWins({ created_at: 11, id: "z" }, { created_at: 10, id: "a" })).toBe(false);
  });

  it("同時則 id 字典序較小者勝（交換律：兩邊算出同一個勝方）", () => {
    const x = { created_at: 5, id: "aaa" };
    const y = { created_at: 5, id: "bbb" };
    expect(incomingWins(x, y)).toBe(false);
    expect(incomingWins(y, x)).toBe(true);
  });

  it("本機還沒有目錄 → 收到的勝出", () => {
    expect(incomingWins(null, { created_at: 1, id: "z" })).toBe(true);
  });
});
