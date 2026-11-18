// C′ 即時通道的 Workers 宿主（SDK ADR 0049 §9.2、R1）：每個家庭一顆 Durable Object `iot:<homeTag>`。
//
// - 手機：`/iot/v1/home/<homeTag>`，講 Nostr（同一套 RelayCore），只收 IoT 的 kind；指令由 {@link IotRealtimeHome} 的轉送半接手。
// - 設備：`/iot/v1/dev/<homeTag>/<blindId>`，標頭 `Authorization: Bearer <權杖>`，講 C′ 設備幀。tag＝`dev:<blindId>`。
// - 休眠式 WebSocket（ADR-0059）；**不用任何計時器、不掛住請求**（否則失去休眠，§9.2）。
// - 心跳：`setWebSocketAutoResponse({"t":"hb"} → {"t":"hb-ack"})`，平台自動回覆、不喚醒 DO、不計費；最後心跳時間以
//   `getWebSocketAutoResponseTimestamp` 取得，還沒有心跳時用連線時間（attachment）。
// - 同一台設備只留一條連線：新的通過權杖驗證後，舊的以 4409 關掉（避免外洩的權杖「搶走」命令）。
// - 長輪詢（SDK ADR 0138，給 Tasmota Berry／ESPHome）：`GET …/<blindId>/next?wait=` 由 **Worker** 掛住——Worker 對 DO
//   開一條休眠式 WebSocket（attachment `transport: 'longpoll'`）、自己 `setTimeout` 等；DO 照樣不掛、不用計時器。
//   DO 送出一個幀就關掉那一條（一輪只回一個幀）。`POST …/ack`、`POST …/state` 的本體就是設備幀。
// - Shelly 明文轉譯（SDK ADR 0139，只限自架＋白名單＋危險旗標）：`/iot/v1/shelly/<homeTag>/<blindId>?token=…`，
//   attachment `transport: 'shelly'`；DO 以這台的 deviceKey 透過 {@link IotShellyTranslator} 替它封／解信封。
//
// 為什麼是獨立的 DO 類別而不是 RelayRoom 的一種政策：RelayRoom 的政策釘選、容量、分片都與 IoT 無關，混在一起
// 每加一條規則都要回頭確認不會影響既有平面；獨立類別只在部署時有 `IOT_HOME` 綁定才存在（ADR 0049〈R1 實作〉）。
import { IOT_DEVICE_FRAME_MAX_BYTES, IOT_DEVICE_HEARTBEAT, IOT_DEVICE_HEARTBEAT_ACK, parseIotDeviceFrame, verifyIotDeviceToken } from '../iot/device-frame.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_HEARTBEAT, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_STATE } from '../iot/kinds.js';
import { parseIotAcl } from '../iot/acl.js';
import { IOT_QUOTA_CLOSE_CODE } from '../protocol/relay-reject.js';
import { ConnPersistence } from './conn-persistence.js';
import { storeOptions } from './host-config.js';
import { IOT_REALTIME_ADDRESSABLE_PER_AUTHOR } from './iot-realtime-config.js';
import { IotShellyTranslator } from './iot-shelly.js';
import { iotLongPollWaitSec, iotPlaintextFrom, IotRealtimeHome, IOT_REALTIME_REJECT, parseIotRealtimeConfig, } from './iot-realtime.js';
import { IotHomeQuota, iotDefaultHomeDailyRequests, nextUtcMidnightSec } from './iot-quota.js';
import { closeSignalOf, RelayCore } from './relay-core.js';
import { SqlMessageStore } from './sql-message-store.js';
/** 設備連線被新連線取代時的關閉碼 */
export const IOT_DEVICE_REPLACED_CLOSE = 4409;
/** 本家預算用完（§10.2）：reason `iot-quota:<reset unix 秒>`，設備據此睡到重置時間，不狂重連 */
export const IOT_QUOTA_CLOSE = IOT_QUOTA_CLOSE_CODE;
const QUOTA_KEY = 'cinder:iot-quota';
/** 手機端 RelayCore 只收的 kind：IoT 事件（NIP-42 AUTH 另外處理） */
const IOT_PHONE_KINDS = [IOT_KIND_COMMAND, IOT_KIND_ACK, IOT_KIND_STATE, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_HEARTBEAT];
const HOME_KEY = 'cinder:iot-home';
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** 手機連線的速率（每分鐘事件數）：指令與查詢都是人按的，60 已經很寬 */
const PHONE_EVENTS_PER_MINUTE = 60;
/**
 * 解析 `/iot/v1/home/<homeTag>`、`/iot/v1/dev/<homeTag>/<blindId>`（長輪詢再加 `/next`、`/ack`、`/state`）、
 * `/iot/v1/shelly/<homeTag>/<blindId>`；其他回 undefined
 */
