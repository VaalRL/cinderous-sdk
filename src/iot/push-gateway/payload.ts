// 推播閘道送給 Google／Apple 的內容（SDK ADR 0049 §11.1；沿用 Cinderous ADR-0272 §5.1 與 SDK ADR 0011 §6 的守門精神）。
//
// - Android：FCM **高優先、空的**資料訊息（`data: {}`）——零額外洩漏，Doze 下也喚醒得了；
// - iOS：**一般推播＋`mutable-content`**（不是靜默推播：靜默推播會被系統節流），`alert` 只放一個在地化鍵
//   （文字由 App 自己的 Localizable.strings 提供，推播裡沒有任何文字），payload 只多一個不透明的事件 id（`ref`，給 NSE 回中繼取）。
// - 送出前一律呼叫 {@link assertContentlessPushPayload}：多一個欄位（標題、內文、設備、類別）就丟例外。
import { assertZeroKnowledgePush } from '../../sync/push.js';
import { IOT_PUSH_DELIVERY_TTL_SEC, IOT_PUSH_REF_PATTERN } from '../push.js';

/** iOS 通知的在地化鍵：只能是大寫英數與底線（不能夾帶任何文字） */
export const PUSH_IOS_LOC_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
/** 預設的在地化鍵：App 的 Localizable.strings 要有它（例如「有新動態」）；NSE 來不及解密時顯示的就是它 */
export const DEFAULT_PUSH_IOS_LOC_KEY = 'CINDER_WAKE';

/** APNs 的 payload（直連 APNs 的本文；經 FCM 時放在 `apns.payload`） */
export interface IosWakePayload {
  readonly aps: { readonly alert: { readonly 'loc-key': string }; readonly 'mutable-content': 1 };
  readonly ref?: string;
}

export function iosWakePayload(locKey: string, ref?: string): IosWakePayload {
  const payload: IosWakePayload = { aps: { alert: { 'loc-key': locKey }, 'mutable-content': 1 }, ...(ref !== undefined ? { ref } : {}) };
  assertContentlessPushPayload('ios', payload);
  return payload;
}

/** FCM HTTP v1 的 Android 訊息：高優先、空資料 */
export function androidFcmMessage(token: string): { message: { token: string; data: Record<string, never>; android: { priority: 'HIGH'; ttl: string } } } {
  const message = { token, data: {}, android: { priority: 'HIGH' as const, ttl: `${IOT_PUSH_DELIVERY_TTL_SEC}s` } };
  assertContentlessPushPayload('android', message);
  return { message };
}

/** FCM HTTP v1 的 iOS 訊息（FCM 轉給 APNs）：一般推播、高優先、`mutable-content` */
export function iosFcmMessage(token: string, locKey: string, ref: string | undefined, nowSec: number): { message: Record<string, unknown> } {
  return {
    message: {
      token,
      apns: {
        headers: { 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(nowSec + IOT_PUSH_DELIVERY_TTL_SEC) },
        payload: iosWakePayload(locKey, ref),
      },
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => {
  const have = Object.keys(v).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
};

/**
 * 零知識守門（SDK ADR 0011 §6 `assertZeroKnowledgePush` 的延伸）：
 * - `android`：FCM 訊息只能有 `token`、`data`（必須是空的——沿用 `assertZeroKnowledgePush('fcm', …)`）、`android`（只有 `priority`、`ttl`）；
 * - `ios`：APNs payload 只能有 `aps`（`alert` 只有 `loc-key`、`mutable-content: 1`）與選用的 `ref`（64 位 hex）。
 */
export function assertContentlessPushPayload(platform: 'android' | 'ios', payload: unknown): void {
  const fail = (): never => {
    throw new Error('推播內容只能是空的喚醒：不得帶標題、內文、設備、類別或任何其他欄位');
  };
  if (!isObject(payload)) fail();
  const p = payload as Record<string, unknown>;
  if (platform === 'android') {
    if (!exactKeys(p, ['token', 'data', 'android']) || typeof p.token !== 'string') fail();
    assertZeroKnowledgePush('fcm', { data: p.data });
    const android = p.android;
    if (!isObject(android) || !exactKeys(android, ['priority', 'ttl']) || android.priority !== 'HIGH' || typeof android.ttl !== 'string' || !/^\d{1,7}s$/.test(android.ttl)) fail();
    return;
  }
  if (!exactKeys(p, p.ref === undefined ? ['aps'] : ['aps', 'ref'])) fail();
  if (p.ref !== undefined && (typeof p.ref !== 'string' || !IOT_PUSH_REF_PATTERN.test(p.ref))) fail();
  const aps = p.aps;
  if (!isObject(aps) || !exactKeys(aps, ['alert', 'mutable-content']) || aps['mutable-content'] !== 1) fail();
  const alert = (aps as Record<string, unknown>).alert;
  if (!isObject(alert) || !exactKeys(alert, ['loc-key']) || typeof alert['loc-key'] !== 'string' || !PUSH_IOS_LOC_KEY_PATTERN.test(alert['loc-key'])) fail();
}
