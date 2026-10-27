// 僅限車道模式（`LANES_ONLY`；SDK ADR 0051）在 Node 主機（docker／fly／home-tunnel 共用）：與 Cloudflare 版同一個環境變數。
import { afterEach, describe, expect, it } from "vitest";

import { startNodeRelay } from "../../src/relay/node-relay.js";

const SECRET = "k7q2mxz4ab3cd5ef6gh7ij2kl3";

// ── Node 主機（docker／fly／home-tunnel 共用）─────────────────────────────────
const port = () => 40_000 + Math.floor(Math.random() * 2_000);
const handles: { close(): void }[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

/** 連線並收集訊息直到關閉或逾時 */
function collect(url: string, ms = 1_500): Promise<{ messages: unknown[][]; closeCode?: number; closeReason?: string }> {
  return new Promise((resolve, reject) => {
    const messages: unknown[][] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      resolve({ messages });
    }, ms);
    ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as unknown[]));
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ messages, closeCode: event.code, closeReason: event.reason });
    });
    ws.addEventListener("error", () => {
      /* close 會接著來 */
    });
    setTimeout(() => reject(new Error("timeout")), ms + 2_000);
  });
}

describe("Node 主機：僅限車道模式（自架同一個環境變數）", () => {
  it("秘密車道收到 NIP-42 挑戰；其他路徑收到與 Worker 相同的拒絕並以 1008 關閉；NIP-11 同樣不透露", async () => {
    const p = port();
    handles.push(startNodeRelay({ PORT: String(p), DB_PATH: ":memory:", APP_LANES: SECRET, LANES_ONLY: "1", MAX_FILE_MB: "17" }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ok = await collect(`ws://127.0.0.1:${p}/app/${SECRET}`, 500);
    expect(ok.messages[0]?.[0]).toBe("AUTH");

    for (const path of ["/", "/app/dochost", "/s/a"]) {
      const bad = await collect(`ws://127.0.0.1:${p}${path}`);
      expect(bad.closeCode, path).toBe(1008);
      expect(bad.messages, path).toHaveLength(1);
      expect(bad.messages[0]?.[0], path).toBe("NOTICE");
      expect(String(bad.messages[0]?.[1]), path).toContain("unknown relay path");
      expect(JSON.stringify(bad), path).not.toContain(SECRET);
    }

    const root = await fetch(`http://127.0.0.1:${p}/`, { headers: { accept: "application/nostr+json" } });
    expect(root.status).toBe(404);
    expect(await root.text()).not.toContain(SECRET);
    const lane = await fetch(`http://127.0.0.1:${p}/app/${SECRET}`, { headers: { accept: "application/nostr+json" } });
    expect(lane.status).toBe(200);
    expect(((await lane.json()) as { cinder_accepts_files?: boolean }).cinder_accepts_files).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${p}/healthz`)).text()).toBe("ok");
    expect(await (await fetch(`http://127.0.0.1:${p}/`)).text()).toBe("Cinderous relay");
  });

  it("沒開：任何路徑照舊連得上（既有自架站不變）", async () => {
    const p = port();
    handles.push(startNodeRelay({ PORT: String(p), DB_PATH: ":memory:", APP_LANES: SECRET }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ok = await collect(`ws://127.0.0.1:${p}/`, 500);
    expect(ok.messages[0]?.[0]).toBe("AUTH");
  });
});

describe("Node 主機：唯讀寬限期（READONLY_LANES；SDK ADR 0052）", () => {
  const NEW = "z9y8x7w6v5u4t3s2r2q2p2o2n2";

  /** 連上、送一則訊息，收集回應 */
  function exchange(url: string, message: unknown[], ms = 800): Promise<unknown[][]> {
    return new Promise((resolve) => {
      const messages: unknown[][] = [];
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => ws.send(JSON.stringify(message)));
      ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as unknown[]));
      setTimeout(() => {
        ws.close();
        resolve(messages);
      }, ms);
    });
  }

  it("舊路徑：連得上、寫入被拒（restricted: read-only:）、NIP-11 宣告唯讀；新路徑照常；到期後與認不得的路徑相同", async () => {
    const p = port();
    const until = Math.floor(Date.now() / 1000) + 4;
    handles.push(
      startNodeRelay({
        PORT: String(p),
        DB_PATH: ":memory:",
        APP_LANES: NEW,
        LANES_ONLY: "1",
        REQUIRE_AUTH: "0",
        READONLY_LANES: `${SECRET}@${until}`,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { finalizeEvent, generateSecretKey } = await import("../../src/protocol/index.js");
    const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [["t", "x"]], content: "x" }, generateSecretKey());

    const old = await exchange(`ws://127.0.0.1:${p}/app/${SECRET}`, ["EVENT", event]);
    const ok = old.find((m) => m[0] === "OK");
    expect(ok?.[2]).toBe(false);
    expect(String(ok?.[3])).toMatch(/^restricted: read-only:/);
    const fresh = await exchange(`ws://127.0.0.1:${p}/app/${NEW}`, ["EVENT", event]);
    expect(fresh.find((m) => m[0] === "OK")?.[2]).toBe(true);

    const info = (await (await fetch(`http://127.0.0.1:${p}/app/${SECRET}`, { headers: { accept: "application/nostr+json" } })).json()) as Record<string, unknown>;
    expect(info.cinder_read_only_until).toBe(until);
    expect((info.limitation as Record<string, unknown>).restricted_writes).toBe(true);

    // 到期（中繼自己判斷，不重啟）
    await new Promise((resolve) => setTimeout(resolve, (until + 1) * 1000 - Date.now()));
    const gone = await collect(`ws://127.0.0.1:${p}/app/${SECRET}`);
    expect(gone.closeCode).toBe(1008);
    expect(String(gone.messages[0]?.[1])).toContain("unknown relay path");
    expect((await fetch(`http://127.0.0.1:${p}/app/${SECRET}`, { headers: { accept: "application/nostr+json" } })).status).toBe(404);
  }, 15_000);
});
