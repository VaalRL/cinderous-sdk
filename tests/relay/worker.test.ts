// 宿主層測試（ADR-0235 H1 後續）：以假的 Durable Object 執行環境跑**真正的** `RelayRoom`。
//
// ## 為什麼要測這一層
//
// H1 的 bug 不是「防護寫錯」，是「防護寫對了但從沒被接上」——`relay-core` 有 126 個測試全綠，
// 而 `worker.ts` 從未把參數傳進去。組裝層（宿主）沒人測，正是那個縫隙。
//
// 這裡不引入 miniflare／@cloudflare/vitest-pool-workers（重相依、且會拖累 CI），改用一個
// 最小的假 DO——它提供 `RelayRoom` 真正用到的那幾個 API（休眠式 WebSocket、DO SQLite、alarm），
// 於是我們測的是**真實的組裝與收發路徑**，包含最棘手的休眠→喚醒還原。

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { buildAuthEvent, buildHttpAuthEvent, buildInboxAck, finalizeEvent, minePow, generateSecretKey, getPublicKey, httpAuthHeader, type NostrEvent, type SecretKey } from "../../src/protocol/index.js";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { mintTurnResponse, turnPreflightResponse, RelayRoom, type Env } from "../../src/relay/worker.js";
import {
  MAX_MESSAGES_PER_MINUTE,
  PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR,
  PUBLIC_LANE_RETENTION_SECONDS,
} from "../../src/relay/host-config.js";
import { namedLaneName } from "../../src/relay/shard.js";
import { fetchRelayFilePolicy, type RelayInfoFetch } from "../../src/sync/vault/relay-check.js";
import { leadingZeroBits, OFFLINE_CEILING_REJECT, RelayCore } from "../../src/relay/relay-core.js";
import { relayWorkerVars } from "../../src/deploy/shared.js";
import { guardFor, messagesPerSecondPerIpFrom, storeOptions } from "../../src/relay/host-config.js";
import { MessageStore } from "../../src/relay/message-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

// ── 假 Durable Object 執行環境 ───────────────────────────────────────────────

/** 休眠式 WebSocket 的假替身：attachment 跨「休眠」存活、send 記進 sent。 */
class FakeWs {
  attachment: unknown = null;
  sent: string[] = [];
  closed = false;
  tags: string[] = [];
  /** serializeAttachment 被呼叫的次數（ADR-0373：沒變就不該重寫）。 */
  serializeCount = 0;
  serializeAttachment(o: unknown): void {
    // 與 workerd 相同的上限與行為（ADR-0373）：超過 16,384 bytes 直接拋，attachment 維持原值。
    // 真實平台量的是 structured clone；實測與 JSON 長度只差幾十 bytes，這裡以 JSON 近似。
    const size = JSON.stringify(o).length;
    if (size > 16_384) {
      throw new Error(`A WebSocket 'attachment' cannot be larger than 16384 bytes.'attachment' was ${size} bytes.`);
    }
    this.serializeCount++;
    this.attachment = o;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  send(s: string): void {
    this.sent.push(s);
  }
  /** 非休眠式接受（worker 自己回說明並關閉時用；ADR-0368）。 */
  accepted = false;
  accept(): void {
    this.accepted = true;
  }
  closeCode: number | undefined;
  closeReason: string | undefined;
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
  /** 取出並清空目前收到的訊息（已解析）。 */
  drain(): unknown[] {
    const out = this.sent.map((s) => JSON.parse(s));
    this.sent = [];
    return out;
  }
}

/** `new WebSocketPair()` 的假替身：[client, server]。 */
class FakeWebSocketPair {
  /** 最近一次建立的那一組——worker 自己回絕時，測試要從這裡拿伺服端看它送了什麼（ADR-0368）。 */
  static last: FakeWebSocketPair | undefined;
  0: FakeWs;
  1: FakeWs;
  constructor() {
    this[0] = new FakeWs();
    this[1] = new FakeWs();
    FakeWebSocketPair.last = this;
  }
}

/**
 * 假 `DurableObjectState`：以 node:sqlite 撐起 `ctx.storage.sql`（跨「休眠」存活——因為同一個
 * FakeState 會被兩個 RelayRoom 共用，模擬記憶體清空但 storage 保留），並記住 acceptWebSocket
 * 掛上的連線與 tag。
 */
class FakeState {
  sockets: FakeWs[] = [];
  alarm: number | null = null;
  private readonly db = new DatabaseSync(":memory:");

  /** 對 `ws_subs` 的寫入次數（INSERT/UPDATE/DELETE；ADR-0373 的寫入成本斷言用）。 */
  wsSubsWrites = 0;
  /** 設了就讓 `ws_subs` 的寫入拋錯（模擬 storage 失敗）。 */
  failWsSubsWrites = false;

  /** 測試直接看溢位表。 */
  wsSubsRows(): { conn_id: string; sub_id: string }[] {
    return this.db.prepare(`SELECT conn_id, sub_id FROM ws_subs ORDER BY conn_id, sub_id`).all() as {
      conn_id: string;
      sub_id: string;
    }[];
  }

  private raw(query: string, ...bindings: (string | number | null)[]): Record<string, unknown>[] {
    // 與 DO SQLite 相同：每次查詢最多 100 個綁定參數（Cinderous ADR-0372；SDK ADR 0032）。
    // node:sqlite 的上限是 32766，不設這一道的話宿主層測試永遠看不出來。
    if (bindings.length > 100) throw new Error(`too many SQL variables: ${bindings.length} > 100`);
    if (/ws_subs/.test(query) && /^\s*(insert|update|delete)/i.test(query)) {
      if (this.failWsSubsWrites) throw new Error("storage write failed (test)");
      this.wsSubsWrites++;
    }
    const stmt = this.db.prepare(query);
    if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
    stmt.run(...bindings);
    return [];
  }

  /** key-value storage（ADR-0366 用它記住本實例的車道政策）；與 sql 同樣跨「休眠」保留。 */
  kv = new Map<string, unknown>();

  storage = {
    sql: {
      exec: (query: string, ...bindings: (string | number | null)[]) => ({
        toArray: () => this.raw(query, ...bindings),
      }),
    },
    getAlarm: async (): Promise<number | null> => this.alarm,
    setAlarm: async (t: number): Promise<void> => {
      this.alarm = t;
    },
    get: async <T>(key: string): Promise<T | undefined> => this.kv.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      this.kv.set(key, value);
    },
  };

  blockConcurrencyWhile = async (fn: () => Promise<void>): Promise<void> => {
    await fn();
  };

  acceptWebSocket(ws: FakeWs, tags: string[]): void {
    ws.tags = tags;
    this.sockets.push(ws);
  }

  getWebSockets(tag?: string): FakeWs[] {
    return tag === undefined ? this.sockets : this.sockets.filter((w) => w.tags.includes(tag));
  }
}

// Workers 專屬的全域；Response(status:101) 在 undici 會拋（狀態超出 200–599），故一併換掉。
beforeAll(() => {
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = FakeWebSocketPair;
  (globalThis as unknown as { Response: unknown }).Response = class {
    constructor(
      public body: unknown,
      public init?: { status?: number },
    ) {}
    /** 真 Response 有；替身漏了會讓「回幾號」這類斷言永遠拿到 undefined。 */
    get status(): number {
      return this.init?.status ?? 200;
    }
  };
});

const nowSec = (): number => Math.floor(Date.now() / 1000);
const HOST = "cinder-relay.example";
const RELAY_URL = `wss://${HOST}`;

function newRoom(state: FakeState, env: Env = {} as Env): RelayRoom {
  return new RelayRoom(state as unknown as DurableObjectState, env);
}

/**
 * 模擬一次連線升級：回傳伺服端 socket，其 attachment 內含 connId。
 *
 * `fetch` 自 ADR-0366 起是 async（要把車道政策寫進 storage 釘住），故此 helper 也是。
 * `lane` 未指定＝嚴格平面，與路由方對 `/`、`/s/<n>`、`/presence` 的判定一致。
 */
async function open(room: RelayRoom, state: FakeState, lane: "strict" | "app" = "strict"): Promise<FakeWs> {
  const before = state.sockets.length;
  // 政策由**路徑**決定（與 worker 路由同一個 `routeForPath`），故這裡也用路徑。
  await room.fetch(new Request(`https://${HOST}${lane === "app" ? "/app/testgame" : "/"}`));
  return state.sockets[before]!; // 本次新掛上的伺服端連線
}

const connIdOf = (ws: FakeWs): string => (ws.attachment as { connId: string }).connId;

/** 對某連線送一則客戶端訊息並回傳其收到的回應（已解析、已清空）。 */
function send(room: RelayRoom, ws: FakeWs, msg: unknown[]): unknown[] {
  room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));
  return ws.drain();
}

/** 完成一次 NIP-42 認證（correct challenge + relay tag），回傳是否成功。 */
function authenticate(room: RelayRoom, ws: FakeWs, sk: SecretKey, relayUrl = RELAY_URL): boolean {
  const challenge = challengeOf(ws);
  const ev = buildAuthEvent(challenge, relayUrl, sk);
  // 回應可能夾在未 drain 的初始挑戰之後，用型別找出那則 OK。
  const out = send(room, ws, ["AUTH", ev]) as [string, string, boolean, string][];
  return out.find((m) => m[0] === "OK")?.[2] === true;
}

/**
 * 取出連線的 AUTH 挑戰。**從 attachment 讀**（`ConnSnapshot.challenge`）而非 send 緩衝——
 * 挑戰在連線建立時就持久化，讀 attachment 不受「誰先 drain」的時序影響。
 */
function challengeOf(ws: FakeWs): string {
  const c = (ws.attachment as { challenge?: string } | null)?.challenge;
  if (!c) throw new Error("attachment 內無 challenge");
  return c;
}

const heartbeat = (sk: SecretKey, createdAt = Math.floor(Date.now() / 1000)): NostrEvent =>
  finalizeEvent({ kind: 20000, created_at: createdAt, tags: [], content: "" }, sk);

// ── 測試 ────────────────────────────────────────────────────────────────────

describe("RelayRoom — 連線與 NIP-42（真實宿主路徑）", () => {
  it("升級即發出 AUTH 挑戰，並存進 attachment（休眠可還原）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    const msgs = ws.drain() as [string, string][];
    expect(msgs[0]?.[0]).toBe("AUTH");
    expect(typeof (ws.attachment as { connId: string }).connId).toBe("string");
  });

  it("正確 challenge + relay tag → 認證成功", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    expect(authenticate(room, ws, generateSecretKey())).toBe(true);
  });

  it("🔴 relay tag 指向別站 → 拒絕（宿主有把 request 主機接進 connect）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    // challenge 是對的（模擬攻擊者從真中繼轉來的），但 relay tag 指向 evil。
    expect(authenticate(room, ws, generateSecretKey(), "wss://evil.example")).toBe(false);
  });
});

describe("RelayRoom — 濫用防護確實接上了（ADR-0235 H1 回歸）", () => {
  it("未來時戳被拒——證明 maxFutureSkewSec 有經 worker 傳進 core", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    const sk = generateSecretKey();
    authenticate(room, ws, sk);
    const future = heartbeat(sk, Math.floor(Date.now() / 1000) + 3600);
    const [ok] = send(room, ws, ["EVENT", future]) as [["OK", string, boolean, string]];
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("時間戳");
  });

  it("重放同一事件不再轉發（OK true duplicate:）——證明 replayWindowSec 有接上（修正前 seenIds 永遠是空的）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    const sk = generateSecretKey();
    authenticate(room, ws, sk);
    const beat = heartbeat(sk);
    const [first] = send(room, ws, ["EVENT", beat]) as [["OK", string, boolean, string]];
    expect(first[2]).toBe(true);
    const replies = send(room, ws, ["EVENT", beat]) as [["OK", string, boolean, string]];
    expect(replies).toHaveLength(1);
    const [second] = replies;
    expect(second[2]).toBe(true); // NIP-01：`OK true "duplicate: …"`（SDK ADR 0038 決策 3）
    expect(second[3]).toMatch(/^duplicate: /);
  });

  it("未認證不得發布（requireAuth 有接上）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    // 未認證的 EVENT：回應含拒絕 OK ＋ 重發的 AUTH 挑戰，故用型別找出那則 OK。
    const out = send(room, ws, ["EVENT", heartbeat(generateSecretKey())]) as [string, string, boolean, string][];
    const ok = out.find((m) => m[0] === "OK");
    expect(ok?.[2]).toBe(false);
    expect(String(ok?.[3])).toContain("auth-required");
  });
});

describe("RelayRoom — 收發與扇出", () => {
  it("認證後訂閱→他人發布→收到扇出（完整往返）", async () => {
    const state = new FakeState();
    const room = newRoom(state);

    const watcherSk = generateSecretKey();
    const watcher = await open(room, state);
    authenticate(room, watcher, watcherSk);
    const req = send(room, watcher, ["REQ", "s1", { kinds: [20000], authors: [getPublicKey(generateSecretKey())] }]);
    expect((req[0] as [string, string])[0]).toBe("EOSE");

    // watcher 訂閱自己的心跳作者集合太麻煩；改訂閱一個已知 sender。
    const senderSk = generateSecretKey();
    const senderPk = getPublicKey(senderSk);
    send(room, watcher, ["REQ", "s2", { kinds: [20000], authors: [senderPk] }]);

    const sender = await open(room, state);
    authenticate(room, sender, senderSk);
    const beat = heartbeat(senderSk);
    send(room, sender, ["EVENT", beat]);

    const got = watcher.drain() as [string, string, NostrEvent][];
    const evented = got.find((m) => m[0] === "EVENT" && m[1] === "s2");
    expect(evented?.[2]?.id).toBe(beat.id);
  });

  it("dispatch 只送給目標連線（tag 路由）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const a = await open(room, state);
    const b = await open(room, state);
    a.drain();
    b.drain();
    // 對 a 送訊息，b 不應收到任何東西。
    send(room, a, ["REQ", "s1", { authors: [getPublicKey(generateSecretKey())] }]);
    expect(b.sent).toEqual([]);
  });
});

describe("RelayRoom — 休眠→喚醒還原（ADR-0059 + ADR-0235 H2）", () => {
  it("認證狀態跨休眠存活：喚醒後的新 RelayRoom 仍認得已認證連線", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);
    const ws = await open(room1, state);
    authenticate(room1, ws, generateSecretKey());

    // 休眠：記憶體中的 RelayRoom 消失，但 storage 與 socket attachment 存活。
    const room2 = newRoom(state);
    // REQ 需要已認證；若還原成功，room2 直接回 EOSE 而非 auth-required。
    const out = send(room2, ws, ["REQ", "s1", { authors: [getPublicKey(generateSecretKey())] }]) as [string, string, string][];
    expect(out[0]?.[0]).toBe("EOSE");
    expect(JSON.stringify(out)).not.toContain("auth-required");
  });

  it("🔴 relayHost 跨休眠存活：喚醒後才認證，仍會驗 relay tag", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);
    const ws = await open(room1, state); // 連線建立→challenge 與 relayHost 寫進 attachment
    const challenge = challengeOf(ws);

    // 休眠前尚未認證。喚醒後才送 AUTH——relayHost 必須從 attachment 還原，否則檢查靜默失效。
    const room2 = newRoom(state);
    const badAuth = buildAuthEvent(challenge, "wss://evil.example", generateSecretKey());
    const out = send(room2, ws, ["AUTH", badAuth]) as [string, string, boolean, string][];
    const ok = out.find((m) => m[0] === "OK");
    expect(ok?.[2]).toBe(false); // relayHost 有還原 → evil 被擋

    // 對照：同一喚醒後的 room，正確 relay tag 仍可認證成功。
    const ws2 = await open(room2, state);
    expect(authenticate(room2, ws2, generateSecretKey())).toBe(true);
  });

  it("離線留言跨休眠存活（DO SQLite）：喚醒後仍查得到", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);

    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const senderSk = generateSecretKey();
    const sender = await open(room1, state);
    authenticate(room1, sender, senderSk);
    const dm = finalizeEvent(
      { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [["p", recipientPk]], content: "x" },
      senderSk,
    );
    send(room1, sender, ["EVENT", dm]);

    // 休眠 → 收件人上線拉取。
    const room2 = newRoom(state);
    const reader = await open(room2, state);
    authenticate(room2, reader, recipientSk);
    const out = send(room2, reader, ["REQ", "inbox", { kinds: [1059], "#p": [recipientPk] }]) as [string, string, NostrEvent][];
    const evented = out.find((m) => m[0] === "EVENT");
    expect(evented?.[2]?.id).toBe(dm.id);
  });
});

