// 重新讀到 NIP-11 後重新驗證「不適用」標記（SDK ADR 0044；補 ADR 0041 §1）。
// 站方打開檔案事件（`cinder_accepts_files: true`）之後，客戶端不必等 24 小時或重開就恢復。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Identity } from '../src/identity.js';
import { RelayPool, type RelayHealthSnapshot } from '../src/relay-pool.js';
import { fetchRelayFilePolicy, watchRelayFileLimits, type RelayInfoFetch } from '../src/sync/vault/index.js';
import { SocketFactory, type FakeSocket } from './fake-socket.js';

const A = 'wss://a.example';
const B = 'wss://b.example';

const writer = Identity.generate();
let counter = 0;
function event(kind: number, content = 'x', tags: string[][] = [['p', writer.pubkey]]) {
  counter += 1;
  return writer.sign({ kind, created_at: 1_700_000_000 + counter, tags, content });
}

const FILES_DISABLED = 'blocked: files-disabled: 檔案事件未啟用（MAX_FILE_MB）';
const LEGACY_FILES_DISABLED = 'blocked: 檔案事件未啟用（MAX_FILE_MB）';

function answer(socket: FakeSocket, ok: boolean, reason = ''): void {
  const events = socket.sentOfType('EVENT');
  const sent = events[events.length - 1]![1] as { id: string };
  socket.receive(['OK', sent.id, ok, reason]);
}

