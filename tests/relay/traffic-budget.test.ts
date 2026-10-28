// Node 版中繼的每月流量預算（SDK ADR 0101）：`MONTHLY_TRAFFIC_GIB`、`TRAFFIC_RESET_DAY`、`TRAFFIC_COUNT`、
// `TRAFFIC_NEAR_FULL_PERCENT`。用完時新舊連線都收到 `over quota:` 並以 1013 關閉，到重置日自動恢復。
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { finalizeEvent, generateSecretKey } from '../../src/protocol/index.js';
import { classifyRelayMessage } from '../../src/protocol/relay-reject.js';
import { startNodeRelay } from '../../src/relay/node-relay.js';
import { opened } from '../node-relay-harness.js';
import type { SqlExec } from '../../src/relay/sql-message-store.js';
import { TrafficMeter, trafficBudgetFrom, trafficPeriod } from '../../src/relay/traffic-budget.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };
const GIB = 1024 ** 3;
const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);

function openExec(): { db: DatabaseSyncType; exec: SqlExec } {
  const db = new DatabaseSync(':memory:');
  const exec: SqlExec = (query, ...bindings) => {
    const stmt = db.prepare(query);
    if (/^\s*select/i.test(query)) return stmt.all(...(bindings as never[])) as Record<string, unknown>[];
    stmt.run(...(bindings as never[]));
    return [];
  };
  return { db, exec };
}

describe('trafficBudgetFrom（SDK ADR 0101）', () => {
  it('沒設 MONTHLY_TRAFFIC_GIB＝不限（與之前相同）', () => {
    expect(trafficBudgetFrom({})).toEqual({ ignored: [] });
  });

  it('預設：每月 1 號重置、進出合計、沒有預警', () => {
    expect(trafficBudgetFrom({ MONTHLY_TRAFFIC_GIB: '900' })).toEqual({
      budget: { budgetBytes: 900 * GIB, resetDay: 1, count: 'total' },
      ignored: [],
    });
  });

  it('重置日 1–28、只算出去的、預警 50–99', () => {
    expect(
      trafficBudgetFrom({ MONTHLY_TRAFFIC_GIB: '100', TRAFFIC_RESET_DAY: '15', TRAFFIC_COUNT: 'out', TRAFFIC_NEAR_FULL_PERCENT: '90' }).budget,
    ).toEqual({ budgetBytes: 100 * GIB, resetDay: 15, count: 'out', nearFullPercent: 90 });
  });

  it('🔴 設錯的項目不生效、列進 ignored（寫錯的預算＝沒有預算，一定要看得見）', () => {
    const r = trafficBudgetFrom({ MONTHLY_TRAFFIC_GIB: '100', TRAFFIC_RESET_DAY: '31', TRAFFIC_COUNT: 'in', TRAFFIC_NEAR_FULL_PERCENT: '20' });
    expect(r.budget).toEqual({ budgetBytes: 100 * GIB, resetDay: 1, count: 'total' });
    expect(r.ignored).toEqual(['TRAFFIC_RESET_DAY: 31', 'TRAFFIC_COUNT: in', 'TRAFFIC_NEAR_FULL_PERCENT: 20']);
    expect(trafficBudgetFrom({ MONTHLY_TRAFFIC_GIB: 'lots' })).toEqual({ ignored: ['MONTHLY_TRAFFIC_GIB: lots'] });
  });
});

describe('trafficPeriod：計費週期（UTC）', () => {
  it('重置日當天 00:00 起算，到下個月同一天', () => {
    expect(trafficPeriod(utc(2026, 10, 19, 5), 1)).toEqual({ start: utc(2026, 10, 1), end: utc(2026, 11, 1), key: '2026-10-01' });
    expect(trafficPeriod(utc(2026, 10, 19, 5), 20)).toEqual({ start: utc(2026, 9, 20), end: utc(2026, 10, 20), key: '2026-09-20' });
    expect(trafficPeriod(utc(2026, 10, 20, 0), 20).key).toBe('2026-10-20');
  });

  it('跨年', () => {
    expect(trafficPeriod(utc(2027, 1, 5), 15)).toEqual({ start: utc(2026, 12, 15), end: utc(2027, 1, 15), key: '2026-12-15' });
    expect(trafficPeriod(utc(2026, 12, 31), 1).end).toBe(utc(2027, 1, 1));
  });
});

