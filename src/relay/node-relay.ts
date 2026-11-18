// 正式版 Node.js 中繼站主機：跑與 Cloudflare 相同的 RelayCore，可在任何 Node 22+ 機器
// （例如樹莓派）長駐執行。離線留言以 Node 內建 SQLite 檔案持久化、預設要求 NIP-42 認證、
// 每小時清除過期留言（對應 Cloudflare 版的 DO alarm）。設定與對外方式見
// docs/self-hosting-raspberry-pi.md。
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import {
  allowedKindsFrom,
  allowedPubkeysFrom,
  connectionsPerPubkeyFrom,
  eventsPerMinuteFrom,
  fileLanesMode,
  filePolicyFor,
  firstHost,
  guardFor,
  knownLanes,
  lanesOnlyFrom,
  maxConnectionsFrom,
  maxConnectionsPerIpFrom,
  laneStateOf,
  messagesPerMinuteFrom,
  messagesPerSecondPerIpFrom,
  nodeCapacityFrom,
  readOnlyLaneIds,
  readOnlyLanesFrom,
  inboxAckGraceFor,
  storeOptions,
  clientIpFrom,
  trustedProxyHopsFrom,
} from "./host-config.js";
import { MessageStore } from "./message-store.js";
import { buildRelayInfo, NIP11_HEADERS, wantsRelayInfo } from "./nip11.js";
import {
  handleNip86Request,
  isNip86Request,
  Nip86Admin,
  NIP86_MAX_BODY_BYTES,
  nip86Precheck,
  type Nip86State,
  parseNip86State,
} from "./nip86.js";
import { relayVersion } from "./version.js";
import { closeSignalOf, RelayCore, type Outbound, type RelayCoreOptions } from "./relay-core.js";
import { ORG_ROSTER_KIND } from "../protocol/index.js";
import { type SqlExec, SqlMessageStore } from "./sql-message-store.js";
import {
  type RejectKind,
  trafficNearFullWarning,
  trafficQuotaRejection,
  UNKNOWN_PATH_INFO_BODY,
  UPGRADE_REJECT_CLOSE_CODE,
  UPGRADE_UNAVAILABLE_CLOSE_CODE,
  upgradeCloseCode,
  upgradeRejection,
} from "./reject-messages.js";
import { TRAFFIC_FLUSH_MS, type TrafficBudget, trafficBudgetFrom, TrafficMeter } from "./traffic-budget.js";
import { routeForPath } from "./shard.js";
import { createIotNodeHub } from "./iot-node.js";
import { iotRealtimeAnnouncement } from "./iot-realtime.js";

// node:sqlite 太新、打包器的內建模組表未收錄 → 以 createRequire 動態載入（型別走 type-only）。
// 只在真的要寫檔時才載入：純記憶體模式不該因為 Node 版本沒有 node:sqlite 而開不起來。
function openDatabase(path: string): DatabaseSyncType {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: typeof DatabaseSyncType;
  };
  return new DatabaseSync(path);
}

/** 宿主從環境變數讀設定（與原本的腳本同一組名稱；見 docs/self-hosting-raspberry-pi.md） */
export type NodeRelayEnv = Record<string, string | undefined>;

/** `startNodeRelay` 的回傳值。 */
export interface NodeRelayHandle {
  close(): void;
  /**
   * 開始監聽後給出實際的埠（`PORT=0` 時由系統分配）；監聽失敗（例如 `EADDRINUSE`）就 reject（SDK ADR 0114）。
   * 不等它也可以：監聽失敗時沒人接住就是未處理的 rejection，與之前「沒人接的 error 事件」一樣讓程序結束。
   */
  readonly ready: Promise<number>;
}

/** 環境變數之外、由呼叫端（例如 CLI）決定的選項。 */
export interface NodeRelayOptions {
  /**
   * 純記憶體（SDK ADR 0006 §relay-lite：預設純記憶體、`--persist` 才寫 SQLite）。
   * 開了就**不碰** `DB_PATH`，重啟即清空。未設＝照原本的行為寫 SQLite 檔（Docker／樹莓派的既有部署不變）。
   */
  memory?: boolean;
  /**
   * 每月流量預算（SDK ADR 0101），取代環境變數 `MONTHLY_TRAFFIC_GIB` 等。給嵌入者與測試用——
   * 環境變數只收整數 GiB，測試用不完。
   */
  trafficBudget?: TrafficBudget;
}

/**
 * 啟動 Node 版中繼（SDK ADR 0007：原本是一載入就開 server 的腳本，改成可呼叫的函式）。
 * 回傳 `close()`：停掉 HTTP／WebSocket 伺服器與清除排程、關掉 SQLite。
 */