describe('RelayPool.revalidateRelay：重新讀到 NIP-11 後清掉已不成立的「不適用」（ADR 0044）', () => {
  let factory: SocketFactory;
  let pool: RelayPool;
  let changes: [string, RelayHealthSnapshot][];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    factory = new SocketFactory();
    changes = [];
    pool = new RelayPool({ urls: [A, B], createSocket: factory.create, reconnectDelaysMs: [100, 5000], publishTimeoutMs: 1000 });
    pool.onRelayHealthChange((url, health) => changes.push([url, health]));
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
  });

  afterEach(() => {
    pool.close();
    vi.useRealTimers();
  });

  /** A 收下、B 以 reason 拒收這一則 */
  async function rejectAtB(ev: ReturnType<typeof event>, reason: string): Promise<void> {
    const result = pool.publish(ev);
    answer(factory.latest(A), true);
    answer(factory.latest(B), false, reason);
    await result;
  }

  it('🔴 files-disabled → 站方開啟 → 重讀 NIP-11 後立即恢復，不必等 24 小時', async () => {
    await rejectAtB(event(1060), FILES_DISABLED);
    expect(pool.writeSet(1060)).toEqual([A]);
    vi.advanceTimersByTime(60_000);
    changes.length = 0;

    const cleared = pool.revalidateRelay(B, { cinder_accepts_files: true });
    expect(cleared).toEqual([expect.objectContaining({ scope: 'kind:1060', state: 'inapplicable', kind: 'policy' })]);
    expect(pool.relayHealth().get(B)!.marks).toEqual([]);
    expect(pool.writeSet(1060)).toEqual([A, B]);
    expect(changes.map(([url]) => url)).toEqual([B]); // 通知一次

    // 之後帶 durability 的發布不再略過 B
    const next = event(1060);
    const result = pool.publish(next, { durability: { minAccepted: 2 } });
    answer(factory.latest(A), true);
    answer(factory.latest(B), true);
    expect((await result).durability).toMatchObject({ satisfied: true, durable: [A, B] });
  });

  it('舊中繼的拒收句（blocked: …MAX_FILE_MB）也認得；fetchRelayFilePolicy 的結果形狀（acceptsFiles）也收', async () => {
    await rejectAtB(event(1060), LEGACY_FILES_DISABLED);
    vi.advanceTimersByTime(1000);
    expect(pool.revalidateRelay(B, { url: B, httpUrl: 'https://b.example/', acceptsFiles: true })).toHaveLength(1);
    expect(pool.relayHealth().get(B)!.marks).toEqual([]);
  });

  it('NIP-11 仍說不收（false）或沒宣告（null／沒欄位）→ 標記留著、不通知', async () => {
    await rejectAtB(event(1060), FILES_DISABLED);
    vi.advanceTimersByTime(1000);
    changes.length = 0;
    expect(pool.revalidateRelay(B, { cinder_accepts_files: false })).toEqual([]);
    expect(pool.revalidateRelay(B, { acceptsFiles: null })).toEqual([]);
    expect(pool.revalidateRelay(B, {})).toEqual([]);
    expect(pool.revalidateRelay(B, 'not a document')).toEqual([]);
    expect(pool.relayHealth().get(B)!.marks).toHaveLength(1);
    expect(changes).toEqual([]);
  });

  it('🔴 其他類別不受影響：已滿、kind 停用（NIP-11 看不出來）、限速都留著', async () => {
    await rejectAtB(event(1059), 'blocked: ceiling: 本站離線留言空間已滿');
    await rejectAtB(event(31438, 'b', [['d', 'b1']]), 'blocked: kind-disabled: 此事件類型已被政策停用');
    const before = pool.relayHealth().get(B)!.marks;
    expect(before).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    const doc = { cinder_accepts_files: true, limitation: { max_message_length: 1_000_000, restricted_writes: false } };
    expect(pool.revalidateRelay(B, doc)).toEqual([]);
    expect(pool.relayHealth().get(B)!.marks).toEqual(before);

    const limited = pool.publish(event(1059));
    answer(factory.latest(A), false, 'rate-limited: events: 發送過於頻繁');
    answer(factory.latest(B), true);
    await limited;
    expect(pool.revalidateRelay(A, doc)).toEqual([]);
    expect(pool.relayHealth().get(A)!.marks).toEqual([expect.objectContaining({ state: 'backoff' })]);
  });

  it('too-large：宣告的上限（max_message_length；可尋址另看 cinder_addressable_max_bytes）已不小於那顆 → 清掉；檔案塊（1060）看不出來 → 留著', async () => {
    await rejectAtB(event(1059, 'y'.repeat(500)), 'blocked: too-large: 事件過大');
    await rejectAtB(event(31438, 'z'.repeat(500), [['d', 'b2']]), 'blocked: too-large: 可尋址事件超過單顆大小上限');
    await rejectAtB(event(1060, 'w'.repeat(500)), 'blocked: too-large: 檔案塊過大');
    vi.advanceTimersByTime(1000);
    const scopes = () => pool.relayHealth().get(B)!.marks.map((m) => m.scope).sort();
    expect(scopes()).toEqual(['kind:1059', 'kind:1060', 'kind:31438']);

    // 上限仍太小 → 不動
    expect(pool.revalidateRelay(B, { limitation: { max_message_length: 100 } })).toEqual([]);
    // 一般 kind 看 max_message_length；可尋址還要看 cinder_addressable_max_bytes（仍太小）
    expect(pool.revalidateRelay(B, { limitation: { max_message_length: 1_000_000 }, cinder_addressable_max_bytes: 100 }).map((m) => m.scope)).toEqual([
      'kind:1059',
    ]);
    expect(pool.revalidateRelay(B, { limitation: { max_message_length: 1_000_000 }, cinder_addressable_max_bytes: 1_000_000 }).map((m) => m.scope)).toEqual([
      'kind:31438',
    ]);
    expect(scopes()).toEqual(['kind:1060']);
  });

  it('restricted: not-allowed（白名單外）：NIP-11 宣告 restricted_writes: false 才清掉', async () => {
    await rejectAtB(event(1059), 'restricted: not-allowed: 不在這座站的白名單上');
    vi.advanceTimersByTime(1000);
    expect(pool.revalidateRelay(B, { limitation: { restricted_writes: true } })).toEqual([]);
    expect(pool.revalidateRelay(B, { limitation: {} })).toEqual([]);
    expect(pool.revalidateRelay(B, { limitation: { restricted_writes: false } })).toHaveLength(1);
    expect(pool.relayHealth().get(B)!.marks).toEqual([]);
  });

  it('🔴 文件比標記舊（observedAt 早於標記出現）→ 不清：讀到「收檔案」之後才被拒，代表文件與實際不符，不能每則都清掉重試', async () => {
    const readAt = Date.now();
    vi.advanceTimersByTime(1000);
    await rejectAtB(event(1060), FILES_DISABLED);
    expect(pool.revalidateRelay(B, { cinder_accepts_files: true }, { observedAt: readAt })).toEqual([]);
    expect(pool.relayHealth().get(B)!.marks).toHaveLength(1);
  });

  it('🔴 預設行為不變：沒有重讀時「不適用」照舊維持 24 小時', async () => {
    await rejectAtB(event(1060), FILES_DISABLED);
    vi.advanceTimersByTime(23 * 3_600_000);
    expect(pool.writeSet(1060)).toEqual([A]);
    vi.advanceTimersByTime(3_600_000);
    expect(pool.writeSet(1060)).toEqual([A, B]);
  });

  it('resetRelayHealth(url, { scope }) 只清那一個範圍', async () => {
    await rejectAtB(event(1059), 'blocked: ceiling: 本站離線留言空間已滿');
    await rejectAtB(event(1060), FILES_DISABLED);
    changes.length = 0;
    pool.resetRelayHealth(B, { scope: 'kind:1060' });
    expect(pool.relayHealth().get(B)!.marks).toEqual([expect.objectContaining({ scope: 'offline', state: 'full' })]);
    expect(changes).toHaveLength(1);
    pool.resetRelayHealth(B, { state: 'inapplicable' }); // 沒有了：不通知
    expect(changes).toHaveLength(1);
    pool.resetRelayHealth(B, { state: 'full' });
    expect(pool.relayHealth().get(B)!.marks).toEqual([]);
  });
});

