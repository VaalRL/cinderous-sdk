// C′ 即時通道的 Node 宿主（SDK ADR 0049 §9、R1）：自架主機（家中 Node relay＋Tunnel）用。與 Workers 版共用 {@link IotRealtimeHome}。
//
// - 每個家庭一個 IotRealtimeHome＋一個手機端 RelayCore（只收 IoT kind），全在記憶體。
// - 升級在**接受之前**就驗（家庭、權杖）：錯的回 HTTP 錯誤（JSON＋`Cinder-Relay: 1`，ADR 0049 §10.2），不建立連線。
// - 設備心跳 `{"t":"hb"}` 由這裡回 `{"t":"hb-ack"}`（Node 沒有平台自動回覆）；協定層 ping 也算心跳。
// - 角色名單（`$sys/acl`）存在主資料庫的 `iot_acl` 表；純記憶體模式只在記憶體。retained（31170）在記憶體——
//   重啟後設備下一次回報就補回來（每台至少每 5 分鐘一次）。
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { parseIotAcl, type IotAcl } from '../iot/acl.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_HEARTBEAT, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_STATE } from '../iot/kinds.js';
import { firstHost } from './host-config.js';
import { IotRealtimeHome, IOT_REALTIME_REJECT, parseIotRealtimeConfig, type IotRealtimeSockets } from './iot-realtime.js';
import { IOT_REALTIME_ADDRESSABLE_PER_AUTHOR } from './iot-realtime-config.js';
import { MessageStore } from './message-store.js';
import { closeSignalOf, RelayCore, type Outbound } from './relay-core.js';
import type { SqlExec } from './sql-message-store.js';

const IOT_PHONE_KINDS = [IOT_KIND_COMMAND, IOT_KIND_ACK, IOT_KIND_STATE, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_HEARTBEAT];
const REPLACED_CLOSE = 4409;
const PATH = /^\/iot\/v1\/(home|dev)\/([A-Za-z0-9_-]{22})(?:\/([A-Za-z0-9_-]{22}))?\/?$/;

const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 426: 'Upgrade Required' };

