// 休眠喚醒與分頁補拉的讀取列數（SDK ADR 0126）。2026-10-22 錨點 1 的 CinderSync 車道 5 小時讀了 535 萬列、
// 撞到免費方案每日 500 萬列的上限後整天停擺。miniflare 實測（真的 workerd＋SQLite、讀 Cloudflare 計費用的 rowsRead）三個來源：
//   一、每次建 store（每次喚醒建兩次）跑的 pubkey/kind 回填，`WHERE pubkey IS NULL OR kind IS NULL` 掃全表；
//   二、喚醒後第一次寫入重算總量 `SUM(bytes)`（掃整個分桶索引），可尋址事件則是**每一次**寫入都 `SUM(LENGTH(json))`；
//   三、`#p` 分頁查詢多排一個 `rowid`，SQLite 得把整個桶讀出來排序——LIMIT 1024 讀了 2049 列，兩步各一次。
// node:sqlite 量不到列數，這裡跟 evict-reads 一樣用查詢計畫與「下了哪些 SQL」守住。
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from '../../src/protocol/index.js';
import { type MessageStoreOptions } from '../../src/relay/message-store.js';
import { SqlMessageStore } from '../../src/relay/sql-message-store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

const NOW = 1_760_000_000;
const X = getPublicKey(generateSecretKey());
const AUTHOR = generateSecretKey();

function chunk(recipient: string, createdAt: number): NostrEvent {
  return finalizeEvent({ kind: 1060, created_at: createdAt, tags: [['p', recipient]], content: 'x'.repeat(500) }, generateSecretKey());
}
function snapshot(d: string, createdAt: number): NostrEvent {
  return finalizeEvent({ kind: 30078, created_at: createdAt, tags: [['d', d]], content: 'y'.repeat(500) }, AUTHOR);
}
const SIZE = JSON.stringify(chunk(X, NOW)).length;

/** 同一個 DB 上可以重開 store（模擬喚醒），記下每一條 SQL，可以事後看查詢計畫 */
function harness() {
  const db = new DatabaseSync(':memory:');
  let log: { query: string; bindings: unknown[] }[] = [];
  const exec = (q: string, ...b: (string | number | null)[]) => {
    log.push({ query: q, bindings: b });
    const stmt = db.prepare(q);
    if (/^\s*select/i.test(q)) return stmt.all(...(b as never[])) as Record<string, unknown>[];
    stmt.run(...(b as never[]));
    return [];
  };
  const open = (opts: MessageStoreOptions = {}) => new SqlMessageStore(exec, opts);
  const plan = (q: string, b: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...(b as never[])) as { detail: string }[]).map((r) => r.detail).join(' | ');
  /** 從現在起記錄 */
  const reset = () => (log = []);
  /** 記錄到的 SELECT／UPDATE／DELETE 與它們的查詢計畫 */
  const planned = () =>
    log.filter((l) => /^\s*(select|update|delete)/i.test(l.query)).map((l) => ({ query: l.query, plan: plan(l.query, l.bindings) }));
  /** 直接在 DB 上跑（不記錄） */
  const raw = (q: string) => db.exec(q);
  return { open, reset, planned, raw };
}

/** 讀整張表的計畫（SCAN；走一般索引也是整個索引）。部分索引只收少數列（缺欄位的舊列、借用列、整批），掃它不算。 */
const PARTIAL = /USING (COVERING )?INDEX idx_offline_(bytes_missing|borrowed|batch)$/;
const fullScan = (plan: string) => /SCAN offline_msgs( |$)/.test(plan) && !PARTIAL.test(plan);

describe('喚醒時建 store 不掃全表（SDK ADR 0126 一）', () => {
  it('🔴 重開一個有資料的 store：遷移與回填的 SQL 沒有任何一條掃整張 offline_msgs', () => {
    const h = harness();
    const first = h.open();
    for (let i = 0; i < 30; i += 1) first.put(chunk(X, NOW + i), NOW);
    h.reset();
    h.open();
    const scans = h.planned().filter((p) => fullScan(p.plan));
    expect(scans, scans.map((s) => s.query).join('\n')).toEqual([]);
  });

  it('升級前的列（沒有 pubkey/kind）仍會被回填', () => {
    const h = harness();
    const e = chunk(X, NOW);
    h.open().put(e, NOW);
    // 模擬 ADR-0235 C2 之前寫入的列
    h.raw(`UPDATE offline_msgs SET pubkey = NULL, kind = NULL`);
    const reopened = h.open();
    expect(reopened.query({ authors: [e.pubkey], kinds: [1060] }, NOW).map((x) => x.id)).toEqual([e.id]);
  });
});

