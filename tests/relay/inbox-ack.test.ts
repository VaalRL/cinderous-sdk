// 收件確認後提早過期（SDK ADR 0067）：中繼端。
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  buildAuthEvent,
  buildInboxAck,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  INBOX_ACK_KIND,
  type NostrEvent,
} from "../../src/protocol/index.js";
import { MessageStore, type OfflineStore } from "../../src/relay/message-store.js";
import { REJECT } from "../../src/relay/reject-messages.js";
import { RelayCore, type RelayCoreOptions } from "../../src/relay/relay-core.js";
import { type SqlExec, SqlMessageStore } from "../../src/relay/sql-message-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

function nodeSqlExec(): SqlExec {
  const db = new DatabaseSync(":memory:");
  return (query, ...bindings) => {
    const stmt = db.prepare(query);
    if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
    stmt.run(...bindings);
    return [];
  };
}

const HOST = "relay.example";
const URL = `wss://${HOST}`;
const NOW = 1_700_000_000;
const DAY = 86_400;
const GRACE = 7_200;
const EVENT = (e: NostrEvent) => JSON.stringify(["EVENT", e]);

/** 一顆寄給 `to` 的包（外層作者是一次性金鑰；帶 7 天的 `expiration`）。 */
function wrap(to: string | string[], kind = 1060): NostrEvent {
  const tags = (Array.isArray(to) ? to : [to]).map((p) => ["p", p]);
  tags.push(["expiration", String(NOW + 7 * DAY)]);
  return finalizeEvent({ kind, created_at: NOW - 3600, tags, content: "密文" }, generateSecretKey());
}

const stores: [string, () => OfflineStore][] = [
  ["MessageStore", () => new MessageStore({ maxPerRecipient: 500 })],
  ["SqlMessageStore", () => new SqlMessageStore(nodeSqlExec(), { maxPerRecipient: 500 })],
];

describe.each(stores)("%s.ackInbox（SDK ADR 0067 §1）", (_name, make) => {
  const me = getPublicKey(generateSecretKey());
  const other = getPublicKey(generateSecretKey());
  const ids = (store: OfflineStore, who: string, at: number) =>
    store.query({ "#p": [who] }, at).map((e) => e.id).sort();

  it("把自己收件匣裡、清單上的列降為指定時間到期；回傳降了幾列", () => {
    const store = make();
    const a = wrap(me);
    const b = wrap(me);
    const c = wrap(me);
    for (const e of [a, b, c]) store.put(e, NOW);
    expect(store.ackInbox!(me, [a.id, b.id], NOW + GRACE, NOW)).toBe(2);
    expect(ids(store, me, NOW + GRACE - 1)).toEqual([a.id, b.id, c.id].sort());
    expect(ids(store, me, NOW + GRACE)).toEqual([c.id]);
  });

  it("只動寄給自己的列：別人的列、別人的 id 都不動", () => {
    const store = make();
    const mine = wrap(me);
    const theirs = wrap(other);
    store.put(mine, NOW);
    store.put(theirs, NOW);
    expect(store.ackInbox!(me, [mine.id, theirs.id], NOW + GRACE, NOW)).toBe(1);
    expect(ids(store, other, NOW + GRACE)).toEqual([theirs.id]);
  });

  it("寄給多位收件人的事件不動（記憶體版的到期時間是每顆事件一份，降了會連累別人）", () => {
    const store = make();
    const shared = wrap([me, other]);
    store.put(shared, NOW);
    expect(store.ackInbox!(me, [shared.id], NOW + GRACE, NOW)).toBe(0);
    expect(ids(store, me, NOW + GRACE)).toEqual([shared.id]);
    expect(ids(store, other, NOW + GRACE)).toEqual([shared.id]);
  });

  it("只會提早、不會延後：已經比寬限早到期的不變，也不算進回傳", () => {
    const store = make();
    const soon = finalizeEvent(
      { kind: 1060, created_at: NOW, tags: [["p", me], ["expiration", String(NOW + 60)]], content: "x" },
      generateSecretKey(),
    );
    store.put(soon, NOW);
    expect(store.ackInbox!(me, [soon.id], NOW + GRACE, NOW)).toBe(0);
    expect(ids(store, me, NOW + 60)).toEqual([]);
  });

  it("不在庫裡的 id 直接忽略", () => {
    const store = make();
    expect(store.ackInbox!(me, ["ab".repeat(32)], NOW + GRACE, NOW)).toBe(0);
  });

  it("降級後 prune 收得走", () => {
    const store = make();
    const a = wrap(me);
    store.put(a, NOW);
    store.ackInbox!(me, [a.id], NOW + GRACE, NOW);
    store.prune(NOW + GRACE);
    expect(ids(store, me, NOW)).toEqual([]);
  });
});

