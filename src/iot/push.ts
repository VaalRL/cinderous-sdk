// IoT 推播的協定層（SDK ADR 0049 §11、§11.1 使用者裁示；沿用 Cinderous ADR-0272 與 SDK ADR 0011 §6）。中立、零 Node。
//
// 模型（裁示 3）：**client 自帶推播端點、憑證只在 App 開發者的推播閘道、誰知道端點誰就送**。
// - 推播端點兩種（裁示 6：UnifiedPush 與 FCM 同等）：
//   - `unifiedpush`：UnifiedPush／ntfy 網址（RFC 8030：送出端直接 POST 一則**沒有內容**的推播）；
//   - `gateway`：推播閘道網址＋以推播閘道公鑰加密的 token 封包（`sealed`，內含 FCM／APNs token 與「每次登記獨有密鑰」）
//     ＋那把密鑰（`key`）。送出端看不到 token，只能以密鑰對喚醒請求做 HMAC 簽章；推播閘道解封、驗簽、防重放、限速後才送。
// - 訂閱＝設備盲化 id（`dv`）清單＋每個訂閱的 `mode`（`standard` 預設／`instant`，裁示 2）；額度預警是特殊項目，只有 owner 能訂閱（裁示 1）。
// - 喚醒請求一律是空的：不含設備、內容、類別（裁示 3）。給推播閘道的請求只有封包、時間戳、簽章，以及（選用）iOS NSE 要回中繼取的
//   不透明事件 id（`ref`，只能是 64 位 hex；Android 與 UnifiedPush 一律不帶）。
// - 登記以加密指令送到保留 topic `$sys/push`（外層照常加密給全家；端點本身再以 NIP-44 加密給送出端，其他成員讀不到）。
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';

import { generateSecretKey, getPublicKey, type PubkeyHex } from '../protocol/keys.js';
import { conversationKey, encryptWithKey } from '../protocol/nip44.js';
import { iotPubkeyOf } from './acl.js';
import { IOT_BLIND_LENGTH } from './keys.js';

/** 推播協定版本（封包與喚醒請求的 `v`） */
export const IOT_PUSH_VERSION = 1;

// ── 上限（裁示 7：有預設值、可設定；部署設定器的推播閘道項目見 `DEPLOY_OPTION_SPECS` 的 `pushGateway.*`）─────────

