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
import { parseIotDownMessage, type IotDeviceAckStatus, type IotUpAck, type IotUpMessage } from './device-message.js';
import type { IotEncoding, IotTopicValue } from './content.js';
import { isValidIotTopic } from './topic.js';
import { IOT_QUOTA_CLOSE_CODE } from '../protocol/relay-reject.js';

export { parseIotDownMessage, parseIotUpMessage, IOT_DEVICE_ACK_STATUSES } from './device-message.js';
export type { IotDeviceAckStatus, IotDownCommand, IotDownMessage, IotDownQuery, IotUpAck, IotUpMessage, IotUpState } from './device-message.js';
export { generateIotDeviceToken, hashIotDeviceToken, IOT_DEVICE_HEARTBEAT, IOT_DEVICE_HEARTBEAT_ACK } from './device-frame.js';
export { deriveIotDeviceKeyDown, iotKid } from './envelope.js';

export const IOT_DEVICE_DEFAULT_HEARTBEAT_SEC = 30;
export const IOT_DEVICE_DEFAULT_HEARTBEAT_TIMEOUT_SEC = 10;
/** 設備端的時間窗（秒）：一般設備 ±60；門類建議設 15（§9.4） */
export const IOT_DEVICE_DEFAULT_MAX_SKEW_SEC = 60;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const SEEN_MAX = 256;

/** 最小的 WebSocket 介面（瀏覽器、Node 22+ 內建、`ws` 都符合） */
export interface IotDeviceSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** 開一條帶標頭的 WebSocket。預設用全域 `WebSocket`（Node 22+ 支援 `headers`；瀏覽器設不了 Authorization，要自己給） */
export type IotDeviceSocketFactory = (url: string, headers: Record<string, string>) => IotDeviceSocket;

/** up 計數器的持久化：`load` 回上次存的值（沒有＝0）；`save` 要真的寫到不會掉的地方再回來 */
export interface IotDeviceCounterStore {
  load(): number | Promise<number>;
  save(ctr: number): void | Promise<void>;
}

/** 測試與開發用：只在記憶體（重開機會從 0 開始——正式設備不要用） */
export function memoryIotDeviceCounterStore(initial = 0): IotDeviceCounterStore & { readonly value: number } {
  let value = initial;
  return {
    get value() {
      return value;
    },
    load: () => value,
    save: (ctr) => void (value = ctr),
  };
}

export interface IotDeviceCommand {
  readonly msgId: string;
  readonly topic: string;
  readonly payload: string;
  readonly enc: IotEncoding;
  readonly confirmed?: boolean;
}

/** topic → 值：字串＝utf8 酬載；物件可指定 `enc` */
export type IotDeviceStateInput = Readonly<Record<string, string | { readonly payload: string; readonly enc?: IotEncoding }>>;

export interface IotDeviceCommandResult {
  readonly status: IotDeviceAckStatus;
  readonly reason?: string;
  /** 執行後的狀態（會跟著 ack 一起回給下指令的人） */
  readonly state?: IotDeviceStateInput;
}

export type IotDeviceLinkState = 'connecting' | 'connected' | 'reconnecting' | 'quota-exhausted' | 'replaced' | 'relay-error' | 'closed';

export interface IotDeviceLinkInfo {
  readonly url: string;
  /** `quota-exhausted`：額度重置時間（unix 秒） */
  readonly reset?: number;
  /** 斷線的 close code */
  readonly code?: number;
  /** 下一次重連前等多久（毫秒） */
  readonly retryInMs?: number;
}