export function iotPathOf(pathname) {
    const m = /^\/iot\/v1\/(home|dev|shelly)\/([A-Za-z0-9_-]{22})(?:\/([A-Za-z0-9_-]{22})(?:\/(next|ack|state))?)?\/?$/.exec(pathname);
    if (!m)
        return undefined;
    if (m[1] === 'home')
        return m[3] === undefined ? { kind: 'home', homeTag: m[2] } : undefined;
    if (m[3] === undefined)
        return undefined;
    if (m[1] === 'shelly')
        return m[4] === undefined ? { kind: 'shelly', homeTag: m[2], blindId: m[3] } : undefined;
    return m[4] === undefined ? { kind: 'dev', homeTag: m[2], blindId: m[3] } : { kind: 'dev', homeTag: m[2], blindId: m[3], op: m[4] };
}
let cache;
/** 從 env 解析 C′ 設定（同一個 isolate 內快取；設定有錯的家庭不啟用，錯誤印一次） */
export function iotRealtimeFrom(env) {
    const plaintextKey = `${env.IOT_PLAINTEXT_DEVICES ?? ''}\u0000${env.ALLOWED_PUBKEYS ?? ''}\u0000${env.IOT_PLAINTEXT_DEVICE_KEYS ?? ''}`;
    if (cache && cache.realtime === env.IOT_REALTIME && cache.keys === env.IOT_GATEWAY_KEYS && cache.plaintext === plaintextKey)
        return cache.parsed;
    let raw;
    let keys = {};
    try {
        raw = env.IOT_REALTIME ? JSON.parse(env.IOT_REALTIME) : { homes: [] };
    }
    catch {
        raw = undefined;
    }
    try {
        keys = env.IOT_GATEWAY_KEYS ? JSON.parse(env.IOT_GATEWAY_KEYS) : {};
    }
    catch {
        keys = {};
    }
    const parsed = parseIotRealtimeConfig(raw, keys, iotPlaintextFrom(env));
    // 🔴 只印路徑與代碼，不印值（權杖雜湊、公鑰、設備金鑰都不該進日誌；SDK ADR 0064）
    if (parsed.issues.length > 0)
        console.warn(`IOT_REALTIME 有 ${parsed.issues.length} 個問題，相關家庭不啟用：${parsed.issues.map((i) => `${i.path}(${i.code})`).join(', ')}`);
    cache = { realtime: env.IOT_REALTIME, keys: env.IOT_GATEWAY_KEYS, plaintext: plaintextKey, parsed };
    return parsed;
}
/** relay 自己產生的 HTTP 錯誤（ADR 0049 §10.2）：一律帶 `Cinder-Relay: 1` 與 JSON `{ error }`，與平台的錯誤分得開 */
export function iotErrorResponse(status, error, headers = {}) {
    return new Response(JSON.stringify({ error }), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'Cinder-Relay': '1', ...headers },
    });
}
/** 本家預算的結構化 503（§10.2）：`home-budget`＝今日用完，`home-shed`＝95% 分流（遙測先丟） */
export function iotQuotaResponse(reset, quota = 'home-budget') {
    const error = quota === 'home-budget'
        ? 'rate-limited: iot-quota: this home has used its relay budget for today'
        : 'rate-limited: iot-quota: this home is shedding telemetry for today (95% of its relay budget used); acks still go through';
    return new Response(JSON.stringify({ error, reset }), {
        status: 503,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'Cinder-Relay': '1',
            'Cinder-Quota': quota,
            'Retry-After': String(Math.max(1, reset - Math.floor(Date.now() / 1000))),
        },
    });
}
/**
 * Worker 端：`/iot/v1/*` 的路由。回 undefined＝不是 IoT 路徑（交給一般路由）。
 * 在碰 DO 之前擋掉：沒開、不認得的家、權杖錯、不是升級——這些都不花 DO 請求。
 */