describe("RelayCore：收件確認（SDK ADR 0067 §1、§2）", () => {
  const sk = generateSecretKey();
  const me = getPublicKey(sk);

  function setup(opts: Partial<RelayCoreOptions> = {}) {
    const store = new MessageStore({ maxPerRecipient: 500 });
    const core = new RelayCore({
      store,
      requireAuth: true,
      now: () => NOW,
      authChallenge: () => "chal",
      inboxAckGraceSec: GRACE,
      ...opts,
    });
    const auth = (conn: string, key: Uint8Array) => {
      core.connect(conn, HOST);
      core.handle(conn, JSON.stringify(["AUTH", buildAuthEvent("chal", URL, key, { created_at: NOW })]));
    };
    return { store, core, auth };
  }

  it("已認證的本人送確認：OK true、那幾列在寬限後消失", () => {
    const { store, core, auth } = setup();
    const a = wrap(me);
    const b = wrap(me);
    store.put(a, NOW);
    store.put(b, NOW);
    auth("c1", sk);
    const out = core.handle("c1", EVENT(buildInboxAck([a.id], sk, { created_at: NOW })));
    expect(out).toHaveLength(1);
    expect(out[0]!.message.slice(0, 3)).toEqual(["OK", out[0]!.message[1], true]);
    expect(store.query({ "#p": [me] }, NOW + GRACE).map((e) => e.id)).toEqual([b.id]);
  });

  it("不存、不轉發：連本人訂閱了這個 kind 也收不到", () => {
    const { store, core, auth } = setup();
    auth("c1", sk);
    auth("c2", sk);
    core.handle("c2", JSON.stringify(["REQ", "s", { kinds: [INBOX_ACK_KIND], authors: [me] }]));
    const a = wrap(me);
    store.put(a, NOW);
    const out = core.handle("c1", EVENT(buildInboxAck([a.id], sk, { created_at: NOW })));
    expect(out.every((o) => o.to === "c1")).toBe(true);
    expect(store.query({ kinds: [INBOX_ACK_KIND] }, NOW)).toEqual([]);
  });

  it("別人簽的確認（重放）：以自己身分認證也不行", () => {
    const { store, core, auth } = setup();
    const attacker = generateSecretKey();
    const a = wrap(me);
    store.put(a, NOW);
    auth("c1", attacker);
    const out = core.handle("c1", EVENT(buildInboxAck([a.id], sk, { created_at: NOW })));
    expect(out[0]!.message[2]).toBe(false);
    expect(out[0]!.message[3]).toBe(REJECT.ackSelfOnly);
    expect(store.query({ "#p": [me] }, NOW + GRACE).map((e) => e.id)).toEqual([a.id]);
  });

  it("沒認證：auth-required 並重發挑戰（車道不強制 AUTH 也一樣）", () => {
    const { core } = setup({ requireAuth: false, publicLane: true });
    core.connect("c1", HOST);
    const out = core.handle("c1", EVENT(buildInboxAck(["ab".repeat(32)], sk, { created_at: NOW })));
    expect(out[0]!.message).toEqual(["OK", expect.any(String), false, REJECT.authRequired]);
    expect(out[1]!.message).toEqual(["AUTH", "chal"]);
  });

  it("格式不對：invalid、不動任何列", () => {
    const { store, core, auth } = setup();
    const a = wrap(me);
    store.put(a, NOW);
    auth("c1", sk);
    const bad = finalizeEvent({ kind: INBOX_ACK_KIND, created_at: NOW, tags: [], content: `${a.id},xyz` }, sk);
    const out = core.handle("c1", EVENT(bad));
    expect(out[0]!.message[2]).toBe(false);
    expect(out[0]!.message[3]).toBe(REJECT.ackMalformed);
    expect(store.query({ "#p": [me] }, NOW + GRACE).map((e) => e.id)).toEqual([a.id]);
  });

  it("沒開（`inboxAckGraceSec` 未設）：當一般瞬時事件，不動任何列", () => {
    const { store, core, auth } = setup({ inboxAckGraceSec: undefined });
    const a = wrap(me);
    store.put(a, NOW);
    auth("c1", sk);
    auth("c2", sk);
    core.handle("c2", JSON.stringify(["REQ", "s", { kinds: [INBOX_ACK_KIND], authors: [me] }]));
    const out = core.handle("c1", EVENT(buildInboxAck([a.id], sk, { created_at: NOW })));
    expect(out.some((o) => o.to === "c2" && o.message[0] === "EVENT")).toBe(true);
    expect(store.query({ "#p": [me] }, NOW + GRACE).map((e) => e.id)).toEqual([a.id]);
  });
});
