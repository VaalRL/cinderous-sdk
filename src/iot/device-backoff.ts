// 設備端：斷線分類與重連間隔（SDK ADR 0049 §10.2；SDK ADR 0140）。純函式、零 Node 內建模組。
//
// 韌體（ESP-IDF、ESPHome、Tasmota Berry、Python）照 `tests/vectors/iot/device-v1.json` 的 `backoff` 向量實作同一套規則，
// 重點是「額度用完」與「中繼故障／網路斷」分開處理——用固定 10 秒重連在額度用完時會把隔天的額度也燒掉（§10.2 估算）。
//
//   觀察                                                       分類
//   relay（Cinder-Relay: 1）503＋Cinder-Quota                  quota-exhausted（reset＝本文 reset，否則 now＋Retry-After）
//   平台（沒有 Cinder-Relay）429＋本文含 1027                   quota-exhausted（reset＝下一個 UTC 00:00）
//   relay 401／403／404／409／426（iot-token、iot-home…）       config-error
//   其他 relay 錯誤、平台 5xx、1101／1102                       relay-error（relay 給了 Retry-After 就當下限）
//   close 4429 `iot-quota:<reset>`                              quota-exhausted
//   close 4409                                                  replaced（同一台設備的新連線把這條擠掉）
//   其他 close、DNS／TCP／TLS 失敗、心跳逾時                    network-down（重連的回應才決定是哪一類）
//
// 間隔（毫秒，`random` ∈ [0, 1)，兩次嘗試至少隔 1 秒）：
//   quota-exhausted：時鐘已同步且知道 reset ⇒ (reset − now) 秒＋random × 20 分鐘；否則 60 分鐘探測一次
//   config-error：60 分鐘；replaced：60 秒
//   relay-error：min(10 分鐘, 5 秒 × 2^attempt) × (0.7 + 0.6 × random)，不小於 Retry-After
//   network-down：min(60 秒, 1 秒 × 2^attempt) × (0.7 + 0.6 × random)
//   任何類別最後都夾在 [1 秒, 25 小時]；relay-error 連同 Retry-After 最多 60 分鐘（程式碼審查 2026-11-18：
//   惡意或有 bug 的 relay 給很遠的 reset／很大的 Retry-After 不能讓設備睡好幾天，JS 的 setTimeout 超過 2^31−1 毫秒還會溢位成立刻重連）
// attempt、random 不是有限數就當 0。
// 乘法順序固定（先夾上限、再乘抖動、最後取整數），JavaScript 與 Python 的倍精度結果逐位相同。

/** 斷線的分類（ADR 0049 §10.2） */
export type IotDeviceDisconnectClass = 'quota-exhausted' | 'config-error' | 'relay-error' | 'network-down' | 'replaced';

/** 設備看到的現象 */
export type IotDeviceObservation =
  /** 升級（或 HTTP 輪詢）被拒：狀態碼、標頭（名稱不分大小寫）、本文 */
  | { readonly kind: 'http'; readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }
  /** WebSocket 被關（含已連上後被關） */
  | { readonly kind: 'close'; readonly code: number; readonly reason?: string }
  /** DNS、TCP、TLS 失敗；連不上預設閘道 */
  | { readonly kind: 'network' }
  /** 心跳逾時（連線已死、可能沒有 close frame） */
  | { readonly kind: 'heartbeat-timeout' };

export interface IotDeviceDisconnect {
  readonly class: IotDeviceDisconnectClass;
  /** 額度重置時間（unix 秒） */
  readonly reset?: number;
  /** relay 的 `Retry-After`（秒） */
  readonly retryAfterSec?: number;
}

export interface IotDeviceRetryContext {
  /** 同一類連續失敗了幾次（第一次＝0） */
  readonly attempt: number;
  /** unix 秒 */
  readonly nowSec: number;
  /** 時鐘已同步（SNTP）；沒同步時不信 reset，改成每 60 分鐘探測 */
  readonly clockSynced: boolean;
  /** [0, 1) 的亂數（測試向量固定它） */
  readonly random: number;
}

/** 額度重置後分散重連的最大隨機延遲：20 分鐘 */
export const IOT_DEVICE_QUOTA_JITTER_MS = 20 * 60_000;
/** 不知道何時重置、或設定錯誤時的探測間隔：60 分鐘 */
export const IOT_DEVICE_PROBE_INTERVAL_MS = 60 * 60_000;
/** 被擠掉（4409）之後多久再試 */
export const IOT_DEVICE_REPLACED_RETRY_MS = 60_000;
/** 任何狀態下兩次連線嘗試的最小間隔 */
export const IOT_DEVICE_MIN_RETRY_MS = 1_000;
/** 任何狀態下最多等多久：額度每天重置，24 小時＋抖動綽綽有餘（也遠低於 setTimeout 的 2^31−1 毫秒） */
export const IOT_DEVICE_MAX_RETRY_MS = 25 * 3_600_000;

