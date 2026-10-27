import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildAuthEvent,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  TIMESTAMP_JITTER_SECONDS,
  type NostrEvent,
} from "../../src/protocol/index.js";
import { MAX_QUERY_BYTES, MessageStore, type MessageStoreOptions, type OfflineStore } from "../../src/relay/message-store.js";
import { SqlMessageStore } from "../../src/relay/sql-message-store.js";
import type { RelayFilter } from "../../src/relay/protocol.js";
import { EXPIRED_REJECT, leadingZeroBits, OFFLINE_CEILING_REJECT, RelayCore } from "../../src/relay/relay-core.js";
import { minePow } from "../../src/protocol/index.js";
import { guardFor } from "../../src/relay/host-config.js";

function heartbeat(): NostrEvent {
  return finalizeEvent(
    { kind: 20000, created_at: 1700000000, tags: [], content: "" },
    generateSecretKey(),
  );
}

const REQ = (sub: string, filter: object) => JSON.stringify(["REQ", sub, filter]);
const EVENT = (e: NostrEvent) => JSON.stringify(["EVENT", e]);

describe("RelayCore — 訂閱與 Ephemeral 轉發", () => {
  it("REQ 立即回 EOSE（M1 無歷史事件）", () => {
    const core = new RelayCore();
    core.connect("c1");
    const out = core.handle("c1", REQ("s1", { kinds: [20000] }));
    expect(out).toEqual([{ to: "c1", message: ["EOSE", "s1"] }]);
  });

  it("心跳事件扇出給符合 filter 的其他連線，並回 OK 給發送者", () => {
    const core = new RelayCore();
    core.connect("sender");
    core.connect("watcher");
    core.handle("watcher", REQ("s1", { kinds: [20000] }));

    const e = heartbeat();
    const out = core.handle("sender", EVENT(e));

    expect(out).toContainEqual({ to: "sender", message: ["OK", e.id, true, ""] });
    expect(out).toContainEqual({ to: "watcher", message: ["EVENT", "s1", e] });
  });

  it("不符 filter（kinds 不同）不轉發", () => {
    const core = new RelayCore();
    core.connect("watcher");
    core.handle("watcher", REQ("s1", { kinds: [1] }));
    const out = core.handle("sender", EVENT(heartbeat()));
    expect(out.some((o) => o.to === "watcher")).toBe(false);
  });

  it("簽章無效的事件回 OK=false 且不轉發", () => {
    const core = new RelayCore();
    core.connect("watcher");
    core.handle("watcher", REQ("s1", { kinds: [20000] }));
    const e = heartbeat();
    const out = core.handle("sender", EVENT({ ...e, content: "tampered" }));
    expect(out).toEqual([
      { to: "sender", message: ["OK", e.id, false, "invalid: bad-signature: 簽章驗證失敗"] },
    ]);
  });

  it("Ephemeral（20000-29999）絕不寫入持久層", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store, now: () => 0 });
    core.connect("sender");
    core.handle("sender", EVENT(heartbeat()));
    expect(store.query({ kinds: [20000] }, 0)).toEqual([]);
  });

  it("非 Ephemeral 事件才會寫入持久層", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store, now: () => 0 });
    core.connect("sender");
    const e = finalizeEvent(
      { kind: 1, created_at: 1700000000, tags: [], content: "hi" },
      generateSecretKey(),
    );
    core.handle("sender", EVENT(e));
    expect(store.query({ kinds: [1] }, 0)).toEqual([e]);
  });

  it("REQ 會回放符合的歷史留言，最後送 EOSE", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store, now: () => 100 });
    const to = getPublicKey(generateSecretKey());
    const dm = finalizeEvent(
      { kind: 1059, created_at: 100, tags: [["p", to]], content: "x" },
      generateSecretKey(),
    );
    core.connect("sender");
    core.handle("sender", EVENT(dm));

    core.connect("reader");
    const out = core.handle("reader", REQ("s1", { kinds: [1059], "#p": [to] }));
    expect(out).toEqual([
      { to: "reader", message: ["EVENT", "s1", dm] },
      { to: "reader", message: ["EOSE", "s1"] },
    ]);
  });

  it("CLOSE 後不再收到轉發", () => {
    const core = new RelayCore();
    core.connect("watcher");
    core.handle("watcher", REQ("s1", { kinds: [20000] }));
    core.handle("watcher", JSON.stringify(["CLOSE", "s1"]));
    const out = core.handle("sender", EVENT(heartbeat()));
    expect(out.some((o) => o.to === "watcher")).toBe(false);
  });

  it("斷線會清除其訂閱", () => {
    const core = new RelayCore();
    core.connect("watcher");
    core.handle("watcher", REQ("s1", { kinds: [20000] }));
    core.disconnect("watcher");
    const out = core.handle("sender", EVENT(heartbeat()));
    expect(out.some((o) => o.to === "watcher")).toBe(false);
  });
});

describe("leadingZeroBits（NIP-13）", () => {
  it("計算 hex 開頭零位元數", () => {
    expect(leadingZeroBits("ffff")).toBe(0);
    expect(leadingZeroBits("0fff")).toBe(4);
    expect(leadingZeroBits("00ff")).toBe(8);
    expect(leadingZeroBits("1fff")).toBe(3);
    expect(leadingZeroBits("002f")).toBe(10);
  });
});

describe("RelayCore — 防濫用（C1）", () => {
  function dmEvent(target: string, createdAt: number) {
    return finalizeEvent(
      { kind: 1059, created_at: createdAt, tags: [["p", target]], content: "x" },
      generateSecretKey(),
    );
  }
  // 只算雜湊、中獎的那一輪才簽章（`minePow`）：每一輪都簽章的寫法在整套測試的負載下會超過 5 秒逾時
  function mine(target: string, difficulty: number) {
    return minePow({ kind: 1059, created_at: 0, tags: [["p", target]], content: "" }, generateSecretKey(), difficulty);
  }

  it("超過每連線訂閱數上限時拒絕新訂閱，替換既有 subId 仍可", () => {
    const core = new RelayCore({ maxSubscriptions: 1 });
    core.connect("c");
    expect(core.handle("c", REQ("s1", { kinds: [20000] }))).toContainEqual({
      to: "c",
      message: ["EOSE", "s1"],
    });
    const rejected = core.handle("c", REQ("s2", { kinds: [20000] }));
    expect(rejected[0]?.message[0]).toBe("CLOSED");
    expect(String(rejected[0]?.message[2])).toContain("上限");
    // 替換同一 subId 不算新增
    expect(core.handle("c", REQ("s1", { kinds: [1] }))).toContainEqual({
      to: "c",
      message: ["EOSE", "s1"],
    });
  });

  it("PoW 難度不足的持久化事件被拒", () => {
    const core = new RelayCore({ minPowDifficulty: 20 });
    const pk = getPublicKey(generateSecretKey());
    const out = core.handle("c", EVENT(dmEvent(pk, 1)));
    expect(out[0]?.message[0]).toBe("OK");
    expect(out[0]?.message[2]).toBe(false);
    expect(String(out[0]?.message[3])).toContain("pow");
  });

  it("PoW 達標的持久化事件被接受", () => {
    const core = new RelayCore({ minPowDifficulty: 8 });
    const pk = getPublicKey(generateSecretKey());
    const out = core.handle("c", EVENT(mine(pk, 8)));
    expect(out[0]?.message[2]).toBe(true);
  });

  it("Ephemeral 事件不受 PoW 限制", () => {
    const core = new RelayCore({ minPowDifficulty: 20 });
    const out = core.handle("c", EVENT(heartbeat()));
    expect(out[0]?.message[2]).toBe(true);
  });
});

describe("RelayCore — 時鐘偏移與重放防護（C2）", () => {
  const hb = (createdAt: number) =>
    finalizeEvent({ kind: 20000, created_at: createdAt, tags: [], content: "" }, generateSecretKey());

  it("created_at 偏離本機時鐘過大時拒收", () => {
    const core = new RelayCore({ maxClockSkewSec: 60, now: () => 1000 });
    const out = core.handle("c", EVENT(hb(5000)));
    expect(out[0]?.message[2]).toBe(false);
    expect(String(out[0]?.message[3])).toContain("時間戳");
  });

  it("時鐘窗內、唯一事件被接受", () => {
    const core = new RelayCore({ maxClockSkewSec: 60, now: () => 1000 });
    expect(core.handle("c", EVENT(hb(1000)))[0]?.message[2]).toBe(true);
  });

  it("重放相同事件被去重：OK true「duplicate:」（NIP-01；SDK ADR 0038 決策 3），不再轉發", () => {
    const core = new RelayCore({ maxClockSkewSec: 60, now: () => 1000 });
    const e = hb(1000);
    expect(core.handle("c", EVENT(e))[0]?.message[2]).toBe(true);
    const replay = core.handle("c", EVENT(e));
    expect(replay).toHaveLength(1);
    expect(replay[0]?.message[2]).toBe(true);
    expect(String(replay[0]?.message[3])).toMatch(/^duplicate: /);
  });

  it("未設定 maxClockSkewSec 時不啟用（維持原行為）", () => {
    const core = new RelayCore({ now: () => 1000 });
    const e = hb(99999);
    expect(core.handle("c", EVENT(e))[0]?.message[2]).toBe(true);
    expect(core.handle("c", EVENT(e))[0]?.message[2]).toBe(true);
  });
});

