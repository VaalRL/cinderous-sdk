// 邊緣代答的探測（SDK ADR 0125）：Cloudflare 的每日請求數用完時邊緣直接回 1027、Worker 沒執行，送不出 1013；
// 瀏覽器的 WebSocket 只看得到 1006，跟網路斷了一模一樣。NIP-11 帶 CORS、邊緣錯誤頁不帶，所以抓兩次就分得出來。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { probeRelayEdge, relayInfoUrlOf, type EdgeProbeFetch } from '../src/edge-probe.js';
import { DEFAULT_EDGE_PROBE_INTERVAL_MS, EDGE_ANSWERED_REASON, RelayPool, type RelayRejection } from '../src/relay-pool.js';
import { SocketFactory } from './fake-socket.js';

type Answer = 'relay' | 'relay-node' | 'edge-node' | 'blocked' | 'down';

/** 假的 fetch：照瀏覽器（或 Node）的規則回應一般與 `no-cors` 兩種請求 */
function fakeFetch(answer: () => Answer) {
  const calls: { url: string; mode?: string; accept?: string }[] = [];
  const fn: EdgeProbeFetch = async (url, init) => {
    calls.push({ url, ...(init.mode !== undefined ? { mode: init.mode } : {}), accept: init.headers.Accept });
    const a = answer();
    const none = { get: () => null };
    if (a === 'down') throw new TypeError('Failed to fetch');
    if (init.mode === 'no-cors') return { type: 'opaque', headers: none };
    if (a === 'relay') return { type: 'cors', headers: none }; // 瀏覽器：讀不到 ACAO，但 type 是 cors
    if (a === 'relay-node') return { type: 'basic', headers: { get: (n: string) => (n === 'access-control-allow-origin' ? '*' : null) } };
    if (a === 'edge-node') return { type: 'basic', headers: none }; // Node 不檢查 CORS：拿得到回應，但沒有 ACAO
    throw new TypeError('Failed to fetch'); // blocked：瀏覽器擋下沒有 CORS 的回應
  };
  return { fn, calls };
}

describe('probeRelayEdge（SDK ADR 0125）', () => {
  it('網址：wss→https、ws→http，路徑照留（車道的 NIP-11 在同一個路徑）', () => {
    expect(relayInfoUrlOf('wss://relay.example/app/x')).toBe('https://relay.example/app/x');
    expect(relayInfoUrlOf('ws://localhost:8787')).toBe('http://localhost:8787');
  });

  it.each<[Answer, string]>([
    ['relay', 'relay'],
    ['relay-node', 'relay'],
    ['edge-node', 'edge'],
    ['blocked', 'edge'],
    ['down', 'unreachable'],
  ])('%s → %s', async (answer, expected) => {
    const { fn, calls } = fakeFetch(() => answer);
    expect(await probeRelayEdge('wss://relay.example/', fn)).toBe(expected);
    expect(calls[0]).toEqual({ url: 'https://relay.example/', accept: 'application/nostr+json' });
    // 只有一般請求失敗時才問不透明的那一次
    expect(calls.map((c) => c.mode ?? 'cors')).toEqual(answer === 'blocked' || answer === 'down' ? ['cors', 'no-cors'] : ['cors']);
  });
});

describe('probeRelayEdge 對真的 HTTP 伺服器（Node 的 fetch）', () => {
  const servers: Server[] = [];
  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<number> => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it('帶 CORS 的 NIP-11＝中繼；429 沒有 CORS（像 1027 的錯誤頁）＝邊緣；沒人聽＝連不上', async () => {
    const relay = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/nostr+json', 'Access-Control-Allow-Origin': '*' });
      res.end('{}');
    });
    const edge = await listen((_req, res) => {
      res.writeHead(429, { 'content-type': 'text/html' });
      res.end('<html><body>error code: 1027</body></html>');
    });
    const gone = await listen(() => {});
    servers.pop()!.close(); // 關掉，留下一個沒人聽的埠
    const fetchFn: EdgeProbeFetch = (url, init) => fetch(url, init);
    expect(await probeRelayEdge(`ws://127.0.0.1:${relay}`, fetchFn)).toBe('relay');
    expect(await probeRelayEdge(`ws://127.0.0.1:${edge}`, fetchFn)).toBe('edge');
    expect(await probeRelayEdge(`ws://127.0.0.1:${gone}`, fetchFn)).toBe('unreachable');
  });
});

