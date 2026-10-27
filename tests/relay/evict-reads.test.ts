// 淘汰時的讀取列數（SDK ADR 0102、0103；Cinderous ADR-0389、0390，測試逐字相同）。2026-10-19 錨點 1 的檔案車道塞滿後，每寫一顆平均讀 172 列、最多 1 萬多列，
// 一小時把免費方案每日 500 萬列的讀取額度用完。wrangler dev 實測兩個來源：
//   一、查「這幾列屬於哪一批」強制走部分索引，掃過全部檔案塊（每次約 4,400 列）；
//   二、淘汰後把每收件人的列數快取整個清掉，下一次寫入重數（每次約 1,400 列）。
// Cloudflare 依「讀了幾列」計費，node:sqlite 量不到列數，所以這裡用查詢計畫與「下了哪些 SQL」守住。
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import { type MessageStoreOptions } from '../../src/relay/message-store.js';
import { SqlMessageStore } from '../../src/relay/sql-message-store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

const NOW = 1_760_000_000;
const DAY = 86_400;
const X = getPublicKey(generateSecretKey());
const Y = getPublicKey(generateSecretKey());

function chunk(recipient: string, expiration: number, createdAt: number): NostrEvent {
  return finalizeEvent(
    { kind: 1060, created_at: createdAt, tags: [['p', recipient], ['expiration', String(expiration)]], content: 'x'.repeat(1000) },
    generateSecretKey(),
  );
}
const SIZE = JSON.stringify(chunk(X, NOW + DAY, NOW)).length;

/** SQLite 版 store，記下每一條下過的 SQL（含綁定值），可以事後看查詢計畫 */
function spied(opts: MessageStoreOptions) {
  const db = new DatabaseSync(':memory:');
  const log: { query: string; bindings: unknown[] }[] = [];
  const store = new SqlMessageStore((q, ...b) => {
    log.push({ query: q, bindings: b });
    const stmt = db.prepare(q);
    if (/^\s*select/i.test(q)) return stmt.all(...(b as never[])) as Record<string, unknown>[];
    stmt.run(...(b as never[]));
    return [];
  }, opts);
  const plan = (q: string, b: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...(b as never[])) as { detail: string }[]).map((r) => r.detail).join(' | ');
  const count = (recipient: string) =>
    Number((db.prepare('SELECT COUNT(*) AS n FROM offline_msgs WHERE recipient = ?').get(recipient) as { n: number }).n);
  return { store, log, plan, count };
}

describe('淘汰時查批次只讀要刪的那幾列（SDK ADR 0102 一）', { timeout: 30_000 }, () => {
  const scenarios: [string, MessageStoreOptions][] = [
    ['舊版天花板淘汰', { offlineMaxTotalBytes: SIZE * 40, ceilingEvicts: true }],
    ['保底份額外淘汰', { offlineMaxTotalBytes: SIZE * 40, ceilingEvicts: true, guaranteeBytes: SIZE * 20 }],
    ['借用帶回收', { offlineMaxTotalBytes: SIZE * 40, ceilingEvicts: true, guaranteeBytes: SIZE * 20, overflowRatio: 0.2 }],
    ['每收件人上限', { filePerRecipient: 20 }],
  ];
  for (const [name, opts] of scenarios) {
    it(`🔴 ${name}：沒有任何一條 SQL 掃過整個 idx_offline_batch`, () => {
      const { store, log, plan } = spied(opts);
      // 兩個收件人輪流、每 5 顆一批，寫到遠超過上限
      for (let i = 0; i < 120; i += 1) {
        const who = i % 3 === 0 ? Y : X;
        // 保底的情境下有些寫入會被拒（沒有人超過保底可淘汰），那不是這裡要驗的
        store.put(chunk(who, NOW + DAY + Math.floor(i / 5) * 60, NOW + i), NOW + i);
      }
      const lookups = log.filter((l) => /\bbatch\b/.test(l.query) && /^\s*select/i.test(l.query));
      expect(lookups.length).toBeGreaterThan(0);
      for (const l of lookups) {
        expect(plan(l.query, l.bindings), l.query).not.toMatch(/SCAN offline_msgs USING (COVERING )?INDEX idx_offline_batch/);
      }
    });
  }
});

