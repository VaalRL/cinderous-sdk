// RelayCore 對容量政策的回應（SDK ADR 0042）：`OK true "warning: borrowed:|near-full:"`、丟棄計數的 `NOTICE`。
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildAuthEvent,
  classifyRelayMessage,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  parseBorrowedWarning,
  parseDroppedNotice,
  parseNearFullWarning,
  RELAY_WARNING_TOKENS,
  type NostrEvent,
} from "../../src/protocol/index.js";
import { MessageStore, type MessageStoreOptions, type OfflineStore } from "../../src/relay/message-store.js";
import { borrowedWarning, droppedNotice, nearFullWarning } from "../../src/relay/reject-messages.js";
import { RelayCore } from "../../src/relay/relay-core.js";
import { SqlMessageStore } from "../../src/relay/sql-message-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const STORES: [string, (opts: MessageStoreOptions) => OfflineStore][] = [
  ["MessageStore", (opts) => new MessageStore(opts)],
  [
    "SqlMessageStore",
    (opts) => {
      const db = new DatabaseSync(":memory:");
      return new SqlMessageStore((query, ...bindings) => {
        const stmt = db.prepare(query);
        if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
        stmt.run(...bindings);
        return [];
      }, opts);
    },
  ],
];

const NOW = 1_800_000_000;
const REQ = (sub: string, filter: object) => JSON.stringify(["REQ", sub, filter]);
const EVENT = (e: NostrEvent) => JSON.stringify(["EVENT", e]);
const CLOSE = (sub: string) => JSON.stringify(["CLOSE", sub]);

function wrapTo(recipient: string, created = NOW, size = 300): NostrEvent {
  return finalizeEvent({ kind: 1059, created_at: created, tags: [["p", recipient]], content: "x".repeat(size) }, generateSecretKey());
}
const ROW = JSON.stringify(wrapTo("a".repeat(64))).length;

/** 已認證的連線 */
function authed(core: RelayCore, connId: string, sk: Uint8Array): void {
  core.connect(connId);
  const ev = buildAuthEvent("chal", "wss://relay.test", sk);
  const out = core.handle(connId, JSON.stringify(["AUTH", ev]));
  expect(out[0]?.message[2]).toBe(true);
}

const okOf = (out: ReturnType<RelayCore["handle"]>, id: string) =>
  out.find((o) => o.message[0] === "OK" && o.message[1] === id)?.message;

describe("warning 的句子是「前綴＋詞元＋說明」，客戶端分得出來（ADR 0040 詞元表）", () => {
  it("borrowed／near-full／dropped 三句都以 warning: 開頭、第二層是詞元，解析得回數字", () => {
    expect(classifyRelayMessage(borrowedWarning(7200))).toMatchObject({ prefix: "warning", token: RELAY_WARNING_TOKENS.borrowed, kind: "borrowed" });
    expect(parseBorrowedWarning(borrowedWarning(7200))).toEqual({ ttlSec: 7200 });
    expect(classifyRelayMessage(nearFullWarning(80))).toMatchObject({ prefix: "warning", token: RELAY_WARNING_TOKENS.nearFull, kind: "near-full" });
    expect(parseNearFullWarning(nearFullWarning(95))).toEqual({ percent: 95 });
    const d = droppedNotice({ count: 12, since: 1_790_000_000, until: 1_790_086_400 });
    expect(classifyRelayMessage(d)).toMatchObject({ prefix: "warning", token: RELAY_WARNING_TOKENS.dropped });
    expect(parseDroppedNotice(d)).toEqual({ count: 12, since: 1_790_000_000, until: 1_790_086_400 });
    // 不是這種訊息就是 undefined
    expect(parseDroppedNotice("warning: borrowed: 7200: x")).toBeUndefined();
    expect(parseNearFullWarning("blocked: ceiling: x")).toBeUndefined();
    // 說明文字裡不帶寄件人、內容或事件 id——只有三個數字
    expect(d.match(/[0-9a-f]{64}/)).toBeNull();
  });
});

