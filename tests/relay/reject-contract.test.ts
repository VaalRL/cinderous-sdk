// 拒收訊息的契約（SDK ADR 0038 P0-R2；ADR 0040）：中繼寫的每一句，客戶端的 classifyRelayMessage 都分得對。
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { buildAuthEvent, finalizeEvent, generateSecretKey, type NostrEvent } from "../../src/protocol/index.js";
import { classifyRelayMessage, RELAY_REJECT_TOKENS, type RelayRejectKind } from "../../src/protocol/relay-reject.js";
import { MessageStore, type MessageStoreOptions, type OfflineStore } from "../../src/relay/message-store.js";
import {
  ADDRESSABLE_REJECT,
  ADDRESSABLE_REJECT_GENERIC,
  EXPIRED_REJECT,
  malformedMessage,
  OFFLINE_CEILING_REJECT,
  powRejectMessage,
  REJECT,
  tooManyConnectionsMessage,
} from "../../src/relay/reject-messages.js";
import { RelayCore } from "../../src/relay/relay-core.js";
import { SqlMessageStore } from "../../src/relay/sql-message-store.js";

const T = RELAY_REJECT_TOKENS;

describe("契約：每一句拒收訊息都是「前綴＋詞元＋說明」，而且分類正確", () => {
  const table: [string, string, string, RelayRejectKind][] = [
    [OFFLINE_CEILING_REJECT, "blocked", T.ceiling, "ceiling"],
    [EXPIRED_REJECT, "invalid", T.expired, "invalid"],
    [ADDRESSABLE_REJECT.stale, "blocked", T.stale, "stale"],
    [ADDRESSABLE_REJECT["too-large"], "blocked", T.tooLarge, "too-large"],
    [ADDRESSABLE_REJECT["address-quota"], "blocked", T.quota, "quota"],
    [ADDRESSABLE_REJECT["byte-quota"], "blocked", T.quota, "quota"],
    [ADDRESSABLE_REJECT.expired, "invalid", T.expired, "invalid"],
    [ADDRESSABLE_REJECT.ceiling, "blocked", T.ceiling, "ceiling"],
    [REJECT.tooManyTags, "blocked", T.tooManyTags, "too-large"],
    [REJECT.tooManyRecipients, "blocked", T.tooManyRecipients, "too-large"],
    [REJECT.eventTooLarge, "blocked", T.tooLarge, "too-large"],
    [REJECT.notAllowed, "blocked", T.notAllowed, "policy"],
    [REJECT.kindDisabled, "blocked", T.kindDisabled, "policy"],
    [REJECT.filesDisabled, "blocked", T.filesDisabled, "policy"],
    [REJECT.fileChunkTooLarge, "blocked", T.tooLarge, "too-large"],
    [REJECT.badSignature, "invalid", T.badSignature, "invalid"],
    [REJECT.clockSkew, "invalid", T.clockSkew, "invalid"],
    [REJECT.messageTooLarge, "invalid", T.tooLarge, "too-large"],
    [REJECT.vanishRelayTag, "invalid", T.relayTag, "invalid"],
    [REJECT.duplicate, "duplicate", T.seen, "duplicate"],
    [REJECT.eventsRateLimited, "rate-limited", T.events, "rate-limited"],
    [REJECT.messagesRateLimited, "rate-limited", T.messages, "rate-limited"],
    [REJECT.ipRateLimited, "rate-limited", T.ip, "rate-limited"],
    [REJECT.subscriptionsLimit, "rate-limited", T.subscriptions, "rate-limited"],
    [REJECT.authRequired, "auth-required", T.nip42, "auth-required"],
    [REJECT.scopeStrict, "restricted", T.scope, "restricted"],
    [REJECT.scopeLane, "restricted", T.scope, "restricted"],
    [REJECT.notOnWhitelist, "restricted", T.notAllowed, "restricted"],
    [REJECT.vanishSelfOnly, "restricted", T.selfOnly, "restricted"],
    [REJECT.ackSelfOnly, "restricted", T.selfOnly, "restricted"],
    [REJECT.ackMalformed, "invalid", T.malformed, "invalid"],
    [REJECT.readOnly, "restricted", T.readOnly, "restricted"],
    [REJECT.authNoChallenge, "auth-failed", T.noChallenge, "restricted"],
    [REJECT.authBadEvent, "auth-failed", T.badAuth, "restricted"],
    [REJECT.authRelayTag, "auth-failed", T.relayTag, "restricted"],
    [REJECT.authTooOld, "auth-failed", T.authTooOld, "restricted"],
    [REJECT.internal, "error", T.internal, "error"],
    [powRejectMessage(8), "pow", T.difficulty, "pow"],
    [tooManyConnectionsMessage(3), "restricted", T.tooManyConnections, "restricted"],
    [malformedMessage("malformed event"), "invalid", T.malformed, "invalid"],
  ];
  it.each(table)("%s", (message, prefix, token, kind) => {
    expect(classifyRelayMessage(message)).toMatchObject({ prefix, token, kind });
  });

  it("每一個詞元至少被一句用到（沒有死詞元）", () => {
    const used = new Set(table.map((row) => row[2]));
    used.add(T.resubscribe); // worker.ts 的 CLOSED（見 worker.test.ts）
    for (const token of Object.values(T)) expect(used.has(token), token).toBe(true);
  });

  it("🔴 ADR 0027 的舊偵測（blocked: 且提到 MAX_FILE_MB）仍然成立", () => {
    expect(REJECT.filesDisabled.startsWith("blocked:")).toBe(true);
    expect(REJECT.filesDisabled).toContain("MAX_FILE_MB");
  });

  it("說不出原因的自訂 store 用舊句子，客戶端分成 policy", () => {
    expect(classifyRelayMessage(ADDRESSABLE_REJECT_GENERIC)).toMatchObject({ prefix: "blocked", token: undefined, kind: "policy" });
  });
});