describe('🔴 RelayPool：連不上時探測邊緣代答（SDK ADR 0125）', () => {
  const A = 'wss://a.example';
  const MIN = 60_000;
  let factory: SocketFactory;
  let pool: RelayPool;
  let rejections: [string, RelayRejection][];
  let answer: Answer;
  let probe: ReturnType<typeof fakeFetch>;

  const make = (edgeProbe: ConstructorParameters<typeof RelayPool>[0]['edgeProbe']) => {
    pool = new RelayPool({
      urls: [A],
      createSocket: factory.create,
      reconnectDelaysMs: [100, 200, 5000],
      onRelayReject: (url, rejection) => rejections.push([url, rejection]),
      ...(edgeProbe !== undefined ? { edgeProbe } : {}),
    });
    pool.connect();
  };
  /** 還沒連上就斷（瀏覽器看到的 1006），然後讓重連發生 */
  const failOnce = async (wait = 100) => {
    factory.latest(A).fail();
    await vi.advanceTimersByTimeAsync(0); // 探測的 fetch 回來
    await vi.advanceTimersByTimeAsync(wait);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // 1013 的等待時間有抖動（SDK ADR 0130）；這裡驗的是精確時間
    factory = new SocketFactory();
    rejections = [];
    answer = 'blocked';
    probe = fakeFetch(() => answer);
  });
  afterEach(() => {
    pool.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('連續兩次還沒連上就斷 → 探測；邊緣代答 → 照 1013 處理：回報、整座 5 分鐘不用、重連等到那時', async () => {
    make({ fetch: probe.fn });
    await failOnce(100);
    expect(probe.calls).toEqual([]); // 一次不算
    factory.latest(A).fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.calls.length).toBe(2);
    expect(rejections).toEqual([
      [A, expect.objectContaining({ source: 'probe', kind: 'unavailable', token: 'edge', reason: EDGE_ANSWERED_REASON, retryable: true, tryOtherRelays: true })],
    ]);
    const marks = pool.relayHealth().get(A)!.marks;
    expect(marks).toEqual([expect.objectContaining({ scope: '*', state: 'backoff', kind: 'unavailable', reason: EDGE_ANSWERED_REASON })]);
    // 原本 200ms 後重連，改成等到標記過期
    const before = factory.forUrl(A).length;
    await vi.advanceTimersByTimeAsync(5 * MIN - 1_000);
    expect(factory.forUrl(A)).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(factory.forUrl(A)).toHaveLength(before + 1);
  });

  it('真的斷網（兩次都失敗）或回答的是中繼：不標記、照一般退避', async () => {
    for (const a of ['down', 'relay'] as const) {
      answer = a;
      rejections = [];
      factory = new SocketFactory();
      make({ fetch: probe.fn });
      await failOnce(100);
      await failOnce(200);
      expect(rejections).toEqual([]);
      expect(pool.relayHealth().get(A)!.marks).toEqual([]);
      pool.close();
    }
  });

  it('中間連上過一次就重新計數；連上之後才斷的不算', async () => {
    make({ fetch: probe.fn });
    await failOnce(100);
    factory.latest(A).open();
    factory.latest(A).fail(); // 連上之後才斷
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await failOnce(200); // 重新計數的第 1 次
    expect(probe.calls).toEqual([]);
  });

  it('同一座最多 5 分鐘探測一次（每次花兩個請求，額度用完時也算請求）', async () => {
    answer = 'down';
    make({ fetch: probe.fn, minIntervalMs: DEFAULT_EDGE_PROBE_INTERVAL_MS });
    await failOnce(100);
    await failOnce(200);
    await failOnce(5000);
    await failOnce(5000);
    expect(probe.calls.filter((c) => c.mode === undefined)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_EDGE_PROBE_INTERVAL_MS);
    await failOnce(5000);
    expect(probe.calls.filter((c) => c.mode === undefined)).toHaveLength(2);
  });

  it('探測回來之前已經連上：結果不用', async () => {
    let release: () => void = () => {};
    const slow: EdgeProbeFetch = (url, init) =>
      new Promise((resolve, reject) => {
        release = () => probe.fn(url, init).then(resolve, reject);
      });
    make({ fetch: slow });
    await failOnce(100);
    factory.latest(A).fail();
    await vi.advanceTimersByTimeAsync(200);
    factory.latest(A).open();
    release();
    await vi.advanceTimersByTimeAsync(0);
    release(); // no-cors 那一次
    await vi.advanceTimersByTimeAsync(0);
    expect(rejections).toEqual([]);
    expect(pool.relayHealth().get(A)!.marks).toEqual([]);
  });

  it('注入了 createSocket 又沒給 edgeProbe：預設不探測（不碰全域 fetch）；false 也關', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    make(undefined);
    await failOnce(100);
    await failOnce(200);
    await failOnce(5000);
    pool.close();
    factory = new SocketFactory();
    make(false);
    await failOnce(100);
    await failOnce(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
