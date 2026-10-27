import { describe, expect, it } from "vitest";
import { generateSecretKey, verifyHttpAuth } from "../../src/protocol/index.js";
import {
  TURN_TTL_FALLBACK_SEC,
  fetchTurnServers,
  parseTurnResponse,
  parseTurnTtl,
  turnEndpointCandidates,
  turnEndpointFromRelay,
  turnRefreshDelayMs,
  fetchTurnWithFallback,
  type TurnFetch,
} from "../../src/protocol/turn-fetch.js";

const SK = generateSecretKey();
const EP = "https://relay.example/turn";

// Cloudflare `/turn` 回應：iceServers 是**單一物件**（urls 陣列＋短期帳密）。
const cfBody = {
  iceServers: {
    urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"],
    username: "ephemeral-user",
    credential: "ephemeral-pass",
  },
};

function res(status: number, body?: unknown): ReturnType<TurnFetch> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  });
}

describe("parseTurnResponse（正規化 Cloudflare TURN 回應，ADR-0243）", () => {
  it("單一 iceServers 物件 → RTCIceServer[]（帶帳密）", () => {
    expect(parseTurnResponse(cfBody)).toEqual([
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"],
        username: "ephemeral-user",
        credential: "ephemeral-pass",
      },
    ]);
  });

  it("iceServers 為陣列亦可（多筆）", () => {
    const arr = { iceServers: [{ urls: "turn:a:3478", username: "u", credential: "p" }, { urls: "stun:b:3478" }] };
    expect(parseTurnResponse(arr)).toEqual([
      { urls: ["turn:a:3478"], username: "u", credential: "p" },
      { urls: ["stun:b:3478"] },
    ]);
  });

  it("過濾非 ICE scheme 的 url（防端點回傳被竄改注入 http 等）", () => {
    const bad = { iceServers: { urls: ["http://evil.example/x", "turn:ok:3478"], username: "u", credential: "p" } };
    expect(parseTurnResponse(bad)).toEqual([{ urls: ["turn:ok:3478"], username: "u", credential: "p" }]);
  });

  it("全部 url 皆非法 → 丟棄該筆", () => {
    expect(parseTurnResponse({ iceServers: { urls: ["http://evil"], username: "u", credential: "p" } })).toEqual([]);
  });

  it("空 / 畸形輸入 → []（no-op）", () => {
    expect(parseTurnResponse(null)).toEqual([]);
    expect(parseTurnResponse(undefined)).toEqual([]);
    expect(parseTurnResponse({})).toEqual([]);
    expect(parseTurnResponse({ iceServers: null })).toEqual([]);
    expect(parseTurnResponse("nope")).toEqual([]);
  });
});

describe("fetchTurnServers（抓短期憑證，失敗一律 no-op）", () => {
  it("200＋合法 body → 伺服器清單", async () => {
    const { servers } = await fetchTurnServers(EP, SK, () => res(200, cfBody));
    expect(servers).toHaveLength(1);
    expect(servers[0]?.username).toBe("ephemeral-user");
  });

  it("204（Worker 未配 secret）→ 空清單（退回純 STUN）", async () => {
    expect((await fetchTurnServers(EP, SK, () => res(204))).servers).toEqual([]);
  });

  it("🔴 401（沒帶/帶錯授權）→ 空清單，不報錯（ADR-0342 §3.2）", async () => {
    // TURN 是保底，拿不到就純 STUN，不該拖垮通話建立。
    expect((await fetchTurnServers(EP, SK, () => res(401))).servers).toEqual([]);
  });

  it("非 2xx → 空清單", async () => {
    expect((await fetchTurnServers(EP, SK, () => res(500, {}))).servers).toEqual([]);
  });

  it("fetch 拋（離線/DNS 失敗）→ 空清單", async () => {
    expect((await fetchTurnServers(EP, SK, () => Promise.reject(new Error("offline")))).servers).toEqual([]);
  });

  it("body 非 JSON（json() 拋）→ 空清單", async () => {
    expect((await fetchTurnServers(EP, SK, () => res(200))).servers).toEqual([]);
  });

  it("🔴 帶上可被 relay 驗證的授權標頭，且綁定的是這個端點", async () => {
    let auth: string | undefined;
    await fetchTurnServers(EP, SK, (_u, init) => {
      auth = init?.headers?.Authorization;
      return res(200, cfBody);
    });
    expect(verifyHttpAuth(auth ?? null, EP, "GET")).not.toBeNull();
    // 對別的端點驗不過——證明簽的是這個 URL 而不是隨便一個。
    expect(verifyHttpAuth(auth ?? null, "https://other.example/turn", "GET")).toBeNull();
  });

  it("⓪ 回應帶 ttl → 一併回傳（ADR-0342 §2）", async () => {
    const r = await fetchTurnServers(EP, SK, () => res(200, { ...cfBody, ttl: 300 }));
    expect(r.ttlSeconds).toBe(300);
  });

  it("⓪ 回應沒有 ttl（舊版 Worker）→ undefined，由排程套用退路", async () => {
    const r = await fetchTurnServers(EP, SK, () => res(200, cfBody));
    expect(r.ttlSeconds).toBeUndefined();
  });
});