export interface IotPushLimitSpec {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

/**
 * 推播的上限（裁示 7）。送出端（閘道、設備、日後的中繼）用前四項；推播閘道用後三項。
 * - `maxEndpoints`：每個家庭最多幾個推播端點（對齊 `ROSTER_MAX_DEVICES` 的 32）；
 * - `standardPerMinute`：標準模式每個端點每分鐘最多幾次（ADR-0272：60 秒合併）；
 * - `instantPerMinute`：即時模式每個端點每分鐘最多幾次（含標準）；
 * - `registrationTtlSec`：登記的存活（ADR-0272：30 天，啟動時續期）；
 * - `gatewayTokenPerHour`／`gatewayTokenPerMinute`：推播閘道每個 token 的上限（每分鐘的上限＝即時模式的上限，縱深防禦）；
 * - `gatewayMaxSkewSec`：推播閘道接受的時間戳誤差。
 */
export const IOT_PUSH_LIMITS = {
  maxEndpoints: { default: 32, min: 1, max: 256 },
  standardPerMinute: { default: 1, min: 1, max: 6 },
  instantPerMinute: { default: 6, min: 1, max: 30 },
  registrationTtlSec: { default: 30 * 86_400, min: 3_600, max: 30 * 86_400 },
  gatewayTokenPerHour: { default: 60, min: 1, max: 3_600 },
  gatewayTokenPerMinute: { default: 6, min: 1, max: 60 },
  gatewayMaxSkewSec: { default: 300, min: 30, max: 3_600 },
} as const satisfies Record<string, IotPushLimitSpec>;

export type IotPushLimitKey = keyof typeof IOT_PUSH_LIMITS;
export type IotPushLimits = { readonly [K in IotPushLimitKey]: number };

/**
 * 補上預設值並檢查範圍。`strict`（設定檔用）＝超出範圍丟例外；否則夾進範圍（程式內的選項）。
 */
export function iotPushLimits(input: Partial<Record<IotPushLimitKey, number>> = {}, opts: { strict?: boolean } = {}): IotPushLimits {
  const out = {} as Record<IotPushLimitKey, number>;
  for (const key of Object.keys(IOT_PUSH_LIMITS) as IotPushLimitKey[]) {
    const spec = IOT_PUSH_LIMITS[key];
    const value = input[key];
    if (value === undefined) {
      out[key] = spec.default;
      continue;
    }
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
      if (opts.strict) throw new RangeError(`${key} 必須是 ${spec.min}–${spec.max} 的整數（收到 ${String(value)}）`);
      out[key] = Number.isFinite(value) ? Math.min(spec.max, Math.max(spec.min, Math.floor(value))) : spec.default;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 標準模式的抖動上限（毫秒）：ADR-0272 的 0–30 秒 */
export const IOT_PUSH_STANDARD_JITTER_MS = 30_000;
/** 即時模式的抖動上限（毫秒）：裁示 2 的 0–2 秒 */
export const IOT_PUSH_INSTANT_JITTER_MS = 2_000;
/** 推播的投遞存活（秒）：FCM `android.ttl`、APNs `apns-expiration`、UnifiedPush `TTL`；喚醒晚一小時以上就沒有意義 */
export const IOT_PUSH_DELIVERY_TTL_SEC = 3_600;

// ── 端點 ─────────────────────────────────────────────────────────

export type IotPushEndpoint =
  | { readonly type: 'unifiedpush'; readonly url: string }
  | { readonly type: 'gateway'; readonly url: string; readonly sealed: string; readonly key: string };

export const IOT_PUSH_URL_MAX = 2_048;
export const IOT_PUSH_SEALED_MAX = 4_096;
const SEALED_PREFIX = 'cp1';
const SEALED_PATTERN = /^cp1\.[0-9a-f]{64}\.[A-Za-z0-9+/]+={0,2}$/;
const KEY_PATTERN = /^[0-9a-f]{64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 區網或本機的主機（明文 http 只允許這些，例如家裡自架的 ntfy） */
export function isPrivateIotPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /\.(local|lan|home\.arpa)$/.test(host)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return /^f[cd][0-9a-f]{2}:/.test(host);
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function checkUrl(raw: unknown, where: string, allowPrivateHttp: boolean): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > IOT_PUSH_URL_MAX) throw new RangeError(`${where} 要是 1–${IOT_PUSH_URL_MAX} 字元的網址`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RangeError(`${where} 不是合法的網址`);
  }
  if (url.username !== '' || url.password !== '') throw new RangeError(`${where} 不能帶帳號密碼`);
  if (url.protocol === 'https:') return raw;
  if (url.protocol === 'http:' && allowPrivateHttp && isPrivateIotPushHost(url.hostname)) return raw;
  throw new RangeError(`${where} 必須是 https://${allowPrivateHttp ? '（區網主機可以用 http://）' : ''}`);
}

/**
 * 驗證推播端點（不丟出端點內容：網址本身就是能力，不進錯誤訊息）。
 * `allowPrivateHttp`：允許 `http://` 的區網主機（家中橋接器送給家裡的 ntfy）；中繼當送出端時不得開。
 */
export function parseIotPushEndpoint(raw: unknown, opts: { allowPrivateHttp?: boolean } = {}): IotPushEndpoint {
  if (!isObject(raw)) throw new RangeError('推播端點要是物件');
  const allow = opts.allowPrivateHttp === true;
  if (raw.type === 'unifiedpush') {
    if (Object.keys(raw).some((k) => k !== 'type' && k !== 'url')) throw new RangeError('unifiedpush 端點只有 type 與 url');
    return { type: 'unifiedpush', url: checkUrl(raw.url, 'unifiedpush 網址', allow) };
  }
  if (raw.type === 'gateway') {
    if (Object.keys(raw).some((k) => !['type', 'url', 'sealed', 'key'].includes(k))) throw new RangeError('gateway 端點只有 type、url、sealed、key');
    const url = checkUrl(raw.url, '推播閘道網址', allow).replace(/\/+$/, '');
    if (typeof raw.sealed !== 'string' || raw.sealed.length > IOT_PUSH_SEALED_MAX || !SEALED_PATTERN.test(raw.sealed)) throw new RangeError('sealed 不是推播閘道的 token 封包');
    if (typeof raw.key !== 'string' || !KEY_PATTERN.test(raw.key)) throw new RangeError('key 要是 64 位小寫 hex（每次登記獨有的密鑰）');
    return { type: 'gateway', url, sealed: raw.sealed, key: raw.key };
  }
  throw new RangeError('推播端點的 type 只能是 unifiedpush 或 gateway');
}

const b64id = (bytes: Uint8Array): string => base64urlnopad.encode(bytes).slice(0, IOT_BLIND_LENGTH);

/** 端點的 id（22 字元）：同一個端點登記兩次是同一筆（更新） */
export function iotPushEndpointId(endpoint: IotPushEndpoint): string {
  const sealed = endpoint.type === 'gateway' ? endpoint.sealed : '';
  return b64id(sha256(utf8ToBytes(`cinder-push/v1/endpoint\n${endpoint.type}\n${endpoint.url}\n${sealed}`)));
}

/** 封包的登記 id（推播閘道以它防重放與撤銷；22 字元） */
export function iotPushRegId(sealed: string): string {
  return b64id(sha256(utf8ToBytes(sealed)));
}

// ── 推播閘道的 token 封包（App 端產生，SDK 不做 FCM／APNs 註冊——ADR 0011 §6）────────────────────

export type IotPushPlatform = 'android' | 'ios';
/** token 的種類：`fcm`（Android，或 iOS 經 Firebase SDK）、`apns`（iOS 直連 APNs 的裝置 token） */
export type IotPushTokenType = 'fcm' | 'apns';

/** 封包裡的明文（只有推播閘道解得開） */
export interface IotPushTokenPayload {
  readonly v: 1;
  readonly p: IotPushPlatform;
  readonly tt: IotPushTokenType;
  /** FCM registration token 或 APNs 裝置 token */
  readonly t: string;
  /** 每次登記獨有的密鑰（64 位 hex） */
  readonly k: string;
  /** 產生時間與到期時間（Unix 秒） */
  readonly iat: number;
  readonly exp: number;
}

const FCM_TOKEN = /^[A-Za-z0-9_:-]{20,4096}$/;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;

/** 檢查封包明文的形狀（推播閘道解開後用；不合法回 undefined） */
export function parseIotPushTokenPayload(raw: unknown): IotPushTokenPayload | undefined {
  if (!isObject(raw) || raw.v !== IOT_PUSH_VERSION) return undefined;
  if (raw.p !== 'android' && raw.p !== 'ios') return undefined;
  if (raw.tt !== 'fcm' && raw.tt !== 'apns') return undefined;
  if (raw.p === 'android' && raw.tt !== 'fcm') return undefined;
  if (typeof raw.t !== 'string' || !(raw.tt === 'fcm' ? FCM_TOKEN : APNS_TOKEN).test(raw.t)) return undefined;
  if (typeof raw.k !== 'string' || !KEY_PATTERN.test(raw.k)) return undefined;
  if (!Number.isSafeInteger(raw.iat) || !Number.isSafeInteger(raw.exp) || (raw.exp as number) <= (raw.iat as number)) return undefined;
  return raw as unknown as IotPushTokenPayload;
}

export interface SealIotPushTokenInput {
  readonly platform: IotPushPlatform;
  /** FCM registration token，或（iOS 直連 APNs 時）APNs 裝置 token 的 hex */
  readonly token: string;
  /** 預設：android → fcm；ios → fcm（推播閘道 `GET /v1/info` 的 `ios` 是 `apns` 時改給 `apns`） */
  readonly tokenType?: IotPushTokenType;
  /** 存活（秒），預設 30 天，夾 1 小時–30 天 */
  readonly ttlSec?: number;
  /** 現在（毫秒），測試用 */
  readonly now?: number;
}

/**
 * App 端：把推播 token 封給推播閘道（ephemeral secp256k1 × 推播閘道公鑰 → NIP-44 v2），並產生「每次登記獨有密鑰」。
 * 回傳的 `{ sealed, key }` 連同推播閘道網址就是一個 `gateway` 端點。**每登記一個送出端就封一次**（各自的密鑰：
 * 一個送出端外洩，不影響其他送出端的簽章，推播閘道也能逐一撤銷）。
 */
export function sealIotPushToken(gatewayPubkey: string, input: SealIotPushTokenInput): { sealed: string; key: string; expiresAt: number } {
  const recipient = iotPubkeyOf(gatewayPubkey);
  const tokenType = input.tokenType ?? 'fcm';
  if (input.platform !== 'android' && input.platform !== 'ios') throw new RangeError('platform 只能是 android 或 ios');
  if (input.platform === 'android' && tokenType !== 'fcm') throw new RangeError('Android 只支援 FCM token');
  const token = tokenType === 'apns' ? input.token.trim().toLowerCase() : input.token.trim();
  if (!(tokenType === 'fcm' ? FCM_TOKEN : APNS_TOKEN).test(token)) throw new RangeError(tokenType === 'fcm' ? 'FCM token 的格式不對' : 'APNs 裝置 token 要是 hex');
  const spec = IOT_PUSH_LIMITS.registrationTtlSec;
  const ttl = input.ttlSec === undefined ? spec.default : Math.min(spec.max, Math.max(spec.min, Math.floor(input.ttlSec)));
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const key = bytesToHex(randomBytes(32));
  const payload: IotPushTokenPayload = { v: 1, p: input.platform, tt: tokenType, t: token, k: key, iat, exp: iat + ttl };
  const ephemeral = generateSecretKey();
  const ciphertext = encryptWithKey(JSON.stringify(payload), conversationKey(ephemeral, recipient));
  return { sealed: `${SEALED_PREFIX}.${getPublicKey(ephemeral)}.${ciphertext}`, key, expiresAt: payload.exp };
}

/** 拆開封包外框（推播閘道用）：`{ epk, ciphertext }`；不是封包回 undefined */
export function splitIotPushSealed(sealed: string): { epk: PubkeyHex; ciphertext: string } | undefined {
  if (sealed.length > IOT_PUSH_SEALED_MAX || !SEALED_PATTERN.test(sealed)) return undefined;
  const [, epk, ciphertext] = sealed.split('.');
  return { epk: epk!, ciphertext: ciphertext! };
}

// ── 喚醒請求（送出端 → 推播閘道／UnifiedPush）──────────────────────────

/** iOS NSE 回中繼取用的不透明事件 id：只能是 Nostr 事件 id（64 位小寫 hex），不能夾帶任何其他東西 */
export const IOT_PUSH_REF_PATTERN = /^[0-9a-f]{64}$/;

/** 要簽的字串：時間戳（毫秒）、`ref`、登記 id；換行分隔 */
export function iotPushWakeMessage(regId: string, ts: number, ref?: string): string {
  return `cinder-push/v1/wake\n${ts}\n${ref ?? ''}\n${regId}`;
}

export function iotPushRevokeMessage(regId: string, ts: number): string {
  return `cinder-push/v1/revoke\n${ts}\n${regId}`;
}

/** HMAC-SHA256（hex）：以「每次登記獨有密鑰」簽 */
export function iotPushSign(keyHex: string, message: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(keyHex), utf8ToBytes(message)));
}