describe('喚醒後寫入不重算總量（SDK ADR 0126 二）', () => {
  const opts: MessageStoreOptions = {
    offlineMaxTotalBytes: SIZE * 1000,
    addressableMaxTotalBytes: SIZE * 1000,
    ceilingEvicts: true,
    nearFullPercent: 80,
  };

  it('🔴 給了資料庫大小（上界）、而且離天花板很遠：離線留言寫入不跑 SUM', () => {
    const h = harness();
    const first = h.open(opts);
    for (let i = 0; i < 30; i += 1) first.put(chunk(X, NOW + i), NOW);
    h.reset();
    const store = h.open({ ...opts, sizeUpperBound: () => SIZE * 40 });
    expect(store.putResult(chunk(X, NOW + 99), NOW)).toEqual({ ok: true });
    const sums = h.planned().filter((p) => /SUM\(/i.test(p.query));
    expect(sums.map((s) => s.query)).toEqual([]);
  });

  it('🔴 可尋址事件同理：每次寫入都不 SUM(LENGTH(json))', () => {
    const h = harness();
    const store = h.open({ ...opts, sizeUpperBound: () => SIZE * 40 });
    store.putAddressable(snapshot('a', NOW), NOW);
    h.reset();
    expect(store.putAddressableResult(snapshot('b', NOW + 1), NOW).ok).toBe(true);
    const sums = h.planned().filter((p) => /SUM\(/i.test(p.query));
    expect(sums.map((s) => s.query)).toEqual([]);
  });

  it('上界接近天花板時照舊精算（上界只用來「確定放得下」，不用來拒收或淘汰）', () => {
    const h = harness();
    const small: MessageStoreOptions = { offlineMaxTotalBytes: SIZE * 10, ceilingEvicts: false };
    const s = h.open({ ...small, sizeUpperBound: () => SIZE * 1_000_000 });
    // 上界遠超天花板，但實際只有 3 顆：照樣放得下
    for (let i = 0; i < 3; i += 1) expect(s.putResult(chunk(X, NOW + i), NOW).ok).toBe(true);
    // 真的滿了才拒收
    for (let i = 3; i < 10; i += 1) s.put(chunk(X, NOW + i), NOW);
    expect(s.putResult(chunk(X, NOW + 50), NOW)).toEqual({ ok: false, reason: 'ceiling' });
  });

  it('宿主給不出有效的上界（undefined、NaN、負數）：照舊精算，結果相同', () => {
    for (const bad of [undefined, Number.NaN, -1]) {
      const h = harness();
      const s = h.open({ offlineMaxTotalBytes: SIZE * 3, ceilingEvicts: false, sizeUpperBound: () => bad as unknown as number });
      for (let i = 0; i < 3; i += 1) expect(s.putResult(chunk(X, NOW + i), NOW).ok).toBe(true);
      expect(s.putResult(chunk(X, NOW + 9), NOW)).toEqual({ ok: false, reason: 'ceiling' });
    }
  });

  it('上界在預警線上時照舊精算預警（不會因為上界偏大就誤報）', () => {
    const h = harness();
    const s = h.open({ offlineMaxTotalBytes: SIZE * 10, nearFullPercent: 80, sizeUpperBound: () => SIZE * 9 });
    expect(s.putResult(chunk(X, NOW), NOW)).toEqual({ ok: true });
  });
});

describe('#p 分頁查詢只讀一頁（SDK ADR 0126 三）', () => {
  it('🔴 #p＋kinds（補拉收件匣、分頁）不需要把整個桶讀出來排序', () => {
    const h = harness();
    const s = h.open();
    for (let i = 0; i < 30; i += 1) s.put(chunk(X, NOW + i), NOW);
    for (const budget of [undefined, 16 * 1024 * 1024]) {
      for (const extra of [{}, { until: NOW + 15 }, { since: NOW + 10 }]) {
        h.reset();
        s.query({ kinds: [1060], '#p': [X], ...extra, limit: 5 }, NOW, budget);
        const selects = h.planned().filter((p) => /FROM offline_msgs/.test(p.query));
        expect(selects.length).toBeGreaterThan(0);
        for (const p of selects) expect(p.plan, p.query).not.toMatch(/TEMP B-TREE/);
      }
    }
  });

  it('同一秒的多顆：分頁的兩步挑到同一批、翻頁不漏不重', () => {
    const h = harness();
    const s = h.open();
    const all = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const e = chunk(X, NOW + Math.floor(i / 2)); // 每秒 2 顆（一頁 3 顆＝每頁都切在同一秒的中間）
      all.add(e.id);
      s.put(e, NOW);
    }
    const seen = new Set<string>();
    let until: number | undefined;
    for (let page = 0; page < 10; page += 1) {
      const got = s.query({ kinds: [1060], '#p': [X], limit: 3, ...(until !== undefined ? { until } : {}) }, NOW, 16 * 1024 * 1024);
      // 照 forEachPage（SDK ADR 0029）：沒有新的就停、以這一頁最舊的那一秒（含）當下一頁的 until
      const fresh = got.filter((e) => !seen.has(e.id));
      if (fresh.length === 0) break;
      for (const e of fresh) seen.add(e.id);
      const oldest = Math.min(...got.map((e) => e.created_at));
      until = until !== undefined && oldest >= until ? until - 1 : oldest;
    }
    expect([...seen].sort()).toEqual([...all].sort());
    // 預算只放得下 2 顆：兩步挑的是同一批（第二步拿到的就是第一步算過大小的那幾列）
    const two = s.query({ kinds: [1060], '#p': [X] }, NOW, SIZE * 2 + 1);
    const top = s.query({ kinds: [1060], '#p': [X], limit: 2 }, NOW);
    expect(two.map((e) => e.id)).toEqual(top.map((e) => e.id));
  });
});
