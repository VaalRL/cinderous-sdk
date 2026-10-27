// C′ 即時通道的 Workers 宿主（SDK ADR 0049 §9.2、R1）：每個家庭一顆 Durable Object `iot:<homeTag>`。
//
// - 手機：`/iot/v1/home/<homeTag>`，講 Nostr（同一套 RelayCore），只收 IoT 的 kind；指令由 {@link IotRealtimeHome} 的轉送半接手。
// - 設備：`/iot/v1/dev/<homeTag>/<blindId>`，標頭 `Authorization: Bearer <權杖>`，講 C′ 設備幀。tag＝`dev:<blindId>`。
// - 休眠式 WebSocket（ADR-0059）；**不用任何計時器、不掛住請求**（否則失去休眠，§9.2）。
// - 心跳：`setWebSocketAutoResponse({"t":"hb"} → {"t":"hb-ack"})`，平台自動回覆、不喚醒 DO、不計費；最後心跳時間以
//   `getWebSocketAutoResponseTimestamp` 取得，還沒有心跳時用連線時間（attachment）。
// - 同一台設備只留一條連線：新的通過權杖驗證後，舊的以 4409 關掉（避免外洩的權杖「搶走」命令）。
//
// 為什麼是獨立的 DO 類別而不是 RelayRoom 的一種政策：RelayRoom 的政策釘選、容量、分片都與 IoT 無關，混在一起
// 每加一條規則都要回頭確認不會影響既有平面；獨立類別只在部署時有 `IOT_HOME` 綁定才存在（ADR 0049〈R1 實作〉）。
import { IOT_DEVICE_HEARTBEAT, IOT_DEVICE_HEARTBEAT_ACK, verifyIotDeviceToken } from '../iot/device-frame.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_HEARTBEAT, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_STATE } from '../iot/kinds.js';
import { parseIotAcl, type IotAcl } from '../iot/acl.js';
import { ConnPersistence } from './conn-persistence.js';
import { storeOptions } from './host-config.js';
import { IotRealtimeHome, IOT_REALTIME_REJECT, parseIotRealtimeConfig, type IotRealtimeSockets, type ParsedIotRealtime } from './iot-realtime.js';
import { IotHomeQuota, iotDefaultHomeDailyRequests, nextUtcMidnightSec, type IotQuotaSnapshot } from './iot-quota.js';
import { closeSignalOf, RelayCore, type ConnSnapshot, type Outbound } from './relay-core.js';
import { type SqlExec, SqlMessageStore } from './sql-message-store.js';

/** C′ 需要的環境變數與綁定（併入 worker 的 Env） */
export interface IotHomeEnv {
  /** 家庭 DO 的命名空間；沒有綁定＝這座站沒開 C′（`/iot/v1/*` 一律 404 `blocked: iot-disabled:`） */
  IOT_HOME?: DurableObjectNamespace;
  /** C′ 設定（JSON，非秘密）：`{ "homes": [ { homeTag, homePub, gatewayPubkey, acl, devices: [...] } ] }` */
  IOT_REALTIME?: string;
  /** 閘道私鑰（JSON `{ "<homeTag>": "<64 位 hex>" }`；Worker secret） */
  IOT_GATEWAY_KEYS?: string;
  /** 設備與手機升級的每 IP 限速（選配，Rate Limiting 綁定） */
  IOT_UPGRADE_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  /** 每個家庭每日的 DO 請求預算（§10.3）；沒設＝帳號每日 100,000 ÷ 家庭數 × 0.5 */
  IOT_HOME_DAILY_REQUESTS?: string;
  MAX_TTL_DAYS?: string;
}

/** 設備連線被新連線取代時的關閉碼 */
export const IOT_DEVICE_REPLACED_CLOSE = 4409;
/** 本家預算用完（§10.2）：reason `iot-quota:<reset unix 秒>`，設備據此睡到重置時間，不狂重連 */
export const IOT_QUOTA_CLOSE = 4429;
const QUOTA_KEY = 'cinder:iot-quota';
/** 手機端 RelayCore 只收的 kind：IoT 事件（NIP-42 AUTH 另外處理） */
const IOT_PHONE_KINDS = [IOT_KIND_COMMAND, IOT_KIND_ACK, IOT_KIND_STATE, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_HEARTBEAT];
const HOME_KEY = 'cinder:iot-home';
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** 手機連線的速率（每分鐘事件數）：指令與查詢都是人按的，60 已經很寬 */
const PHONE_EVENTS_PER_MINUTE = 60;