describe('TrafficMeter', () => {
  const budget = { budgetBytes: 1000, resetDay: 1, count: 'total' as const, nearFullPercent: 80 };

  it('進出合計；用完就 exhausted；預警分兩級（站方設定的一級與 95）', () => {
    let now = utc(2026, 10, 19);
    const meter = new TrafficMeter(budget, { now: () => now });
    meter.record('in', 500);
    expect(meter.nearFullLevel()).toBeUndefined();
    meter.record('out', 300);
    expect(meter.nearFullLevel()).toBe(80);
    meter.record('out', 160);
    expect(meter.nearFullLevel()).toBe(95);
    expect(meter.snapshot()).toMatchObject({ usedBytes: 960, exhausted: false, resetsAt: utc(2026, 11, 1) / 1000 });
    meter.record('in', 40);
    expect(meter.snapshot().exhausted).toBe(true);
    // 🔴 到了重置日自動恢復
    now = utc(2026, 11, 1);
    expect(meter.snapshot()).toMatchObject({ usedBytes: 0, exhausted: false, resetsAt: utc(2026, 12, 1) / 1000 });
  });

  it('count: out＝只算出去的', () => {
    const meter = new TrafficMeter({ ...budget, count: 'out' }, { now: () => utc(2026, 10, 19) });
    meter.record('in', 5000);
    meter.record('out', 10);
    expect(meter.snapshot().usedBytes).toBe(10);
  });

  it('🔴 用量存在 SQLite：重開不會歸零；換了週期就從零開始', () => {
    const { exec } = openExec();
    let now = utc(2026, 10, 19);
    const first = new TrafficMeter(budget, { exec, now: () => now });
    first.record('out', 700);
    first.flush();
    const second = new TrafficMeter(budget, { exec, now: () => now });
    expect(second.snapshot().usedBytes).toBe(700);
    now = utc(2026, 11, 2);
    expect(new TrafficMeter(budget, { exec, now: () => now }).snapshot().usedBytes).toBe(0);
  });
});

const handles: { close(): void }[] = [];
const clients: WsClient[] = [];
afterEach(() => {
  for (const ws of clients.splice(0)) ws.terminate();
  for (const handle of handles.splice(0)) handle.close();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function open(url: string): Promise<{ ws: WsClient; messages: unknown[][]; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    clients.push(ws);
    const messages: unknown[][] = [];
    const closed = new Promise<{ code: number; reason: string }>((done) => ws.on('close', (code, reason) => done({ code, reason: reason.toString() })));
    ws.on('message', (data) => messages.push(JSON.parse(String(data)) as unknown[]));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('error', reject);
  });
}

const note = (sk: Uint8Array, size: number) =>
  finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x'.repeat(size) }, sk);

describe('startNodeRelay：每月流量預算（SDK ADR 0101）', () => {
  it('🔴 快用完時 OK 帶 near-full 預警（客戶端照既有的分類認得）；NIP-11 公告用量百分比', async () => {
    // MONTHLY_TRAFFIC_GIB 只收整數 GiB，測試用不完：改用呼叫端選項 trafficBudget 設成 20 KB
    const p = await opened(handles,
      startNodeRelay({ PORT: '0', REQUIRE_AUTH: '0', MAX_EVENTS_PER_MINUTE: '0' }, { memory: true, trafficBudget: { budgetBytes: 20_000, resetDay: 1, count: 'total', nearFullPercent: 50 } }),
    );
    await wait(100);
    const { ws, messages } = await open(`ws://127.0.0.1:${p}`);
    const sk = generateSecretKey();
    ws.send(JSON.stringify(['EVENT', note(sk, 6_000)]));
    ws.send(JSON.stringify(['EVENT', note(sk, 6_001)]));
    await wait(300);
    const oks = messages.filter((m) => m[0] === 'OK');
    expect(oks[0]![3]).toBe('');
    expect(String(oks[1]![3])).toMatch(/^warning: near-full: 50: /);
    expect(classifyRelayMessage(String(oks[1]![3])).kind).toBe('near-full');
    const info = (await (await fetch(`http://127.0.0.1:${p}/`, { headers: { accept: 'application/nostr+json' } })).json()) as {
      cinder_traffic?: { count: string; used_percent: number; resets_at: number };
    };
    expect(info.cinder_traffic?.count).toBe('total');
    expect(info.cinder_traffic?.used_percent).toBeGreaterThanOrEqual(50);
    expect(info.cinder_traffic?.resets_at).toBeGreaterThan(Date.now() / 1000);
  });

  it('🔴 用完：既有連線收到 over quota 並以 1013 關閉；新連線也一樣', async () => {
    const p = await opened(handles,
      startNodeRelay({ PORT: '0', REQUIRE_AUTH: '0', MAX_EVENTS_PER_MINUTE: '0' }, { memory: true, trafficBudget: { budgetBytes: 10_000, resetDay: 1, count: 'total' } }),
    );
    await wait(100);
    const url = `ws://127.0.0.1:${p}`;
    const bystander = await open(url);
    const sender = await open(url);
    sender.ws.send(JSON.stringify(['EVENT', note(generateSecretKey(), 12_000)]));
    const [a, b] = await Promise.all([bystander.closed, sender.closed]);
    expect(a).toEqual({ code: 1013, reason: 'over quota' });
    expect(b.code).toBe(1013);
    expect(String(bystander.messages.find((m) => m[0] === 'NOTICE')?.[1])).toMatch(/^over quota: .*monthly traffic/);
    const late = await open(url);
    expect((await late.closed).code).toBe(1013);
    expect(String(late.messages[0]?.[1])).toMatch(/^over quota: /);
  });

  it('沒設＝不限、NIP-11 沒有 cinder_traffic', async () => {
    const p = await opened(handles,startNodeRelay({ PORT: '0' }, { memory: true }));
    await wait(100);
    const info = (await (await fetch(`http://127.0.0.1:${p}/`, { headers: { accept: 'application/nostr+json' } })).json()) as Record<string, unknown>;
    expect(info.cinder_traffic).toBeUndefined();
  });
});
