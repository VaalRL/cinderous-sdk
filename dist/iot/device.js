/**
 * `@cinderous/client/iot/device`（SDK ADR 0049 §9.6、SDK ADR 0120）：C′ 即時通道的**設備端**。中立、零 Node 內建模組——
 * Node／Home Assistant／瀏覽器型設備與測試用；ESP32 等韌體照同一套幀與信封自己實作（R3）。
 *
 * - 一條常駐的 WebSocket 連到 `/iot/v1/dev/<homeTag>/<blindId>`（`Authorization: Bearer <權杖>`），斷線以指數退避重連，
 *   有 `standbyUrls` 時輪流換站（§10.4）。
 * - 應用層心跳 `{"t":"hb"}`（預設每 30 秒）；`timeoutSec` 內沒收到 `{"t":"hb-ack"}` 就當作死線、重連（Cloudflare 可能不送 close frame）。
 * - 指令：解開 down 信封（門鎖類的 `cmd` 以 `deviceKeyDown`，`query` 一律 `deviceKey`）→ 信封時間在 `maxSkewSec` 之內、
 *   內容沒過期、時鐘已同步（fail-closed）→ msgId 去重（重送回同一個 ack，不再執行）→ `onCommand` → up 信封的 `ack`。
 * - up 信封的計數器嚴格遞增，**先存再送**（`counterStore`）——重開機後不會重用 nonce，也不會被手機與 relay 當成重放。
 * - relay 以 4429 `iot-quota:<reset>` 關連線＝今日額度用完：有備援站就換站，沒有就睡到重置時間，不狂重連（§10.2）。
 *   4409＝同一台設備的新連線把這條擠掉（權杖可能外洩）：退到最長的間隔再試，並以 `onLinkState('replaced')` 告知。
 */
