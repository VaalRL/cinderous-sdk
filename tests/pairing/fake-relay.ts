// 配對測試用的記憶體中繼：依 `kinds`／`#p` 過濾、非同步投遞（microtask），可以攔截（丟棄、竄改、重送、搶先）。
// Ephemeral（20000–29999）不保存：送出當下沒有訂閱就沒了；其他 kind 保存，新訂閱會收到舊的。
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

import type { PublishResult, RelayTransport, SubscriptionHandlers } from '../../src/relay-pool.js';

interface Sub {
  owner: string;
  filters: Filter[];
  handlers: SubscriptionHandlers;
  closed: boolean;
}

function matches(filters: Filter[], event: Event): boolean {
  return filters.some((f) => {
    if (f.kinds && !f.kinds.includes(event.kind)) return false;
    const p = f['#p'];
    if (p && !event.tags.some((t) => t[0] === 'p' && p.includes(t[1]!))) return false;
    return true;
  });
}

export class FakeRelay {
  readonly subs: Sub[] = [];
  readonly stored: Event[] = [];
  readonly log: Array<{ from: string; event: Event }> = [];
  /** 攔截：回傳真正要投遞的事件（空陣列＝丟掉）。預設原樣投遞 */
  intercept: ((event: Event, from: string) => Event[]) | undefined;
  /** 某個連線池暫時斷線（發布失敗、收不到） */
  readonly offline = new Set<string>();

  pool(name: string): RelayTransport {
    return {
      publish: (event: Event): Promise<PublishResult> => {
        if (this.offline.has(name)) return Promise.resolve({ accepted: [], rejected: [{ url: 'wss://fake', reason: 'offline' }] });
        this.log.push({ from: name, event });
        const out = this.intercept ? this.intercept(event, name) : [event];
        for (const e of out) this.inject(e);
        return Promise.resolve({ accepted: ['wss://fake'], rejected: [] });
      },
      subscribe: (filters: Filter[], handlers: SubscriptionHandlers) => {
        const sub: Sub = { owner: name, filters, handlers, closed: false };
        this.subs.push(sub);
        for (const e of this.stored) if (matches(filters, e)) queueMicrotask(() => !sub.closed && handlers.onEvent(e, 'wss://fake'));
        return { close: () => void (sub.closed = true) };
      },
    };
  }

  /** 直接放一顆事件進中繼（攻擊者自己發布） */
  inject(event: Event): void {
    const ephemeral = event.kind >= 20000 && event.kind < 30000;
    if (!ephemeral) this.stored.push(event);
    for (const sub of this.subs) {
      if (sub.closed || this.offline.has(sub.owner) || !matches(sub.filters, event)) continue;
      queueMicrotask(() => !sub.closed && sub.handlers.onEvent(event, 'wss://fake'));
    }
  }

  openSubs(owner: string): number {
    return this.subs.filter((s) => s.owner === owner && !s.closed).length;
  }
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 讓 microtask 與 setImmediate 都跑幾輪 */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await tick();
}