/** 在 socket 上直接回一個 HTTP 錯誤（升級被拒）：JSON＋`Cinder-Relay: 1` */
function rejectUpgrade(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\nCinder-Relay: 1\r\nConnection: close\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

interface HomeRuntime {
  rt: IotRealtimeHome;
  core: RelayCore;
  phones: Map<string, WebSocket>;
  devices: Map<string, { ws: WebSocket; lastHb: number }>;
}

export interface IotNodeHub {
  /** 這是 IoT 路徑嗎；是的話已處理（接受或拒絕） */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** 一般 HTTP 請求打到 `/iot/`：回錯誤；不是 IoT 路徑回 false */
  handleHttp(path: string): { status: number; error: string } | undefined;
  close(): void;
}

/**
 * 建立 Node 的 IoT 集線器。`IOT_REALTIME` 沒設＝回傳的集線器對所有 `/iot/` 回 404 `blocked: iot-disabled:`（與 Workers 版相同）。
 * `exec` 給了就把角色名單存進 `iot_acl` 表。
 */
export function createIotNodeHub(env: Record<string, string | undefined>, opts: { exec?: SqlExec } = {}): IotNodeHub {
  const wss = new WebSocketServer({ noServer: true });
  const homes = new Map<string, HomeRuntime>();
  let enabled = false;
  if (env.IOT_REALTIME) {
    let raw: unknown;
    let keys: Record<string, string> = {};
    try {
      raw = JSON.parse(env.IOT_REALTIME);
      keys = env.IOT_GATEWAY_KEYS ? (JSON.parse(env.IOT_GATEWAY_KEYS) as Record<string, string>) : {};
    } catch {
      raw = undefined;
    }
    const parsed = parseIotRealtimeConfig(raw, keys);
    // 🔴 自架站的設定錯誤要讓人看見；只印路徑與代碼（不印值）
    if (parsed.issues.length > 0) console.warn(`IOT_REALTIME 有 ${parsed.issues.length} 個問題，相關家庭不啟用：${parsed.issues.map((i) => `${i.path}(${i.code})`).join(', ')}`);
    const exec = opts.exec;
    exec?.('CREATE TABLE IF NOT EXISTS iot_acl (home TEXT PRIMARY KEY, acl TEXT NOT NULL)');
    for (const [homeTag, entry] of parsed.homes) {
      const phones = new Map<string, WebSocket>();
      const devices = new Map<string, { ws: WebSocket; lastHb: number }>();
      const sockets: IotRealtimeSockets = {
        isConnected: (b) => devices.has(b),
        lastHeartbeatMs: (b) => devices.get(b)?.lastHb,
        send: (b, text) => {
          const d = devices.get(b);
          if (!d || d.ws.readyState !== d.ws.OPEN) return false;
          d.ws.send(text);
          return true;
        },
      };
      const aclStore = exec
        ? {
            load: (): IotAcl | undefined => {
              const row = exec('SELECT acl FROM iot_acl WHERE home = ?', homeTag)[0];
              if (!row) return undefined;
              try {
                return parseIotAcl(JSON.parse(String(row.acl)));
              } catch {
                return undefined;
              }
            },
            save: (acl: IotAcl): void => void exec('INSERT INTO iot_acl (home, acl) VALUES (?, ?) ON CONFLICT(home) DO UPDATE SET acl = excluded.acl', homeTag, JSON.stringify(acl)),
          }
        : undefined;
      const rt = new IotRealtimeHome(entry.config, entry.gatewaySecret, { sockets, ...(aclStore ? { aclStore } : {}) });
      const core: RelayCore = new RelayCore({
        store: new MessageStore({ addressablePerAuthor: IOT_REALTIME_ADDRESSABLE_PER_AUTHOR }),
        allowedKinds: IOT_PHONE_KINDS,
        maxEventsPerMinute: 60,
        maxFutureSkewSec: 60,
        maxPastSkewSec: 300,
        replayWindowSec: 300,
        intercept: (connId, event, authed): Outbound[] | undefined => {
          const r = rt.interceptPhoneEvent(connId, event, authed);
          return r ? [...r.outbound, ...r.publish.flatMap((e) => core.publishLocal(e))] : undefined;
        },
      });
      homes.set(homeTag, { rt, core, phones, devices });
    }
    enabled = homes.size > 0;
  }

  const dispatch = (h: HomeRuntime, out: Outbound[]): void => {
    for (const { to, message, close } of out) {
      const ws = h.phones.get(to);
      if (!ws || ws.readyState !== ws.OPEN) continue;
      ws.send(JSON.stringify(message));
      if (close) {
        const { code, reason } = closeSignalOf(close);
        ws.close(code, reason);
      }
    }
  };

  let counter = 0;
  return {
    handleUpgrade(req, socket, head) {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      if (!pathname.startsWith('/iot/')) return false;
      if (!enabled) return void rejectUpgrade(socket, 404, 'blocked: iot-disabled: this relay does not run the IoT realtime channel'), true;
      const m = PATH.exec(pathname);
      const kind = m?.[1];
      const homeTag = m?.[2];
      const blindId = m?.[3];
      if (!m || (kind === 'home' && blindId !== undefined) || (kind === 'dev' && blindId === undefined)) {
        return void rejectUpgrade(socket, 404, 'invalid: iot-path: not an IoT endpoint (see SDK ADR 0049)'), true;
      }
      const h = homes.get(homeTag!);
      if (!h) return void rejectUpgrade(socket, 403, IOT_REALTIME_REJECT.home), true;
      if (kind === 'dev') {
        const auth = h.rt.authenticateDevice(blindId!, req.headers.authorization);
        if (!auth.ok) return void rejectUpgrade(socket, auth.status, auth.error), true;
        wss.handleUpgrade(req, socket, head, (ws) => {
          const old = h.devices.get(blindId!);
          if (old) old.ws.close(REPLACED_CLOSE, 'replaced');
          const slot = { ws, lastHb: Date.now() };
          h.devices.set(blindId!, slot);
          ws.on('ping', () => void (slot.lastHb = Date.now()));
          ws.on('message', (data, isBinary) => {
            const r = h.rt.onDeviceFrame(blindId!, isBinary ? new Uint8Array(data as Buffer) : data.toString());
            if (r.reply !== undefined) {
              slot.lastHb = Date.now();
              ws.send(r.reply);
            }
            for (const e of r.publish) dispatch(h, h.core.publishLocal(e));
          });
          const gone = (): void => {
            if (h.devices.get(blindId!) === slot) h.devices.delete(blindId!);
          };
          ws.on('close', gone);
          ws.on('error', gone);
        });
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const id = `iot${counter++}`;
        h.phones.set(id, ws);
        const host = (req.headers['x-forwarded-host'] ?? req.headers.host) as string | undefined;
        dispatch(h, h.core.connect(id, firstHost(host), req.socket.remoteAddress ?? undefined));
        // 名單公告（SDK ADR 0121）：重啟後 retained 在記憶體裡沒了，第一位手機連上時補發
        const announce = h.rt.aclAnnouncement();
        if (announce) dispatch(h, h.core.publishLocal(announce));
        ws.on('message', (data) => dispatch(h, h.core.handle(id, data.toString())));
        const gone = (): void => {
          h.core.disconnect(id);
          h.phones.delete(id);
        };
        ws.on('close', gone);
        ws.on('error', gone);
      });
      return true;
    },
    handleHttp(path) {
      if (!path.startsWith('/iot/')) return undefined;
      if (!enabled) return { status: 404, error: 'blocked: iot-disabled: this relay does not run the IoT realtime channel' };
      return { status: 426, error: 'invalid: iot-upgrade: WebSocket upgrade required' };
    },
    close() {
      for (const h of homes.values()) {
        for (const d of h.devices.values()) d.ws.terminate();
        for (const ws of h.phones.values()) ws.terminate();
      }
      wss.close();
    },
  };
}
