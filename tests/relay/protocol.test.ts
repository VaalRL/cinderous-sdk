import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey } from "../../src/protocol/index.js";
import { parseClientMessage } from "../../src/relay/protocol.js";

const evt = finalizeEvent(
  { kind: 20000, created_at: 1700000000, tags: [], content: "" },
  generateSecretKey(),
);

describe("Nostr 客戶端訊息解析", () => {
  it("解析 EVENT", () => {
    const msg = parseClientMessage(JSON.stringify(["EVENT", evt]));
    expect(msg).toEqual({ type: "EVENT", event: evt });
  });

  it("解析 REQ（含多個 filter）", () => {
    const raw = JSON.stringify(["REQ", "sub1", { kinds: [20000] }, { authors: ["ab"] }]);
    expect(parseClientMessage(raw)).toEqual({
      type: "REQ",
      subId: "sub1",
      filters: [{ kinds: [20000] }, { authors: ["ab"] }],
    });
  });

  it("REQ 無 filter 時預設為單一空 filter", () => {
    const msg = parseClientMessage(JSON.stringify(["REQ", "sub1"]));
    expect(msg).toEqual({ type: "REQ", subId: "sub1", filters: [{}] });
  });

  it("解析 CLOSE", () => {
    expect(parseClientMessage(JSON.stringify(["CLOSE", "sub1"]))).toEqual({
      type: "CLOSE",
      subId: "sub1",
    });
  });

  it("非法 JSON 或未知類型回傳 INVALID", () => {
    expect(parseClientMessage("not json").type).toBe("INVALID");
    expect(parseClientMessage(JSON.stringify(["FOO"])).type).toBe("INVALID");
    expect(parseClientMessage(JSON.stringify("x")).type).toBe("INVALID");
  });
});

// ADR-0235 C1：事件結構驗證。簽章只保證「這串 JSON 是這把金鑰簽的」，**不保證欄位型別**
// ——攻擊者可自行對 `tags` 為物件/字串/null 的結構算 hash 並簽名，`verifyEvent` 會通過，
// 隨後 `event.tags.find(...)` 拋 TypeError 打掛整座中繼。故解析層即擋下非法形狀。
describe("事件結構驗證（ADR-0235 C1）", () => {
  const withField = (field: string, value: unknown): string =>
    JSON.stringify(["EVENT", { ...evt, [field]: value }]);

  it("tags 非陣列 → INVALID（物件／字串／null／缺省）", () => {
    for (const bad of [{ a: 1 }, "tags", null, undefined]) {
      expect(parseClientMessage(withField("tags", bad)).type).toBe("INVALID");
    }
  });

  it("tags 內含非陣列元素 → INVALID", () => {
    expect(parseClientMessage(withField("tags", [["p", "ab"], "oops"])).type).toBe("INVALID");
    expect(parseClientMessage(withField("tags", [null])).type).toBe("INVALID");
  });

  it("tag 內含非字串元素 → INVALID", () => {
    expect(parseClientMessage(withField("tags", [["p", 123]])).type).toBe("INVALID");
  });

  it("kind／created_at 非數字 → INVALID", () => {
    expect(parseClientMessage(withField("kind", "20000")).type).toBe("INVALID");
    expect(parseClientMessage(withField("created_at", null)).type).toBe("INVALID");
    expect(parseClientMessage(withField("kind", Number.NaN)).type).toBe("INVALID");
  });

  it("content／id／pubkey／sig 非字串 → INVALID", () => {
    for (const field of ["content", "id", "pubkey", "sig"]) {
      expect(parseClientMessage(withField(field, 1)).type).toBe("INVALID");
    }
  });

  it("合法事件（空 tags 與有 tags）照常通過", () => {
    expect(parseClientMessage(JSON.stringify(["EVENT", evt])).type).toBe("EVENT");
    expect(parseClientMessage(withField("tags", [["p", "ab"], ["expiration", "1"]])).type).toBe("EVENT");
  });

  it("AUTH 事件走同一套結構驗證", () => {
    expect(parseClientMessage(JSON.stringify(["AUTH", { ...evt, tags: {} }])).type).toBe("INVALID");
    expect(parseClientMessage(JSON.stringify(["AUTH", evt])).type).toBe("AUTH");
  });

  it("REQ 的 filter 非物件 → INVALID（陣列／字串／null 皆非法）", () => {
    expect(parseClientMessage(JSON.stringify(["REQ", "s", "nope"])).type).toBe("INVALID");
    expect(parseClientMessage(JSON.stringify(["REQ", "s", [1, 2]])).type).toBe("INVALID");
    expect(parseClientMessage(JSON.stringify(["REQ", "s", null])).type).toBe("INVALID");
  });
});
