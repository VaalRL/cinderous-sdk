import { verifyHttpAuth } from "../protocol/index.js";
import { allowedPubkeysFrom, connectionsPerPubkeyFrom, doCapacityFor, doCapacitySettings, fileLanes, filePolicyFor, messagesPerSecondPerIpFrom, firstHost, guardFor, knownLanes, lanesOnlyFrom, laneStateOf, powForLane, readOnlyLaneIds, readOnlyLanesFrom, inboxAckGraceFor, storeOptions, } from "./host-config.js";
import { buildRelayInfo, NIP11_HEADERS, wantsRelayInfo } from "./nip11.js";
import { relayVersion } from "./version.js";
import { UNKNOWN_PATH_INFO_BODY, UPGRADE_REJECT_CLOSE_CODE, upgradeCloseCode, upgradeRejection } from "./reject-messages.js";
import { ConnPersistence, MAX_CONN_SUB_BYTES } from "./conn-persistence.js";
import { closeSignalOf, RelayCore, storageExhausted } from "./relay-core.js";
import { routeForPath } from "./shard.js";
import { routeIotRequest } from "./iot-home-room.js";
import { iotRealtimeAnnouncement } from "./iot-realtime.js";
export { IotHomeRoom } from "./iot-home-room.js";
import { SqlMessageStore } from "./sql-message-store.js";
import { ReconnectGuard, reconnectGuardFrom } from "./reconnect-guard.js";
import { UnauthDiag, unauthDiagEnabled } from "./unauth-diag.js";
/**
 * `/turn` 的 CORS 標頭（審查發現 #1）。
 *
 * ⚠ **每一種回應都要帶**（含 401／429／204）——只有 200 帶的話，瀏覽器讀不到錯誤狀態，
 * `fetch` 會直接 reject，客戶端就分不出「被擋」與「站方未配置」。
 */
const TURN_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Max-Age": "86400",
};
/** CORS 預檢回應。 */
export function turnPreflightResponse() {
    return new Response(null, { status: 204, headers: TURN_CORS });
}
/** Cloudflare TURN 憑證換發 API（POST，Bearer token）。 */
const CF_TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
/** 短期憑證秒數：正整數才採用，否則預設 1 天。 */
function turnTtlSeconds(raw) {
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 86400;
}
/**
 * `GET /turn`（ADR-0243）：以站方 secret 向 Cloudflare 換發**短期** TURN 憑證回給客戶端。
 * 未配 `TURN_KEY_ID`/`TURN_API_TOKEN` → **204**（客戶端 no-op、退回純 STUN）；Cloudflare 故障
 * 亦回 204（保底抓不到不該讓客戶端報錯）。憑證短期＋Cloudflare 端用量上限＝ADR-0243 的「有上限」。
 */
export async function mintTurnResponse(env, request, fetchFn = fetch) {
    const keyId = env.TURN_KEY_ID;
    const token = env.TURN_API_TOKEN;
    if (!keyId || !token)
        return new Response(null, { status: 204, headers: TURN_CORS }); // 未配置＝no-op
    // 🔴 ADR-0342 §3.2：先驗身分。**401 而非 204**——204 的語意是「站方未配置」，
    // 兩者不可混：客戶端對 204 是安靜退回純 STUN，對 401 才知道是自己沒帶授權。
    const pubkey = verifyHttpAuth(request.headers.get("Authorization"), request.url, request.method);
    if (!pubkey)
        return new Response(null, { status: 401, headers: TURN_CORS });
    // ADR-0342 §3.1（審查修正）：**以 IP 計數，不是 pubkey**。
    //
    // 🔴 原本用 pubkey——但 pubkey 由請求方自選、換一把是微秒級的事，
    // 以它計數等於完全沒有限制。要限速就得綁**比較貴的東西**：換 IP 要花錢。
    // ⚠ 代價是行動網路共用 IP 會被一起計數（額度給得寬即可容納）。
    // ⚠ 這仍是速度緩衝而非頻寬上限：Cloudflare 明說它 per-location 計數且最終一致。
    if (env.TURN_LIMIT) {
        const key = request.headers.get("CF-Connecting-IP") ?? pubkey; // 缺標頭（本地/測試）才退回 pubkey
        const { success } = await env.TURN_LIMIT.limit({ key });
        if (!success)
            return new Response(null, { status: 429, headers: TURN_CORS });
    }
    const ttl = turnTtlSeconds(env.TURN_TTL_SECONDS);
    try {
        const res = await fetchFn(`${CF_TURN_API}/${encodeURIComponent(keyId)}/credentials/generate`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ttl }),
        });
        if (!res.ok)
            return new Response(null, { status: 204, headers: TURN_CORS });
        // ⓪ ADR-0342 §2：把 **ttl 一起回給客戶端**。
        // 先前沒有這個欄位，客戶端只好寫死 6 小時刷新——TTL 一縮短，憑證就在客戶端不知情的
        // 情況下過期，TURN 形同失效。這裡送的就是我們送給 Cloudflare 的那個值（唯一真實來源）。
        const body = (await res.json());
        return new Response(JSON.stringify({ ...body, ttl }), {
            status: 200,
            headers: {
                ...TURN_CORS,
                "Content-Type": "application/json",
                "Cache-Control": "no-store", // 短期憑證，勿快取
            },
        });
    }
    catch {
        return new Response(null, { status: 204, headers: TURN_CORS });
    }
}
/**
 * 由 Worker 環境變數組出 NIP-11 文件（ADR-0260）。
 *
 * `authRequired: true` 是**寫死**的——worker 的 `RelayCore` 就是 `requireAuth: true`
 * （見 `RelayRoom` 建構子），拿一個獨立的旗標去描述它遲早會說謊。
 */