describe('借用列的查詢只讀借用列的部分索引（SDK ADR 0102 三）', { timeout: 30_000 }, () => {
  it('🔴 借用帶回收時列出借用列：不走整個到期索引（那是每一列）', () => {
    const { store, log, plan } = spied({ offlineMaxTotalBytes: SIZE * 40, ceilingEvicts: true, guaranteeBytes: SIZE * 20, overflowRatio: 0.2 });
    for (let i = 0; i < 120; i += 1) store.put(chunk(i % 3 === 0 ? Y : X, NOW + DAY + Math.floor(i / 5) * 60, NOW + i), NOW + i);
    const borrowed = log.filter((l) => /borrowed = 1/.test(l.query) && /^\s*select/i.test(l.query));
    expect(borrowed.length).toBeGreaterThan(0);
    for (const l of borrowed) expect(plan(l.query, l.bindings), l.query).not.toMatch(/SCAN offline_msgs USING INDEX idx_offline_expiration/);
  });

  it('🔴 每小時清理：查到期借用列的批次時不掃整個 idx_offline_batch', () => {
    const { store, log, plan } = spied({ offlineMaxTotalBytes: SIZE * 40, ceilingEvicts: true, guaranteeBytes: SIZE * 20, overflowRatio: 0.2, countDrops: true });
    for (let i = 0; i < 120; i += 1) store.put(chunk(i % 3 === 0 ? Y : X, NOW + DAY + Math.floor(i / 5) * 60, NOW + i), NOW + i);
    log.length = 0;
    store.prune(NOW + 3 * 3600);
    const reads = log.filter((l) => /^\s*select/i.test(l.query));
    expect(reads.length).toBeGreaterThan(0);
    for (const l of reads) expect(plan(l.query, l.bindings), l.query).not.toMatch(/SCAN offline_msgs USING (COVERING )?INDEX idx_offline_batch/);
  });
});

describe('只問一位收件人、一種 kind 的分頁查詢順著索引讀（SDK ADR 0103）', { timeout: 30_000 }, () => {
  it('🔴 外掛啟動補拉的形狀（#p 一位、kinds 一種、until、有位元組預算）：不把剩下的列全部拿出來排序', () => {
    const { store, log, plan } = spied({ filePerRecipient: 10_000 });
    for (let i = 0; i < 300; i += 1) store.put(chunk(X, NOW + DAY, NOW - 1000 + i), NOW);
    log.length = 0;
    const page = store.query({ kinds: [1060], '#p': [X], until: NOW }, NOW, 64 * SIZE);
    expect(page.length).toBe(64);
    const selects = log.filter((l) => /^\s*select/i.test(l.query) && /FROM offline_msgs/.test(l.query));
    expect(selects.length).toBeGreaterThan(0);
    for (const l of selects) {
      // 允許「只排同一秒的那幾列」（LAST TERM），不允許整個重排
      expect(plan(l.query, l.bindings), l.query).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    }
  });

  it('多位收件人或多種 kind 照舊（結果不變）', () => {
    const { store } = spied({ filePerRecipient: 10_000 });
    for (let i = 0; i < 20; i += 1) store.put(chunk(i % 2 ? X : Y, NOW + DAY, NOW - 100 + i), NOW);
    expect(store.query({ kinds: [1060], '#p': [X, Y] }, NOW).length).toBe(20);
    expect(store.query({ kinds: [1060, 1059], '#p': [X] }, NOW).length).toBe(10);
    expect(store.query({ kinds: [1060], '#p': [X] }, NOW).length).toBe(10);
  });
});

