import { describe, expect, it } from "vitest";
import {
  AUTH_KIND,
  authChallengeOf,
  authRelayMatches,
  authRelayOf,
  buildAuthEvent,
  relayHostOf,
} from "../../src/protocol/nip42.js";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { verifyEvent } from "../../src/protocol/sign.js";

describe("NIP-42 AUTH（ADR-0057）", () => {
  it("buildAuthEvent：kind 22242、帶 relay/challenge tag、簽章有效、作者為簽章者", () => {
    const sk = generateSecretKey();
    const ev = buildAuthEvent("chal-abc", "wss://relay.example", sk);
    expect(ev.kind).toBe(AUTH_KIND);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.tags).toContainEqual(["relay", "wss://relay.example"]);
    expect(ev.tags).toContainEqual(["challenge", "chal-abc"]);
  });

  it("authChallengeOf：取回 challenge tag 值；無則 undefined", () => {
    const ev = buildAuthEvent("xyz-123", "wss://r", generateSecretKey());
    expect(authChallengeOf(ev)).toBe("xyz-123");
    expect(authChallengeOf({ ...ev, tags: [] })).toBeUndefined();
  });
});

// ADR-0235 H2：NIP-42 規範要求驗證 `relay` tag。只比對 challenge 相符擋不住「惡意中繼把
// 真中繼的挑戰轉發給受害者、再把受害者的簽名轉交回去」的中間人轉發攻擊。
describe("relay tag 驗證（ADR-0235 H2）", () => {
  const sk = generateSecretKey();
  const ev = (relayUrl: string) => buildAuthEvent("chal-1", relayUrl, sk);

  it("relayHostOf：忽略 scheme／路徑／大小寫，保留 port", () => {
    expect(relayHostOf("wss://Relay.Example.com/")).toBe("relay.example.com");
    expect(relayHostOf("https://relay.example.com/nostr")).toBe("relay.example.com");
    expect(relayHostOf("relay.example.com")).toBe("relay.example.com");
    expect(relayHostOf("ws://localhost:8787")).toBe("localhost:8787");
    expect(relayHostOf(undefined)).toBeUndefined();
    expect(relayHostOf("")).toBeUndefined();
  });

  it("authRelayOf 取出 relay tag；缺少時 undefined", () => {
    expect(authRelayOf(ev("wss://a.example"))).toBe("wss://a.example");
    expect(authRelayOf({ ...ev("wss://a.example"), tags: [["challenge", "x"]] })).toBeUndefined();
  });

  it("同一主機不同 scheme／尾斜線視為相符（客戶端記 wss://，中繼收到 https://）", () => {
    const e = ev("wss://relay.example.com");
    expect(authRelayMatches(e, "https://relay.example.com/")).toBe(true);
    expect(authRelayMatches(e, "relay.example.com")).toBe(true);
  });

  it("🔴 主機不符即拒——這正是中間人轉發攻擊被擋下的地方", () => {
    // 受害者以為自己在對 evil.example 認證，簽出的事件帶 relay: evil.example。
    const victimAuth = ev("wss://evil.example");
    // 攻擊者把它轉交給真中繼；真中繼一看主機不是自己 → 拒收。
    expect(authRelayMatches(victimAuth, "wss://relay.example.com")).toBe(false);
  });

  it("缺少 relay tag 一律不相符（不能因為「沒宣稱」就放行）", () => {
    const noTag = { ...ev("wss://a.example"), tags: [["challenge", "chal-1"]] };
    expect(authRelayMatches(noTag, "wss://a.example")).toBe(false);
  });
});
