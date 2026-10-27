// 唯讀寬限期（`READONLY_LANES`；SDK ADR 0052）：換了私人路徑之後，舊路徑到期前可以連、可以讀、拒絕一切寫入；
// 到期後與認不得的路徑相同。這裡測解析、路由、預算與 RelayCore 的寫入閘門；宿主層在 lanes-only／worker／lanes-only-node 測試。
import { describe, expect, it } from "vitest";

import { buildAuthEvent, finalizeEvent, generateSecretKey, getPublicKey } from "../../src/protocol/index.js";
import { classifyRelayMessage } from "../../src/protocol/relay-reject.js";
import {
  computeCeilingBudget,
  fileLanes,
  filePolicyFor,
  laneStateOf,
  READONLY_LANES_MAX,
  readOnlyLaneIds,
  readOnlyLanesFrom,
} from "../../src/relay/host-config.js";
import { MessageStore } from "../../src/relay/message-store.js";
import { REJECT } from "../../src/relay/reject-messages.js";
import { RelayCore } from "../../src/relay/relay-core.js";
import { allDoNames, namedLaneName, routeForPath } from "../../src/relay/shard.js";

const OLD = "k7q2mxz4ab3cd5ef6gh7ij2kl3";
const NEW = "z9y8x7w6v5u4t3s2r2q2p2o2n2";
const NOW = 1_800_000_000;

