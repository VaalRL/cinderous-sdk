// `v0.33-stores.mjs` 的型別（SDK ADR 0042）：v0.33.0 的兩個 store，形狀就是當時的 `OfflineStore`。
import type { NostrEvent } from '../../src/protocol/index.js';
import type { MessageStoreOptions } from '../../src/relay/message-store.js';
import type { RelayFilter } from '../../src/relay/protocol.js';
import type { SqlExec } from '../../src/relay/sql-message-store.js';

export interface V033Store {
  put(event: NostrEvent, nowSec: number): boolean;
  putAddressable(event: NostrEvent, nowSec: number): boolean;
  query(filter: RelayFilter, nowSec: number, maxBytes?: number): NostrEvent[];
  prune(nowSec: number): void;
  vanish(pubkey: string, nowSec: number): number;
}
export declare const MessageStore: new (opts?: MessageStoreOptions) => V033Store;
export declare const SqlMessageStore: new (sql: SqlExec, opts?: MessageStoreOptions) => V033Store;