export interface IotDeviceOptions {
  url: string;
  /** 備援站（另一個 Cloudflare 帳號或家中 Node relay，§10.4）：斷線或額度用完時輪流換 */
  standbyUrls?: readonly string[];
  /** 設備權杖（`cit1_…`） */
  token: string;
  /** up 方向（以及 `query` 幀）的金鑰＝`deriveIotHome(homeSecret).deviceKey(id, epoch)` */
  deviceKey: Uint8Array;
  /** 門鎖類：`cmd` 幀的金鑰＝`deriveIotDeviceKeyDown(operatorSecret, id, epoch)`；沒給＝`cmd` 也用 `deviceKey` */
  deviceKeyDown?: Uint8Array;
  /** `<設備 id>.<epoch>` */
  kid: string;
  heartbeat?: { intervalSec?: number; timeoutSec?: number };
  /** 信封時間窗（秒），預設 60；門類建議 15 */
  maxSkewSec?: number;
  counterStore: IotDeviceCounterStore;
  /** 時鐘同步了沒（SNTP）；回 false 時拒絕所有指令（fail-closed，§9.4）。沒給＝視為已同步 */
  clockSynced?: () => boolean;
  onCommand(cmd: IotDeviceCommand): IotDeviceCommandResult | Promise<IotDeviceCommandResult>;
  /** 回答查詢：目前所有 topic 的值。沒給＝查詢回 `ok`、不帶狀態 */
  onQuery?: () => IotDeviceStateInput | Promise<IotDeviceStateInput>;
  onLinkState?: (state: IotDeviceLinkState, info: IotDeviceLinkInfo) => void;
  onError?: (error: unknown) => void;
  webSocket?: IotDeviceSocketFactory;
  /** 毫秒 */
  now?: () => number;
  /** 重連退避（毫秒），預設 1,000–60,000 */
  reconnect?: { minMs?: number; maxMs?: number };
}

export interface IotDeviceConnection {
  readonly state: IotDeviceLinkState;
  /** 回報狀態（25172；relay 另外每 5 分鐘最多寫一次 retained）。沒有連線時回 false（即時通道不排隊） */
  publishState(state: IotDeviceStateInput, opts?: { will?: boolean }): Promise<boolean>;
  close(): void;
}

function defaultSocketFactory(): IotDeviceSocketFactory {
  const Ctor = (globalThis as { WebSocket?: new (url: string, init?: unknown) => IotDeviceSocket }).WebSocket;
  if (!Ctor) throw new Error('這個環境沒有全域 WebSocket（Node 22 以上才有）：請以 webSocket 選項給一個（例如 `ws`）');
  return (url, headers) => new Ctor(url, { headers });
}

function textOf(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (Array.isArray(data)) {
    // `ws` 的分片訊息：自己接起來（不用 Node 的 Buffer）
    const parts = data as Uint8Array[];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) out.set(p, (at += p.length) - p.length);
    return new TextDecoder().decode(out);
  }
  return undefined;
}