/** 送給推播閘道的喚醒請求本文：只有封包、時間戳、簽章與選用的 `ref`（{@link assertEmptyIotPushWake} 守門） */
export interface IotPushWakeBody {
  readonly v: 1;
  readonly sealed: string;
  /** 毫秒；同一個登記必須嚴格遞增（推播閘道以它防重放） */
  readonly ts: number;
  readonly sig: string;
  readonly ref?: string;
}

export interface IotPushRevokeBody {
  readonly v: 1;
  readonly sealed: string;
  readonly ts: number;
  readonly sig: string;
}

const WAKE_KEYS = new Set(['v', 'sealed', 'ts', 'sig', 'ref']);

/**
 * 喚醒請求一律是空的（裁示 3）：本文只能有 `v`、`sealed`、`ts`、`sig`、選用的 `ref`（64 位 hex）。
 * 多一個欄位（設備、類別、內容、標題）就丟例外——送出端與推播閘道都呼叫它。
 */
export function assertEmptyIotPushWake(body: unknown): asserts body is IotPushWakeBody {
  if (!isObject(body) || Object.keys(body).some((k) => !WAKE_KEYS.has(k))) throw new Error('喚醒請求只能帶封包、時間戳、簽章與不透明的事件 id：不得帶設備、內容或類別');
  if (body.v !== IOT_PUSH_VERSION || typeof body.sealed !== 'string' || !Number.isSafeInteger(body.ts) || typeof body.sig !== 'string') throw new Error('喚醒請求的格式不對');
  if (body.ref !== undefined && (typeof body.ref !== 'string' || !IOT_PUSH_REF_PATTERN.test(body.ref))) throw new Error('ref 只能是 64 位小寫 hex 的事件 id');
}

