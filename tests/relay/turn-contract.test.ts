// 契約（SDK ADR 0017）：SDK 的 TurnProvider 簽的請求，直接交給 SDK 中繼真的 `/turn` 處理器。
import { describe, expect, it } from "vitest";

import { TurnProvider } from "../../src/call/turn-provider.js";
import { Identity } from "../../src/identity.js";
import type { TurnFetch } from "../../src/protocol/index.js";
import { mintTurnResponse, type Env } from "../../src/relay/worker.js";

/** 把 TurnFetch 接到真的 Worker 處理器；Cloudflare 的換發 API 用替身 */
function workerFetch(env: Partial<Env>): TurnFetch {
  const cloudflare = (async () =>
    new Response(JSON.stringify({ iceServers: { urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" } }), {
      status: 201,
    })) as unknown as typeof fetch;
  return async (url, init) => {
    const response = await mintTurnResponse(env as Env, new Request(url, { method: init?.method ?? "GET", headers: init?.headers ?? {} }), cloudflare);
    return { ok: response.ok, status: response.status, json: () => response.json() };
  };
}

describe("TurnProvider × 中繼的 /turn", () => {
  it("Identity 簽的授權中繼驗得過；拿到 TURN 與中繼回報的 ttl", async () => {
    const turn = new TurnProvider({
      signer: Identity.generate(),
      home: "wss://relay.example",
      fetch: workerFetch({ TURN_KEY_ID: "k", TURN_API_TOKEN: "t", TURN_TTL_SECONDS: "300" }),
    });
    await turn.start();
    turn.stop();
    expect(turn.iceServers().at(-1)).toEqual({ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" });
  });

  it("中繼沒配 TURN → 204 → 只剩 STUN", async () => {
    const turn = new TurnProvider({ signer: Identity.generate(), home: "wss://relay.example", fetch: workerFetch({}) });
    await turn.start();
    turn.stop();
    expect(turn.iceServers()).toHaveLength(1);
  });
});