describe("RelayCore — 企業封閉模式 allowlist（ADR-0044）", () => {
  const signedHb = (sk: Uint8Array): NostrEvent =>
    finalizeEvent({ kind: 20000, created_at: 1700000000, tags: [], content: "" }, sk);

  it("名單內成員可發布並扇出；名單外成員一律拒收（含心跳）", () => {
    const memberSk = generateSecretKey();
    const outsiderSk = generateSecretKey();
    const member = getPublicKey(memberSk);
    const core = new RelayCore({ allowedAuthors: [member] });
    core.connect("watcher");
    core.handle("watcher", REQ("s1", { kinds: [20000] }));

    const good = signedHb(memberSk);
    const goodOut = core.handle("member", EVENT(good));
    expect(goodOut).toContainEqual({ to: "member", message: ["OK", good.id, true, ""] });
    expect(goodOut).toContainEqual({ to: "watcher", message: ["EVENT", "s1", good] });

    const bad = signedHb(outsiderSk);
    const badOut = core.handle("outsider", EVENT(bad));
    expect(badOut[0]?.message[2]).toBe(false);
    expect(String(badOut[0]?.message[3])).toContain("blocked");
    // 非成員的事件不扇出給任何訂閱者
    expect(badOut.some((o) => o.to === "watcher")).toBe(false);
  });

  it("未設定 allowedAuthors 時為開放中繼（維持原行為）", () => {
    const core = new RelayCore();
    const e = signedHb(generateSecretKey());
    expect(core.handle("c", EVENT(e))[0]?.message[2]).toBe(true);
  });
});

describe("RelayCore — NIP-42 AUTH（ADR-0057）", () => {
  const AUTHMSG = (e: NostrEvent) => JSON.stringify(["AUTH", e]);
  const authCore = () => new RelayCore({ requireAuth: true, authChallenge: () => "chal-1" });

  it("connect 發出 AUTH 挑戰", () => {
    expect(authCore().connect("c")).toEqual([{ to: "c", message: ["AUTH", "chal-1"] }]);
  });

  it("未認證的 REQ 被擋並重發挑戰", () => {
    const core = authCore();
    core.connect("c");
    const out = core.handle("c", REQ("s", { kinds: [1] }));
    expect(out).toContainEqual({ to: "c", message: ["CLOSED", "s", "auth-required: nip42: 請先認證（NIP-42）"] });
    expect(out).toContainEqual({ to: "c", message: ["AUTH", "chal-1"] });
  });

  it("未認證的 EVENT 被擋", () => {
    const core = authCore();
    core.connect("c");
    const e = heartbeat();
    expect(core.handle("c", EVENT(e))).toContainEqual({
      to: "c",
      message: ["OK", e.id, false, "auth-required: nip42: 請先認證（NIP-42）"],
    });
  });

  it("正確 AUTH → 認證成功，之後**具名的** REQ 通過（ADR-0123）", () => {
    const core = authCore();
    core.connect("c");
    const sk = generateSecretKey();
    const self = getPublicKey(sk);
    const authEv = buildAuthEvent("chal-1", "wss://r", sk);
    expect(core.handle("c", AUTHMSG(authEv))).toEqual([{ to: "c", message: ["OK", authEv.id, true, ""] }]);
    // 舊版這裡是 `{ kinds: [1] }`——**沒有 scope 也通過**。那正是 ADR-0123 移除的行為。
    expect(core.handle("c", REQ("s", { kinds: [1], authors: [self] }))).toContainEqual({
      to: "c",
      message: ["EOSE", "s"],
    });
  });

  it("挑戰不符的 AUTH 被拒", () => {
    const core = authCore();
    core.connect("c");
    const out = core.handle("c", AUTHMSG(buildAuthEvent("wrong", "wss://r", generateSecretKey())));
    expect(out[0]?.message[0]).toBe("OK");
    expect(out[0]?.message[2]).toBe(false);
  });

  it("#p 收件匣閘門：只能訂閱自己的 pubkey", () => {
    const core = authCore();
    core.connect("c");
    const sk = generateSecretKey();
    const self = getPublicKey(sk);
    core.handle("c", AUTHMSG(buildAuthEvent("chal-1", "wss://r", sk)));
    expect(core.handle("c", REQ("mine", { kinds: [1059], "#p": [self] }))).toContainEqual({
      to: "c",
      message: ["EOSE", "mine"],
    });
    const other = getPublicKey(generateSecretKey());
    expect(core.handle("c", REQ("other", { kinds: [1059], "#p": [other] }))).toContainEqual({
      to: "c",
      message: ["CLOSED", "other", "restricted: scope: 訂閱必須指定 #p（自己）或 authors（ADR-0123）"],
    });
  });

  it("requireAuth 關（預設）：connect 不發挑戰、免認證即可讀寫", () => {
    const core = new RelayCore();
    expect(core.connect("c")).toEqual([]);
    expect(core.handle("c", REQ("s", { kinds: [20000] }))).toEqual([{ to: "c", message: ["EOSE", "s"] }]);
  });
});

describe("RelayCore — 休眠狀態還原（ADR-0059）", () => {
  const AUTHMSG = (e: NostrEvent) => JSON.stringify(["AUTH", e]);

  it("exportConn/rehydrate：喚醒後還原認證與訂閱，扇出仍正確", () => {
    const sk = generateSecretKey();
    const self = getPublicKey(sk);
    // 原 core：認證 + 掛上收件匣訂閱
    const core1 = new RelayCore({ requireAuth: true, authChallenge: () => "c1" });
    core1.connect("c");
    core1.handle("c", AUTHMSG(buildAuthEvent("c1", "wss://r", sk)));
    core1.handle("c", REQ("inbox", { kinds: [1059], "#p": [self] }));
    const snap = core1.exportConn("c");
    expect(snap.pubkey).toBe(self);
    expect(snap.subs.map((s) => s.subId)).toEqual(["inbox"]);

    // 模擬休眠喚醒：全新 core，只 rehydrate（不重連、不重認證）
    const core2 = new RelayCore({ requireAuth: true, authChallenge: () => "c2" });
    core2.rehydrate(snap);
    // 認證已還原：具名的 REQ 不被擋 → EOSE（ADR-0123：無 scope 的 filter 一律拒絕）
    expect(core2.handle("c", REQ("probe", { kinds: [1], authors: [self] }))).toContainEqual({
      to: "c",
      message: ["EOSE", "probe"],
    });
    // 訂閱已還原：另一連線發 #p:[self] 的 1059 → 扇出給還原的 "c/inbox"
    core2.connect("pub");
    core2.handle("pub", AUTHMSG(buildAuthEvent("c2", "wss://r", generateSecretKey())));
    const pubEv = finalizeEvent({ kind: 1059, created_at: 1700000000, tags: [["p", self]], content: "x" }, generateSecretKey());
    expect(core2.handle("pub", EVENT(pubEv))).toContainEqual({ to: "c", message: ["EVENT", "inbox", pubEv] });
  });

  it("未認證連線的挑戰也隨快照還原（喚醒後仍能完成認證）", () => {
    const core1 = new RelayCore({ requireAuth: true, authChallenge: () => "chal-x" });
    core1.connect("c");
    const snap = core1.exportConn("c");
    expect(snap.challenge).toBe("chal-x");
    expect(snap.pubkey).toBeUndefined();

    const core2 = new RelayCore({ requireAuth: true, authChallenge: () => "other" });
    core2.rehydrate(snap);
    // 用還原的挑戰認證 → 成功
    const sk = generateSecretKey();
    const out = core2.handle("c", AUTHMSG(buildAuthEvent("chal-x", "wss://r", sk)));
    expect(out[0]?.message[2]).toBe(true);
  });
});

describe("RelayCore — 企業政策 allowedKinds（ADR-0048）", () => {
  const signedHb = (sk: Uint8Array): NostrEvent =>
    finalizeEvent({ kind: 20000, created_at: 1700000000, tags: [], content: "" }, sk);
  const signedKind = (sk: Uint8Array, kind: number): NostrEvent =>
    finalizeEvent({ kind, created_at: 1700000000, tags: [], content: "" }, sk);

  it("允許名單內 kind 通過、名單外拒收", () => {
    const core = new RelayCore({ allowedKinds: [20000] });
    const sk = generateSecretKey();
    expect(core.handle("c", EVENT(signedHb(sk)))[0]?.message[2]).toBe(true);
    const dropped = core.handle("c", EVENT(signedKind(sk, 21000))); // 信令 kind 被政策擋
    expect(dropped[0]?.message[2]).toBe(false);
    expect(String(dropped[0]?.message[3])).toContain("blocked");
  });

  it("未設 allowedKinds 時不限制", () => {
    const core = new RelayCore();
    expect(core.handle("c", EVENT(signedKind(generateSecretKey(), 21000)))[0]?.message[2]).toBe(true);
  });
});