export async function routeIotRequest(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/iot/'))
        return undefined;
    const path = iotPathOf(url.pathname);
    const parsed = env.IOT_HOME && env.IOT_REALTIME ? iotRealtimeFrom(env) : undefined;
    if (!env.IOT_HOME || !parsed || parsed.homes.size === 0)
        return iotErrorResponse(404, 'blocked: iot-disabled: this relay does not run the IoT realtime channel');
    if (!path)
        return iotErrorResponse(404, 'invalid: iot-path: not an IoT endpoint (phones use the home endpoint, devices the device endpoint; see SDK ADR 0049)');
    const entry = parsed.homes.get(path.homeTag);
    if (!entry)
        return iotErrorResponse(403, IOT_REALTIME_REJECT.home);
    if (path.kind === 'dev' || path.kind === 'shelly') {
        const device = entry.config.devices.find((d) => d.blindId === path.blindId);
        // Shelly 設備只走 /shelly/、其他設備不能走 /shelly/（relay 手上只有 Shelly 設備的金鑰）
        if (!device || (device.transport === 'shelly') !== (path.kind === 'shelly'))
            return iotErrorResponse(404, IOT_REALTIME_REJECT.device);
        // 只驗權杖（不需要閘道金鑰）：與 IotRealtimeHome.authenticateDevice 同一個函式
        const auth = authenticate(device.tokenHash, iotDeviceAuthorization(request, path.kind));
        if (!auth)
            return iotErrorResponse(401, IOT_REALTIME_REJECT.token);
    }
    const op = path.kind === 'dev' ? path.op : undefined;
    let upstream = request;
    if (op === 'ack' || op === 'state') {
        if (request.method !== 'POST')
            return iotErrorResponse(405, `invalid: iot-method: POST the device frame to /${op}`, { Allow: 'POST' });
        // 在 Worker 就擋掉壞幀（不花 DO 請求）；解不解得開信封由 DO 判斷，那一關不回任何訊號（沒有 oracle）
        const text = await request.text();
        const frame = new TextEncoder().encode(text).length <= IOT_DEVICE_FRAME_MAX_BYTES ? parseIotDeviceFrame(text, 'device') : undefined;
        if (!frame || frame.t !== op)
            return iotErrorResponse(400, `invalid: iot-frame: the body must be one device frame with t="${op}"`);
        upstream = new Request(request.url, { method: 'POST', headers: { Authorization: request.headers.get('Authorization') ?? '' }, body: text });
    }
    else if (op === 'next') {
        if (request.method !== 'GET')
            return iotErrorResponse(405, 'invalid: iot-method: GET /next to wait for the next frame', { Allow: 'GET' });
    }
    else if (request.headers.get('Upgrade') !== 'websocket') {
        return iotErrorResponse(426, 'invalid: iot-upgrade: WebSocket upgrade required', { Upgrade: 'websocket' });
    }
    const ip = request.headers.get('CF-Connecting-IP');
    if (env.IOT_UPGRADE_LIMIT && ip && op !== 'ack' && op !== 'state') {
        const { success } = await env.IOT_UPGRADE_LIMIT.limit({ key: ip });
        if (!success)
            return iotErrorResponse(429, 'rate-limited: iot-upgrade: too many connection attempts from this address', { 'Retry-After': '60' });
    }
    try {
        const stub = env.IOT_HOME.get(env.IOT_HOME.idFromName(`iot:${path.homeTag}`));
        if (op === 'next')
            return await longPoll(stub, request, iotLongPollWaitSec(url.searchParams.get('wait')));
        return await stub.fetch(upstream);
    }
    catch (error) {
        // DO 超量（§10.3 第 2 點）：在 Worker 端拋出、沒接住會變成 500。改回結構化 503，設備依 Retry-After 退讓。
        // 文字比對很脆弱：比不到的 DO 失敗照樣回 503，但不帶 Cinder-Quota（設備當成 relay-error 指數退避）
        const message = String(error instanceof Error ? error.message : error);
        const m = /Exceeded allowed (volume|duration)/i.exec(message);
        const reset = nextUtcMidnightSec(Date.now());
        if (m) {
            return iotErrorResponse(503, `rate-limited: iot-quota: the relay account is out of Durable Object ${m[1].toLowerCase() === 'volume' ? 'requests' : 'duration'} for today`, {
                'Retry-After': String(Math.max(1, reset - Math.floor(Date.now() / 1000))),
                'Cinder-Quota': m[1].toLowerCase() === 'volume' ? 'do-requests' : 'do-duration',
            });
        }
        return iotErrorResponse(503, 'error: iot-relay: the home instance failed; retry with backoff');
    }
}
/**
 * 長輪詢的一輪（SDK ADR 0138）：Worker 對 DO 開一條休眠式 WebSocket，自己計時——**DO 不掛住任何東西**。
 * DO 回 200（空檔內保留的幀）或任何非 101 的回應（預算用完的 503…）就原樣轉出。
 */