/** n 把假的 authors（格式合法的 64 hex；只拿來撐大 filter，不需要對應私鑰）。 */
function fakeAuthors(n: number): string[] {
  return Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, "0"));
}

/** 認證好的觀察者：訂閱 `subId`，authors＝n 把假 key ＋真正會發布的那一把（放最後）。 */
async function bigWatcher(room: RelayRoom, state: FakeState, n: number, publisherPk: string, subId = "hb") {
  const ws = await open(room, state);
  authenticate(room, ws, generateSecretKey());
  ws.drain();
  const out = send(room, ws, ["REQ", subId, { kinds: [20000], authors: [...fakeAuthors(n - 1), publisherPk] }]);
  return { ws, out: out as [string, string, string?][] };
}

/** 發布者連上、認證、發一顆心跳；回傳那顆事件。 */
async function publishBeat(room: RelayRoom, state: FakeState, sk: SecretKey): Promise<NostrEvent> {
  const ws = await open(room, state);
  authenticate(room, ws, sk);
  const beat = heartbeat(sk);
  send(room, ws, ["EVENT", beat]);
  return beat;
}

describe("RelayRoom — WebSocket attachment 16KB 上限（ADR-0373）", () => {
  it("替身與平台一致：超過 16,384 bytes 的 attachment 會拋（否則以下測試全是空轉）", () => {
    const ws = new FakeWs();
    expect(() => ws.serializeAttachment({ big: "x".repeat(17_000) })).toThrow(/16384/);
  });

  it("🔴 260 把 authors：不拋、回 EOSE（修正前 serializeAttachment 未捕捉例外 ⇒ 客戶端什麼都收不到）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    authenticate(room, ws, generateSecretKey());
    ws.drain();
    const msg = JSON.stringify(["REQ", "hb", { kinds: [20000], authors: fakeAuthors(260) }]);
    expect(() => room.webSocketMessage(ws as unknown as WebSocket, msg)).not.toThrow();
    expect(ws.drain()).toEqual([["EOSE", "hb"]]);
    expect(JSON.stringify(ws.attachment).length).toBeLessThanOrEqual(16_384);
  });

  it("🔴 1024 把 authors：休眠→喚醒後仍收得到新事件（訂閱完整還原）", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);
    const pubSk = generateSecretKey();
    const { ws: watcher, out } = await bigWatcher(room1, state, 1024, getPublicKey(pubSk));
    expect(out).toEqual([["EOSE", "hb"]]);

    // 休眠：記憶體裡的 RelayRoom 消失，只剩 storage 與 socket attachment。
    const room2 = newRoom(state);
    const beat = await publishBeat(room2, state, pubSk);
    const got = watcher.drain() as [string, string, NostrEvent][];
    expect(got.find((m) => m[0] === "EVENT" && m[1] === "hb")?.[2]?.id).toBe(beat.id);
  });

  it("多條訂閱混合：小的留在 attachment、大的溢位，喚醒後兩條都還在", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);
    const pubSk = generateSecretKey();
    const pubPk = getPublicKey(pubSk);
    const { ws: watcher } = await bigWatcher(room1, state, 500, pubPk, "big");
    send(room1, watcher, ["REQ", "small", { kinds: [20000], authors: [pubPk] }]);
    expect(state.wsSubsRows().map((r) => r.sub_id)).toEqual(["big"]);
    const att = watcher.attachment as { subs: { subId: string }[]; spilled?: string[] };
    expect(att.subs.map((s) => s.subId)).toEqual(["small"]);
    expect(att.spilled).toEqual(["big"]);

    const room2 = newRoom(state);
    const beat = await publishBeat(room2, state, pubSk);
    const subs = (watcher.drain() as [string, string, NostrEvent][])
      .filter((m) => m[0] === "EVENT" && m[2].id === beat.id)
      .map((m) => m[1])
      .sort();
    expect(subs).toEqual(["big", "small"]);
  });

  it("小訂閱不碰溢位表（ADR-0059 的「喚醒零讀寫」在一般情況下不變）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    authenticate(room, ws, generateSecretKey());
    send(room, ws, ["REQ", "s", { kinds: [20000], authors: fakeAuthors(50) }]);
    expect(state.wsSubsWrites).toBe(0);
    expect(state.wsSubsRows()).toEqual([]);
  });

  it("💰 不改訂閱的訊息零寫入：心跳 EVENT 不重寫溢位列，也不重做 serializeAttachment——喚醒後亦同", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);
    const sk = generateSecretKey();
    const ws = await open(room1, state);
    authenticate(room1, ws, sk);
    send(room1, ws, ["REQ", "hb", { kinds: [20000], authors: fakeAuthors(1024) }]);
    const writes = state.wsSubsWrites;
    const serial = ws.serializeCount;
    expect(writes).toBe(1);

    send(room1, ws, ["EVENT", heartbeat(sk, nowSec() - 1)]);
    // 休眠→喚醒後的第一則訊息也不該把溢位列重寫一遍（那會變成每次喚醒一筆寫入）。
    const room2 = newRoom(state);
    send(room2, ws, ["EVENT", heartbeat(sk)]);
    expect(state.wsSubsWrites).toBe(writes);
    expect(ws.serializeCount).toBe(serial);
  });

  it("CLOSE 或把大訂閱換成小的 ⇒ 溢位列刪掉", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    authenticate(room, ws, generateSecretKey());
    send(room, ws, ["REQ", "a", { authors: fakeAuthors(400) }]);
    send(room, ws, ["REQ", "b", { authors: fakeAuthors(400) }]);
    expect(state.wsSubsRows().map((r) => r.sub_id)).toEqual(["a", "b"]);
    send(room, ws, ["CLOSE", "a"]);
    send(room, ws, ["REQ", "b", { authors: fakeAuthors(3) }]);
    expect(state.wsSubsRows()).toEqual([]);
    expect((ws.attachment as { spilled?: string[] }).spilled).toBeUndefined();
  });

  it("連線關閉（webSocketClose／webSocketError）⇒ 溢位列清掉", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const a = await open(room, state);
    const b = await open(room, state);
    authenticate(room, a, generateSecretKey());
    authenticate(room, b, generateSecretKey());
    send(room, a, ["REQ", "hb", { authors: fakeAuthors(300) }]);
    send(room, b, ["REQ", "hb", { authors: fakeAuthors(300) }]);
    expect(state.wsSubsRows()).toHaveLength(2);
    room.webSocketClose(a as unknown as WebSocket);
    // 休眠後才斷線：close handler 要先還原才知道有哪些列要刪。
    const room2 = newRoom(state);
    room2.webSocketError(b as unknown as WebSocket);
    expect(state.wsSubsRows()).toEqual([]);
  });

  it("🧹 孤兒列（部署重啟時連線消失、webSocketClose 沒跑）在下一次喚醒時清掉", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);
    const ws = await open(room1, state);
    authenticate(room1, ws, generateSecretKey());
    send(room1, ws, ["REQ", "hb", { authors: fakeAuthors(300) }]);
    expect(state.wsSubsRows()).toHaveLength(1);

    state.sockets = []; // DO 重建：所有連線都斷了，沒有任何 handler 被呼叫
    const room2 = newRoom(state);
    await open(room2, state); // 任何新連線都會觸發還原
    expect(state.wsSubsRows()).toEqual([]);
  });

  it("🧹 alarm 也會清孤兒（之後再也沒有連線進來的 DO）", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);
    const ws = await open(room1, state);
    authenticate(room1, ws, generateSecretKey());
    send(room1, ws, ["REQ", "hb", { authors: fakeAuthors(300) }]);
    state.sockets = [];
    await newRoom(state).alarm();
    expect(state.wsSubsRows()).toEqual([]);
  });

  it("🔴 喚醒時溢位列不見了 ⇒ 回 CLOSED 請客戶端重訂（不假裝還在）", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);
    const pubSk = generateSecretKey();
    const { ws: watcher } = await bigWatcher(room1, state, 300, getPublicKey(pubSk));
    state.storage.sql.exec(`DELETE FROM ws_subs`).toArray();

    const room2 = newRoom(state);
    await publishBeat(room2, state, pubSk);
    const got = watcher.drain() as [string, string, string][];
    expect(got.some((m) => m[0] === "EVENT")).toBe(false);
    const closed = got.find((m) => m[0] === "CLOSED" && m[1] === "hb");
    expect(closed?.[2]).toMatch(/^error: resubscribe: .*please resubscribe/);
    // attachment 也更正了：不再指著不存在的列。
    expect((watcher.attachment as { spilled?: string[] }).spilled).toBeUndefined();
  });

  it("🔴 超過每連線合計上限 ⇒ 那一條回 CLOSED（invalid:）且不回 EOSE；先前的訂閱不受影響", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const pubSk = generateSecretKey();
    const pubPk = getPublicKey(pubSk);
    const ws = await open(room, state);
    authenticate(room, ws, generateSecretKey());
    ws.drain();
    // 每條約 69KB；512KiB 放得下 7 條，第 8 條超過。
    for (let i = 0; i < 7; i++) {
      expect(send(room, ws, ["REQ", `s${i}`, { authors: [...fakeAuthors(1023), pubPk] }])).toEqual([["EOSE", `s${i}`]]);
    }
    const out = send(room, ws, ["REQ", "s7", { authors: [...fakeAuthors(1023), pubPk] }]) as [string, string, string][];
    expect(out).toHaveLength(1);
    expect(out[0]?.[0]).toBe("CLOSED");
    expect(out[0]?.[1]).toBe("s7");
    expect(out[0]?.[2]).toMatch(/^invalid: too-large: .*ADR-0373/);

    // 被關掉的那條真的不在了；其他 7 條休眠後照樣收得到。
    const room2 = newRoom(state);
    const beat = await publishBeat(room2, state, pubSk);
    const subs = (ws.drain() as [string, string, NostrEvent][])
      .filter((m) => m[0] === "EVENT" && m[2].id === beat.id)
      .map((m) => m[1])
      .sort();
    expect(subs).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  it("🔴 storage 寫入失敗 ⇒ 不拋、回 CLOSED（error:），訂閱不會留在記憶體裡假裝能用", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const pubSk = generateSecretKey();
    const pubPk = getPublicKey(pubSk);
    const ws = await open(room, state);
    authenticate(room, ws, generateSecretKey());
    ws.drain();
    state.failWsSubsWrites = true;
    const msg = JSON.stringify(["REQ", "hb", { authors: [...fakeAuthors(300), pubPk] }]);
    expect(() => room.webSocketMessage(ws as unknown as WebSocket, msg)).not.toThrow();
    const out = ws.drain() as [string, string, string][];
    expect(out).toHaveLength(1);
    expect(out[0]?.slice(0, 2)).toEqual(["CLOSED", "hb"]);
    expect(out[0]?.[2]).toMatch(/^error: /);

    state.failWsSubsWrites = false;
    await publishBeat(room, state, pubSk);
    expect((ws.drain() as unknown[][]).some((m) => m[0] === "EVENT")).toBe(false);
  });

  it("舊版 attachment（沒有 spilled 欄）照常還原——升級當下已連著的客戶端不受影響", async () => {
    const state = new FakeState();
    const room1 = newRoom(state);
    const pubSk = generateSecretKey();
    const ws = await open(room1, state);
    authenticate(room1, ws, generateSecretKey());
    // 模擬舊版寫下的 attachment：訂閱全在 subs 裡、沒有 spilled。
    const att = ws.attachment as { subs: unknown[] };
    ws.attachment = { ...att, subs: [{ subId: "old", filters: [{ kinds: [20000], authors: [getPublicKey(pubSk)] }] }] };

    const room2 = newRoom(state);
    const beat = await publishBeat(room2, state, pubSk);
    const got = ws.drain() as [string, string, NostrEvent][];
    expect(got.find((m) => m[0] === "EVENT" && m[1] === "old")?.[2]?.id).toBe(beat.id);
  });
});

describe("NIP-11 端點（ADR-0260 worker fetch）", () => {
  // 本檔的全域 `Response` 是假的（見 beforeAll）——只記 body 與 init，故這樣拆。
  const get = async (
    headers: Record<string, string> = {},
    env: Partial<Env> = {},
  ): Promise<{ body: string; status?: number; headers?: Record<string, string> }> => {
    const r = (await worker.fetch(new Request(`https://${HOST}/`, { headers }), env as Env)) as unknown as {
      body: string;
      init: { status?: number; headers?: Record<string, string> };
    };
    return { body: r.body, ...r.init };
  };
  const docOf = async (env: Partial<Env> = {}): Promise<Record<string, unknown>> =>
    JSON.parse((await get({ Accept: "application/nostr+json" }, env)).body) as Record<string, unknown>;

  it("不帶 Accept → 維持純文字 200（健康檢查契約不破，ADR-0089）", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toBe("Cinderous relay");
  });

  it("帶 application/nostr+json → 回 NIP-11 文件（含 CORS，瀏覽器版要跨源抓）", async () => {
    const r = await get({ Accept: "application/nostr+json" });
    expect(r.status).toBe(200);
    expect(r.headers?.["content-type"]).toContain("application/nostr+json");
    expect(r.headers?.["Access-Control-Allow-Origin"]).toBe("*");
    const doc = JSON.parse(r.body) as Record<string, unknown>;
    expect(doc.supported_nips).toContain(62);
    // worker 的 RelayCore 恆為 requireAuth: true——文件必須據實反映，不能各說各話。
    expect((doc.limitation as Record<string, unknown>).auth_required).toBe(true);
  });

  it("software：沒設＝SDK 的中立預設（SDK ADR 0019）；設了 RELAY_SOFTWARE_URL 就用它（SDK ADR 0050，AGPL §13）", async () => {
    expect((await docOf()).software).toBe("https://github.com/VaalRL/cinderous-sdk");
    expect((await docOf({ RELAY_SOFTWARE_URL: "https://git.example.com/fork" })).software).toBe("https://git.example.com/fork");
  });

  it("營運者填了贊助管道就出現在文件裡（ADR-0089 的入口終於有載體）", async () => {
    const doc = await docOf({
      DONATE_GITHUB_SPONSORS: "https://github.com/sponsors/op",
      RELAY_CONTACT: "op@example.com",
    });
    expect(doc.cinder_donations).toEqual({ github_sponsors: "https://github.com/sponsors/op" });
    expect(doc.contact).toBe("op@example.com");
  });

  it("未填贊助管道＝整個欄位不出現（客戶端據此不顯示贊助卡）", async () => {
    expect("cinder_donations" in (await docOf())).toBe(false);
  });

  it("站方 TTL 上限反映在 retention（企業站放寬後客戶端看得到）", async () => {
    expect((await docOf({ MAX_TTL_DAYS: "90" })).retention).toEqual([{ time: 90 * 86_400 }]);
  });

  it("宣告收件確認（SDK ADR 0067 §2）", async () => {
    expect((await docOf()).cinder_inbox_ack).toEqual({ kind: 25190, grace_sec: 7_200 });
  });
});


