// RelayCore 的宿主擴充點（SDK ADR 0049 §7、C′ R1）：`intercept`（宿主接手某些事件）與 `publishLocal`（宿主自己產生的事件）。
// 沒有設定時行為逐則相同——既有的 relay-core 測試照跑；這裡只驗新增的兩個入口。
import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, type NostrEvent } from "../../src/protocol/index.js";
import { MessageStore } from "../../src/relay/message-store.js";
import { RelayCore, type Outbound } from "../../src/relay/relay-core.js";

const NOW = 1_760_000_000;
const REQ = (sub: string, filter: object) => JSON.stringify(["REQ", sub, filter]);
const EVENT = (e: NostrEvent) => JSON.stringify(["EVENT", e]);
const ev = (kind: number, tags: string[][] = [], sk = generateSecretKey()) =>
  finalizeEvent({ kind, created_at: NOW, tags, content: "x" }, sk);

describe("RelayCore intercept（宿主接手）", () => {
  it("回傳陣列＝宿主處理：不扇出、不寫庫，回傳的訊息原樣送出", () => {
    const seen: string[] = [];
    const core = new RelayCore({
      now: () => NOW,
      intercept: (connId, event) => {
        seen.push(`${connId}:${event.kind}`);
        return event.kind === 25170 ? [{ to: connId, message: ["OK", event.id, true, "handled"] }] : undefined;
      },
    });
    core.connect("phone");
    core.connect("watcher");
    core.handle("watcher", REQ("s", { kinds: [25170, 20000] }));
    const cmd = ev(25170);
    expect(core.handle("phone", EVENT(cmd))).toEqual([{ to: "phone", message: ["OK", cmd.id, true, "handled"] }]);
    // undefined＝照常扇出
    const beat = ev(20000);
    const out = core.handle("phone", EVENT(beat));
    expect(out.map((o) => o.to)).toEqual(["phone", "watcher"]);
    expect(seen).toEqual(["phone:25170", "phone:20000"]);
  });

  it("在驗簽、kind 政策與速率限制之後才呼叫（壞簽章、停用的 kind 到不了宿主）", () => {
    let calls = 0;
    const core = new RelayCore({ now: () => NOW, allowedKinds: [25170], intercept: () => (calls++, []) });
    core.connect("c");
    const bad = { ...ev(25170), sig: "00".repeat(64) };
    expect(core.handle("c", EVENT(bad))[0]!.message[2]).toBe(false);
    expect(core.handle("c", EVENT(ev(25172)))[0]!.message[2]).toBe(false);
    expect(calls).toBe(0);
    core.handle("c", EVENT(ev(25170)));
    expect(calls).toBe(1);
  });

  it("把認證身分交給宿主（requireAuth 站：ACL 以認證身分或事件作者判斷）", () => {
    const got: (string | undefined)[] = [];
    const core = new RelayCore({ now: () => NOW, intercept: (_c, _e, authed) => (got.push(authed), []) });
    core.connect("c");
    core.handle("c", EVENT(ev(25170)));
    expect(got).toEqual([undefined]);
  });
});

describe("RelayCore publishLocal（宿主自己產生的事件）", () => {
  it("扇出給符合的訂閱；ephemeral 不寫庫", () => {
    const store = new MessageStore();
    const core = new RelayCore({ now: () => NOW, store });
    core.connect("a");
    core.connect("b");
    core.handle("a", REQ("s", { kinds: [25172], "#h": ["home1"] }));
    core.handle("b", REQ("s", { kinds: [25172], "#h": ["other"] }));
    const state = ev(25172, [["h", "home1"]]);
    const out: Outbound[] = core.publishLocal(state);
    expect(out).toEqual([{ to: "a", message: ["EVENT", "s", state] }]);
  });

  it("可尋址事件照取代語意寫庫，之後的 REQ 讀得到最新一顆", () => {
    const store = new MessageStore();
    const core = new RelayCore({ now: () => NOW, store });
    const sk = generateSecretKey();
    const older = finalizeEvent({ kind: 31170, created_at: NOW - 10, tags: [["d", "dev1"], ["h", "home1"]], content: "old" }, sk);
    const newer = finalizeEvent({ kind: 31170, created_at: NOW, tags: [["d", "dev1"], ["h", "home1"]], content: "new" }, sk);
    core.publishLocal(older);
    core.publishLocal(newer);
    core.connect("r");
    const out = core.handle("r", REQ("q", { kinds: [31170], "#h": ["home1"] }));
    const events = out.filter((o) => o.message[0] === "EVENT").map((o) => (o.message[2] as NostrEvent).content);
    expect(events).toEqual(["new"]);
  });
});