export type IotPath = { kind: 'home'; homeTag: string } | { kind: 'dev'; homeTag: string; blindId: string };

/** 解析 `/iot/v1/home/<homeTag>`、`/iot/v1/dev/<homeTag>/<blindId>`；其他回 undefined */
export function iotPathOf(pathname: string): IotPath | undefined {
  const m = /^\/iot\/v1\/(home|dev)\/([A-Za-z0-9_-]{22})(?:\/([A-Za-z0-9_-]{22}))?\/?$/.exec(pathname);
  if (!m) return undefined;
  if (m[1] === 'home') return m[3] === undefined ? { kind: 'home', homeTag: m[2]! } : undefined;
  return m[3] === undefined ? undefined : { kind: 'dev', homeTag: m[2]!, blindId: m[3] };
}

let cache: { realtime: string | undefined; keys: string | undefined; parsed: ParsedIotRealtime } | undefined;

/** 從 env 解析 C′ 設定（同一個 isolate 內快取；設定有錯的家庭不啟用，錯誤印一次） */
export function iotRealtimeFrom(env: Pick<IotHomeEnv, 'IOT_REALTIME' | 'IOT_GATEWAY_KEYS'>): ParsedIotRealtime {
  if (cache && cache.realtime === env.IOT_REALTIME && cache.keys === env.IOT_GATEWAY_KEYS) return cache.parsed;
  let raw: unknown;
  let keys: Record<string, string> = {};
  try {
    raw = env.IOT_REALTIME ? JSON.parse(env.IOT_REALTIME) : { homes: [] };
  } catch {
    raw = undefined;
  }
  try {
    keys = env.IOT_GATEWAY_KEYS ? (JSON.parse(env.IOT_GATEWAY_KEYS) as Record<string, string>) : {};
  } catch {
    keys = {};
  }
  const parsed = parseIotRealtimeConfig(raw, keys);
  // 🔴 只印路徑與代碼，不印值（權杖雜湊、公鑰都不該進日誌；SDK ADR 0064）
  if (parsed.issues.length > 0) console.warn(`IOT_REALTIME 有 ${parsed.issues.length} 個問題，相關家庭不啟用：${parsed.issues.map((i) => `${i.path}(${i.code})`).join(', ')}`);
  cache = { realtime: env.IOT_REALTIME, keys: env.IOT_GATEWAY_KEYS, parsed };
  return parsed;
}

/** relay 自己產生的 HTTP 錯誤（ADR 0049 §10.2）：一律帶 `Cinder-Relay: 1` 與 JSON `{ error }`，與平台的錯誤分得開 */
export function iotErrorResponse(status: number, error: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'Cinder-Relay': '1', ...headers },
  });
}

/**
 * Worker 端：`/iot/v1/*` 的路由。回 undefined＝不是 IoT 路徑（交給一般路由）。
 * 在碰 DO 之前擋掉：沒開、不認得的家、權杖錯、不是升級——這些都不花 DO 請求。
 */