describe("第三方車道路由（ADR-0366 worker fetch）", () => {
  /** 回傳 [DO 名, DO 收到的路徑, HTTP 狀態]。 */
  const route = async (path: string): Promise<[string, string, number]> => {
    let doName = "";
    let seenPath = "";
    const env = {
      RELAY_ROOM: {
        idFromName: (n: string) => {
          doName = n;
          return {} as never;
        },
        get: () => ({
          fetch: (req: Request) => {
            seenPath = new URL(req.url).pathname;
            return new Response(null, { status: 101 });
          },
        }),
      },
    } as unknown as Env;
    const res = await worker.fetch(
      new Request(`https://${HOST}${path}`, { headers: { Upgrade: "websocket" } }),
      env,
    );
    return [doName, seenPath, res.status];
  };

  it("/app/<laneId> → 車道 DO", async () => {
    const [doName, , status] = await route("/app/elementalist");
    expect(doName).toMatch(/^app-[0-7]$/);
    expect(status).toBe(101);
  });

  it("🔴 request 原封不動轉給 DO——政策由 DO 自己對同一路徑算，兩邊不可能不一致", async () => {
    for (const p of ["/", "/s/a", "/presence", "/app/elementalist"]) {
      const [, seenPath] = await route(p);
      expect(seenPath, p).toBe(p);
    }
  });

  it("🔴 認不得的路徑**根本不碰 DO**（ADR-0366 §決策 4；ADR-0368 只改了拒絕時說什麼）", async () => {
    for (const p of ["/s/zz", "/s/ab", "/nope", "/app"]) {
      const [doName] = await route(p);
      expect(doName, p).toBe(""); // idFromName 沒被呼叫
    }
  });
});

describe("拒絕連線時說明原因並指向開發者文件（ADR-0368）", () => {
  // SDK 預設不指向任何網址（SDK ADR 0019）：要附文件網址就設 DEVELOPER_DOCS_URL
  const DOCS = "https://relay.example.org/developers/";
  /** 送一次升級；回傳 [狀態碼, 是否碰到 DO, worker 自建那組的伺服端]。 */
  const reject = async (
    path: string,
    env: Partial<Env> = {},
    ip?: string,
  ): Promise<{ status: number; touchedDo: boolean; server: FakeWs | undefined }> => {
    let touchedDo = false;
    FakeWebSocketPair.last = undefined;
    const full = {
      ...env,
      RELAY_ROOM: {
        idFromName: () => {
          touchedDo = true;
          return {} as never;
        },
        get: () => ({ fetch: () => new Response(null, { status: 101 }) }),
      },
    } as unknown as Env;
    const headers: Record<string, string> = { Upgrade: "websocket" };
    if (ip !== undefined) headers["CF-Connecting-IP"] = ip;
    const res = await worker.fetch(new Request(`https://${HOST}${path}`, { headers }), full);
    return { status: res.status, touchedDo, server: FakeWebSocketPair.last?.[1] };
  };
  const noticeOf = (ws: FakeWs | undefined): string => {
    const msg = JSON.parse(ws?.sent[0] ?? "[]") as unknown[];
    expect(msg[0]).toBe("NOTICE");
    return msg[1] as string;
  };
  const bytes = (s: string | undefined): number => new TextEncoder().encode(s ?? "").length;

  it("🔴 錯誤路徑：接受、送一則 NOTICE、以 1008 關閉——且**仍然不碰任何 DO**", async () => {
    for (const p of ["/s/zz", "/nope", "/relay"]) {
      const { status, touchedDo, server } = await reject(p, { DEVELOPER_DOCS_URL: DOCS });
      expect(touchedDo, p).toBe(false);
      expect(status, p).toBe(101);
      expect(server?.accepted, p).toBe(true);
      expect(server?.sent, p).toHaveLength(1);
      const notice = noticeOf(server);
      expect(notice, p).toContain(DOCS);
      expect(notice, p).toContain(`wss://${HOST}/app/<your-app-id>`);
      expect(server?.closed, p).toBe(true);
      expect(server?.closeCode, p).toBe(1008);
    }
  });

  it("關閉原因也帶文件網址——瀏覽器的 `WebSocket` 只看得到這個，看不到 NOTICE 以外的東西", async () => {
    const { server } = await reject("/nope", { DEVELOPER_DOCS_URL: DOCS });
    expect(server?.closeReason).toContain(DOCS);
    expect(bytes(server?.closeReason)).toBeLessThanOrEqual(123); // WebSocket 規格的上限
  });

  it("車道 id 不合法：說明合法的形狀，而不是籠統的「路徑錯了」", async () => {
    for (const p of ["/app", "/app/", "/app/_x", "/app/a%20b", "/APP/lwd"]) {
      const { touchedDo, server } = await reject(p, { DEVELOPER_DOCS_URL: DOCS });
      expect(touchedDo, p).toBe(false);
      const notice = noticeOf(server);
      expect(notice, p).toContain("invalid app lane");
      expect(notice, p).toContain("a-z 0-9");
      expect(notice, p).toContain(DOCS);
    }
  });

  it("🔴 不回顯對方送來的路徑——中繼站不該變成反射任意字串的地方", async () => {
    const { server } = await reject("/zzz-probe-marker");
    expect(noticeOf(server)).not.toContain("zzz-probe-marker");
    expect(server?.closeReason).not.toContain("zzz-probe-marker");
  });

  it("車道限速：同一個形狀，以 `rate-limited:` 開頭，**不碰 DO**", async () => {
    const limiter = { limit: () => Promise.resolve({ success: false }) };
    const { status, touchedDo, server } = await reject("/app/testgame", { APP_LANE_LIMIT: limiter, DEVELOPER_DOCS_URL: DOCS }, "203.0.113.7");
    expect(touchedDo).toBe(false);
    expect(status).toBe(101);
    const notice = noticeOf(server);
    expect(notice.startsWith("rate-limited:")).toBe(true);
    expect(notice).toContain(DOCS);
    expect(server?.closeCode).toBe(1008);
  });

  it("🔴 沒設 DEVELOPER_DOCS_URL → 不附任何網址（SDK 不替別人的站指向 Cinderous 官網；SDK ADR 0019）", async () => {
    const { server } = await reject("/nope");
    const notice = noticeOf(server);
    expect(notice).toContain("unknown relay path");
    expect(notice).not.toMatch(/https?:\/\//);
    expect(notice).not.toContain("Docs:");
    expect(server?.closeReason).toBe("unknown relay path");
  });

  it("網址太長塞不進 123 bytes：關閉原因退回短句，網址仍在 NOTICE 裡", async () => {
    const own = `https://relay.example.org/${"x".repeat(150)}`;
    const { server } = await reject("/nope", { DEVELOPER_DOCS_URL: own });
    expect(noticeOf(server)).toContain(own);
    expect(bytes(server?.closeReason)).toBeLessThanOrEqual(123);
    expect(server?.closeReason).toContain("unknown relay path");
  });

  it("非升級的 HTTP 請求不受影響：錯誤路徑的一般 GET 照舊回純文字 200（ADR-0089 契約）", async () => {
    const res = await worker.fetch(new Request(`https://${HOST}/nope`), {} as Env);
    expect(res.status).toBe(200);
  });
});

describe("RelayRoom — 車道政策釘住（ADR-0366）", () => {
  it("車道連線放行標籤訂閱；嚴格平面同一個 filter 被擋", async () => {
    const laneState = new FakeState();
    const laneRoom = newRoom(laneState);
    const lane = await open(laneRoom, laneState, "app");
    // 車道不要求 AUTH，可直接訂閱（ADR-0366 §決策 5 的 requireAuth: false）
    expect(send(laneRoom, lane, ["REQ", "s", { kinds: [1078], "#w": ["world-1"] }])).toContainEqual([
      "EOSE",
      "s",
    ]);

    const strictState = new FakeState();
    const strictRoom = newRoom(strictState);
    const strict = await open(strictRoom, strictState);
    const out = send(strictRoom, strict, ["REQ", "s", { kinds: [1078], "#w": ["world-1"] }]);
    // 嚴格平面先要 AUTH；就算認證了也會因為沒有 #p/authors 而被擋（見 relay-core 測試）。
    expect(JSON.stringify(out)).toContain("auth-required");
  });

  it("🔴 政策跨休眠存活：喚醒後的新 RelayRoom 仍是車道", async () => {
    const state = new FakeState();
    await open(newRoom(state), state, "app");
    // 休眠＝記憶體清空、storage 保留 ⇒ 新實例從 storage 還原政策
    const woken = newRoom(state);
    const ws = await open(woken, state, "app");
    expect(send(woken, ws, ["REQ", "s", { kinds: [1078], "#w": ["w"] }])).toContainEqual(["EOSE", "s"]);
  });

  it("🔴 釘住之後收到不同政策 → 409，不切換（同一份儲存不可被兩套規則讀寫）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    await open(room, state, "app");
    const res = await room.fetch(new Request(`https://${HOST}/`)); // 同一顆 DO 收到嚴格平面的路徑
    expect(res.status).toBe(409);
  });

  it("認不得的路徑漏進 DO 時一律當嚴格（fail-closed 的底線；正常情況 worker 已先 404）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    await room.fetch(new Request(`https://${HOST}/s/zz`));
    expect(state.kv.get("cinder:lane-profile")).toBe("strict");
  });
});

describe("分片路由（ADR-0241 worker fetch）", () => {
  const routeOf = async (path: string): Promise<string> => {
    let routed = "";
    const env = {
      RELAY_ROOM: {
        idFromName: (n: string) => {
          routed = n;
          return {} as never;
        },
        get: () => ({ fetch: () => new Response(null, { status: 101 }) }),
      },
    } as unknown as Env;
    await worker.fetch(new Request(`https://${HOST}${path}`, { headers: { Upgrade: "websocket" } }), env);
    return routed;
  };

  it("/s/<prefix> → 訊息片", async () => {
    expect(await routeOf("/s/a")).toBe("shard-a");
  });
  it("/presence → presence 獨立層", async () => {
    expect(await routeOf("/presence")).toBe("presence");
  });
  it("/（舊客戶端）→ 舊全域 DO（遷移回退）", async () => {
    expect(await routeOf("/")).toBe("global");
  });
});

describe("分片血條隔離（ADR-0241）", () => {
  it("一片收畸形訊息（不拋）不影響另一片：他片的離線留言照樣查得到", async () => {
    // shard-A：塞畸形訊息（模擬攻擊/崩潰路徑，C1 已保證不拋）——完全獨立的 state/DO。
    const stateA = new FakeState();
    const roomA = newRoom(stateA);
    const wsA = await open(roomA, stateA);
    wsA.drain();
    expect(() => roomA.webSocketMessage(wsA as unknown as WebSocket, "not json{{{")).not.toThrow();

    // shard-B：另一個獨立 DO——存一則離線留言。
    const stateB = new FakeState();
    const roomB = newRoom(stateB);
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const senderSk = generateSecretKey();
    const sender = await open(roomB, stateB);
    authenticate(roomB, sender, senderSk);
    const dm = finalizeEvent(
      { kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [["p", recipientPk]], content: "x" },
      senderSk,
    );
    send(roomB, sender, ["EVENT", dm]);

    // shard-A 的故障不影響 shard-B：B 的收件人照常拉到留言（血條＝一崩 1/N）。
    const reader = await open(roomB, stateB);
    authenticate(roomB, reader, recipientSk);
    const out = send(roomB, reader, ["REQ", "inbox", { kinds: [1059], "#p": [recipientPk] }]) as [
      string,
      string,
      NostrEvent,
    ][];
    expect(out.find((m) => m[0] === "EVENT")?.[2]?.id).toBe(dm.id);
  });
});

describe("RelayRoom — 崩潰韌性（ADR-0235 C1 宿主層）", () => {
  it("畸形訊息不會讓房間拋例外（單一惡意訊息不打掛全域 DO）", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    ws.drain();
    expect(() => room.webSocketMessage(ws as unknown as WebSocket, "not json{{{")).not.toThrow();
    // tags 為物件的畸形事件（能通過驗簽卻讓 tags.find 拋）——解析層擋下，回 NOTICE。
    const sk = generateSecretKey();
    authenticate(room, ws, sk);
    const good = heartbeat(sk);
    expect(() =>
      room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(["EVENT", { ...good, tags: {} }])),
    ).not.toThrow();
  });

  it("webSocketClose 清掉連線且不拋", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state);
    expect(() => room.webSocketClose(ws as unknown as WebSocket)).not.toThrow();
    expect(ws.closed).toBe(true);
  });
});

