// 診斷「沒認證就斷線」的連線（SDK ADR 0111；Cinderous ADR-0392）：只記動詞、kind、存活秒數、關閉碼；不記內容、公鑰、IP。
import { describe, expect, it } from "vitest";
import { UnauthDiag, unauthDiagEnabled } from "../../src/relay/unauth-diag.js";

describe("UnauthDiag", () => {
  it("🔴 沒認證就斷線：一行摘要，含動詞序列、訂閱的 kind、中繼的回覆、存活秒數、關閉碼", () => {
    let now = 1_000;
    const d = new UnauthDiag({ now: () => now });
    d.open("c1");
    d.inbound("c1", JSON.stringify(["REQ", "sub1", { kinds: [10050, 0], authors: ["ab"] }, { kinds: [1] }]));
    d.outbound("c1", ["CLOSED", "sub1", "auth-required: 請先完成 NIP-42 認證"]);
    d.inbound("c1", JSON.stringify(["CLOSE", "sub1"]));
    now += 2_400;
    const line = d.close("c1", 1006);
    expect(line).toBe("unauth-diag in=REQ,CLOSE kinds=0,1,10050 out=CLOSED:auth-required alive=2.4s code=1006");
  });

  it("🔴 認證過的連線不記（正常使用者看不到任何紀錄）", () => {
    const d = new UnauthDiag({ now: () => 0 });
    d.open("c1");
    d.inbound("c1", JSON.stringify(["AUTH", { kind: 22242 }]));
    d.authed("c1");
    expect(d.close("c1", 1000)).toBeNull();
  });

  it("🔴 不記內容、公鑰、IP：EVENT 的內容與 filter 的 authors 都不會出現", () => {
    const d = new UnauthDiag({ now: () => 0 });
    d.open("c1");
    d.inbound("c1", JSON.stringify(["EVENT", { kind: 1059, pubkey: "deadbeef", content: "secret" }]));
    d.inbound("c1", JSON.stringify(["REQ", "s", { authors: ["cafebabe"], "#p": ["f00d"] }]));
    d.outbound("c1", ["OK", "id", false, "auth-required: x"]);
    const line = d.close("c1", 1006) ?? "";
    expect(line).toContain("in=EVENT,REQ");
    expect(line).toContain("out=OK:auth-required");
    for (const secret of ["deadbeef", "secret", "cafebabe", "f00d", "1059"]) expect(line).not.toContain(secret);
  });

  it("壞掉的訊息記成 ?；沒開過的連線關閉回 null；記憶體有上限", () => {
    const d = new UnauthDiag({ now: () => 0, maxConns: 2 });
    d.open("a");
    d.inbound("a", "not json");
    expect(d.close("a", 1006)).toContain("in=?");
    expect(d.close("nope", 1006)).toBeNull();
    d.open("x");
    d.open("y");
    d.open("z");
    expect(d.size).toBe(2);
  });

  it("只有 DIAG_UNAUTH_LOG=1 才開（預設關）", () => {
    expect(unauthDiagEnabled(undefined)).toBe(false);
    expect(unauthDiagEnabled("0")).toBe(false);
    expect(unauthDiagEnabled("1")).toBe(true);
  });
});