export function buildIotPushWakeBody(endpoint: Extract<IotPushEndpoint, { type: 'gateway' }>, wake: { ts: number; ref?: string }): IotPushWakeBody {
  const ref = wake.ref !== undefined && IOT_PUSH_REF_PATTERN.test(wake.ref) ? wake.ref : undefined;
  const regId = iotPushRegId(endpoint.sealed);
  const body: IotPushWakeBody = { v: 1, sealed: endpoint.sealed, ts: wake.ts, sig: iotPushSign(endpoint.key, iotPushWakeMessage(regId, wake.ts, ref)), ...(ref ? { ref } : {}) };
  assertEmptyIotPushWake(body);
  return body;
}

/** App 端停用推播時：請推播閘道撤銷這個登記（直到封包到期） */
export function buildIotPushRevokeBody(endpoint: Extract<IotPushEndpoint, { type: 'gateway' }>, ts: number): IotPushRevokeBody {
  return { v: 1, sealed: endpoint.sealed, ts, sig: iotPushSign(endpoint.key, iotPushRevokeMessage(iotPushRegId(endpoint.sealed), ts)) };
}

/** 一則要送出的 HTTP 請求（`fetch` 的參數；也給設備端照抄） */
export interface IotPushRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * 喚醒請求：
 * - `unifiedpush`：`POST <網址>`，本文**空的**（RFC 8030 §5 沒有內容的推播），`TTL`＋`Urgency: high`；`ref` 不送；
 * - `gateway`：`POST <推播閘道>/v1/wake`，本文 {@link IotPushWakeBody}。
 */
