// 僅限車道模式（`LANES_ONLY`；SDK ADR 0051）：個人專屬中繼「開放寫入＋不可猜的隨機路徑」。
//
// 開啟時只有 `APP_LANES` 上的車道連得上；主路徑 `/`、分片、presence、沒列的車道一律拒絕，
// 而且拒絕的樣子與一般「認不得的路徑」逐字相同、NIP-11 對被拒的路徑也不透露有哪些車道。
import { beforeAll, describe, expect, it } from "vitest";

import worker, { rejectUpgrade, type Env } from "../../src/relay/worker.js";
import { lanesOnlyFrom, worstCaseStorage } from "../../src/relay/host-config.js";
import { allDoNames, namedLaneName, routeForPath } from "../../src/relay/shard.js";

/** 26 字 base32 小寫（130 位元）：與 `generatePrivateLaneId` 同一個形狀 */
const SECRET = "k7q2mxz4ab3cd5ef6gh7ij2kl3";
const HOST = "cinderous-relay.alice.workers.dev";

// ── Workers 執行環境的最小替身（與 worker.test.ts 同一個做法）────────────────
class FakeWs {
  sent: string[] = [];
  accepted = false;
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  accept(): void {
    this.accepted = true;
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}
class FakeWebSocketPair {
  static last: FakeWebSocketPair | undefined;
  0 = new FakeWs();
  1 = new FakeWs();
  constructor() {
    FakeWebSocketPair.last = this;
  }
}
type FakeResponse = { body: string | null; init?: { status?: number; headers?: Record<string, string> }; status: number };

let RealResponse: typeof Response;
beforeAll(() => {
  RealResponse = globalThis.Response;
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = FakeWebSocketPair;
});
/** 101 在 undici 的 Response 會拋：只有 worker 的升級測試才換掉 */
function withFakeResponse<T>(fn: () => Promise<T>): Promise<T> {
  (globalThis as unknown as { Response: unknown }).Response = class {
    constructor(
      public body: unknown,
      public init?: { status?: number; headers?: Record<string, string> },
    ) {}
    get status(): number {
      return this.init?.status ?? 200;
    }
  };
  return fn().finally(() => {
    globalThis.Response = RealResponse;
  });
}

const LANES_ONLY_ENV: Partial<Env> = {
  APP_LANES: SECRET,
  FILE_LANES: SECRET,
  MAX_FILE_MB: "17",
  LANES_ONLY: "1",
};

/** 送一次 WebSocket 升級：回傳碰到的 DO 名（沒碰到是空字串）與 worker 自建那組的伺服端 */
async function upgrade(path: string, env: Partial<Env>): Promise<{ doName: string; server: FakeWs | undefined; status: number }> {
  return withFakeResponse(async () => {
    let doName = "";
    FakeWebSocketPair.last = undefined;
    const full = {
      ...env,
      RELAY_ROOM: {
        idFromName: (n: string) => {
          doName = n;
          return {} as never;
        },
        get: () => ({ fetch: () => new Response(null, { status: 101 }) }),
      },
    } as unknown as Env;
    const res = await worker.fetch(new Request(`https://${HOST}${path}`, { headers: { Upgrade: "websocket" } }), full);
    return { doName, server: doName === "" ? FakeWebSocketPair.last?.[1] : undefined, status: res.status };
  });
}

async function http(path: string, env: Partial<Env>, headers: Record<string, string> = {}): Promise<FakeResponse> {
  return withFakeResponse(async () => {
    const res = (await worker.fetch(new Request(`https://${HOST}${path}`, { headers }), env as Env)) as unknown as FakeResponse;
    return res;
  });
}

const nip11 = (path: string, env: Partial<Env>) => http(path, env, { Accept: "application/nostr+json" });

describe("lanesOnlyFrom：環境變數（SDK ADR 0051）", () => {
  it("1／true（不分大小寫、前後空白）才開；其他一律關", () => {
    for (const on of ["1", "true", "TRUE", " 1 "]) expect(lanesOnlyFrom(on), on).toBe(true);
    for (const off of [undefined, "", "0", "false", "no", "yes"]) expect(lanesOnlyFrom(off), String(off)).toBe(false);
  });
});

describe("routeForPath 的僅限車道模式", () => {
  const known = new Set([SECRET]);

  it("只有名單上的車道有路由，落在它自己的 DO", () => {
    expect(routeForPath(`/app/${SECRET}`, known, { lanesOnly: true })).toEqual({
      profile: "app",
      doName: namedLaneName(SECRET),
      laneId: SECRET,
      known: true,
    });
  });

  it("🔴 主路徑、分片、presence、沒列的車道全部沒有路由", () => {
    for (const p of ["/", "", "/s/a", "/presence", "/app/dochost", "/app/k7q2mxz4ab3cd5ef6gh7ij2kl", "/app"]) {
      expect(routeForPath(p, known, { lanesOnly: true }), p).toBeUndefined();
    }
  });

  it("沒開＝與原本完全相同", () => {
    expect(routeForPath("/", known)?.doName).toBe("global");
    expect(routeForPath("/app/dochost", known)?.profile).toBe("app");
  });

  it("allDoNames：只會建立名單上那幾顆（帳號儲存預算據此計算）", () => {
    expect(allDoNames(known, { lanesOnly: true })).toEqual([namedLaneName(SECRET)]);
    const budget = worstCaseStorage({ APP_LANES: SECRET, FILE_LANES: SECRET, MAX_FILE_MB: "17", LANES_ONLY: "1" });
    expect(budget.rows.map((r) => r.doName)).toEqual([namedLaneName(SECRET)]);
    expect(worstCaseStorage({ APP_LANES: SECRET }).rows.length).toBeGreaterThan(1);
  });
});

describe("Worker：僅限車道模式（SDK ADR 0051）", () => {
  it("秘密車道 → 它自己的 DO", async () => {
    const { doName, status } = await upgrade(`/app/${SECRET}`, LANES_ONLY_ENV);
    expect(doName).toBe(namedLaneName(SECRET));
    expect(status).toBe(101);
  });

  it("🔴 其他路徑一律拒絕、不碰 DO，NOTICE 與關閉原因和一般站的「認不得的路徑」逐字相同、不含秘密", async () => {
    const generic = await upgrade("/nope", {});
    const genericNotice = generic.server?.sent[0];
    for (const p of ["/", "/s/a", "/presence", "/app/dochost", "/app", "/app/_x", `/app/${SECRET}x`, "/nope"]) {
      const { doName, server } = await upgrade(p, { ...LANES_ONLY_ENV, DEVELOPER_DOCS_URL: undefined });
      expect(doName, p).toBe("");
      expect(server?.sent, p).toEqual([genericNotice]);
      expect(server?.closeCode, p).toBe(1008);
      expect(server?.closeReason, p).toBe(generic.server?.closeReason);
      expect(JSON.stringify(server?.sent), p).not.toContain(SECRET);
    }
  });

  it("文件網址照附，但仍不含秘密", async () => {
    const docs = "https://docs.example.org/relay";
    const { server } = await upgrade("/", { ...LANES_ONLY_ENV, DEVELOPER_DOCS_URL: docs });
    expect(server?.sent[0]).toContain(docs);
    expect(server?.sent[0]).not.toContain(SECRET);
    expect(server?.closeReason).not.toContain(SECRET);
  });

  it("🔴 NIP-11：被拒的路徑回 404、內容與「猜錯車道」相同，不透露車道；秘密車道回它自己的文件", async () => {
    const root = await nip11("/", LANES_ONLY_ENV);
    const guess = await nip11("/app/dochost", LANES_ONLY_ENV);
    const shard = await nip11("/s/a", LANES_ONLY_ENV);
    expect(root.status).toBe(404);
    expect(guess.status).toBe(404);
    expect(shard.status).toBe(404);
    expect(guess.body).toBe(root.body);
    expect(shard.body).toBe(root.body);
    expect(String(root.body)).not.toContain(SECRET);
    expect(root.init?.headers?.["Access-Control-Allow-Origin"]).toBe("*");

    const lane = await nip11(`/app/${SECRET}`, LANES_ONLY_ENV);
    expect(lane.status).toBe(200);
    const doc = JSON.parse(String(lane.body)) as Record<string, unknown>;
    expect(doc.cinder_accepts_files).toBe(true);
    expect(doc.cinder_max_file_mb).toBe(17);
    expect(String(lane.body)).not.toContain(SECRET);
  });

  it("HTTP 首頁與 /healthz 不受影響、不列車道", async () => {
    const home = await http("/", LANES_ONLY_ENV);
    expect(home.status).toBe(200);
    expect(home.body).toBe("Cinderous relay");
    expect((await http("/healthz", LANES_ONLY_ENV)).body).toBe("ok");
  });

  it("沒開 LANES_ONLY：主路徑照常服務（既有部署不變）", async () => {
    const { doName } = await upgrade("/", { APP_LANES: SECRET });
    expect(doName).toBe("global");
    expect((await nip11("/", { APP_LANES: SECRET })).status).toBe(200);
  });

  it("rejectUpgrade 的句子本來就不含任何車道 id（只有固定的 `<your-app-id>` 佔位）", async () => {
    await withFakeResponse(async () => {
      rejectUpgrade("unknown-path", HOST, {});
      expect(FakeWebSocketPair.last?.[1].sent[0]).toContain("<your-app-id>");
    });
  });
});


describe("Worker：唯讀寬限期（READONLY_LANES；SDK ADR 0052）", () => {
  const NEW = "z9y8x7w6v5u4t3s2r2q2p2o2n2";
  const later = () => Math.floor(Date.now() / 1000) + 7 * 86_400;
  const rotated = (expiresAt: number): Partial<Env> => ({
    APP_LANES: NEW,
    FILE_LANES: NEW,
    MAX_FILE_MB: "17",
    LANES_ONLY: "1",
    READONLY_LANES: `${SECRET}@${expiresAt}`,
  });

  it("寬限期內：舊路徑連得上、落在它原本那顆 DO；新路徑落在新的 DO", async () => {
    expect((await upgrade(`/app/${SECRET}`, rotated(later()))).doName).toBe(namedLaneName(SECRET));
    expect((await upgrade(`/app/${NEW}`, rotated(later()))).doName).toBe(namedLaneName(NEW));
  });

  it("🔴 到期後：舊路徑與認不得的路徑逐字相同（不碰 DO）、NIP-11 404；不需要再部署", async () => {
    const expired = rotated(Math.floor(Date.now() / 1000) - 1);
    const generic = await upgrade("/nope", { ...expired, DEVELOPER_DOCS_URL: undefined });
    const old = await upgrade(`/app/${SECRET}`, { ...expired, DEVELOPER_DOCS_URL: undefined });
    expect(old.doName).toBe("");
    expect(old.server?.sent).toEqual(generic.server?.sent);
    expect(old.server?.closeCode).toBe(1008);
    expect(JSON.stringify(old.server?.sent)).not.toContain(SECRET);
    expect((await nip11(`/app/${SECRET}`, expired)).status).toBe(404);
  });

  it("NIP-11：唯讀的舊路徑宣告 restricted_writes、到期時間、不收檔案；新路徑照常", async () => {
    const until = later();
    const doc = JSON.parse(String((await nip11(`/app/${SECRET}`, rotated(until))).body)) as Record<string, unknown>;
    expect((doc.limitation as Record<string, unknown>).restricted_writes).toBe(true);
    expect(doc.cinder_read_only_until).toBe(until);
    expect(doc.cinder_accepts_files).toBe(false);
    const fresh = JSON.parse(String((await nip11(`/app/${NEW}`, rotated(until))).body)) as Record<string, unknown>;
    expect(fresh.cinder_read_only_until).toBeUndefined();
    expect(fresh.cinder_accepts_files).toBe(true);
    expect((fresh.limitation as Record<string, unknown>).restricted_writes).toBe(false);
  });
});