describe("RelayCore — 可尋址快照（NIP-33，ADR-0071）", () => {
  const AUTHMSG = (e: NostrEvent) => JSON.stringify(["AUTH", e]);
  const snapshot = (sk: Uint8Array, opts: { d?: string; content?: string; createdAt?: number } = {}): NostrEvent =>
    finalizeEvent(
      {
        kind: 30078,
        created_at: opts.createdAt ?? 1_700_000_000,
        tags: [["d", opts.d ?? "dev1"]],
        content: opts.content ?? "密文快照",
      },
      sk,
    );

  it("NIP-17 kind 10050（content 空）：OK true 且別人以 authors 查得到——不是被當成 purge（Cinderous ADR-0382 §7；SDK ADR 0083）", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store, now: () => 1_700_000_000 });
    core.connect("c");
    const sk = generateSecretKey();
    const inbox = finalizeEvent({ kind: 10050, created_at: 1_700_000_000, tags: [["relay", "wss://a.example/s/1"]], content: "" }, sk);
    expect(core.handle("c", EVENT(inbox))).toContainEqual({ to: "c", message: ["OK", inbox.id, true, ""] });
    const got = core.handle("c", REQ("s", { kinds: [10050], authors: [getPublicKey(sk)] })).filter((o) => o.message[0] === "EVENT");
    expect(got.map((o) => (o.message[2] as NostrEvent).id)).toEqual([inbox.id]);
  });

  it("發佈→取代→purge：REQ 永遠只看到最新一顆；purge 後查無", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store, now: () => 1_700_000_000 });
    core.connect("c");
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);

    const v1 = snapshot(sk, { createdAt: 1_700_000_000, content: "v1" });
    const v2 = snapshot(sk, { createdAt: 1_700_000_100, content: "v2" });
    expect(core.handle("c", EVENT(v1))).toContainEqual({ to: "c", message: ["OK", v1.id, true, ""] });
    expect(core.handle("c", EVENT(v2))).toContainEqual({ to: "c", message: ["OK", v2.id, true, ""] });

    const replay = core.handle("c", REQ("s", { kinds: [30078], authors: [pk] }));
    const events = replay.filter((o) => o.message[0] === "EVENT");
    expect(events).toHaveLength(1);
    expect((events[0]!.message[2] as NostrEvent).content).toBe("v2");

    const purge = snapshot(sk, { createdAt: 1_700_000_200, content: "" });
    expect(core.handle("c", EVENT(purge))).toContainEqual({ to: "c", message: ["OK", purge.id, true, ""] });
    const after = core.handle("c", REQ("s2", { kinds: [30078], authors: [pk] }));
    expect(after.filter((o) => o.message[0] === "EVENT")).toHaveLength(0);
  });

  it("配額超限回 OK false「blocked: quota:」（第 6 個 d；SDK ADR 0038 P0-R2）", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store, now: () => 1_700_000_000 });
    core.connect("c");
    const sk = generateSecretKey();
    for (let i = 1; i <= 5; i++) {
      const e = snapshot(sk, { d: `dev${i}` });
      expect(core.handle("c", EVENT(e))).toContainEqual({ to: "c", message: ["OK", e.id, true, ""] });
    }
    const sixth = snapshot(sk, { d: "dev6" });
    expect(core.handle("c", EVENT(sixth))).toContainEqual({
      to: "c",
      message: ["OK", sixth.id, false, "blocked: quota: 這個作者在這個 kind 的位址數已達上限"],
    });
  });

  it("requireAuth：他人讀不到我的快照——REQ 重放與即時扇出皆閘門，本人可讀", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store, now: () => 1_700_000_000, requireAuth: true, authChallenge: () => "ch" });
    const aliceSk = generateSecretKey();
    const alicePk = getPublicKey(aliceSk);
    const bobSk = generateSecretKey();

    core.connect("alice");
    core.handle("alice", AUTHMSG(buildAuthEvent("ch", "wss://r", aliceSk)));
    core.connect("bob");
    core.handle("bob", AUTHMSG(buildAuthEvent("ch", "wss://r", bobSk)));

    // Bob 先掛萬用訂閱（會匹配任何 kind）——即時扇出不得把 Alice 的快照送給他
    core.handle("bob", REQ("spy", {}));
    const snap = snapshot(aliceSk);
    const out = core.handle("alice", EVENT(snap));
    expect(out.some((o) => o.to === "bob")).toBe(false);

    // Bob 的 REQ 重放也拿不到（即使 filter 直指 Alice）
    const replay = core.handle("bob", REQ("s", { kinds: [30078], authors: [alicePk] }));
    expect(replay.filter((o) => o.message[0] === "EVENT")).toHaveLength(0);

    // Alice 本人可讀回
    const mine = core.handle("alice", REQ("m", { kinds: [30078], authors: [alicePk] }));
    expect(mine.filter((o) => o.message[0] === "EVENT")).toHaveLength(1);
  });
});

describe("RelayCore — 可取代事件（NIP-01，ADR-0035）", () => {
  const maintainerSk = generateSecretKey();
  const maintainer = getPublicKey(maintainerSk);
  const list = (createdAt: number, content: string): NostrEvent =>
    finalizeEvent({ kind: 10037, created_at: createdAt, tags: [], content }, maintainerSk);

  it("cron 連發 relay 清單只留最新一顆；新客戶端 REQ 只收到一份（不再下載上百份重複）", () => {
    const core = new RelayCore({ store: new MessageStore() });
    core.connect("pub");
    for (let h = 0; h < 24; h += 1) core.handle("pub", JSON.stringify(["EVENT", list(1000 + h * 3600, `v${h}`)]));

    core.connect("client");
    const out = core.handle("client", JSON.stringify(["REQ", "relaylist", { kinds: [10037], authors: [maintainer] }]));
    const events = out.filter((o) => o.message[0] === "EVENT");
    expect(events.length).toBe(1); // ← 修好的行為（過去會是 24）
    expect((events[0]!.message[2] as NostrEvent).content).toBe("v23");
  });

  it("可取代事件是**公開**的：不像快照被限制只回作者本人（清單必須人人收得到）", () => {
    const core = new RelayCore({ store: new MessageStore() });
    core.connect("pub");
    core.connect("sub");
    // 別人先訂閱，維護者才發佈 → 即時扇出應送達訂閱者（非作者）。
    core.handle("sub", JSON.stringify(["REQ", "rl", { kinds: [10037] }]));
    const out = core.handle("pub", JSON.stringify(["EVENT", list(2000, "public")]));
    expect(out.some((o) => o.to === "sub" && o.message[0] === "EVENT")).toBe(true);
  });
});

describe("訂閱必須具名（ADR-0123）", () => {
  const AUTHMSG = (e: NostrEvent) => JSON.stringify(["AUTH", e]);
  const authed = () => {
    const core = new RelayCore({ store: new MessageStore(), requireAuth: true, authChallenge: () => "chal-1" });
    core.connect("c");
    const sk = generateSecretKey();
    core.handle("c", AUTHMSG(buildAuthEvent("chal-1", "wss://r", sk)));
    return { core, self: getPublicKey(sk) };
  };
  const closed = (out: { message: unknown[] }[]) => out.some((o) => o.message[0] === "CLOSED");

  it("🔴 **`{kinds:[20000]}` 是一支消防水管**——全站心跳、狀態訊息、正在聽什麼，一次收割", () => {
    const { core } = authed();
    // 舊版：`inboxAllowed` 只檢查「有 #p 的 filter」→ `#p` 是 undefined 就直接放行。
    // 攻擊者不需要事先知道任何 pubkey——這正是質變所在。
    expect(closed(core.handle("c", REQ("firehose", { kinds: [20000] })))).toBe(true);
  });

  it("🔴 `{kinds:[1059]}`：拿不到明文，但拿得到全站收件人 p-tag ＋ 時間分布（流量分析）", () => {
    const { core } = authed();
    expect(closed(core.handle("c", REQ("ta", { kinds: [1059] })))).toBe(true);
  });

  it("完全空的 filter（要全部）也擋", () => {
    const { core } = authed();
    expect(closed(core.handle("c", REQ("all", {})))).toBe(true);
  });

  it("**一組 filter 裡只要有一個沒 scope，整個 REQ 就被拒**（不能夾帶）", () => {
    const { core, self } = authed();
    const out = core.handle("c", JSON.stringify(["REQ", "mix", { kinds: [1059], "#p": [self] }, { kinds: [20000] }]));
    expect(closed(out)).toBe(true);
  });

  it("`authors: [十萬把金鑰]` 不能拿來繞過（上限 1024）", () => {
    const { core } = authed();
    const many = Array.from({ length: 1025 }, () => getPublicKey(generateSecretKey()));
    expect(closed(core.handle("c", REQ("enum", { kinds: [20000], authors: many })))).toBe(true);
  });

  it("**合法客戶端零影響**——引擎實際送出的每一個 filter 都通過", () => {
    const { core, self } = authed();
    const me = [self];
    const contacts = [getPublicKey(generateSecretKey()), getPublicKey(generateSecretKey())];
    const out = core.handle(
      "c",
      JSON.stringify([
        "REQ",
        "all",
        { kinds: [20000], authors: contacts }, // 心跳（我的聯絡人）
        { kinds: [20001], "#p": me }, // typing
        { kinds: [20100], "#p": me }, // nudge
        { kinds: [1059], "#p": me }, // 收件匣
        { kinds: [30078], authors: me }, // 雲端快照
        { kinds: [21000], "#p": me }, // WebRTC 信令
        { kinds: [21002], "#p": me }, // 通話信令
        { kinds: [10037], authors: [getPublicKey(generateSecretKey())] }, // 維護者清單
      ]),
    );
    expect(closed(out)).toBe(false);
    expect(out).toContainEqual({ to: "c", message: ["EOSE", "all"] });
  });

  it("拒絕時**說得出原因**（沉默的空回應會讓人跑去別的地方找 bug）", () => {
    const { core } = authed();
    const out = core.handle("c", REQ("x", { kinds: [20000] }));
    expect(String(out[0]?.message[2])).toContain("authors");
  });
});