for (const [name, make] of STORES) {
  describe(`${name}：OK true 帶 warning`, () => {
    it("借用收下：OK true「warning: borrowed: 7200: …」，照常扇出（收下了）", () => {
      const store = make({ offlineMaxTotalBytes: ROW, overflowRatio: 1, borrowPerKeyBytes: ROW });
      const core = new RelayCore({ store, now: () => NOW });
      core.connect("sender");
      core.connect("watcher");
      const R = "a".repeat(64);
      core.handle("watcher", REQ("s", { "#p": [R] }));
      const first = wrapTo(R);
      expect(okOf(core.handle("sender", EVENT(first)), first.id)).toEqual(["OK", first.id, true, ""]);
      const second = wrapTo(R);
      const out = core.handle("sender", EVENT(second));
      expect(okOf(out, second.id)).toEqual(["OK", second.id, true, borrowedWarning(7200)]);
      expect(out.some((o) => o.to === "watcher" && o.message[0] === "EVENT")).toBe(true);
    });

    it("接近天花板：OK true「warning: near-full: 80: …」；可尋址也一樣", () => {
      const store = make({ offlineMaxTotalBytes: 10 * ROW, nearFullPercent: 80 });
      const core = new RelayCore({ store, now: () => NOW });
      core.connect("sender");
      const notes = Array.from({ length: 8 }, () => {
        const e = wrapTo("b".repeat(64));
        return okOf(core.handle("sender", EVENT(e)), e.id)?.[3];
      });
      expect(notes.slice(0, 7)).toEqual(Array(7).fill(""));
      expect(notes[7]).toBe(nearFullWarning(80));

      const sk = generateSecretKey();
      const snap = (d: string): NostrEvent =>
        finalizeEvent({ kind: 30_100, created_at: NOW, tags: [["d", d]], content: "y".repeat(300) }, sk);
      const size = JSON.stringify(snap("0")).length;
      const astore = make({ addressableMaxTotalBytes: 2 * size, nearFullPercent: 50, addressablePerAuthor: 10 });
      const acore = new RelayCore({ store: astore, now: () => NOW });
      acore.connect("a");
      const e = snap("0");
      expect(okOf(acore.handle("a", EVENT(e)), e.id)).toEqual(["OK", e.id, true, nearFullWarning(50)]);
    });

    it("沒設容量選項：OK true 的訊息仍是空字串（v0.33 相同）", () => {
      const core = new RelayCore({ store: make({ offlineMaxTotalBytes: 100 * ROW }), now: () => NOW });
      core.connect("sender");
      const e = wrapTo("c".repeat(64));
      expect(okOf(core.handle("sender", EVENT(e)), e.id)).toEqual(["OK", e.id, true, ""]);
    });
  });

  describe(`${name}：丟棄計數的 NOTICE`, () => {
    const setup = () => {
      const store = make({ maxPerRecipient: 2, countDrops: true });
      const core = new RelayCore({ store, now: () => NOW, requireAuth: true, authChallenge: () => "chal" });
      const senderSk = generateSecretKey();
      const recipientSk = generateSecretKey();
      const R = getPublicKey(recipientSk);
      authed(core, "sender", senderSk);
      return { core, R, recipientSk };
    };

    it("🔴 收件人讀自己的收件匣：EOSE 之前收到一則「warning: dropped: 則數: since: until: …」，之後歸零", () => {
      const { core, R, recipientSk } = setup();
      const sent = [1, 2, 3, 4].map((i) => wrapTo(R, NOW - 100 + i));
      for (const e of sent) core.handle("sender", EVENT(e));
      authed(core, "r", recipientSk);
      const out = core.handle("r", REQ("inbox", { kinds: [1059], "#p": [R] }));
      const kinds = out.map((o) => o.message[0]);
      expect(kinds.slice(-2)).toEqual(["NOTICE", "EOSE"]);
      const notice = String(out.at(-2)!.message[1]);
      expect(parseDroppedNotice(notice)).toEqual({ count: 2, since: NOW - 99, until: NOW - 98 });
      // 第二次讀：歸零了
      expect(core.handle("r", REQ("inbox2", { kinds: [1059], "#p": [R] })).map((o) => o.message[0])).not.toContain("NOTICE");
    });

    it("只收 ephemeral 的 #p 訂閱（通話信令）不拿走計數", () => {
      const { core, R, recipientSk } = setup();
      for (let i = 1; i <= 3; i += 1) core.handle("sender", EVENT(wrapTo(R, NOW - 100 + i)));
      authed(core, "r", recipientSk);
      expect(core.handle("r", REQ("sig", { kinds: [21000], "#p": [R] })).map((o) => o.message[0])).toEqual(["EOSE"]);
      expect(core.handle("r", REQ("inbox", { "#p": [R] })).map((o) => o.message[0])).toContain("NOTICE");
    });

    it("收件人在線上收收件匣時被擠掉的（即時收到了）不算；關掉訂閱之後才算", () => {
      const { core, R, recipientSk } = setup();
      authed(core, "r", recipientSk);
      core.handle("r", REQ("inbox", { "#p": [R] }));
      for (let i = 1; i <= 4; i += 1) core.handle("sender", EVENT(wrapTo(R, NOW - 100 + i)));
      core.handle("r", CLOSE("inbox"));
      expect(core.handle("r", REQ("again", { "#p": [R] })).map((o) => o.message[0])).not.toContain("NOTICE");
      core.handle("r", CLOSE("again"));
      for (let i = 5; i <= 7; i += 1) core.handle("sender", EVENT(wrapTo(R, NOW - 100 + i)));
      const out = core.handle("r", REQ("later", { "#p": [R] }));
      expect(parseDroppedNotice(String(out.find((o) => o.message[0] === "NOTICE")?.message[1]))).toEqual({
        count: 1,
        since: NOW - 95,
        until: NOW - 95,
      });
    });

    it("斷線也算訂閱結束：斷線前即時送到的，之後被擠掉不算", () => {
      const { core, R, recipientSk } = setup();
      authed(core, "r", recipientSk);
      core.handle("r", REQ("inbox", { "#p": [R] }));
      for (let i = 1; i <= 2; i += 1) core.handle("sender", EVENT(wrapTo(R, NOW - 100 + i)));
      core.disconnect("r");
      for (let i = 3; i <= 4; i += 1) core.handle("sender", EVENT(wrapTo(R, NOW - 100 + i))); // 擠掉 1、2（送到過）
      authed(core, "r2", recipientSk);
      expect(core.handle("r2", REQ("inbox", { "#p": [R] })).map((o) => o.message[0])).not.toContain("NOTICE");
    });
  });
}
