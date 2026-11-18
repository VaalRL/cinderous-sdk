import { WebSocketServer } from 'ws';
import { parseIotAcl } from '../iot/acl.js';
import { IOT_KIND_ACK, IOT_KIND_COMMAND, IOT_KIND_HEARTBEAT, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_STATE } from '../iot/kinds.js';
import { firstHost } from './host-config.js';
import { IOT_DEVICE_FRAME_MAX_BYTES, parseIotDeviceFrame } from '../iot/device-frame.js';
import { iotLongPollWaitSec, iotPlaintextFrom, IotRealtimeHome, IOT_REALTIME_REJECT, parseIotRealtimeConfig } from './iot-realtime.js';
import { IotShellyTranslator } from './iot-shelly.js';
import { IOT_REALTIME_ADDRESSABLE_PER_AUTHOR } from './iot-realtime-config.js';
import { MessageStore } from './message-store.js';
import { closeSignalOf, RelayCore } from './relay-core.js';
const IOT_PHONE_KINDS = [IOT_KIND_COMMAND, IOT_KIND_ACK, IOT_KIND_STATE, IOT_KIND_QUERY, IOT_KIND_RETAINED, IOT_KIND_HEARTBEAT];
const REPLACED_CLOSE = 4409;
const PATH = /^\/iot\/v1\/(home|dev|shelly)\/([A-Za-z0-9_-]{22})(?:\/([A-Za-z0-9_-]{22}))?\/?$/;
/** 長輪詢的端點（SDK ADR 0138） */
const LONGPOLL_PATH = /^\/iot\/v1\/dev\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{22})\/(next|ack|state)\/?$/;
const STATUS_TEXT = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 426: 'Upgrade Required' };
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'Cinder-Relay': '1' };
function httpError(res, status, error, headers = {}) {
    if (res.headersSent)
        return void res.end();
    res.writeHead(status, { ...JSON_HEADERS, ...headers });
    res.end(JSON.stringify({ error }));
}
/** 在 socket 上直接回一個 HTTP 錯誤（升級被拒）：JSON＋`Cinder-Relay: 1` */
function rejectUpgrade(socket, status, error) {
    const body = JSON.stringify({ error });
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
        'Content-Type: application/json; charset=utf-8\r\nCinder-Relay: 1\r\nConnection: close\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.destroy();
}
/**
 * 建立 Node 的 IoT 集線器。`IOT_REALTIME` 沒設＝回傳的集線器對所有 `/iot/` 回 404 `blocked: iot-disabled:`（與 Workers 版相同）。
 * `exec` 給了就把角色名單存進 `iot_acl` 表。
 */
