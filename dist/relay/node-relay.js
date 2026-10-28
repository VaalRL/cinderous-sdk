// 正式版 Node.js 中繼站主機：跑與 Cloudflare 相同的 RelayCore，可在任何 Node 22+ 機器
// （例如樹莓派）長駐執行。離線留言以 Node 內建 SQLite 檔案持久化、預設要求 NIP-42 認證、
// 每小時清除過期留言（對應 Cloudflare 版的 DO alarm）。設定與對外方式見
// docs/self-hosting-raspberry-pi.md。
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
import { allowedPubkeysFrom, connectionsPerPubkeyFrom, eventsPerMinuteFrom, fileLanesMode, filePolicyFor, firstHost, guardFor, knownLanes, lanesOnlyFrom, maxConnectionsFrom, maxConnectionsPerIpFrom, laneStateOf, messagesPerMinuteFrom, messagesPerSecondPerIpFrom, nodeCapacityFrom, readOnlyLaneIds, readOnlyLanesFrom, inboxAckGraceFor, storeOptions, } from "./host-config.js";
import { MessageStore } from "./message-store.js";
import { buildRelayInfo, NIP11_HEADERS, wantsRelayInfo } from "./nip11.js";
import { relayVersion } from "./version.js";
import { closeSignalOf, RelayCore } from "./relay-core.js";
import { SqlMessageStore } from "./sql-message-store.js";
import { trafficNearFullWarning, trafficQuotaRejection, UNKNOWN_PATH_INFO_BODY, UPGRADE_REJECT_CLOSE_CODE, UPGRADE_UNAVAILABLE_CLOSE_CODE, upgradeCloseCode, upgradeRejection, } from "./reject-messages.js";
import { TRAFFIC_FLUSH_MS, trafficBudgetFrom, TrafficMeter } from "./traffic-budget.js";
import { routeForPath } from "./shard.js";
import { createIotNodeHub } from "./iot-node.js";
// node:sqlite 太新、打包器的內建模組表未收錄 → 以 createRequire 動態載入（型別走 type-only）。
// 只在真的要寫檔時才載入：純記憶體模式不該因為 Node 版本沒有 node:sqlite 而開不起來。
function openDatabase(path) {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    return new DatabaseSync(path);
}
/**
 * 啟動 Node 版中繼（SDK ADR 0007：原本是一載入就開 server 的腳本，改成可呼叫的函式）。
 * 回傳 `close()`：停掉 HTTP／WebSocket 伺服器與清除排程、關掉 SQLite。
 */