describe("公共 TURN 端點（/turn，ADR-0243／0342）", () => {
  const cfJson = { iceServers: { urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "p" } };
  const cfBody = JSON.stringify(cfJson);
  const okFetch = (async () =>
    ({ ok: true, status: 201, text: async () => cfBody, json: async () => cfJson }) as unknown as Response) as typeof fetch;
  // 本檔的 beforeAll 把全域 Response 換成只存 {body, init} 的替身（見上）；照其形狀斷言。
  const stub = (r: Response) => r as unknown as { body: unknown; init: { status?: number; headers?: Record<string, string> } };

  const TURN_URL = "https://relay.example/turn";
  const authSk = generateSecretKey();
  /** 帶合法 NIP-98 授權的請求（ADR-0342 §3.2）。 */
  const authed = (url = TURN_URL): Request =>
    ({
      url,
      method: "GET",
      headers: { get: (h: string) => (h === "Authorization" ? httpAuthHeader(buildHttpAuthEvent(url, "GET", authSk)) : null) },
    }) as unknown as Request;
  /** 未帶授權。 */
  const bare = (url = TURN_URL): Request =>
    ({ url, method: "GET", headers: { get: () => null } }) as unknown as Request;

  it("未配 secret → 204（客戶端退回純 STUN，no-op）", async () => {
    const r = stub(await mintTurnResponse({} as Env, authed(), okFetch));
    expect(r.init.status).toBe(204);
    expect(r.body).toBeNull();
  });

  it("配好 secret → 200＋Cloudflare 憑證 body＋CORS", async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const spy = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return { ok: true, status: 201, text: async () => cfBody, json: async () => cfJson } as unknown as Response;
    }) as typeof fetch;
    const env = { TURN_KEY_ID: "key123", TURN_API_TOKEN: "tok", TURN_TTL_SECONDS: "3600" } as Env;
    const r = stub(await mintTurnResponse(env, authed(), spy));
    expect(r.init.status).toBe(200);
    expect(r.init.headers?.["Access-Control-Allow-Origin"]).toBe("*");
    // ⓪ ADR-0342 §2：回應要**帶上 ttl**，客戶端才知道何時該刷新。
    expect(JSON.parse(r.body as string)).toEqual({ ...cfJson, ttl: 3600 });
    // 打對 Cloudflare API、帶 Bearer token 與 ttl。
    expect(seen?.url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate");
    expect((seen?.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(seen?.init?.body as string)).toEqual({ ttl: 3600 });
  });

  it("Cloudflare 回非 2xx → 204（保底抓不到不讓客戶端報錯）", async () => {
    const bad = (async () => ({ ok: false, status: 500, text: async () => "" }) as unknown as Response) as typeof fetch;
    const env = { TURN_KEY_ID: "k", TURN_API_TOKEN: "t" } as Env;
    expect(stub(await mintTurnResponse(env, authed(), bad)).init.status).toBe(204);
  });

  it("fetch 拋 → 204", async () => {
    const boom = (async () => {
      throw new Error("network");
    }) as typeof fetch;
    const env = { TURN_KEY_ID: "k", TURN_API_TOKEN: "t" } as Env;
    expect(stub(await mintTurnResponse(env, authed(), boom)).init.status).toBe(204);
  });

  it("🔴 未帶授權 → 401（**不是 204**——204 的語意是站方未配置，兩者不可混）", async () => {
    const env = { TURN_KEY_ID: "k", TURN_API_TOKEN: "t" } as Env;
    expect(stub(await mintTurnResponse(env, bare(), okFetch)).init.status).toBe(401);
  });

  it("🔴 對別的 URL 簽的授權不能拿來打 /turn", async () => {
    const env = { TURN_KEY_ID: "k", TURN_API_TOKEN: "t" } as Env;
    const wrong = {
      url: TURN_URL,
      method: "GET",
      headers: {
        get: (h: string) =>
          h === "Authorization" ? httpAuthHeader(buildHttpAuthEvent("https://relay.example/other", "GET", authSk)) : null,
      },
    } as unknown as Request;
    expect(stub(await mintTurnResponse(env, wrong, okFetch)).init.status).toBe(401);
  });

  it("⚠ 未配 secret 時先回 204，不因缺授權而變 401（站方未配置的語意優先）", async () => {
    expect(stub(await mintTurnResponse({} as Env, bare(), okFetch)).init.status).toBe(204);
  });

  it("超過取得速率 → 429，且**不去跟 Cloudflare 換憑證**", async () => {
    let called = 0;
    const spy = (async () => {
      called++;
      return { ok: true, status: 201, json: async () => cfJson } as unknown as Response;
    }) as typeof fetch;
    const env = {
      TURN_KEY_ID: "k",
      TURN_API_TOKEN: "t",
      TURN_LIMIT: { limit: async () => ({ success: false }) },
    } as unknown as Env;
    expect(stub(await mintTurnResponse(env, authed(), spy)).init.status).toBe(429);
    expect(called, "被限速就不該再花一次換發").toBe(0);
  });

  it("未綁定 TURN_LIMIT ⇒ 不限速（本地開發/測試沒有這個 binding，不該因此壞掉）", async () => {
    const env = { TURN_KEY_ID: "k", TURN_API_TOKEN: "t" } as Env;
    expect(stub(await mintTurnResponse(env, authed(), okFetch)).init.status).toBe(200);
  });

  it("🔴 審查 #1：CORS 預檢必須在授權檢查之前放行，且帶 Allow-Headers: Authorization", () => {
    // `Authorization` 不是 CORS 安全列表標頭 ⇒ 瀏覽器（含 Tauri／Capacitor webview）會先送
    // OPTIONS。若讓它走進換發流程會回 401 且無 CORS 標頭 ⇒ 瀏覽器擋掉整個請求、TURN 靜默失效。
    const r = stub(turnPreflightResponse());
    expect(r.init.status).toBe(204);
    expect(r.init.headers?.["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(r.init.headers?.["Access-Control-Allow-Methods"]).toContain("GET");
    expect(r.init.headers?.["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("🔴 審查 #1：**每一種**回應都要帶 CORS（否則瀏覽器讀不到狀態、分不出被擋或未配置）", async () => {
    const envOff = {} as Env;
    const envOn = { TURN_KEY_ID: "k", TURN_API_TOKEN: "t" } as Env;
    const limited = {
      TURN_KEY_ID: "k",
      TURN_API_TOKEN: "t",
      TURN_LIMIT: { limit: async () => ({ success: false }) },
    } as unknown as Env;
    for (const [label, r] of [
      ["204 未配置", stub(await mintTurnResponse(envOff, bare(), okFetch))],
      ["401 未授權", stub(await mintTurnResponse(envOn, bare(), okFetch))],
      ["429 限速", stub(await mintTurnResponse(limited, authed(), okFetch))],
      ["200 正常", stub(await mintTurnResponse(envOn, authed(), okFetch))],
    ] as const) {
      expect(r.init.headers?.["Access-Control-Allow-Origin"], label).toBe("*");
    }
  });

  it("🔴 審查 #2：速率限制以 **IP** 計數——pubkey 由請求方自選、換一把不用錢", async () => {
    let key: string | undefined;
    const env = {
      TURN_KEY_ID: "k",
      TURN_API_TOKEN: "t",
      TURN_LIMIT: { limit: async (o: { key: string }) => ((key = o.key), { success: true }) },
    } as unknown as Env;
    const withIp = {
      url: TURN_URL,
      method: "GET",
      headers: {
        get: (h: string) =>
          h === "Authorization"
            ? httpAuthHeader(buildHttpAuthEvent(TURN_URL, "GET", authSk))
            : h === "CF-Connecting-IP"
              ? "203.0.113.7"
              : null,
      },
    } as unknown as Request;
    await mintTurnResponse(env, withIp, okFetch);
    expect(key, "以 pubkey 計數等於沒有限制").toBe("203.0.113.7");
    expect(key).not.toBe(getPublicKey(authSk));
  });

  it("沒有 CF-Connecting-IP（本地/測試）→ 退回 pubkey，不因此壞掉", async () => {
    let key: string | undefined;
    const env = {
      TURN_KEY_ID: "k",
      TURN_API_TOKEN: "t",
      TURN_LIMIT: { limit: async (o: { key: string }) => ((key = o.key), { success: true }) },
    } as unknown as Env;
    await mintTurnResponse(env, authed(), okFetch);
    expect(key).toBe(getPublicKey(authSk));
  });

  it("TTL 未設 → 預設 86400", async () => {
    let body: string | undefined;
    const spy = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return { ok: true, status: 201, text: async () => cfBody, json: async () => cfJson } as unknown as Response;
    }) as typeof fetch;
    const r = stub(await mintTurnResponse({ TURN_KEY_ID: "k", TURN_API_TOKEN: "t" } as Env, authed(), spy));
    expect(JSON.parse(body as string)).toEqual({ ttl: 86400 });
    // 回應帶的 ttl 必須與送給 Cloudflare 的一致（唯一真實來源，ADR-0342 §2）。
    expect((JSON.parse(r.body as string) as { ttl: number }).ttl).toBe(86400);
  });
});

describe("統一節點：選配靜態資產（ADR-0354）", () => {
  /**
   * 假的 `ASSETS` 綁定（Workers Static Assets 的 Fetcher）。
   * 記下它收到的 URL，並回一個可辨識的 body——用來斷言「這個請求真的被交給資產了」。
   */
  const fakeAssets = (): { binding: NonNullable<Env["ASSETS"]>; seen: string[] } => {
    const seen: string[] = [];
    const binding = {
      fetch: (req: Request) => {
        seen.push(new URL(req.url).pathname);
        return new Response("<!doctype html>index", { status: 200 });
      },
    } as unknown as NonNullable<Env["ASSETS"]>;
    return { binding, seen };
  };

  const get = async (
    path: string,
    env: Partial<Env>,
    headers: Record<string, string> = {},
  ): Promise<{ body: string; status: number | undefined }> => {
    const r = (await worker.fetch(new Request(`https://${HOST}${path}`, { headers }), env as Env)) as unknown as {
      body: string;
      init: { status?: number };
    };
    return { body: r.body, status: r.init?.status };
  };

  it("未綁定 ASSETS（純 relay，預設模式）→ `/` 維持純文字（現況不變）", async () => {
    const r = await get("/", {});
    expect(r.status).toBe(200);
    expect(r.body).toBe("Cinderous relay");
  });

  it("🔴 `/healthz` 回的是 `ok`——文件、官網與 App 的探測都照這個字串判斷", async () => {
    // 先前它回 `Cinderous relay`，而 ADR-0356、自架文件、官網中英文案與 `cf_verify_healthz`
    // 全都寫 `ok`。每個照著教學做的自架者都會得出「我的節點壞了」的結論。
    expect((await get("/healthz", {})).body).toBe("ok");
  });

  it("綁定 ASSETS → `/` 交給資產（SPA 首頁；回退由 not_found_handling 處理）", async () => {
    const { binding, seen } = fakeAssets();
    const r = await get("/", { ASSETS: binding });
    expect(r.body).toContain("index");
    expect(seen).toEqual(["/"]);
  });

  it("綁定 ASSETS → 深層路徑也交給資產（`/chat/npub1…` 由 SPA 回退接手）", async () => {
    const { binding, seen } = fakeAssets();
    await get("/chat/npub1abc", { ASSETS: binding });
    expect(seen).toEqual(["/chat/npub1abc"]);
  });

  it("🔴 綁定 ASSETS → `/healthz` **不得**被資產吃掉（自架文件與 PaaS 健康檢查靠它，ADR-0089）", async () => {
    const { binding, seen } = fakeAssets();
    const r = await get("/healthz", { ASSETS: binding });
    expect(r.body).toBe("ok");
    expect(seen).toEqual([]);
  });

  it("🔴 綁定 ASSETS → NIP-11 仍優先於資產（社群探測不能拿到 HTML）", async () => {
    const { binding, seen } = fakeAssets();
    const r = await get("/", { ASSETS: binding }, { Accept: "application/nostr+json" });
    expect((JSON.parse(r.body) as { name: string }).name).toBe("Cinderous SDK relay");
    expect(seen).toEqual([]);
  });

  it("🔴 綁定 ASSETS → `/turn` 仍優先於資產（通話保底不能變成 HTML）", async () => {
    const { binding, seen } = fakeAssets();
    const r = await get("/turn", { ASSETS: binding });
    expect(r.status).toBe(204); // 未配 secret＝no-op，但確實走到 TURN 分支
    expect(seen).toEqual([]);
  });

  it("🔴 綁定 ASSETS → 帶 Upgrade 的 `/` 仍到 DO（wrangler 需配 run_worker_first；程式碼側先擋住）", async () => {
    const { binding, seen } = fakeAssets();
    let routed = "";
    const env = {
      ASSETS: binding,
      RELAY_ROOM: {
        idFromName: (n: string) => {
          routed = n;
          return {} as never;
        },
        get: () => ({ fetch: () => new Response(null, { status: 101 }) }),
      },
    } as unknown as Env;
    await worker.fetch(new Request(`https://${HOST}/`, { headers: { Upgrade: "websocket" } }), env);
    expect(routed).toBe("global"); // ADR-0241 舊客戶端回退路徑
    expect(seen).toEqual([]); // 資產沒碰到這個請求
  });
});

describe("NIP-11 依路徑回該車道的文件（ADR-0366 P1 #6）", () => {
  const docAt = async (path: string): Promise<Record<string, unknown>> => {
    const res = await worker.fetch(
      new Request(`https://${HOST}${path}`, { headers: { Accept: "application/nostr+json" } }),
      {} as Env,
    );
    return JSON.parse((res as unknown as { body: string }).body) as Record<string, unknown>;
  };

  it("嚴格平面：要求 AUTH、具名訂閱", async () => {
    const doc = await docAt("/");
    expect((doc.limitation as Record<string, unknown>).auth_required).toBe(true);
    expect(doc.cinder_subscription_scope).toBe("named");
  });

  it("第三方車道：不要求 AUTH、接受標籤訂閱", async () => {
    const doc = await docAt("/app/elementalist");
    expect((doc.limitation as Record<string, unknown>).auth_required).toBe(false);
    expect(doc.cinder_subscription_scope).toBe("tagged");
  });

  it("🔴 認不得的路徑給嚴格版——問錯路徑不該拿到比較寬鬆的描述", async () => {
    expect((await docAt("/nope")).cinder_subscription_scope).toBe("named");
  });

  it("兩種路徑都報得出時鐘窗", async () => {
    for (const p of ["/", "/app/x"]) {
      expect((await docAt(p)).cinder_max_past_skew_sec, p).toBeGreaterThan(0);
    }
  });
});

describe("車道 PoW（ADR-0366 P2 #11）", () => {
  /**
   * 「沒挖礦」不能只寫 `minePow(..., 0)`：那是一顆**隨機** id，而隨機 id 有 1/256 的
   * 機率本來就帶 8 個前導零 ⇒ 該測試會偶發地變綠。實測抓到過一次。
   * 這裡明確要求「低於門檻」，讓「未挖礦」這件事是確定的。
   */
  const belowDifficulty = (sk: SecretKey, difficulty: number): NostrEvent => {
    for (let nonce = 0; ; nonce += 1) {
      const e = finalizeEvent(
        { kind: 1078, created_at: nowSec(), tags: [["t", "g"], ["n", String(nonce)]], content: "x" },
        sk,
      );
      if (leadingZeroBits(e.id) < difficulty) return e;
    }
  };

  const publish = async (
    env: Env,
    lane: "strict" | "app",
    difficulty: number,
    /** 要送一顆**達不到**這個難度的事件（測「未挖礦被拒」）。 */
    below?: number,
  ) => {
    const state = new FakeState();
    const room = newRoom(state, env);
    const ws = await open(room, state, lane);
    const sk = generateSecretKey();
    const e =
      below === undefined
        ? minePow({ kind: 1078, created_at: nowSec(), tags: [["t", "g"]], content: "x" }, sk, difficulty)
        : belowDifficulty(sk, below);
    // 車道連線一開始就有（可選的）AUTH 挑戰排在前面（ADR-0369），故以型別找出那則 OK。
    const out = send(room, ws, ["EVENT", e]) as [string, string, boolean, string][];
    return out.find((m) => m[0] === "OK") ?? out[0]!;
  };

  it("未設 APP_LANE_POW → 車道照收未挖礦的持久化事件（預設不打開）", async () => {
    expect((await publish({} as Env, "app", 0))[2]).toBe(true);
  });

  it("設了就生效：未挖礦的事件被拒、挖過的收下", async () => {
    const env = { APP_LANE_POW: "8" } as Env;
    const rejected = await publish(env, "app", 0, 8);
    expect(rejected[2]).toBe(false);
    expect(rejected[3]).toContain("pow");
    expect((await publish(env, "app", 8))[2]).toBe(true);
  });

  it("🔴 同一個變數對嚴格平面無效——自架者設錯不會鎖死自己的訊息平面", async () => {
    const env = { APP_LANE_POW: "8" } as Env;
    const state = new FakeState();
    const room = newRoom(state, env);
    const ws = await open(room, state); // 嚴格
    // 嚴格平面要 AUTH，先認證再發一顆沒挖過的持久化事件。
    const sk = generateSecretKey();
    const challenge = (ws.drain()[0] as [string, string])[1];
    send(room, ws, ["AUTH", buildAuthEvent(challenge, RELAY_URL, sk)]);
    const e = finalizeEvent({ kind: 1078, created_at: nowSec(), tags: [], content: "x" }, sk);
    const ok = send(room, ws, ["EVENT", e])[0] as [string, string, boolean, string];
    expect(ok[2]).toBe(true); // 沒有 PoW 也收得下
  });
});

describe("車道的成本護欄（ADR-0366 §容量）", () => {
  /** 以 IP 為鍵的升級速率限制替身；記下每次被問到的 key。 */
  const limiter = (allow: boolean) => {
    const keys: string[] = [];
    return {
      keys,
      binding: {
        limit: (opts: { key: string }) => {
          keys.push(opts.key);
          return Promise.resolve({ success: allow });
        },
      },
    };
  };

  /** 送一次升級請求；回傳 [狀態碼, 是否碰到 DO]。 */
  const upgrade = async (path: string, env: Partial<Env>, ip?: string): Promise<[number, boolean]> => {
    let touchedDo = false;
    const full = {
      ...env,
      RELAY_ROOM: {
        idFromName: () => {
          touchedDo = true;
          return {} as never;
        },
        get: () => ({ fetch: () => new Response(null, { status: 101 }) }),
      },
    } as unknown as Env;
    const headers: Record<string, string> = { Upgrade: "websocket" };
    if (ip !== undefined) headers["CF-Connecting-IP"] = ip;
    const res = await worker.fetch(new Request(`https://${HOST}${path}`, { headers }), full);
    return [res.status, touchedDo];
  };

  it("車道升級超過 IP 限額：被擋下，且**根本不碰 DO**（回絕的形狀見 ADR-0368 那組測試）", async () => {
    const { binding, keys } = limiter(false);
    const [, touchedDo] = await upgrade("/app/testgame", { APP_LANE_LIMIT: binding }, "203.0.113.7");
    expect(touchedDo).toBe(false);
    expect(keys).toEqual(["203.0.113.7"]); // 以 IP 計數，不是 pubkey——換一把金鑰是微秒級的事
  });

  it("額度內照常升級", async () => {
    const { binding } = limiter(true);
    const [status, touchedDo] = await upgrade("/app/testgame", { APP_LANE_LIMIT: binding }, "203.0.113.7");
    expect(status).toBe(101);
    expect(touchedDo).toBe(true);
  });

  it("🔴 嚴格平面不受此限制——那裡是本專案自己的使用者，且要求 NIP-42", async () => {
    const { binding, keys } = limiter(false);
    for (const path of ["/", "/s/a", "/presence"]) {
      const [status] = await upgrade(path, { APP_LANE_LIMIT: binding }, "203.0.113.7");
      expect(status, path).toBe(101);
    }
    expect(keys).toEqual([]);
  });

  it("沒有 CF-Connecting-IP 就不限——不是把所有人塞進同一個桶", async () => {
    // 該標頭由 Cloudflare 填寫、客戶端偽造不了；缺了代表根本不在 CF 後面，
    // 此時用單一 key 會讓**所有人共用一個額度**，第一個濫用者就把全站擋死。
    const { binding, keys } = limiter(false);
    const [status] = await upgrade("/app/testgame", { APP_LANE_LIMIT: binding });
    expect(status).toBe(101);
    expect(keys).toEqual([]);
  });

  it("沒綁定＝不限速（本地開發與自架站不該因此壞掉）", async () => {
    const [status] = await upgrade("/app/testgame", {}, "203.0.113.7");
    expect(status).toBe(101);
  });

  it("每連線訊息上限觸發時，宿主送出 NOTICE 之後真的把連線關掉", async () => {
    // 用 CLOSE 灌：它不佔訂閱數上限，測的就是「訊息次數」本身。
    const state = new FakeState();
    const room = newRoom(state);
    const ws = await open(room, state, "app");
    for (let i = 0; i < MAX_MESSAGES_PER_MINUTE; i += 1) {
      send(room, ws, ["CLOSE", "s1"]);
      expect(ws.closed, `第 ${i + 1} 則就被關掉了`).toBe(false);
    }
    const out = send(room, ws, ["CLOSE", "s1"]);
    expect((out[0] as string[])[0]).toBe("NOTICE");
    expect(String((out[0] as string[])[1])).toMatch(/rate-limited/);
    expect(ws.closed).toBe(true);
  });
});

describe("已知租戶名單（ADR-0366 §裁示）", () => {
  /** 回傳 [DO 名, HTTP 狀態]。 */
  const route = async (path: string, lanes?: string): Promise<[string, number]> => {
    let doName = "";
    const env = {
      ...(lanes === undefined ? {} : { APP_LANES: lanes }),
      RELAY_ROOM: {
        idFromName: (n: string) => {
          doName = n;
          return {} as never;
        },
        get: () => ({ fetch: () => new Response(null, { status: 101 }) }),
      },
    } as unknown as Env;
    const res = await worker.fetch(
      new Request(`https://${HOST}${path}`, { headers: { Upgrade: "websocket" } }),
      env,
    );
    return [doName, res.status];
  };

  it("名單上的車道有自己的 DO", async () => {
    const [doName, status] = await route("/app/lwd", "lwd, elementalist");
    expect(doName).toBe(namedLaneName("lwd"));
    expect(status).toBe(101);
  });

  it("🔴 不在名單上的照常服務，只是共用雜湊分片——錨點同時是公用 relay", async () => {
    const [doName, status] = await route("/app/someoneelse", "lwd, elementalist");
    expect(status).toBe(101);
    expect(doName).toMatch(/^app-[0-7]$/);
    expect(doName).not.toBe(namedLaneName("someoneelse"));
  });

  it("沒設名單＝沒有已知租戶，全部共用分片（車道剛上線時的行為）", async () => {
    const [doName, status] = await route("/app/lwd");
    expect(status).toBe(101);
    expect(doName).toMatch(/^app-[0-7]$/);
  });

  it("配額跟著名單走：已知租戶 64、公用車道 16，且休眠後仍然一致", async () => {
    /** 對某顆 DO 連續發 n 筆可尋址事件（各自不同 `d`），回傳被接受的筆數。 */
    const accepted = async (lanes: string | undefined, n: number): Promise<number> => {
      const state = new FakeState();
      const env = (lanes === undefined ? {} : { APP_LANES: lanes }) as unknown as Env;
      const room = newRoom(state, env);
      const ws = await open(room, state, "app");
      ws.drain();
      const sk = generateSecretKey();
      let ok = 0;
      for (let i = 0; i < n; i += 1) {
        const event = finalizeEvent(
          {
            kind: 31081,
            created_at: nowSec(),
            tags: [["d", `deck-${i}`]],
            content: "{}",
          },
          sk,
        );
        const out = send(room, ws, ["EVENT", event]) as [string, string, boolean, string][];
        if (out.find((m) => m[0] === "OK")?.[2] === true) ok += 1;
      }
      return ok;
    };

    // 公用車道：第 17 筆被拒
    expect(await accepted(undefined, PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR + 1)).toBe(
      PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR,
    );
    // 名單上的車道（DO 名不同，這裡以 `/app/testgame` 進來）：同樣筆數全收
    expect(await accepted("testgame", PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR + 1)).toBe(
      PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR + 1,
    );
  });
});

describe("NIP-11 依路徑回報真實保存期（ADR-0367 §後果）", () => {
  const doc = async (path: string, lanes?: string): Promise<Record<string, unknown>> => {
    const env = { ...(lanes === undefined ? {} : { APP_LANES: lanes }) } as unknown as Env;
    const res = (await worker.fetch(
      new Request(`https://${HOST}${path}`, { headers: { Accept: "application/nostr+json" } }),
      env,
    )) as unknown as { body: string };
    return JSON.parse(res.body) as Record<string, unknown>;
  };

  it("公用分片誠實回報見習期；名單上的車道回報正常保存期", async () => {
    expect((await doc("/app/stranger", "lwd")).retention).toEqual([
      { time: PUBLIC_LANE_RETENTION_SECONDS },
    ]);
    expect((await doc("/app/lwd", "lwd")).retention).toEqual([{ time: 7 * 86_400 }]);
    expect((await doc("/")).retention).toEqual([{ time: 7 * 86_400 }]);
  });

  it("可尋址壽命也照路徑回報——客戶端原本只能猜", async () => {
    expect((await doc("/app/stranger", "lwd")).cinder_addressable_ttl_sec).toBe(
      PUBLIC_LANE_RETENTION_SECONDS,
    );
    expect((await doc("/app/lwd", "lwd")).cinder_addressable_ttl_sec).toBe(30 * 86_400);
  });
});

describe("白名單模式 ALLOWED_PUBKEYS（SDK ADR 0008）", () => {
  const publish = async (env: Partial<Env>, sk: SecretKey, lane: "strict" | "app" = "strict") => {
    const state = new FakeState();
    const room = newRoom(state, env as Env);
    const ws = await open(room, state, lane);
    authenticate(room, ws, sk);
    const out = send(room, ws, ["EVENT", heartbeat(sk)]) as [string, string, boolean, string][];
    return out.find((m) => m[0] === "OK");
  };

  it("名單上的人可以發布", async () => {
    const sk = generateSecretKey();
    expect((await publish({ ALLOWED_PUBKEYS: getPublicKey(sk) }, sk))?.[2]).toBe(true);
  });

  it("名單外的人發不了（認證時就被擋下）", async () => {
    const ok = await publish({ ALLOWED_PUBKEYS: getPublicKey(generateSecretKey()) }, generateSecretKey());
    expect(ok?.[2]).toBe(false);
  });

  it("🔴 名單外的人認證後以 4003 斷線（PRD 3.3；SDK ADR 0013）", async () => {
    const state = new FakeState();
    const room = newRoom(state, { ALLOWED_PUBKEYS: getPublicKey(generateSecretKey()) } as Env);
    const ws = await open(room, state);
    expect(authenticate(room, ws, generateSecretKey())).toBe(false);
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(4003);
    expect(ws.closeReason).toBe("restricted");
  });

  it("🔴 車道也擋——否則白名單站換個 /app/ 路徑就被繞過", async () => {
    const ok = await publish({ ALLOWED_PUBKEYS: getPublicKey(generateSecretKey()) }, generateSecretKey(), "app");
    expect(ok?.[2]).toBe(false);
  });

  it("沒設＝開放（現有錨點行為不變）", async () => {
    expect((await publish({}, generateSecretKey()))?.[2]).toBe(true);
  });

  it("NIP-11 標示 restricted_writes", async () => {
    const r = (await worker.fetch(
      new Request(`https://${HOST}/`, { headers: { Accept: "application/nostr+json" } }),
      { ALLOWED_PUBKEYS: getPublicKey(generateSecretKey()) } as unknown as Env,
    )) as unknown as { body: string };
    const doc = JSON.parse(r.body) as { limitation: Record<string, unknown> };
    expect(doc.limitation.restricted_writes).toBe(true);
  });
});

describe("檔案車道（FILE_LANES，Cinderous ADR-0371）", () => {
  const FILE_ENV = { APP_LANES: "testgame,other", FILE_LANES: "testgame", MAX_FILE_MB: "30" } as unknown as Env;
  const LEGACY_ENV = { APP_LANES: "testgame,other", MAX_FILE_MB: "30" } as unknown as Env;

  /** 在指定路徑升級一條連線。 */
  const openAt = async (room: RelayRoom, state: FakeState, path: string): Promise<FakeWs> => {
    const before = state.sockets.length;
    const res = await room.fetch(new Request(`https://${HOST}${path}`));
    expect((res as unknown as { status: number }).status).toBe(101);
    return state.sockets[before]!;
  };

  const fileChunk = (sk: SecretKey = generateSecretKey(), to = "a".repeat(64)): NostrEvent =>
    finalizeEvent({ kind: 1060, created_at: nowSec(), tags: [["p", to]], content: "x" }, sk);

  /** 在某路徑送一顆檔案塊，回傳 OK 訊息。嚴格平面會先完成 AUTH。 */
  const sendFile = async (env: Env, path: string): Promise<[string, string, boolean, string]> => {
    const state = new FakeState();
    const room = newRoom(state, env);
    const ws = await openAt(room, state, path);
    const sk = generateSecretKey();
    if (!path.startsWith("/app/")) expect(authenticate(room, ws, sk)).toBe(true);
    ws.drain();
    const e = fileChunk(sk);
    const out = send(room, ws, ["EVENT", e]) as [string, string, boolean, string][];
    return out.find((m) => m[0] === "OK")!;
  };

  it("只有名單上的檔案車道收檔案塊", async () => {
    expect((await sendFile(FILE_ENV, "/app/testgame"))[2]).toBe(true);
  });

  it("🔴 Cinderous 主訊息平面（舊全域、分片、presence）整類拒收", async () => {
    for (const path of ["/", "/s/a", "/presence"]) {
      const ok = await sendFile(FILE_ENV, path);
      expect(ok[2], path).toBe(false);
      expect(ok[3], path).toContain("blocked");
    }
  });

  it("🔴 其他已知車道與共用分片也拒收——只開給 FILE_LANES 列的那幾條", async () => {
    expect((await sendFile(FILE_ENV, "/app/other"))[2]).toBe(false);
    expect((await sendFile(FILE_ENV, "/app/stranger"))[2]).toBe(false);
  });

  it("🔴 回歸：沒設 FILE_LANES 時 MAX_FILE_MB 仍是全站開關（企業自架行為不變）", async () => {
    expect((await sendFile(LEGACY_ENV, "/"))[2]).toBe(true);
    expect((await sendFile(LEGACY_ENV, "/app/stranger"))[2]).toBe(true);
    expect((await sendFile(LEGACY_ENV, "/app/other"))[2]).toBe(true);
  });

  it("🔴 車道 id 跨休眠存活：喚醒後沒有 fetch 也還是檔案車道", async () => {
    const state = new FakeState();
    const room = newRoom(state, FILE_ENV);
    const ws = await openAt(room, state, "/app/testgame");
    ws.drain();
    const woke = newRoom(state, FILE_ENV); // 模擬休眠後喚醒：記憶體清空、storage 還在
    await new Promise((r) => setTimeout(r, 0)); // 讓建構子裡的 storage 還原跑完
    const out = send(woke, ws, ["EVENT", fileChunk()]) as [string, string, boolean, string][];
    expect(out.find((m) => m[0] === "OK")?.[2]).toBe(true);
  });

  it("升級前就已釘住政策的 DO（storage 裡沒有車道 id）：下一次連線補記，不回 409", async () => {
    const state = new FakeState();
    state.kv.set("cinder:lane-profile", "app");
    state.kv.set("cinder:lane-known", true);
    const room = newRoom(state, FILE_ENV);
    await new Promise((r) => setTimeout(r, 0)); // 讓建構子裡的 storage 還原跑完
    const ws = await openAt(room, state, "/app/testgame");
    ws.drain();
    const out = send(room, ws, ["EVENT", fileChunk()]) as [string, string, boolean, string][];
    expect(out.find((m) => m[0] === "OK")?.[2]).toBe(true);
  });

  it("每收件人檔案塊配額由單檔上限推得（MAX_FILE_MB=1 → 2×22＋128＝172 塊）", { timeout: 30_000 }, async () => {
    const env = { ...FILE_ENV, MAX_FILE_MB: "1" } as unknown as Env;
    const state = new FakeState();
    const room = newRoom(state, env);
    const ws = await openAt(room, state, "/app/testgame");
    ws.drain();
    for (let i = 0; i < 180; i += 1) send(room, ws, ["EVENT", fileChunk()]);
    const n = state.storage.sql.exec("SELECT COUNT(*) AS n FROM offline_msgs WHERE kind = 1060").toArray()[0]!.n;
    expect(n).toBe(172);
  });

  describe("NIP-11 如實宣告（客戶端遵守單檔上限；relay 無法重組檔案）", () => {
    const doc = async (env: Env, path: string): Promise<Record<string, unknown>> => {
      const res = (await worker.fetch(
        new Request(`https://${HOST}${path}`, { headers: { Accept: "application/nostr+json" } }),
        env,
      )) as unknown as { body: string };
      return JSON.parse(res.body) as Record<string, unknown>;
    };

    it("檔案車道：收、單檔上限 30MB、每收件人配額 1440 塊", async () => {
      const d = await doc(FILE_ENV, "/app/testgame");
      expect(d.cinder_accepts_files).toBe(true);
      expect(d.cinder_max_file_mb).toBe(30);
      expect(d.cinder_file_chunks_per_recipient).toBe(1440);
    });

    it("🔴 根路徑（主平面）與其他車道：不收、也不宣告上限", async () => {
      for (const path of ["/", "/app/other", "/app/stranger"]) {
        const d = await doc(FILE_ENV, path);
        expect(d.cinder_accepts_files, path).toBe(false);
        expect(d.cinder_max_file_mb, path).toBeUndefined();
      }
    });

    it("回歸：沒設 FILE_LANES 時文件與過去相同（收，但不宣告單檔上限）", async () => {
      const d = await doc(LEGACY_ENV, "/");
      expect(d.cinder_accepts_files).toBe(true);
      expect(d.cinder_max_file_mb).toBeUndefined();
      expect(d.cinder_file_chunks_per_recipient).toBeUndefined();
    });
  });
});

describe("同一顆 DO 從 Cinderous main 版切到 SDK 版（SDK ADR 0029；Cinderous PR #9 的前置條件）", () => {
  const FILE_ENV = { APP_LANES: "testgame", FILE_LANES: "testgame", MAX_FILE_MB: "30" } as unknown as Env;

  it("🔴 storage 已由 Cinderous main 釘住（profile／known／lane-id 與 ADR-0371 schema）：照常連線、取回舊塊、繼續收新塊", async () => {
    const state = new FakeState();
    // Cinderous main（73756982）留下的 DO 狀態：KV 三個鍵＋建構子跑完後的 schema（見 schema-compat.test.ts）
    state.kv.set("cinder:lane-profile", "app");
    state.kv.set("cinder:lane-known", true);
    state.kv.set("cinder:lane-id", "testgame");
    const sql = (q: string, ...b: (string | number | null)[]) => state.storage.sql.exec(q, ...b).toArray();
    sql(`CREATE TABLE offline_msgs (
        id TEXT NOT NULL, recipient TEXT NOT NULL, expiration INTEGER, created_at INTEGER NOT NULL,
        json TEXT NOT NULL, pubkey TEXT, kind INTEGER, bytes INTEGER, PRIMARY KEY (id, recipient))`);
    sql(`CREATE TABLE addressable (kind INTEGER NOT NULL, pubkey TEXT NOT NULL, d TEXT NOT NULL, id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expiration INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, pubkey, d))`);
    sql("CREATE INDEX idx_addressable_expiration ON addressable(expiration)");
    sql("CREATE INDEX idx_addressable_pubkey ON addressable(pubkey)");
    sql("CREATE INDEX idx_offline_bucket ON offline_msgs(recipient, kind, created_at, expiration, bytes)");
    sql("CREATE INDEX idx_offline_bytes_missing ON offline_msgs(id) WHERE bytes IS NULL");
    sql("CREATE INDEX idx_offline_expiration ON offline_msgs(expiration)");
    sql("CREATE INDEX idx_offline_kind ON offline_msgs(kind)");
    sql("CREATE INDEX idx_offline_pubkey ON offline_msgs(pubkey)");
    const bob = generateSecretKey();
    const bobPk = getPublicKey(bob);
    const old = finalizeEvent({ kind: 1060, created_at: nowSec() - 60, tags: [["p", bobPk]], content: "old" }, generateSecretKey());
    const json = JSON.stringify(old);
    sql(
      `INSERT INTO offline_msgs (id, recipient, expiration, created_at, json, pubkey, kind, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      old.id, bobPk, nowSec() + 86_400, old.created_at, json, old.pubkey, old.kind, json.length,
    );

    const room = newRoom(state, FILE_ENV);
    await new Promise((r) => setTimeout(r, 0)); // 讓建構子裡的 storage 還原跑完
    const res = await room.fetch(new Request(`https://${HOST}/app/testgame`));
    expect((res as unknown as { status: number }).status).toBe(101); // 不是 409（政策與車道 id 都對得上）
    const ws = state.sockets[0]!;
    expect(authenticate(room, ws, bob)).toBe(true);
    ws.drain();
    const got = send(room, ws, ["REQ", "s", { "#p": [bobPk] }]) as unknown[][];
    expect(got.filter((m) => m[0] === "EVENT").map((m) => (m[2] as NostrEvent).id)).toEqual([old.id]);
    const fresh = finalizeEvent({ kind: 1060, created_at: nowSec(), tags: [["p", bobPk]], content: "new" }, generateSecretKey());
    const ok = (send(room, ws, ["EVENT", fresh]) as [string, string, boolean, string][]).find((m) => m[0] === "OK")!;
    expect(ok[2]).toBe(true);
    const row = sql("SELECT bytes FROM offline_msgs WHERE id = ?", fresh.id)[0] as { bytes: number };
    expect(row.bytes).toBe(JSON.stringify(fresh).length);
  });
});

describe("白名單（SDK ADR 0028 §7）× 檔案車道（Cinderous ADR-0371）合併後的行為（SDK ADR 0029）", () => {
  const member = generateSecretKey();
  const base = { APP_LANES: "testgame,other", ALLOWED_PUBKEYS: getPublicKey(member) };

  /** 以 `who` 認證（可不認證）後，在 `path` 送一顆由一次性金鑰簽的檔案塊，回傳 OK。 */
  const sendWrapped = async (env: Env, path: string, who?: SecretKey): Promise<[string, string, boolean, string]> => {
    const state = new FakeState();
    const room = newRoom(state, env);
    await room.fetch(new Request(`https://${HOST}${path}`));
    const ws = state.sockets[0]!;
    if (who) expect(authenticate(room, ws, who)).toBe(true);
    ws.drain();
    const e = finalizeEvent({ kind: 1060, created_at: nowSec(), tags: [["p", "a".repeat(64)]], content: "x" }, generateSecretKey());
    return (send(room, ws, ["EVENT", e]) as [string, string, boolean, string][]).find((m) => m[0] === "OK")!;
  };

  it("車道模式：已認證成員在檔案車道送外層是一次性金鑰的檔案塊 ⇒ 收", async () => {
    const env = { ...base, FILE_LANES: "testgame", MAX_FILE_MB: "30" } as unknown as Env;
    expect((await sendWrapped(env, "/app/testgame", member))[2]).toBe(true);
  });

  it("🔴 車道模式：白名單的例外不會越過檔案政策——主平面與非檔案車道照舊拒收", async () => {
    const env = { ...base, FILE_LANES: "testgame", MAX_FILE_MB: "30" } as unknown as Env;
    for (const path of ["/", "/app/other"]) {
      const ok = await sendWrapped(env, path, member);
      expect(ok[2], path).toBe(false);
      expect(ok[3], path).toContain("檔案事件未啟用");
    }
  });

  it("🔴 車道模式：沒認證（車道的 AUTH 是選擇性的）就不適用例外 ⇒ 白名單擋下", async () => {
    const env = { ...base, FILE_LANES: "testgame", MAX_FILE_MB: "30" } as unknown as Env;
    const ok = await sendWrapped(env, "/app/testgame");
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("allowlist");
  });

  it("自架單人站（沒有 FILE_LANES）：MAX_FILE_MB 是全站開關，成員在根路徑就能送（SDK 一鍵部署的形狀）", async () => {
    const env = { ...base, MAX_FILE_MB: "30" } as unknown as Env;
    expect((await sendWrapped(env, "/", member))[2]).toBe(true);
  });
});

describe("客戶端讀得到車道的檔案政策（SDK ADR 0029：fetchRelayFilePolicy × 真正的 Worker 路由）", () => {
  const env = { APP_LANES: "testgame,other", FILE_LANES: "testgame", MAX_FILE_MB: "30" } as unknown as Env;
  const viaWorker = (seen: string[]): RelayInfoFetch => async (url, init) => {
    seen.push(url);
    const res = (await worker.fetch(new Request(url, { headers: init.headers }), env)) as unknown as { status: number; body: string };
    return { status: res.status, text: async () => res.body };
  };

  it("🔴 wss://<host>/app/<車道>：GET 同一路徑，拿到 30MB／1440 塊／7 天；根路徑與其他車道不收", async () => {
    const seen: string[] = [];
    const lane = await fetchRelayFilePolicy(`wss://${HOST}/app/testgame`, { fetch: viaWorker(seen) });
    expect(seen).toEqual([`https://${HOST}/app/testgame`]);
    expect(lane).toMatchObject({ acceptsFiles: true, maxFileMb: 30, fileChunksPerRecipient: 1440, retentionSeconds: 7 * 86_400 });
    for (const path of ["", "/app/other"]) {
      const other = await fetchRelayFilePolicy(`wss://${HOST}${path}`, { fetch: viaWorker([]) });
      expect(other.acceptsFiles, path).toBe(false);
      expect(other.maxFileMb, path).toBeUndefined();
    }
  });
});

// ── SDK 專屬功能 × Cinderous ADR-0372／0373（SDK ADR 0032）────────────────────
//
// 上面那組 ADR-0373 測試是從 Cinderous 逐字移植的；這裡釘住「SDK 才有的功能」與兩個修正疊在一起的行為。
// 假 DO 的 SQL 也與 DO 一樣限 100 個綁定參數（見 FakeState.raw），所以大 filter 在這一層也是真的測到。

/** 在指定路徑升級一條連線（可帶 CF-Connecting-IP）。 */
async function openPath(room: RelayRoom, state: FakeState, path: string, ip?: string): Promise<FakeWs> {
  const before = state.sockets.length;
  const headers: Record<string, string> = {};
  if (ip !== undefined) headers["CF-Connecting-IP"] = ip;
  const res = await room.fetch(new Request(`https://${HOST}${path}`, { headers }));
  expect((res as unknown as { status: number }).status).toBe(101);
  return state.sockets[before]!;
}

describe("白名單站（SDK ADR 0008／0013）× 溢位訂閱（Cinderous ADR-0373；SDK ADR 0032）", () => {
  it("🔴 成員的 1024 把 authors 訂閱：EOSE、休眠後仍收得到另一位成員的事件", async () => {
    const watcherSk = generateSecretKey();
    const pubSk = generateSecretKey();
    const env = { ALLOWED_PUBKEYS: `${getPublicKey(watcherSk)},${getPublicKey(pubSk)}` } as unknown as Env;
    const state = new FakeState();
    const room1 = newRoom(state, env);
    const watcher = await open(room1, state);
    expect(authenticate(room1, watcher, watcherSk)).toBe(true);
    watcher.drain();
    const out = send(room1, watcher, ["REQ", "hb", { kinds: [20000], authors: [...fakeAuthors(1023), getPublicKey(pubSk)] }]);
    expect(out).toEqual([["EOSE", "hb"]]);
    expect(state.wsSubsRows().map((r) => r.sub_id)).toEqual(["hb"]);

    const room2 = newRoom(state, env); // 休眠：只剩 storage 與 attachment
    const beat = await publishBeat(room2, state, pubSk);
    const got = watcher.drain() as [string, string, NostrEvent][];
    expect(got.find((m) => m[0] === "EVENT" && m[1] === "hb")?.[2]?.id).toBe(beat.id);
  });

  it("🔴 車道上沒認證就先訂了大訂閱、再以名單外的身分認證 ⇒ 4003 斷線，溢位列一起清掉", async () => {
    const env = { APP_LANES: "testgame", ALLOWED_PUBKEYS: getPublicKey(generateSecretKey()) } as unknown as Env;
    const state = new FakeState();
    const room = newRoom(state, env);
    const ws = await openPath(room, state, "/app/testgame");
    ws.drain();
    // 車道的 AUTH 是選擇性的（ADR-0369），authors 訂閱不必先認證。
    expect(send(room, ws, ["REQ", "big", { authors: fakeAuthors(400) }])).toEqual([["EOSE", "big"]]);
    expect(state.wsSubsRows()).toHaveLength(1);
    expect(authenticate(room, ws, generateSecretKey())).toBe(false);
    expect(ws.closeCode).toBe(4003);
    expect(state.wsSubsRows()).toEqual([]);
  });

  it("每把公鑰連線數上限：休眠還原後照樣算得到舊連線（它的大訂閱也還在）", async () => {
    const sk = generateSecretKey();
    const env = { ALLOWED_PUBKEYS: getPublicKey(sk), MAX_CONNECTIONS_PER_PUBKEY: "1" } as unknown as Env;
    const state = new FakeState();
    const room1 = newRoom(state, env);
    const first = await open(room1, state);
    expect(authenticate(room1, first, sk)).toBe(true);
    send(room1, first, ["REQ", "hb", { kinds: [20000], authors: [...fakeAuthors(500), getPublicKey(sk)] }]);

    const room2 = newRoom(state, env);
    const second = await open(room2, state);
    expect(authenticate(room2, second, sk)).toBe(false);
    expect(second.closeCode).toBe(1008);
    // 第一條不受影響：它自己發的心跳仍打到它的大訂閱
    first.drain();
    const beat = heartbeat(sk);
    const echo = send(room2, first, ["EVENT", beat]) as unknown[][];
    expect(echo.some((m) => m[0] === "EVENT" && m[1] === "hb")).toBe(true);
    expect(state.wsSubsRows()).toHaveLength(1); // 被拒的那條沒有留下任何列
  });

  it("每 IP 速率超限被關（1008）⇒ 溢位列一起清掉", async () => {
    const env = { APP_LANES: "testgame", MAX_MESSAGES_PER_SECOND_PER_IP: "2" } as unknown as Env;
    const state = new FakeState();
    const room = newRoom(state, env);
    const ws = await openPath(room, state, "/app/testgame", "198.51.100.7");
    send(room, ws, ["REQ", "big", { authors: fakeAuthors(400) }]);
    expect(state.wsSubsRows()).toHaveLength(1);
    send(room, ws, ["REQ", "x", { authors: fakeAuthors(1) }]);
    send(room, ws, ["REQ", "y", { authors: fakeAuthors(1) }]); // 第 3 則：超過每秒 2 則
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
    expect(state.wsSubsRows()).toEqual([]);
  });
});

describe("檔案車道（Cinderous ADR-0371；SDK ADR 0029）× 大量 authors（Cinderous ADR-0372／0373；SDK ADR 0032）", () => {
  const FILE_ENV = { APP_LANES: "testgame", FILE_LANES: "testgame", MAX_FILE_MB: "30" } as unknown as Env;
  const TO = "a".repeat(64);

  /** 150 把不同金鑰各送一顆檔案塊（各自一條連線，避開每連線速率）。 */
  async function seedChunks(room: RelayRoom, state: FakeState, n: number): Promise<{ sks: SecretKey[]; ids: string[] }> {
    const sks: SecretKey[] = [];
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const sk = generateSecretKey();
      const ws = await openPath(room, state, "/app/testgame");
      const e = finalizeEvent({ kind: 1060, created_at: nowSec() - n + i, tags: [["p", TO]], content: `c${i}` }, sk);
      const ok = (send(room, ws, ["EVENT", e]) as [string, string, boolean][]).find((m) => m[0] === "OK");
      expect(ok?.[2]).toBe(true);
      sks.push(sk);
      ids.push(e.id);
    }
    return { sks, ids };
  }

  it("🔴 kinds:[1060] ＋ authors 150 把：補得回全部 150 顆並 EOSE（修正前綁定參數超過 100 ⇒ NOTICE、沒有 EOSE）", async () => {
    const state = new FakeState();
    const room = newRoom(state, FILE_ENV);
    await new Promise((r) => setTimeout(r, 0)); // 讓建構子裡的 storage 還原跑完（同一顆 room 會升級很多次）
    const { sks, ids } = await seedChunks(room, state, 150);
    const ws = await openPath(room, state, "/app/testgame");
    ws.drain();
    const out = send(room, ws, ["REQ", "files", { kinds: [1060], authors: sks.map((sk) => getPublicKey(sk)), limit: 500 }]) as unknown[][];
    expect(out.at(-1)).toEqual(["EOSE", "files"]);
    const got = out.filter((m) => m[0] === "EVENT").map((m) => (m[2] as NostrEvent).id);
    expect(got.sort()).toEqual([...ids].sort());
  }, 30_000); // 150 次簽章＋驗章，整套測試滿載時會超過預設的 5 秒

  it("🔴 kinds:[1060] ＋ authors 300 把（溢位）：休眠後新的檔案塊仍即時送到", async () => {
    const state = new FakeState();
    const room1 = newRoom(state, FILE_ENV);
    const sender = generateSecretKey();
    const watcher = await openPath(room1, state, "/app/testgame");
    watcher.drain();
    const out = send(room1, watcher, ["REQ", "files", { kinds: [1060], authors: [...fakeAuthors(299), getPublicKey(sender)] }]);
    expect(out).toEqual([["EOSE", "files"]]);
    expect(state.wsSubsRows().map((r) => r.sub_id)).toEqual(["files"]);

    const room2 = newRoom(state, FILE_ENV);
    const ws = await openPath(room2, state, "/app/testgame");
    const chunk = finalizeEvent({ kind: 1060, created_at: nowSec(), tags: [["p", TO]], content: "late" }, sender);
    expect((send(room2, ws, ["EVENT", chunk]) as [string, string, boolean][]).find((m) => m[0] === "OK")?.[2]).toBe(true);
    const got = watcher.drain() as [string, string, NostrEvent][];
    expect(got.find((m) => m[0] === "EVENT" && m[1] === "files")?.[2]?.id).toBe(chunk.id);
  });
});

describe("同一顆 DO 從 Cinderous（PR #12＋#13）切到 SDK 版：溢位訂閱照常還原（SDK ADR 0032；Cinderous PR #9 的前置條件）", () => {
  /**
   * 夾具抄自**真正執行** Cinderous 程式留下的狀態：把 `claude/relay-ws-attachment-limit`（ADR-0373）的
   * `relay/src` 疊上 `claude/relay-sql-param-limit`（ADR-0372）的 `sql-message-store.ts`，以 esbuild 打包，
   * 在 node:sqlite 上跑它的 `RelayRoom`：`/presence` 認證 → REQ hb（300 把）→ REQ small（1 把），
   * 再 dump attachment 與 `ws_subs`。attachment 的欄位依序是 connId／challenge／pubkey／relayHost／subs／spilled，
   * `ws_subs` 的 DDL 見 schema-compat.test.ts。
   */
  it("🔴 attachment 記著 spilled、ws_subs 裡有那一列：SDK 的 RelayRoom 還原兩條訂閱，喚醒後第一則訊息零寫入", async () => {
    const state = new FakeState();
    state.kv.set("cinder:lane-profile", "strict");
    state.kv.set("cinder:lane-known", false);
    const sql = (q: string, ...b: (string | number | null)[]) => state.storage.sql.exec(q, ...b).toArray();
    sql(`CREATE TABLE ws_subs (
        conn_id TEXT NOT NULL,
        sub_id  TEXT NOT NULL,
        filters TEXT NOT NULL,
        PRIMARY KEY (conn_id, sub_id)
      )`);
    const watcherSk = generateSecretKey();
    const pubSk = generateSecretKey();
    const pubPk = getPublicKey(pubSk);
    const connId = "30b97c37-6029-46f1-bf8d-84174cc6778f";
    const hb = [{ kinds: [20000], authors: [...fakeAuthors(299), pubPk] }];
    sql(`INSERT INTO ws_subs (conn_id, sub_id, filters) VALUES (?, ?, ?)`, connId, "hb", JSON.stringify(hb));
    const watcher = new FakeWs();
    state.acceptWebSocket(watcher, [connId]);
    watcher.attachment = {
      connId,
      challenge: "8255ded5-3b0b-40b4-8d78-54efbcb5467c",
      pubkey: getPublicKey(watcherSk),
      relayHost: HOST,
      subs: [{ subId: "small", filters: [{ kinds: [20000], authors: [pubPk] }] }],
      spilled: ["hb"],
    };
    const writesBefore = state.wsSubsWrites;

    const room = newRoom(state);
    await new Promise((r) => setTimeout(r, 0)); // 讓建構子裡的 storage 還原跑完
    const beat = await publishBeat(room, state, pubSk);
    const subs = (watcher.drain() as [string, string, NostrEvent][])
      .filter((m) => m[0] === "EVENT" && m[2].id === beat.id)
      .map((m) => m[1])
      .sort();
    expect(subs).toEqual(["hb", "small"]);
    // 還原後的狀態就是「已持久化」：不搬家、不重寫
    expect(state.wsSubsWrites).toBe(writesBefore);
    expect(state.wsSubsRows()).toEqual([{ conn_id: connId, sub_id: "hb" }]);
    // 已認證的身分也一起還原（SDK 才有的 ip 欄不在舊 attachment 裡，不影響）
    const ok = (send(room, watcher, ["EVENT", heartbeat(watcherSk)]) as [string, string, boolean][]).find((m) => m[0] === "OK");
    expect(ok?.[2]).toBe(true);
    expect(state.wsSubsWrites).toBe(writesBefore);
  });
});

/**
 * DocHost 形狀的用法在自架站上可不可行（SDK ADR 0036）：部署端 `relayWorkerVars` 產生的環境變數**直接**餵給 Worker，
 * 客戶端**不做 NIP-42 AUTH**、只送 REQ／EVENT／CLOSE，事件是 kind 31438（可尋址）、`d` 是 HMAC 值、64 個桶。
 */
describe("自架站上的 DocHost 形狀（appLanes＋白名單、不做 AUTH；SDK ADR 0036）", () => {
  const DOCHOST_KIND = 31438;
  const BUCKETS = 64;
  const hmacD = (i: number): string => (i.toString(16).padStart(2, "0") + "ab").repeat(16); // 64 字元 hex，形似 HMAC
  const bucket = (sk: SecretKey, i: number, content = "dh1:" + "A".repeat(200), createdAt = nowSec()): NostrEvent =>
    finalizeEvent({ kind: DOCHOST_KIND, created_at: createdAt, tags: [["d", hmacD(i)]], content }, sk);

  async function lane(env: Record<string, string>, path = "/app/dochost") {
    const state = new FakeState();
    const room = newRoom(state, env as unknown as Env);
    const before = state.sockets.length;
    await room.fetch(new Request(`https://${HOST}${path}`));
    const ws = state.sockets[before]!;
    return { room, ws };
  }
  const okOf = (out: unknown[]) => (out as [string, string, boolean, string][]).find((m) => m[0] === "OK");

  it("🔴 appLanes: ['dochost']＋白名單：不做 AUTH 也能寫 64 個桶、第 65 個被拒；REQ（authors＋#d）讀得回來", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const { room, ws } = await lane(relayWorkerVars({ allowedPubkeys: [pk], appLanes: ["dochost"] }));
    // 車道會發 AUTH 挑戰但不強制——不處理 AUTH 的客戶端要能忽略這一則
    expect(ws.drain().some((m) => (m as unknown[])[0] === "AUTH")).toBe(true);
    for (let i = 0; i < BUCKETS; i += 1) expect(okOf(send(room, ws, ["EVENT", bucket(sk, i)]))?.[2], `bucket ${i}`).toBe(true);
    expect(okOf(send(room, ws, ["EVENT", bucket(sk, BUCKETS)]))?.[2]).toBe(false);
    // 更新既有的桶（取代語意，created_at 較新者勝）不受位址配額影響
    expect(okOf(send(room, ws, ["EVENT", bucket(sk, 0, "dh1:updated", nowSec() + 1)]))?.[2]).toBe(true);

    const out = send(room, ws, ["REQ", "s", { kinds: [DOCHOST_KIND], authors: [pk], "#d": [hmacD(0), hmacD(1)] }]) as unknown[][];
    const events = out.filter((m) => m[0] === "EVENT").map((m) => m[2] as NostrEvent);
    expect(events.map((e) => e.content).sort()).toEqual(["dh1:" + "A".repeat(200), "dh1:updated"].sort());
    expect(out.some((m) => m[0] === "EOSE")).toBe(true);
  }, 30_000); // 66 次 Schnorr 簽章＋中繼驗章（單跑約 0.3 秒）：整套平行跑、機器忙時曾超過預設 5 秒

  it("🔴 白名單照樣擋外人：名單外的金鑰寫不進 dochost 車道（不需要 AUTH 就能判斷——看的是事件簽章者）", async () => {
    const owner = getPublicKey(generateSecretKey());
    const { room, ws } = await lane(relayWorkerVars({ allowedPubkeys: [owner], appLanes: ["dochost"] }));
    ws.drain();
    const out = okOf(send(room, ws, ["EVENT", bucket(generateSecretKey(), 0)]));
    expect(out?.[2]).toBe(false);
    expect(out?.[3]).toContain("blocked");
  });

  it("沒設 appLanes：/app/dochost 落到公用車道——可尋址只給 16 個，64 桶放不下", async () => {
    const sk = generateSecretKey();
    const { room, ws } = await lane(relayWorkerVars({ allowedPubkeys: [getPublicKey(sk)] }));
    ws.drain();
    let accepted = 0;
    for (let i = 0; i < BUCKETS; i += 1) if (okOf(send(room, ws, ["EVENT", bucket(sk, i)]))?.[2] === true) accepted += 1;
    expect(accepted).toBe(PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR);
  }, 30_000); // 64 次簽章＋驗章，同上

  it("車道上單顆可尋址事件上限 32 KB（事件 JSON 長度）：大桶要拆或壓縮", async () => {
    const sk = generateSecretKey();
    const { room, ws } = await lane(relayWorkerVars({ allowedPubkeys: [getPublicKey(sk)], appLanes: ["dochost"] }));
    ws.drain();
    expect(okOf(send(room, ws, ["EVENT", bucket(sk, 0, "dh1:" + "A".repeat(31 * 1024))]))?.[2]).toBe(true);
    expect(okOf(send(room, ws, ["EVENT", bucket(sk, 1, "dh1:" + "A".repeat(33 * 1024))]))?.[2]).toBe(false);
  });

  it("NIP-11（車道路徑）宣告配額與每 IP 速率，客戶端連線前就知道要不要節流", async () => {
    const env = relayWorkerVars({ appLanes: ["dochost"] }) as unknown as Env;
    const doc = async (path: string) =>
      JSON.parse(
        ((await worker.fetch(new Request(`https://${HOST}${path}`, { headers: { Accept: "application/nostr+json" } }), env)) as unknown as { body: string }).body,
      ) as Record<string, unknown>;
    expect(await doc("/app/dochost")).toMatchObject({
      cinder_addressable_per_author: 64,
      cinder_addressable_max_bytes: 32 * 1024,
      cinder_addressable_ttl_sec: 30 * 86_400,
      cinder_max_messages_per_second_per_ip: 20,
      limitation: { auth_required: false },
    });
    expect(await doc("/app/other")).toMatchObject({ cinder_addressable_per_author: PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR });
  });

  it("🔴 一鍵部署預設每 IP 每秒 20 則：一口氣推 64 個桶會在第 21 則被斷線；調高 maxMessagesPerSecondPerIp 就過得去", () => {
    const now = nowSec();
    const sk = generateSecretKey();
    const events = Array.from({ length: BUCKETS }, (_, i) => bucket(sk, i));
    const burst = (vars: Record<string, string>): number => {
      const core = new RelayCore({
        store: new MessageStore(storeOptions(undefined, "app", true)),
        ...guardFor("app"),
        maxMessagesPerSecondPerIp: messagesPerSecondPerIpFrom(vars.MAX_MESSAGES_PER_SECOND_PER_IP)!,
        now: () => now,
      });
      core.connect("c", HOST, "203.0.113.7");
      for (let i = 0; i < events.length; i += 1) {
        if (core.handle("c", JSON.stringify(["EVENT", events[i]])).some((o) => o.close)) return i + 1;
      }
      return 0;
    };
    expect(burst(relayWorkerVars({}))).toBe(21);
    expect(burst(relayWorkerVars({ maxMessagesPerSecondPerIp: 100 }))).toBe(0);
  });

  it("只同步差異：桶帶 NIP-40 `expiration` 就照它到期（已知租戶的 30 天是上限、不是下限）——現有中繼即支援", () => {
    const now = nowSec();
    const sk = generateSecretKey();
    const store = new MessageStore(storeOptions(undefined, "app", true));
    const short = finalizeEvent(
      { kind: DOCHOST_KIND, created_at: now, tags: [["d", hmacD(0)], ["expiration", String(now + 3 * 86_400)]], content: "dh1:x" },
      sk,
    );
    const forever = finalizeEvent(
      { kind: DOCHOST_KIND, created_at: now, tags: [["d", hmacD(1)], ["expiration", String(now + 400 * 86_400)]], content: "dh1:y" },
      sk,
    );
    expect(store.putAddressable(short, now)).toBe(true);
    expect(store.putAddressable(forever, now)).toBe(true);
    const filter = { kinds: [DOCHOST_KIND], authors: [getPublicKey(sk)] };
    expect(store.query(filter, now + 2 * 86_400)).toHaveLength(2);
    expect(store.query(filter, now + 4 * 86_400).map((e) => e.content)).toEqual(["dh1:y"]);
    // 過長的過期章被夾到 30 天
    expect(store.query(filter, now + 31 * 86_400)).toHaveLength(0);
  });
});

