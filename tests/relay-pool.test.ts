// 多 Relay 連接池：全部同時連、去重、驗簽、斷線重連（ADR 0007）、NIP-42 認證。用假 socket 與假計時器。
import type { Event } from 'nostr-tools/core';
import { verifyEvent } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../src/identity.js';
import { TIMESTAMP_JITTER_SECONDS } from '../src/protocol/nip59.js';
import { NIP59_MAX_BACKDATE_SEC, RelayPool } from '../src/relay-pool.js';
import { SocketFactory } from './fake-socket.js';

const PRIMARY = 'wss://primary.example';
const BACKUP = 'wss://backup.example';

function signed(identity: Identity, content: string, createdAt = 1_700_000_000) {
  return identity.sign({ kind: 20078, created_at: createdAt, tags: [['t', 'demo']], content });
}

/** 走一趟 JSON，像 Relay 收到的那樣（沒有 nostr-tools 掛的驗證快取符號） */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('RelayPool', () => {
  let factory: SocketFactory;
  let pool: RelayPool;

  beforeEach(() => {
    vi.useFakeTimers();
    factory = new SocketFactory();
    pool = new RelayPool({
      urls: [PRIMARY, BACKUP],
      createSocket: factory.create,
      reconnectDelaysMs: [100, 200],
      publishTimeoutMs: 1000,
    });
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  describe('query：一次性查詢（SDK ADR 0005）', () => {
    it('對每一座開著的站送 REQ，全部 EOSE 才回；結果去重、依 created_at 新到舊；結束送 CLOSE', async () => {
      pool.connect();
      factory.latest(PRIMARY).open();
      factory.latest(BACKUP).open();
      const writer = Identity.generate();
      const a = plain(signed(writer, 'a', 1_700_000_001));
      const b = plain(signed(writer, 'b', 1_700_000_002));
      const result = pool.query([{ kinds: [20078], '#t': ['demo'] }], 1000);
      const [reqA] = factory.latest(PRIMARY).sentOfType('REQ');
      const [reqB] = factory.latest(BACKUP).sentOfType('REQ');
      factory.latest(PRIMARY).receive(['EVENT', reqA?.[1], a]);
      factory.latest(PRIMARY).receive(['EOSE', reqA?.[1]]);
      factory.latest(BACKUP).receive(['EVENT', reqB?.[1], a]);
      factory.latest(BACKUP).receive(['EVENT', reqB?.[1], b]);
      factory.latest(BACKUP).receive(['EOSE', reqB?.[1]]);
      expect((await result).map((event) => event.content)).toEqual(['b', 'a']);
      expect(factory.latest(PRIMARY).sentOfType('CLOSE')).toEqual([['CLOSE', reqA?.[1]]]);
    });

    it('有站不回應：逾時就帶著已收到的結果回；被 CLOSED 或斷線的站不再等', async () => {
      pool.connect();
      factory.latest(PRIMARY).open();
      factory.latest(BACKUP).open();
      const writer = Identity.generate();
      const slow = pool.query([{ kinds: [20078], '#t': ['demo'] }], 500);
      const [reqA] = factory.latest(PRIMARY).sentOfType('REQ');
      factory.latest(PRIMARY).receive(['EVENT', reqA?.[1], plain(signed(writer, 'a'))]);
      vi.advanceTimersByTime(500);
      expect((await slow).map((event) => event.content)).toEqual(['a']);

      const quick = pool.query([{ kinds: [20078], '#t': ['demo'] }], 500);
      const reqs = factory.latest(PRIMARY).sentOfType('REQ');
      const reqP = reqs[reqs.length - 1];
      factory.latest(PRIMARY).receive(['CLOSED', reqP?.[1], 'restricted: 名單外']);
      factory.latest(BACKUP).fail();
      expect(await quick).toEqual([]);
    });

    it('還沒有任何一座開起來：等第一座開了再查；一直沒開就逾時回空', async () => {
      pool.connect();
      const waiting = pool.query([{ kinds: [20078], '#t': ['demo'] }], 500);
      factory.latest(PRIMARY).open();
      // 等到開起來之後才送 REQ（在下一個 microtask）
      await vi.advanceTimersByTimeAsync(0);
      const [req] = factory.latest(PRIMARY).sentOfType('REQ');
      expect(req?.[2]).toEqual({ kinds: [20078], '#t': ['demo'] });
      factory.latest(PRIMARY).receive(['EOSE', req?.[1]]);
      expect(await waiting).toEqual([]);

      const lonely = new RelayPool({ urls: [PRIMARY], createSocket: factory.create });
      const never = lonely.query([{ kinds: [1] }], 300);
      await vi.advanceTimersByTimeAsync(300);
      expect(await never).toEqual([]);
      lonely.close();
    });
  });

  it('connect 對每個 Relay 各開一條 socket，狀態隨連線變化', () => {
    const statuses: string[] = [];
    pool.onStatusChange((url, status) => statuses.push(`${url}:${status}`));
    pool.connect();
    expect(factory.sockets.map((s) => s.url)).toEqual([PRIMARY, BACKUP]);
    expect(pool.status().get(PRIMARY)).toBe('connecting');
    factory.latest(PRIMARY).open();
    expect(pool.status().get(PRIMARY)).toBe('open');
    expect(pool.status().get(BACKUP)).toBe('connecting');
    expect(statuses).toContain(`${PRIMARY}:open`);
  });

  it('publish 送到所有已開的 Relay，依 OK 回覆整理接受與拒絕', async () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    factory.latest(BACKUP).open();
    const event = signed(Identity.generate(), 'hello');
    const result = pool.publish(event);
    expect(factory.latest(PRIMARY).sentOfType('EVENT')).toEqual([['EVENT', plain(event)]]);
    expect(factory.latest(BACKUP).sentOfType('EVENT')).toEqual([['EVENT', plain(event)]]);
    factory.latest(PRIMARY).receive(['OK', event.id, true, '']);
    factory.latest(BACKUP).receive(['OK', event.id, false, 'blocked: rate limited']);
    expect(await result).toEqual({
      accepted: [PRIMARY],
      rejected: [{ url: BACKUP, reason: 'blocked: rate limited', kind: 'policy', retryable: false, tryOtherRelays: true }],
    });
  });

  it('publish 等不到 OK 的 Relay 算逾時拒絕；沒有任何 Relay 開著時立刻回全部拒絕', async () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    const event = signed(Identity.generate(), 'hello');
    const pending = pool.publish(event);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({
      accepted: [],
      rejected: [
        { url: PRIMARY, reason: 'timeout', kind: 'timeout', retryable: true, tryOtherRelays: true },
        { url: BACKUP, reason: 'not connected', kind: 'disconnected', retryable: true, tryOtherRelays: true },
      ],
    });
  });

  it('subscribe 對每個已開的 Relay 送 REQ，之後才開的 Relay 補送；close 送 CLOSE', () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    const subscription = pool.subscribe([{ kinds: [20078], '#t': ['demo'] }], {
      onEvent: () => {},
    });
    const [req] = factory.latest(PRIMARY).sentOfType('REQ');
    expect(req?.[0]).toBe('REQ');
    expect(typeof req?.[1]).toBe('string');
    expect(req?.[2]).toEqual({ kinds: [20078], '#t': ['demo'] });

    factory.latest(BACKUP).open();
    expect(factory.latest(BACKUP).sentOfType('REQ')).toEqual([req]);

    subscription.close();
    expect(factory.latest(PRIMARY).sentOfType('CLOSE')).toEqual([['CLOSE', req?.[1]]]);
    expect(factory.latest(BACKUP).sentOfType('CLOSE')).toEqual([['CLOSE', req?.[1]]]);
  });

  it('同一事件從兩個 Relay 進來只交付一次；簽章壞的丟掉；EOSE 通知一次', () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    factory.latest(BACKUP).open();
    const received: string[] = [];
    let eose = 0;
    const subscription = pool.subscribe([{ kinds: [20078] }], {
      onEvent: (event, url) => received.push(`${event.content}@${url}`),
      onEose: () => {
        eose += 1;
      },
    });
    const subId = factory.latest(PRIMARY).sentOfType('REQ')[0]?.[1] as string;
    const event = signed(Identity.generate(), 'once');
    factory.latest(PRIMARY).receive(['EVENT', subId, event]);
    factory.latest(BACKUP).receive(['EVENT', subId, event]);
    factory.latest(BACKUP).receive(['EVENT', subId, { ...event, content: 'forged' }]);
    factory.latest(PRIMARY).receive(['EVENT', 'someone-else', signed(Identity.generate(), 'x')]);
    factory.latest(PRIMARY).receive(['EOSE', subId]);
    factory.latest(BACKUP).receive(['EOSE', subId]);
    expect(received).toEqual([`once@${PRIMARY}`]);
    expect(eose).toBe(1);
    subscription.close();
  });

  it('主力斷線後按退避時間重連，重連成功就補送 REQ；備援期間照樣收事件', async () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    factory.latest(BACKUP).open();
    const received: string[] = [];
    pool.subscribe([{ kinds: [20078] }], { onEvent: (event) => received.push(event.content) });
    const subId = factory.latest(PRIMARY).sentOfType('REQ')[0]?.[1] as string;

    factory.latest(PRIMARY).fail();
    expect(pool.status().get(PRIMARY)).toBe('closed');
    factory.latest(BACKUP).receive(['EVENT', subId, signed(Identity.generate(), 'via backup')]);
    expect(received).toEqual(['via backup']);

    // 第一次退避 100 ms 後開新 socket
    expect(factory.forUrl(PRIMARY)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(factory.forUrl(PRIMARY)).toHaveLength(2);
    factory.latest(PRIMARY).fail();
    // 第二次退避 200 ms；之後維持最後一段
    await vi.advanceTimersByTimeAsync(199);
    expect(factory.forUrl(PRIMARY)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory.forUrl(PRIMARY)).toHaveLength(3);
    factory.latest(PRIMARY).open();
    expect(pool.status().get(PRIMARY)).toBe('open');
    // 補送時從看過最新的那則接續（ADR 0004）：備援送來的那則是 1_700_000_000
    expect(factory.latest(PRIMARY).sentOfType('REQ')).toEqual([
      ['REQ', subId, { kinds: [20078], since: 1_700_000_000 }],
    ]);
  });

  it('🔴 連上就被關（Relay 送 NOTICE 後關線）：不把退避歸零，照階往後排——否則就是 0.5 秒一次的迴圈', async () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    factory.latest(PRIMARY).close(); // 例如 Cinderous 對限速或錯誤路徑的回絕
    await vi.advanceTimersByTimeAsync(100);
    expect(factory.forUrl(PRIMARY)).toHaveLength(2);
    factory.latest(PRIMARY).open();
    factory.latest(PRIMARY).close();
    await vi.advanceTimersByTimeAsync(199);
    expect(factory.forUrl(PRIMARY)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory.forUrl(PRIMARY)).toHaveLength(3);
  });

  it('連線撐過穩定門檻（預設 30 秒）才斷：退避歸零，從第一階重來', async () => {
    pool.connect();
    factory.latest(PRIMARY).fail();
    await vi.advanceTimersByTimeAsync(100);
    factory.latest(PRIMARY).open();
    await vi.advanceTimersByTimeAsync(30_000);
    factory.latest(PRIMARY).fail();
    await vi.advanceTimersByTimeAsync(100);
    expect(factory.forUrl(PRIMARY)).toHaveLength(3);
  });

  it('CLOSED（非 auth-required）與 NOTICE 經 onRelayProblem 回報；auth-required 不回報（認證後會自動補送）', () => {
    const problems: string[] = [];
    const watched = new RelayPool({
      urls: [PRIMARY],
      createSocket: factory.create,
      reconnectDelaysMs: [100],
      onRelayProblem: (url, reason) => problems.push(`${url} ${reason}`),
    });
    watched.connect();
    const socket = factory.latest(PRIMARY);
    socket.open();
    socket.receive(['CLOSED', 'sub1', 'auth-required: #p needs NIP-42']);
    socket.receive(['CLOSED', 'sub2', 'restricted: filter must name a scope']);
    socket.receive(['NOTICE', 'rate-limited: too many messages']);
    expect(problems).toEqual([
      `${PRIMARY} restricted: filter must name a scope`,
      `${PRIMARY} rate-limited: too many messages`,
    ]);
    watched.close();
  });

  it('close 關掉所有 socket 且不再重連', async () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    pool.close();
    expect(factory.latest(PRIMARY).readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(factory.forUrl(PRIMARY)).toHaveLength(1);
    expect(pool.status().get(PRIMARY)).toBe('closed');
  });
});