describe('watchRelayFileLimits：定期重讀 NIP-11 並重新驗證（ADR 0044）', () => {
  afterEach(() => vi.useRealTimers());

  function setup(refreshMs?: number) {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const factory = new SocketFactory();
    const pool = new RelayPool({ urls: [A, B], createSocket: factory.create, publishTimeoutMs: 1000 });
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
    const docs: Record<string, Record<string, unknown>> = {
      'https://a.example/': { cinder_accepts_files: true, cinder_max_file_mb: 30, cinder_file_chunks_per_recipient: 1440, retention: [{ time: 604800 }] },
      'https://b.example/': { cinder_accepts_files: false },
    };
    const fetched: string[] = [];
    const fetch: RelayInfoFetch = async (url) => {
      fetched.push(url);
      return { status: 200, text: async () => JSON.stringify(docs[url]) };
    };
    const seen: (readonly string[])[] = [];
    const stop = watchRelayFileLimits({
      pool,
      fetch,
      onLimits: (_limits, set) => seen.push(set),
      ...(refreshMs !== undefined ? { refreshMs } : {}),
    });
    return { factory, pool, docs, fetched, seen, stop };
  }

  async function filesDisabledAtB(factory: SocketFactory, pool: RelayPool): Promise<void> {
    const ev = event(1060);
    const result = pool.publish(ev);
    answer(factory.latest(A), true);
    answer(factory.latest(B), false, FILES_DISABLED);
    await result;
    await vi.advanceTimersByTimeAsync(0);
  }

  it('🔴 預設每 30 分鐘重讀：站方打開檔案事件後，下一輪就清掉標記、寫入集合與限制跟著重算', async () => {
    const { factory, pool, docs, fetched, seen, stop } = setup();
    await vi.advanceTimersByTimeAsync(0);
    await filesDisabledAtB(factory, pool);
    expect(seen.at(-1)).toEqual([A]);

    docs['https://b.example/'] = { cinder_accepts_files: true, cinder_max_file_mb: 10, cinder_file_chunks_per_recipient: 400, retention: [{ time: 604800 }] };
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(pool.relayHealth().get(B)!.marks).toHaveLength(1); // 還沒到
    const before = fetched.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.relayHealth().get(B)!.marks).toEqual([]);
    expect(seen.at(-1)).toEqual([A, B]);
    // 被標記而不在寫入集合裡的 B 也重讀了；每座一輪一次
    expect(fetched.slice(before).sort()).toEqual(['https://a.example/', 'https://b.example/']);
    stop();
    pool.close();
  });

  it('NIP-11 仍不收 → 標記留著；refreshMs: 0 → 不定期重讀（只讀一次，與 v0.35.0 相同）', async () => {
    const first = setup();
    await vi.advanceTimersByTimeAsync(0);
    await filesDisabledAtB(first.factory, first.pool);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(first.pool.relayHealth().get(B)!.marks).toHaveLength(1);
    first.stop();
    first.pool.close();

    const off = setup(0);
    await vi.advanceTimersByTimeAsync(0);
    await filesDisabledAtB(off.factory, off.pool);
    const before = off.fetched.length;
    off.docs['https://b.example/'] = { cinder_accepts_files: true };
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(off.fetched.length).toBe(before);
    expect(off.pool.relayHealth().get(B)!.marks).toHaveLength(1);
    off.stop();
    off.pool.close();
  });

  it('停止之後不再重讀', async () => {
    const { fetched, stop, pool } = setup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const before = fetched.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetched.length).toBe(before);
    pool.close();
  });

  it('G12e（SDK ADR 0045）：refresh() 立刻重讀一輪、清掉恢復的標記；回傳值照舊可以直接當停止函式呼叫', async () => {
    const { factory, pool, docs, fetched, seen, stop } = setup(0);
    await vi.advanceTimersByTimeAsync(0);
    await filesDisabledAtB(factory, pool);
    expect(seen.at(-1)).toEqual([A]);
    docs['https://b.example/'] = { cinder_accepts_files: true, cinder_max_file_mb: 10, cinder_file_chunks_per_recipient: 400, retention: [{ time: 604800 }] };
    const before = fetched.length;
    await stop.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetched.slice(before).sort()).toEqual(['https://a.example/', 'https://b.example/']);
    expect(pool.relayHealth().get(B)!.marks).toEqual([]);
    expect(seen.at(-1)).toEqual([A, B]);
    // 同時叫兩次只讀一輪
    const again = fetched.length;
    await Promise.all([stop.refresh(), stop.refresh()]);
    expect(fetched.length - again).toBe(2);
    stop.stop();
    const after = fetched.length;
    await stop.refresh();
    expect(fetched.length).toBe(after); // 停止之後 refresh 什麼都不做
    stop(); // 照舊可以呼叫（冪等）
    pool.close();
  });

  it('G12e：refresh() 之後定期重讀從那時候重新起算（不會緊接著又讀一次）', async () => {
    const { fetched, stop, pool } = setup(60_000);
    await vi.advanceTimersByTimeAsync(50_000);
    await stop.refresh();
    const before = fetched.length;
    await vi.advanceTimersByTimeAsync(30_000); // 原本的計時器在 60 秒會到
    expect(fetched.length).toBe(before);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetched.length).toBeGreaterThan(before);
    stop();
    pool.close();
  });
});

describe('fetchRelayFilePolicy：帶回重新驗證要用的欄位（ADR 0044）', () => {
  it('有宣告才有 maxMessageLength、restrictedWrites、addressableMaxBytes；交給 revalidateRelay 可清 too-large', async () => {
    const fetch: RelayInfoFetch = async () => ({
      status: 200,
      text: async () => JSON.stringify({ cinder_accepts_files: true, limitation: { max_message_length: 262144, restricted_writes: false }, cinder_addressable_max_bytes: 65536 }),
    });
    const policy = await fetchRelayFilePolicy(A, { fetch });
    expect(policy).toMatchObject({ acceptsFiles: true, maxMessageLength: 262144, restrictedWrites: false, addressableMaxBytes: 65536 });
    const bare = await fetchRelayFilePolicy(A, { fetch: async () => ({ status: 200, text: async () => '{}' }) });
    expect(bare).toEqual({ url: A, httpUrl: 'https://a.example/', acceptsFiles: null });
  });
});