export function relayInfoFrom(env, profile = "strict", 
/** 本路徑是不是名單上的已知租戶（ADR-0366 §裁示）：公用分片的保存期短得多（ADR-0367）。 */
knownLane = false, 
/** 名單上車道的 id（Cinderous ADR-0371）：決定這條路徑收不收檔案、單檔上限多少。 */
laneId, 
/** 這條路徑的 DO 名（SDK ADR 0042）：決定天花板與容量政策；沒給＝預設天花板、沒有保底與溢位帶。 */
doName) {
    // 與 DO 實際套用的同一個函式（`filePolicyFor`）——文件說的就是這條路徑真正在執行的政策。
    const files = filePolicyFor(env, profile === "app" && knownLane ? laneId : undefined);
    // 唯讀寬限期（SDK ADR 0052）：與 DO 的寫入閘門同一個判斷；寫入一律被拒，所以也不宣告收檔案
    const readOnlyUntil = profile === "app" && knownLane && laneId !== undefined && laneStateOf(env, laneId, nowSec()) === "read-only"
        ? readOnlyLanesFrom(env.READONLY_LANES).lanes.get(laneId)
        : undefined;
    return buildRelayInfo({
        profile,
        knownLane,
        name: env.RELAY_NAME,
        description: env.RELAY_DESCRIPTION,
        pubkey: env.RELAY_PUBKEY,
        contact: env.RELAY_CONTACT,
        // 未設或空白＝SDK 的中立預設（buildRelayInfo；SDK ADR 0019、0050）
        software: env.RELAY_SOFTWARE_URL?.trim() || undefined,
        maxTtlDays: env.MAX_TTL_DAYS,
        acceptsFiles: files.accept && readOnlyUntil === undefined,
        maxFileMb: files.accept && readOnlyUntil === undefined ? files.maxFileMb : undefined,
        readOnlyUntil,
        // 與實際生效的政策同源（`guardFor`）——拿獨立旗標描述它遲早會說謊（見本檔案上方註解）。
        authRequired: guardFor(profile).requireAuth === true,
        writeRestricted: allowedPubkeysFrom(env.ALLOWED_PUBKEYS) !== undefined,
        // 與 DO 實際套用的同一個函式（SDK ADR 0036）：沒設＝不限、文件不出現。
        maxMessagesPerSecondPerIp: messagesPerSecondPerIpFrom(env.MAX_MESSAGES_PER_SECOND_PER_IP),
        // 與 DO 實際套用的同一個函式（SDK ADR 0042）：天花板、淘汰或拒收、保底、溢位帶、預警、丟棄計數都是靜態值
        ...(doName !== undefined ? { capacity: doCapacityFor(env, doName) } : {}),
        // ADR-0356：出貨版號。讓任何人（與 App 的「一鍵更新節點」）看得出這座跑的是哪一版，
        // 也讓 ADR-0241 的跟版義務從「口頭提醒」變成「查得到的事實」。
        version: relayVersion(),
        donations: {
            github_sponsors: env.DONATE_GITHUB_SPONSORS,
            buy_me_a_coffee: env.DONATE_BUY_ME_A_COFFEE,
            liberapay: env.DONATE_LIBERAPAY,
            lightning: env.DONATE_LIGHTNING,
        },
        nodeAttestation: env.NODE_ATTESTATION,
        // C′ 即時通道（SDK ADR 0120）：與 `routeIotRequest` 同一個條件（有 `IOT_HOME` 綁定、至少一個家庭有效）
        iotRealtime: env.IOT_HOME ? iotRealtimeAnnouncement(env) : undefined,
    });
}
/**
 * 這個路徑的路由——worker 與 DO 共用（SSOT）：已知租戶名單與僅限車道模式（SDK ADR 0051）都從 env 讀。
 */
function routeOf(pathname, env) {
    // 唯讀寬限期（SDK ADR 0052）：還沒到期的舊路徑照樣有路由（落在它原本那顆 DO）；到期由中繼自己判斷
    const readOnlyLanes = readOnlyLaneIds(env, nowSec());
    return routeForPath(pathname, knownLanes(env.APP_LANES), {
        lanesOnly: lanesOnlyFrom(env.LANES_ONLY),
        ...(readOnlyLanes.size > 0 ? { readOnlyLanes } : {}),
    });
}
/** 現在的 unix 秒（唯讀寬限期的到期判斷；SDK ADR 0052）。 */
function nowSec() {
    return Math.floor(Date.now() / 1000);
}
/** NIP-40 過期留言的清理間隔（C2）：DO alarm 每小時 prune 一次。 */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/**
 * 拒絕一次 WebSocket 升級，但**說得出為什麼**（ADR-0368）。
 *
 * 🔴 為什麼不直接回 404／429：瀏覽器的 `WebSocket` 不暴露握手的狀態碼與內容，
 * 對方只拿到一個沒有訊息的 `error` 與 close 1006——和「中繼站掛了」一模一樣。
 * 所以在 Worker 內接受、送一則 `NOTICE`、以 1008 關閉，關閉原因也帶文件網址。
 *
 * 🔴 **不碰任何 DO、不套任何政策**：這條連線從頭到尾只存在於這次 Worker 呼叫裡，
 * ADR-0366 §決策 4「認不得的連線不落在任何 DO」原樣成立；成本與原本的 404 同為一次請求。
 *
 * 刻意**不回顯**對方送來的路徑：對方自己知道打了什麼，回顯只會讓中繼站反射任意字串。
 * 句子由 `upgradeRejection` 組（Node 主機用同一個，SDK ADR 0051）。
 */