describe("readOnlyLanesFrom：`<車道 id>@<到期 unix 秒>`", () => {
  it("解析、轉小寫、同一條取較晚的到期", () => {
    const { lanes, ignored } = readOnlyLanesFrom(` ${OLD.toUpperCase()}@${NOW + 10} , ${NEW}@${NOW}, ${OLD}@${NOW + 5}`);
    expect(ignored).toEqual([]);
    expect([...lanes]).toEqual([
      [OLD, NOW + 10],
      [NEW, NOW],
    ]);
  });

  it("🔴 寫錯的項目不採用；回報只有第幾項與原因，不含車道 id", () => {
    const { lanes, ignored } = readOnlyLanesFrom(`${OLD},${OLD}@abc,_bad@${NOW},${NEW}@0,${NEW}@${NOW}`);
    expect([...lanes.keys()]).toEqual([NEW]);
    expect(ignored).toHaveLength(4);
    expect(ignored.join()).not.toContain(OLD);
    expect(ignored[0]).toMatch(/^#1/);
  });

  it(`最多 ${READONLY_LANES_MAX} 條`, () => {
    const raw = Array.from({ length: READONLY_LANES_MAX + 2 }, (_, i) => `lane${i}@${NOW}`).join(",");
    const { lanes, ignored } = readOnlyLanesFrom(raw);
    expect(lanes.size).toBe(READONLY_LANES_MAX);
    expect(ignored).toHaveLength(2);
  });

  it("沒設＝沒有", () => {
    expect(readOnlyLanesFrom(undefined).lanes.size).toBe(0);
    expect(readOnlyLanesFrom("").ignored).toEqual([]);
  });
});

describe("readOnlyLaneIds／laneStateOf：到期由中繼自己判斷", () => {
  const env = { APP_LANES: NEW, READONLY_LANES: `${OLD}@${NOW + 60}` };

  it("到期前是唯讀，到期那一秒起就不是", () => {
    expect([...readOnlyLaneIds(env, NOW)]).toEqual([OLD]);
    expect(readOnlyLaneIds(env, NOW + 60).size).toBe(0);
    expect(laneStateOf(env, OLD, NOW)).toBe("read-only");
    expect(laneStateOf(env, OLD, NOW + 60)).toBe("expired");
    expect(laneStateOf(env, NEW, NOW)).toBe("active");
    expect(laneStateOf(env, "other", NOW)).toBe("unlisted");
  });

  it("同時在 APP_LANES 上的以 APP_LANES 為準（照常可寫）", () => {
    const both = { APP_LANES: OLD, READONLY_LANES: `${OLD}@${NOW + 60}` };
    expect(readOnlyLaneIds(both, NOW).size).toBe(0);
    expect(laneStateOf(both, OLD, NOW)).toBe("active");
  });
});

describe("routeForPath：唯讀車道落在它原本那顆 DO", () => {
  const known = new Set([NEW]);
  const readOnlyLanes = new Set([OLD]);

  it("僅限車道模式：舊路徑連得上（同一顆 `app:<id>`、known、readOnly），新路徑照常", () => {
    expect(routeForPath(`/app/${OLD}`, known, { lanesOnly: true, readOnlyLanes })).toEqual({
      profile: "app",
      doName: namedLaneName(OLD),
      laneId: OLD,
      known: true,
      readOnly: true,
    });
    expect(routeForPath(`/app/${NEW}`, known, { lanesOnly: true, readOnlyLanes })).toEqual({
      profile: "app",
      doName: namedLaneName(NEW),
      laneId: NEW,
      known: true,
    });
  });

  it("沒列在唯讀名單（例如已到期，呼叫端篩掉了）＝認不得", () => {
    expect(routeForPath(`/app/${OLD}`, known, { lanesOnly: true })).toBeUndefined();
  });

  it("沒開僅限車道：舊路徑仍落在它自己的 DO（不掉進共用分片）", () => {
    expect(routeForPath(`/app/${OLD}`, known, { readOnlyLanes })?.doName).toBe(namedLaneName(OLD));
  });

  it("allDoNames 與帳號儲存預算把唯讀車道算進去（資料還在）", () => {
    expect(allDoNames(known, { lanesOnly: true, readOnlyLanes })).toEqual([namedLaneName(NEW), namedLaneName(OLD)]);
    const vars = { APP_LANES: NEW, FILE_LANES: NEW, MAX_FILE_MB: "17", LANES_ONLY: "1", READONLY_LANES: `${OLD}@${NOW}` };
    const budget = computeCeilingBudget(vars);
    expect(budget.rows.map((r) => r.doName)).toEqual([namedLaneName(NEW), namedLaneName(OLD)]);
    // 車道模式下唯讀車道沿用檔案車道的儲存設定：既有的檔案塊留得住
    expect(budget.rows.map((r) => r.cls)).toEqual(["file", "file"]);
  });

  it("檔案政策：車道模式下唯讀車道沿用檔案車道的儲存設定；沒有檔案車道的站不變", () => {
    const vars = { APP_LANES: NEW, FILE_LANES: NEW, MAX_FILE_MB: "17", READONLY_LANES: `${OLD}@${NOW}` };
    expect([...fileLanes(vars).active].sort()).toEqual([NEW, OLD].sort());
    expect(filePolicyFor(vars, OLD)).toEqual({ accept: true, maxFileMb: 17 });
    expect(filePolicyFor({ APP_LANES: NEW, READONLY_LANES: `${OLD}@${NOW}` }, OLD)).toEqual({ accept: false });
  });
});

describe("RelayCore 的唯讀閘門", () => {
  const sk = generateSecretKey();
  const note = (content: string) => finalizeEvent({ kind: 1, created_at: NOW, tags: [["p", getPublicKey(sk)]], content }, sk);

  it("唯讀：EVENT 一律 `OK false restricted: read-only:`（在認證之前），REQ 照常讀到既有事件", () => {
    const store = new MessageStore();
    const writer = new RelayCore({ store, now: () => NOW });
    writer.connect("w");
    const stored = note("before");
    expect(writer.handle("w", JSON.stringify(["EVENT", stored])).find((o) => o.message[0] === "OK")?.message[2]).toBe(true);

    const core = new RelayCore({ store, now: () => NOW, readOnly: true, requireAuth: true });
    const [challenge] = core.connect("c", "relay.example").map((o) => o.message[1] as string);
    const ok = core.handle("c", JSON.stringify(["EVENT", note("after")])).find((o) => o.message[0] === "OK")?.message;
    expect(ok?.[2]).toBe(false);
    expect(ok?.[3]).toBe(REJECT.readOnly);
    expect(classifyRelayMessage(String(ok?.[3]))).toMatchObject({ prefix: "restricted", token: "read-only", kind: "restricted" });
    // 不回顯任何網址或車道
    expect(REJECT.readOnly).not.toMatch(/wss?:|\/app\//);

    // AUTH 照常（讀自己的 #p 要認證）
    const auth = core.handle("c", JSON.stringify(["AUTH", buildAuthEvent(challenge!, "wss://relay.example", sk, { created_at: NOW })]));
    expect(auth.find((o) => o.message[0] === "OK")?.message[2]).toBe(true);
    const req = core.handle("c", JSON.stringify(["REQ", "s", { "#p": [getPublicKey(sk)] }]));
    expect(req.filter((o) => o.message[0] === "EVENT").map((o) => (o.message[2] as { id: string }).id)).toEqual([stored.id]);
    // 唯讀之後寫的沒有進去
    expect(req.filter((o) => o.message[0] === "EVENT")).toHaveLength(1);
  });

  it("依連線判斷（Node 主機）：只有唯讀的那條被拒", () => {
    const core = new RelayCore({ store: new MessageStore(), now: () => NOW, readOnly: (connId) => connId === "old" });
    core.connect("old");
    core.connect("new");
    const e = note("x");
    expect(core.handle("old", JSON.stringify(["EVENT", e])).find((o) => o.message[0] === "OK")?.message[2]).toBe(false);
    expect(core.handle("new", JSON.stringify(["EVENT", e])).find((o) => o.message[0] === "OK")?.message[2]).toBe(true);
  });
});