export function buildIotPushRequest(endpoint: IotPushEndpoint, wake: { ts: number; ref?: string }): IotPushRequest {
  if (endpoint.type === 'unifiedpush') {
    return { url: endpoint.url, method: 'POST', headers: { TTL: String(IOT_PUSH_DELIVERY_TTL_SEC), Urgency: 'high' }, body: '' };
  }
  return {
    url: `${endpoint.url.replace(/\/+$/, '')}/v1/wake`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildIotPushWakeBody(endpoint, wake)),
  };
}

/** 送出結果：`gone`＝端點已失效（送出端刪掉它）；`retry`＝對方要求晚點再送 */
export type IotPushSendResult =
  | { readonly status: 'ok' }
  | { readonly status: 'gone' }
  | { readonly status: 'retry'; readonly retryAfterMs: number }
  | { readonly status: 'error'; readonly reason: string };

/** 送出一次喚醒（可注入；預設 {@link fetchIotPushSend}） */
export type IotPushSend = (endpoint: IotPushEndpoint, wake: { readonly ts: number; readonly ref?: string }) => Promise<IotPushSendResult>;

/** `Retry-After`（秒數或 HTTP 日期）→ 毫秒；沒有或看不懂回 `fallbackMs` */
export function retryAfterMs(header: string | null | undefined, nowMs: number, fallbackMs = 60_000): number {
  if (header === null || header === undefined || header.trim() === '') return fallbackMs;
  const v = header.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? fallbackMs : Math.max(0, at - nowMs);
}

/** HTTP 狀態 → 送出結果（UnifiedPush 與推播閘道共用） */
export function iotPushResultOf(status: number, retryAfter: string | null, nowMs: number): IotPushSendResult {
  if (status >= 200 && status < 300) return { status: 'ok' };
  if (status === 404 || status === 410) return { status: 'gone' };
  if (status === 429 || status === 503) return { status: 'retry', retryAfterMs: retryAfterMs(retryAfter, nowMs) };
  return { status: 'error', reason: `http-${status}` };
}

/**
 * 預設的送出函式：以 `fetch` 送 {@link buildIotPushRequest}。錯誤原因只有狀態碼或 `network`／`timeout`——
 * **不含網址**（UnifiedPush 網址本身就是能力，不能進日誌）。
 */