/** DO 拋出的錯誤是不是寫入（或讀取）額度用完（SDK ADR 0097）：Cloudflare 的訊息是「Exceeded allowed rows written…」 */
export function doFailureKind(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /exceeded allowed rows (written|read)|free tier|quota/i.test(message) ? "over-quota" : "unavailable";
}
export function rejectUpgrade(kind, host, env) {
    const { notice, reason } = upgradeRejection(kind, host, env.DEVELOPER_DOCS_URL);
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    server.send(JSON.stringify(["NOTICE", notice]));
    server.close(upgradeCloseCode(kind), reason);
    return new Response(null, { status: 101, webSocket: pair[0] });
}
/** Worker 進入點：WebSocket 升級後交給單一 Durable Object 房間以共享連線狀態。 */
export default {
    async fetch(request, env) {
        // IoT 即時通道（SDK ADR 0049 C′）：`/iot/v1/*` 自己一套路由與家庭 DO；沒開的站一律 404，不落進一般平面
        const iot = await routeIotRequest(request, env);
        if (iot)
            return iot;
        const url = new URL(request.url);
        if (request.headers.get("Upgrade") !== "websocket") {
            // 公共 TURN 保底端點（ADR-0243）：換發短期憑證；未配 secret 則 204、客戶端退回純 STUN。
            if (url.pathname === "/turn") {
                // 🔴 CORS 預檢必須在授權檢查**之前**（審查發現 #1）。
                // `Authorization` 不是 CORS 安全列表標頭 ⇒ 瀏覽器（含 Tauri／Capacitor 的 webview）
                // 會先送 OPTIONS。若讓它走進換發流程，會因為預檢不帶授權而回 401、且無 CORS 標頭
                // ⇒ **瀏覽器直接擋掉整個請求**，客戶端靜默退回純 STUN。
                if (request.method === "OPTIONS")
                    return turnPreflightResponse();
                return mintTurnResponse(env, request);
            }
            // NIP-11（ADR-0260）：只有明確要 `application/nostr+json` 的請求拿到 JSON；
            // 其餘維持純文字 200（PaaS／容器健康檢查靠它，ADR-0089 定下的契約）。
            if (wantsRelayInfo(request.headers.get("Accept"))) {
                // 依路徑回該車道的文件（ADR-0366）：一份文件描述不了兩種政策。
                // 認不得的路徑仍給嚴格版——探測器問錯路徑不該拿到比較寬鬆的描述。
                const infoRoute = routeOf(url.pathname, env);
                // 僅限車道（SDK ADR 0051）：被拒的路徑沒有政策可描述。回 404，內容與猜錯車道完全相同、不提任何車道。
                if (!infoRoute && lanesOnlyFrom(env.LANES_ONLY)) {
                    return new Response(UNKNOWN_PATH_INFO_BODY, {
                        status: 404,
                        headers: { "content-type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
                    });
                }
                const profile = infoRoute?.profile ?? "strict";
                const known = infoRoute?.profile === "app" && infoRoute.known;
                const laneId = infoRoute?.profile === "app" ? infoRoute.laneId : undefined;
                return new Response(JSON.stringify(relayInfoFrom(env, profile, known, laneId, infoRoute?.doName)), {
                    status: 200,
                    headers: NIP11_HEADERS,
                });
            }
            // 健康檢查落點（ADR-0354）：**兩種模式都回純文字**。統一節點模式下 `/` 會變成網頁版首頁，
            // 而 `docs/SELF-HOSTING*.md` 與 PaaS 健康檢查靠的是 ADR-0089 的純文字契約——搬到這裡而非廢除，
            // 兩座宿主（本檔與 `node-relay.ts`）一致。
            // ADR-0354：純文字 `ok`。**刻意與 `/` 的回應不同**——合體部署後 `/` 會回網頁版，
            // 「首頁回不回 HTML」已經不能拿來判斷中繼站死活，這個端點才是。
            if (url.pathname === "/healthz")
                return new Response("ok", { status: 200 });
            // 統一節點（ADR-0354，選配）：有 ASSETS 綁定＝這座 Worker 同時是網頁版 ⇒ 其餘 HTTP 交給資產
            // （SPA 深層路由由 `not_found_handling` 回退 index.html）。未綁定＝純 relay，維持純文字。
            if (env.ASSETS)
                return env.ASSETS.fetch(request);
            return new Response("Cinderous relay", { status: 200 });
        }
        // 路由（ADR-0241 分片 ＋ ADR-0366 第三方車道）：依 URL 路徑同時決定 **DO 與政策**。
        // 每個實例都是獨立 RelayRoom，血條＝一片崩只影響那一片。
        //
        // 🔴 **認不得的路徑直接拒絕**（ADR-0366 §決策 4）。原本是「其他一律回退舊全域」，
        // 那讓 `/s/zz` 這種算錯分片的客戶端靜默落進別的平面；而一旦有了寬鬆車道，
        // 任何 catch-all 都是一條把流量靜默送進錯誤政策的路。兩邊正面列舉、其餘拒絕（拒絕的形狀見 ADR-0368）。
        const route = routeOf(url.pathname, env);
        // 拒絕時要說得出為什麼（ADR-0368）：404 對瀏覽器與 Nostr 函式庫是看不見的。
        // 僅限車道（SDK ADR 0051）：一律回一般的「認不得的路徑」——「車道 id 不合法」會讓人分得出
        // 「猜的形狀對不對」，而秘密車道的站不該對猜測給任何回饋。
        if (!route) {
            const badLane = !lanesOnlyFrom(env.LANES_ONLY) && /^\/app(\/|$)/i.test(url.pathname);
            return rejectUpgrade(badLane ? "bad-lane" : "unknown-path", url.host, env);
        }
        // 車道的成本護欄（ADR-0366 §容量）：以 IP 計數的升級限速，在碰 DO 之前就擋掉。
        // `CF-Connecting-IP` 由 Cloudflare 填寫、客戶端偽造不了；**缺了就不限**——
        // 那代表根本不在 CF 後面，此時退回單一 key 會讓所有人共用一個額度，
        // 第一個濫用者就把全站擋死（那比不限還糟）。
        const clientIp = request.headers.get("CF-Connecting-IP");
        if (route.profile === "app" && env.APP_LANE_LIMIT && clientIp) {
            const { success } = await env.APP_LANE_LIMIT.limit({ key: clientIp });
            if (!success)
                return rejectUpgrade("rate-limited", url.host, env);
        }
        // 主平面的升級限速（SDK ADR 0111）：以「IP＋DO 名」計數，同樣在碰 DO 之前擋掉；缺標頭或未綁定就不限
        if (route.profile !== "app" && env.STRICT_UPGRADE_LIMIT && clientIp) {
            const { success } = await env.STRICT_UPGRADE_LIMIT.limit({ key: `${clientIp} ${route.doName}` });
            if (!success)
                return rejectUpgrade("reconnect-limited", url.host, env);
        }
        // 原始 request 原封不動轉給 DO——DO 對**同一個路徑**跑**同一個** `routeForPath` 算出政策，
        // 所以兩邊不可能不一致。刻意不用標頭傳遞：那要 clone request，而「`Upgrade` 標頭在
        // clone 之後還在不在」是平台細節，賭它不如不賭。
        const stub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(route.doName));
        // DO 起不來（SDK ADR 0097）：寫入額度用完時 Cloudflare 讓 DO 拋錯，沒接住就是 1101／500，客戶端分不出原因。
        // 接住、照 ADR-0368 的形狀說明原因並以 1013 關閉；內部錯誤訊息只進日誌，不回給客戶端
        try {
            const res = await stub.fetch(request);
            if (res.status >= 500 && !res.webSocket) {
                console.error("relay: DO responded", res.status);
                return rejectUpgrade("unavailable", url.host, env);
            }
            return res;
        }
        catch (error) {
            console.error("relay: DO failed", error);
            return rejectUpgrade(doFailureKind(error), url.host, env);
        }
    },
};
/** DO storage 裡記住本實例綁定的政策（ADR-0366）。 */
const PROFILE_KEY = "cinder:lane-profile";
/**
 * DO storage 裡記住本實例服務的是不是名單上的已知租戶（ADR-0366 §裁示）。
 *
 * 為什麼要存：休眠喚醒後可能**沒有 fetch**（`webSocketMessage` 直接進來），那時算不出
 * 車道 id；而配額必須與這顆 DO 先前用的那個一致，否則同一份儲存會被兩種配額讀寫過。
 */