export async function routeIotRequest(request: Request, env: IotHomeEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/iot/')) return undefined;
  const path = iotPathOf(url.pathname);
  const parsed = env.IOT_HOME && env.IOT_REALTIME ? iotRealtimeFrom(env) : undefined;
  if (!env.IOT_HOME || !parsed || parsed.homes.size === 0) return iotErrorResponse(404, 'blocked: iot-disabled: this relay does not run the IoT realtime channel');
  if (!path) return iotErrorResponse(404, 'invalid: iot-path: not an IoT endpoint (phones use the home endpoint, devices the device endpoint; see SDK ADR 0049)');
  const entry = parsed.homes.get(path.homeTag);
  if (!entry) return iotErrorResponse(403, IOT_REALTIME_REJECT.home);
  if (path.kind === 'dev') {
    const device = entry.config.devices.find((d) => d.blindId === path.blindId);
    if (!device) return iotErrorResponse(404, IOT_REALTIME_REJECT.device);
    // 只驗權杖（不需要閘道金鑰）：與 IotRealtimeHome.authenticateDevice 同一個函式
    const auth = authenticate(device.tokenHash, request.headers.get('Authorization'));
    if (!auth) return iotErrorResponse(401, IOT_REALTIME_REJECT.token);
  }
  if (request.headers.get('Upgrade') !== 'websocket') return iotErrorResponse(426, 'invalid: iot-upgrade: WebSocket upgrade required', { Upgrade: 'websocket' });
  const ip = request.headers.get('CF-Connecting-IP');
  if (env.IOT_UPGRADE_LIMIT && ip) {
    const { success } = await env.IOT_UPGRADE_LIMIT.limit({ key: ip });
    if (!success) return iotErrorResponse(429, 'rate-limited: iot-upgrade: too many connection attempts from this address', { 'Retry-After': '60' });
  }
  try {
    return await env.IOT_HOME.get(env.IOT_HOME.idFromName(`iot:${path.homeTag}`)).fetch(request);
  } catch (error) {
    // DO 超量（§10.3 第 2 點）：在 Worker 端拋出、沒接住會變成 500。改回結構化 503，設備依 Retry-After 退讓。
    // 文字比對很脆弱：比不到的 DO 失敗照樣回 503，但不帶 Cinder-Quota（設備當成 relay-error 指數退避）
    const message = String(error instanceof Error ? error.message : error);
    const m = /Exceeded allowed (volume|duration)/i.exec(message);
    const reset = nextUtcMidnightSec(Date.now());
    if (m) {
      return iotErrorResponse(503, `rate-limited: iot-quota: the relay account is out of Durable Object ${m[1]!.toLowerCase() === 'volume' ? 'requests' : 'duration'} for today`, {
        'Retry-After': String(Math.max(1, reset - Math.floor(Date.now() / 1000))),
        'Cinder-Quota': m[1]!.toLowerCase() === 'volume' ? 'do-requests' : 'do-duration',
      });
    }
    return iotErrorResponse(503, 'error: iot-relay: the home instance failed; retry with backoff');
  }
}

function authenticate(tokenHash: string, header: string | null): boolean {
  return verifyIotDeviceToken(/^Bearer\s+(\S+)$/.exec(header ?? '')?.[1], tokenHash);
}

interface DeviceAttachment {
  readonly iotDevice: string;
  /** 連線時間（毫秒）：還沒有心跳時當作最後心跳 */
  readonly at: number;
}

const isDevice = (att: unknown): att is DeviceAttachment => typeof (att as DeviceAttachment | null)?.iotDevice === 'string';

/** 家庭 DO（每個家庭一顆，`idFromName("iot:<homeTag>")`） */
export class IotHomeRoom {
  private readonly ctx: DurableObjectState;
  private readonly env: IotHomeEnv;
  private readonly exec: SqlExec;
  private readonly store: SqlMessageStore;
  private readonly conns: ConnPersistence;
  private readonly core: RelayCore;
  private rt: IotRealtimeHome | undefined;
  private hydrated = false;
  private quota: IotHomeQuota;