const RELAY_ERROR = { minMs: 5_000, maxMs: 600_000 };
const NETWORK_DOWN = { minMs: 1_000, maxMs: 60_000 };
const CONFIG_TOKENS = /\b(iot-token|iot-home|iot-device|iot-disabled|iot-path|iot-upgrade):/;
const DAY_SEC = 86_400;

function header(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

function seconds(value: string | undefined): number | undefined {
  return value !== undefined && /^\d{1,10}$/.test(value.trim()) ? Number(value.trim()) : undefined;
}

function bodyJson(body: string | undefined): { error?: unknown; reset?: unknown } {
  if (!body) return {};
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === 'object' && v !== null ? (v as { error?: unknown; reset?: unknown }) : {};
  } catch {
    return {};
  }
}

/** 分類一次斷線或被拒（`nowSec`：unix 秒，只用來推算 reset） */
export function classifyIotDeviceDisconnect(obs: IotDeviceObservation, nowSec: number): IotDeviceDisconnect {
  if (obs.kind === 'network' || obs.kind === 'heartbeat-timeout') return { class: 'network-down' };
  if (obs.kind === 'close') {
    if (obs.code === 4429) {
      const m = /^iot-quota:(\d{1,12})$/.exec(obs.reason ?? '');
      return m ? { class: 'quota-exhausted', reset: Number(m[1]) } : { class: 'quota-exhausted' };
    }
    if (obs.code === 4409) return { class: 'replaced' };
    return { class: 'network-down' };
  }
  const fromRelay = header(obs.headers, 'Cinder-Relay') === '1';
  const retryAfterSec = seconds(header(obs.headers, 'Retry-After'));
  if (!fromRelay) {
    if (obs.status === 429 && (obs.body ?? '').includes('1027')) return { class: 'quota-exhausted', reset: (Math.floor(nowSec / DAY_SEC) + 1) * DAY_SEC };
    return { class: 'relay-error' };
  }
  const body = bodyJson(obs.body);
  if (obs.status === 503 && header(obs.headers, 'Cinder-Quota') !== undefined) {
    const reset = typeof body.reset === 'number' && Number.isSafeInteger(body.reset) && body.reset > 0 ? body.reset : retryAfterSec !== undefined ? nowSec + retryAfterSec : undefined;
    return { class: 'quota-exhausted', ...(reset !== undefined ? { reset } : {}), ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) };
  }
  const error = typeof body.error === 'string' ? body.error : '';
  if ([401, 403, 404, 409, 426].includes(obs.status) && (CONFIG_TOKENS.test(error) || error === '')) return { class: 'config-error' };
  return { class: 'relay-error', ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) };
}

function exponential(range: { minMs: number; maxMs: number }, attempt: number, random: number): number {
  const base = Math.min(range.maxMs, range.minMs * 2 ** Math.max(0, Math.min(Number.isFinite(attempt) ? Math.floor(attempt) : 0, 30)));
  return Math.floor(base * (0.7 + 0.6 * random));
}

/** 下一次連線前等多久（毫秒） */
export function iotDeviceRetryDelayMs(d: IotDeviceDisconnect, ctx: IotDeviceRetryContext): number {
  const random = Number.isFinite(ctx.random) ? Math.min(Math.max(ctx.random, 0), 0.999999) : 0;
  let ms: number;
  switch (d.class) {
    case 'quota-exhausted':
      // 先把秒數夾在上限內再換成毫秒：reset 接近 2^53 時兩種語言都不會失去精度
      ms =
        ctx.clockSynced && d.reset !== undefined
          ? Math.min(d.reset - ctx.nowSec, IOT_DEVICE_MAX_RETRY_MS / 1000) * 1000 + Math.floor(random * IOT_DEVICE_QUOTA_JITTER_MS)
          : IOT_DEVICE_PROBE_INTERVAL_MS;
      break;
    case 'config-error':
      ms = IOT_DEVICE_PROBE_INTERVAL_MS;
      break;
    case 'replaced':
      ms = IOT_DEVICE_REPLACED_RETRY_MS;
      break;
    case 'relay-error':
      ms = Math.max(exponential(RELAY_ERROR, ctx.attempt, random), Math.min(d.retryAfterSec ?? 0, IOT_DEVICE_PROBE_INTERVAL_MS / 1000) * 1000);
      break;
    case 'network-down':
      ms = exponential(NETWORK_DOWN, ctx.attempt, random);
      break;
  }
  return Math.min(IOT_DEVICE_MAX_RETRY_MS, Math.max(IOT_DEVICE_MIN_RETRY_MS, ms));
}