describe("嚴格平面離線天花板滿了：真的回 OK false、不扇出（SDK ADR 0038 P0-R1，宿主層）", () => {
  it("🔴 以真正的 RelayRoom 與 128 MB 天花板：存不下的回「blocked: ceiling:」，回 OK true 的都查得到", async () => {
    const state = new FakeState();
    const room = newRoom(state);

    // 收件人之一在線、訂閱自己的收件匣——被拒的那幾顆不應該即時送到他手上。
    const watcherSk = generateSecretKey();
    const watcherPk = getPublicKey(watcherSk);
    const watcher = await open(room, state);
    authenticate(room, watcher, watcherSk);
    send(room, watcher, ["REQ", "inbox", { kinds: [1059], "#p": [watcherPk] }]);

    const sender = await open(room, state);
    authenticate(room, sender, generateSecretKey());

    // 每顆約 240 KB、16 位收件人（上限）＝每顆在天花板裡算約 3.8 MB——三十幾顆就滿。
    const recipients = [watcherPk, ...Array.from({ length: 15 }, () => getPublicKey(generateSecretKey()))];
    const accepted: string[] = [];
    let rejected: [string, string, boolean, string] | undefined;
    for (let i = 0; i < 40 && !rejected; i++) {
      const e = finalizeEvent(
        { kind: 1059, created_at: nowSec(), tags: recipients.map((p) => ["p", p]), content: "x".repeat(240_000) },
        generateSecretKey(),
      );
      const out = send(room, sender, ["EVENT", e]) as [string, string, boolean, string][];
      const ok = out.find((m) => m[0] === "OK" && m[1] === e.id);
      const delivered = (watcher.drain() as [string, string, NostrEvent][]).some((m) => m[0] === "EVENT" && m[2]?.id === e.id);
      if (ok?.[2] === true) {
        accepted.push(e.id);
        expect(delivered).toBe(true);
      } else {
        rejected = ok;
        expect(delivered).toBe(false);
      }
    }
    expect(accepted.length).toBeGreaterThan(30);
    expect(rejected?.[2]).toBe(false);
    expect(rejected?.[3]).toBe(OFFLINE_CEILING_REJECT);

    // 回 OK true 的每一顆都真的在庫裡（修正前：天花板之後的全部回 OK true 卻不在）。
    const inbox = send(room, watcher, ["REQ", "check", { kinds: [1059], "#p": [watcherPk], limit: 1000 }]) as [string, string, NostrEvent][];
    const storedIds = inbox.filter((m) => m[0] === "EVENT").map((m) => m[2].id);
    expect(storedIds.sort()).toEqual([...accepted].sort());
  }, 60_000);
});