const KNOWN_LANE_KEY = "cinder:lane-known";
/**
 * DO storage 裡記住本實例服務的**名單上車道 id**（Cinderous ADR-0371）。
 *
 * 為什麼要存：檔案政策依車道 id 決定（`FILE_LANES`），而休眠喚醒後可能沒有 fetch、算不出路徑。
 * 只存 id、不存「收不收檔案」：後者由 env 決定，改 `FILE_LANES` 重新部署就要立刻生效，
 * 存下來反而會把舊決定永久釘在 DO 裡。共用分片服務多條車道，不存（它們一律不收檔案）。
 */
const LANE_ID_KEY = "cinder:lane-id";
/**
 * DO storage 裡記住本實例的 **DO 名**（Cinderous ADR-0377；SDK ADR 0042 移植，鍵名逐字相同）。
 *
 * 為什麼要存：天花板與容量政策可以依單顆 DO 設定（`DO_CEILINGS_MIB` 的 `shard-a`、`presence`），而嚴格平面的
 * `global`／`presence`／`shard-*` 政策完全相同、從 storage 裡的其他鍵分不出來；休眠喚醒後可能
 * 沒有 fetch、算不出路徑。DO 名由 `idFromName` 決定、一輩子不變，存下來不會過時。
 */
const DO_NAME_KEY = "cinder:do-name";
/**
 * 持有 RelayCore；以**休眠式 WebSocket**（ADR-0059）收發：DO 可在訊息間休眠、不計 idle
 * duration。休眠會清空記憶體，故每連線的訂閱/認證狀態存在其 WebSocket 的 attachment
 *（放不下 16KB 的大訂閱溢位到 DO SQLite，Cinderous ADR-0373），喚醒時據此重建 RelayCore。
 */