describe('RelayPool NIP-42 認證', () => {
  let factory: SocketFactory;
  let me: Identity;
  let pool: RelayPool;

  beforeEach(() => {
    vi.useFakeTimers();
    factory = new SocketFactory();
    me = Identity.generate();
    pool = new RelayPool({
      urls: [PRIMARY],
      identity: me,
      createSocket: factory.create,
      reconnectDelaysMs: [100],
      publishTimeoutMs: 1000,
    });
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  function sentAuth(index = 0): Event {
    return factory.latest(PRIMARY).sentOfType('AUTH')[index]?.[1] as Event;
  }

  it('收到 AUTH 挑戰就回一則簽好的 22242（relay＋challenge 標籤）；同一挑戰不重複回；認證成功後補送所有訂閱', () => {
    pool.connect();
    const socket = factory.latest(PRIMARY);
    socket.open();
    pool.subscribe([{ kinds: [20078], '#p': [me.pubkey] }], { onEvent: () => {} });
    const [req] = socket.sentOfType('REQ');

    socket.receive(['AUTH', 'challenge-1']);
    const auth = sentAuth();
    expect(auth.kind).toBe(22242);
    expect(auth.pubkey).toBe(me.pubkey);
    expect(auth.tags).toEqual([
      ['relay', PRIMARY],
      ['challenge', 'challenge-1'],
    ]);
    expect(auth.content).toBe('');
    expect(verifyEvent(auth)).toBe(true);
    socket.receive(['AUTH', 'challenge-1']);
    expect(socket.sentOfType('AUTH')).toHaveLength(1);

    // Relay 先把認證前的訂閱關掉；認證 OK 後補送同一個 REQ
    socket.receive(['CLOSED', req?.[1], 'auth-required: 請先認證（NIP-42）']);
    expect(socket.sentOfType('REQ')).toHaveLength(1);
    socket.receive(['OK', auth.id, true, '']);
    expect(socket.sentOfType('REQ')).toEqual([req, req]);

    // 認證後仍被 restricted 關掉的訂閱不再重送；認證後再來的挑戰也不理
    socket.receive(['CLOSED', req?.[1], 'restricted: 訂閱必須指定 #p（自己）或 authors']);
    socket.receive(['AUTH', 'challenge-2']);
    expect(socket.sentOfType('REQ')).toHaveLength(2);
    expect(socket.sentOfType('AUTH')).toHaveLength(1);
  });

  it('認證前被 auth-required 擋下的發布，認證成功後重送一次、以第二次 OK 為準', async () => {
    pool.connect();
    const socket = factory.latest(PRIMARY);
    socket.open();
    socket.receive(['AUTH', 'c']);
    const auth = sentAuth();
    const event = signed(Identity.generate(), 'hello');
    const result = pool.publish(event);
    socket.receive(['OK', event.id, false, 'auth-required: 請先認證（NIP-42）']);
    expect(socket.sentOfType('EVENT')).toHaveLength(1);

    socket.receive(['OK', auth.id, true, '']);
    expect(socket.sentOfType('EVENT')).toEqual([
      ['EVENT', plain(event)],
      ['EVENT', plain(event)],
    ]);
    socket.receive(['OK', event.id, true, '']);
    expect(await result).toEqual({ accepted: [PRIMARY], rejected: [] });
  });

  it('認證被拒時，排隊的發布以 Relay 的理由算拒絕', async () => {
    pool.connect();
    const socket = factory.latest(PRIMARY);
    socket.open();
    socket.receive(['AUTH', 'c']);
    const auth = sentAuth();
    const event = signed(Identity.generate(), 'hello');
    const result = pool.publish(event);
    socket.receive(['OK', event.id, false, 'auth-required: 請先認證（NIP-42）']);
    socket.receive(['OK', auth.id, false, 'restricted: 名單外的公鑰']);
    expect(await result).toEqual({
      accepted: [],
      rejected: [{ url: PRIMARY, reason: 'restricted: 名單外的公鑰', kind: 'restricted', retryable: false, tryOtherRelays: true }],
    });
    expect(socket.sentOfType('EVENT')).toHaveLength(1);
  });

  it('沒有給身分就不回應 AUTH；auth-required 的拒絕直接算拒絕', async () => {
    const anonymous = new RelayPool({
      urls: [PRIMARY],
      createSocket: factory.create,
      publishTimeoutMs: 1000,
    });
    anonymous.connect();
    const socket = factory.latest(PRIMARY);
    socket.open();
    socket.receive(['AUTH', 'c']);
    expect(socket.sentOfType('AUTH')).toEqual([]);
    const event = signed(Identity.generate(), 'hello');
    const result = anonymous.publish(event);
    socket.receive(['OK', event.id, false, 'auth-required: 請先認證（NIP-42）']);
    expect(await result).toEqual({
      accepted: [],
      rejected: [{ url: PRIMARY, reason: 'auth-required: 請先認證（NIP-42）', kind: 'auth-required', retryable: true, tryOtherRelays: false }],
    });
    anonymous.close();
  });

  it('先開池、後給身分：setAuthIdentity 立刻回覆已收到的挑戰；設回 null 之後不再回應', () => {
    const late = new RelayPool({ urls: [PRIMARY], createSocket: factory.create, publishTimeoutMs: 1000 });
    late.connect();
    const socket = factory.latest(PRIMARY);
    socket.open();
    socket.receive(['AUTH', 'early']);
    expect(socket.sentOfType('AUTH')).toEqual([]);

    const identity = Identity.generate();
    late.setAuthIdentity(identity);
    const [auth] = socket.sentOfType('AUTH');
    const event = (auth as unknown[])[1] as Event;
    expect(event.pubkey).toBe(identity.pubkey);
    expect(event.tags).toContainEqual(['challenge', 'early']);

    late.setAuthIdentity(null);
    socket.receive(['AUTH', 'again']);
    expect(socket.sentOfType('AUTH')).toHaveLength(1);
    late.close();
  });

  describe('ping：逐座探針（SDK ADR 0003）', () => {
    const probe = [{ kinds: [1], '#t': ['demo'], limit: 1 }];

    it('只送這一座一個 REQ，EOSE 回來就量出往返時間並收掉訂閱；探針的事件不進其他訂閱', async () => {
      pool.connect();
      factory.latest(PRIMARY).open();
      const seen: string[] = [];
      pool.subscribe([{ kinds: [1] }], { onEvent: (event) => seen.push(event.id) });
      const rtt = pool.ping(PRIMARY, probe);
      const reqs = factory.latest(PRIMARY).sentOfType('REQ');
      expect(reqs).toHaveLength(2);
      const req = reqs[1];
      expect(req?.[2]).toEqual(probe[0]);
      factory.latest(PRIMARY).receive(['EVENT', req?.[1], plain(signed(Identity.generate(), 'probe'))]);
      vi.advanceTimersByTime(40);
      factory.latest(PRIMARY).receive(['EOSE', req?.[1]]);
      expect(await rtt).toBe(40);
      expect(factory.latest(PRIMARY).sentOfType('CLOSE')).toEqual([['CLOSE', req?.[1]]]);
      expect(seen).toEqual([]);
    });

    it('沒連上、被 CLOSED、逾時、中途斷線都算失敗', async () => {
      await expect(pool.ping(PRIMARY, probe)).rejects.toThrow(/沒有連上/);
      pool.connect();
      factory.latest(PRIMARY).open();

      const closed = pool.ping(PRIMARY, probe);
      const [req] = factory.latest(PRIMARY).sentOfType('REQ').slice(-1);
      factory.latest(PRIMARY).receive(['CLOSED', req?.[1], 'restricted: 名單外']);
      await expect(closed).rejects.toThrow(/restricted/);

      const slow = pool.ping(PRIMARY, probe, 500);
      vi.advanceTimersByTime(500);
      await expect(slow).rejects.toThrow(/逾時/);

      const dropped = pool.ping(PRIMARY, probe);
      factory.latest(PRIMARY).fail();
      await expect(dropped).rejects.toThrow(/斷線/);
    });

    it('isAuthenticated：NIP-42 通過之後才是 true', () => {
      pool.connect();
      factory.latest(PRIMARY).open();
      expect(pool.isAuthenticated(PRIMARY)).toBe(false);
      factory.latest(PRIMARY).receive(['AUTH', 'c']);
      const [auth] = factory.latest(PRIMARY).sentOfType('AUTH');
      factory.latest(PRIMARY).receive(['OK', ((auth as unknown[])[1] as Event).id, true, '']);
      expect(pool.isAuthenticated(PRIMARY)).toBe(true);
    });
  });

  describe('v0.3：訊框上限、補訂閱游標、立刻重連、活動時間（SDK ADR 0004）', () => {
    it('超過 maxFrameBytes 的訊框整框丟掉，socket 照常', () => {
      const small = new RelayPool({ urls: [PRIMARY], createSocket: factory.create, maxFrameBytes: 600 });
      small.connect();
      factory.latest(PRIMARY).open();
      const seen: string[] = [];
      small.subscribe([{ kinds: [20078] }], { onEvent: (event) => seen.push(event.content) });
      const [req] = factory.latest(PRIMARY).sentOfType('REQ');
      const writer = Identity.generate();
      factory.latest(PRIMARY).receive(['EVENT', req?.[1], plain(signed(writer, 'x'.repeat(800)))]);
      factory.latest(PRIMARY).receive(['EVENT', req?.[1], plain(signed(writer, 'ok'))]);
      expect(seen).toEqual(['ok']);
      small.close();
    });

    it('斷線重連後補訂閱帶 since＝看過最新的 created_at（以本機時鐘為上限，擋遠未來的毒化）', () => {
      vi.setSystemTime(new Date(1_700_000_500_000));
      pool.connect();
      factory.latest(PRIMARY).open();
      pool.subscribe([{ kinds: [20078], '#t': ['demo'] }], { onEvent: () => undefined });
      const [req] = factory.latest(PRIMARY).sentOfType('REQ');
      const writer = Identity.generate();
      factory.latest(PRIMARY).receive(['EVENT', req?.[1], plain(signed(writer, 'a', 1_700_000_100))]);
      factory.latest(PRIMARY).receive(['EVENT', req?.[1], plain(signed(writer, 'future', 1_900_000_000))]);
      factory.latest(PRIMARY).fail();
      vi.advanceTimersByTime(100);
      factory.latest(PRIMARY).open();
      const [again] = factory.latest(PRIMARY).sentOfType('REQ');
      expect(again?.[2]).toEqual({ kinds: [20078], '#t': ['demo'], since: 1_700_000_500 });
    });

    describe('🔴 G8（SDK ADR 0035）：可能被回溯時間戳的 filter，補訂閱的 since 再往前退讓 NIP-59 的兩天', () => {
      const TWO_DAYS = 2 * 86_400;

      it('回溯窗常數與封裝端的抖動窗是同一個數字（NIP-59：最多往前推兩天）', () => {
        expect(NIP59_MAX_BACKDATE_SEC).toBe(TIMESTAMP_JITTER_SECONDS);
        expect(NIP59_MAX_BACKDATE_SEC).toBe(TWO_DAYS);
      });
      const reconnectAndReq = (subscribeFilters: Record<string, unknown>[], opts?: { backdateWindowSec?: number }) => {
        vi.setSystemTime(new Date(1_700_000_500_000));
        pool.connect();
        factory.latest(PRIMARY).open();
        pool.subscribe(subscribeFilters as never, { onEvent: () => undefined }, opts);
        const [req] = factory.latest(PRIMARY).sentOfType('REQ');
        const writer = Identity.generate();
        factory.latest(PRIMARY).receive(['EVENT', req?.[1], plain(signed(writer, 'a', 1_700_000_400))]);
        factory.latest(PRIMARY).fail();
        vi.advanceTimersByTime(100);
        factory.latest(PRIMARY).open();
        const [again] = factory.latest(PRIMARY).sentOfType('REQ');
        return again?.slice(2);
      };

      it('kinds 含 1059（NIP-17 私訊）：since＝游標 − 兩天', () => {
        expect(reconnectAndReq([{ kinds: [1059], '#p': ['ab'] }])).toEqual([{ kinds: [1059], '#p': ['ab'], since: 1_700_000_400 - TWO_DAYS }]);
      });

      it('kinds 含 1060（檔案塊／vault／名單外層）：since＝游標 − 兩天', () => {
        expect(reconnectAndReq([{ kinds: [1060] }])).toEqual([{ kinds: [1060], since: 1_700_000_400 - TWO_DAYS }]);
      });

      it('收件匣類（`#p`）——例如通話信令 21002、SDP 21000 也是禮物包：一樣退讓', () => {
        expect(reconnectAndReq([{ kinds: [21002], '#p': ['ab'] }])).toEqual([{ kinds: [21002], '#p': ['ab'], since: 1_700_000_400 - TWO_DAYS }]);
      });

      it('同一個訂閱裡只有可能被回溯的那一個 filter 退讓，其他維持原游標；原本的 since 比較新就用原本的', () => {
        expect(
          reconnectAndReq([
            { kinds: [1059], '#p': ['ab'], since: 1_700_000_300 - TWO_DAYS - 50 },
            { kinds: [20078], '#t': ['demo'] },
            { kinds: [1059], '#p': ['cd'], since: 1_700_000_450 - TWO_DAYS },
          ]),
        ).toEqual([
          { kinds: [1059], '#p': ['ab'], since: 1_700_000_400 - TWO_DAYS },
          { kinds: [20078], '#t': ['demo'], since: 1_700_000_400 },
          { kinds: [1059], '#p': ['cd'], since: 1_700_000_450 - TWO_DAYS },
        ]);
      });

      it('呼叫端可宣告 backdateWindowSec：自訂的回溯窗套用到這個訂閱的每一個 filter；0＝關閉自動判斷', () => {
        expect(reconnectAndReq([{ kinds: [30078] }], { backdateWindowSec: 3600 })).toEqual([{ kinds: [30078], since: 1_700_000_400 - 3600 }]);
      });

      it('backdateWindowSec: 0 → 即使是 1059 也照原游標（呼叫端自己處理）', () => {
        expect(reconnectAndReq([{ kinds: [1059], '#p': ['ab'] }], { backdateWindowSec: 0 })).toEqual([{ kinds: [1059], '#p': ['ab'], since: 1_700_000_400 }]);
      });

      it('重拉回來、已經交給上層的事件不會再交一次（訂閱內以 id 去重）', () => {
        vi.setSystemTime(new Date(1_700_000_500_000));
        pool.connect();
        factory.latest(PRIMARY).open();
        const seen: string[] = [];
        pool.subscribe([{ kinds: [1059], '#p': ['ab'] }], { onEvent: (event) => seen.push(event.id) });
        const writer = Identity.generate();
        const event = plain(signed(writer, 'x', 1_700_000_400));
        const [req] = factory.latest(PRIMARY).sentOfType('REQ');
        factory.latest(PRIMARY).receive(['EVENT', req?.[1], event]);
        factory.latest(PRIMARY).fail();
        vi.advanceTimersByTime(100);
        factory.latest(PRIMARY).open();
        const [again] = factory.latest(PRIMARY).sentOfType('REQ');
        factory.latest(PRIMARY).receive(['EVENT', again?.[1], event]);
        expect(seen).toEqual([event.id]);
      });
    });

    it('reconnectNow：跳過退避立刻重連；已經開著就不動', () => {
      pool.connect();
      factory.latest(PRIMARY).fail();
      const before = factory.forUrl(PRIMARY).length;
      pool.reconnectNow(PRIMARY);
      expect(factory.forUrl(PRIMARY).length).toBe(before + 1);
      factory.latest(PRIMARY).open();
      pool.reconnectNow(PRIMARY);
      expect(factory.forUrl(PRIMARY).length).toBe(before + 1);
      // 被取消的退避計時器不會再多開一條
      vi.advanceTimersByTime(10_000);
      expect(factory.forUrl(PRIMARY).length).toBe(before + 1);
    });

    it('connectTimeoutMs：卡在連線中的 socket 逾時就關掉、照退避重連', () => {
      const slow = new RelayPool({
        urls: [PRIMARY],
        createSocket: factory.create,
        connectTimeoutMs: 300,
        reconnectDelaysMs: [100],
      });
      const statuses: string[] = [];
      slow.onStatusChange((_, status) => statuses.push(status));
      slow.connect();
      vi.advanceTimersByTime(299);
      expect(statuses).toEqual(['connecting']);
      vi.advanceTimersByTime(1);
      expect(statuses).toEqual(['connecting', 'closed']);
      vi.advanceTimersByTime(100);
      expect(factory.forUrl(PRIMARY)).toHaveLength(2);
      factory.latest(PRIMARY).open();
      vi.advanceTimersByTime(1_000);
      expect(slow.status().get(PRIMARY)).toBe('open');
      slow.close();
    });

    it('lastActivityAt：最近一次從那一座收到任何訊息的時間；沒收過是 null', () => {
      vi.setSystemTime(new Date(1_700_000_000_000));
      pool.connect();
      expect(pool.lastActivityAt(PRIMARY)).toBeNull();
      factory.latest(PRIMARY).open();
      vi.advanceTimersByTime(250);
      factory.latest(PRIMARY).receive(['NOTICE', 'hi']);
      expect(pool.lastActivityAt(PRIMARY)).toBe(1_700_000_000_250);
    });
  });

  it('一次性查詢被 auth-required 擋下：認證成功後對那一座重送；認證失敗就不等它（SDK ADR 0005）', async () => {
    pool.connect();
    const socket = factory.latest(PRIMARY);
    socket.open();
    socket.receive(['AUTH', 'c']);
    const [auth] = socket.sentOfType('AUTH');
    const result = pool.query([{ kinds: [1059], '#p': ['a'.repeat(64)] }], 1000);
    await vi.advanceTimersByTimeAsync(0);
    const [req] = socket.sentOfType('REQ');
    socket.receive(['CLOSED', req?.[1], 'auth-required: 請先認證（NIP-42）']);
    socket.receive(['OK', ((auth as unknown[])[1] as Event).id, true, '']);
    const again = socket.sentOfType('REQ');
    expect(again).toHaveLength(2);
    expect(again[1]?.[1]).toBe(req?.[1]);
    const writer = Identity.generate();
    socket.receive(['EVENT', req?.[1], plain(signed(writer, 'secret'))]);
    socket.receive(['EOSE', req?.[1]]);
    expect((await result).map((event) => event.content)).toEqual(['secret']);
  });

  describe('🔴 認證前被應用車道以 restricted 擋下（SDK ADR 0076）', () => {
    // 車道一連上就發挑戰但不強制；`#p` 只能是自己、「自己」要認證後才算數——認證完成前到的 REQ 回 restricted
    const LANE_REASON = 'restricted: app lanes need a tag filter (e.g. #t, #d), authors, or #p set to yourself after NIP-42 AUTH (ADR-0366)';

    it('一次性查詢：收過挑戰、還沒認證完時的 restricted 當成等認證，認證成功後重送；之後的結果照常', async () => {
      pool.connect();
      const socket = factory.latest(PRIMARY);
      socket.open();
      socket.receive(['AUTH', 'c']);
      const [auth] = socket.sentOfType('AUTH');
      const result = pool.queryResult([{ kinds: [1060], '#p': [me.pubkey] }], 1000);
      await vi.advanceTimersByTimeAsync(0);
      const [req] = socket.sentOfType('REQ');
      socket.receive(['CLOSED', req?.[1], LANE_REASON]);
      socket.receive(['OK', ((auth as unknown[])[1] as Event).id, true, '']);
      const again = socket.sentOfType('REQ');
      expect(again).toHaveLength(2);
      expect(again[1]?.[1]).toBe(req?.[1]);
      const writer = Identity.generate();
      socket.receive(['EVENT', req?.[1], plain(signed(writer, 'inbox'))]);
      socket.receive(['EOSE', req?.[1]]);
      const outcome = await result;
      expect(outcome.events.map((event) => event.content)).toEqual(['inbox']);
      expect(outcome.answered).toBe(1);
    });

    it('認證後仍被 restricted：才算真的被拒（不再等）', async () => {
      pool.connect();
      const socket = factory.latest(PRIMARY);
      socket.open();
      socket.receive(['AUTH', 'c']);
      const [auth] = socket.sentOfType('AUTH');
      const result = pool.queryResult([{ kinds: [1060], '#p': ['b'.repeat(64)] }], 1000);
      await vi.advanceTimersByTimeAsync(0);
      const [req] = socket.sentOfType('REQ');
      socket.receive(['CLOSED', req?.[1], LANE_REASON]);
      socket.receive(['OK', ((auth as unknown[])[1] as Event).id, true, '']);
      socket.receive(['CLOSED', req?.[1], LANE_REASON]);
      const outcome = await result;
      expect(outcome.answered).toBe(0);
      expect(outcome.relays[0]).toMatchObject({ status: 'closed', reason: LANE_REASON });
    });

    it('常駐訂閱：認證前的 restricted 不回報（認證成功後照常補送）', () => {
      const problems: string[] = [];
      const watched = new RelayPool({
        urls: [PRIMARY],
        identity: me,
        createSocket: factory.create,
        reconnectDelaysMs: [100],
        onRelayProblem: (url, reason) => problems.push(`${url} ${reason}`),
      });
      watched.subscribe([{ kinds: [1060], '#p': [me.pubkey] }], { onEvent: () => undefined });
      watched.connect();
      const socket = factory.latest(PRIMARY);
      socket.open();
      socket.receive(['AUTH', 'c']);
      const [req] = socket.sentOfType('REQ');
      socket.receive(['CLOSED', req?.[1], LANE_REASON]);
      expect(problems).toEqual([]);
      const [auth] = socket.sentOfType('AUTH');
      socket.receive(['OK', ((auth as unknown[])[1] as Event).id, true, '']);
      expect(socket.sentOfType('REQ').map((r) => r[1])).toEqual([req?.[1], req?.[1]]);
      watched.close();
    });

    it('沒收過挑戰（不做 NIP-42 的中繼）：restricted 照舊直接算拒絕，不空等', async () => {
      pool.connect();
      const socket = factory.latest(PRIMARY);
      socket.open();
      const result = pool.queryResult([{ kinds: [1060], '#p': [me.pubkey] }], 1000);
      await vi.advanceTimersByTimeAsync(0);
      const [req] = socket.sentOfType('REQ');
      socket.receive(['CLOSED', req?.[1], LANE_REASON]);
      const outcome = await result;
      expect(outcome.answered).toBe(0);
      expect(outcome.relays[0]?.status).toBe('closed');
    });
  });

  describe('🔴 一次性查詢的逾時以「多久沒有新資料」計（SDK ADR 0077）', () => {
    it('大頁面陸續傳來：每收到一則就延長，傳完回 EOSE 才結束（不在固定的逾時切斷）', async () => {
      pool.connect();
      const socket = factory.latest(PRIMARY);
      socket.open();
      const writer = Identity.generate();
      const result = pool.queryResult([{ kinds: [20078], '#t': ['demo'] }], 1000);
      await vi.advanceTimersByTimeAsync(0);
      const [req] = socket.sentOfType('REQ');
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(800);
        socket.receive(['EVENT', req?.[1], plain(signed(writer, `chunk ${i}`, 1_700_000_000 + i))]);
      }
      await vi.advanceTimersByTimeAsync(800);
      socket.receive(['EOSE', req?.[1]]);
      const outcome = await result;
      expect(outcome.events).toHaveLength(5);
      expect(outcome.answered).toBe(1);
    });

    it('一直沒停的中繼：最多等逾時的 12 倍就結束（算逾時）', async () => {
      pool.connect();
      const socket = factory.latest(PRIMARY);
      socket.open();
      const writer = Identity.generate();
      let done = false;
      const result = pool.queryResult([{ kinds: [20078], '#t': ['demo'] }], 1000).then((r) => {
        done = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(0);
      const [req] = socket.sentOfType('REQ');
      for (let i = 0; i < 30 && !done; i += 1) {
        await vi.advanceTimersByTimeAsync(500);
        socket.receive(['EVENT', req?.[1], plain(signed(writer, `drip ${i}`, 1_700_000_000 + i))]);
      }
      const outcome = await result;
      expect(outcome.answered).toBe(0);
      expect(outcome.relays[0]?.status).toBe('timeout');
      expect(outcome.events.length).toBeGreaterThan(20);
      expect(outcome.events.length).toBeLessThanOrEqual(24);
    });

    it('🔴 同一座先忙著傳常駐訂閱的資料：還在傳就不算閒置，傳完輪到查詢時照樣回完（SDK ADR 0080）', async () => {
      pool.connect();
      const socket = factory.latest(PRIMARY);
      socket.open();
      const writer = Identity.generate();
      const watched = pool.subscribe([{ kinds: [20078], '#t': ['demo'] }], { onEvent: () => undefined });
      await vi.advanceTimersByTimeAsync(0);
      const [sub] = socket.sentOfType('REQ');
      const result = pool.queryResult([{ kinds: [20078], '#t': ['demo'] }], 1000);
      await vi.advanceTimersByTimeAsync(0);
      const req = socket.sentOfType('REQ').at(-1);
      // 中繼先把訂閱的大量資料傳完（超過查詢的逾時），才輪到查詢
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(800);
        socket.receive(['EVENT', sub?.[1], plain(signed(writer, `sub ${i}`, 1_700_000_000 + i))]);
      }
      await vi.advanceTimersByTimeAsync(800);
      socket.receive(['EVENT', req?.[1], plain(signed(writer, 'q', 1_700_000_100))]);
      socket.receive(['EOSE', req?.[1]]);
      const outcome = await result;
      expect(outcome.answered).toBe(1);
      expect(outcome.events).toHaveLength(1);
      watched.close();
    });

    it('完全沒回應：照舊在逾時結束', async () => {
      pool.connect();
      factory.latest(PRIMARY).open();
      const result = pool.queryResult([{ kinds: [20078], '#t': ['demo'] }], 1000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await result).relays[0]?.status).toBe('timeout');
    });
  });

  it('重連後的新連線要重新認證', async () => {
    pool.connect();
    factory.latest(PRIMARY).open();
    factory.latest(PRIMARY).receive(['AUTH', 'c1']);
    factory.latest(PRIMARY).receive(['OK', sentAuth().id, true, '']);

    factory.latest(PRIMARY).fail();
    await vi.advanceTimersByTimeAsync(100);
    const next = factory.latest(PRIMARY);
    expect(factory.forUrl(PRIMARY)).toHaveLength(2);
    next.open();
    next.receive(['AUTH', 'c2']);
    expect(next.sentOfType('AUTH')).toHaveLength(1);
    expect(sentAuth().tags).toContainEqual(['challenge', 'c2']);
  });
});
