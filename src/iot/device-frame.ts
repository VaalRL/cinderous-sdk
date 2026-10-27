// C′ 即時通道的設備幀與設備權杖（SDK ADR 0049 §9.2、§9.3、§9.5）。純函式、零 Node 內建模組。
//
// 設備常駐一條 `wss` 連到 `/iot/v1/dev/<homeTag>/<blindId>`（標頭 `Authorization: Bearer <權杖>`），幀是 JSON：
//   relay → 設備：`{"t":"cmd","env":<down 信封>}`、`{"t":"query","env":<down 信封>}`
//   設備 → relay：`{"t":"ack","env":<up 信封>}`、`{"t":"state","env":<up 信封>}`、心跳 `{"t":"hb"}`
// 心跳由平台自動回覆 `{"t":"hb-ack"}`（`setWebSocketAutoResponse`），不喚醒 DO、不計費——兩個字串必須逐位元組固定。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';

import { parseIotEnvelope, type IotDeviceEnvelope } from './envelope.js';

/** 設備送的應用層心跳（逐位元組固定） */
export const IOT_DEVICE_HEARTBEAT = '{"t":"hb"}';
/** 平台自動回覆的心跳（逐位元組固定） */
export const IOT_DEVICE_HEARTBEAT_ACK = '{"t":"hb-ack"}';
/** 單一設備幀上限（bytes）：一個信封（明文 16 KiB → base64 約 22 KiB）加欄位 */
export const IOT_DEVICE_FRAME_MAX_BYTES = 32 * 1024;

export type IotDeviceFrame =
  | { readonly t: 'cmd' | 'query'; readonly env: IotDeviceEnvelope }
  | { readonly t: 'ack' | 'state'; readonly env: IotDeviceEnvelope }
  | { readonly t: 'hb' };

/** 誰送的幀：`relay`＝relay 送給設備的，`device`＝設備送給 relay 的 */
export type IotDeviceFrameSource = 'relay' | 'device';

const FROM_RELAY = new Set(['cmd', 'query']);
const FROM_DEVICE = new Set(['ack', 'state']);

/** 編碼設備幀（心跳回傳固定字串） */
export function encodeIotDeviceFrame(frame: IotDeviceFrame): string {
  if (frame.t === 'hb') return IOT_DEVICE_HEARTBEAT;
  return JSON.stringify({ t: frame.t, env: frame.env });
}

/** 解析設備幀；方向、信封方向或格式不對回 undefined */
export function parseIotDeviceFrame(data: string | Uint8Array, source: IotDeviceFrameSource): IotDeviceFrame | undefined {
  const bytes = typeof data === 'string' ? utf8ToBytes(data) : data;
  if (bytes.length > IOT_DEVICE_FRAME_MAX_BYTES) return undefined;
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const t = (value as { t?: unknown }).t;
  if (t === 'hb') return source === 'device' ? { t: 'hb' } : undefined;
  if (typeof t !== 'string') return undefined;
  const allowed = source === 'relay' ? FROM_RELAY : FROM_DEVICE;
  if (!allowed.has(t)) return undefined;
  const env = parseIotEnvelope((value as { env?: unknown }).env);
  if (!env || env.dir !== (source === 'relay' ? 'down' : 'up')) return undefined;
  return { t: t as 'cmd' | 'query' | 'ack' | 'state', env };
}

/** 設備權杖的形狀：`cit1_`（Cinder IoT token v1）＋32 bytes base64url——前綴讓秘密掃描認得出來 */
export const IOT_DEVICE_TOKEN_PATTERN = /^cit1_[A-Za-z0-9_-]{43}$/;

/** 產生一個設備權杖（只顯示一次；relay 只存 {@link hashIotDeviceToken} 的結果） */
export function generateIotDeviceToken(): string {
  return `cit1_${base64urlnopad.encode(randomBytes(32))}`;
}

/** 權杖雜湊（SHA-256 hex）：relay 的設定只放這個 */
export function hashIotDeviceToken(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token)));
}

/** 以常數時間比較權杖與雜湊；權杖格式不對或雜湊不是 64 位 hex 直接回 false */
export function verifyIotDeviceToken(token: string | undefined, expectedHash: string): boolean {
  if (token === undefined || !IOT_DEVICE_TOKEN_PATTERN.test(token) || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const actual = hashIotDeviceToken(token);
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return diff === 0;
}