export function createIotNodeHub(env, opts = {}) {
    const wss = new WebSocketServer({ noServer: true });
    const homes = new Map();
    let enabled = false;
    if (env.IOT_REALTIME) {
        let raw;
        let keys = {};
        try {
            raw = JSON.parse(env.IOT_REALTIME);
            keys = env.IOT_GATEWAY_KEYS ? JSON.parse(env.IOT_GATEWAY_KEYS) : {};
        }
        catch {
            raw = undefined;
        }
        const parsed = parseIotRealtimeConfig(raw, keys, iotPlaintextFrom(env));
        // 🔴 自架站的設定錯誤要讓人看見；只印路徑與代碼（不印值）
        if (parsed.issues.length > 0)
            console.warn(`IOT_REALTIME 有 ${parsed.issues.length} 個問題，相關家庭不啟用：${parsed.issues.map((i) => `${i.path}(${i.code})`).join(', ')}`);
        const exec = opts.exec;
        exec?.('CREATE TABLE IF NOT EXISTS iot_acl (home TEXT PRIMARY KEY, acl TEXT NOT NULL)');
        for (const [homeTag, entry] of parsed.homes) {
            const phones = new Map();
            const devices = new Map();
            let rtRef;
            const plaintextKeys = entry.plaintextKeys;
            const sockets = {
                isConnected: (b) => devices.has(b),
                lastHeartbeatMs: (b) => {
                    const d = devices.get(b);
                    return d?.kind === 'ws' ? d.lastHb : undefined;
                },
                transportOf: (b) => devices.get(b)?.kind,
                send: (b, text) => {
                    const d = devices.get(b);
                    if (!d)
                        return false;
                    if (d.kind === 'longpoll') {
                        // 一輪只回一個幀
                        devices.delete(b);
                        clearTimeout(d.timer);
                        d.res.writeHead(200, JSON_HEADERS);
                        d.res.end(text);
                        rtRef?.longPollEnded(b);
                        return true;
                    }
                    if (d.ws.readyState !== d.ws.OPEN)
                        return false;
                    if (d.kind === 'shelly') {
                        const out = d.translator.fromRelay(text);
                        for (const rpc of out.toDevice)
                            d.ws.send(rpc);
                        // 馬上能回答的 up（不認得的 topic、過期）晚一拍再交給核心：現在還在核心處理手機訊息的途中
                        if (out.up.length > 0)
                            queueMicrotask(() => feedUp(homeTag, b, out.up));
                        return true;
                    }
                    d.ws.send(text);
                    return true;
                },
            };
            const aclStore = exec
                ? {
                    load: () => {
                        const row = exec('SELECT acl FROM iot_acl WHERE home = ?', homeTag)[0];
                        if (!row)
                            return undefined;
                        try {
                            return parseIotAcl(JSON.parse(String(row.acl)));
                        }
                        catch {
                            return undefined;
                        }
                    },
                    save: (acl) => void exec('INSERT INTO iot_acl (home, acl) VALUES (?, ?) ON CONFLICT(home) DO UPDATE SET acl = excluded.acl', homeTag, JSON.stringify(acl)),
                }
                : undefined;
            const rt = new IotRealtimeHome(entry.config, entry.gatewaySecret, { sockets, ...(aclStore ? { aclStore } : {}) });
            rtRef = rt;
            const core = new RelayCore({
                store: new MessageStore({ addressablePerAuthor: IOT_REALTIME_ADDRESSABLE_PER_AUTHOR }),
                allowedKinds: IOT_PHONE_KINDS,
                maxEventsPerMinute: 60,
                maxFutureSkewSec: 60,
                maxPastSkewSec: 300,
                replayWindowSec: 300,
                intercept: (connId, event, authed) => {
                    const r = rt.interceptPhoneEvent(connId, event, authed);
                    return r ? [...r.outbound, ...r.publish.flatMap((e) => core.publishLocal(e))] : undefined;
                },
            });
            homes.set(homeTag, { rt, core, phones, devices, plaintextKeys });
        }
        enabled = homes.size > 0;
    }
    const dispatch = (h, out) => {
        for (const { to, message, close } of out) {
            const ws = h.phones.get(to);
            if (!ws || ws.readyState !== ws.OPEN)
                continue;
            ws.send(JSON.stringify(message));
            if (close) {
                const { code, reason } = closeSignalOf(close);
                ws.close(code, reason);
            }
        }
    };
    /** Shelly 轉譯出來的 up 幀交給家庭核心（與 E2EE 設備的幀走同一條路） */
    function feedUp(homeTag, blindId, frames) {
        const h = homes.get(homeTag);
        if (!h)
            return;
        for (const frame of frames)
            for (const e of h.rt.onDeviceFrame(blindId, frame).publish)
                dispatch(h, h.core.publishLocal(e));
    }
    /** 把舊的那條讓出來（4409／409 replaced） */
    const replace = (h, blindId) => {
        const old = h.devices.get(blindId);
        if (!old)
            return;
        h.devices.delete(blindId);
        if (old.kind === 'ws' || old.kind === 'shelly')
            return void old.ws.close(REPLACED_CLOSE, 'replaced');
        clearTimeout(old.timer);
        httpError(old.res, 409, 'restricted: iot-replaced: another connection for this device took over (token leaked?)');
    };
    /** 長輪詢的三個端點（SDK ADR 0138） */
    const longPoll = (h, blindId, op, req, res) => {
        const auth = h.rt.authenticateDevice(blindId, req.headers.authorization);
        if (!auth.ok)
            return httpError(res, auth.status, auth.error);
        if (auth.device.transport === 'shelly')
            return httpError(res, 404, IOT_REALTIME_REJECT.device);
        if (op === 'next') {
            if (req.method !== 'GET')
                return httpError(res, 405, 'invalid: iot-method: GET /next to wait for the next frame', { Allow: 'GET' });
            const held = h.rt.longPollStart(blindId);
            if (held !== undefined) {
                res.writeHead(200, JSON_HEADERS);
                return void res.end(held);
            }
            replace(h, blindId);
            const wait = iotLongPollWaitSec(new URL(req.url ?? '/', 'http://x').searchParams.get('wait'));
            const slot = {
                kind: 'longpoll',
                res,
                timer: setTimeout(() => {
                    if (h.devices.get(blindId) !== slot)
                        return;
                    h.devices.delete(blindId);
                    res.writeHead(204, { 'Cinder-Relay': '1' });
                    res.end();
                    h.rt.longPollEnded(blindId);
                }, wait * 1000),
            };
            h.devices.set(blindId, slot);
            // 設備那頭斷了（或反向代理逾時）：開始算空檔
            res.on('close', () => {
                if (h.devices.get(blindId) !== slot)
                    return;
                h.devices.delete(blindId);
                clearTimeout(slot.timer);
                h.rt.longPollEnded(blindId);
            });
            return;
        }
        if (req.method !== 'POST')
            return httpError(res, 405, `invalid: iot-method: POST the device frame to /${op}`, { Allow: 'POST' });
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size <= IOT_DEVICE_FRAME_MAX_BYTES)
                chunks.push(c);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const frame = size <= IOT_DEVICE_FRAME_MAX_BYTES ? parseIotDeviceFrame(text, 'device') : undefined;
            if (!frame || frame.t !== op)
                return httpError(res, 400, `invalid: iot-frame: the body must be one device frame with t="${op}"`);
            // 解不開的信封照樣回 204（不給 oracle）
            for (const e of h.rt.onDeviceFrame(blindId, text).publish)
                dispatch(h, h.core.publishLocal(e));
            res.writeHead(204, { 'Cinder-Relay': '1' });
            res.end();
        });
    };
    let counter = 0;
    return {
        handleUpgrade(req, socket, head) {
            const pathname = (req.url ?? '/').split('?')[0] ?? '/';
            if (!pathname.startsWith('/iot/'))
                return false;
            if (!enabled)
                return void rejectUpgrade(socket, 404, 'blocked: iot-disabled: this relay does not run the IoT realtime channel'), true;
            const m = PATH.exec(pathname);
            const kind = m?.[1];
            const homeTag = m?.[2];
            const blindId = m?.[3];
            if (!m || (kind === 'home' && blindId !== undefined) || (kind !== 'home' && blindId === undefined)) {
                return void rejectUpgrade(socket, 404, 'invalid: iot-path: not an IoT endpoint (see SDK ADR 0049)'), true;
            }
            const h = homes.get(homeTag);
            if (!h)
                return void rejectUpgrade(socket, 403, IOT_REALTIME_REJECT.home), true;
            if (kind === 'shelly') {
                // Shelly 設不了標頭：權杖放網址（會進存取記錄——SDK ADR 0139 的已知風險）
                const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
                const auth = h.rt.authenticateDevice(blindId, req.headers.authorization ?? (token ? `Bearer ${token}` : undefined));
                if (!auth.ok)
                    return void rejectUpgrade(socket, auth.status, auth.error), true;
                const key = auth.device.transport === 'shelly' ? h.plaintextKeys.get(auth.device.id) : undefined;
                if (!key)
                    return void rejectUpgrade(socket, 404, IOT_REALTIME_REJECT.device), true;
                wss.handleUpgrade(req, socket, head, (ws) => {
                    replace(h, blindId);
                    const slot = { kind: 'shelly', ws, translator: new IotShellyTranslator({ device: auth.device, deviceKey: key }) };
                    h.devices.set(blindId, slot);
                    ws.on('message', (data) => {
                        const out = slot.translator.fromDevice(data.toString());
                        for (const rpc of out.toDevice)
                            ws.send(rpc);
                        feedUp(homeTag, blindId, out.up);
                    });
                    const gone = () => {
                        if (h.devices.get(blindId) === slot)
                            h.devices.delete(blindId);
                    };
                    ws.on('close', gone);
                    ws.on('error', gone);
                });
                return true;
            }
            if (kind === 'dev') {
                const auth = h.rt.authenticateDevice(blindId, req.headers.authorization);
                if (!auth.ok)
                    return void rejectUpgrade(socket, auth.status, auth.error), true;
                if (auth.device.transport === 'shelly')
                    return void rejectUpgrade(socket, 404, IOT_REALTIME_REJECT.device), true;
                wss.handleUpgrade(req, socket, head, (ws) => {
                    replace(h, blindId);
                    const slot = { kind: 'ws', ws, lastHb: Date.now() };
                    h.devices.set(blindId, slot);
                    ws.on('ping', () => void (slot.lastHb = Date.now()));
                    ws.on('message', (data, isBinary) => {
                        const r = h.rt.onDeviceFrame(blindId, isBinary ? new Uint8Array(data) : data.toString());
                        if (r.reply !== undefined) {
                            slot.lastHb = Date.now();
                            ws.send(r.reply);
                        }
                        for (const e of r.publish)
                            dispatch(h, h.core.publishLocal(e));
                    });
                    const gone = () => {
                        if (h.devices.get(blindId) === slot)
                            h.devices.delete(blindId);
                    };
                    ws.on('close', gone);
                    ws.on('error', gone);
                });
                return true;
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
                const id = `iot${counter++}`;
                h.phones.set(id, ws);
                const host = (req.headers['x-forwarded-host'] ?? req.headers.host);
                dispatch(h, h.core.connect(id, firstHost(host), req.socket.remoteAddress ?? undefined));
                // 名單公告（SDK ADR 0121）：重啟後 retained 在記憶體裡沒了，第一位手機連上時補發
                const announce = h.rt.aclAnnouncement();
                if (announce)
                    dispatch(h, h.core.publishLocal(announce));
                ws.on('message', (data) => dispatch(h, h.core.handle(id, data.toString())));
                const gone = () => {
                    h.core.disconnect(id);
                    h.phones.delete(id);
                };
                ws.on('close', gone);
                ws.on('error', gone);
            });
            return true;
        },
        handleHttp(req, res) {
            const path = (req.url ?? '/').split('?')[0] ?? '/';
            if (!path.startsWith('/iot/'))
                return false;
            if (!enabled)
                return httpError(res, 404, 'blocked: iot-disabled: this relay does not run the IoT realtime channel'), true;
            const lp = LONGPOLL_PATH.exec(path);
            if (lp) {
                const h = homes.get(lp[1]);
                if (!h)
                    return httpError(res, 403, IOT_REALTIME_REJECT.home), true;
                return longPoll(h, lp[2], lp[3], req, res), true;
            }
            return httpError(res, 426, 'invalid: iot-upgrade: WebSocket upgrade required', { Upgrade: 'websocket' }), true;
        },
        close() {
            for (const h of homes.values()) {
                for (const d of h.devices.values()) {
                    if (d.kind === 'ws' || d.kind === 'shelly')
                        d.ws.terminate();
                    else {
                        clearTimeout(d.timer);
                        d.res.destroy();
                    }
                }
                for (const ws of h.phones.values())
                    ws.terminate();
            }
            wss.close();
        },
    };
}
//# sourceMappingURL=iot-node.js.map