export function fetchIotPushSend(fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args), opts: { timeoutMs?: number; now?: () => number } = {}): IotPushSend {
  const now = opts.now ?? Date.now;
  return async (endpoint, wake) => {
    const req = buildIotPushRequest(endpoint, wake);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal, redirect: 'manual' });
      return iotPushResultOf(res.status, res.headers.get('retry-after'), now());
    } catch {
      return { status: 'error', reason: controller.signal.aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── 訂閱與 `$sys/push` 操作 ─────────────────────────────────────────

export type IotPushMode = 'standard' | 'instant';
export const IOT_PUSH_MODES: readonly IotPushMode[] = ['standard', 'instant'];
/** 特殊的可訂閱項目：額度預警（只有 owner；ADR 0049 §10、§11.1 裁示 1） */
export type IotPushSpecial = 'quota';
export const IOT_PUSH_SPECIALS: readonly IotPushSpecial[] = ['quota'];
/** 一個登記最多幾個訂閱 */
export const IOT_PUSH_MAX_SUBSCRIPTIONS = 64;

export type IotPushSubscription =
  | { readonly dv: string; readonly mode: IotPushMode }
  | { readonly special: IotPushSpecial; readonly mode: IotPushMode };

const BLIND_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${IOT_BLIND_LENGTH}}$`);

/** 驗證訂閱清單：`dv` 是盲化 id、`mode` 預設 standard、不重複 */
export function parseIotPushSubscriptions(raw: unknown): IotPushSubscription[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > IOT_PUSH_MAX_SUBSCRIPTIONS) throw new RangeError(`訂閱要是 1–${IOT_PUSH_MAX_SUBSCRIPTIONS} 項`);
  const seen = new Set<string>();
  return raw.map((item) => {
    if (!isObject(item)) throw new RangeError('每個訂閱都要是物件');
    const mode = item.mode ?? 'standard';
    if (!IOT_PUSH_MODES.includes(mode as IotPushMode)) throw new RangeError('mode 只能是 standard 或 instant');
    let sub: IotPushSubscription;
    if (item.dv !== undefined && item.special === undefined) {
      if (typeof item.dv !== 'string' || !BLIND_PATTERN.test(item.dv)) throw new RangeError('dv 要是設備的盲化 id');
      sub = { dv: item.dv, mode: mode as IotPushMode };
    } else if (item.special !== undefined && item.dv === undefined) {
      if (!IOT_PUSH_SPECIALS.includes(item.special as IotPushSpecial)) throw new RangeError('special 只有 quota');
      sub = { special: item.special as IotPushSpecial, mode: mode as IotPushMode };
    } else {
      throw new RangeError('每個訂閱只能有 dv 或 special 其中一個');
    }
    const key = 'dv' in sub ? `dv:${sub.dv}` : `special:${sub.special}`;
    if (seen.has(key)) throw new RangeError('訂閱有重複的項目');
    seen.add(key);
    return sub;
  });
}

/** `$sys/push` 的操作（指令的 payload，JSON） */
export type IotPushOp =
  | {
      readonly op: 'register';
      /** 端點（{@link IotPushEndpoint} 的 JSON）以 NIP-44 加密給送出端（成員私鑰 × 送出端公鑰） */
      readonly endpoint: string;
      readonly subscriptions: readonly IotPushSubscription[];
      /** 存活（秒），預設 30 天 */
      readonly ttlSec?: number;
    }
  | { readonly op: 'remove'; readonly id: string };

const ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${IOT_BLIND_LENGTH}}$`);

/** 驗證 `$sys/push` 的操作內容；不合法丟例外 */
export function parseIotPushOp(payload: string): IotPushOp {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new RangeError('推播登記要是 JSON');
  }
  if (!isObject(raw)) throw new RangeError('推播登記要是物件');
  if (raw.op === 'register') {
    if (typeof raw.endpoint !== 'string' || raw.endpoint.length === 0 || raw.endpoint.length > 8_192) throw new RangeError('endpoint 要是加密給送出端的字串');
    const subscriptions = parseIotPushSubscriptions(raw.subscriptions);
    if (raw.ttlSec !== undefined && (!Number.isSafeInteger(raw.ttlSec) || (raw.ttlSec as number) <= 0)) throw new RangeError('ttlSec 要是正整數（秒）');
    return { op: 'register', endpoint: raw.endpoint, subscriptions, ...(raw.ttlSec !== undefined ? { ttlSec: raw.ttlSec as number } : {}) };
  }
  if (raw.op === 'remove') {
    if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) throw new RangeError('remove 要帶端點 id');
    return { op: 'remove', id: raw.id };
  }
  throw new RangeError('推播登記只有 register 與 remove');
}

/** 送出端保存的一筆登記（帶 TTL；裁示 3） */
export interface IotPushRegistration {
  readonly id: string;
  /** 登記的成員（外層事件的簽章者） */
  readonly owner: PubkeyHex;
  readonly endpoint: IotPushEndpoint;
  readonly subscriptions: readonly IotPushSubscription[];
  /** Unix 秒 */
  readonly createdAt: number;
  readonly expiresAt: number;
}
