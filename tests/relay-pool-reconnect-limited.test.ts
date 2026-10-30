// 重連太頻繁被擋（SDK ADR 0130）：主平面的重連閘（ADR 0111）以 1013 `rate-limited: reconnects` 關閉。
// 原本跟額度用完一樣整座等 5 分鐘、而且沒有抖動——同一個共用 IP 後面被擋的人 5 分鐘後一起重連、又被擋一輪。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelayHealthTracker } from '../src/relay-health.js';
import { RelayPool } from '../src/relay-pool.js';
import { SocketFactory } from './fake-socket.js';

const A = 'wss://a.example';
const MIN = 60_000;
const REASON = 'rate-limited: reconnects; docs: https://example.com/docs';

describe('RelayHealthTracker：重連太頻繁（SDK ADR 0130）', () => {
  let now = 1_000_000;
  const tracker = (random = () => 0) => new RelayHealthTracker({ now: () => now, random, onChange: () => undefined });
  const limited = (t: RelayHealthTracker) => t.observe(A, { kind: 'unavailable', reason: REASON, source: 'close' });
  const wait = (t: RelayHealthTracker) => {
    const mark = t.marks(A)[0]!;
    return mark.until - now;
  };

  beforeEach(() => {
    now = 1_000_000;
  });

  it('🔴 第一次只等 60 秒（Worker 那一道的計數窗），不是 5 分鐘', () => {
    const t = tracker();
    limited(t);
    expect(wait(t)).toBe(MIN);
  });

  it('連續被擋就加倍：60 → 120 → 240 秒，最多 5 分鐘（DO 那一道一擋 10 分鐘，不能一直每分鐘撞）', () => {
    const t = tracker();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      limited(t);
      waits.push(wait(t));
      now += wait(t);
    }
    expect(waits).toEqual([MIN, 2 * MIN, 4 * MIN, 5 * MIN, 5 * MIN]);
  });

  it('那一座恢復服務（EOSE）或收下事件之後，下一次被擋又從 60 秒算起', () => {
    const t = tracker();
    limited(t);
    now += MIN;
    limited(t);
    t.served(A);
    limited(t);
    expect(wait(t)).toBe(MIN);
    now += MIN;
    limited(t);
    t.accepted(A, 1);
    limited(t);
    expect(wait(t)).toBe(MIN);
  });

  it('🔴 抖動：多等 0～20%，大家不會在同一刻一起重連', () => {
    const t = tracker(() => 0.5);
    limited(t);
    expect(wait(t)).toBe(66_000);
  });

  it('其他 1013（額度用完、儲存起不來）照舊 5 分鐘，也加上抖動', () => {
    const t = tracker(() => 0.5);
    t.observe(A, { kind: 'unavailable', reason: 'over quota', source: 'close' });
    expect(wait(t)).toBe(330_000);
  });

  it('中繼說了什麼時候恢復（`until`）就照它，不另外加抖動', () => {
    const t = tracker(() => 0.5);
    t.observe(A, { kind: 'unavailable', reason: 'iot-quota', source: 'close', until: now + 3 * MIN });
    expect(wait(t)).toBe(3 * MIN);
  });
});

describe('RelayPool：重連太頻繁被擋之後（SDK ADR 0130）', () => {
  let factory: SocketFactory;
  let pool: RelayPool;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    factory = new SocketFactory();
    pool = new RelayPool({ urls: [A], createSocket: factory.create, reconnectDelaysMs: [100, 200, 5000] });
    pool.connect();
    factory.latest(A).open();
  });

  afterEach(() => {
    pool.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** 錨點實際的樣子：Worker 接受升級、送說明、以 1013 關閉 */
  function rejectReconnect() {
    const socket = factory.latest(A);
    socket.open();
    socket.receive(['NOTICE', 'rate-limited: too many reconnects from your IP; wait a few minutes before reconnecting.']);
    socket.serverClose(1013, REASON);
  }

  it('🔴 60 秒後就重連，不是 5 分鐘；又被擋就等 120 秒', () => {
    rejectReconnect();
    vi.advanceTimersByTime(MIN - 1);
    expect(factory.forUrl(A)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(factory.forUrl(A)).toHaveLength(2);
    rejectReconnect();
    vi.advanceTimersByTime(2 * MIN - 1);
    expect(factory.forUrl(A)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(factory.forUrl(A)).toHaveLength(3);
  });
});