  constructor(ctx: DurableObjectState, env: IotHomeEnv) {
    this.ctx = ctx;
    this.env = env;
    const sql = ctx.storage.sql;
    this.exec = (query, ...bindings) => sql.exec(query, ...bindings).toArray() as Record<string, unknown>[];
    this.exec('CREATE TABLE IF NOT EXISTS iot_acl (id INTEGER PRIMARY KEY CHECK (id = 1), acl TEXT NOT NULL)');
    this.store = new SqlMessageStore(this.exec, storeOptions(env.MAX_TTL_DAYS));
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
        if (!this.rt) return [{ to: connId, message: ['OK', event.id, false, IOT_REALTIME_REJECT.home] }];
        const r = this.rt.interceptPhoneEvent(connId, event, authed);
        return r ? [...r.outbound, ...r.publish.flatMap((e) => this.core.publishLocal(e))] : undefined;
      },
    });
    this.quota = new IotHomeQuota(iotDefaultHomeDailyRequests(iotRealtimeFrom(env).homes.size, env.IOT_HOME_DAILY_REQUESTS));
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<IotQuotaSnapshot>(QUOTA_KEY);
      if (saved) this.quota = new IotHomeQuota(this.quota.limit, Date.now, saved);
      const tag = await ctx.storage.get<string>(HOME_KEY);
      if (tag !== undefined) this.bind(tag);
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    });
  }

  /** 綁定這顆 DO 服務的家庭（設定裡沒有或有錯＝不綁，指令一律拒收） */
  private bind(homeTag: string): boolean {
    const entry = iotRealtimeFrom(this.env).homes.get(homeTag);
    if (!entry) return false;
    this.rt = new IotRealtimeHome(entry.config, entry.gatewaySecret, { sockets: this.deviceSockets(), aclStore: this.aclStore() });
    return true;
  }

  private aclStore(): { load(): IotAcl | undefined; save(acl: IotAcl): void } {
    return {
      load: () => {
        const row = this.exec('SELECT acl FROM iot_acl WHERE id = 1')[0];
        if (!row) return undefined;
        try {
          return parseIotAcl(JSON.parse(String(row.acl)));
        } catch {
          return undefined;
        }
      },
      save: (acl) => void this.exec('INSERT INTO iot_acl (id, acl) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET acl = excluded.acl', JSON.stringify(acl)),
    };
  }

  private deviceSockets(): IotRealtimeSockets {
    const first = (blindId: string): WebSocket | undefined => this.ctx.getWebSockets(`dev:${blindId}`)[0];
    return {
      isConnected: (blindId) => first(blindId) !== undefined,
      lastHeartbeatMs: (blindId) => {
        const ws = first(blindId);
        if (!ws) return undefined;
        const ts = this.ctx.getWebSocketAutoResponseTimestamp(ws);
        if (ts) return ts.getTime();
        const att = ws.deserializeAttachment() as DeviceAttachment | null;
        return att?.at;
      },
      send: (blindId, text) => {
        const ws = first(blindId);
        if (!ws) return false;
        try {
          ws.send(text);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  /**
   * 計一次用量（§10.3）：跨過門檻時通知 owner；用完就關掉所有連線（4429 帶重置時間）。回傳現在是不是已經用完。
   * 寫回 storage 是 fire-and-forget（DO 的 put 會在輸出閘門前完成），每 64 次或跨門檻才寫一次。
   */
  private count(): boolean {
    const r = this.quota.add();
    if (r.persist) void this.ctx.storage.put(QUOTA_KEY, this.quota.snapshot());
    if (r.crossed && this.rt) {
      const { used } = this.quota.snapshot();
      this.dispatch(this.core.publishLocal(this.rt.quotaNotice(r.crossed, used, this.quota.limit, this.quota.resetAt())));
    }
    if (r.state !== 'exhausted') return false;
    if (r.crossed === 'exhausted') {
      const reason = `iot-quota:${this.quota.resetAt()}`;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(IOT_QUOTA_CLOSE, reason);
        } catch {
          /* 已關閉 */
        }
      }
    }
    return true;
  }

  async alarm(): Promise<void> {
    this.count();
    this.dispatch(this.ensureHydrated());
    this.store.prune(Math.floor(Date.now() / 1000));
    await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const path = iotPathOf(new URL(request.url).pathname);
    if (!path) return iotErrorResponse(404, 'invalid: iot-path: unknown path');
    if (this.quota.state() === 'exhausted' || this.count()) {
      const reset = this.quota.resetAt();
      return new Response(JSON.stringify({ error: 'rate-limited: iot-quota: this home has used its relay budget for today', reset }), {
        status: 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Cinder-Relay': '1',
          'Cinder-Quota': 'home-budget',
          'Retry-After': String(Math.max(1, reset - Math.floor(Date.now() / 1000))),
        },
      });
    }
    if (!this.rt) {
      if (!this.bind(path.homeTag)) return iotErrorResponse(403, IOT_REALTIME_REJECT.home);
      await this.ctx.storage.put(HOME_KEY, path.homeTag);
    }
    // 一顆 DO 只服務一個家（名字就是 `iot:<homeTag>`）；收到別家的請求代表路由壞了——拒絕，不切換
    if (this.rt!.homeTag !== path.homeTag) return iotErrorResponse(409, 'invalid: iot-home: this instance serves another home');
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (path.kind === 'dev') {
      const auth = this.rt!.authenticateDevice(path.blindId, request.headers.get('Authorization'));
      if (!auth.ok) return iotErrorResponse(auth.status, auth.error);
      for (const old of this.ctx.getWebSockets(`dev:${path.blindId}`)) {
        try {
          old.close(IOT_DEVICE_REPLACED_CLOSE, 'replaced');
        } catch {
          /* 已關閉 */
        }
      }
      this.ctx.acceptWebSocket(server, [`dev:${path.blindId}`]);
      server.serializeAttachment({ iotDevice: path.blindId, at: Date.now() } satisfies DeviceAttachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    const connId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [connId]);
    const restored = this.ensureHydrated();
    const out = this.core.connect(connId, hostOf(request), request.headers.get('CF-Connecting-IP') ?? undefined);
    this.conns.save(server, this.core.exportConn(connId));
    this.dispatch([...restored, ...out]);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (this.count()) return; // 用完了：連線已經全部關掉
    const att = ws.deserializeAttachment() as unknown;
    if (isDevice(att)) {
      if (!this.rt) return;
      const shed = this.quota.state() === 'shed';
      const r = this.rt.onDeviceFrame(att.iotDevice, typeof message === 'string' ? message : new Uint8Array(message), { shed });
      if (r.reply !== undefined) {
        try {
          ws.send(r.reply);
        } catch {
          /* 已關閉 */
        }
      }
      this.dispatch(r.publish.flatMap((e) => this.core.publishLocal(e)));
      return;
    }
    const restored = this.ensureHydrated();
    const connId = (att as ConnSnapshot | null)?.connId;
    if (!connId) return this.dispatch(restored);
    const out = this.core.handle(connId, typeof message === 'string' ? message : '');
    this.conns.save(ws, this.core.exportConn(connId));
    this.dispatch([...restored, ...out]);
  }

  webSocketClose(ws: WebSocket): void {
    this.closed(ws);
    try {
      ws.close();
    } catch {
      /* 已關閉 */
    }
  }

  webSocketError(ws: WebSocket): void {
    this.closed(ws);
  }

  private closed(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as unknown;
    if (isDevice(att)) return;
    const restored = this.ensureHydrated();
    const connId = (att as ConnSnapshot | null)?.connId;
    if (connId) {
      this.core.disconnect(connId);
      this.conns.remove(connId);
    }
    this.dispatch(restored);
  }

  private ensureHydrated(): Outbound[] {
    if (this.hydrated) return [];
    this.hydrated = true;
    const { snapshots, lost } = this.conns.load(this.ctx.getWebSockets());
    for (const snap of snapshots) this.core.rehydrate(snap);
    return lost.map(({ connId, subId }) => ({ to: connId, message: ['CLOSED', subId, 'error: resubscribe: subscription was lost when the relay restarted; please resubscribe'] }));
  }

  private dispatch(outbound: Outbound[]): void {
    for (const { to, message, close } of outbound) {
      const [ws] = this.ctx.getWebSockets(to);
      try {
        ws?.send(JSON.stringify(message));
      } catch {
        /* 已關閉 */
      }
      if (!close) continue;
      this.core.disconnect(to);
      this.conns.remove(to);
      const { code, reason } = closeSignalOf(close);
      try {
        ws?.close(code, reason);
      } catch {
        /* 已關閉 */
      }
    }
  }
}

function hostOf(request: Request): string | undefined {
  const header = request.headers.get('Host');
  if (header) return header.split(',')[0]!.trim().toLowerCase();
  try {
    return new URL(request.url).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}