export function startNodeRelay(env = process.env, opts = {}) {
    const port = Number(env.PORT ?? 8787);
    const dbPath = opts.memory ? undefined : (env.DB_PATH ?? "cinder-relay.db");
    const requireAuth = env.REQUIRE_AUTH !== "0"; // 預設開 NIP-42 認證；設 REQUIRE_AUTH=0 可關
    // 白名單（SDK ADR 0008）：寫錯任何一筆就在這裡丟例外、不開站——不會默默變成開放中繼。
    const allowed = allowedPubkeysFrom(env.ALLOWED_PUBKEYS);
    const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
    let db;
    let store;
    let sqlExec;
    // 空間上限（SDK ADR 0099）：沿用 Cloudflare 版的容量設定，只認 `strict`；`CEILING_MODE` 決定滿了拒收或淘汰。
    // 什麼都沒設＝`capacity` 不出現＝與之前完全相同。設錯的項目不生效，要看得見
    const { capacity, ignored: capacityIgnored } = nodeCapacityFrom(env);
    if (capacityIgnored.length > 0)
        console.warn(`容量設定有項目沒有生效（SDK ADR 0099）：${capacityIgnored.join("；")}`);
    const storeOpts = storeOptions(env.MAX_TTL_DAYS, "strict", false, undefined, capacity);
    if (dbPath === undefined) {
        store = new MessageStore(storeOpts);
    }
    else {
        const opened = openDatabase(dbPath);
        db = opened;
        const exec = (query, ...bindings) => {
            const stmt = opened.prepare(query);
            if (/^\s*select/i.test(query))
                return stmt.all(...bindings);
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
    const coreOptions = { store, ...guardFor("strict"), requireAuth };
    if (allowed)
        coreOptions.allowedAuthors = allowed;
    // 收件確認（SDK ADR 0067）：要 AUTH 證明「自己的收件匣」；REQUIRE_AUTH=0 的站不發挑戰，就不開也不宣告
    if (requireAuth)
        coreOptions.inboxAckGraceSec = inboxAckGraceFor(storeOpts);
    // PRD 3.3（SDK ADR 0013）：沒設＝不限；`cinderous relay start` 預設帶 5 與 20
    const maxConnections = connectionsPerPubkeyFrom(env.MAX_CONNECTIONS_PER_PUBKEY);
    if (maxConnections !== undefined)
        coreOptions.maxConnectionsPerPubkey = maxConnections;
    const perIp = messagesPerSecondPerIpFrom(env.MAX_MESSAGES_PER_SECOND_PER_IP);
    if (perIp !== undefined)
        coreOptions.maxMessagesPerSecondPerIp = perIp;
    // 反向代理後方才信 X-Forwarded-For（TRUST_PROXY=1）；直連時那個標頭任何人都能偽造
    const trustProxy = env.TRUST_PROXY === "1";
    const rate = eventsPerMinuteFrom(env.MAX_EVENTS_PER_MINUTE);
    if (rate === undefined)
        delete coreOptions.maxEventsPerMinute;
    else
        coreOptions.maxEventsPerMinute = rate;
    // 訊息上限跟著事件上限走（ADR-0366 §容量）：調高事件上限的自架站不該被訊息上限偷偷夾住。
    const msgRate = messagesPerMinuteFrom(env.MAX_MESSAGES_PER_MINUTE, rate);
    if (msgRate === undefined)
        delete coreOptions.maxMessagesPerMinute;
    else
        coreOptions.maxMessagesPerMinute = msgRate;
    // 檔案塊（Cinderous ADR-0162／0371）：與 Cloudflare 版同一個 `filePolicyFor`。本宿主沒有車道，所以永遠以
    // 「不是任何車道」去問——沒設 FILE_LANES 時 MAX_FILE_MB 照舊是全站開關（自架單人站不變）；
    // 設了 FILE_LANES 就是車道模式，而這裡沒有車道 ⇒ 整站不收，與 Cloudflare 版的主訊息平面一致。
    const filePolicy = filePolicyFor(env);
    if (filePolicy.accept)
        coreOptions.acceptFileEvents = true;
    if (fileLanesMode(env.FILE_LANES)) {
        console.warn("FILE_LANES 只在 Cloudflare 版（有車道 DO）生效；node 主機沒有車道，設了它就整站不收檔案塊（Cinderous ADR-0371）");
    }
    // 唯讀寬限期（SDK ADR 0052）：本宿主所有路徑共用一個 core，所以唯讀是**每條連線**的（連進來的路徑是唯讀車道）
    const readOnlyConns = new Map(); // connId → 車道 id
    coreOptions.readOnly = (connId) => readOnlyConns.has(connId);
    const core = new RelayCore(coreOptions);
    // 僅限車道（SDK ADR 0051）：與 Cloudflare 版同一個環境變數、同一個 `routeForPath`。本宿主沒有車道 DO，
    // 名單只當**門**用：通過的連線仍是本站唯一的嚴格政策（要 NIP-42 AUTH），不會因此變成寬鬆車道（ADR-0366 §決策 8）。
    // 沒開＝與過去完全相同（任何路徑都接受）。
    const lanesOnly = lanesOnlyFrom(env.LANES_ONLY);
    const lanes = knownLanes(env.APP_LANES);
    if (lanesOnly && lanes.size === 0)
        console.warn("LANES_ONLY 開著但 APP_LANES 是空的：這座站拒絕所有連線（SDK ADR 0051）");
    const badReadOnly = readOnlyLanesFrom(env.READONLY_LANES).ignored;
    // 🔴 只印第幾項與原因，不印車道 id（它是秘密）
    if (badReadOnly.length > 0)
        console.warn(`READONLY_LANES 忽略無效的項目：${badReadOnly.join("；")}（SDK ADR 0052）`);
    const nowSec = () => Math.floor(Date.now() / 1000);
    /** 這個路徑的路由（與 Cloudflare 版同一個 `routeForPath`；唯讀寬限期依現在的時間判斷） */
    const routeOf = (rawUrl) => {
        const pathname = (rawUrl ?? "/").split("?")[0] ?? "/";
        const readOnlyLanes = readOnlyLaneIds(env, nowSec());
        return routeForPath(pathname, lanes, { lanesOnly: true, ...(readOnlyLanes.size > 0 ? { readOnlyLanes } : {}) });
    };
    const pathAllowed = (rawUrl) => !lanesOnly || routeOf(rawUrl) !== undefined;
    /** 連進來的路徑是唯讀寬限期的車道嗎（SDK ADR 0052）：是的話回車道 id */
    const readOnlyLaneOf = (rawUrl) => {
        const route = routeOf(rawUrl);
        return route?.profile === "app" && route.readOnly === true ? route.laneId : undefined;
    };
    // NIP-11 文件（ADR-0260）：自架者以環境變數填站名/聯絡/贊助管道；未設的欄位不會出現。
    // 只組一次——內容全部來自啟動時的環境，執行期不會變。
    const relayInfo = buildRelayInfo({
        name: env.RELAY_NAME,
        description: env.RELAY_DESCRIPTION,
        pubkey: env.RELAY_PUBKEY,
        contact: env.RELAY_CONTACT,
        // 未設或空白＝SDK 的中立預設（buildRelayInfo；SDK ADR 0019、0050）
        software: env.RELAY_SOFTWARE_URL?.trim() || undefined,
        maxTtlDays: env.MAX_TTL_DAYS,
        acceptsFiles: filePolicy.accept,
        authRequired: requireAuth,
        inboxAck: requireAuth,
        writeRestricted: allowed !== undefined,
        maxMessagesPerSecondPerIp: perIp,
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
    });
    const sockets = new Map();
    // 每月流量預算（SDK ADR 0101）：沒設＝不限。只算 WebSocket 裡的資料量（TLS／HTTP 開銷在反向代理上）
    const traffic = trafficBudgetFrom(env);
    if (traffic.ignored.length > 0)
        console.warn(`流量設定有項目沒有生效（SDK ADR 0101）：${traffic.ignored.join("；")}`);
    const trafficBudget = opts.trafficBudget ?? traffic.budget;
    const meter = trafficBudget === undefined ? undefined : new TrafficMeter(trafficBudget, sqlExec ? { exec: sqlExec } : {});
    if (meter !== undefined && sqlExec === undefined)
        console.warn("純記憶體模式：流量用量重開就歸零（SDK ADR 0101）");
    /** 送出並計入流量 */
    const sendTo = (ws, payload) => {
        if (ws === undefined)
            return;
        ws.send(payload);
        meter?.record("out", Buffer.byteLength(payload));
    };
    let warnedLevel;
    let cutOffUntil;
    /** 流量用完（SDK ADR 0101）：每條連線收到說明並以 1013 關閉；日誌每個週期只寫一次 */
    const enforceTraffic = () => {
        if (meter === undefined)
            return false;
        const snap = meter.snapshot();
        const level = meter.nearFullLevel();
        if (level !== undefined && level !== warnedLevel) {
            warnedLevel = level;
            console.warn(`本月流量已用 ${snap.percent}%（預算 ${snap.budgetBytes} 位元組，SDK ADR 0101）`);
        }
        if (!snap.exhausted)
            return false;
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
    const perIpCount = new Map();
    let counter = 0;
    const dispatch = (out) => {
        for (const { to, message, close } of out) {
            const ws = sockets.get(to);
            // 本月流量快用完（SDK ADR 0101）：收下了的 OK 帶預警；已經帶別的警告（空間、借用）就不蓋掉
            const level = meter?.nearFullLevel();
            if (level !== undefined && message[0] === "OK" && message[2] === true && message[3] === "") {
                sendTo(ws, JSON.stringify([message[0], message[1], message[2], trafficNearFullWarning(level)]));
            }
            else {
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
        const iotHttp = iot.handleHttp((req.url ?? "/").split("?")[0] ?? "/");
        if (iotHttp) {
            res.writeHead(iotHttp.status, { "content-type": "application/json; charset=utf-8", "Cinder-Relay": "1" });
            res.end(JSON.stringify({ error: iotHttp.error }));
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
            const base = readOnlyUntil === undefined ? relayInfo : { ...relayInfo, ...readOnlyInfo(relayInfo, readOnlyUntil) };
            res.end(JSON.stringify(meter === undefined ? base : { ...base, cinder_traffic: trafficInfo(meter, trafficBudget) }));
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
        if (iot.handleUpgrade(req, socket, head))
            return;
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    wss.on("connection", (ws, req) => {
        if (!pathAllowed(req.url)) {
            // 與 Cloudflare 版同一個拒絕（ADR-0368）：接受、送一則 NOTICE、以 1008 關閉，句子逐字相同
            const host = (req.headers["x-forwarded-host"] ?? req.headers.host);
            const { notice, reason } = upgradeRejection("unknown-path", firstHost(host) ?? "localhost", env.DEVELOPER_DOCS_URL);
            ws.send(JSON.stringify(["NOTICE", notice]));
            ws.close(UPGRADE_REJECT_CLOSE_CODE, reason);
            return;
        }
        const forwarded = trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
        const ip = forwarded || req.socket.remoteAddress || undefined;
        // 本月流量用完（SDK ADR 0101）：新連線也收到說明、以 1013 關閉
        if (meter?.snapshot().exhausted) {
            const { notice, reason } = trafficQuotaRejection(meter.snapshot().resetsAt);
            ws.send(JSON.stringify(["NOTICE", notice]));
            ws.close(UPGRADE_UNAVAILABLE_CLOSE_CODE, reason);
            return;
        }
        const full = connectionCap !== undefined && sockets.size >= connectionCap
            ? "too-many-connections"
            : perIpCap !== undefined && ip !== undefined && (perIpCount.get(ip) ?? 0) >= perIpCap
                ? "too-many-connections-ip"
                : undefined;
        if (full !== undefined) {
            // 與 Cloudflare 版 DO 起不來時同一個形狀（SDK ADR 0097）：說明原因、1013 Try Again Later
            const host = (req.headers["x-forwarded-host"] ?? req.headers.host);
            const { notice, reason } = upgradeRejection(full, firstHost(host) ?? "localhost", env.DEVELOPER_DOCS_URL);
            ws.send(JSON.stringify(["NOTICE", notice]));
            ws.close(upgradeCloseCode(full), reason);
            return;
        }
        const id = `c${counter++}`;
        sockets.set(id, ws);
        if (ip !== undefined)
            perIpCount.set(ip, (perIpCount.get(ip) ?? 0) + 1);
        const readOnlyLane = readOnlyLaneOf(req.url);
        if (readOnlyLane !== undefined)
            readOnlyConns.set(id, readOnlyLane);
        // 本次連線打到的主機（ADR-0235 H2）：AUTH 的 `relay` tag 必須指向它。反向代理後方以
        // `X-Forwarded-Host` 為準（否則會拿到內網的 `localhost:8787`，把所有客戶端擋在門外）。
        const host = (req.headers["x-forwarded-host"] ?? req.headers.host);
        dispatch(core.connect(id, firstHost(host), ip)); // NIP-42 AUTH 挑戰
        ws.on("message", (data) => {
            meter?.record("in", rawLength(data));
            if (enforceTraffic())
                return;
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
        const cleanup = () => {
            // close 與 error 都會呼叫：只算一次（不然同一個 IP 的名額會被多扣）
            if (!sockets.delete(id))
                return;
            core.disconnect(id);
            readOnlyConns.delete(id);
            if (ip !== undefined) {
                const left = (perIpCount.get(ip) ?? 1) - 1;
                if (left > 0)
                    perIpCount.set(ip, left);
                else
                    perIpCount.delete(ip);
            }
        };
        ws.on("close", cleanup);
        ws.on("error", cleanup);
    });
    // 每小時清除已過期留言（NIP-40）；對應 Cloudflare 版的 DO alarm（ADR-0056/0059）。
    const pruneTimer = setInterval(() => store.prune(Math.floor(Date.now() / 1000)), PRUNE_INTERVAL_MS);
    const trafficTimer = meter === undefined ? undefined : setInterval(() => meter.flush(), TRAFFIC_FLUSH_MS);
    const ready = new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, () => {
            httpServer.off("error", reject);
            const address = httpServer.address();
            const actual = typeof address === "object" && address !== null ? address.port : port;
            const storage = dbPath === undefined ? "純記憶體" : `DB=${dbPath}`;
            const writers = allowed ? `, 白名單 ${allowed.length} 人` : "";
            console.log(`Cinderous node-relay：ws://0.0.0.0:${actual}（${storage}, requireAuth=${requireAuth}${writers}）`);
            resolve(actual);
        });
    });
    return {
        ready,
        close() {
            clearInterval(pruneTimer);
            if (trafficTimer !== undefined)
                clearInterval(trafficTimer);
            meter?.flush();
            iot.close();
            wss.close();
            httpServer.close();
            db?.close();
        },
    };
}
/** WebSocket 收到的一則訊息有幾個位元組（`ws` 可能給 Buffer、ArrayBuffer 或分段的 Buffer 陣列） */
function rawLength(data) {
    if (Array.isArray(data))
        return data.reduce((n, part) => n + part.length, 0);
    if (data instanceof ArrayBuffer)
        return data.byteLength;
    return data.length ?? 0;
}
/**
 * NIP-11 的流量欄位（SDK ADR 0101）：預算多大、怎麼算、這一期用了幾 %、何時重置。
 * 只公開百分比與預算，讓客戶端在用完前就能分散到別座；確切位元組只寫日誌。
 */
function trafficInfo(meter, budget) {
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
function readOnlyInfo(info, until) {
    const limitation = typeof info.limitation === "object" && info.limitation !== null ? info.limitation : {};
    return {
        limitation: { ...limitation, restricted_writes: true },
        cinder_read_only_until: until,
        cinder_accepts_files: false,
    };
}
//# sourceMappingURL=node-relay.js.map