// ── SDK ADR 0042：每顆 DO 的天花板（Cinderous ADR-0377 移植）、DO 名、溢位帶、NIP-11 ───────────────────────
describe("容量設定與 DO 名（Cinderous ADR-0377 移植；SDK ADR 0042）", () => {
  const openAt = async (room: RelayRoom, state: FakeState, path: string): Promise<FakeWs> => {
    const before = state.sockets.length;
    const res = await room.fetch(new Request(`https://${HOST}${path}`));
    expect((res as unknown as { status: number }).status).toBe(101);
    return state.sockets[before]!;
  };
  /** 約 200 KB 的禮物包（天花板 4 MiB 放得下 20 顆） */
  const big = (to: string): NostrEvent =>
    finalizeEvent({ kind: 1059, created_at: nowSec(), tags: [["p", to]], content: "x".repeat(200_000) }, generateSecretKey());
  // 溢位帶 100%＝4 MiB，每位收件人最多借帶子的 1/16（256 KiB）＝一顆
  const ENV = { DO_CEILINGS_MIB: "shard-a=4/4", DO_BORROW_PERCENT: "shard-a=100" } as unknown as Env;

  /** 在 /s/a 對同一位收件人送 22 顆，回傳每顆 OK 的第 3、4 欄：20 顆正常、第 21 顆借用、第 22 顆超過每人借用上限 */
  const fillShardA = (room: RelayRoom, ws: FakeWs): [boolean, string][] => {
    const to = "b".repeat(64);
    return Array.from({ length: 22 }, () => {
      const e = big(to);
      const ok = (send(room, ws, ["EVENT", e]) as [string, string, boolean, string][]).find((m) => m[0] === "OK");
      return [ok![2], ok![3]];
    });
  };

  it("🔴 DO 名在第一次連線時記進 storage（cinder:do-name，與 Cinderous 同一個鍵），天花板與溢位帶依它生效", async () => {
    const state = new FakeState();
    const room = newRoom(state, ENV);
    const ws = await openAt(room, state, "/s/a");
    expect(state.kv.get("cinder:do-name")).toBe("shard-a");
    expect(authenticate(room, ws, generateSecretKey())).toBe(true);
    ws.drain();
    const results = fillShardA(room, ws);
    expect(results.slice(0, 20)).toEqual(Array(20).fill([true, ""]));
    expect(results[20]![0]).toBe(true);
    expect(results[20]![1]).toMatch(/^warning: borrowed: 7200: /);
    expect(results[21]).toEqual([false, OFFLINE_CEILING_REJECT]);
  });

  it("休眠喚醒後沒有 fetch：從 storage 讀回 DO 名，天花板照樣生效", async () => {
    const state = new FakeState();
    const room = newRoom(state, ENV);
    const ws = await openAt(room, state, "/s/a");
    expect(authenticate(room, ws, generateSecretKey())).toBe(true);
    ws.drain();
    const woke = newRoom(state, ENV);
    await new Promise((r) => setTimeout(r, 0));
    expect(fillShardA(woke, ws)[21]).toEqual([false, OFFLINE_CEILING_REJECT]);
  });

  it("升級前就釘住政策的 DO（沒有 DO 名）：下一次連線補記，換成自己的天花板", async () => {
    const state = new FakeState();
    state.kv.set("cinder:lane-profile", "strict");
    state.kv.set("cinder:lane-known", false);
    const room = newRoom(state, ENV);
    await new Promise((r) => setTimeout(r, 0));
    const ws = await openAt(room, state, "/s/a");
    expect(state.kv.get("cinder:do-name")).toBe("shard-a");
    expect(authenticate(room, ws, generateSecretKey())).toBe(true);
    ws.drain();
    expect(fillShardA(room, ws)[21]![0]).toBe(false);
  });

  it("沒設容量變數：與 v0.33 相同（128 MiB、沒有借用；OK true 的訊息是空字串）", async () => {
    const state = new FakeState();
    const room = newRoom(state, {} as Env);
    const ws = await openAt(room, state, "/s/a");
    expect(authenticate(room, ws, generateSecretKey())).toBe(true);
    ws.drain();
    expect(fillShardA(room, ws)).toEqual(Array(22).fill([true, ""]));
  });

  it("設錯的項目不生效、啟動時 console.warn（要看得見）", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => void warned.push(msg);
    try {
      newRoom(new FakeState(), { DO_CEILINGS_MIB: "shard-z=1/1", DO_GUARANTEE_KIB: "strict=2048" } as unknown as Env);
    } finally {
      console.warn = original;
    }
    expect(warned.join("\n")).toContain("DO_CEILINGS_MIB: shard-z=1/1");
    expect(warned.join("\n")).toContain("DO_GUARANTEE_KIB: strict=2048");
  });

  it("NIP-11 依路徑宣告那顆 DO 的天花板與政策（只有靜態值）", async () => {
    const env = {
      APP_LANES: "dochost",
      DO_CEILINGS_MIB: "shard-a=1/1,app:dochost=64/512",
      DO_GUARANTEE_KIB: "lane=2048",
      DO_BORROW_PERCENT: "strict=25,lane=25",
      DO_NEAR_FULL_PERCENT: "lane=80",
      DO_DROP_NOTICES: "strict",
    } as unknown as Env;
    const info = async (path: string, e: Env = env): Promise<Record<string, unknown>> =>
      JSON.parse(
        ((await worker.fetch(new Request(`https://${HOST}${path}`, { headers: { Accept: "application/nostr+json" } }), e)) as unknown as { body: string }).body,
      ) as Record<string, unknown>;
    const shard = await info("/s/a");
    expect(shard.cinder_ceiling_policy).toBe("reject");
    expect(shard.cinder_ceiling_bytes).toEqual({ offline: 1024 * 1024, addressable: 1024 * 1024 });
    expect(shard.cinder_borrow_percent).toBe(25);
    expect(shard.cinder_borrow_ttl_sec).toBe(7200);
    expect(shard.cinder_borrow_planes).toEqual(["offline"]); // 嚴格平面的可尋址不借用
    expect(shard.cinder_drop_notices).toBe(true);
    expect(shard.cinder_guarantee_bytes).toBeUndefined();
    const lane = await info("/app/dochost");
    expect(lane.cinder_ceiling_policy).toBe("evict");
    expect(lane.cinder_ceiling_bytes).toEqual({ offline: 64 * 1024 * 1024, addressable: 512 * 1024 * 1024 });
    expect(lane.cinder_guarantee_bytes).toBe(2048 * 1024);
    expect(lane.cinder_borrow_planes).toEqual(["offline", "addressable"]);
    expect(lane.cinder_near_full_percent).toEqual([80, 95]);
    const plain = await info("/s/a", {} as Env);
    expect(plain.cinder_ceiling_policy).toBe("reject");
    expect(plain.cinder_ceiling_bytes).toEqual({ offline: 128 * 1024 * 1024, addressable: 128 * 1024 * 1024 });
    for (const k of ["cinder_borrow_ttl_sec", "cinder_guarantee_bytes", "cinder_near_full_percent", "cinder_drop_notices"]) {
      expect(plain[k], k).toBeUndefined();
    }
  });

  /** 從幾條新連線（每條 100 則，避開每把公鑰每分鐘 120 則）寄 `n` 則給 R */
  const flood = async (room: RelayRoom, state: FakeState, R: string, n: number): Promise<void> => {
    for (let sent = 0; sent < n; sent += 100) {
      const sender = await openAt(room, state, "/s/a");
      expect(authenticate(room, sender, generateSecretKey())).toBe(true);
      for (let i = sent; i < Math.min(n, sent + 100); i += 1) {
        room.webSocketMessage(
          sender as unknown as WebSocket,
          JSON.stringify(["EVENT", finalizeEvent({ kind: 1059, created_at: nowSec() - 3000 + i, tags: [["p", R]], content: "x" }, generateSecretKey())]),
        );
      }
      sender.drain();
    }
  };

  it("丟棄計數跨休眠：收件人的收件匣訂閱在喚醒後還原，線上時被擠掉的不算；離線時被擠掉的算", async () => {
    const env = { DO_DROP_NOTICES: "strict" } as unknown as Env;
    const rsk = generateSecretKey();
    const R = getPublicKey(rsk);

    // 線上：訂閱著收件匣，DO 休眠又喚醒（訂閱從 attachment 還原），505 則擠掉最舊的 5 則 ⇒ 不算
    const online = new FakeState();
    const room = newRoom(online, env);
    const reader = await openAt(room, online, "/s/a");
    expect(authenticate(room, reader, rsk)).toBe(true);
    send(room, reader, ["REQ", "inbox", { kinds: [1059], "#p": [R] }]);
    const woke = newRoom(online, env);
    await new Promise((r) => setTimeout(r, 0));
    await flood(woke, online, R, 505);
    reader.drain();
    const seen = send(woke, reader, ["REQ", "again", { kinds: [1059], "#p": [R], limit: 1 }]) as [string, string][];
    expect(seen.map((m) => m[0])).not.toContain("NOTICE");

    // 對照：收件人不在線上，同樣 505 則 ⇒ 5 則算丟棄，下次讀收件匣時在 EOSE 前收到
    const offline = new FakeState();
    const room2 = newRoom(offline, env);
    await flood(room2, offline, R, 505);
    const reader2 = await openAt(room2, offline, "/s/a");
    expect(authenticate(room2, reader2, rsk)).toBe(true);
    reader2.drain();
    const out = send(room2, reader2, ["REQ", "inbox", { kinds: [1059], "#p": [R], limit: 1 }]) as [string, string][];
    const notice = out.find((m) => m[0] === "NOTICE");
    expect(notice?.[1]).toMatch(/^warning: dropped: 5: /);
    expect(out.at(-1)?.[0]).toBe("EOSE");
  }, 120_000);
});

