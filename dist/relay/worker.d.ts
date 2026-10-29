import { type RelayProfile } from "./host-config.js";
import { type RejectKind } from "./reject-messages.js";
import { type IotHomeEnv } from "./iot-home-room.js";
export { IotHomeRoom } from "./iot-home-room.js";
export interface Env extends IotHomeEnv {
    RELAY_ROOM: DurableObjectNamespace;
    /**
     * 統一節點（ADR-0354，**選配**）：Workers Static Assets 綁定。設定了就代表這座 Worker
     * 同時是 relay 與網頁版（同一個網址、`wss://` 與 `https://` 分流）；**未綁定＝純 relay、
     * 行為與過去完全相同**（官方錨點站即為此模式）。以 `wrangler --env unified` 部署時才有。
     *
     * 🔴 wrangler 端**必須**同時設 `run_worker_first = true`：Static Assets 預設「資產優先」——
     * 命中資產就直接回傳、**根本不執行本 Worker**，而 `/` 有 `index.html`、又正是 ADR-0241
     * 舊客戶端的 WebSocket 回退路徑 ⇒ 不設就等於把 relay 靜默關掉（回 HTML 200，不是錯誤）。
     */
    ASSETS?: {
        fetch: (request: Request) => Response | Promise<Response>;
    };
    /**
     * 離線留言 TTL 上限（天，ADR-0160）：企業自架站以 wrangler var 放寬（例 "90"）。
     * 未設/壞值＝預設 7 天。發送端蓋超過此上限的過期章會被截斷——站方上限恆為權威。
     */
    MAX_TTL_DAYS?: string;
    /**
     * 接受檔案塊事件（ADR-0162）：≥1 才收 FILE_WRAP(1060)；未設＝整類拒收（公共站預設）。
     * 沒設 `FILE_LANES` 時只是**全站**開關（企業自架；實際上限由名冊政策 relayFilesMaxMb ≤16 控制）；
     * 設了 `FILE_LANES` 時改當那幾條車道的**單檔上限**（MB，Cinderous ADR-0371）。
     */
    MAX_FILE_MB?: string;
    /**
     * 只在這幾條車道收檔案塊（逗號分隔的車道 id；Cinderous ADR-0371）。
     *
     * 🔴 **設了就是車道模式**：Cinderous 主訊息平面（`/`、`/s/<n>`、`/presence`）、共用分片與
     * 其他車道一律整類拒收 1060；列在這裡的車道還必須**同時在 `APP_LANES` 上**（有自己的 DO），
     * 不在的會被忽略。沒設＝與過去完全相同（`MAX_FILE_MB` 是全站開關）。
     */
    FILE_LANES?: string;
    /**
     * 第三方車道的 NIP-13 PoW 難度（ADR-0366 P2 #11）。未設＝0（不要求）。
     *
     * 🔴 打開之前**必須先確認該車道的客戶端會挖礦**（core 的 `minePow`）——否則它們的
     * 持久化事件會全部被拒，而客戶端那邊看到的只是 `OK false`。嚴格平面不受此變數影響
     * （恆為 0，見 `host-config.powForLane`）。
     */
    APP_LANE_POW?: string;
    /**
     * 站方的**已知租戶名單**（逗號分隔的車道 id；ADR-0366 §裁示）。
     *
     * 🔴 **不是白名單**：沒列的車道照常服務——錨點同時是公用 relay。名單決定的是
     * 「這條車道有沒有自己的 DO」，因而決定它的可尋址配額（列了 64、沒列 16）。
     * 未設＝沒有已知租戶，所有車道共用雜湊分片。
     *
     * ⚠ 加進來或拿掉＝換一顆 DO，該車道舊 DO 裡的資料不會跟著搬（等 TTL 到期）。
     */
    APP_LANES?: string;
    /**
     * 僅限車道（SDK ADR 0051）：`1`／`true` 才開。開了就**只接受 `APP_LANES` 上的車道**——主平面
     * （`/`、`/s/<n>`、`/presence`）、沒列的車道與其他路徑的 WebSocket 一律以一般的「認不得的路徑」拒絕，
     * NIP-11 對它們回 404（內容與猜錯車道相同）。給「開放寫入＋不可猜的隨機路徑」的個人專屬中繼：
     * 路徑本身就是門票。未設＝與過去完全相同。
     */
    LANES_ONLY?: string;
    /**
     * 唯讀寬限期（SDK ADR 0052）：`<車道 id>@<到期 unix 秒>`，逗號分隔。換了私人路徑之後的舊路徑：到期前連得上、讀得到
     * （REQ、AUTH），寫入一律 `OK false "restricted: read-only: …"`；到期後與認不得的路徑相同（`LANES_ONLY` 時 `unknown-path`），
     * 還開著的連線在下一則訊息時關掉。到期由中繼自己判斷，不需要再部署。同時在 `APP_LANES` 上的以 `APP_LANES` 為準。
     * 舊車道那顆 DO 的資料原地保留（車道模式下沿用檔案車道的儲存設定），等各自的 TTL 到期。未設＝與過去完全相同。
     */
    READONLY_LANES?: string;
    /**
     * 每顆 DO 的容量天花板（Cinderous ADR-0377；SDK ADR 0042 移植）：`<對象>=<離線 MiB>/<可尋址 MiB>`，逗號分隔。
     * 對象是類別（`strict`／`public`／`lane`／`file`）或單顆 DO 名（`global`、`shard-a`、`app-3`、`app:dochost`），單顆優先。
     * **未設＝與過去完全相同**（每顆 128/128 MiB、檔案車道離線 1 GiB）。設錯的項目不生效、啟動時 `console.warn`。
     * 所有可能 DO 的加總用 `computeCeilingBudget(vars)` 守（Cloudflare 免費方案：帳號 5 GB）。
     */
    DO_CEILINGS_MIB?: string;
    /**
     * 保底份額（SDK ADR 0042；ADR 0038 P2）：`<對象>=<KiB>`。共用 DO 內每位作者（可尋址）／每位收件人（離線）的保底，
     * 保底內的資料不會被別人擠掉；只在淘汰制（車道）生效。**未設＝沒有保底**（v0.33 行為）。
     */
    DO_GUARANTEE_KIB?: string;
    /**
     * 溢位帶（SDK ADR 0042；ADR 0039 B1）：`<對象>=<天花板的百分比>`。天花板之上再收這麼多的「借用」，保存 2 小時、最先被淘汰，
     * 回 `OK true "warning: borrowed: …"`。嚴格平面的可尋址不借用；車道要同時設保底才生效。**未設＝沒有溢位帶**。
     */
    DO_BORROW_PERCENT?: string;
    /** 粗分級預警（SDK ADR 0042）：`<對象>=<百分比>`；寫入後用量達這一級（或 95％）以上時 `OK true` 帶 `warning: near-full:`。未設＝不預警。 */
    DO_NEAR_FULL_PERCENT?: string;
    /** 丟棄計數（SDK ADR 0042）：開啟的對象（逗號分隔）。收件人讀收件匣時收到 `NOTICE "warning: dropped: …"`。未設＝不計。 */
    DO_DROP_NOTICES?: string;
    /**
     * 白名單（SDK ADR 0008；PRD 5.3 `--allowed-pubkeys`）：逗號分隔的 `npub` 或 hex。
     * 設了就**只有名單上的人能寫入**，所有路徑（含 `/app/` 車道）一體適用；沒設＝開放中繼（錨點站即此模式）。
     * 寫錯任何一筆，這座站會直接出錯而不是默默開放（見 `host-config.allowedPubkeysFrom`）。
     */
    ALLOWED_PUBKEYS?: string;
    /**
     * 同一把公鑰最多幾條連線、同一個 IP 每秒最多幾則訊息（PRD 3.3；SDK ADR 0013）。
     * 沒設＝不限（Cinderous 錨點不設）；`cinderous relay deploy` 預設寫入 5 與 20。
     * ⚠ 在 Worker 上是**每顆 DO 各自計算**：同一個人連到不同分片不會合併計數。
     */
    MAX_CONNECTIONS_PER_PUBKEY?: string;
    MAX_MESSAGES_PER_SECOND_PER_IP?: string;
    /**
     * 連線被拒時指向的開發文件網址（ADR-0368）。**未設＝不附網址**（SDK ADR 0019）：
     * SDK 不替別人的站決定文件在哪。Cinderous 的錨點在自己的 wrangler.toml 設成官網開發者頁。
     */
    DEVELOPER_DOCS_URL?: string;
    /**
     * 公共 TURN 保底（ADR-0243）：Cloudflare TURN 的 Key ID。與 `TURN_API_TOKEN` 一起設定後，
     * `GET /turn` 會向 Cloudflare 換發**短期**憑證回給客戶端（餵進 `buildRtcConfig` 的 turnServers）。
     * **未設＝端點回 204，客戶端退回純 STUN**（no-op，不影響既有部署）。
     */
    TURN_KEY_ID?: string;
    /** 公共 TURN 保底（ADR-0243）：Cloudflare TURN 的 API Token（secret，以 `wrangler secret put` 放）。 */
    TURN_API_TOKEN?: string;
    /** 短期 TURN 憑證有效秒數（ADR-0243）；未設/壞值＝預設 86400（1 天）。客戶端於半 TTL 前刷新。 */
    TURN_TTL_SECONDS?: string;
    /**
     * 取得速率限制（ADR-0342 §3.1）：以 pubkey 計數，超過即 429。
     * **未綁定＝不限速**（本地開發與測試無此 binding，不該因此壞掉）。
     *
     * ⚠ Cloudflare 明說它 **per-location 計數且最終一致、刻意寬鬆**——
     * 它是成本乘數，不是閘門。
     */
    TURN_LIMIT?: {
        limit(opts: {
            key: string;
        }): Promise<{
            success: boolean;
        }>;
    };
    /**
     * 第三方車道的**升級**速率限制（ADR-0366 §容量）：以 **IP** 計數，超過即 429，
     * 而且在碰到 DO 之前就擋掉。**未綁定＝不限速**（本地開發與自架站無此 binding）。
     *
     * 🔴 為什麼是 IP 而不是 pubkey：車道不要求 AUTH，pubkey 由發送方自選、換一把是
     * 微秒級的事（ADR-0342 §3.1 同一個結論）。要限速就得綁比較貴的東西。
     *
     * 🔴 為什麼只擋升級不夠、要和 `maxMessagesPerMinute` 一起看：一條已經建立的連線
     * 可以持續灌訊息而完全不需要再升級。核心那一道超限就關連線，關了要回來就得再升級
     * ——兩道接起來，每個 IP 的**持續**成本才是有界的。
     *
     * ⚠ 嚴格平面不套這一道：那裡是本專案自己的使用者、且要求 NIP-42，而行動網路的
     * 共用 IP 會讓一整群人共用同一個桶。主平面另有一道比較寬的（`STRICT_UPGRADE_LIMIT`，SDK ADR 0111）。
     */
    APP_LANE_LIMIT?: {
        limit(opts: {
            key: string;
        }): Promise<{
            success: boolean;
        }>;
    };
    /**
     * 主平面的升級限速（SDK ADR 0111；Cinderous ADR-0391）：以「IP＋DO 名」計數（主平面分 16 片，同一個共用 IP 後面的人
     * 分散在不同的桶），在碰 DO 之前擋掉。**未綁定＝不限速**。Cloudflare 只支援 10／60 秒窗口，擋不住慢速重連——
     * 長窗口那道在 DO 裡（`RECONNECT_GUARD`）。
     */
    STRICT_UPGRADE_LIMIT?: {
        limit(opts: {
            key: string;
        }): Promise<{
            success: boolean;
        }>;
    };
    /**
     * 主平面 DO 的反覆重連限速（SDK ADR 0111）：`次數/窗口秒/封鎖秒`（預設 `20/600/600`），`off`＝關掉。
     * 只在記憶體計數、不寫儲存。
     */
    RECONNECT_GUARD?: string;
    /**
     * 診斷「沒認證就斷線」的主平面連線（SDK ADR 0111；Cinderous ADR-0392）：`1`＝每條印一行摘要到 console
     * （動詞、kind、回覆、存活秒數、關閉碼；不記內容、公鑰、IP）。**預設關閉**；只在要查的時候開，看完關掉。
     */
    DIAG_UNAUTH_LOG?: string;
    /** 站名／描述／營運者公鑰（hex）／聯絡方式；未設＝該欄不出現在文件裡。 */
    RELAY_NAME?: string;
    RELAY_DESCRIPTION?: string;
    RELAY_PUBKEY?: string;
    RELAY_CONTACT?: string;
    /**
     * NIP-11 `software`（SDK ADR 0050）：這座站跑的程式的原始碼網址。**未設＝SDK 的 repo**（ADR 0019）。
     * 改過中繼程式再對外服務的人，把它指向修改後的原始碼（AGPL §13）。
     */
    RELAY_SOFTWARE_URL?: string;
    /** 營運者自報的贊助管道（ADR-0089）；**全部未設＝文件無 `cinder_donations`＝客戶端不顯示贊助卡**。 */
    DONATE_GITHUB_SPONSORS?: string;
    DONATE_BUY_ME_A_COFFEE?: string;
    DONATE_LIBERAPAY?: string;
    DONATE_LIGHTNING?: string;
    /** 節點自報（ADR-0092）：已簽章的 `CinderNodeDeclaration` 事件 JSON 字串。 */
    NODE_ATTESTATION?: string;
}
/** CORS 預檢回應。 */
export declare function turnPreflightResponse(): Response;
/**
 * `GET /turn`（ADR-0243）：以站方 secret 向 Cloudflare 換發**短期** TURN 憑證回給客戶端。
 * 未配 `TURN_KEY_ID`/`TURN_API_TOKEN` → **204**（客戶端 no-op、退回純 STUN）；Cloudflare 故障
 * 亦回 204（保底抓不到不該讓客戶端報錯）。憑證短期＋Cloudflare 端用量上限＝ADR-0243 的「有上限」。
 */
