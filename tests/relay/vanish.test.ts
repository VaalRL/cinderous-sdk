// NIP-62 Request to Vanish 的中繼端行為（ADR-0260）。
import {
  ALL_RELAYS,
  buildAuthEvent,
  buildVanishRequest,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type NostrEvent,
} from "../../src/protocol/index.js";
import { describe, expect, it } from "vitest";
import { MessageStore } from "../../src/relay/message-store.js";
import { RelayCore } from "../../src/relay/relay-core.js";

const HOST = "relay.example";
const URL = `wss://${HOST}`;
const NOW = 1_700_000_000;

const EVENT = (e: NostrEvent) => JSON.stringify(["EVENT", e]);

/** 一則寄給 `to` 的離線留言（Gift Wrap 形狀：外層作者是一次性金鑰）。 */
function giftWrap(to: string, createdAt = NOW): NostrEvent {
  return finalizeEvent(
    { kind: 1059, created_at: createdAt, tags: [["p", to]], content: "密文" },
    generateSecretKey(), // ← 一次性金鑰：pubkey 欄位查不到真正的寄件者
  );
}

/** 建一座要求 AUTH 的中繼，並讓 `sk` 完成認證。 */
function authedCore(sk: Uint8Array, store: MessageStore): RelayCore {
  const core = new RelayCore({ store, requireAuth: true, now: () => NOW, authChallenge: () => "chal" });
  core.connect("c1", HOST);
  core.handle("c1", JSON.stringify(["AUTH", buildAuthEvent("chal", URL, sk, { created_at: NOW })]));
  return core;
}