describe("ADR-0123 的邊界：`authors: []` 必須放行", () => {
  it("🔴 **還沒有任何聯絡人的新使用者**——心跳訂閱的 authors 就是空的，不能把他整個 REQ 拒掉", () => {
    const core = new RelayCore({ store: new MessageStore(), requireAuth: true, authChallenge: () => "chal-1" });
    core.connect("c");
    const sk = generateSecretKey();
    const self = getPublicKey(sk);
    core.handle("c", JSON.stringify(["AUTH", buildAuthEvent("chal-1", "wss://r", sk)]));

    // `matchFilter` 的 `!filter.authors.includes(pk)` 對空陣列恆為真 → 匹配不到任何事件。
    // 它**不是**消防水管；該擋的是 `authors` 不存在（＝不過濾作者＝全站）。
    const out = core.handle(
      "c",
      JSON.stringify(["REQ", "boot", { kinds: [20000], authors: [] }, { kinds: [1059], "#p": [self] }]),
    );
    expect(out.some((o) => o.message[0] === "CLOSED")).toBe(false);
    expect(out).toContainEqual({ to: "c", message: ["EOSE", "boot"] });
  });
});

describe("檔案塊事件（FILE_WRAP=1060，ADR-0162）", () => {
  const fileEvent = (recipient = "a".repeat(64), content = "x"): NostrEvent =>
    finalizeEvent(
      { kind: 1060, created_at: 1700000000, tags: [["p", recipient], ["expiration", "1700086400"]], content },
      generateSecretKey(),
    );

  it("預設（公共站）整類拒收：OK false、不入庫", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store });
    core.connect("c1");
    const e = fileEvent();
    const out = core.handle("c1", EVENT(e));
    expect(out).toContainEqual({ to: "c1", message: ["OK", e.id, false, "blocked: files-disabled: 檔案事件未啟用（MAX_FILE_MB）"] });
    expect(store.query({ kinds: [1060] }, 1700000001)).toEqual([]);
  });

  it("acceptFileEvents 啟用：收下入庫；單顆超過 200KB sanity 上限仍拒", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store, acceptFileEvents: true, now: () => 1_700_000_001 });
    core.connect("c1");
    const e = fileEvent();
    const out = core.handle("c1", EVENT(e));
    expect(out).toContainEqual({ to: "c1", message: ["OK", e.id, true, ""] });
    expect(store.query({ kinds: [1060] }, 1700000001).map((x) => x.id)).toEqual([e.id]);
    const huge = fileEvent("b".repeat(64), "z".repeat(210_000));
    const out2 = core.handle("c1", EVENT(huge));
    expect(out2).toContainEqual({ to: "c1", message: ["OK", huge.id, false, "blocked: too-large: 檔案塊過大"] });
  });
});

// ADR-0235 C1：例外圍籬。解析層已擋掉畸形事件，但持久層／宿主仍可能拋（磁碟滿、SQLite 錯誤、
// 未來新增的解析路徑）。`handle` 是傳輸無關核心的唯一入口，把圍籬放這裡就同時保護
// Cloudflare Worker（DO 未捕捉例外＝全站斷線）與 Node 自架站。
describe("RelayCore — 例外圍籬（ADR-0235 C1）", () => {
  const throwingStore = {
    put: () => {
      throw new TypeError("boom");
    },
    putAddressable: () => {
      throw new TypeError("boom");
    },
    query: () => {
      throw new TypeError("boom");
    },
    prune: () => {},
    vanish: () => {
      throw new TypeError("boom");
    },
  };

  it("持久層拋例外時回 NOTICE，不向宿主逸出", () => {
    const core = new RelayCore({ store: throwingStore });
    core.connect("c1");
    const e = finalizeEvent(
      { kind: 1059, created_at: 1700000000, tags: [["p", "ab"]], content: "x" },
      generateSecretKey(),
    );
    let out: ReturnType<RelayCore["handle"]> = [];
    expect(() => {
      out = core.handle("c1", EVENT(e));
    }).not.toThrow();
    expect(out).toEqual([{ to: "c1", message: ["NOTICE", "error: internal: 內部錯誤，請稍後再試"] }]);
  });

  it("查詢拋例外時同樣被攔下（REQ 路徑）", () => {
    const core = new RelayCore({ store: throwingStore });
    core.connect("c1");
    expect(() => core.handle("c1", REQ("s1", { "#p": ["ab"] }))).not.toThrow();
  });

  it("畸形事件（tags 非陣列）在解析層即被擋，回 NOTICE invalid", () => {
    const core = new RelayCore();
    core.connect("c1");
    const e = finalizeEvent({ kind: 20000, created_at: 1700000000, tags: [], content: "" }, generateSecretKey());
    const out = core.handle("c1", JSON.stringify(["EVENT", { ...e, tags: {} }]));
    expect(out).toEqual([{ to: "c1", message: ["NOTICE", "invalid: malformed: malformed event"] }]);
  });
});

// ADR-0235 C3：寫入放大防護。`recipientsOf` 回傳**所有** `p` tag，`SqlMessageStore.put` 對每個
// 收件人各 INSERT 一列、再各跑一次 `enforceCap`（SELECT + N 次 DELETE）。原本只有 kind 1060
// 有大小上限，其餘 kind 完全無界——一則 1MB 事件可塞約 15,000 個 `p` tag，換算 15,000 次
// INSERT ＋ 15,000 輪 SELECT/DELETE。客戶端外層事件一律只有 1 個 `p`（多重提及在加密 rumor
// 內層，中繼看不到），故上限可訂得很緊。
describe("RelayCore — 事件大小與 tag 上限（ADR-0235 C3）", () => {
  const sk = generateSecretKey();
  const ev = (tags: string[][], content = "x"): NostrEvent =>
    finalizeEvent({ kind: 1059, created_at: 1700000000, tags, content }, sk);

  it("p tag 數超過上限 → OK false、不入庫", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store });
    core.connect("c1");
    const e = ev(Array.from({ length: 64 }, (_, i) => ["p", `${i}`.padStart(64, "0")]));
    const out = core.handle("c1", EVENT(e));
    expect(out).toContainEqual({ to: "c1", message: ["OK", e.id, false, "blocked: too-many-recipients: 收件人數超過上限"] });
    expect(store.query({ kinds: [1059] }, 1700000001)).toEqual([]);
  });

  it("tag 總數超過上限 → OK false", () => {
    const core = new RelayCore();
    core.connect("c1");
    const e = ev(Array.from({ length: 300 }, (_, i) => ["e", `${i}`]));
    const out = core.handle("c1", EVENT(e));
    expect(out).toContainEqual({ to: "c1", message: ["OK", e.id, false, "blocked: too-many-tags: tag 數超過上限"] });
  });

  it("事件序列化超過全域大小上限 → OK false", () => {
    const core = new RelayCore();
    core.connect("c1");
    const e = ev([["p", "ab"]], "z".repeat(300_000));
    const out = core.handle("c1", EVENT(e));
    expect(out).toContainEqual({ to: "c1", message: ["OK", e.id, false, "blocked: too-large: 事件過大"] });
  });

  it("原始訊息超過上限 → NOTICE，且不進 JSON.parse", () => {
    const core = new RelayCore();
    core.connect("c1");
    const out = core.handle("c1", "x".repeat(500_000));
    expect(out).toEqual([{ to: "c1", message: ["NOTICE", "invalid: too-large: 訊息過大"] }]);
  });

  it("正常事件（1 個 p tag）不受影響", () => {
    const store = new MessageStore();
    const core = new RelayCore({ store, now: () => 1_700_000_001 });
    core.connect("c1");
    const e = ev([["p", "ab"]]);
    expect(core.handle("c1", EVENT(e))).toContainEqual({ to: "c1", message: ["OK", e.id, true, ""] });
    expect(store.query({ "#p": ["ab"] }, 1700000001).map((x) => x.id)).toEqual([e.id]);
  });
});

