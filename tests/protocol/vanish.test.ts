import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { verifyEvent } from "../../src/protocol/sign.js";
import { ALL_RELAYS, buildVanishRequest, VANISH_KIND, vanishTargetsOf, vanishTargetsRelay } from "../../src/protocol/vanish.js";

const sk = generateSecretKey();

describe("NIP-62 清除請求（ADR-0260）", () => {
  it("建構：kind 62、本人簽章、relay tag 帶目標", () => {
    const evt = buildVanishRequest("wss://relay.example", sk, { created_at: 1000 });
    expect(evt.kind).toBe(VANISH_KIND);
    expect(evt.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(evt)).toBe(true);
    expect(vanishTargetsOf(evt)).toEqual(["wss://relay.example"]);
  });

  it("reason 只進 content，中繼不得據以判斷", () => {
    expect(buildVanishRequest(ALL_RELAYS, sk, { reason: "離職" }).content).toBe("離職");
    expect(buildVanishRequest(ALL_RELAYS, sk).content).toBe("");
  });

  describe("目標比對", () => {
    it("比對主機，不逐字比對 URL（wss://host vs https://host/）", () => {
      const evt = buildVanishRequest("wss://relay.example", sk);
      expect(vanishTargetsRelay(evt, "relay.example")).toBe(true);
      expect(vanishTargetsRelay(evt, "https://relay.example/")).toBe(true);
      expect(vanishTargetsRelay(evt, "other.example")).toBe(false);
    });

    it("ALL_RELAYS 對任何站成立（含不知道自己主機時）", () => {
      const evt = buildVanishRequest(ALL_RELAYS, sk);
      expect(vanishTargetsRelay(evt, "relay.example")).toBe(true);
      expect(vanishTargetsRelay(evt, undefined)).toBe(true);
    });

    it("fail-closed：無 relay tag → false", () => {
      const evt = { ...buildVanishRequest("wss://relay.example", sk), tags: [] };
      expect(vanishTargetsRelay(evt, "relay.example")).toBe(false);
    });

    it("fail-closed：宿主不知道自己主機時，具名目標一律不成立", () => {
      // 放寬會讓「發給 A 站的請求」把 B 站的資料也清掉——不可逆的動作不對模糊輸入寬容。
      const evt = buildVanishRequest("wss://relay.example", sk);
      expect(vanishTargetsRelay(evt, undefined)).toBe(false);
    });

    it("多個 relay tag：其一命中即成立", () => {
      const evt = buildVanishRequest("wss://a.example", sk);
      const multi = { ...evt, tags: [...evt.tags, ["relay", "wss://b.example"]] };
      expect(vanishTargetsRelay(multi, "b.example")).toBe(true);
      expect(vanishTargetsRelay(multi, "c.example")).toBe(false);
    });
  });
});