import { openIotEnvelope, parseIotKid, sealIotEnvelope } from './envelope.js';
import { encodeIotDeviceFrame, IOT_DEVICE_HEARTBEAT, IOT_DEVICE_HEARTBEAT_ACK, IOT_DEVICE_TOKEN_PATTERN, parseIotDeviceFrame } from './device-frame.js';
import { parseIotDownMessage } from './device-message.js';
import { isValidIotTopic } from './topic.js';
export { parseIotDownMessage, parseIotUpMessage, IOT_DEVICE_ACK_STATUSES } from './device-message.js';
export { generateIotDeviceToken, hashIotDeviceToken, IOT_DEVICE_HEARTBEAT, IOT_DEVICE_HEARTBEAT_ACK } from './device-frame.js';
export { deriveIotDeviceKeyDown, iotKid } from './envelope.js';
export const IOT_DEVICE_DEFAULT_HEARTBEAT_SEC = 30;
export const IOT_DEVICE_DEFAULT_HEARTBEAT_TIMEOUT_SEC = 10;
/** 設備端的時間窗（秒）：一般設備 ±60；門類建議設 15（§9.4） */
export const IOT_DEVICE_DEFAULT_MAX_SKEW_SEC = 60;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const SEEN_MAX = 256;
/** 測試與開發用：只在記憶體（重開機會從 0 開始——正式設備不要用） */
export function memoryIotDeviceCounterStore(initial = 0) {
    let value = initial;
    return {
        get value() {
            return value;
        },
        load: () => value,
        save: (ctr) => void (value = ctr),
    };
}
function defaultSocketFactory() {
    const Ctor = globalThis.WebSocket;
    if (!Ctor)
        throw new Error('這個環境沒有全域 WebSocket（Node 22 以上才有）：請以 webSocket 選項給一個（例如 `ws`）');
    return (url, headers) => new Ctor(url, { headers });
}
function textOf(data) {
    if (typeof data === 'string')
        return data;
    if (data instanceof Uint8Array)
        return new TextDecoder().decode(data);
    if (data instanceof ArrayBuffer)
        return new TextDecoder().decode(new Uint8Array(data));
    if (Array.isArray(data)) {
        // `ws` 的分片訊息：自己接起來（不用 Node 的 Buffer）
        const parts = data;
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts)
            out.set(p, (at += p.length) - p.length);
        return new TextDecoder().decode(out);
    }
    return undefined;
}
/** 連上 relay 的 C′ 設備通道 */
export function connectIotDevice(opts) {
    if (!IOT_DEVICE_TOKEN_PATTERN.test(opts.token))
        throw new RangeError('設備權杖格式不對（應為 cit1_ 開頭）');
    if (!parseIotKid(opts.kid))
        throw new RangeError(`kid 格式不對：${opts.kid}`);
    if (opts.deviceKey.length !== 32 || (opts.deviceKeyDown !== undefined && opts.deviceKeyDown.length !== 32))
        throw new RangeError('設備金鑰必須是 32 bytes');
    const urls = [opts.url, ...(opts.standbyUrls ?? [])];
    const factory = opts.webSocket ?? defaultSocketFactory();
    const now = opts.now ?? Date.now;
    const hbMs = Math.max(1, opts.heartbeat?.intervalSec ?? IOT_DEVICE_DEFAULT_HEARTBEAT_SEC) * 1000;
    const hbTimeoutMs = Math.max(1, opts.heartbeat?.timeoutSec ?? IOT_DEVICE_DEFAULT_HEARTBEAT_TIMEOUT_SEC) * 1000;
    const skewSec = Math.max(1, opts.maxSkewSec ?? IOT_DEVICE_DEFAULT_MAX_SKEW_SEC);
    const minMs = Math.max(1, opts.reconnect?.minMs ?? RECONNECT_MIN_MS);
    const maxMs = Math.max(minMs, opts.reconnect?.maxMs ?? RECONNECT_MAX_MS);
    let state = 'connecting';
    let socket;
    let urlIndex = 0;
    let failures = 0;
    let closed = false;
    let hbTimer;
    let hbDeadline;
    let retryTimer;
    /** 已處理的 msgId → 回過的 ack（重送回同一個，不再執行） */
    const seen = new Map();
    // 計數器：先載入，所有送出都排在同一條鏈上（嚴格遞增、先存再送）
    let ctr;
    let chain = Promise.resolve(opts.counterStore.load()).then((v) => {
        ctr = Number.isSafeInteger(v) && v >= 0 ? v : 0;
    });
    const report = (next, info = {}) => {
        state = next;
        try {
            opts.onLinkState?.(next, { url: urls[urlIndex], ...info });
        }
        catch (error) {
            opts.onError?.(error);
        }
    };
    const stopHeartbeat = () => {
        if (hbTimer !== undefined)
            clearTimeout(hbTimer);
        if (hbDeadline !== undefined)
            clearTimeout(hbDeadline);
        hbTimer = hbDeadline = undefined;
    };
    const armHeartbeat = (ws) => {
        stopHeartbeat();
        hbTimer = setTimeout(() => {
            if (socket !== ws)
                return;
            try {
                ws.send(IOT_DEVICE_HEARTBEAT);
            }
            catch {
                // 送不出去：等 deadline 判死
            }
            hbDeadline = setTimeout(() => {
                if (socket === ws)
                    ws.close(4000, 'heartbeat timeout');
            }, hbTimeoutMs);
        }, hbMs);
    };
    const send = (ws, message) => {
        const run = chain.then(async () => {
            if (socket !== ws || ws.readyState !== 1)
                return false;
            const next = ctr + 1;
            await opts.counterStore.save(next);
            ctr = next;
            const env = sealIotEnvelope({ key: opts.deviceKey, kid: opts.kid, dir: 'up', ctr: next, ts: Math.floor(now() / 1000), plaintext: JSON.stringify(message) });
            ws.send(encodeIotDeviceFrame({ t: message.type, env }));
            return true;
        });
        chain = run.catch((error) => opts.onError?.(error));
        return run.catch(() => false);
    };
    const onFrame = async (ws, text) => {
        if (text === IOT_DEVICE_HEARTBEAT_ACK) {
            if (hbDeadline !== undefined)
                clearTimeout(hbDeadline);
            hbDeadline = undefined;
            armHeartbeat(ws);
            return;
        }
        const frame = parseIotDeviceFrame(text, 'relay');
        if (!frame || frame.t === 'hb' || (frame.t !== 'cmd' && frame.t !== 'query'))
            return;
        const env = frame.env;
        if (env.kid !== opts.kid)
            return;
        const key = frame.t === 'cmd' ? (opts.deviceKeyDown ?? opts.deviceKey) : opts.deviceKey;
        let plaintext;
        try {
            plaintext = openIotEnvelope(env, key);
        }
        catch {
            return; // 解不開＝不是持有金鑰的人做的（或 viewer 偽造門鎖指令）：不回任何東西
        }
        const msg = parseIotDownMessage(plaintext);
        if (!msg || msg.type !== frame.t)
            return;
        const nowSec = Math.floor(now() / 1000);
        for (const [id, s] of seen)
            if (s.exp < nowSec - skewSec)
                seen.delete(id);
        const prior = seen.get(msg.msgId);
        if (prior) {
            if (prior.ack)
                await send(ws, prior.ack);
            return;
        }
        const reject = (reason) => send(ws, { type: 'ack', inReplyTo: msg.msgId, status: 'rejected', reason });
        if (opts.clockSynced && !opts.clockSynced())
            return void (await reject('clock-unsynced'));
        if (Math.abs(env.ts - nowSec) > skewSec || msg.exp < nowSec)
            return void (await reject('expired'));
        seen.set(msg.msgId, { exp: msg.exp });
        while (seen.size > SEEN_MAX)
            seen.delete(seen.keys().next().value);
        let ack;
        try {
            if (msg.type === 'cmd') {
                const r = await opts.onCommand({ msgId: msg.msgId, topic: msg.topic, payload: msg.payload, enc: msg.enc, ...(msg.confirmed !== undefined ? { confirmed: msg.confirmed } : {}) });
                ack = { type: 'ack', inReplyTo: msg.msgId, status: r.status, ...(r.reason !== undefined ? { reason: r.reason.slice(0, 200) } : {}), ...topicsOf(r.state, now()) };
            }
            else {
                const current = opts.onQuery ? await opts.onQuery() : undefined;
                ack = { type: 'ack', inReplyTo: msg.msgId, status: 'ok', ...topicsOf(current, now()) };
            }
        }
        catch (error) {
            opts.onError?.(error);
            ack = { type: 'ack', inReplyTo: msg.msgId, status: 'rejected', reason: 'device-error' };
        }
        seen.set(msg.msgId, { exp: msg.exp, ack });
        await send(ws, ack);
    };
    const schedule = (delayMs, next, info = {}) => {
        if (closed)
            return;
        report(next, { ...info, retryInMs: delayMs });
        retryTimer = setTimeout(open, delayMs);
    };
    const backoff = () => {
        const base = Math.min(maxMs, minMs * 2 ** Math.min(failures, 16));
        failures += 1;
        return Math.round(base / 2 + Math.random() * (base / 2)); // 抖動：一整批設備不要同時重連
    };
    function open() {
        if (closed)
            return;
        retryTimer = undefined;
        let ws;
        try {
            ws = factory(urls[urlIndex], { Authorization: `Bearer ${opts.token}` });
        }
        catch (error) {
            opts.onError?.(error);
            urlIndex = (urlIndex + 1) % urls.length;
            return schedule(backoff(), 'relay-error');
        }
        socket = ws;
        let wasOpen = false;
        ws.onopen = () => {
            if (socket !== ws)
                return;
            wasOpen = true;
            failures = 0;
            report('connected');
            armHeartbeat(ws);
        };
        ws.onmessage = (ev) => {
            if (socket !== ws)
                return;
            const text = textOf(ev.data);
            if (text !== undefined)
                onFrame(ws, text).catch((error) => opts.onError?.(error));
        };
        ws.onerror = () => {
            // 之後一定有 onclose；在那裡決定怎麼重連
        };
        ws.onclose = (ev) => {
            if (socket !== ws)
                return;
            socket = undefined;
            stopHeartbeat();
            if (closed)
                return;
            const quota = /^iot-quota:(\d{1,12})$/.exec(ev.reason ?? '');
            if (ev.code === 4429) {
                const reset = quota ? Number(quota[1]) : undefined;
                if (urls.length > 1) {
                    urlIndex = (urlIndex + 1) % urls.length;
                    return schedule(minMs, 'quota-exhausted', { code: ev.code, ...(reset !== undefined ? { reset } : {}) });
                }
                const wait = reset !== undefined ? Math.max(minMs, reset * 1000 - now() + Math.round(Math.random() * 60_000)) : maxMs;
                return schedule(wait, 'quota-exhausted', { code: ev.code, ...(reset !== undefined ? { reset } : {}) });
            }
            if (ev.code === 4409)
                return schedule(maxMs, 'replaced', { code: ev.code });
            if (!wasOpen) {
                // 升級失敗（權杖錯、站不認得、網路不通）：換下一站再試
                urlIndex = (urlIndex + 1) % urls.length;
                return schedule(backoff(), 'relay-error', { code: ev.code });
            }
            schedule(backoff(), 'reconnecting', { code: ev.code });
        };
    }
    report('connecting');
    open();
    return {
        get state() {
            return state;
        },
        publishState(input, o = {}) {
            const ws = socket;
            if (!ws || state !== 'connected')
                return Promise.resolve(false);
            const { topics } = topicsOf(input, now());
            if (!topics)
                return Promise.resolve(false);
            return send(ws, { type: 'state', topics, ...(o.will !== undefined ? { will: o.will } : {}) });
        },
        close() {
            if (closed)
                return;
            closed = true;
            if (retryTimer !== undefined)
                clearTimeout(retryTimer);
            stopHeartbeat();
            const ws = socket;
            socket = undefined;
            ws?.close(1000, 'closed');
            report('closed');
        },
    };
}
function topicsOf(input, nowMs) {
    if (!input)
        return {};
    const topics = {};
    for (const [topic, value] of Object.entries(input)) {
        if (!isValidIotTopic(topic))
            throw new RangeError(`topic 不合法：${topic}`);
        topics[topic] = typeof value === 'string' ? { payload: value, ts: nowMs } : { payload: value.payload, ...(value.enc !== undefined ? { enc: value.enc } : {}), ts: nowMs };
    }
    return Object.keys(topics).length > 0 ? { topics } : {};
}
//# sourceMappingURL=device.js.map