describe("RelayRoom — 唯讀寬限期（READONLY_LANES；SDK ADR 0052）", () => {
  const OLD = "k7q2mxz4ab3cd5ef6gh7ij2kl3";
  const NEW = "z9y8x7w6v5u4t3s2r2q2p2o2n2";
  const lanesEnv = (extra: Partial<Env>): Env => ({ LANES_ONLY: "1", MAX_FILE_MB: "17", ...extra }) as Env;
  const openLane = async (room: RelayRoom, state: FakeState, lane: string): Promise<FakeWs> => {
    // 假的 blockConcurrencyWhile 不會擋：先讓建構子讀完 storage，免得它蓋掉 fetch 釘住的車道
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = state.sockets.length;
    await room.fetch(new Request(`https://${HOST}/app/${lane}`));
    const ws = state.sockets[before]!;
    ws.drain();
    return ws;
  };
  const tagged = (sk: SecretKey, content: string) =>
    finalizeEvent({ kind: 1, created_at: nowSec(), tags: [["t", "move"]], content }, sk);

  it("換路徑重新部署後：舊車道那顆 DO 的資料讀得到、寫入一律被拒（說明原因、不提新網址）", async () => {
    const sk = generateSecretKey();
    const state = new FakeState();
    // 部署前：OLD 是唯一的車道
    const before = newRoom(state, lanesEnv({ APP_LANES: OLD, FILE_LANES: OLD }));
    const w = await openLane(before, state, OLD);
    const stored = tagged(sk, "before");
    expect((send(before, w, ["EVENT", stored]) as unknown[][]).find((m) => m[0] === "OK")?.[2]).toBe(true);

    // 換路徑重新部署：同一顆 DO（同一份 storage）、新的環境
    const env = lanesEnv({ APP_LANES: NEW, FILE_LANES: NEW, READONLY_LANES: `${OLD}@${nowSec() + 7 * 86_400}` });
    const after = newRoom(state, env);
    const r = await openLane(after, state, OLD);
    const ok = (send(after, r, ["EVENT", tagged(sk, "after")]) as unknown[][]).find((m) => m[0] === "OK");
    expect(ok?.[2]).toBe(false);
    expect(String(ok?.[3])).toMatch(/^restricted: read-only:/);
    expect(String(ok?.[3])).not.toContain(NEW);
    const got = (send(after, r, ["REQ", "s", { "#t": ["move"] }]) as unknown[][]).filter((m) => m[0] === "EVENT");
    expect(got.map((m) => (m[2] as NostrEvent).id)).toEqual([stored.id]);
  });

  it("🔴 寬限期在連線期間過了：下一則訊息就以「認不得的路徑」關掉（NOTICE＋1008），不處理那則", async () => {
    const state = new FakeState();
    const until = nowSec() + 60;
    const room = newRoom(state, lanesEnv({ APP_LANES: NEW, FILE_LANES: NEW, READONLY_LANES: `${OLD}@${until}` }));
    const ws = await openLane(room, state, OLD);
    const realNow = Date.now;
    Date.now = () => (until + 1) * 1000;
    try {
      const out = send(room, ws, ["REQ", "s", { "#t": ["move"] }]) as unknown[][];
      expect(out).toHaveLength(1);
      expect(out[0]?.[0]).toBe("NOTICE");
      expect(String(out[0]?.[1])).toContain("unknown relay path");
      expect(JSON.stringify(out)).not.toContain(OLD);
      expect(ws.closed).toBe(true);
      expect(ws.closeCode).toBe(1008);
    } finally {
      Date.now = realNow;
    }
  });

  it("新路徑那顆 DO 照常可寫", async () => {
    const sk = generateSecretKey();
    const state = new FakeState();
    const room = newRoom(state, lanesEnv({ APP_LANES: NEW, FILE_LANES: NEW, READONLY_LANES: `${OLD}@${nowSec() + 60}` }));
    const ws = await openLane(room, state, NEW);
    expect((send(room, ws, ["EVENT", tagged(sk, "x")]) as unknown[][]).find((m) => m[0] === "OK")?.[2]).toBe(true);
  });
});