export function startNodeRelay(env: NodeRelayEnv = process.env, opts: NodeRelayOptions = {}): NodeRelayHandle {
  const port = Number(env.PORT ?? 8787);
  // 監聽位址（SDK ADR 0119）：沒設＝所有位址（與之前相同）；反向代理在同一台時設 127.0.0.1，直接連埠的人連不進來
  const host = env.HOST === undefined || env.HOST.trim() === "" ? undefined : env.HOST.trim();
  const dbPath = opts.memory ? undefined : (env.DB_PATH ?? "cinder-relay.db");
  const requireAuth = env.REQUIRE_AUTH !== "0"; // 預設開 NIP-42 認證；設 REQUIRE_AUTH=0 可關
  // 白名單（SDK ADR 0008）：寫錯任何一筆就在這裡丟例外、不開站——不會默默變成開放中繼。
  const allowed = allowedPubkeysFrom(env.ALLOWED_PUBKEYS);
  const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

  let db: DatabaseSyncType | undefined;
  let store: MessageStore | SqlMessageStore;
  let sqlExec: SqlExec | undefined;
  // 空間上限（SDK ADR 0099）：沿用 Cloudflare 版的容量設定，只認 `strict`；`CEILING_MODE` 決定滿了拒收或淘汰。
  // 什麼都沒設＝`capacity` 不出現＝與之前完全相同。設錯的項目不生效，要看得見
  const { capacity, ignored: capacityIgnored } = nodeCapacityFrom(env);
  if (capacityIgnored.length > 0) console.warn(`容量設定有項目沒有生效（SDK ADR 0099）：${capacityIgnored.join("；")}`);
  const storeOpts = storeOptions(env.MAX_TTL_DAYS, "strict", false, undefined, capacity);
  if (dbPath === undefined) {
    store = new MessageStore(storeOpts);
  } else {
    const opened = openDatabase(dbPath);
    db = opened;
    const exec: SqlExec = (query, ...bindings) => {
      const stmt = opened.prepare(query);
      if (/^\s*select/i.test(query)) return stmt.all(...bindings) as Record<string, unknown>[];
      stmt.run(...bindings);
      return [];
    };
    store = new SqlMessageStore(exec, storeOpts);
    sqlExec = exec;
  }
  // 濫用防護（ADR-0235 H1）由 `host-config` 統一供應——與 Cloudflare 版用同一組常數。
  // 速率上限可用 MAX_EVENTS_PER_MINUTE 覆寫（自架站專屬）：未設＝120、設 0＝關閉。
  // 用 delete 而非指派 undefined（exactOptionalPropertyTypes 不允許顯式 undefined）。
  //
  // 🔴 **本宿主是單一 profile，且恆為嚴格**（ADR-0366 §決策 8）。它沒有路徑路由，
  // 所以沒有「哪條連線該套哪套規則」這個問題——也因此**絕不可以**在這裡帶進
  // `APP_LANE_GUARD`／`publicLane`：那會讓自架者升個版就把自己的站默默變成公共站，
  // 而症狀是「沒有症狀」。要跑第三方車道請用 Cloudflare 版（有 DO 隔離）。
  // `requireAuth` 放最後：自架站可用 REQUIRE_AUTH=0 明確關掉，那是他自己的取捨。
  const coreOptions: RelayCoreOptions = { store, ...guardFor("strict"), requireAuth };
  if (allowed) coreOptions.allowedAuthors = allowed;
  // 收件確認（SDK ADR 0067）：要 AUTH 證明「自己的收件匣」；REQUIRE_AUTH=0 的站不發挑戰，就不開也不宣告
  if (requireAuth) coreOptions.inboxAckGraceSec = inboxAckGraceFor(storeOpts);
  // PRD 3.3（SDK ADR 0013）：沒設＝不限；`cinderous relay start` 預設帶 5 與 20
  const maxConnections = connectionsPerPubkeyFrom(env.MAX_CONNECTIONS_PER_PUBKEY);
  if (maxConnections !== undefined) coreOptions.maxConnectionsPerPubkey = maxConnections;
  const perIp = messagesPerSecondPerIpFrom(env.MAX_MESSAGES_PER_SECOND_PER_IP);
  if (perIp !== undefined) coreOptions.maxMessagesPerSecondPerIp = perIp;
  // 反向代理後方才信 X-Forwarded-For（TRUST_PROXY=<層數>）；直連時那個標頭任何人都能偽造。從右邊數（SDK ADR 0119）
  const proxyHops = trustedProxyHopsFrom(env.TRUST_PROXY);
  const rate = eventsPerMinuteFrom(env.MAX_EVENTS_PER_MINUTE);
  if (rate === undefined) delete coreOptions.maxEventsPerMinute;
  else coreOptions.maxEventsPerMinute = rate;
  // 訊息上限跟著事件上限走（ADR-0366 §容量）：調高事件上限的自架站不該被訊息上限偷偷夾住。
  const msgRate = messagesPerMinuteFrom(env.MAX_MESSAGES_PER_MINUTE, rate);
  if (msgRate === undefined) delete coreOptions.maxMessagesPerMinute;
  else coreOptions.maxMessagesPerMinute = msgRate;
  // 檔案塊（Cinderous ADR-0162／0371）：與 Cloudflare 版同一個 `filePolicyFor`。本宿主沒有車道，所以永遠以
  // 「不是任何車道」去問——沒設 FILE_LANES 時 MAX_FILE_MB 照舊是全站開關（自架單人站不變）；
  // 設了 FILE_LANES 就是車道模式，而這裡沒有車道 ⇒ 整站不收，與 Cloudflare 版的主訊息平面一致。
  const filePolicy = filePolicyFor(env);
  if (filePolicy.accept) coreOptions.acceptFileEvents = true;
  if (fileLanesMode(env.FILE_LANES)) {
    console.warn("FILE_LANES 只在 Cloudflare 版（有車道 DO）生效；node 主機沒有車道，設了它就整站不收檔案塊（Cinderous ADR-0371）");
  }
  // 唯讀寬限期（SDK ADR 0052）：本宿主所有路徑共用一個 core，所以唯讀是**每條連線**的（連進來的路徑是唯讀車道）
  const readOnlyConns = new Map<string, string>(); // connId → 車道 id
  coreOptions.readOnly = (connId) => readOnlyConns.has(connId);
  // 事件類型清單（Cinderous ADR-0048、SDK ADR 0132）：寫錯任何一筆就在這裡丟例外、不開站。沒設＝全部接受
  const envKinds = allowedKindsFrom(env.ALLOWED_KINDS);
  if (envKinds) coreOptions.allowedKinds = envKinds;

  // NIP-86 管理 API（SDK ADR 0132）：設了 NIP86_ADMIN_PUBKEYS 才開；存過的狀態蓋過環境變數
  const nip86Admins = allowedPubkeysFrom(env.NIP86_ADMIN_PUBKEYS, "NIP86_ADMIN_PUBKEYS");
  const rosterAdmin = allowedPubkeysFrom(env.ROSTER_ADMIN_PUBKEY, "ROSTER_ADMIN_PUBKEY");
  if (rosterAdmin !== undefined && rosterAdmin.length !== 1) {
    db?.close();
    throw new Error("ROSTER_ADMIN_PUBKEY 只能有一把（SDK ADR 0132）");
  }
  // 對外網址（SDK ADR 0133）：設了就只認簽給它的請求。寫錯就不開站——悄悄退回「看 Host 標頭」比不開更糟。
  let nip86PublicUrl: string | undefined;
  if (env.NIP86_PUBLIC_URL !== undefined && env.NIP86_PUBLIC_URL.trim() !== "") {
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = new URL(env.NIP86_PUBLIC_URL.trim());
    } catch {
      parsedUrl = undefined;
    }
    if (parsedUrl === undefined || (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")) {
      db?.close();
      throw new Error("NIP86_PUBLIC_URL 要是 http:// 或 https:// 開頭的完整網址（SDK ADR 0133）");
    }
    nip86PublicUrl = env.NIP86_PUBLIC_URL.trim();
  }
  const savedNip86 = sqlExec === undefined ? undefined : loadNip86State(sqlExec);
  if (nip86Admins === undefined && savedNip86 !== undefined) {
    const otherThanRoster = savedNip86.allowedKinds !== undefined || savedNip86.name !== undefined || savedNip86.description !== undefined;
    if (rosterAdmin === undefined) {
      console.warn("資料庫裡有 NIP-86 存過的設定，但 NIP86_ADMIN_PUBKEYS 沒設：這次照環境變數（SDK ADR 0132）");
    } else if (otherThanRoster) {
      console.warn("NIP86_ADMIN_PUBKEYS 沒設：只沿用存過的名冊，事件類型、站名與說明照環境變數（SDK ADR 0134）");
    }
  }
  if (nip86Admins !== undefined && nip86PublicUrl === undefined) {
    console.warn(
      "NIP-86 開著但沒設 NIP86_PUBLIC_URL：請求的簽章只綁到對方送來的 Host 標頭。同一把運維金鑰管不只一座站、或前面有反向代理時請設定它（SDK ADR 0133）",
    );
  }
  // 名冊自動套用（SDK ADR 0134）只需要 ROSTER_ADMIN_PUBKEY：管理 API 沒開時只沿用存過的名冊
  let nip86State: Nip86State | undefined =
    nip86Admins !== undefined
      ? savedNip86
      : rosterAdmin !== undefined && savedNip86?.roster !== undefined
        ? { roster: savedNip86.roster }
        : undefined;
  // 存過的名冊只在「同一把名冊金鑰還設著」時生效（SDK ADR 0133）：拿掉或換掉 ROSTER_ADMIN_PUBKEY
  // ＝回到環境變數的 ALLOWED_PUBKEYS。否則站方想用環境變數踢人會毫無效果，而且沒有任何管道能改回來。
  if (nip86State?.roster) {
    const signedBy = nip86State.roster.admin;
    const current = rosterAdmin?.[0];
    if (current === undefined || (signedBy !== undefined && signedBy !== current)) {
      console.warn(
        current === undefined
          ? "資料庫裡有套用過的名冊，但 ROSTER_ADMIN_PUBKEY 沒設：這次不用它，成員照 ALLOWED_PUBKEYS（SDK ADR 0133）"
          : "資料庫裡的名冊是另一把 ROSTER_ADMIN_PUBKEY 簽的：這次不用它，成員照 ALLOWED_PUBKEYS（SDK ADR 0133）",
      );
      const { roster: _dropped, ...rest } = nip86State;
      nip86State = rest;
    } else if (allowed !== undefined && !sameSet(allowed, nip86State.roster.allowed)) {
      console.warn("資料庫裡套用過的名冊蓋過了環境變數 ALLOWED_PUBKEYS（名冊才是成員權威；要改成員請送新名冊，SDK ADR 0132 §8）");
    }
  }
  if (nip86State?.allowedKinds && envKinds !== undefined && !sameSet(envKinds, nip86State.allowedKinds)) {
    console.warn("資料庫裡 NIP-86 改過的事件類型清單蓋過了環境變數 ALLOWED_KINDS（SDK ADR 0132 §8）");
  }
  if (nip86State?.roster) coreOptions.allowedAuthors = nip86State.roster.allowed;
  if (nip86State?.allowedKinds) coreOptions.allowedKinds = nip86State.allowedKinds;
  // 名冊金鑰永遠寫得進（SDK ADR 0134）：否則它簽的下一份名冊會被白名單擋在門外，自動套用只能用一次。
  // 它本來就能把自己加進名冊，所以這不多給任何權力。
  const rosterSigner = rosterAdmin?.[0];
  const withRosterAdmin = (list: Iterable<string>): string[] => {
    const out = [...list];
    if (rosterSigner !== undefined && !out.includes(rosterSigner)) out.push(rosterSigner);
    return out;
  };
  if (coreOptions.allowedAuthors !== undefined) coreOptions.allowedAuthors = withRosterAdmin(coreOptions.allowedAuthors);
  // 名冊金鑰簽的名冊發到這座站 → 直接套用（SDK ADR 0134）。照一般流程存檔與扇出（客戶端也要收到）。
  if (rosterSigner !== undefined) {
    coreOptions.intercept = (_connId, event) => {
      // 擁有者或它列的共同管理者（SDK ADR 0135）
      if (event.kind === ORG_ROSTER_KIND && nip86 !== undefined && nip86.rosterSigners().includes(event.pubkey)) {
        const r = nip86.applyRosterEvent(event);
        if ("error" in r && !r.error.startsWith("stale:")) console.warn(`收到名冊金鑰簽的名冊，但沒有套用：${r.error}（SDK ADR 0134）`);
      }
      return undefined;
    };
  }
  /** 目前生效的白名單（NIP-11 的 restricted_writes 跟著它） */
  let currentAllowed: readonly string[] | undefined = nip86State?.roster?.allowed ?? allowed;
  const core = new RelayCore(coreOptions);
  let nip86: Nip86Admin | undefined;
  if (nip86Admins !== undefined || rosterAdmin !== undefined) {
    if (sqlExec === undefined) console.warn("純記憶體模式：NIP-86 或名冊改的設定重開就回到環境變數（SDK ADR 0132／0134）");
    const exec = sqlExec;
    try {
      nip86 = new Nip86Admin({
        admins: nip86Admins ?? [],
        rosterAdmin: rosterAdmin?.[0],
        allowed: currentAllowed,
        allowedKinds: nip86State?.allowedKinds ?? envKinds,
        state: nip86State,
        apply: {
          allowed: (list) => {
            // 被移出名冊的人已連著的連線一起切（SDK ADR 0136）。只在執行期套用名冊時呼叫，`dispatch` 已就緒
            dispatch(core.setAllowedAuthors(withRosterAdmin(list)));
            currentAllowed = list;
          },
          kinds: (list) => core.setAllowedKinds(list),
        },
        save: exec === undefined ? undefined : (state) => saveNip86State(exec, state),
        log: (line) => console.log(line),
      });
    } catch (error) {
      db?.close();
      throw error;
    }
  }

  // 僅限車道（SDK ADR 0051）：與 Cloudflare 版同一個環境變數、同一個 `routeForPath`。本宿主沒有車道 DO，
  // 名單只當**門**用：通過的連線仍是本站唯一的嚴格政策（要 NIP-42 AUTH），不會因此變成寬鬆車道（ADR-0366 §決策 8）。
  // 沒開＝與過去完全相同（任何路徑都接受）。
  const lanesOnly = lanesOnlyFrom(env.LANES_ONLY);
  const lanes = knownLanes(env.APP_LANES);
  if (lanesOnly && lanes.size === 0) console.warn("LANES_ONLY 開著但 APP_LANES 是空的：這座站拒絕所有連線（SDK ADR 0051）");
  const badReadOnly = readOnlyLanesFrom(env.READONLY_LANES).ignored;
  // 🔴 只印第幾項與原因，不印車道 id（它是秘密）
  if (badReadOnly.length > 0) console.warn(`READONLY_LANES 忽略無效的項目：${badReadOnly.join("；")}（SDK ADR 0052）`);
  const nowSec = (): number => Math.floor(Date.now() / 1000);
  /** 這個路徑的路由（與 Cloudflare 版同一個 `routeForPath`；唯讀寬限期依現在的時間判斷） */
  const routeOf = (rawUrl: string | undefined) => {
    const pathname = (rawUrl ?? "/").split("?")[0] ?? "/";
    const readOnlyLanes = readOnlyLaneIds(env, nowSec());
    return routeForPath(pathname, lanes, { lanesOnly: true, ...(readOnlyLanes.size > 0 ? { readOnlyLanes } : {}) });
  };
  const pathAllowed = (rawUrl: string | undefined): boolean => !lanesOnly || routeOf(rawUrl) !== undefined;
  /** 連進來的路徑是唯讀寬限期的車道嗎（SDK ADR 0052）：是的話回車道 id */
  const readOnlyLaneOf = (rawUrl: string | undefined): string | undefined => {
    const route = routeOf(rawUrl);
    return route?.profile === "app" && route.readOnly === true ? route.laneId : undefined;
  };

  // NIP-11 文件（ADR-0260）：自架者以環境變數填站名/聯絡/贊助管道；未設的欄位不會出現。
  // 每次請求現組：NIP-86 能在執行期改站名、說明與白名單（SDK ADR 0132）。
  const relayInfoOf = () => buildRelayInfo({
    name: nip86?.info().name ?? env.RELAY_NAME,
    description: nip86?.info().description ?? env.RELAY_DESCRIPTION,
    pubkey: env.RELAY_PUBKEY,
    contact: env.RELAY_CONTACT,
    // 未設或空白＝SDK 的中立預設（buildRelayInfo；SDK ADR 0019、0050）
    software: env.RELAY_SOFTWARE_URL?.trim() || undefined,
    maxTtlDays: env.MAX_TTL_DAYS,
    acceptsFiles: filePolicy.accept,
    authRequired: requireAuth,
    inboxAck: requireAuth,
    writeRestricted: currentAllowed !== undefined,
    nip86: nip86 !== undefined && nip86Admins !== undefined,
    maxMessagesPerSecondPerIp: perIp,
    // 實際套用的值（SDK ADR 0129）；設 0 關掉時不宣告
    maxEventsPerMinute: rate ?? "off",
    capacity,
    // 宿主注入的版號（與 Worker 一致；Cinderous ADR-0356 的一鍵更新節點靠它比對）。
    // 先前漏了這一欄，自架站的 NIP-11 永遠沒有 version（SDK ADR 0018 冒煙測試抓到）。
    version: relayVersion(),
    donations: {
      github_sponsors: env.DONATE_GITHUB_SPONSORS,
      buy_me_a_coffee: env.DONATE_BUY_ME_A_COFFEE,
      liberapay: env.DONATE_LIBERAPAY,
      lightning: env.DONATE_LIGHTNING,
    },
    nodeAttestation: env.NODE_ATTESTATION,
    // C′ 即時通道（SDK ADR 0120）：與 `/iot/` 實際啟用的家庭同一個解析
    iotRealtime: iotRealtimeAnnouncement(env),
  });

  const sockets = new Map<string, WebSocket>();
  // 每月流量預算（SDK ADR 0101）：沒設＝不限。只算 WebSocket 裡的資料量（TLS／HTTP 開銷在反向代理上）
  const traffic = trafficBudgetFrom(env);
  if (traffic.ignored.length > 0) console.warn(`流量設定有項目沒有生效（SDK ADR 0101）：${traffic.ignored.join("；")}`);
  const trafficBudget = opts.trafficBudget ?? traffic.budget;
  const meter = trafficBudget === undefined ? undefined : new TrafficMeter(trafficBudget, sqlExec ? { exec: sqlExec } : {});
  if (meter !== undefined && sqlExec === undefined) console.warn("純記憶體模式：流量用量重開就歸零（SDK ADR 0101）");
  /** 送出並計入流量 */
  const sendTo = (ws: WebSocket | undefined, payload: string): void => {
    if (ws === undefined) return;
    ws.send(payload);
    meter?.record("out", Buffer.byteLength(payload));
  };
  let warnedLevel: number | undefined;
  let cutOffUntil: number | undefined;
  /** 流量用完（SDK ADR 0101）：每條連線收到說明並以 1013 關閉；日誌每個週期只寫一次 */
  const enforceTraffic = (): boolean => {
    if (meter === undefined) return false;
    const snap = meter.snapshot();
    const level = meter.nearFullLevel();
    if (level !== undefined && level !== warnedLevel) {
      warnedLevel = level;
      console.warn(`本月流量已用 ${snap.percent}%（預算 ${snap.budgetBytes} 位元組，SDK ADR 0101）`);
    }
    if (!snap.exhausted) return false;
    if (cutOffUntil !== snap.resetsAt) {
      cutOffUntil = snap.resetsAt;
      console.warn(`本月流量用完，暫停服務到 ${new Date(snap.resetsAt * 1000).toISOString()}（SDK ADR 0101）`);
    }
    const { notice, reason } = trafficQuotaRejection(snap.resetsAt);
    for (const ws of sockets.values()) {
      ws.send(JSON.stringify(["NOTICE", notice]));
      ws.close(UPGRADE_UNAVAILABLE_CLOSE_CODE, reason);
    }
    return true;
  };
  // 同時連線數（SDK ADR 0100）：沒設＝不限。只數真正進來的連線；被擋的不佔名額
  const connectionCap = maxConnectionsFrom(env.MAX_CONNECTIONS);
  const perIpCap = maxConnectionsPerIpFrom(env.MAX_CONNECTIONS_PER_IP);
  const perIpCount = new Map<string, number>();
  let counter = 0;
  const dispatch = (out: Outbound[]): void => {
    for (const { to, message, close } of out) {
      const ws = sockets.get(to);
      // 本月流量快用完（SDK ADR 0101）：收下了的 OK 帶預警；已經帶別的警告（空間、借用）就不蓋掉
      const level = meter?.nearFullLevel();
      if (level !== undefined && message[0] === "OK" && message[2] === true && message[3] === "") {
        sendTo(ws, JSON.stringify([message[0], message[1], message[2], trafficNearFullWarning(level)]));
      } else {
        sendTo(ws, JSON.stringify(message));
      }
      // 超限即關（ADR-0366 §容量）：與 Cloudflare 宿主同一個行為，否則自架站少一道護欄。
      if (close) {
        const { code, reason } = closeSignalOf(close);
        ws?.close(code, reason);
      }
    }
  };

  // 掛在 HTTP 伺服器上：一般請求回 200（讓 PaaS/容器健康檢查通過，比照 Cloudflare worker），
  // WebSocket 升級請求交給 ws。純 WS 伺服器對 GET / 不回應會被健康檢查誤判為離線。
  // IoT 即時通道（SDK ADR 0049 C′）：`/iot/` 自己一套（沒設 IOT_REALTIME＝一律 404 iot-disabled，與 Cloudflare 版相同）
  const iot = createIotNodeHub(env, sqlExec ? { exec: sqlExec } : {});
  const httpServer = createServer((req, res) => {
    if (iot.handleHttp(req, res)) return;
    // NIP-86 管理 API（SDK ADR 0132）：沒開＝當作一般請求，跟之前一樣
    // 只設了 ROSTER_ADMIN_PUBKEY（名冊自動套用，SDK ADR 0134）時沒有運維金鑰＝不開這個端點
    if (nip86 !== undefined && nip86Admins !== undefined && (req.method === "OPTIONS" || isNip86Request(req.method, req.headers["content-type"]))) {
      if (!pathAllowed(req.url)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end(UNKNOWN_PATH_INFO_BODY);
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, NIP86_CORS_HEADERS);
        res.end();
        return;
      }
      const admin = nip86;
      /** 回應後切斷連線：對方還在送的內容不再收（SDK ADR 0133） */
      const reply = (status: number, body: unknown, hangUp = false) => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          ...NIP86_CORS_HEADERS,
          ...(hangUp ? { connection: "close" } : {}),
        });
        res.end(JSON.stringify(body), () => {
          if (hangUp) req.destroy();
        });
      };
      // 先擋人、再收內容（SDK ADR 0133）：不是運維金鑰簽的就不替他緩衝任何東西。
      if (!nip86Precheck(admin, req.headers.authorization)) {
        reply(401, { error: "unauthorized" }, true);
        return;
      }
      if (Number(req.headers["content-length"] ?? 0) > NIP86_MAX_BODY_BYTES) {
        reply(413, { error: "payload too large" }, true);
        return;
      }
      readBody(req, NIP86_MAX_BODY_BYTES, (body) => {
        if (body === undefined) {
          reply(413, { error: "payload too large" }, true);
          return;
        }
        try {
          const out = handleNip86Request(admin, {
            method: req.method ?? "POST",
            contentType: req.headers["content-type"],
            authorization: req.headers.authorization,
            body,
            // 🔴 只看 Host，不看 X-Forwarded-Host：那是任何人都能加的標頭。反向代理後面請設 NIP86_PUBLIC_URL。
            host: firstHost(req.headers.host),
            publicUrl: nip86PublicUrl,
            path: (req.url ?? "/").split("?")[0] ?? "/",
          });
          reply(out.status, out.body);
        } catch (error) {
          // 這裡是 `end` 事件的回呼：漏出去的例外會讓整個程序結束
          console.warn("NIP-86 請求處理失敗：", error);
          reply(500, { error: "internal error" });
        }
      });
      return;
    }
    // NIP-11（ADR-0260）：只有明確要 `application/nostr+json` 的請求拿到 JSON；其餘維持純文字 200
    // ——健康檢查靠那個 200（ADR-0089 的契約），改掉會讓部署中的站看起來像掛了。
    if (wantsRelayInfo(req.headers.accept)) {
      // 僅限車道（SDK ADR 0051）：被拒的路徑回 404，內容與 Cloudflare 版相同、不提任何車道
      if (!pathAllowed(req.url)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(UNKNOWN_PATH_INFO_BODY);
        return;
      }
      // 唯讀寬限期（SDK ADR 0052）：寫入一律被拒，文件照實宣告（與 Cloudflare 版相同）
      const readOnlyLane = readOnlyLaneOf(req.url);
      const readOnlyUntil = readOnlyLane === undefined ? undefined : readOnlyLanesFrom(env.READONLY_LANES).lanes.get(readOnlyLane);
      res.writeHead(200, NIP11_HEADERS);
      const relayInfo = relayInfoOf();
      const base = readOnlyUntil === undefined ? relayInfo : { ...relayInfo, ...readOnlyInfo(relayInfo, readOnlyUntil) };
      res.end(JSON.stringify(meter === undefined ? base : { ...base, cinder_traffic: trafficInfo(meter, trafficBudget!) }));
      return;
    }
    // `/healthz`（ADR-0354）：**純文字 `ok`，與兩座宿主一致**，自架文件才教得出同一句話。
    // 刻意與 `/` 的回應不同——Worker 在統一模式下 `/` 會回網頁版，「首頁回不回 HTML」
    // 已經不能拿來判斷中繼站死活。
    if ((req.url ?? "").split("?")[0] === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Cinderous relay");
  });
  // 升級改成自己分流：`/iot/` 在接受之前就要驗家庭與設備權杖（錯的回 HTTP 錯誤、不建立連線），其餘照舊交給中繼
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    if (iot.handleUpgrade(req, socket, head)) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws, req) => {
    if (!pathAllowed(req.url)) {
      // 與 Cloudflare 版同一個拒絕（ADR-0368）：接受、送一則 NOTICE、以 1008 關閉，句子逐字相同
      const host = (req.headers["x-forwarded-host"] ?? req.headers.host) as string | undefined;
      const { notice, reason } = upgradeRejection("unknown-path", firstHost(host) ?? "localhost", env.DEVELOPER_DOCS_URL);
      ws.send(JSON.stringify(["NOTICE", notice]));
      ws.close(UPGRADE_REJECT_CLOSE_CODE, reason);
      return;
    }
    const forwardedFor = req.headers["x-forwarded-for"];
    const ip = clientIpFrom(Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor, req.socket.remoteAddress, proxyHops) || undefined;
    // 本月流量用完（SDK ADR 0101）：新連線也收到說明、以 1013 關閉
    if (meter?.snapshot().exhausted) {
      const { notice, reason } = trafficQuotaRejection(meter.snapshot().resetsAt);
      ws.send(JSON.stringify(["NOTICE", notice]));
      ws.close(UPGRADE_UNAVAILABLE_CLOSE_CODE, reason);
      return;
    }
    const full: RejectKind | undefined =
      connectionCap !== undefined && sockets.size >= connectionCap
        ? "too-many-connections"
        : perIpCap !== undefined && ip !== undefined && (perIpCount.get(ip) ?? 0) >= perIpCap
          ? "too-many-connections-ip"
          : undefined;
    if (full !== undefined) {
      // 與 Cloudflare 版 DO 起不來時同一個形狀（SDK ADR 0097）：說明原因、1013 Try Again Later
      const host = (req.headers["x-forwarded-host"] ?? req.headers.host) as string | undefined;
      const { notice, reason } = upgradeRejection(full, firstHost(host) ?? "localhost", env.DEVELOPER_DOCS_URL);
      ws.send(JSON.stringify(["NOTICE", notice]));
      ws.close(upgradeCloseCode(full), reason);
      return;
    }
    const id = `c${counter++}`;
    sockets.set(id, ws);
    if (ip !== undefined) perIpCount.set(ip, (perIpCount.get(ip) ?? 0) + 1);
    const readOnlyLane = readOnlyLaneOf(req.url);
    if (readOnlyLane !== undefined) readOnlyConns.set(id, readOnlyLane);
    // 本次連線打到的主機（ADR-0235 H2）：AUTH 的 `relay` tag 必須指向它。反向代理後方以
    // `X-Forwarded-Host` 為準（否則會拿到內網的 `localhost:8787`，把所有客戶端擋在門外）。
    const host = (req.headers["x-forwarded-host"] ?? req.headers.host) as string | undefined;
    dispatch(core.connect(id, firstHost(host), ip)); // NIP-42 AUTH 挑戰
    ws.on("message", (data) => {
      meter?.record("in", rawLength(data));
      if (enforceTraffic()) return;
      // 唯讀寬限期在連線期間過了（SDK ADR 0052）：與認不得的路徑同一個拒絕，不處理這則訊息
      const lane = readOnlyConns.get(id);
      if (lane !== undefined && laneStateOf(env, lane, nowSec()) !== "read-only") {
        const { notice, reason } = upgradeRejection("unknown-path", firstHost(host) ?? "localhost", env.DEVELOPER_DOCS_URL);
        ws.send(JSON.stringify(["NOTICE", notice]));
        ws.close(UPGRADE_REJECT_CLOSE_CODE, reason);
        cleanup();
        return;
      }
      dispatch(core.handle(id, data.toString()));
      enforceTraffic();
    });
    const cleanup = (): void => {
      // close 與 error 都會呼叫：只算一次（不然同一個 IP 的名額會被多扣）
      if (!sockets.delete(id)) return;
      core.disconnect(id);
      readOnlyConns.delete(id);
      if (ip !== undefined) {
        const left = (perIpCount.get(ip) ?? 1) - 1;
        if (left > 0) perIpCount.set(ip, left);
        else perIpCount.delete(ip);
      }
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  // 每小時清除已過期留言（NIP-40）；對應 Cloudflare 版的 DO alarm（ADR-0056/0059）。
  const pruneTimer = setInterval(() => store.prune(Math.floor(Date.now() / 1000)), PRUNE_INTERVAL_MS);
  const trafficTimer = meter === undefined ? undefined : setInterval(() => meter.flush(), TRAFFIC_FLUSH_MS);

  const ready = new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    const onListening = () => {
      httpServer.off("error", reject);
      const address = httpServer.address();
      const actual = typeof address === "object" && address !== null ? address.port : port;
      const storage = dbPath === undefined ? "純記憶體" : `DB=${dbPath}`;
      const writers = allowed ? `, 白名單 ${allowed.length} 人` : "";
      const shown = host === undefined ? "0.0.0.0" : host.includes(":") ? `[${host}]` : host;
      console.log(`Cinderous node-relay：ws://${shown}:${actual}（${storage}, requireAuth=${requireAuth}${writers}）`);
      resolve(actual);
    };
    if (host === undefined) httpServer.listen(port, onListening);
    else httpServer.listen(port, host, onListening);
  });

  return {
    ready,
    close() {
      clearInterval(pruneTimer);
      if (trafficTimer !== undefined) clearInterval(trafficTimer);
      meter?.flush();
      iot.close();
      wss.close();
      httpServer.close();
      db?.close();
    },
  };
}