export declare function mintTurnResponse(env: Env, request: Request, fetchFn?: typeof fetch): Promise<Response>;
/**
 * 由 Worker 環境變數組出 NIP-11 文件（ADR-0260）。
 *
 * `authRequired: true` 是**寫死**的——worker 的 `RelayCore` 就是 `requireAuth: true`
 * （見 `RelayRoom` 建構子），拿一個獨立的旗標去描述它遲早會說謊。
 */
export declare function relayInfoFrom(env: Env, profile?: RelayProfile, 
/** 本路徑是不是名單上的已知租戶（ADR-0366 §裁示）：公用分片的保存期短得多（ADR-0367）。 */
knownLane?: boolean, 
/** 名單上車道的 id（Cinderous ADR-0371）：決定這條路徑收不收檔案、單檔上限多少。 */
laneId?: string, 
/** 這條路徑的 DO 名（SDK ADR 0042）：決定天花板與容量政策；沒給＝預設天花板、沒有保底與溢位帶。 */
doName?: string): Record<string, unknown>;
export type { RejectKind } from "./reject-messages.js";
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
export declare function doFailureKind(error: unknown): "over-quota" | "unavailable";
export declare function rejectUpgrade(kind: RejectKind, host: string, env: Pick<Env, "DEVELOPER_DOCS_URL">): Response;
/** Worker 進入點：WebSocket 升級後交給單一 Durable Object 房間以共享連線狀態。 */
declare const _default: {
    fetch(request: Request, env: Env): Promise<Response>;
};
export default _default;
/**
 * 持有 RelayCore；以**休眠式 WebSocket**（ADR-0059）收發：DO 可在訊息間休眠、不計 idle
 * duration。休眠會清空記憶體，故每連線的訂閱/認證狀態存在其 WebSocket 的 attachment
 *（放不下 16KB 的大訂閱溢位到 DO SQLite，Cinderous ADR-0373），喚醒時據此重建 RelayCore。
 */