// ADR-0235 H1：速率限制與時鐘偏移。
//
// 產線 worker 建立 RelayCore 時只給了 `requireAuth` 與 `maxSubscriptions`：
//   - 沒有任何 per-pubkey 事件速率限制（ARCHITECTURE §5 宣稱有，程式碼裡不存在）
//   - `maxClockSkewSec` 未設 → `seenIds` 永遠是空的 → **零重放防護**
//
// 時鐘窗必須**非對稱**：NIP-59 把外層 `created_at` 隨機往前推最多 2 天（隱私設計，
// `TIMESTAMP_JITTER_SECONDS`），對稱窗會把幾乎每一則 Gift Wrap 都擋掉。
describe("RelayCore — 速率限制與時鐘窗（ADR-0235 H1）", () => {
  const sk = generateSecretKey();
  const at = (createdAt: number, kind = 20000): NostrEvent =>
    finalizeEvent({ kind, created_at: createdAt, tags: [], content: "" }, sk);
  const NOW = 1_700_000_000;

  it("超過每分鐘事件上限 → OK false rate-limited", () => {
    const core = new RelayCore({ now: () => NOW, maxEventsPerMinute: 3 });
    core.connect("c1");
    for (let i = 0; i < 3; i++) {
      const e = at(NOW - i);
      expect(core.handle("c1", EVENT(e))).toContainEqual({ to: "c1", message: ["OK", e.id, true, ""] });
    }
    const over = at(NOW - 99);
    expect(core.handle("c1", EVENT(over))).toContainEqual({
      to: "c1",
      message: ["OK", over.id, false, "rate-limited: events: 發送過於頻繁，請稍後再試"],
    });
  });

  it("配額按時間窗回補（不是永久封鎖）", () => {
    let clock = NOW;
    const core = new RelayCore({ now: () => clock, maxEventsPerMinute: 2 });
    core.connect("c1");
    core.handle("c1", EVENT(at(clock)));
    core.handle("c1", EVENT(at(clock - 1)));
    const blocked = at(clock - 2);
    expect(core.handle("c1", EVENT(blocked))[0]?.message[3]).toContain("rate-limited");
    clock += 61; // 窗過了
    const after = at(clock);
    expect(core.handle("c1", EVENT(after))).toContainEqual({ to: "c1", message: ["OK", after.id, true, ""] });
  });

  it("速率以 pubkey 計，不是以連線計——換條連線繞不過", () => {
    const core = new RelayCore({ now: () => NOW, maxEventsPerMinute: 1 });
    core.connect("c1");
    core.connect("c2");
    core.handle("c1", EVENT(at(NOW)));
    const second = at(NOW - 1);
    expect(core.handle("c2", EVENT(second))[0]?.message[3]).toContain("rate-limited");
  });

  it("未來時戳被拒（沒有合法事件會是未來的）", () => {
    const core = new RelayCore({ now: () => NOW, maxFutureSkewSec: 900 });
    core.connect("c1");
    const future = at(NOW + 901);
    expect(core.handle("c1", EVENT(future))).toContainEqual({
      to: "c1",
      message: ["OK", future.id, false, "invalid: clock-skew: 時間戳超出允許範圍"],
    });
    const ok = at(NOW + 60);
    expect(core.handle("c1", EVENT(ok))).toContainEqual({ to: "c1", message: ["OK", ok.id, true, ""] });
  });

  it("🔴 NIP-59 抖動窗內的舊時戳必須放行——否則 Gift Wrap 全掛", () => {
    const core = new RelayCore({ now: () => NOW, maxFutureSkewSec: 900, maxPastSkewSec: TIMESTAMP_JITTER_SECONDS + 3600 });
    core.connect("c1");
    // 外層時戳被往前推將近兩天：這是**正常且必要**的隱私設計。
    const jittered = at(NOW - TIMESTAMP_JITTER_SECONDS + 10, 1059);
    expect(core.handle("c1", EVENT(jittered))).toContainEqual({ to: "c1", message: ["OK", jittered.id, true, ""] });
  });

  it("遠超抖動窗的古老時戳仍被拒", () => {
    const core = new RelayCore({ now: () => NOW, maxPastSkewSec: TIMESTAMP_JITTER_SECONDS + 3600 });
    core.connect("c1");
    const ancient = at(NOW - TIMESTAMP_JITTER_SECONDS - 7200, 1059);
    expect(core.handle("c1", EVENT(ancient))[0]?.message[3]).toContain("時間戳超出允許範圍");
  });

  it("近期事件重放（同一 id 再送一次）被擋——偽造上線的主要手法", () => {
    const core = new RelayCore({ now: () => NOW, maxFutureSkewSec: 900, replayWindowSec: 3600 });
    core.connect("c1");
    const beat = at(NOW);
    expect(core.handle("c1", EVENT(beat))).toContainEqual({ to: "c1", message: ["OK", beat.id, true, ""] });
    expect(core.handle("c1", EVENT(beat))).toContainEqual({
      to: "c1",
      message: ["OK", beat.id, true, "duplicate: seen: 事件重複"],
    });
  });

  it("抖動窗內的舊事件不進重放快取（否則 2 天份的 id 會撐爆記憶體）", () => {
    const core = new RelayCore({
      now: () => NOW,
      maxPastSkewSec: TIMESTAMP_JITTER_SECONDS + 3600,
      replayWindowSec: 3600,
    });
    core.connect("c1");
    const old = at(NOW - 7200, 1059);
    core.handle("c1", EVENT(old));
    // 重送同一顆不被當成重複（收件端本來就以 rumor.id 去重）。
    expect(core.handle("c1", EVENT(old))).toContainEqual({ to: "c1", message: ["OK", old.id, true, ""] });
  });
});

// ADR-0235 H2：AUTH 的 relay tag 與新鮮度驗證。
describe("RelayCore — NIP-42 relay tag 驗證（ADR-0235 H2）", () => {
  const HOST = "relay.example.com";
  const NOW = 1_700_000_000;
  const sk = generateSecretKey();
  const auth = (e: NostrEvent) => JSON.stringify(["AUTH", e]);
  // 假時鐘：AUTH 事件的 created_at 必須對齊 `now`，否則會撞上新鮮度檢查。
  const authEvent = (challenge: string, relayUrl: string, createdAt = NOW) =>
    buildAuthEvent(challenge, relayUrl, sk, { created_at: createdAt });
  const chal = (out: ReturnType<RelayCore["connect"]>): string => String(out[0]?.message[1]);

  const newCore = () =>
    new RelayCore({ requireAuth: true, now: () => NOW, authChallenge: () => "fixed-challenge", authMaxAgeSec: 600 });

  it("relay tag 指向本站 → 認證成功", () => {
    const core = newCore();
    const c = chal(core.connect("c1", HOST));
    const e = authEvent(c, `wss://${HOST}`);
    expect(core.handle("c1", auth(e))).toEqual([{ to: "c1", message: ["OK", e.id, true, ""] }]);
  });

  it("🔴 relay tag 指向別站 → 拒絕（擋下中間人把挑戰轉發的攻擊）", () => {
    const core = newCore();
    const c = chal(core.connect("c1", HOST));
    // 受害者以為自己在對 evil.example 認證。challenge 是對的（攻擊者從真中繼轉來的）。
    const e = authEvent(c, "wss://evil.example");
    const out = core.handle("c1", auth(e));
    expect(out[0]?.message[2]).toBe(false);
    expect(String(out[0]?.message[3])).toContain("auth-failed");
  });

  it("缺少 relay tag → 拒絕", () => {
    const core = newCore();
    const c = chal(core.connect("c1", HOST));
    const base = authEvent(c, `wss://${HOST}`);
    const stripped = finalizeEvent(
      { kind: base.kind, created_at: base.created_at, tags: [["challenge", c]], content: "" },
      sk,
    );
    expect(core.handle("c1", auth(stripped))[0]?.message[2]).toBe(false);
  });

  it("過期的 AUTH 事件 → 拒絕（限制側錄簽名的可用時間）", () => {
    const core = newCore();
    const c = chal(core.connect("c1", HOST));
    const stale = finalizeEvent(
      { kind: 22242, created_at: NOW - 601, tags: [["relay", `wss://${HOST}`], ["challenge", c]], content: "" },
      sk,
    );
    expect(core.handle("c1", auth(stale))[0]?.message[2]).toBe(false);
  });

  it("未提供本站主機時不強制（自架/測試環境維持原行為）", () => {
    const core = new RelayCore({ requireAuth: true, now: () => NOW, authChallenge: () => "fixed" });
    const c = chal(core.connect("c1"));
    const e = authEvent(c, "wss://whatever.example");
    expect(core.handle("c1", auth(e))[0]?.message[2]).toBe(true);
  });

  it("本站主機隨連線快照存活（DO 休眠喚醒後仍會驗證）", () => {
    const core = newCore();
    core.connect("c1", HOST);
    const snap = core.exportConn("c1");
    expect(snap.relayHost).toBe(HOST);

    const revived = newCore();
    revived.rehydrate(snap);
    const e = authEvent(String(snap.challenge), "wss://evil.example");
    expect(revived.handle("c1", auth(e))[0]?.message[2]).toBe(false);
  });
});

// ADR-0235 H1 缺口修補：Gift Wrap 洪水繞過速率限制。
//
// 速率限制原本 keyed on `event.pubkey`。但 Gift Wrap（kind 1059）的外層作者是**一次性臨時
// 金鑰**——每則訊息一把不同的 pubkey——於是 per-author 的速率桶對它們形同虛設：一個認證身分
// 可以無限灌 gift wrap。必須改以**認證連線的身分**計數（authState.pubkey），那才是真正的寄件人。
describe("RelayCore — Gift Wrap 洪水須以認證身分限速（ADR-0235 H1 缺口）", () => {
  const NOW = 1_700_000_000;
  const wrap = (): NostrEvent =>
    // 每則一把新的臨時金鑰，模擬真實 Gift Wrap 的外層作者。
    finalizeEvent({ kind: 1059, created_at: NOW, tags: [["p", "ab"]], content: "x" }, generateSecretKey());

  it("認證身分為速率桶：即使每則事件作者都不同，超過上限仍被擋", () => {
    const core = new RelayCore({
      requireAuth: true,
      now: () => NOW,
      authChallenge: () => "chal",
      maxEventsPerMinute: 3,
      maxFutureSkewSec: 900,
      maxPastSkewSec: 100_000,
    });
    const sk = generateSecretKey();
    core.connect("c1");
    core.handle("c1", JSON.stringify(["AUTH", buildAuthEvent("chal", "wss://r", sk)]));

    for (let i = 0; i < 3; i++) {
      const e = wrap();
      expect(core.handle("c1", EVENT(e))).toContainEqual({ to: "c1", message: ["OK", e.id, true, ""] });
    }
    const over = wrap();
    expect(core.handle("c1", EVENT(over))).toContainEqual({
      to: "c1",
      message: ["OK", over.id, false, "rate-limited: events: 發送過於頻繁，請稍後再試"],
    });
  });

  it("開放中繼（無 requireAuth）退回以事件作者計數（維持原行為）", () => {
    const core = new RelayCore({ now: () => NOW, maxEventsPerMinute: 1, maxFutureSkewSec: 900, maxPastSkewSec: 100_000 });
    core.connect("c1");
    const sk = generateSecretKey();
    const a = finalizeEvent({ kind: 20000, created_at: NOW, tags: [], content: "" }, sk);
    expect(core.handle("c1", EVENT(a))).toContainEqual({ to: "c1", message: ["OK", a.id, true, ""] });
    const b = finalizeEvent({ kind: 20000, created_at: NOW - 1, tags: [], content: "" }, sk);
    expect(core.handle("c1", EVENT(b))[0]?.message[3]).toContain("rate-limited");
  });
});