const NOW = 1_700_000_000;
const EVENT = (e: NostrEvent) => JSON.stringify(["EVENT", e]);
const okOf = (out: ReturnType<RelayCore["handle"]>, id: string) =>
  out.find((o) => o.message[0] === "OK" && o.message[1] === id)?.message;

describe("可尋址被拒依原因拆開（SDK ADR 0038 P0-R2）", () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
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
  const addressable = (sk: Uint8Array, opts: { d?: string; size?: number; createdAt?: number; kind?: number; tags?: string[][] } = {}) =>
    finalizeEvent(
      {
        kind: opts.kind ?? 30078,
        created_at: opts.createdAt ?? NOW,
        tags: [["d", opts.d ?? "a"], ...(opts.tags ?? [])],
        content: "x".repeat(opts.size ?? 10),
      },
      sk,
    );

  for (const [name, make] of stores) {
    describe(name, () => {
      const send = (store: OfflineStore, e: NostrEvent) => {
        const core = new RelayCore({ store, now: () => NOW });
        core.connect("c");
        return okOf(core.handle("c", EVENT(e)), e.id);
      };

      it("較舊 → stale", () => {
        const store = make({});
        const sk = generateSecretKey();
        expect(send(store, addressable(sk, { createdAt: NOW }))?.[2]).toBe(true);
        const older = addressable(sk, { createdAt: NOW - 10 });
        expect(send(store, older)).toEqual(["OK", older.id, false, ADDRESSABLE_REJECT.stale]);
        expect(store.putAddressableResult!(older, NOW)).toEqual({ ok: false, reason: "stale" });
      });

      it("單顆太大 → too-large", () => {
        const store = make({ addressableMaxBytes: 500 });
        const e = addressable(generateSecretKey(), { size: 1000 });
        expect(send(store, e)).toEqual(["OK", e.id, false, ADDRESSABLE_REJECT["too-large"]]);
      });

      it("位址數滿 → quota（位址數）", () => {
        const store = make({ addressablePerAuthor: 1 });
        const sk = generateSecretKey();
        expect(send(store, addressable(sk, { d: "a" }))?.[2]).toBe(true);
        const second = addressable(sk, { d: "b" });
        expect(send(store, second)).toEqual(["OK", second.id, false, ADDRESSABLE_REJECT["address-quota"]]);
      });

      it("每作者總量滿 → quota（總量）", () => {
        const store = make({ addressableBytesPerAuthor: 800 });
        const sk = generateSecretKey();
        expect(send(store, addressable(sk, { d: "a", size: 300 }))?.[2]).toBe(true);
        const second = addressable(sk, { d: "b", size: 300 });
        expect(send(store, second)).toEqual(["OK", second.id, false, ADDRESSABLE_REJECT["byte-quota"]]);
      });

      it("自帶的 expiration 已過 → invalid: expired:", () => {
        const store = make({});
        const e = addressable(generateSecretKey(), { tags: [["expiration", String(NOW - 1)]] });
        expect(send(store, e)).toEqual(["OK", e.id, false, EXPIRED_REJECT]);
        expect(store.putAddressableResult!(e, NOW)).toEqual({ ok: false, reason: "expired" });
      });

      it("嚴格平面的 DO 天花板滿 → ceiling；車道淘汰則照收", () => {
        const strict = make({ addressableMaxTotalBytes: 1500 });
        expect(send(strict, addressable(generateSecretKey(), { size: 800 }))?.[2]).toBe(true);
        const e = addressable(generateSecretKey(), { size: 800 });
        expect(send(strict, e)).toEqual(["OK", e.id, false, ADDRESSABLE_REJECT.ceiling]);

        const lane = make({ addressableMaxTotalBytes: 1500, ceilingEvicts: true });
        expect(send(lane, addressable(generateSecretKey(), { size: 800 }))?.[2]).toBe(true);
        expect(send(lane, addressable(generateSecretKey(), { size: 800 }))?.[2]).toBe(true);
      });

      it("putAddressable（boolean）照舊可用：與 putAddressableResult 的 ok 一致", () => {
        const store = make({ addressablePerAuthor: 1 });
        const sk = generateSecretKey();
        expect(store.putAddressable(addressable(sk, { d: "a" }), NOW)).toBe(true);
        expect(store.putAddressable(addressable(sk, { d: "b" }), NOW)).toBe(false);
        expect(store.putAddressableResult!(addressable(sk, { d: "c" }), NOW)).toEqual({ ok: false, reason: "address-quota" });
      });
    });
  }

  it("只實作 boolean 的自訂 store：回舊句子（沒有詞元）", () => {
    const store: OfflineStore = { put: () => true, putAddressable: () => false, query: () => [], prune: () => {}, vanish: () => 0 };
    const e = addressable(generateSecretKey());
    const core = new RelayCore({ store, now: () => NOW });
    core.connect("c");
    expect(okOf(core.handle("c", EVENT(e)), e.id)).toEqual(["OK", e.id, false, ADDRESSABLE_REJECT_GENERIC]);
  });
});

