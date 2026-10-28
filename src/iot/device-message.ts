// C′／C 設備信封裡面的明文（SDK ADR 0049 §2.6、§9；SDK ADR 0120）：手機與設備之間的訊息，relay 看不到。純函式、零 Node 內建模組。
//
//   down（手機 → 設備）：`{"type":"cmd","msgId","topic","payload","enc","confirmed"?,"exp"}`、`{"type":"query","msgId","exp"}`
//   up（設備 → 手機）：  `{"type":"ack","inReplyTo","status","reason"?,"topics"?}`、`{"type":"state","topics","will"?}`
//
// - `exp`＝指令存活到期（unix 秒，與外層 NIP-40 `expiration` 相同）；信封的 `ts`（秒）在 AAD 裡，設備另以它做時間窗。
// - `topics` 的值與 retained 同一個形狀 `{ payload, enc?, ts }`（ts＝毫秒）。
// - 門鎖類（`class: 'lock'`）的 `cmd` 幀以 `deviceKeyDown`（operatorSecret 導出，§9.5）加密；`query` 幀一律用 `deviceKey`
//   （viewer 也能查詢）。設備只執行「`cmd` 幀＋以 down 金鑰解開＋內容 `type: 'cmd'`」的訊息。
import { isValidIotTopic } from './topic.js';
import type { IotEncoding, IotTopicValue } from './content.js';

/** 設備回覆指令的結果（角色檢查在 relay，設備只回這三種） */
export type IotDeviceAckStatus = 'ok' | 'rejected' | 'unknown-topic';
export const IOT_DEVICE_ACK_STATUSES: readonly IotDeviceAckStatus[] = ['ok', 'rejected', 'unknown-topic'];

export interface IotDownCommand {
  readonly type: 'cmd';
  readonly msgId: string;
  readonly topic: string;
  readonly payload: string;
  readonly enc: IotEncoding;
  readonly confirmed?: boolean;
  /** unix 秒 */
  readonly exp: number;
}

export interface IotDownQuery {
  readonly type: 'query';
  readonly msgId: string;
  readonly exp: number;
}

export type IotDownMessage = IotDownCommand | IotDownQuery;

export interface IotUpAck {
  readonly type: 'ack';
  readonly inReplyTo: string;
  readonly status: IotDeviceAckStatus;
  readonly reason?: string;
  /** 指令執行後（或查詢時）的狀態 */
  readonly topics?: Readonly<Record<string, IotTopicValue>>;
}

export interface IotUpState {
  readonly type: 'state';
  readonly topics: Readonly<Record<string, IotTopicValue>>;
  /** 設備層的遺囑（例如即將斷電） */
  readonly will?: boolean;
}

export type IotUpMessage = IotUpAck | IotUpState;

/** 單一 topic 酬載上限（與 25172 相同） */
const PAYLOAD_MAX_BYTES = 8 * 1024;
const REASON_MAX = 200;
const MAX_TOPICS = 64;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMsgId = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Za-z_-]{16,64}$/.test(v);
const isSec = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isEnc = (v: unknown): v is IotEncoding => v === 'utf8' || v === 'base64';
const isPayload = (v: unknown): v is string => typeof v === 'string' && new TextEncoder().encode(v).length <= PAYLOAD_MAX_BYTES;

function isTopics(v: unknown): v is Record<string, IotTopicValue> {
  if (!isObject(v)) return false;
  const entries = Object.entries(v);
  if (entries.length > MAX_TOPICS) return false;
  return entries.every(([topic, value]) => isValidIotTopic(topic) && isObject(value) && isPayload(value.payload) && (value.enc === undefined || isEnc(value.enc)) && isSec(value.ts));
}

function parseJson(data: Uint8Array | string): unknown {
  try {
    return JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
  } catch {
    return undefined;
  }
}

/** 解析 down 明文（設備端用）；不認得回 undefined */
export function parseIotDownMessage(data: Uint8Array | string): IotDownMessage | undefined {
  const raw = parseJson(data);
  if (!isObject(raw) || !isMsgId(raw.msgId) || !isSec(raw.exp)) return undefined;
  if (raw.type === 'query') return { type: 'query', msgId: raw.msgId, exp: raw.exp };
  if (raw.type !== 'cmd' || !isValidIotTopic(raw.topic) || !isPayload(raw.payload) || !isEnc(raw.enc)) return undefined;
  if (raw.confirmed !== undefined && typeof raw.confirmed !== 'boolean') return undefined;
  return { type: 'cmd', msgId: raw.msgId, topic: raw.topic, payload: raw.payload, enc: raw.enc, ...(raw.confirmed !== undefined ? { confirmed: raw.confirmed } : {}), exp: raw.exp };
}

/** 解析 up 明文（手機端用）；不認得回 undefined */
export function parseIotUpMessage(data: Uint8Array | string): IotUpMessage | undefined {
  const raw = parseJson(data);
  if (!isObject(raw)) return undefined;
  if (raw.type === 'state') {
    if (!isTopics(raw.topics) || (raw.will !== undefined && typeof raw.will !== 'boolean')) return undefined;
    return { type: 'state', topics: raw.topics, ...(raw.will !== undefined ? { will: raw.will } : {}) };
  }
  if (raw.type !== 'ack' || !isMsgId(raw.inReplyTo) || !IOT_DEVICE_ACK_STATUSES.includes(raw.status as IotDeviceAckStatus)) return undefined;
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > REASON_MAX)) return undefined;
  if (raw.topics !== undefined && !isTopics(raw.topics)) return undefined;
  return {
    type: 'ack',
    inReplyTo: raw.inReplyTo,
    status: raw.status as IotDeviceAckStatus,
    ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
    ...(raw.topics !== undefined ? { topics: raw.topics } : {}),
  };
}
