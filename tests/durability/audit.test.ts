// 讀回稽核（SDK ADR 0038 M4；ADR 0041 §4）：逐座查回自己的可尋址事件與收件匣，找出被淘汰的。
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auditOwnEvents, OwnEventAuditor, type AuditPool, type AuditTarget } from '../../src/durability/index.js';
import { Identity } from '../../src/identity.js';
import { RelayPool, type QueryEachOptions, type RelayQueryResult } from '../../src/relay-pool.js';
import { SocketFactory } from '../fake-socket.js';

const me = Identity.generate();
const other = Identity.generate();
const A = 'wss://a.example';
const B = 'wss://b.example';

function bucket(d: string, createdAt: number): Event {
  return me.sign({ kind: 31438, created_at: createdAt, tags: [['d', d]], content: d }) as Event;
}

/** 以記憶體裡每座的事件回答 filter 的假池（只實作稽核用到的欄位） */
class FakeRelays implements AuditPool {
  readonly stores = new Map<string, Event[]>();
  readonly requests: Filter[][] = [];
  readonly evicted: [string, number][] = [];
  status = new Map<string, RelayQueryResult['status']>();

  constructor(urls: string[]) {
    for (const url of urls) this.stores.set(url, []);
  }

  async queryEach(filters: Filter[], options: QueryEachOptions = {}): Promise<RelayQueryResult[]> {
    this.requests.push(filters);
    return (options.relays ?? [...this.stores.keys()]).map((url) => {
      const status = this.status.get(url) ?? 'eose';
      const events = status === 'eose' ? (this.stores.get(url) ?? []).filter((e) => filters.some((f) => matches(f, e))) : [];
      return { url, status, events };
    });
  }

  markEvicted(url: string, kind: number): void {
    this.evicted.push([url, kind]);
  }
}

function matches(filter: Filter, event: Event): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  const d = filter['#d'];
  if (d && !event.tags.some((t) => t[0] === 'd' && d.includes(t[1]!))) return false;
  const p = filter['#p'];
  if (p && !event.tags.some((t) => t[0] === 'p' && p.includes(t[1]!))) return false;
  return true;
}

describe('auditOwnEvents', () => {
  it('🔴 找出某座被淘汰的可尋址桶；同一批合併成一個 #d filter；標成已滿', async () => {
    const relays = new FakeRelays([A, B]);
    const b1 = bucket('b1', 100);
    const b2 = bucket('b2', 200);
    relays.stores.set(A, [b1, b2]);
    relays.stores.set(B, [b2]); // B 把最久沒更新的 b1 擠掉了
    const targets: AuditTarget[] = [
      { type: 'addressable', kind: 31438, pubkey: me.pubkey, d: 'b1', updatedAt: 100 },
      { type: 'addressable', kind: 31438, pubkey: me.pubkey, d: 'b2', updatedAt: 200 },
    ];
    const report = await auditOwnEvents(relays, targets, { self: me.pubkey });
    expect(report.missing).toEqual([{ target: targets[0], relays: [B] }]);
    expect(report.inconclusive).toEqual([]);
    expect(relays.requests).toEqual([[{ kinds: [31438], authors: [me.pubkey], '#d': ['b1', 'b2'], limit: 2 }]]);
    expect(relays.evicted).toEqual([[B, 31438]]);
  });

  it('outdated：那一座只剩比較舊的版本（最新那一版不見了）', async () => {
    const relays = new FakeRelays([A, B]);
    const old = bucket('b1', 100);
    const latest = bucket('b1', 300);
    relays.stores.set(A, [latest]);
    relays.stores.set(B, [old]);
    const target: AuditTarget = { type: 'addressable', kind: 31438, pubkey: me.pubkey, d: 'b1', id: latest.id, createdAt: 300 };
    const report = await auditOwnEvents(relays, [target], { self: me.pubkey, markEvicted: false });
    expect(report.missing).toEqual([]);
    expect(report.outdated).toEqual([{ target, relay: B, found: { id: old.id, created_at: 100 } }]);
    expect(relays.evicted).toEqual([]);
  });

  it('一般事件（作者是自己）與收件匣（#p 自己）：分別以 authors／#p 查；寄給別人的禮物包列為查不到', async () => {
    const relays = new FakeRelays([A, B]);
    const note = me.sign({ kind: 1, created_at: 1, tags: [], content: 'hi' }) as Event;
    const inbox = other.sign({ kind: 1059, created_at: 2, tags: [['p', me.pubkey]], content: 'wrap' }) as Event;
    relays.stores.set(A, [note, inbox]);
    relays.stores.set(B, [note]); // B 把收件匣裡那一則擠掉了（FIFO）
    const giftToOther: AuditTarget = { type: 'event', id: 'ff'.repeat(32), kind: 1059, recipient: other.pubkey };
    const report = await auditOwnEvents(
      relays,
      [{ type: 'event', id: note.id, kind: 1 }, { type: 'event', id: inbox.id, kind: 1059, recipient: me.pubkey }, giftToOther],
      { self: me.pubkey },
    );
    expect(report.unauditable).toEqual([giftToOther]);
    expect(report.missing.map((m) => [m.target.type === 'event' && m.target.id, m.relays])).toEqual([[inbox.id, [B]]]);
    expect(relays.requests[0]).toEqual([
      { ids: [note.id], authors: [me.pubkey], limit: 1 },
      { ids: [inbox.id], '#p': [me.pubkey], limit: 1 },
    ]);
  });

  it('沒有完整回覆的那座（逾時、CLOSED）不算遺失，列在 inconclusive', async () => {
    const relays = new FakeRelays([A, B]);
    relays.stores.set(A, [bucket('b1', 1)]);
    relays.status.set(B, 'timeout');
    const report = await auditOwnEvents(relays, [{ type: 'addressable', kind: 31438, pubkey: me.pubkey, d: 'b1' }], { self: me.pubkey });
    expect(report.missing).toEqual([]);
    expect(report.inconclusive).toEqual([{ url: B, status: 'timeout' }]);
  });

  it('抽樣：最久沒更新的優先；分批', async () => {
    const relays = new FakeRelays([A]);
    const targets: AuditTarget[] = [5, 1, 4, 2, 3].map((n) => ({ type: 'addressable', kind: 31438, pubkey: me.pubkey, d: `b${n}`, updatedAt: n }));
    const report = await auditOwnEvents(relays, targets, { self: me.pubkey, sample: 3, batchSize: 2 });
    expect(report.checked.map((t) => (t.type === 'addressable' ? t.d : ''))).toEqual(['b1', 'b2', 'b3']);
    expect(report.deferred).toBe(2);
    expect(relays.requests.map((r) => r[0]!['#d'])).toEqual([['b1', 'b2'], ['b3']]);
  });
});