describe("duplicate 改回 OK true（SDK ADR 0038 決策 3；NIP-01）", () => {
  const wrap = () =>
    finalizeEvent({ kind: 1059, created_at: NOW, tags: [["p", "a".repeat(64)]], content: "x" }, generateSecretKey());

  it("重放窗內再送同一顆：OK true「duplicate: seen:」，不再扇出、不再寫庫", () => {
    const stored: string[] = [];
    const store: OfflineStore = {
      put: (e) => (stored.push(e.id), true),
      putAddressable: () => true,
      query: () => [],
      prune: () => {},
      vanish: () => 0,
    };
    const core = new RelayCore({ store, now: () => NOW, replayWindowSec: 3600 });
    core.connect("sender");
    core.connect("watcher");
    core.handle("watcher", JSON.stringify(["REQ", "s", { kinds: [1059] }]));
    const e = wrap();
    expect(core.handle("sender", EVENT(e))).toContainEqual({ to: "watcher", message: ["EVENT", "s", e] });
    const again = core.handle("sender", EVENT(e));
    expect(again).toEqual([{ to: "sender", message: ["OK", e.id, true, REJECT.duplicate] }]);
    expect(stored).toEqual([e.id]);
  });

  it("🔴 store 丟例外：這顆不留在重放快取（否則重送只會拿到 duplicate＝被當成送達）", () => {
    let explode = true;
    const store: OfflineStore = {
      put: () => {
        if (explode) throw new Error("SQLITE_FULL");
        return true;
      },
      putAddressable: () => true,
      query: () => [],
      prune: () => {},
      vanish: () => 0,
    };
    const core = new RelayCore({ store, now: () => NOW, replayWindowSec: 3600 });
    core.connect("sender");
    const e = wrap();
    expect(core.handle("sender", EVENT(e))).toEqual([{ to: "sender", message: ["NOTICE", REJECT.internal] }]);
    explode = false;
    expect(okOf(core.handle("sender", EVENT(e)), e.id)).toEqual(["OK", e.id, true, ""]);
  });

  it("被拒（v0.31.1）之後重送仍是收下，而不是 duplicate", () => {
    let full = true;
    const store: OfflineStore = { put: () => !full, putAddressable: () => true, query: () => [], prune: () => {}, vanish: () => 0 };
    const core = new RelayCore({ store, now: () => NOW, replayWindowSec: 3600 });
    core.connect("sender");
    const e = wrap();
    expect(okOf(core.handle("sender", EVENT(e)), e.id)?.[3]).toBe(OFFLINE_CEILING_REJECT);
    full = false;
    expect(okOf(core.handle("sender", EVENT(e)), e.id)).toEqual(["OK", e.id, true, ""]);
    expect(okOf(core.handle("sender", EVENT(e)), e.id)).toEqual(["OK", e.id, true, REJECT.duplicate]);
  });
});

