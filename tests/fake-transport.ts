/**
 * 假的傳輸層（取代整個 RelayPool）：記下發布的事件、讓測試把事件餵給所有訂閱者。
 * 同一個 FakeTransport 可以給兩個身分共用，模擬「兩個人連著同一批 Relay」。
 */

import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

import type { PublishOptions, RejectedRelay, RelayTransport, PublishResult, SubscriptionHandlers } from '../src/relay-pool.js';

export interface FakeSubscription {
  readonly filters: Filter[];
  readonly handlers: SubscriptionHandlers;
  closed: boolean;
}

export class FakeTransport implements RelayTransport {
  readonly published: Event[] = [];
  readonly subscriptions: FakeSubscription[] = [];
  /** 之後的發布由哪些 Relay 接受；空陣列＝全部拒絕 */
  accepted: string[] = ['wss://fake'];
  /** 發布是否自動送到所有訂閱者（模擬 Relay 轉發）；預設不自動，測試自己 deliver */
  relay = false;
  /** 另外幾座拒收（模擬部分拒收；SDK ADR 0038 P0-C） */
  alsoRejected: RejectedRelay[] = [];

  /** 每一次發布帶的選項（與 `published` 一一對應；SDK ADR 0067 看 `relays`） */
  readonly publishOptions: (PublishOptions | undefined)[] = [];

  publish(event: Event, options?: PublishOptions): Promise<PublishResult> {
    this.published.push(event);
    this.publishOptions.push(options);
    const result: PublishResult = {
      accepted: [...this.accepted],
      rejected: [...(this.accepted.length === 0 ? [{ url: 'wss://fake', reason: 'blocked' }] : []), ...this.alsoRejected],
    };
    if (this.relay && this.accepted.length > 0) {
      this.deliver(event);
    }
    return Promise.resolve(result);
  }

  subscribe(filters: Filter[], handlers: SubscriptionHandlers) {
    const entry: FakeSubscription = { filters, handlers, closed: false };
    this.subscriptions.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
    };
  }

  /** 像 Relay 一樣把事件送給每個還開著的訂閱（不看 filter，交給被測物自己過濾） */
  deliver(event: Event): void {
    for (const subscription of [...this.subscriptions]) {
      if (!subscription.closed) {
        subscription.handlers.onEvent(event, 'wss://fake');
      }
    }
  }
}