describe("⓪ 刷新排程跟著 TTL（ADR-0342 §2）", () => {
  it("parseTurnTtl 只收正整數，其餘一律 undefined", () => {
    expect(parseTurnTtl({ ttl: 300 })).toBe(300);
    expect(parseTurnTtl({ ttl: 300.7 })).toBe(300);
    for (const bad of [{ ttl: 0 }, { ttl: -1 }, { ttl: "300" }, { ttl: NaN }, {}, null, "x"]) {
      expect(parseTurnTtl(bad)).toBeUndefined();
    }
  });

  it("🔴 半個 TTL——這正是先前寫死 6 小時所缺的", () => {
    expect(turnRefreshDelayMs(600)).toBe(300_000);
    expect(turnRefreshDelayMs(7200)).toBe(3600_000);
  });

  it("🔴 TTL 300（站方現行設定）→ 2.5 分鐘刷新一次，而不是 6 小時", () => {
    // 舊行為（6h）會讓 5 分鐘就過期的憑證在客戶端不知情下失效，TURN 形同不存在。
    expect(turnRefreshDelayMs(300)).toBe(150_000);
  });

  it("下限 60 秒——極短 TTL 不得把客戶端變成打樁機（也會撞速率限制）", () => {
    expect(turnRefreshDelayMs(10)).toBe(60_000);
    expect(turnRefreshDelayMs(1)).toBe(60_000);
  });

  it("上限 6 小時——憑證長效時不必無謂常刷", () => {
    expect(turnRefreshDelayMs(86400)).toBe(6 * 3600_000);
  });

  it("ttl 缺席 → 退回預設（對舊版 Worker 的 86400 很安全）", () => {
    expect(turnRefreshDelayMs(undefined)).toBe((TURN_TTL_FALLBACK_SEC / 2) * 1000);
  });
});

describe("turnEndpointFromRelay（由 relay URL 推導 /turn 端點）", () => {
  it("wss → https、ws → http，補 /turn", () => {
    expect(turnEndpointFromRelay("wss://cinder-relay.example.workers.dev")).toBe(
      "https://cinder-relay.example.workers.dev/turn",
    );
    expect(turnEndpointFromRelay("ws://localhost:8787")).toBe("http://localhost:8787/turn");
  });

  it("忽略尾斜線與路徑，只取 host", () => {
    expect(turnEndpointFromRelay("wss://relay.example/")).toBe("https://relay.example/turn");
  });

  it("非法/空 → undefined", () => {
    expect(turnEndpointFromRelay(undefined)).toBeUndefined();
    expect(turnEndpointFromRelay("http://not-ws")).toBeUndefined();
    expect(turnEndpointFromRelay("")).toBeUndefined();
  });
});

// ── TURN 錨點後備（ADR-0356 §6）────────────────────────────────────────────────

describe("turnEndpointCandidates", () => {
  const ANCHORS = ["wss://a.example", "wss://b.example"];

  it("home 排在錨點前面——那是使用者自己的站", () => {
    expect(turnEndpointCandidates("wss://mine.workers.dev", ANCHORS)).toEqual([
      "https://mine.workers.dev/turn",
      "https://a.example/turn",
      "https://b.example/turn",
    ]);
  });

  it("home 本來就是錨點之一時不重複問", () => {
    expect(turnEndpointCandidates("wss://a.example", ANCHORS)).toEqual([
      "https://a.example/turn",
      "https://b.example/turn",
    ]);
  });

  it("🔴 企業明指端點時只用它、不後備——自作主張問錨點等於把企業流量送給第三方", () => {
    expect(turnEndpointCandidates("wss://mine", ANCHORS, "https://corp.example/turn")).toEqual([
      "https://corp.example/turn",
    ]);
  });

  it("沒有 home（示範模式）也還有錨點可問", () => {
    expect(turnEndpointCandidates(undefined, ANCHORS)).toEqual([
      "https://a.example/turn",
      "https://b.example/turn",
    ]);
  });

  it("非 ws(s) 的項目被略過而不是變成壞端點", () => {
    expect(turnEndpointCandidates("http://nope", ["wss://a.example", "not-a-url"])).toEqual([
      "https://a.example/turn",
    ]);
  });

  it("什麼都沒有就是空陣列（呼叫端據此完全不打）", () => {
    expect(turnEndpointCandidates(undefined, [])).toEqual([]);
  });
});