export declare class RelayRoom {
    #private;
    private readonly ctx;
    private readonly env;
    /** DO 內建 SQLite 的同步執行器；政策確定後要用它重建 store（ADR-0366 P1 #7）。 */
    private readonly exec;
    private core;
    private store;
    /** 每連線狀態的休眠持久化：attachment ＋溢位表（Cinderous ADR-0373）。 */
    private readonly conns;
    /** 本次喚醒是否已從 attachment 重建 RelayCore 狀態。 */
    private hydrated;
    /** 本 DO 實例綁定的政策；由路由方在首次請求時釘住（ADR-0366）。 */
    private profile;
    /** 政策是否已寫進 storage（釘住後不得再改，見 `fetch`）。 */
    private profilePinned;
    /** 本 DO 服務的是名單上的已知租戶嗎（ADR-0366 §裁示）；預設否＝公用配額。 */
    private knownLane;
    /** 本 DO 服務的名單上車道 id（Cinderous ADR-0371）；嚴格平面與共用分片為 undefined。 */
    private laneId;
    /** 本實例的 DO 名（Cinderous ADR-0377）；決定天花板與容量政策。第一次 fetch 之前（與升級前的 DO）為 undefined＝預設天花板。 */
    private doName;
    constructor(ctx: DurableObjectState, env: Env);
    /**
     * 以指定政策組 `RelayCore`。濫用防護由 `host-config` 統一供應（ADR-0235 H1）——
     * 與 `node-relay.ts` 用同一組常數，兩座宿主不可能各走各的。
     */
    private buildCore;
    private unauthDiag;
    private reconnectGuard;
    /** DO 定時鬧鐘（C2）：清除已過期留言並重排下一次。 */
    alarm(): Promise<void>;
    fetch(request: Request): Promise<Response>;
    /** 這顆 DO 服務的車道現在是不是在唯讀寬限期（SDK ADR 0052） */
    private laneReadOnly;
    /** 唯讀寬限期已過（SDK ADR 0052）：這顆 DO 的車道列在 `READONLY_LANES` 但到期了 */
    private laneExpired;
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void;
    private handleMessage;
    webSocketClose(ws: WebSocket, code?: number): void;
    webSocketError(ws: WebSocket): void;
    /** 連線結束：記憶體與溢位列一起清（Cinderous ADR-0373）。 */
    private forget;
    /**
     * 休眠喚醒後，從所有存活 WebSocket 的 attachment（＋溢位表）重建 RelayCore 狀態（ADR-0059；Cinderous ADR-0373）。
     *
     * 回傳要送出的 `CLOSED`：attachment 記著、storage 卻找不到的訂閱**不能假裝還在**——
     * 告訴客戶端，它才會重訂。
     */
    private ensureHydrated;
    /**
     * 把連線狀態存起來（Cinderous ADR-0373）。存不住的訂閱**關掉並回 `CLOSED`**——絕不靜默：
     * 留在記憶體裡的話它看起來能用，DO 休眠一次就無聲消失。
     */
    private persist;
    private dispatch;
}
//# sourceMappingURL=worker.d.ts.map