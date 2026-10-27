import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { finalizeEvent } from "../../src/protocol/sign.js";
import {
  HTTP_AUTH_KIND,
  buildHttpAuthEvent,
  httpAuthHeader,
  verifyHttpAuth,
} from "../../src/protocol/http-auth.js";

const URL_A = "https://relay.example/turn";
const URL_B = "https://relay.example/other";

/** 簽好並包成標頭（正常路徑）。 */
function sign(sk: Uint8Array, url = URL_A, method = "GET", now = 1_000_000): string {
  return httpAuthHeader(buildHttpAuthEvent(url, method, sk, now));
}

describe("HTTP 請求簽章（ADR-0342 §3.2 / NIP-98）", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const now = 1_000_000;

  it("合法簽章 → 回傳簽署者 pubkey", () => {
    expect(verifyHttpAuth(sign(sk), URL_A, "GET", now)).toBe(pk);
  });

  it("method 大小寫不敏感（簽與驗兩側都正規化）", () => {
    expect(verifyHttpAuth(sign(sk, URL_A, "get"), URL_A, "GET", now)).toBe(pk);
    expect(verifyHttpAuth(sign(sk, URL_A, "GET"), URL_A, "get", now)).toBe(pk);
  });

  it("沒有標頭 → null", () => {
    expect(verifyHttpAuth(null, URL_A, "GET", now)).toBeNull();
    expect(verifyHttpAuth("", URL_A, "GET", now)).toBeNull();
  });

  it("標頭格式不對 → null", () => {
    expect(verifyHttpAuth("Bearer abc", URL_A, "GET", now)).toBeNull();
    expect(verifyHttpAuth("Nostr", URL_A, "GET", now)).toBeNull();
    expect(verifyHttpAuth("Nostr 不是base64", URL_A, "GET", now)).toBeNull();
  });

  it("🔴 綁定 URL——對 A 端點簽的不能拿去打 B 端點", () => {
    expect(verifyHttpAuth(sign(sk, URL_A), URL_B, "GET", now)).toBeNull();
  });

  it("🔴 綁定 method——GET 的簽章不能拿去 POST", () => {
    expect(verifyHttpAuth(sign(sk, URL_A, "GET"), URL_A, "POST", now)).toBeNull();
  });

  it("🔴 綁定時間——超出偏移窗即失效（否則永久可重放）", () => {
    const h = sign(sk, URL_A, "GET", now);
    expect(verifyHttpAuth(h, URL_A, "GET", now + 59)).toBe(pk);
    expect(verifyHttpAuth(h, URL_A, "GET", now + 61)).toBeNull();
    // 未來的時間戳同樣要擋（時鐘往前撥不該換到更長的有效期）。
    expect(verifyHttpAuth(h, URL_A, "GET", now - 61)).toBeNull();
  });

  it("kind 不對 → null（不接受隨便一種簽過的事件）", () => {
    const wrong = finalizeEvent(
      { kind: 1, created_at: now, tags: [["u", URL_A], ["method", "GET"]], content: "" },
      sk,
    );
    expect(verifyHttpAuth(httpAuthHeader(wrong), URL_A, "GET", now)).toBeNull();
  });

  it("簽章被竄改 → null", () => {
    const ev = buildHttpAuthEvent(URL_A, "GET", sk, now);
    const tampered = { ...ev, pubkey: getPublicKey(generateSecretKey()) };
    expect(verifyHttpAuth(httpAuthHeader(tampered), URL_A, "GET", now)).toBeNull();
  });

  it("🔴 ADR-0235 C1：畸形 tags 必須在驗章**之前**被擋掉", () => {
    // verifyEvent 只保證雜湊與簽章相符，完全不檢查欄位型別——攻擊者可以對
    // `{tags:{}}` 這種形狀自簽並通過驗章，後續 `tags.find(...)` 會拋 TypeError。
    for (const bad of [{ tags: {} }, { tags: "x" }, { tags: [[1, 2]] }, { tags: [null] }]) {
      const ev = { ...buildHttpAuthEvent(URL_A, "GET", sk, now), ...bad };
      expect(() => verifyHttpAuth(httpAuthHeader(ev as never), URL_A, "GET", now)).not.toThrow();
      expect(verifyHttpAuth(httpAuthHeader(ev as never), URL_A, "GET", now)).toBeNull();
    }
  });

  it("缺欄位／型別錯 → null 且不丟例外", () => {
    for (const bad of [{ id: 1 }, { pubkey: null }, { sig: {} }, { content: 5 }, { kind: "x" }, { created_at: "x" }]) {
      const ev = { ...buildHttpAuthEvent(URL_A, "GET", sk, now), ...bad };
      expect(() => verifyHttpAuth(httpAuthHeader(ev as never), URL_A, "GET", now)).not.toThrow();
      expect(verifyHttpAuth(httpAuthHeader(ev as never), URL_A, "GET", now)).toBeNull();
    }
  });

  it("非物件 / 陣列 → null", () => {
    for (const bad of ["null", "[]", '"x"', "3"]) {
      expect(verifyHttpAuth(`Nostr ${btoa(bad)}`, URL_A, "GET", now)).toBeNull();
    }
  });

  it("事件本身用的是約定的 kind 與 tags", () => {
    const ev = buildHttpAuthEvent(URL_A, "GET", sk, now);
    expect(ev.kind).toBe(HTTP_AUTH_KIND);
    expect(ev.tags).toEqual([["u", URL_A], ["method", "GET"]]);
    expect(ev.content).toBe("");
  });
});

describe("非 ASCII 端點（審查發現 #5）", () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const now = 1_000_000;

  it("🔴 IDN 主機名／非 ASCII 路徑不得讓編碼丟例外", () => {
    // `btoa` 只吃 Latin-1，碼位 > U+00FF 會丟 InvalidCharacterError。
    for (const url of ["https://中繼.example/turn", "https://relay.example/轉發", "https://ex.example/ü"]) {
      expect(() => httpAuthHeader(buildHttpAuthEvent(url, "GET", sk, now))).not.toThrow();
      expect(verifyHttpAuth(httpAuthHeader(buildHttpAuthEvent(url, "GET", sk, now)), url, "GET", now)).toBe(pk);
    }
  });

  it("非 ASCII 的 URL 一樣要綁定（不能因為編碼路徑不同就鬆掉）", () => {
    const h = httpAuthHeader(buildHttpAuthEvent("https://中繼.example/turn", "GET", sk, now));
    expect(verifyHttpAuth(h, "https://別的.example/turn", "GET", now)).toBeNull();
  });
});