describe("fetchTurnWithFallback", () => {
  const sk = new Uint8Array(32).fill(7) as unknown as Parameters<typeof fetchTurnWithFallback>[1];
  const okBody = { iceServers: [{ urls: ["turn:t.example:3478"], username: "u", credential: "c" }], ttl: 300 };

  /** 依端點決定回什麼；記下問過誰。 */
  function fakeFetch(by: Record<string, { status: number; body?: unknown }>) {
    const asked: string[] = [];
    const fn = (async (url: string) => {
      asked.push(url);
      const r = by[url] ?? { status: 500 };
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body ?? {},
      };
    }) as unknown as Parameters<typeof fetchTurnWithFallback>[2];
    return { fn, asked };
  }

  it("home 給得出憑證 → 就用它，錨點連問都不問", async () => {
    const f = fakeFetch({ "https://mine/turn": { status: 200, body: okBody } });
    const got = await fetchTurnWithFallback(["https://mine/turn", "https://a/turn"], sk, f.fn);
    expect(got.servers).toHaveLength(1);
    expect(got.endpoint).toBe("https://mine/turn");
    expect(f.asked).toEqual(["https://mine/turn"]);
  });

  it("🔴 home 回 204（自架站沒配 TURN）→ 改問錨點，通話保底還在", async () => {
    const f = fakeFetch({
      "https://mine/turn": { status: 204 },
      "https://a/turn": { status: 200, body: okBody },
    });
    const got = await fetchTurnWithFallback(["https://mine/turn", "https://a/turn"], sk, f.fn);
    expect(got.endpoint).toBe("https://a/turn");
    expect(got.ttlSeconds).toBe(300);
    expect(f.asked).toEqual(["https://mine/turn", "https://a/turn"]);
  });

  it("前面幾座都掛了就繼續往下問", async () => {
    const f = fakeFetch({
      "https://mine/turn": { status: 500 },
      "https://a/turn": { status: 401 },
      "https://b/turn": { status: 200, body: okBody },
    });
    const got = await fetchTurnWithFallback(
      ["https://mine/turn", "https://a/turn", "https://b/turn"],
      sk,
      f.fn,
    );
    expect(got.endpoint).toBe("https://b/turn");
    expect(f.asked).toHaveLength(3);
  });

  it("全部都給不出來 → 空清單（退回純 STUN，與過去行為相同）", async () => {
    const f = fakeFetch({ "https://mine/turn": { status: 204 }, "https://a/turn": { status: 204 } });
    const got = await fetchTurnWithFallback(["https://mine/turn", "https://a/turn"], sk, f.fn);
    expect(got.servers).toEqual([]);
    expect(got.endpoint).toBeUndefined();
  });

  it("沒有候選端點時一個請求都不發", async () => {
    const f = fakeFetch({});
    const got = await fetchTurnWithFallback([], sk, f.fn);
    expect(got.servers).toEqual([]);
    expect(f.asked).toEqual([]);
  });

  it("回應有 iceServers 但全是畸形 URL → 當成沒給，繼續後備", async () => {
    const f = fakeFetch({
      "https://mine/turn": { status: 200, body: { iceServers: [{ urls: ["javascript:alert(1)"] }] } },
      "https://a/turn": { status: 200, body: okBody },
    });
    const got = await fetchTurnWithFallback(["https://mine/turn", "https://a/turn"], sk, f.fn);
    expect(got.endpoint).toBe("https://a/turn");
  });
});

describe("企業身分不後備到公共錨點（2026-09-17 審查）", () => {
  const ANCHORS = ["wss://a.example", "wss://b.example"];

  it("🔴 企業自架站的 /turn 給不出憑證時，不得改問公共錨點", () => {
    // 自架封閉節點的意義就是流量不出自己的基礎設施。為了通話保底去問公共錨點，
    // 等於把「這台裝置在講話」告訴第三方。
    expect(turnEndpointCandidates("wss://corp.internal", ANCHORS, undefined, { enterprise: true })).toEqual([
      "https://corp.internal/turn",
    ]);
  });

  it("企業身分沒有 home 時就是完全不打", () => {
    expect(turnEndpointCandidates(undefined, ANCHORS, undefined, { enterprise: true })).toEqual([]);
  });

  it("個人身分維持後備（這才是 ADR-0356 §6 要修的那件事）", () => {
    expect(turnEndpointCandidates("wss://mine", ANCHORS, undefined, { enterprise: false })).toHaveLength(3);
    expect(turnEndpointCandidates("wss://mine", ANCHORS)).toHaveLength(3); // 未指定＝個人
  });
});