describe("ADR-0366 §決策 5：第三方車道的三道閘", () => {
  const authed = (opts: Record<string, unknown>) => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const core = new RelayCore({ requireAuth: true, authChallenge: () => "ch", ...opts });
    core.connect("c");
    core.handle("c", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", sk)]));
    return { core, pk, sk };
  };
  const closedReason = (out: { message: unknown[] }[]) =>
    out.find((o) => o.message[0] === "CLOSED")?.message[2];

  describe("閘一：scoped() 放行標籤 filter（只在車道）", () => {
    it("🔴 大廳／世界／牌組的 filter 在**嚴格**平面仍然被擋", () => {
      const { core } = authed({});
      // 這三個正是下游實際送出的形狀（NAGD 大廳、世界動作、元素使牌組瀏覽）。
      for (const f of [
        { kinds: [20078], "#t": ["nagd"], "#g": ["chess"] },
        { kinds: [1078], "#w": ["world-1"] },
        { kinds: [31081], "#d": ["openetg-arena-deck"] },
      ]) {
        expect(closedReason(core.handle("c", REQ("s", f)))).toContain("restricted");
      }
    });

    it("同樣三個 filter 在車道上放行", () => {
      const { core } = authed({ publicLane: true });
      for (const f of [
        { kinds: [20078], "#t": ["nagd"], "#g": ["chess"] },
        { kinds: [1078], "#w": ["world-1"] },
        { kinds: [31081], "#d": ["openetg-arena-deck"] },
      ]) {
        expect(core.handle("c", REQ("s", f))).toContainEqual({ to: "c", message: ["EOSE", "s"] });
      }
    });

    it("🔴 車道**仍然**擋掉裸 filter——消防水管換條車道還是消防水管", () => {
      const { core } = authed({ publicLane: true });
      expect(closedReason(core.handle("c", REQ("s", { kinds: [20000] })))).toContain("restricted");
      expect(closedReason(core.handle("c", REQ("s2", {})))).toContain("restricted");
    });

    it("空的標籤陣列不算具名（匹配不到任何東西，放行只有成本沒有收穫）", () => {
      const { core } = authed({ publicLane: true });
      expect(closedReason(core.handle("c", REQ("s", { kinds: [1078], "#t": [] })))).toContain("restricted");
    });

    it("🔴 `#p` 仍然只能是自己——車道不放寬這一條", () => {
      const { core } = authed({ publicLane: true });
      const other = getPublicKey(generateSecretKey());
      // 即使同時帶了別的標籤，`#p` 指向別人依然被擋（否則等於能讀他人收件匣的元資料）。
      const out = core.handle("c", REQ("s", { kinds: [20078], "#t": ["nagd"], "#p": [other] }));
      expect(closedReason(out)).toContain("restricted");
    });

    it("🔴 車道上還沒認證就送 `#p`：回 auth-required（附挑戰），不是 restricted——認證後同一個 filter 放行（SDK ADR 0076）", () => {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      const core = new RelayCore({ requireAuth: false, publicLane: true, authChallenge: () => "ch" });
      core.connect("c");
      const before = core.handle("c", REQ("s", { kinds: [1060], "#p": [pk] }));
      expect(closedReason(before)).toMatch(/^auth-required:/);
      expect(before).toContainEqual({ to: "c", message: ["AUTH", "ch"] });
      core.handle("c", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", sk)]));
      expect(core.handle("c", REQ("s", { kinds: [1060], "#p": [pk] }))).toContainEqual({ to: "c", message: ["EOSE", "s"] });
      // 裸 filter 不是「認證後就會過」的那種：照舊 restricted
      const bare = new RelayCore({ requireAuth: false, publicLane: true, authChallenge: () => "ch" });
      bare.connect("d");
      expect(closedReason(bare.handle("d", REQ("s", { kinds: [20000] })))).toContain("restricted");
    });

    it("被拒時說得出這條車道接受什麼（ADR-0123：沉默的空回應會讓人跑去別處找 bug）", () => {
      expect(closedReason(authed({ publicLane: true }).core.handle("c", REQ("s", {})))).toContain("tag filter");
      expect(closedReason(authed({}).core.handle("c", REQ("s", {})))).not.toContain("tag filter");
    });
  });

  describe("閘二：可尋址的「只回作者本人」收窄到 SNAPSHOT_KIND", () => {
    const addressable = (kind: number, sk: ReturnType<typeof generateSecretKey>) =>
      finalizeEvent(
        { kind, created_at: Math.floor(Date.now() / 1000), tags: [["d", "x"]], content: "內容" },
        sk,
      );

    it("🔴 kind 30078（快照）仍然只回作者本人——ADR-0071 不受影響", () => {
      const alice = authed({});
      const bob = authed({});
      // 兩個 core 是各自獨立的，改用同一個 core 的兩條連線才測得到扇出閘門。
      const core = new RelayCore({ requireAuth: true, authChallenge: () => "ch" });
      const aSk = generateSecretKey();
      core.connect("alice");
      core.handle("alice", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", aSk)]));
      core.connect("bob");
      core.handle("bob", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", generateSecretKey())]));
      core.handle("bob", REQ("watch", { kinds: [30078], authors: [getPublicKey(aSk)] }));

      const out = core.handle("alice", EVENT(addressable(30078, aSk)));
      expect(out.some((o) => o.to === "bob")).toBe(false);
      expect(alice.pk).not.toBe(bob.pk); // 只是確保 helper 真的產生不同身分
    });

    it("🔴 其他可尋址 kind（第三方公開資料）**現在讀得到**——這正是先前三重阻擋的第二重", () => {
      const core = new RelayCore({ requireAuth: true, authChallenge: () => "ch" });
      const aSk = generateSecretKey();
      core.connect("alice");
      core.handle("alice", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", aSk)]));
      core.connect("bob");
      core.handle("bob", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", generateSecretKey())]));
      core.handle("bob", REQ("watch", { kinds: [31081], authors: [getPublicKey(aSk)] }));

      const deck = addressable(31081, aSk);
      expect(core.handle("alice", EVENT(deck))).toContainEqual({
        to: "bob",
        message: ["EVENT", "watch", deck],
      });
    });

    it("歷史回放同樣只閘快照，不閘其他可尋址 kind", () => {
      const store = new MessageStore();
      const core = new RelayCore({ store, requireAuth: true, authChallenge: () => "ch" });
      const aSk = generateSecretKey();
      core.connect("alice");
      core.handle("alice", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", aSk)]));
      core.handle("alice", EVENT(addressable(30078, aSk)));
      core.handle("alice", EVENT(addressable(31081, aSk)));

      core.connect("bob");
      core.handle("bob", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", generateSecretKey())]));
      const kinds = core
        .handle("bob", REQ("s", { kinds: [30078, 31081], authors: [getPublicKey(aSk)] }))
        .filter((o) => o.message[0] === "EVENT")
        .map((o) => (o.message[2] as NostrEvent).kind);
      expect(kinds).toEqual([31081]);
    });
  });
});

describe("ADR-0366 P1 #9：車道與訊息平面的配額**結構性**分離", () => {
  it("🔴 速率桶是每個 RelayCore 實例自己的——車道灌爆不影響訊息平面", () => {
    // 這不需要新程式碼：`routeForPath` 讓兩者落在不同的 DO，而每顆 DO 有自己的
    // RelayCore（自己的 `rate` Map）與自己的 SQLite。本測試把那個性質釘住，
    // 因為它是「放寬車道規則」之所以安全的一半理由（另一半是儲存分離，見下）。
    const sk = generateSecretKey();
    const mk = () => {
      const core = new RelayCore({ maxEventsPerMinute: 1, now: () => 1700000000 });
      return core;
    };
    const lane = mk();
    const plane = mk();
    const e1 = finalizeEvent({ kind: 20000, created_at: 1700000000, tags: [], content: "a" }, sk);
    const e2 = finalizeEvent({ kind: 20000, created_at: 1700000000, tags: [], content: "b" }, sk);

    lane.connect("c");
    expect(lane.handle("c", EVENT(e1))[0]?.message[2]).toBe(true);
    expect(String(lane.handle("c", EVENT(e2))[0]?.message[3])).toContain("rate-limited");

    // 同一把金鑰在另一個實例上桶是空的——兩條車道互不相干。
    plane.connect("c");
    expect(plane.handle("c", EVENT(e2))[0]?.message[2]).toBe(true);
  });

  it("每收件人 FIFO 也是每個 store 自己的——遊戲禮物擠不掉真人的離線訊息", () => {
    const laneStore = new MessageStore({ maxPerRecipient: 1 });
    const planeStore = new MessageStore({ maxPerRecipient: 1 });
    const wrap = (id: string, to: string): NostrEvent =>
      ({ id, pubkey: "x", created_at: 1000, kind: 1059, tags: [["p", to]], content: "", sig: "" }) as NostrEvent;

    laneStore.put(wrap("gift1", "alice"), 1000);
    laneStore.put(wrap("gift2", "alice"), 1000); // 擠掉 gift1——但只在車道那顆 store 裡
    planeStore.put(wrap("chat", "alice"), 1000);

    expect(planeStore.query({ "#p": ["alice"] } as never, 1000).map((e) => e.id)).toEqual(["chat"]);
  });
});

describe("NIP-13 難度量測是轉引，不是各抄一份（ADR-0366 P2 #11）", () => {
  it("🔴 中繼端用的就是 core 的那一個函式", async () => {
    // 挖礦端（core `minePow`）與驗證端（本檔）對難度的定義差一位元，症狀就是
    // 「客戶端算得很辛苦卻照樣被拒」，而且是安靜的。
    //
    // ⚠ 這條斷言必須住在 relay 這一側：依賴方向是 relay → core，反過來寫會讓
    // core 的 `tsc --noEmit` 因為 rootDir 而整個掛掉（實際踩過）。
    const core = await import("../../src/protocol/index.js");
    expect(leadingZeroBits).toBe(core.leadingZeroBits);
  });

  it("挖過的事件通得過中繼的 PoW 閘門（兩端對同一個難度達成一致）", () => {
    const core = new RelayCore({ minPowDifficulty: 8 });
    core.connect("c");
    const sk = generateSecretKey();
    const mined = minePow({ kind: 1078, created_at: 1700000000, tags: [], content: "x" }, sk, 8);
    expect(core.handle("c", EVENT(mined))[0]?.message[2]).toBe(true);

    const plain = finalizeEvent({ kind: 1078, created_at: 1700000000, tags: [], content: "y" }, sk);
    const out = core.handle("c", EVENT(plain))[0];
    // 沒挖過的**可能**湊巧達標（機率 1/256），那不是失敗——重點是閘門有在判。
    if (out?.message[2] === false) expect(String(out.message[3])).toContain("pow");
  });
});

describe("RelayCore — 每連線訊息速率上限（ADR-0366 §容量）", () => {
  /** 進站訊息是中繼站的計費單位，而 REQ／CLOSE 不是事件——per-pubkey 的事件限速看不到它們。 */
  const core = (perMinute: number, now: () => number) =>
    new RelayCore({ maxMessagesPerMinute: perMinute, now });

  it("超過上限：回 NOTICE 並要求宿主關閉該連線", () => {
    let clock = 1_700_000_000;
    const relay = core(3, () => clock);
    relay.connect("c1");
    for (let i = 0; i < 3; i += 1) {
      expect(relay.handle("c1", REQ(`s${i}`, { kinds: [20000] }))[0]?.close).toBeUndefined();
    }
    const out = relay.handle("c1", REQ("s3", { kinds: [20000] }));
    expect(out).toHaveLength(1);
    expect(out[0]?.to).toBe("c1");
    expect(out[0]?.message[0]).toBe("NOTICE");
    expect(String(out[0]?.message[1])).toMatch(/rate-limited/);
    // 🔴 關閉是重點：不關的話，同一條連線可以繼續燒額度，而擋在升級處的 IP 限速
    // 只看得到「新連線」。兩道一起才有界。
    expect(out[0]?.close).toBe(true);
  });

  it("各連線各算各的——一條被擋不影響另一條", () => {
    let clock = 1_700_000_000;
    const relay = core(1, () => clock);
    relay.connect("a");
    relay.connect("b");
    relay.handle("a", REQ("s1", { kinds: [20000] }));
    expect(relay.handle("a", REQ("s2", { kinds: [20000] }))[0]?.close).toBe(true);
    expect(relay.handle("b", REQ("s1", { kinds: [20000] }))[0]?.close).toBeUndefined();
  });

  it("過了一分鐘就重置（固定窗，與事件限速同一套演算法）", () => {
    let clock = 1_700_000_000;
    const relay = core(1, () => clock);
    relay.connect("c1");
    relay.handle("c1", REQ("s1", { kinds: [20000] }));
    expect(relay.handle("c1", REQ("s2", { kinds: [20000] }))[0]?.close).toBe(true);
    clock += 60;
    expect(relay.handle("c1", REQ("s3", { kinds: [20000] }))[0]?.close).toBeUndefined();
  });

  it("未設定＝不限制（自架站與測試維持原行為）", () => {
    const relay = new RelayCore();
    relay.connect("c1");
    for (let i = 0; i < 50; i += 1) {
      expect(relay.handle("c1", REQ(`s${i}`, { kinds: [20000] }))[0]?.close).toBeUndefined();
    }
  });
});

describe("車道用**上線時的真實設定**：範圍檢查與可選 AUTH（ADR-0369）", () => {
  // 🔴 這組存在的理由：上面「閘一」的測試都是 `requireAuth: true ＋ publicLane`，而上線的車道是
  // `guardFor("app")`＝`requireAuth: false`。範圍檢查原本包在 `requireAuth` 條件裡，
  // 於是車道上**完全不檢查**——那組測試全綠，產線卻是消防水管。一律用真實設定。
  const lane = () => {
    const core = new RelayCore({ store: new MessageStore(), ...guardFor("app"), authChallenge: () => "ch" });
    const connectOut = core.connect("c");
    return { core, connectOut };
  };
  const closedReason = (out: { message: unknown[] }[]) =>
    out.find((o) => o.message[0] === "CLOSED")?.message[2] as string | undefined;
  const eose = (out: { message: unknown[] }[]) => out.some((o) => o.message[0] === "EOSE");
  const authAs = (core: RelayCore, sk: ReturnType<typeof generateSecretKey>) =>
    core.handle("c", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", sk)]));

  it("🔴 裸 filter 被擋——不論有沒有 AUTH", () => {
    const { core } = lane();
    expect(closedReason(core.handle("c", REQ("s", { kinds: [20000] })))).toContain("restricted");
    expect(closedReason(core.handle("c", REQ("s2", {})))).toContain("restricted");
  });

  it("標籤 filter 不需要 AUTH 就能訂閱（不處理 AUTH 的客戶端仍可用）", () => {
    const { core } = lane();
    expect(eose(core.handle("c", REQ("s", { kinds: [20078], "#t": ["nagd"] })))).toBe(true);
    expect(eose(core.handle("c", REQ("s2", { kinds: [31081], "#d": ["deck"] })))).toBe(true);
  });

  it("🔴 `#p` 指向別人被擋——不論有沒有 AUTH", () => {
    const { core } = lane();
    const other = getPublicKey(generateSecretKey());
    // 還沒認證：分不出是不是自己 → 先要求認證（SDK ADR 0076）；照樣不放行
    expect(closedReason(core.handle("c", REQ("s", { kinds: [20078], "#p": [other] })))).toMatch(/^auth-required:/);
    authAs(core, generateSecretKey());
    expect(closedReason(core.handle("c", REQ("s2", { kinds: [20078], "#p": [other] })))).toContain("restricted");
  });

  it("車道連線一開始就收到 AUTH 挑戰（可選，不強制）", () => {
    const { connectOut } = lane();
    expect(connectOut).toContainEqual({ to: "c", message: ["AUTH", "ch"] });
  });

  it("做了 AUTH 就能用 `#p` 讀自己的指名信令", () => {
    const { core } = lane();
    const sk = generateSecretKey();
    const ok = authAs(core, sk);
    expect(ok).toContainEqual({ to: "c", message: expect.arrayContaining(["OK", true]) });
    expect(eose(core.handle("c", REQ("s", { kinds: [20078], "#p": [getPublicKey(sk)] })))).toBe(true);
  });

  it("沒做 AUTH 就用 `#p`：以 NIP-42 的 auth-required 講出「先 AUTH」（客戶端認證後會重送；SDK ADR 0076），而不是籠統的 restricted", () => {
    const { core } = lane();
    const me = getPublicKey(generateSecretKey());
    const out = core.handle("c", REQ("s", { kinds: [20078], "#p": [me] }));
    expect(closedReason(out)).toMatch(/^auth-required:/);
    expect(out).toContainEqual({ to: "c", message: ["AUTH", "ch"] });
  });

  it("🔴 AUTH 仍然**不是**發事件的前提——車道的寫入維持開放", () => {
    const { core } = lane();
    const ev = finalizeEvent(
      { kind: 1078, created_at: Math.floor(Date.now() / 1000), tags: [["t", "nagd"]], content: "" },
      generateSecretKey(),
    );
    expect(core.handle("c", EVENT(ev))).toContainEqual({ to: "c", message: ["OK", ev.id, true, ""] });
  });

  it("拒絕原因以英文說明車道接受什麼（讀者是第三方開發者）", () => {
    const { core } = lane();
    const reason = closedReason(core.handle("c", REQ("s", {})));
    expect(reason).toContain("tag");
    expect(reason).toContain("authors");
  });

  it("嚴格平面不變：仍是 AUTH 前拒絕、範圍訊息仍為原文", () => {
    const core = new RelayCore({ store: new MessageStore(), ...guardFor("strict"), authChallenge: () => "ch" });
    core.connect("c");
    expect(closedReason(core.handle("c", REQ("s", { kinds: [20000] })))).toContain("auth-required");
  });
});

describe("REQ 的位元組預算（Cinderous ADR-0371 §決策 6）", () => {
  const sk = generateSecretKey();
  const author = getPublicKey(sk);
  const stored = (i: number, kind: number): NostrEvent =>
    finalizeEvent({ kind, created_at: 1_700_000_000 + i, tags: [["p", "a".repeat(64)]], content: "x".repeat(1000) }, sk);

  it("🔴 一次 REQ 的所有 filter 共用同一份預算——多塞幾個 filter 不能繞過", () => {
    const store = new MessageStore();
    const events = [...Array.from({ length: 5 }, (_, i) => stored(i, 1060)), ...Array.from({ length: 5 }, (_, i) => stored(10 + i, 1059))];
    for (const e of events) store.put(e, 1_700_000_001);
    const one = JSON.stringify(events[0]).length;
    const core = new RelayCore({ store, maxQueryBytes: one * 4 + 10, now: () => 1_700_000_001 });
    core.connect("c");
    const out = core.handle(
      "c",
      JSON.stringify(["REQ", "s", { authors: [author], kinds: [1060] }, { authors: [author], kinds: [1059] }]),
    );
    const got = out.filter((o) => o.message[0] === "EVENT");
    expect(got).toHaveLength(4);
    expect(out.at(-1)).toEqual({ to: "c", message: ["EOSE", "s"] });
  });

  it("預設就有上限（MAX_QUERY_BYTES）——宿主不必記得傳", () => {
    expect(MAX_QUERY_BYTES).toBeLessThanOrEqual(32 * 1024 * 1024);
    const store = new MessageStore();
    const seen: (number | undefined)[] = [];
    const spy = { ...store, query: (f: RelayFilter, now: number, max?: number) => (seen.push(max), store.query(f, now, max)) };
    const core = new RelayCore({ store: spy as unknown as MessageStore });
    core.connect("c");
    core.handle("c", JSON.stringify(["REQ", "s", { authors: [author] }]));
    expect(seen).toEqual([MAX_QUERY_BYTES]);
  });
});

// SDK ADR 0038 P0-R1：離線留言存不下時，中繼必須說實話。
//
// 修正前 `handleEvent` 呼叫 `store.put()` 卻不看回傳值：嚴格平面（不淘汰）的 DO 天花板滿了之後，
// 每一則新的私訊都回 `OK true`、照常扇出，然後就不見了——寄件端以為送達，收件端永遠收不到。
describe("RelayCore — 離線留言存不下要回 OK false（SDK ADR 0038 P0-R1）", () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: typeof DatabaseSyncType;
  };
  const sqlStore = (opts: MessageStoreOptions): OfflineStore => {
    const db = new DatabaseSync(":memory:");
    return new SqlMessageStore((query, ...bindings) => {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
      stmt.run(...bindings);
      return [];
    }, opts);
  };
  const stores: [string, (opts: MessageStoreOptions) => OfflineStore][] = [
    ["MessageStore", (opts) => new MessageStore(opts)],
    ["SqlMessageStore", sqlStore],
  ];
  const NOW = 1_700_000_000;
  const RECIPIENT = "a".repeat(64);
  const wrapOf = (extraTags: string[][] = [], size = 3000): NostrEvent =>
    finalizeEvent(
      { kind: 1059, created_at: NOW, tags: [["p", RECIPIENT], ...extraTags], content: "x".repeat(size) },
      generateSecretKey(),
    );
  const okOf = (out: ReturnType<RelayCore["handle"]>, id: string) =>
    out.find((o) => o.to === "sender" && o.message[0] === "OK" && o.message[1] === id)?.message;

  for (const [name, make] of stores) {
    describe(name, () => {
      it("🔴 嚴格平面（不淘汰）天花板滿了：回 OK false「blocked: ceiling:」、不扇出；回 OK true 的都真的存下了", () => {
        const store = make({ offlineMaxTotalBytes: 10_000 });
        const core = new RelayCore({ store, now: () => NOW });
        core.connect("sender");
        core.connect("watcher");
        core.handle("watcher", REQ("s", { "#p": [RECIPIENT] }));

        const accepted: string[] = [];
        const rejected: string[] = [];
        for (let i = 0; i < 5; i++) {
          const e = wrapOf();
          const out = core.handle("sender", EVENT(e));
          const ok = okOf(out, e.id);
          const fannedOut = out.some((o) => o.to === "watcher");
          if (ok?.[2] === true) {
            accepted.push(e.id);
            expect(fannedOut).toBe(true);
          } else {
            rejected.push(e.id);
            expect(ok).toEqual(["OK", e.id, false, OFFLINE_CEILING_REJECT]);
            expect(fannedOut).toBe(false);
          }
        }
        // 修正前：五顆都回 OK true，只存了兩顆。
        expect(accepted.length).toBe(2);
        expect(rejected.length).toBe(3);
        const stored = store.query({ "#p": [RECIPIENT] } as RelayFilter, NOW).map((e) => e.id);
        expect(stored.sort()).toEqual([...accepted].sort());
      });

      it("拒收訊息是 NIP-01 機器可讀前綴＋英文詞元（ADR 0038 決策 2）", () => {
        expect(OFFLINE_CEILING_REJECT.startsWith("blocked: ceiling: ")).toBe(true);
        expect(EXPIRED_REJECT.startsWith("invalid: expired: ")).toBe(true);
      });

      it("事件自帶的 expiration 已經過了：回 OK false「invalid: expired:」、不扇出、不入庫", () => {
        const store = make({ offlineMaxTotalBytes: 10_000 });
        const core = new RelayCore({ store, now: () => NOW });
        core.connect("sender");
        core.connect("watcher");
        core.handle("watcher", REQ("s", { "#p": [RECIPIENT] }));
        const e = wrapOf([["expiration", String(NOW - 1)]], 10);
        const out = core.handle("sender", EVENT(e));
        expect(out).toEqual([{ to: "sender", message: ["OK", e.id, false, EXPIRED_REJECT] }]);
        expect(store.query({ "#p": [RECIPIENT] } as RelayFilter, NOW - 10)).toEqual([]);
      });

      it("車道（ceilingEvicts）照舊淘汰最快到期者、收下新的：五顆都是 OK true", () => {
        const store = make({ offlineMaxTotalBytes: 10_000, ceilingEvicts: true });
        const core = new RelayCore({ store, now: () => NOW });
        core.connect("sender");
        for (let i = 0; i < 5; i++) {
          const e = wrapOf();
          expect(okOf(core.handle("sender", EVENT(e)), e.id)?.[2]).toBe(true);
        }
      });

      it("每收件人 FIFO 擠掉舊的、收下新的——不是存不下，仍回 OK true", () => {
        const store = make({ maxPerRecipient: 1 });
        const core = new RelayCore({ store, now: () => NOW });
        core.connect("sender");
        const first = wrapOf([], 10);
        const second = wrapOf([], 10);
        expect(okOf(core.handle("sender", EVENT(first)), first.id)?.[2]).toBe(true);
        expect(okOf(core.handle("sender", EVENT(second)), second.id)?.[2]).toBe(true);
        expect(store.query({ "#p": [RECIPIENT] } as RelayFilter, NOW).map((e) => e.id)).toEqual([second.id]);
      });
    });
  }

  it("🔴 被拒的事件不記進重放快取：空間騰出來後重送同一顆，是收下而不是「duplicate」", () => {
    let full = true;
    const stored: string[] = [];
    const store: OfflineStore = {
      put: (e) => {
        if (full) return false;
        stored.push(e.id);
        return true;
      },
      putAddressable: () => true,
      query: () => [],
      prune: () => {},
      vanish: () => 0,
    };
    const core = new RelayCore({ store, now: () => NOW, replayWindowSec: 3600 });
    core.connect("sender");
    const e = wrapOf([], 10);
    expect(okOf(core.handle("sender", EVENT(e)), e.id)).toEqual(["OK", e.id, false, OFFLINE_CEILING_REJECT]);
    full = false;
    expect(okOf(core.handle("sender", EVENT(e)), e.id)).toEqual(["OK", e.id, true, ""]);
    expect(stored).toEqual([e.id]);
    // 收下之後才是真的重複。
    expect(okOf(core.handle("sender", EVENT(e)), e.id)?.[3]).toContain("duplicate");
  });

  it("可尋址被拒同樣不記進重放快取（拒收訊息不變）", () => {
    let accept = false;
    const store: OfflineStore = {
      put: () => true,
      putAddressable: () => accept,
      query: () => [],
      prune: () => {},
      vanish: () => 0,
    };
    const core = new RelayCore({ store, now: () => NOW, replayWindowSec: 3600 });
    core.connect("sender");
    const e = finalizeEvent({ kind: 30078, created_at: NOW, tags: [["d", "x"]], content: "" }, generateSecretKey());
    expect(okOf(core.handle("sender", EVENT(e)), e.id)).toEqual([
      "OK",
      e.id,
      false,
      "blocked: 取代事件遭拒（配額/大小/較舊）",
    ]);
    accept = true;
    expect(okOf(core.handle("sender", EVENT(e)), e.id)?.[2]).toBe(true);
  });
});