describe('淘汰後每個人的保底用量照實扣掉，不整個重建（SDK ADR 0103）', { timeout: 30_000 }, () => {
  /** 從資料庫實算每個 key 的正常列用量（與 ownerNormalUsage 同一個定義） */
  function truth(db: { prepare(q: string): { all(): unknown[] } }): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of db.prepare(
      `SELECT CASE WHEN recipient = '' THEN pubkey ELSE recipient END AS o, SUM(bytes) AS n FROM offline_msgs WHERE borrowed = 0 GROUP BY o`,
    ).all() as { o: string; n: number }[]) out.set(row.o, row.n);
    return out;
  }

  it('🔴 錨點的比例（每收件人上限×3 落在天花板與天花板＋溢位帶之間）、整批淘汰：塞滿後連續寫入不重建用量（沒有 GROUP BY、沒有逐人重算），而且快取與實算一致', () => {
    const db = new DatabaseSync(':memory:');
    const log: string[] = [];
    const store = new SqlMessageStore((q, ...b) => {
      log.push(q);
      const stmt = db.prepare(q);
      if (/^\s*select/i.test(q)) return stmt.all(...(b as never[])) as Record<string, unknown>[];
      stmt.run(...(b as never[]));
      return [];
    }, { offlineMaxTotalBytes: SIZE * 40, ceilingEvicts: true, guaranteeBytes: SIZE * 8, overflowRatio: 0.2, borrowPerKeyBytes: SIZE * 8, filePerRecipient: 14 });
    const Z = getPublicKey(generateSecretKey());
    for (let i = 0; i < 90; i += 1) store.put(chunk([X, Y, Z][i % 3]!, NOW + DAY + Math.floor(i / 4) * 60, NOW + i), NOW + i);
    log.length = 0;
    for (let i = 90; i < 180; i += 1) store.put(chunk([X, Y, Z][i % 3]!, NOW + DAY + Math.floor(i / 4) * 60, NOW + i), NOW + i);
    expect(log.filter((q) => /GROUP BY/.test(q))).toEqual([]);
    expect(log.filter((q) => /SUM\(bytes\), 0\) AS n FROM offline_msgs WHERE recipient = \? OR/.test(q))).toEqual([]);
    const cached = (store as unknown as { ownerNormal?: Map<string, number> }).ownerNormal;
    expect(cached).toBeDefined();
    const real = truth(db);
    for (const key of new Set([...cached!.keys(), ...real.keys()])) expect(cached!.get(key) ?? 0, key).toBe(real.get(key) ?? 0);
  });
});

describe('淘汰後每收件人的列數照實扣掉，不整個重數（SDK ADR 0102 二）', { timeout: 30_000 }, () => {
  it('🔴 天花板滿了之後連續寫入：不再對收件人下 COUNT(*)', () => {
    const { store, log } = spied({ offlineMaxTotalBytes: SIZE * 30, ceilingEvicts: true, filePerRecipient: 1000 });
    for (let i = 0; i < 60; i += 1) store.put(chunk(i % 2 ? X : Y, NOW + DAY + i, NOW + i), NOW + i);
    log.length = 0;
    for (let i = 60; i < 120; i += 1) store.put(chunk(i % 2 ? X : Y, NOW + DAY + i, NOW + i), NOW + i);
    expect(log.filter((l) => /COUNT\(\*\)/.test(l.query) && /recipient = \?/.test(l.query))).toEqual([]);
  });

  it('🔴 被天花板淘汰掉的列有扣掉：之後每收件人上限剛好在上限才動手（不提早、不超過）', () => {
    // X 先放 4 顆（各自一批），Y 的寫入撐爆天花板、淘汰最早到期的 X 兩顆；X 再放 2 顆，剛好回到上限 4，一顆都不該被上限刪掉
    const { store, count } = spied({ offlineMaxTotalBytes: SIZE * 6, ceilingEvicts: true, filePerRecipient: 4 });
    for (let i = 0; i < 4; i += 1) expect(store.put(chunk(X, NOW + DAY + i, NOW + i), NOW)).toBe(true);
    for (let i = 0; i < 4; i += 1) expect(store.put(chunk(Y, NOW + 5 * DAY + i, NOW + 10 + i), NOW)).toBe(true);
    expect(count(X)).toBe(2);
    expect(store.put(chunk(X, NOW + 9 * DAY, NOW + 20), NOW)).toBe(true);
    expect(store.put(chunk(X, NOW + 9 * DAY + 1, NOW + 21), NOW)).toBe(true);
    expect(count(X)).toBeLessThanOrEqual(4);
    // 天花板 6 顆：Y 4 顆＋X 2 顆已滿，再放 X 會淘汰最早到期的那顆 X——但不是因為上限
    expect(count(X) + count(Y)).toBeLessThanOrEqual(6);
  });

  it('整批淘汰刪掉同批的其他列後，那個收件人的列數也扣掉', () => {
    const { store, count, log } = spied({ filePerRecipient: 4 });
    for (let i = 0; i < 3; i += 1) store.put(chunk(X, NOW + DAY, NOW - 100 + i), NOW); // 舊的一批 3 顆
    for (let i = 0; i < 3; i += 1) store.put(chunk(X, NOW + 2 * DAY, NOW + i), NOW); // 新的一批，第 2 顆起超過上限 → 舊批整批刪
    expect(count(X)).toBe(3);
    log.length = 0;
    // 再放 1 顆＝4 顆，不該刪任何東西；也不該重數
    expect(store.put(chunk(X, NOW + 3 * DAY, NOW + 9), NOW)).toBe(true);
    expect(count(X)).toBe(4);
    expect(log.filter((l) => /COUNT\(\*\)/.test(l.query))).toEqual([]);
  });
});