describe("NIP-62 中繼端清除（ADR-0260）", () => {
  it("清掉寄給我的 Gift Wrap——即使外層作者是一次性金鑰", () => {
    const sk = generateSecretKey();
    const me = getPublicKey(sk);
    const store = new MessageStore({ maxPerRecipient: 500 });
    store.put(giftWrap(me), NOW);
    store.put(giftWrap(me), NOW);
    expect(store.query({ "#p": [me] }, NOW).length).toBe(2);

    const core = authedCore(sk, store);
    const out = core.handle("c1", EVENT(buildVanishRequest(URL, sk, { created_at: NOW })));

    expect(out.some((o) => o.message[0] === "OK" && o.message[2] === true)).toBe(true);
    expect(store.query({ "#p": [me] }, NOW)).toEqual([]);
  });

  it("清掉我發的事件，但不動別人的", () => {
    const sk = generateSecretKey();
    const me = getPublicKey(sk);
    const other = generateSecretKey();
    const store = new MessageStore({ maxPerRecipient: 500 });
    const mine = finalizeEvent({ kind: 1059, created_at: NOW, tags: [["p", "x".repeat(64)]], content: "a" }, sk);
    const theirs = finalizeEvent({ kind: 1059, created_at: NOW, tags: [["p", "x".repeat(64)]], content: "b" }, other);
    store.put(mine, NOW);
    store.put(theirs, NOW);

    authedCore(sk, store).handle("c1", EVENT(buildVanishRequest(URL, sk, { created_at: NOW })));

    const left = store.query({ "#p": ["x".repeat(64)] }, NOW);
    expect(left.map((e) => e.id)).toEqual([theirs.id]);
    expect(left.every((e) => e.pubkey !== me)).toBe(true);
  });

  it("清掉我的可尋址事件（雲端快照）", () => {
    const sk = generateSecretKey();
    const me = getPublicKey(sk);
    const store = new MessageStore();
    const snap = finalizeEvent({ kind: 30078, created_at: NOW, tags: [["d", "dev1"]], content: "密文" }, sk);
    expect(store.putAddressable(snap, NOW)).toBe(true);
    expect(store.query({ authors: [me], kinds: [30078] }, NOW).length).toBe(1);

    authedCore(sk, store).handle("c1", EVENT(buildVanishRequest(URL, sk, { created_at: NOW })));

    expect(store.query({ authors: [me], kinds: [30078] }, NOW)).toEqual([]);
  });

  it("ALL_RELAYS 同樣生效", () => {
    const sk = generateSecretKey();
    const me = getPublicKey(sk);
    const store = new MessageStore({ maxPerRecipient: 500 });
    store.put(giftWrap(me), NOW);

    authedCore(sk, store).handle("c1", EVENT(buildVanishRequest(ALL_RELAYS, sk, { created_at: NOW })));

    expect(store.query({ "#p": [me] }, NOW)).toEqual([]);
  });

  it("relay tag 指向別座 → 拒絕，資料不動", () => {
    const sk = generateSecretKey();
    const me = getPublicKey(sk);
    const store = new MessageStore({ maxPerRecipient: 500 });
    store.put(giftWrap(me), NOW);

    const core = authedCore(sk, store);
    const out = core.handle("c1", EVENT(buildVanishRequest("wss://other.example", sk, { created_at: NOW })));

    expect(out.some((o) => o.message[0] === "OK" && o.message[2] === false)).toBe(true);
    expect(store.query({ "#p": [me] }, NOW).length).toBe(1);
  });

  it("認證身分不符 → 拒絕（擋重放：側錄到的舊 vanish 事件過不了他人的 AUTH）", () => {
    const victimSk = generateSecretKey();
    const victim = getPublicKey(victimSk);
    const attackerSk = generateSecretKey();
    const store = new MessageStore({ maxPerRecipient: 500 });
    store.put(giftWrap(victim), NOW);

    // 攻擊者以自己的身分認證，卻轉送受害者簽的 vanish 事件。
    const core = authedCore(attackerSk, store);
    const out = core.handle("c1", EVENT(buildVanishRequest(URL, victimSk, { created_at: NOW })));

    expect(out.some((o) => o.message[0] === "OK" && o.message[2] === false)).toBe(true);
    expect(store.query({ "#p": [victim] }, NOW).length).toBe(1); // 受害者的信還在
  });

  it("是命令不是留言：不寫庫、不扇出", () => {
    const sk = generateSecretKey();
    const store = new MessageStore({ maxPerRecipient: 500 });
    const core = authedCore(sk, store);

    // 另一條連線訂閱 kind 62——不該收到任何東西（廣播「某人要求清除」本身就是元資料洩漏）。
    const watcherSk = generateSecretKey();
    core.connect("c2", HOST);
    core.handle("c2", JSON.stringify(["AUTH", buildAuthEvent("chal", URL, watcherSk, { created_at: NOW })]));
    core.handle("c2", JSON.stringify(["REQ", "s1", { kinds: [62], authors: [getPublicKey(sk)] }]));

    const out = core.handle("c1", EVENT(buildVanishRequest(URL, sk, { created_at: NOW })));

    expect(out.every((o) => o.to === "c1")).toBe(true); // 沒有扇出
    expect(store.query({ kinds: [62] }, NOW)).toEqual([]); // 沒寫庫
  });

  it("無 AUTH 的自架站也能用（主機資訊與 AUTH 狀態分離）", () => {
    const sk = generateSecretKey();
    const me = getPublicKey(sk);
    const store = new MessageStore({ maxPerRecipient: 500 });
    store.put(giftWrap(me), NOW);

    const core = new RelayCore({ store, now: () => NOW }); // requireAuth 未開
    core.connect("c1", HOST);
    core.handle("c1", EVENT(buildVanishRequest(URL, sk, { created_at: NOW })));

    expect(store.query({ "#p": [me] }, NOW)).toEqual([]);
  });

  it("同一顆事件寄給多人時，只清請求者那一份", () => {
    const skA = generateSecretKey();
    const a = getPublicKey(skA);
    const b = getPublicKey(generateSecretKey());
    const store = new MessageStore({ maxPerRecipient: 500 });
    const shared = finalizeEvent(
      { kind: 1059, created_at: NOW, tags: [["p", a], ["p", b]], content: "密文" },
      generateSecretKey(),
    );
    store.put(shared, NOW);

    authedCore(skA, store).handle("c1", EVENT(buildVanishRequest(URL, skA, { created_at: NOW })));

    expect(store.query({ "#p": [a] }, NOW)).toEqual([]);
    expect(store.query({ "#p": [b] }, NOW).length).toBe(1); // B 的那份仍在，且仍受 TTL 管轄
    expect(store.query({ "#p": [b] }, NOW + 8 * 86_400)).toEqual([]); // 到期照樣收得走
  });
});