describe('OwnEventAuditor：速率限制與輪流', () => {
  it('兩輪之間至少隔 minIntervalMs；剛查過的往後排，輪流查到每一個', async () => {
    let now = 1_000_000;
    const relays = new FakeRelays([A]);
    const auditor = new OwnEventAuditor({ pool: relays, self: me.pubkey, sample: 2, minIntervalMs: 60_000, now: () => now });
    const targets: AuditTarget[] = [1, 2, 3].map((n) => ({ type: 'addressable', kind: 31438, pubkey: me.pubkey, d: `b${n}`, updatedAt: n }));
    const first = await auditor.run(targets);
    expect('checked' in first && first.checked.map((t) => (t.type === 'addressable' ? t.d : ''))).toEqual(['b1', 'b2']);
    now += 1000;
    expect(await auditor.run(targets)).toEqual({ skipped: 'rate-limited', nextRunAt: 1_060_000 });
    now += 60_000;
    const second = await auditor.run(targets);
    expect('checked' in second && second.checked.map((t) => (t.type === 'addressable' ? t.d : ''))).toEqual(['b3', 'b1']);
    expect(relays.requests).toHaveLength(2);
  });
});

describe('G12a（SDK ADR 0045）：沒有任何中繼回完的那一批不算「查過了」', () => {
  it('verified 只列有中繼回完的目標；OwnEventAuditor 不把沒查到的往後排、也不佔速率限制', async () => {
    let now = 1_000_000;
    const relays = new FakeRelays([A, B]);
    relays.status.set(A, 'not-connected');
    relays.status.set(B, 'timeout');
    const auditor = new OwnEventAuditor({ pool: relays, self: me.pubkey, sample: 2, minIntervalMs: 60_000, now: () => now });
    const targets: AuditTarget[] = [1, 2, 3].map((n) => ({ type: 'addressable', kind: 31438, pubkey: me.pubkey, d: `b${n}`, updatedAt: n }));
    const first = await auditor.run(targets);
    expect('verified' in first && first.verified).toEqual([]);
    expect('inconclusive' in first && first.inconclusive.map((r) => r.status)).toEqual(['not-connected', 'timeout']);
    // 一個都沒查到：不佔速率限制，連上之後可以馬上再跑；沒查到的照舊排在前面
    now += 1000;
    relays.status.clear();
    const second = await auditor.run(targets);
    expect('checked' in second && second.checked.map((t) => (t.type === 'addressable' ? t.d : ''))).toEqual(['b1', 'b2']);
    expect('verified' in second && second.verified.map((t) => (t.type === 'addressable' ? t.d : ''))).toEqual(['b1', 'b2']);
  });
});

describe('與 RelayPool 整合：queryEach → auditOwnEvents → 健康狀態', () => {
  afterEach(() => vi.useRealTimers());

  it('中繼把桶淘汰了：稽核找出來，那一座的可尋址標成已滿（耐久發布會略過它）', async () => {
    vi.useFakeTimers();
    const factory = new SocketFactory();
    const pool = new RelayPool({ urls: [A, B], createSocket: factory.create, publishTimeoutMs: 1000 });
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
    const b1 = JSON.parse(JSON.stringify(bucket('b1', 100))) as Event;
    const running = auditOwnEvents(pool, [{ type: 'addressable', kind: 31438, pubkey: me.pubkey, d: 'b1' }], { self: me.pubkey });
    await vi.advanceTimersByTimeAsync(0);
    const [reqA] = factory.latest(A).sentOfType('REQ');
    const [reqB] = factory.latest(B).sentOfType('REQ');
    factory.latest(A).receive(['EVENT', reqA![1], b1]);
    factory.latest(A).receive(['EOSE', reqA![1]]);
    factory.latest(B).receive(['EOSE', reqB![1]]);
    const report = await running;
    expect(report.missing.map((m) => m.relays)).toEqual([[B]]);
    expect(pool.relayHealth().get(B)!.marks).toEqual([expect.objectContaining({ scope: 'addressable', state: 'full' })]);
    expect(pool.writeSet(31438)).toEqual([A]);
    pool.close();
  });
});