describe("RelayCore 送出的每一則拒收都帶詞元", () => {
  it("一輪常見的拒收情境：OK false、CLOSED、NOTICE 全部認得出詞元", () => {
    const core = new RelayCore({
      requireAuth: true,
      authChallenge: () => "ch",
      maxSubscriptions: 1,
      minPowDifficulty: 30,
      maxEventsPerMinute: 1000,
      now: () => NOW,
      store: new MessageStore(),
    });
    const sk = generateSecretKey();
    const messages: string[] = [];
    const collect = (out: ReturnType<RelayCore["handle"]>) => {
      for (const o of out) {
        const m = o.message;
        if (m[0] === "OK" && m[2] === false) messages.push(String(m[3]));
        if (m[0] === "CLOSED" || m[0] === "NOTICE") messages.push(String(m[m[0] === "CLOSED" ? 2 : 1]));
      }
    };
    core.connect("c", "relay.example");
    const e = finalizeEvent({ kind: 1, created_at: NOW, tags: [], content: "" }, sk);
    collect(core.handle("c", EVENT(e))); // auth-required
    collect(core.handle("c", JSON.stringify(["REQ", "s", { kinds: [1] }]))); // auth-required（CLOSED）
    collect(core.handle("c", JSON.stringify(["AUTH", buildAuthEvent("wrong", "wss://relay.example", sk)]))); // auth-failed
    core.handle("c", JSON.stringify(["AUTH", buildAuthEvent("ch", "wss://relay.example", sk)]));
    collect(core.handle("c", JSON.stringify(["REQ", "s", { kinds: [1] }]))); // restricted: scope
    core.handle("c", JSON.stringify(["REQ", "ok", { authors: ["a".repeat(64)] }]));
    collect(core.handle("c", JSON.stringify(["REQ", "two", { authors: ["a".repeat(64)] }]))); // subscriptions
    collect(core.handle("c", EVENT(e))); // pow
    collect(core.handle("c", EVENT({ ...e, content: "tampered" }))); // bad-signature
    collect(core.handle("c", "not json")); // malformed
    expect(messages.length).toBeGreaterThanOrEqual(8);
    for (const message of messages) expect(classifyRelayMessage(message).token, message).toBeDefined();
  });
});