/** 連上 relay 的 C′ 設備通道 */
export function connectIotDevice(opts: IotDeviceOptions): IotDeviceConnection {
  if (!IOT_DEVICE_TOKEN_PATTERN.test(opts.token)) throw new RangeError('設備權杖格式不對（應為 cit1_ 開頭）');
  if (!parseIotKid(opts.kid)) throw new RangeError(`kid 格式不對：${opts.kid}`);
  if (opts.deviceKey.length !== 32 || (opts.deviceKeyDown !== undefined && opts.deviceKeyDown.length !== 32)) throw new RangeError('設備金鑰必須是 32 bytes');
  const urls = [opts.url, ...(opts.standbyUrls ?? [])];
  const factory = opts.webSocket ?? defaultSocketFactory();
  const now = opts.now ?? Date.now;
  const hbMs = Math.max(1, opts.heartbeat?.intervalSec ?? IOT_DEVICE_DEFAULT_HEARTBEAT_SEC) * 1000;
  const hbTimeoutMs = Math.max(1, opts.heartbeat?.timeoutSec ?? IOT_DEVICE_DEFAULT_HEARTBEAT_TIMEOUT_SEC) * 1000;
  const skewSec = Math.max(1, opts.maxSkewSec ?? IOT_DEVICE_DEFAULT_MAX_SKEW_SEC);
  const minMs = Math.max(1, opts.reconnect?.minMs ?? RECONNECT_MIN_MS);
  const maxMs = Math.max(minMs, opts.reconnect?.maxMs ?? RECONNECT_MAX_MS);

  let state: IotDeviceLinkState = 'connecting';
  let socket: IotDeviceSocket | undefined;
  let urlIndex = 0;
  let failures = 0;
  let closed = false;
  let hbTimer: ReturnType<typeof setTimeout> | undefined;
  let hbDeadline: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 已處理的 msgId → 回過的 ack（重送回同一個，不再執行） */
  const seen = new Map<string, { exp: number; ack?: IotUpAck }>();
  // 計數器：先載入，所有送出都排在同一條鏈上（嚴格遞增、先存再送）
  let ctr: number | undefined;
  let chain: Promise<unknown> = Promise.resolve(opts.counterStore.load()).then((v) => {
    ctr = Number.isSafeInteger(v) && v >= 0 ? v : 0;
  });

  const report = (next: IotDeviceLinkState, info: Omit<IotDeviceLinkInfo, 'url'> = {}): void => {
    state = next;
    try {
      opts.onLinkState?.(next, { url: urls[urlIndex]!, ...info });
    } catch (error) {
      opts.onError?.(error);
    }
  };

  const stopHeartbeat = (): void => {
    if (hbTimer !== undefined) clearTimeout(hbTimer);
    if (hbDeadline !== undefined) clearTimeout(hbDeadline);
    hbTimer = hbDeadline = undefined;
  };

  const armHeartbeat = (ws: IotDeviceSocket): void => {
    stopHeartbeat();
    hbTimer = setTimeout(() => {
      if (socket !== ws) return;
      try {
        ws.send(IOT_DEVICE_HEARTBEAT);
      } catch {
        // 送不出去：等 deadline 判死
      }
      hbDeadline = setTimeout(() => {
        if (socket === ws) ws.close(4000, 'heartbeat timeout');
      }, hbTimeoutMs);
    }, hbMs);
  };

  const send = (ws: IotDeviceSocket, message: IotUpMessage): Promise<boolean> => {
    const run = chain.then(async () => {
      if (socket !== ws || ws.readyState !== 1) return false;
      const next = ctr! + 1;
      await opts.counterStore.save(next);
      ctr = next;
      const env = sealIotEnvelope({ key: opts.deviceKey, kid: opts.kid, dir: 'up', ctr: next, ts: Math.floor(now() / 1000), plaintext: JSON.stringify(message) });
      ws.send(encodeIotDeviceFrame({ t: message.type, env }));
      return true;
    });
    chain = run.catch((error) => opts.onError?.(error));
    return run.catch(() => false);
  };

  const onFrame = async (ws: IotDeviceSocket, text: string): Promise<void> => {
    if (text === IOT_DEVICE_HEARTBEAT_ACK) {
      if (hbDeadline !== undefined) clearTimeout(hbDeadline);
      hbDeadline = undefined;
      armHeartbeat(ws);
      return;
    }
    const frame = parseIotDeviceFrame(text, 'relay');
    if (!frame || frame.t === 'hb' || (frame.t !== 'cmd' && frame.t !== 'query')) return;
    const env = frame.env;
    if (env.kid !== opts.kid) return;
    const key = frame.t === 'cmd' ? (opts.deviceKeyDown ?? opts.deviceKey) : opts.deviceKey;
    let plaintext: Uint8Array;
    try {
      plaintext = openIotEnvelope(env, key);
    } catch {
      return; // 解不開＝不是持有金鑰的人做的（或 viewer 偽造門鎖指令）：不回任何東西
    }
    const msg = parseIotDownMessage(plaintext);
    if (!msg || msg.type !== frame.t) return;
    const nowSec = Math.floor(now() / 1000);
    for (const [id, s] of seen) if (s.exp < nowSec - skewSec) seen.delete(id);
    const prior = seen.get(msg.msgId);
    if (prior) {
      if (prior.ack) await send(ws, prior.ack);
      return;
    }
    const reject = (reason: string): Promise<boolean> => send(ws, { type: 'ack', inReplyTo: msg.msgId, status: 'rejected', reason });
    if (opts.clockSynced && !opts.clockSynced()) return void (await reject('clock-unsynced'));
    if (Math.abs(env.ts - nowSec) > skewSec || msg.exp < nowSec) return void (await reject('expired'));
    seen.set(msg.msgId, { exp: msg.exp });
    while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
    let ack: IotUpAck;
    try {
      if (msg.type === 'cmd') {
        const r = await opts.onCommand({ msgId: msg.msgId, topic: msg.topic, payload: msg.payload, enc: msg.enc, ...(msg.confirmed !== undefined ? { confirmed: msg.confirmed } : {}) });
        ack = { type: 'ack', inReplyTo: msg.msgId, status: r.status, ...(r.reason !== undefined ? { reason: r.reason.slice(0, 200) } : {}), ...topicsOf(r.state, now()) };
      } else {
        const current = opts.onQuery ? await opts.onQuery() : undefined;
        ack = { type: 'ack', inReplyTo: msg.msgId, status: 'ok', ...topicsOf(current, now()) };
      }
    } catch (error) {
      opts.onError?.(error);
      ack = { type: 'ack', inReplyTo: msg.msgId, status: 'rejected', reason: 'device-error' };
    }
    seen.set(msg.msgId, { exp: msg.exp, ack });
    await send(ws, ack);
  };

  const schedule = (delayMs: number, next: IotDeviceLinkState, info: Omit<IotDeviceLinkInfo, 'url' | 'retryInMs'> = {}): void => {
    if (closed) return;
    report(next, { ...info, retryInMs: delayMs });
    retryTimer = setTimeout(open, delayMs);
  };

  const backoff = (): number => {
    const base = Math.min(maxMs, minMs * 2 ** Math.min(failures, 16));
    failures += 1;
    return Math.round(base / 2 + Math.random() * (base / 2)); // 抖動：一整批設備不要同時重連
  };

  function open(): void {
    if (closed) return;
    retryTimer = undefined;
    let ws: IotDeviceSocket;
    try {
      ws = factory(urls[urlIndex]!, { Authorization: `Bearer ${opts.token}` });
    } catch (error) {
      opts.onError?.(error);
      urlIndex = (urlIndex + 1) % urls.length;
      return schedule(backoff(), 'relay-error');
    }
    socket = ws;
    let wasOpen = false;
    ws.onopen = () => {
      if (socket !== ws) return;
      wasOpen = true;
      failures = 0;
      report('connected');
      armHeartbeat(ws);
    };
    ws.onmessage = (ev) => {
      if (socket !== ws) return;
      const text = textOf(ev.data);
      if (text !== undefined) onFrame(ws, text).catch((error) => opts.onError?.(error));
    };
    ws.onerror = () => {
      // 之後一定有 onclose；在那裡決定怎麼重連
    };
    ws.onclose = (ev) => {
      if (socket !== ws) return;
      socket = undefined;
      stopHeartbeat();
      if (closed) return;
      const quota = /^iot-quota:(\d{1,12})$/.exec(ev.reason ?? '');
      if (ev.code === IOT_QUOTA_CLOSE_CODE) {
        const reset = quota ? Number(quota[1]) : undefined;
        if (urls.length > 1) {
          urlIndex = (urlIndex + 1) % urls.length;
          return schedule(minMs, 'quota-exhausted', { code: ev.code, ...(reset !== undefined ? { reset } : {}) });
        }
        const wait = reset !== undefined ? Math.max(minMs, reset * 1000 - now() + Math.round(Math.random() * 60_000)) : maxMs;
        return schedule(wait, 'quota-exhausted', { code: ev.code, ...(reset !== undefined ? { reset } : {}) });
      }
      if (ev.code === 4409) return schedule(maxMs, 'replaced', { code: ev.code });
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
      if (!ws || state !== 'connected') return Promise.resolve(false);
      const { topics } = topicsOf(input, now());
      if (!topics) return Promise.resolve(false);
      return send(ws, { type: 'state', topics, ...(o.will !== undefined ? { will: o.will } : {}) });
    },
    close() {
      if (closed) return;
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      stopHeartbeat();
      const ws = socket;
      socket = undefined;
      ws?.close(1000, 'closed');
      report('closed');
    },
  };
}

function topicsOf(input: IotDeviceStateInput | undefined, nowMs: number): { topics?: Record<string, IotTopicValue> } {
  if (!input) return {};
  const topics: Record<string, IotTopicValue> = {};
  for (const [topic, value] of Object.entries(input)) {
    if (!isValidIotTopic(topic)) throw new RangeError(`topic 不合法：${topic}`);
    topics[topic] = typeof value === 'string' ? { payload: value, ts: nowMs } : { payload: value.payload, ...(value.enc !== undefined ? { enc: value.enc } : {}), ts: nowMs };
  }
  return Object.keys(topics).length > 0 ? { topics } : {};
}