/** NIP-86 回應的 CORS 標頭：網頁版的管理工具要能帶 Authorization 打進來（SDK ADR 0132） */
const NIP86_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
} as const;

/** 讀完請求內容；超過上限就停止收集、回 undefined（不把整包讀進記憶體） */
function readBody(req: IncomingMessage, max: number, done: (body: string | undefined) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let finished = false;
  const finish = (body: string | undefined) => {
    if (finished) return;
    finished = true;
    done(body);
  };
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > max) {
      finish(undefined);
      return;
    }
    if (!finished) chunks.push(chunk);
  });
  req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
  req.on("error", () => finish(undefined));
}

/** NIP-86 存檔的表（SDK ADR 0132）：一列 JSON，重開後蓋過環境變數 */
function loadNip86State(exec: SqlExec): Nip86State | undefined {
  exec("CREATE TABLE IF NOT EXISTS cinder_admin_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const row = exec("SELECT v FROM cinder_admin_state WHERE k = ?", "nip86")[0];
  if (row === undefined || typeof row.v !== "string") return undefined;
  const state = parseNip86State(row.v);
  if (state === undefined) console.warn("cinder_admin_state 的 NIP-86 設定壞了或結構不對，這次照環境變數（SDK ADR 0133）");
  return state;
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((x) => set.has(x));
}

function saveNip86State(exec: SqlExec, state: Nip86State): void {
  exec("INSERT INTO cinder_admin_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", "nip86", JSON.stringify(state));
}

/** WebSocket 收到的一則訊息有幾個位元組（`ws` 可能給 Buffer、ArrayBuffer 或分段的 Buffer 陣列） */
function rawLength(data: unknown): number {
  if (Array.isArray(data)) return data.reduce((n: number, part: { length: number }) => n + part.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return (data as { length?: number }).length ?? 0;
}

/**
 * NIP-11 的流量欄位（SDK ADR 0101）：預算多大、怎麼算、這一期用了幾 %、何時重置。
 * 只公開百分比與預算，讓客戶端在用完前就能分散到別座；確切位元組只寫日誌。
 */
function trafficInfo(meter: TrafficMeter, budget: TrafficBudget): Record<string, unknown> {
  const snap = meter.snapshot();
  return {
    budget_bytes: budget.budgetBytes,
    count: budget.count,
    used_percent: snap.percent,
    resets_at: snap.resetsAt,
    ...(budget.nearFullPercent !== undefined ? { near_full_percent: budget.nearFullPercent } : {}),
  };
}

/** 唯讀寬限期的 NIP-11 差異（SDK ADR 0052）：`restricted_writes`、到期時間、不收檔案。 */
function readOnlyInfo(info: Record<string, unknown>, until: number): Record<string, unknown> {
  const limitation = typeof info.limitation === "object" && info.limitation !== null ? info.limitation : {};
  return {
    limitation: { ...limitation, restricted_writes: true },
    cinder_read_only_until: until,
    cinder_accepts_files: false,
  };
}
