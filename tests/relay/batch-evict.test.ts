// 檔案塊整批淘汰（SDK ADR 0085）：中繼自己要刪檔案塊時（每收件人上限、天花板、保底份額外、借用到期），
// 同一收件人、同一個 `expiration` 標籤的 kind 1060 一起刪——只刪一部分會切出永遠收不齊的孤兒（2026-10-14 錨點 1 的 130 MiB）。
// 兩個實作（記憶體版、SQLite 版）跑同一組測試：行為必須逐字對齊。
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import { MessageStore, type MessageStoreOptions, type OfflineStore } from '../../src/relay/message-store.js';
import { SqlMessageStore } from '../../src/relay/sql-message-store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

const NOW = 1_760_000_000;
const DAY = 86_400;
const X = getPublicKey(generateSecretKey());
const Y = getPublicKey(generateSecretKey());

/** 一顆檔案塊：一次性作者、收件人、批次（＝`expiration` 標籤）、建立時間；內容固定長度讓大小一致 */
function chunk(recipient: string, expiration: number, createdAt: number, kind = 1060): NostrEvent {
  return finalizeEvent(
    { kind, created_at: createdAt, tags: [['p', recipient], ['expiration', String(expiration)]], content: 'x'.repeat(1000) },
    generateSecretKey(),
  );
}
const SIZE = JSON.stringify(chunk(X, NOW + DAY, NOW)).length;

type Store = OfflineStore & {
  takeDropped?(recipient: string, nowSec: number): { count: number } | undefined;
};

const impls: [string, (opts: MessageStoreOptions) => Store][] = [
  ['記憶體版', (opts) => new MessageStore(opts)],
  [
    'SQLite 版',
    (opts) => {
      const db = new DatabaseSync(':memory:');
      return new SqlMessageStore((q, ...b) => {
        const stmt = db.prepare(q);
        if (/^\s*select/i.test(q)) return stmt.all(...b) as Record<string, unknown>[];
        stmt.run(...b);
        return [];
      }, opts);
    },
  ],
];

const ids = (store: Store, recipient: string, at = NOW) => store.query({ '#p': [recipient] }, at).map((e) => e.id).sort();

for (const [name, make] of impls) {
  describe(`檔案塊整批淘汰（SDK ADR 0085）——${name}`, () => {
    it('每收件人上限（FIFO）刪到舊批的一部分 → 那批剩下的一起刪；丟棄計數算進去', () => {
      const store = make({ filePerRecipient: 4, countDrops: true });
      const a = [0, 1, 2].map((i) => chunk(X, NOW + DAY, NOW - 100 + i));
      const b = [0, 1, 2].map((i) => chunk(X, NOW + 2 * DAY, NOW + i));
      for (const e of [...a, ...b]) expect(store.put(e, NOW)).toBe(true);
      expect(ids(store, X)).toEqual(b.map((e) => e.id).sort());
      expect(store.takeDropped?.(X, NOW)?.count).toBe(3);
    });

    it('舊版天花板淘汰（沒有保底）：只需要騰一塊的空間，也把那一批整批刪掉', () => {
      const store = make({ offlineMaxTotalBytes: SIZE * 5, ceilingEvicts: true });
      const a = [0, 1, 2].map((i) => chunk(X, NOW + DAY, NOW + i)); // 最早到期
      const b = [0, 1].map((i) => chunk(Y, NOW + 2 * DAY, NOW + i));
      for (const e of [...a, ...b]) expect(store.put(e, NOW)).toBe(true);
      const c = chunk(Y, NOW + 3 * DAY, NOW + 9);
      expect(store.put(c, NOW)).toBe(true);
      expect(ids(store, X)).toEqual([]);
      expect(ids(store, Y)).toEqual([...b, c].map((e) => e.id).sort());
    });

    it('保底份額外淘汰：刪到超過保底那人的一塊 → 那批剩下的一起刪', () => {
      const store = make({ offlineMaxTotalBytes: SIZE * 4, ceilingEvicts: true, guaranteeBytes: SIZE * 2 });
      const a = [0, 1, 2].map((i) => chunk(X, NOW + DAY, NOW + i)); // X 超過保底
      const y1 = chunk(Y, NOW + 2 * DAY, NOW);
      for (const e of [...a, y1]) expect(store.put(e, NOW)).toBe(true);
      const y2 = chunk(Y, NOW + 2 * DAY, NOW + 1);
      expect(store.put(y2, NOW)).toBe(true);
      expect(ids(store, X)).toEqual([]);
      expect(ids(store, Y)).toEqual([y1, y2].map((e) => e.id).sort());
    });

    it('借用到期（2 小時）：借用的那幾塊被清掉時，同一批正常存放的也一起清掉', () => {
      const store = make({ offlineMaxTotalBytes: SIZE * 2, overflowRatio: 0.5, borrowPerKeyBytes: SIZE, countDrops: true });
      const a = [0, 1, 2].map((i) => chunk(X, NOW + 3 * DAY, NOW + i));
      for (const e of a) expect(store.put(e, NOW)).toBe(true); // 第三塊借用
      expect(ids(store, X)).toHaveLength(3);
      const later = NOW + 2 * 3600 + 1;
      store.prune(later);
      expect(ids(store, X, later)).toEqual([]);
      expect(store.takeDropped?.(X, later)?.count).toBe(3);
    });

    it('不受影響的：別人的同批時間、別批、聊天訊息（不是 1060）都不跟著刪', () => {
      const store = make({ filePerRecipient: 2, maxPerRecipient: 100 });
      const chat = chunk(X, NOW + DAY, NOW - 200, 1059); // 與 a 同一個 expiration，但不是檔案塊
      const other = chunk(Y, NOW + DAY, NOW - 100); // 別人、同一個 expiration
      const a = [0, 1].map((i) => chunk(X, NOW + DAY, NOW - 100 + i));
      const b = [0, 1].map((i) => chunk(X, NOW + 2 * DAY, NOW + i));
      for (const e of [chat, other, ...a, ...b]) expect(store.put(e, NOW)).toBe(true);
      expect(ids(store, X)).toEqual([chat, ...b].map((e) => e.id).sort());
      expect(ids(store, Y)).toEqual([other.id]);
    });
  });
}