describe("RelayRoom — 收件確認（SDK ADR 0067）", () => {
  it("收件人確認後，DO SQLite 裡那一列的到期時間降為「現在＋2 小時」；確認事件不存", async () => {
    const state = new FakeState();
    const room = newRoom(state);
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const sender = await open(room, state);
    authenticate(room, sender, generateSecretKey());
    const wrap = finalizeEvent(
      { kind: 1059, created_at: nowSec(), tags: [["p", recipientPk], ["expiration", String(nowSec() + 7 * 86_400)]], content: "x" },
      generateSecretKey(),
    );
    send(room, sender, ["EVENT", wrap]);

    const reader = await open(room, state);
    authenticate(room, reader, recipientSk);
    const out = send(room, reader, ["EVENT", buildInboxAck([wrap.id], recipientSk)]) as [string, string, boolean, string][];
    expect(out.find((m) => m[0] === "OK")?.[2]).toBe(true);
    const rows = state.storage.sql.exec("SELECT id, expiration FROM offline_msgs").toArray() as { id: string; expiration: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(wrap.id);
    expect(rows[0]!.expiration).toBeGreaterThanOrEqual(nowSec() + 7_200 - 5);
    expect(rows[0]!.expiration).toBeLessThanOrEqual(nowSec() + 7_200);
  });
});

describe("DO 起不來時說明原因（SDK ADR 0097／Cinderous ADR-0387；額度用完不再只回 1101）", () => {
  /** 讓 DO 的 fetch 拋錯或回某個回應，送一次升級 */
  const upgradeWith = async (doFetch: () => Promise<Response>): Promise<{ status: number; server: FakeWs | undefined }> => {
    FakeWebSocketPair.last = undefined;
    const env = { RELAY_ROOM: { idFromName: () => ({}) as never, get: () => ({ fetch: doFetch }) } } as unknown as Env;
    const res = await worker.fetch(new Request(`https://${HOST}/`, { headers: { Upgrade: "websocket" } }), env);
    return { status: res.status, server: FakeWebSocketPair.last?.[1] };
  };
  const noticeOf = (ws: FakeWs | undefined): string => {
    const msg = JSON.parse(ws?.sent[0] ?? "[]") as unknown[];
    expect(msg[0]).toBe("NOTICE");
    return msg[1] as string;
  };

  it("🔴 寫入額度用完（Cloudflare 的錯誤訊息）：接受、NOTICE 說明額度與恢復時間、以 1013 關閉", async () => {
    const { status, server } = await upgradeWith(() => Promise.reject(new Error("Exceeded allowed rows written in Durable Objects free tier.")));
    expect(status).toBe(101);
    expect(server?.accepted).toBe(true);
    const notice = noticeOf(server);
    expect(notice).toMatch(/^over quota: /);
    expect(notice).toContain("00:00 UTC");
    expect(server?.closeCode).toBe(1013);
    expect(server?.closeReason).toBe("over quota");
  });

  it("🔴 其他錯誤：說明暫時無法使用、請稍後或改用別座，以 1013 關閉；不洩漏內部錯誤訊息", async () => {
    const { server } = await upgradeWith(() => Promise.reject(new Error("internal: sqlite busy at /secret/path")));
    const notice = noticeOf(server);
    expect(notice).toMatch(/^temporarily unavailable: /);
    expect(notice).not.toContain("secret");
    expect(server?.closeCode).toBe(1013);
  });

  it("DO 回 5xx（沒有 WebSocket）也一樣說明；正常的 101 原樣轉回", async () => {
    const { server } = await upgradeWith(() => Promise.resolve(new Response("boom", { status: 500 })));
    expect(noticeOf(server)).toMatch(/^temporarily unavailable: /);
    const ok = await upgradeWith(() => Promise.resolve(new Response(null, { status: 101 })));
    expect(ok.status).toBe(101);
    expect(ok.server).toBeUndefined();
  });
});