async function longPoll(stub, request, waitSec) {
    const res = await stub.fetch(new Request(request.url, { headers: { Upgrade: 'websocket', Authorization: request.headers.get('Authorization') ?? '' } }));
    const ws = res.webSocket;
    if (res.status !== 101 || !ws)
        return res;
    ws.accept();
    return new Promise((resolve) => {
        let done = false;
        const finish = (r) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            try {
                ws.close(1000, 'done');
            }
            catch {
                /* 已關閉 */
            }
            resolve(r);
        };
        const timer = setTimeout(() => finish(new Response(null, { status: 204, headers: { 'Cinder-Relay': '1' } })), waitSec * 1000);
        ws.addEventListener('message', (ev) => {
            const data = ev.data;
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
            finish(new Response(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'Cinder-Relay': '1' } }));
        });
        ws.addEventListener('close', (ev) => {
            const { code, reason } = ev;
            if (code === IOT_QUOTA_CLOSE) {
                const reset = Number(/^iot-quota:(\d{1,12})$/.exec(reason ?? '')?.[1] ?? nextUtcMidnightSec(Date.now()));
                return finish(iotQuotaResponse(reset));
            }
            if (code === IOT_DEVICE_REPLACED_CLOSE)
                return finish(iotErrorResponse(409, 'restricted: iot-replaced: another connection for this device took over (token leaked?)'));
            finish(iotErrorResponse(503, 'error: iot-relay: the home instance closed the poll; retry with backoff'));
        });
    });
}
/**
 * 設備的權杖：`Authorization: Bearer …`；Shelly 設不了標頭，另外接受網址的 `?token=`（會進存取記錄——SDK ADR 0139 的已知風險）
 */
