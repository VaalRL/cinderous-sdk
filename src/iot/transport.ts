// IoT 客戶端與閘道共用的收送小工具：只依賴 `RelayTransport` 介面（型別），不把連線池的執行期拉進 `./iot`。
// 發布一律經過同一身分的事件預算（SDK ADR 0043 的 `publishPaced`），中繼說限速就整個預算退避。
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

import type { NostrEvent } from '../protocol/event.js';
import { verifyEvent } from '../protocol/sign.js';
import { publishRejections, type ClassifiedRejection } from '../publish-rejections.js';
import { publishPaced, type RelayEventBudget } from '../relay-budget.js';
import type { PublishResult, RelayTransport } from '../relay-pool.js';

/** `RelayPool` 直接符合；有 `query` 就用它，沒有就以訂閱＋EOSE 代替 */
export type IotTransport = RelayTransport & { query?(filters: Filter[], timeoutMs?: number): Promise<Event[]> };

/** 一次性查詢：有 `query` 用它，否則訂閱到第一個 EOSE（或逾時）為止 */
export function iotQuery(pool: IotTransport, filters: Filter[], timeoutMs: number): Promise<Event[]> {
  if (typeof pool.query === 'function') return pool.query(filters, timeoutMs);
  return new Promise((resolve) => {
    const events = new Map<string, Event>();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => sub.close());
      resolve([...events.values()].sort((a, b) => b.created_at - a.created_at));
    };
    const timer = setTimeout(finish, timeoutMs);
    const sub = pool.subscribe(filters, {
      onEvent: (event) => {
        if (!done) events.set(event.id, event);
      },
      onEose: finish,
    });
  });
}

/** 驗簽（連線池已經驗過；自訂傳輸層不一定，閘道與客戶端是安全邊界，再驗一次） */
export function iotVerified(event: Event | NostrEvent): boolean {
  try {
    return verifyEvent(event as NostrEvent);
  } catch {
    return false;
  }
}

export interface IotPublishOutcome {
  readonly ok: boolean;
  readonly result: PublishResult;
  readonly rejected: readonly ClassifiedRejection[];
}

/** 取預算 → 發布（限速就退避重送）；至少一座收下算成功 */
export async function iotPublish(pool: IotTransport, budget: RelayEventBudget, event: NostrEvent): Promise<IotPublishOutcome> {
  const result = await publishPaced(budget, () => pool.publish(event as unknown as Event));
  return { ok: result.accepted.length > 0, result, rejected: publishRejections(result) };
}