export class RelayRoom {
    ctx;
    env;
    /** DO 內建 SQLite 的同步執行器；政策確定後要用它重建 store（ADR-0366 P1 #7）。 */
    exec;
    core;
    store;
    /** 每連線狀態的休眠持久化：attachment ＋溢位表（Cinderous ADR-0373）。 */
    conns;
    /** 本次喚醒是否已從 attachment 重建 RelayCore 狀態。 */
    hydrated = false;
    /** 本 DO 實例綁定的政策；由路由方在首次請求時釘住（ADR-0366）。 */
    profile = "strict";
    /** 政策是否已寫進 storage（釘住後不得再改，見 `fetch`）。 */
    profilePinned = false;
    /** 本 DO 服務的是名單上的已知租戶嗎（ADR-0366 §裁示）；預設否＝公用配額。 */
    knownLane = false;
    /** 本 DO 服務的名單上車道 id（Cinderous ADR-0371）；嚴格平面與共用分片為 undefined。 */
    laneId;
    /** 本實例的 DO 名（Cinderous ADR-0377）；決定天花板與容量政策。第一次 fetch 之前（與升級前的 DO）為 undefined＝預設天花板。 */
    doName;
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        // 離線留言持久化於 DO 內建 SQLite（同步、免 D1；ADR-0056）——storage 跨休眠存活。
        const sql = ctx.storage.sql;
        const exec = (query, ...bindings) => sql.exec(query, ...bindings).toArray();
        this.exec = exec;
        this.store = new SqlMessageStore(exec, { ...storeOptions(env.MAX_TTL_DAYS), sizeUpperBound: () => sql.databaseSize });
        this.conns = new ConnPersistence(exec);
        // 先以嚴格政策組起來：休眠喚醒後可能**沒有 fetch**（`webSocketMessage` 直接進來），
        // 那時還沒讀到 storage，預設必須是**收得最緊**的那一邊。
        this.core = this.buildCore("strict");
        // FILE_LANES 裡不在 APP_LANES 上的 id 會被忽略（Cinderous ADR-0371）——設錯要看得見，不是默默不生效。
        const ignored = fileLanes(env).ignored;
        if (ignored.length > 0) {
            console.warn(`FILE_LANES 忽略不在 APP_LANES 上的車道：${ignored.join(", ")}（Cinderous ADR-0371）`);
        }
        // 容量設定錯的項目不生效、退回較大的預設值或關閉（Cinderous ADR-0377；SDK ADR 0042）——一樣要看得見。
        // 僅限車道卻沒有任何車道＝整座站什麼都連不上（SDK ADR 0051）
        if (lanesOnlyFrom(env.LANES_ONLY) && knownLanes(env.APP_LANES).size === 0) {
            console.warn("LANES_ONLY 開著但 APP_LANES 是空的：這座站拒絕所有連線（SDK ADR 0051）");
        }
        // 唯讀寬限期寫錯的項目（SDK ADR 0052）：🔴 訊息只有第幾項與原因，不印車道 id（它是秘密）
        const badReadOnly = readOnlyLanesFrom(env.READONLY_LANES).ignored;
        if (badReadOnly.length > 0) {
            console.warn(`READONLY_LANES 忽略無效的項目：${badReadOnly.join("；")}（SDK ADR 0052）`);
        }
        const badCapacity = doCapacitySettings(env).ignored;
        if (badCapacity.length > 0) {
            console.warn(`容量設定忽略無效的項目：${badCapacity.join(", ")}（SDK ADR 0042）`);
        }
        ctx.blockConcurrencyWhile(async () => {
            // 還原本實例綁定的政策（ADR-0366）。DO 名與政策是一對一的，所以這裡讀到什麼就是什麼。
            const stored = await ctx.storage.get(PROFILE_KEY);
            this.knownLane = (await ctx.storage.get(KNOWN_LANE_KEY)) === true;
            this.laneId = await ctx.storage.get(LANE_ID_KEY);
            this.doName = await ctx.storage.get(DO_NAME_KEY);
            if (stored !== undefined) {
                this.profile = stored;
                this.profilePinned = true;
                // 知道 DO 名＝天花板可能不是預設值（Cinderous ADR-0377），嚴格平面也要重組。
                if (stored !== "strict" || this.doName !== undefined) {
                    this.core = this.buildCore(stored);
                    this.hydrated = false; // 新的 core 要重新從 attachment 還原既有連線
                }
            }
            // C2：排程 NIP-40 過期清理（DO 休眠仍會被 alarm 喚醒執行）。
            if ((await ctx.storage.getAlarm()) === null) {
                await ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
            }
        });
    }
    /**
     * 以指定政策組 `RelayCore`。濫用防護由 `host-config` 統一供應（ADR-0235 H1）——
     * 與 `node-relay.ts` 用同一組常數，兩座宿主不可能各走各的。
     */
    buildCore(profile) {
        // store 與 core 必須用**同一個** profile 組起來——拆開就會出現
        // 「core 是車道、store 還套著嚴格配額」這種只在第 6 份牌組才看得出來的錯。
        // 檔案政策（Cinderous ADR-0371）：與 NIP-11 同一個函式。只有名單上的車道 DO 帶得出 laneId。
        const files = filePolicyFor(this.env, profile === "app" && this.knownLane ? this.laneId : undefined);
        const storeOpts = storeOptions(this.env.MAX_TTL_DAYS, profile, this.knownLane, files.accept ? files.maxFileMb : undefined, 
        // 每顆 DO 的容量政策（Cinderous ADR-0377；SDK ADR 0042）：與預算加總、NIP-11 用的是同一個函式。
        this.doName !== undefined ? doCapacityFor(this.env, this.doName) : undefined);
        // 資料庫大小當用量的上界（SDK ADR 0126）：喚醒後第一次寫入不必 SUM 整張表就知道放得下
        this.store = new SqlMessageStore(this.exec, { ...storeOpts, sizeUpperBound: () => this.ctx.storage.sql.databaseSize });
        const pow = powForLane(profile, this.env.APP_LANE_POW);
        // 白名單不分政策：車道也要擋，否則私人站換個 `/app/` 路徑就被繞過（SDK ADR 0008）。
        const allowed = allowedPubkeysFrom(this.env.ALLOWED_PUBKEYS);
        const maxConnections = connectionsPerPubkeyFrom(this.env.MAX_CONNECTIONS_PER_PUBKEY);
        const perIp = messagesPerSecondPerIpFrom(this.env.MAX_MESSAGES_PER_SECOND_PER_IP);
        return new RelayCore({
            store: this.store,
            ...guardFor(profile),
            // 唯讀寬限期（SDK ADR 0052）：這顆 DO 服務的舊路徑在寬限期內只能讀。env 在部署之間不變，
            // 「唯讀 → 到期」由 `webSocketMessage` 的到期檢查處理（關掉連線），不必重組 core。
            ...(this.laneReadOnly(profile) ? { readOnly: true } : {}),
            ...(allowed ? { allowedAuthors: allowed } : {}),
            ...(maxConnections !== undefined ? { maxConnectionsPerPubkey: maxConnections } : {}),
            ...(perIp !== undefined ? { maxMessagesPerSecondPerIp: perIp } : {}),
            ...(pow > 0 ? { minPowDifficulty: pow } : {}),
            ...(files.accept ? { acceptFileEvents: true } : {}),
            // 收件確認（SDK ADR 0067）：與 NIP-11 宣告的 `grace_sec` 同一個函式
            inboxAckGraceSec: inboxAckGraceFor(storeOpts),
            // 處理到一半撞到每日讀寫列數上限（SDK ADR 0127）：說清楚、以 1013 關閉，不回 error: internal
            isStorageExhausted: (error) => doFailureKind(error) === "over-quota",
        });
    }
    /** 沒認證就斷線的診斷（SDK ADR 0111）：`DIAG_UNAUTH_LOG=1` 才有，否則 null */
    #unauthDiag;
    unauthDiag() {
        if (this.#unauthDiag === undefined)
            this.#unauthDiag = unauthDiagEnabled(this.env.DIAG_UNAUTH_LOG) ? new UnauthDiag() : null;
        return this.#unauthDiag;
    }
    /** 反覆重連限速（SDK ADR 0111）：第一次用到才依 `RECONNECT_GUARD` 建立；`off` 時為 null */
    #reconnectGuard;
    reconnectGuard() {
        if (this.#reconnectGuard === undefined) {
            const config = reconnectGuardFrom(this.env.RECONNECT_GUARD);
            this.#reconnectGuard = config ? new ReconnectGuard(config) : null;
        }
        return this.#reconnectGuard;
    }
    /** DO 定時鬧鐘（C2）：清除已過期留言並重排下一次。 */
    async alarm() {
        // 順手還原＋清孤兒溢位列（Cinderous ADR-0373）：部署重啟時 `webSocketClose` 不保證會跑，
        // 之後若再也沒有連線進來，孤兒列只有這裡清得到。
        this.dispatch(this.ensureHydrated());
        this.store.prune(Math.floor(Date.now() / 1000));
        await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
    async fetch(request) {
        // 政策由**本次請求的路徑**決定，用的是與 worker 路由同一個 `routeForPath`（SSOT）。
        // 認不得的路徑在 worker 就被擋掉了（ADR-0368，不碰 DO）；真的漏進來就當嚴格（fail-closed）。
        const route = routeOf(new URL(request.url).pathname, this.env);
        const wanted = route?.profile ?? "strict";
        // 主平面的反覆重連限速（SDK ADR 0111）：在 acceptWebSocket 與任何儲存寫入之前回絕——只花這一次 DO 請求
        const clientIp = request.headers.get("CF-Connecting-IP");
        const guard = this.reconnectGuard();
        if (wanted !== "app" && clientIp && guard && !guard.admit(clientIp)) {
            return rejectUpgrade("reconnect-limited", hostOf(request) ?? new URL(request.url).host, this.env);
        }
        // 已知租戶有自己的 DO（`app:<id>`），所以這個旗標對一顆 DO 而言是恆定的；
        // 第一次請求時釘住，與政策同一個時機。
        const wantedKnown = route?.profile === "app" && route.known;
        // 名單上車道的 id（Cinderous ADR-0371）。DO 名就是 `app:<id>`，所以它對一顆 DO 而言也是恆定的。
        const wantedLaneId = route?.profile === "app" && route.known ? route.laneId : undefined;
        // DO 名（Cinderous ADR-0377）：worker 就是用這個名字 `idFromName` 到這裡的，一輩子不變。
        // 升級前就存在的 DO 沒有這個鍵——第一次連線補記，並在下面換成它自己的天花板。
        // 先同步設好（不 await），下面第一次釘住政策時組的 core 就已經用上自己的天花板。
        const newName = route !== undefined && route.doName !== this.doName ? route.doName : undefined;
        if (newName !== undefined)
            this.doName = newName;
        const wasPinned = this.profilePinned;
        if (this.profilePinned &&
            wanted === this.profile &&
            wantedKnown === this.knownLane &&
            this.laneId === undefined &&
            wantedLaneId !== undefined) {
            // 升級前就釘住的 DO：storage 裡還沒有車道 id。補記即可，不是政策衝突。
            this.laneId = wantedLaneId;
            await this.ctx.storage.put(LANE_ID_KEY, wantedLaneId);
            this.core = this.buildCore(this.profile);
            this.hydrated = false; // 新的 core 要重新從 attachment 還原既有連線
        }
        if (wanted !== this.profile ||
            !this.profilePinned ||
            wantedKnown !== this.knownLane ||
            wantedLaneId !== this.laneId) {
            // 🔴 一顆 DO 只服務一種政策。釘住之後還收到不同政策的請求，代表路由壞了
            // （或有人在試）——**拒絕，不要切換**。切換等於讓同一份儲存被兩套規則讀寫過。
            if (this.profilePinned)
                return new Response("lane profile mismatch", { status: 409 });
            this.knownLane = wantedKnown;
            this.laneId = wantedLaneId;
            if (wanted !== this.profile) {
                this.profile = wanted;
            }
            // 配額也會變，所以 core 與 store 一起重組（兩者必須同一組設定）。
            this.core = this.buildCore(wanted);
            await this.ctx.storage.put(PROFILE_KEY, wanted);
            await this.ctx.storage.put(KNOWN_LANE_KEY, wantedKnown);
            if (wantedLaneId !== undefined)
                await this.ctx.storage.put(LANE_ID_KEY, wantedLaneId);
            this.profilePinned = true;
        }
        if (newName !== undefined) {
            await this.ctx.storage.put(DO_NAME_KEY, newName);
            if (wasPinned) {
                // 升級前就釘住的 DO：天花板換成它自己的（Cinderous ADR-0377）。與補記車道 id 同一個做法，
                // 重組後從 attachment 還原既有連線。（第一次釘住的 DO 在上面組 core 時已經用上了。）
                this.core = this.buildCore(this.profile);
                this.hydrated = false;
            }
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const connId = crypto.randomUUID();
        // 休眠式接受：以 connId 為 tag 供路由；DO 於訊息間可休眠（ADR-0059）。
        this.ctx.acceptWebSocket(server, [connId]);
        const restored = this.ensureHydrated();
        // 本次請求打到的主機（ADR-0235 H2）：AUTH 的 `relay` tag 必須指向它。取自 request 而非
        // 設定檔——同一份 Worker 可能同時服務 workers.dev 與自訂網域，寫死任一個都會誤擋另一個。
        const relayHost = hostOf(request);
        // IP 只用在每 IP 速率限制；CF-Connecting-IP 由 Cloudflare 填寫，客戶端偽造不了
        const out = this.core.connect(connId, relayHost, clientIp ?? undefined); // 產生 NIP-42 AUTH 挑戰
        if (wanted !== "app")
            this.unauthDiag()?.open(connId);
        const unsaved = this.persist(server, connId); // 存回 attachment（含挑戰），休眠後可還原
        this.dispatch([...restored, ...out, ...unsaved]);
        return new Response(null, { status: 101, webSocket: client });
    }
    /** 這顆 DO 服務的車道現在是不是在唯讀寬限期（SDK ADR 0052） */
    laneReadOnly(profile = this.profile) {
        return profile === "app" && this.knownLane && this.laneId !== undefined && laneStateOf(this.env, this.laneId, nowSec()) === "read-only";
    }
    /** 唯讀寬限期已過（SDK ADR 0052）：這顆 DO 的車道列在 `READONLY_LANES` 但到期了 */
    laneExpired() {
        return this.profile === "app" && this.laneId !== undefined && laneStateOf(this.env, this.laneId, nowSec()) === "expired";
    }
    webSocketMessage(ws, message) {
        try {
            this.handleMessage(ws, message);
        }
        catch (error) {
            // core 之外（喚醒還原、存訂閱）撞到每日讀寫列數上限（SDK ADR 0127）：跟 core 裡撞到的同一個回覆。
            // 其他錯誤照舊拋出（平台記錄、連線由平台處理）——不把一般錯誤說成額度用完。
            const connId = connIdOf(ws);
            if (!connId || doFailureKind(error) !== "over-quota")
                throw error;
            const raw = typeof message === "string" ? message : "";
            try {
                this.forget(connId); // 記憶體裡的狀態；溢位列刪不掉時 remove 自己吞掉
            }
            catch {
                /* 還原到一半 */
            }
            for (const { message: m, close } of storageExhausted(connId, raw)) {
                try {
                    ws.send(JSON.stringify(m));
                    if (close) {
                        const { code, reason } = closeSignalOf(close);
                        ws.close(code, reason);
                    }
                }
                catch {
                    /* 已關閉 */
                }
            }
        }
    }
    handleMessage(ws, message) {
        const restored = this.ensureHydrated();
        const connId = connIdOf(ws);
        if (!connId)
            return this.dispatch(restored);
        if (this.laneExpired()) {
            // 寬限期在連線期間過了（SDK ADR 0052）：與認不得的路徑同一個拒絕（ADR-0368 的 NOTICE＋1008），不處理這則訊息
            const host = this.core.exportConn(connId)?.relayHost ?? "localhost";
            const { notice, reason } = upgradeRejection("unknown-path", host, this.env.DEVELOPER_DOCS_URL);
            this.dispatch(restored);
            this.forget(connId);
            try {
                ws.send(JSON.stringify(["NOTICE", notice]));
                ws.close(UPGRADE_REJECT_CLOSE_CODE, reason);
            }
            catch {
                /* 已關閉 */
            }
            return;
        }
        const raw = typeof message === "string" ? message : "";
        const diag = this.unauthDiag();
        diag?.inbound(connId, raw);
        const out = this.core.handle(connId, raw);
        if (diag) {
            for (const o of out)
                if (o.to === connId)
                    diag.outbound(connId, o.message);
            if (this.core.isAuthenticated(connId))
                diag.authed(connId);
        }
        const unsaved = this.persist(ws, connId); // 訂閱/認證可能已變，更新 attachment（沒變則零寫入）
        // 存不住的訂閱已被關掉：它的 EVENT/EOSE 不送，只送 CLOSED（說明原因）。
        const closed = new Set(unsaved.map((o) => o.message[1]));
        const kept = closed.size === 0 ? out : out.filter((o) => !isSubReply(o, connId, closed));
        this.dispatch([...restored, ...kept, ...unsaved]);
    }
    webSocketClose(ws, code) {
        const restored = this.ensureHydrated();
        const connId = connIdOf(ws);
        if (connId) {
            const line = this.unauthDiag()?.close(connId, code);
            if (line)
                console.log(line);
            this.forget(connId);
        }
        try {
            ws.close();
        }
        catch {
            /* 已關閉 */
        }
        this.dispatch(restored);
    }
    webSocketError(ws) {
        // 先還原（Cinderous ADR-0373）：休眠後才斷線時，要先讀回 attachment 才知道有哪些溢位列要刪。
        const restored = this.ensureHydrated();
        const connId = connIdOf(ws);
        if (connId) {
            const line = this.unauthDiag()?.close(connId, undefined);
            if (line)
                console.log(line);
            this.forget(connId);
        }
        this.dispatch(restored);
    }
    /** 連線結束：記憶體與溢位列一起清（Cinderous ADR-0373）。 */
    forget(connId) {
        this.core.disconnect(connId);
        this.conns.remove(connId);
    }
    /**
     * 休眠喚醒後，從所有存活 WebSocket 的 attachment（＋溢位表）重建 RelayCore 狀態（ADR-0059；Cinderous ADR-0373）。
     *
     * 回傳要送出的 `CLOSED`：attachment 記著、storage 卻找不到的訂閱**不能假裝還在**——
     * 告訴客戶端，它才會重訂。
     */
    ensureHydrated() {
        if (this.hydrated)
            return [];
        this.hydrated = true;
        const { snapshots, lost } = this.conns.load(this.ctx.getWebSockets());
        for (const snap of snapshots)
            this.core.rehydrate(snap);
        if (lost.length === 0)
            return [];
        console.warn(`喚醒還原：${lost.length} 條溢位訂閱遺失，已通知客戶端重訂（Cinderous ADR-0373）`);
        const out = lost.map(({ connId, subId }) => ({ to: connId, message: ["CLOSED", subId, CLOSED_LOST] }));
        // 立刻把那些連線的 attachment 更正過來（不再指著不存在的列），不等它下一則訊息。
        for (const connId of new Set(lost.map((l) => l.connId))) {
            const [ws] = this.ctx.getWebSockets(connId);
            if (ws)
                out.push(...this.persist(ws, connId));
        }
        return out;
    }
    /**
     * 把連線狀態存起來（Cinderous ADR-0373）。存不住的訂閱**關掉並回 `CLOSED`**——絕不靜默：
     * 留在記憶體裡的話它看起來能用，DO 休眠一次就無聲消失。
     */
    persist(ws, connId) {
        const first = this.conns.save(ws, this.core.exportConn(connId));
        if (first.rejected.length === 0)
            return [];
        for (const r of first.rejected)
            this.core.dropSubscription(connId, r.subId);
        // 再存一次，讓 attachment／溢位表與關掉之後的狀態一致。
        const second = this.conns.save(ws, this.core.exportConn(connId));
        for (const r of second.rejected)
            this.core.dropSubscription(connId, r.subId);
        const rejected = [...first.rejected, ...second.rejected];
        console.warn(`關閉無法持久化的訂閱 conn=${connId}：${rejected.map((r) => `${r.subId}(${r.reason})`).join(", ")}（Cinderous ADR-0373）`);
        return rejected.map((r) => ({ to: connId, message: ["CLOSED", r.subId, closedReason(r.reason)] }));
    }
    dispatch(outbound) {
        for (const { to, message, close } of outbound) {
            const [ws] = this.ctx.getWebSockets(to); // 以 connId tag 找回該連線
            ws?.send(JSON.stringify(message));
            if (!close)
                continue;
            // 超限即關（ADR-0366 §容量）：訊息一旦抵達那次請求就已經付掉了，只回一則
            // NOTICE 擋不住成本。關掉之後要回來就得重新升級，而那一關有 IP 限速。
            this.forget(to); // 伺服端主動關閉不保證會觸發 webSocketClose（溢位列一起清，Cinderous ADR-0373）
            const { code, reason } = closeSignalOf(close);
            try {
                ws?.close(code, reason);
            }
            catch {
                /* 已關閉 */
            }
        }
    }
}
/**
 * 喚醒時找不到溢位列的訂閱（Cinderous ADR-0373）。客戶端應重送 REQ。
 * 線路上的字串與 Cinderous 逐字相同（括號內是 Cinderous 的 ADR 編號）：PR #9 之後錨點改跑本檔，客戶端看到的不能變。
 */
const CLOSED_LOST = "error: resubscribe: subscription was lost when the relay restarted; please resubscribe (ADR-0373)";
/**
 * 無法持久化時回給客戶端的 `CLOSED` 原因（Cinderous ADR-0373）。前綴依 NIP-01 的機器可讀慣例，
 * 後面接詞元（SDK ADR 0038 P0-R2）：`resubscribe`＝重訂有用，客戶端會自動重訂；`too-large`＝重訂也一樣，不重訂。
 */
function closedReason(reason) {
    return reason === "too-large"
        ? `invalid: too-large: subscriptions on this connection exceed ${MAX_CONN_SUB_BYTES / 1024} KiB and cannot be kept across relay hibernation (ADR-0373)`
        : "error: resubscribe: subscription could not be saved on the relay; please resubscribe (ADR-0373)";
}
/** 這則是不是某連線上、某些訂閱的 EVENT/EOSE 回覆。 */
function isSubReply(o, connId, subIds) {
    const kind = o.message[0];
    return o.to === connId && (kind === "EVENT" || kind === "EOSE") && subIds.has(o.message[1]);
}
/** 從 WebSocket 的 attachment 取回其 connId。 */
function connIdOf(ws) {
    const snap = ws.deserializeAttachment();
    return snap?.connId;
}
/** 本次請求的主機（含 port）；優先取 `Host` 標頭，退回 URL。解析失敗回 undefined＝不強制。 */
function hostOf(request) {
    const header = firstHost(request.headers.get("Host") ?? undefined);
    if (header)
        return header;
    try {
        return new URL(request.url).host.toLowerCase() || undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=worker.js.map