export function iotDeviceAuthorization(request, kind) {
    const header = request.headers.get('Authorization');
    if (header || kind !== 'shelly')
        return header;
    const token = new URL(request.url).searchParams.get('token');
    return token ? `Bearer ${token}` : null;
}
function authenticate(tokenHash, header) {
    return verifyIotDeviceToken(/^Bearer\s+(\S+)$/.exec(header ?? '')?.[1], tokenHash);
}
const isDevice = (att) => typeof att?.iotDevice === 'string';
/** 家庭 DO（每個家庭一顆，`idFromName("iot:<homeTag>")`） */
export class IotHomeRoom {
    ctx;
    env;
    exec;
    store;
    conns;
    core;
    rt;
    /** Shelly 設備的金鑰（綁定家庭時取得）與轉譯器（記憶體；休眠後重建，計數器以時間為底不會倒退） */
    plaintextKeys = new Map();
    shelly = new Map();
    hydrated = false;
    quota;
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        const sql = ctx.storage.sql;
        this.exec = (query, ...bindings) => sql.exec(query, ...bindings).toArray();
        this.exec('CREATE TABLE IF NOT EXISTS iot_acl (id INTEGER PRIMARY KEY CHECK (id = 1), acl TEXT NOT NULL)');
        // 閘道公鑰替每台設備存一顆 retained：可尋址上限要放到設備數＋名單（SDK ADR 0121）
        this.store = new SqlMessageStore(this.exec, { ...storeOptions(env.MAX_TTL_DAYS), addressablePerAuthor: IOT_REALTIME_ADDRESSABLE_PER_AUTHOR });
        this.conns = new ConnPersistence(this.exec);
        // 平台自動回覆心跳：字串必須與設備送的逐位元組相同，否則每則都喚醒 DO、悄悄變成計費（R0 實測結果一）
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(IOT_DEVICE_HEARTBEAT, IOT_DEVICE_HEARTBEAT_ACK));
        this.core = new RelayCore({
            store: this.store,
            allowedKinds: IOT_PHONE_KINDS,
            maxEventsPerMinute: PHONE_EVENTS_PER_MINUTE,
            maxFutureSkewSec: 60,
            maxPastSkewSec: 300,
            replayWindowSec: 300,
            intercept: (connId, event, authed) => {
                if (!this.rt)
                    return [{ to: connId, message: ['OK', event.id, false, IOT_REALTIME_REJECT.home] }];
                const r = this.rt.interceptPhoneEvent(connId, event, authed);
                return r ? [...r.outbound, ...r.publish.flatMap((e) => this.core.publishLocal(e))] : undefined;
            },
        });
        this.quota = new IotHomeQuota(iotDefaultHomeDailyRequests(iotRealtimeFrom(env).homes.size, env.IOT_HOME_DAILY_REQUESTS));
        ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get(QUOTA_KEY);
            if (saved)
                this.quota = new IotHomeQuota(this.quota.limit, Date.now, saved);
            const tag = await ctx.storage.get(HOME_KEY);
            if (tag !== undefined)
                this.bind(tag);
            if ((await ctx.storage.getAlarm()) === null)
                await ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
        });
    }
    /** 綁定這顆 DO 服務的家庭（設定裡沒有或有錯＝不綁，指令一律拒收） */
    bind(homeTag) {
        const entry = iotRealtimeFrom(this.env).homes.get(homeTag);
        if (!entry)
            return false;
        this.rt = new IotRealtimeHome(entry.config, entry.gatewaySecret, { sockets: this.deviceSockets(), aclStore: this.aclStore() });
        this.plaintextKeys = entry.plaintextKeys;
        return true;
    }
    /** 這台 Shelly 的轉譯器（沒有金鑰或不是 Shelly＝undefined） */
    translator(blindId) {
        const existing = this.shelly.get(blindId);
        if (existing)
            return existing;
        const device = this.rt?.device(blindId);
        const key = device?.transport === 'shelly' ? this.plaintextKeys.get(device.id) : undefined;
        if (!device || !key)
            return undefined;
        const t = new IotShellyTranslator({ device, deviceKey: key });
        this.shelly.set(blindId, t);
        return t;
    }
    /** Shelly 轉譯的輸出：RPC 送給 Shelly；up 幀交給家庭核心（與 E2EE 設備的幀走同一條路：kid、計數器、分流都一樣） */
    shellyOut(ws, blindId, out) {
        for (const rpc of out.toDevice) {
            try {
                ws.send(rpc);
            }
            catch {
                /* 已關閉 */
            }
        }
        if (out.up.length === 0 || !this.rt)
            return;
        const shed = this.quota.state() === 'shed';
        const publish = out.up.flatMap((frame) => this.rt.onDeviceFrame(blindId, frame, { shed }).publish);
        if (publish.length === 0)
            return;
        const restored = this.ensureHydrated();
        this.dispatch([...restored, ...publish.flatMap((e) => this.core.publishLocal(e))]);
    }
    aclStore() {
        return {
            load: () => {
                const row = this.exec('SELECT acl FROM iot_acl WHERE id = 1')[0];
                if (!row)
                    return undefined;
                try {
                    return parseIotAcl(JSON.parse(String(row.acl)));
                }
                catch {
                    return undefined;
                }
            },
            save: (acl) => void this.exec('INSERT INTO iot_acl (id, acl) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET acl = excluded.acl', JSON.stringify(acl)),
        };
    }
    deviceSockets() {
        // 同一台設備可能短暫有兩條（新的剛接受、舊的還在關）：取 attachment 時間最新的，不靠 getWebSockets 的順序
        const first = (blindId) => {
            let best;
            let bestAt = -Infinity;
            for (const ws of this.ctx.getWebSockets(`dev:${blindId}`)) {
                const at = ws.deserializeAttachment()?.at ?? 0;
                if (at >= bestAt)
                    [best, bestAt] = [ws, at];
            }
            return best;
        };
        const transportOf = (ws) => ws.deserializeAttachment()?.transport ?? 'ws';
        return {
            isConnected: (blindId) => first(blindId) !== undefined,
            transportOf: (blindId) => {
                const ws = first(blindId);
                return ws ? transportOf(ws) : undefined;
            },
            lastHeartbeatMs: (blindId) => {
                const ws = first(blindId);
                if (!ws)
                    return undefined;
                const ts = this.ctx.getWebSocketAutoResponseTimestamp(ws);
                if (ts)
                    return ts.getTime();
                const att = ws.deserializeAttachment();
                return att?.at;
            },
            send: (blindId, text) => {
                const ws = first(blindId);
                if (!ws)
                    return false;
                if (transportOf(ws) === 'shelly') {
                    const t = this.translator(blindId);
                    if (!t)
                        return false;
                    const out = t.fromRelay(text);
                    this.shellyOut(ws, blindId, { toDevice: out.toDevice, up: [] });
                    // 馬上能回答的 up（不認得的 topic、過期）晚一拍再交給核心：現在還在核心處理手機訊息的途中
                    if (out.up.length > 0)
                        queueMicrotask(() => this.shellyOut(ws, blindId, { toDevice: [], up: out.up }));
                    return true;
                }
                try {
                    ws.send(text);
                }
                catch {
                    return false;
                }
                // 長輪詢：一輪只回一個幀。立刻關掉，下一個指令就不會送進一條 Worker 正在收尾的連線（會遺失）
                if (transportOf(ws) === 'longpoll') {
                    try {
                        ws.close(1000, 'delivered');
                    }
                    catch {
                        /* 已關閉 */
                    }
                    this.rt?.longPollEnded(blindId);
                }
                return true;
            },
        };
    }
    /**
     * 計一次用量（§10.3）：跨過門檻時通知 owner；用完就關掉所有連線（4429 帶重置時間）。回傳現在是不是已經用完。
     * 寫回 storage 是 fire-and-forget（DO 的 put 會在輸出閘門前完成），每 64 次或跨門檻才寫一次。
     */
    count() {
        const r = this.quota.add();
        if (r.persist)
            void this.ctx.storage.put(QUOTA_KEY, this.quota.snapshot());
        if (r.crossed && this.rt) {
            const { used } = this.quota.snapshot();
            this.dispatch(this.core.publishLocal(this.rt.quotaNotice(r.crossed, used, this.quota.limit, this.quota.resetAt())));
        }
        if (r.state !== 'exhausted')
            return false;
        if (r.crossed === 'exhausted') {
            const reason = `iot-quota:${this.quota.resetAt()}`;
            for (const ws of this.ctx.getWebSockets()) {
                try {
                    ws.close(IOT_QUOTA_CLOSE, reason);
                }
                catch {
                    /* 已關閉 */
                }
            }
        }
        return true;
    }
    async alarm() {
        this.count();
        this.dispatch(this.ensureHydrated());
        this.store.prune(Math.floor(Date.now() / 1000));
        await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
    async fetch(request) {
        const path = iotPathOf(new URL(request.url).pathname);
        if (!path)
            return iotErrorResponse(404, 'invalid: iot-path: unknown path');
        if (this.quota.state() === 'exhausted' || this.count())
            return iotQuotaResponse(this.quota.resetAt());
        if (!this.rt) {
            if (!this.bind(path.homeTag))
                return iotErrorResponse(403, IOT_REALTIME_REJECT.home);
            await this.ctx.storage.put(HOME_KEY, path.homeTag);
        }
        // 一顆 DO 只服務一個家（名字就是 `iot:<homeTag>`）；收到別家的請求代表路由壞了——拒絕，不切換
        if (this.rt.homeTag !== path.homeTag)
            return iotErrorResponse(409, 'invalid: iot-home: this instance serves another home');
        if (path.kind === 'dev' || path.kind === 'shelly') {
            const auth = this.rt.authenticateDevice(path.blindId, iotDeviceAuthorization(request, path.kind));
            if (!auth.ok)
                return iotErrorResponse(auth.status, auth.error);
            if ((auth.device.transport === 'shelly') !== (path.kind === 'shelly'))
                return iotErrorResponse(404, IOT_REALTIME_REJECT.device);
            if (path.kind === 'shelly' && !this.translator(path.blindId))
                return iotErrorResponse(404, IOT_REALTIME_REJECT.device);
            const op = path.kind === 'dev' ? path.op : undefined;
            if (op === 'ack' || op === 'state')
                return this.devicePost(path.blindId, op, await request.text());
            if (op === 'next') {
                // 空檔內保留的幀：直接回 200，不開連線（SDK ADR 0138）
                const held = this.rt.longPollStart(path.blindId);
                if (held !== undefined)
                    return new Response(held, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'Cinder-Relay': '1' } });
            }
        }
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        if (path.kind === 'dev' || path.kind === 'shelly') {
            for (const old of this.ctx.getWebSockets(`dev:${path.blindId}`)) {
                try {
                    old.close(IOT_DEVICE_REPLACED_CLOSE, 'replaced');
                }
                catch {
                    /* 已關閉 */
                }
            }
            this.ctx.acceptWebSocket(server, [`dev:${path.blindId}`]);
            const transport = path.kind === 'shelly' ? 'shelly' : path.op === 'next' ? 'longpoll' : undefined;
            server.serializeAttachment({ iotDevice: path.blindId, at: Date.now(), ...(transport ? { transport } : {}) });
            return new Response(null, { status: 101, webSocket: client });
        }
        const connId = crypto.randomUUID();
        this.ctx.acceptWebSocket(server, [connId]);
        const restored = this.ensureHydrated();
        const out = this.core.connect(connId, hostOf(request), request.headers.get('CF-Connecting-IP') ?? undefined);
        this.conns.save(server, this.core.exportConn(connId));
        // 名單公告（SDK ADR 0121）：這個實例第一次有手機連上時發一次（休眠喚醒後是新實例，會再發一次——可取代事件，只多一列寫入）
        const announce = this.rt.aclAnnouncement();
        this.dispatch([...restored, ...out, ...(announce ? this.core.publishLocal(announce) : [])]);
        return new Response(null, { status: 101, webSocket: client });
    }
    /** 長輪詢設備的上行（SDK ADR 0138）：Worker 已經擋掉壞幀；解不開的信封照樣回 204（不給 oracle） */
    devicePost(blindId, op, text) {
        if (op === 'state' && this.quota.state() === 'shed')
            return iotQuotaResponse(this.quota.resetAt(), 'home-shed');
        const frame = parseIotDeviceFrame(text, 'device');
        if (!frame || frame.t !== op)
            return iotErrorResponse(400, `invalid: iot-frame: the body must be one device frame with t="${op}"`);
        const restored = this.ensureHydrated();
        const r = this.rt.onDeviceFrame(blindId, text);
        this.dispatch([...restored, ...r.publish.flatMap((e) => this.core.publishLocal(e))]);
        return new Response(null, { status: 204, headers: { 'Cinder-Relay': '1' } });
    }
    webSocketMessage(ws, message) {
        if (this.count())
            return; // 用完了：連線已經全部關掉
        const att = ws.deserializeAttachment();
        if (isDevice(att)) {
            if (!this.rt)
                return;
            if (att.transport === 'shelly') {
                const t = this.translator(att.iotDevice);
                if (t)
                    this.shellyOut(ws, att.iotDevice, t.fromDevice(typeof message === 'string' ? message : new TextDecoder().decode(message)));
                return;
            }
            const shed = this.quota.state() === 'shed';
            const r = this.rt.onDeviceFrame(att.iotDevice, typeof message === 'string' ? message : new Uint8Array(message), { shed });
            if (r.reply !== undefined) {
                try {
                    ws.send(r.reply);
                }
                catch {
                    /* 已關閉 */
                }
            }
            // 🔴 先還原手機的訂閱再扇出：休眠喚醒後若設備比手機先開口，訂閱還沒回到 RelayCore，ack 會沒人收（SDK ADR 0138 順手修）
            const restored = r.publish.length > 0 ? this.ensureHydrated() : [];
            this.dispatch([...restored, ...r.publish.flatMap((e) => this.core.publishLocal(e))]);
            return;
        }
        const restored = this.ensureHydrated();
        const connId = att?.connId;
        if (!connId)
            return this.dispatch(restored);
        const out = this.core.handle(connId, typeof message === 'string' ? message : '');
        this.conns.save(ws, this.core.exportConn(connId));
        this.dispatch([...restored, ...out]);
    }
    webSocketClose(ws) {
        this.closed(ws);
        try {
            ws.close();
        }
        catch {
            /* 已關閉 */
        }
    }
    webSocketError(ws) {
        this.closed(ws);
    }
    closed(ws) {
        const att = ws.deserializeAttachment();
        if (isDevice(att)) {
            if (att.transport !== 'longpoll')
                return;
            // 長輪詢的一輪結束（Worker 逾時或設備斷了）：這個事件本身也是一次 DO 請求，計入本家預算；開始算空檔
            if (this.count())
                return;
            if (this.ctx.getWebSockets(`dev:${att.iotDevice}`).every((other) => other === ws))
                this.rt?.longPollEnded(att.iotDevice);
            return;
        }
        const restored = this.ensureHydrated();
        const connId = att?.connId;
        if (connId) {
            this.core.disconnect(connId);
            this.conns.remove(connId);
        }
        this.dispatch(restored);
    }
    ensureHydrated() {
        if (this.hydrated)
            return [];
        this.hydrated = true;
        const { snapshots, lost } = this.conns.load(this.ctx.getWebSockets());
        for (const snap of snapshots)
            this.core.rehydrate(snap);
        return lost.map(({ connId, subId }) => ({ to: connId, message: ['CLOSED', subId, 'error: resubscribe: subscription was lost when the relay restarted; please resubscribe'] }));
    }
    dispatch(outbound) {
        for (const { to, message, close } of outbound) {
            const [ws] = this.ctx.getWebSockets(to);
            try {
                ws?.send(JSON.stringify(message));
            }
            catch {
                /* 已關閉 */
            }
            if (!close)
                continue;
            this.core.disconnect(to);
            this.conns.remove(to);
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
function hostOf(request) {
    const header = request.headers.get('Host');
    if (header)
        return header.split(',')[0].trim().toLowerCase();
    try {
        return new URL(request.url).host.toLowerCase() || undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=iot-home-room.js.map