// 名冊移除成員後切斷他已連著的連線（SDK ADR 0136；補 ADR 0133〈殘餘風險〉）。
// 修正前：寫入立刻被擋，但他已開的訂閱在斷線前仍收得到投遞給他的事件。
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAuthEvent, finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent, signOrgRoster } from "../../src/protocol/index.js";
import { startNodeRelay } from "../../src/relay/node-relay.js";
import { REJECT } from "../../src/relay/reject-messages.js";
import { RelayCore } from "../../src/relay/relay-core.js";
import { opened } from "../node-relay-harness.js";

const NOW = 1_700_000_000;
const HOST = "relay.example.com";
const aliceSk = generateSecretKey();
const alice = getPublicKey(aliceSk);
const bobSk = generateSecretKey();
const bob = getPublicKey(bobSk);
const carolSk = generateSecretKey();
const carol = getPublicKey(carolSk);

let seq = 0;
const note = (sk: Uint8Array): NostrEvent =>
  finalizeEvent({ kind: 1, created_at: NOW, tags: [], content: `n${seq++}` }, sk);

function authed(core: RelayCore, connId: string, sk: Uint8Array): void {
  const challenge = String(core.connect(connId, HOST)[0]?.message[1]);
  const e = buildAuthEvent(challenge, `wss://${HOST}`, sk, { created_at: NOW });
  const out = core.handle(connId, JSON.stringify(["AUTH", e]));
  expect(out[0]?.message[2]).toBe(true);
  expect(core.handle(connId, JSON.stringify(["REQ", "s", { kinds: [1], authors: [bob] }]))[0]?.message[0]).toBe("EOSE");
}

const newCore = (allowed?: string[]) =>
  new RelayCore({ requireAuth: true, now: () => NOW, ...(allowed ? { allowedAuthors: allowed } : {}) });

describe("setAllowedAuthors 切斷被移出名單的人（SDK ADR 0136）", () => {
  it("🔴 被移出的人：已認證的連線收到 NOTICE 並以 4003 restricted 關閉", () => {
    const core = newCore([alice, bob]);
    authed(core, "a1", aliceSk);
    authed(core, "b1", bobSk);
    const out = core.setAllowedAuthors([bob]);
    expect(out).toEqual([
      { to: "a1", message: ["NOTICE", REJECT.removedFromWhitelist], close: { code: 4003, reason: "restricted" } },
    ]);
  });

  it("🔴 被移出的人的訂閱立刻停：關閉完成之前，新事件也不再投遞給他", () => {
    const core = newCore([alice, bob]);
    authed(core, "a1", aliceSk);
    authed(core, "b1", bobSk);
    core.setAllowedAuthors([bob]);
    const out = core.handle("b1", JSON.stringify(["EVENT", note(bobSk)]));
    expect(out.some((o) => o.to === "a1")).toBe(false);
    expect(out.some((o) => o.to === "b1" && o.message[0] === "EVENT")).toBe(true); // 留下的人照收
  });

  it("同一個人的每一條連線都切", () => {
    const core = newCore([alice, bob]);
    authed(core, "a1", aliceSk);
    authed(core, "a2", aliceSk);
    expect(core.setAllowedAuthors([bob]).map((o) => o.to).sort()).toEqual(["a1", "a2"]);
  });

  it("仍在名單上的人、還沒認證的連線都不動", () => {
    const core = newCore([alice, bob]);
    authed(core, "b1", bobSk);
    core.connect("anon", HOST); // 還沒 AUTH：什麼都讀不到，不用切；之後 AUTH 時照新名單判斷
    expect(core.setAllowedAuthors([bob, carol])).toEqual([]);
  });

  it("開放站換成封閉站：已認證、但不在新名單上的人也切（與 AUTH 時的規則一致）", () => {
    const core = newCore();
    authed(core, "a1", aliceSk);
    authed(core, "c1", carolSk);
    expect(core.setAllowedAuthors([carol]).map((o) => o.to)).toEqual(["a1"]);
  });

  it("被切的人重新連上：AUTH 時照新名單以 4003 擋下", () => {
    const core = newCore([alice, bob]);
    authed(core, "a1", aliceSk);
    core.setAllowedAuthors([bob]);
    const challenge = String(core.connect("a2", HOST)[0]?.message[1]);
    const out = core.handle("a2", JSON.stringify(["AUTH", buildAuthEvent(challenge, `wss://${HOST}`, aliceSk, { created_at: NOW })]));
    expect(out[0]?.close).toEqual({ code: 4003, reason: "restricted" });
  });
});

describe("Node 主機：名冊移除後切斷連線（SDK ADR 0136）", () => {
  const handles: { close(): void }[] = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.close();
    vi.restoreAllMocks();
  });

  /** 連上、完成 NIP-42、訂閱 bob 的貼文；回傳關閉時的關閉碼 */
  function member(port: number, sk: Uint8Array): Promise<{ ws: WebSocket; closed: Promise<number> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
      const timer = setTimeout(() => reject(new Error("沒有完成 AUTH")), 3_000);
      ws.addEventListener("message", (m) => {
        const msg = JSON.parse(String(m.data)) as unknown[];
        if (msg[0] === "AUTH") {
          ws.send(JSON.stringify(["AUTH", buildAuthEvent(String(msg[1]), `ws://127.0.0.1:${port}`, sk)]));
        } else if (msg[0] === "OK" && msg[2] === true) {
          ws.send(JSON.stringify(["REQ", "s", { kinds: [1], authors: [bob] }]));
        } else if (msg[0] === "EOSE") {
          clearTimeout(timer);
          resolve({ ws, closed });
        }
      });
      ws.addEventListener("error", () => reject(new Error("連不上")));
    });
  }

  it("🔴 名冊金鑰發新名冊移除 alice → alice 已連著的連線以 4003 關閉；bob 不受影響", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rosterSk = generateSecretKey();
    const port = await opened(
      handles,
      startNodeRelay({ PORT: "0", REQUIRE_AUTH: "1", ROSTER_ADMIN_PUBKEY: getPublicKey(rosterSk), ALLOWED_PUBKEYS: `${alice},${bob}` }, { memory: true }),
    );
    const a = await member(port, aliceSk);
    const b = await member(port, bobSk);
    const admin = await member(port, rosterSk);
    const now = Math.floor(Date.now() / 1000);
    admin.ws.send(JSON.stringify(["EVENT", signOrgRoster({ org: "測試", members: [{ pubkey: bob, name: "B" }], updatedAt: now }, rosterSk)]));
    expect(await a.closed).toBe(4003);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    b.ws.close();
    admin.ws.close();
  });
});
