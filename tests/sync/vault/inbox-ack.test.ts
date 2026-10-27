// 收件確認後提早過期（SDK ADR 0067）：客戶端。處理完（訊框收齊、協調器已保存）才確認，只送給宣告了的中繼。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

import { Identity } from '../../../src/identity.js';
import { INBOX_ACK_KIND, INBOX_ACK_MAX_IDS, inboxAckIdsOf } from '../../../src/protocol/inbox-ack.js';
import { verifyEvent } from '../../../src/protocol/sign.js';
import {
  createNostrVaultTransport,
  fetchRelayFilePolicy,
  inboxAckRelays,
  MemorySyncStateStore,
  VAULT_FRAME_BYTES,
  VaultSyncCoordinator,
  type VaultRelayPool,
  type VaultSyncMessage,
} from '../../../src/sync/vault/index.js';
import type { PublishOptions, SubscriptionHandlers } from '../../../src/relay-pool.js';
import { sha256Hex } from '../../../src/sync/vault/graph.js';
import { FakeTransport } from '../../fake-transport.js';
import { flush, MemoryVault } from './harness.js';

const R1 = 'wss://r1.example';
const R2 = 'wss://r2.example';

const want = (from = 'dev-a'): VaultSyncMessage => ({ type: 'want', from, items: [['a'.repeat(32), 'b'.repeat(32)]] });

function bigNode(): VaultSyncMessage {
  const content = new Uint8Array(VAULT_FRAME_BYTES * 2 + 7).map((_, i) => i % 251);
  return {
    type: 'node',
    from: 'dev-a',
    fileId: 'a'.repeat(32),
    node: {
      id: 'b'.repeat(32),
      parents: [],
      path: 'x.bin',
      pathAt: 1,
      deleted: false,
      hash: sha256Hex(content),
      size: content.length,
      text: false,
      at: 1,
      device: 'dev-a',
      label: 'A',
      p2p: false,
    },
    content,
  };
}

/** alice 寄、bob 收；`pool.published` 先清空，只留確認 */
function pair(opts: { inboxAck?: boolean; inboxAckRelays?: readonly string[]; inboxAckBatch?: number } = {}) {
  const pool = new FakeTransport();
  const alice = Identity.generate();
  const bob = Identity.generate();
  const sender = createNostrVaultTransport({ pool, signer: alice, devices: [bob.pubkey], eventsPerMinute: 1e9 });
  const receiver = createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey], inboxAckRelays: [R1], eventsPerMinute: 1e9, ...opts });
  const acks = () => pool.published.filter((e) => e.kind === INBOX_ACK_KIND);
  const deliver = async (message: VaultSyncMessage) => {
    const from = pool.published.length;
    await sender.send(message);
    const wraps = pool.published.slice(from);
    for (const e of wraps) pool.deliver(e);
    return wraps.map((e) => e.id);
  };
  return { pool, alice, bob, sender, receiver, acks, deliver };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NostrVaultTransport：收件確認（SDK ADR 0067 §3）', () => {
  it('監聽者回傳的 Promise 完成才確認；確認帶這則訊息所有訊框的外層 id、以收件人自己的金鑰簽、只送給宣告了的中繼', async () => {
    const { pool, bob, receiver, acks, deliver } = pair();
    receiver.onMessage(() => Promise.resolve());
    const ids = await deliver(bigNode());
    expect(ids).toHaveLength(3);
    await flush();
    await receiver.flushInboxAcks();
    expect(acks()).toHaveLength(1);
    const ack = acks()[0]!;
    expect(ack.pubkey).toBe(bob.pubkey);
    expect(verifyEvent(ack)).toBe(true);
    expect(inboxAckIdsOf(ack)!.sort()).toEqual([...ids].sort());
    expect(pool.publishOptions[pool.published.indexOf(ack)]).toEqual({ relays: [R1] });
  });

  it('監聽者沒回傳 Promise（例如只是收集）不算處理完：不確認', async () => {
    const { receiver, acks, deliver } = pair();
    const got: VaultSyncMessage[] = [];
    receiver.onMessage((m) => {
      got.push(m);
    });
    await deliver(want());
    await flush();
    await receiver.flushInboxAcks();
    expect(got).toHaveLength(1);
    expect(acks()).toEqual([]);
  });

  it('有一個監聽者確認、其他沒回傳的：確認（應答器這類旁聽者不擋）', async () => {
    const { receiver, acks, deliver } = pair();
    receiver.onMessage(() => undefined);
    receiver.onMessage(() => Promise.resolve());
    await deliver(want());
    await flush();
    await receiver.flushInboxAcks();
    expect(acks()).toHaveLength(1);
  });

  it('處理失敗（Promise reject）：不確認', async () => {
    const { receiver, acks, deliver } = pair();
    receiver.onMessage(() => Promise.reject(new Error('存不下')));
    await deliver(want());
    await flush();
    await receiver.flushInboxAcks();
    expect(acks()).toEqual([]);
  });

  it('沒收齊的、不在信任名單的寄件人：不確認', async () => {
    const { pool, bob, receiver, acks, sender } = pair();
    receiver.onMessage(() => Promise.resolve());
    await sender.send(bigNode());
    pool.deliver(pool.published[0]!); // 只送到 1/3
    const mallory = createNostrVaultTransport({ pool, signer: Identity.generate(), devices: [bob.pubkey] });
    const from = pool.published.length;
    await mallory.send(want());
    for (const e of pool.published.slice(from)) pool.deliver(e);
    await flush();
    await receiver.flushInboxAcks();
    expect(acks()).toEqual([]);
  });

  it('沒有宣告的中繼就不送；之後 setInboxAckRelays 才送（期間留著）', async () => {
    const { pool, receiver, acks, deliver } = pair({ inboxAckRelays: [] });
    receiver.onMessage(() => Promise.resolve());
    await deliver(want());
    await flush();
    await receiver.flushInboxAcks();
    expect(acks()).toEqual([]);
    receiver.setInboxAckRelays([R1, R2]);
    await receiver.flushInboxAcks();
    expect(acks()).toHaveLength(1);
    expect(pool.publishOptions[pool.published.indexOf(acks()[0]!)]).toEqual({ relays: [R1, R2] });
  });

  it('inboxAck: false 一律不送', async () => {
    const { receiver, acks, deliver } = pair({ inboxAck: false });
    receiver.onMessage(() => Promise.resolve());
    await deliver(want());
    await flush();
    await receiver.flushInboxAcks();
    expect(acks()).toEqual([]);
  });

  it('累積滿一批（預設 500，`inboxAckBatch` 可調小）就自動送，不必等', async () => {
    const { receiver, acks, deliver } = pair({ inboxAckBatch: 3 });
    receiver.onMessage(() => Promise.resolve());
    for (let i = 0; i < 2; i += 1) await deliver(want());
    await flush();
    expect(acks()).toEqual([]);
    await deliver(want());
    await flush();
    await flush();
    expect(acks()).toHaveLength(1);
    expect(inboxAckIdsOf(acks()[0]!)).toHaveLength(3);
  });

  it(`inboxAckBatch 給得比上限（${INBOX_ACK_MAX_IDS}）大也不會壞：沒滿不送、flush 照送`, async () => {
    const { receiver, acks, deliver } = pair({ inboxAckBatch: 10_000 });
    receiver.onMessage(() => Promise.resolve());
    await deliver(want());
    await flush();
    expect(acks()).toEqual([]);
    await receiver.flushInboxAcks();
    expect(acks()).toHaveLength(1);
  });

  it('沒滿也會在 5 分鐘內送出', async () => {
    vi.useFakeTimers();
    const { receiver, acks, deliver } = pair();
    receiver.onMessage(() => Promise.resolve());
    await deliver(want());
    await vi.advanceTimersByTimeAsync(0);
    expect(acks()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(acks()).toHaveLength(1);
    receiver.stop();
  });

  it('送出失敗（沒有中繼收下）就留到下一次', async () => {
    const { pool, receiver, acks, deliver } = pair();
    receiver.onMessage(() => Promise.resolve());
    await deliver(want());
    await flush();
    pool.accepted = [];
    await receiver.flushInboxAcks();
    expect(acks()).toHaveLength(1);
    pool.accepted = [R1];
    await receiver.flushInboxAcks();
    expect(acks()).toHaveLength(2);
    expect(inboxAckIdsOf(acks()[1]!)).toEqual(inboxAckIdsOf(acks()[0]!));
  });
});

describe('NIP-11：哪幾座宣告了收件確認（SDK ADR 0067 §2）', () => {
  const fetchOf = (docs: Record<string, unknown>) => async (url: string) => ({
    status: 200,
    text: async () => JSON.stringify(docs[url] ?? {}),
  });

  it('fetchRelayFilePolicy 讀出 cinder_inbox_ack；inboxAckRelays 只挑 kind 對得上的', async () => {
    const fetch = fetchOf({
      'https://r1.example/': { cinder_inbox_ack: { kind: INBOX_ACK_KIND, grace_sec: 7200 } },
      'https://r2.example/': {},
      'https://r3.example/': { cinder_inbox_ack: { kind: 12345, grace_sec: 7200 } },
    });
    const policies = await Promise.all(['wss://r1.example', 'wss://r2.example', 'wss://r3.example'].map((u) => fetchRelayFilePolicy(u, { fetch })));
    expect(policies[0]!.inboxAck).toEqual({ kind: INBOX_ACK_KIND, graceSeconds: 7200 });
    expect(policies[1]!.inboxAck).toBeUndefined();
    expect(inboxAckRelays([...policies, null])).toEqual(['wss://r1.example']);
  });
});

describe('協調器：存好才算處理完（SDK ADR 0067 §3）', () => {
  async function devices(failPersist = false) {
    const pool = new FakeTransport();
    pool.relay = true;
    const [ida, idb] = [Identity.generate(), Identity.generate()];
    class FailingStore extends MemorySyncStateStore {
      fail = false;
      override async set(key: string, value: Uint8Array): Promise<void> {
        if (this.fail) throw new Error('磁碟滿了');
        return super.set(key, value);
      }
    }
    const storeB = new FailingStore();
    const ta = createNostrVaultTransport({ pool, signer: ida, devices: [idb.pubkey], inboxAckRelays: [R1] });
    const tb = createNostrVaultTransport({ pool, signer: idb, devices: [ida.pubkey], inboxAckRelays: [R1] });
    const a = { vault: new MemoryVault(), transport: ta };
    const b = { vault: new MemoryVault(), transport: tb };
    const syncA = new VaultSyncCoordinator({ adapter: a.vault, store: new MemorySyncStateStore(), transport: ta, deviceId: 'dev-a', tickMs: 0 });
    const syncB = new VaultSyncCoordinator({ adapter: b.vault, store: storeB, transport: tb, deviceId: 'dev-b', tickMs: 0 });
    await syncA.start();
    await syncB.start();
    // 啟動時 A 的摘要在 B 的協調器啟動前就到了：傳輸層留著、B 註冊後照樣處理並確認（SDK ADR 0075）。先處理完、送出確認，只看之後的
    for (let i = 0; i < 5; i += 1) {
      await flush();
      await syncB.idle();
    }
    await tb.flushInboxAcks();
    storeB.fail = failPersist;
    const startedAt = pool.published.length;
    const settle = async () => {
      for (let i = 0; i < 10; i += 1) {
        await flush();
        await syncA.idle();
        await syncB.idle();
      }
    };
    const acksBy = (pubkey: string) => pool.published.slice(startedAt).filter((e) => e.kind === INBOX_ACK_KIND && e.pubkey === pubkey);
    const wrapsTo = (pubkey: string) => pool.published.slice(startedAt).filter((e) => e.kind === 1060 && e.tags.some((t) => t[0] === 'p' && t[1] === pubkey));
    syncB.on('error', () => {});
    return { a, b, syncA, syncB, idb, settle, acksBy, wrapsTo };
  }

  it('收到並保存後，收件端確認那幾顆包', async () => {
    const { a, b, syncA, idb, settle, acksBy, wrapsTo } = await devices();
    a.vault.userWrite('n.md', '你好');
    await syncA.notifyLocalChange('n.md', 'create');
    await settle();
    expect(b.vault.get('n.md')).toBe('你好');
    await b.transport.flushInboxAcks();
    const acked = acksBy(idb.pubkey).flatMap((e) => inboxAckIdsOf(e)!);
    expect(acked.length).toBeGreaterThan(0);
    expect(new Set(wrapsTo(idb.pubkey).map((e) => e.id))).toEqual(new Set(acked));
  });

  it('🔴 狀態儲存寫不進去：不確認（讓包留在中繼上，之後還補拉得到）', async () => {
    const { a, b, syncA, idb, settle, acksBy } = await devices(true);
    a.vault.userWrite('n.md', '你好');
    await syncA.notifyLocalChange('n.md', 'create');
    await settle();
    await b.transport.flushInboxAcks();
    expect(acksBy(idb.pubkey)).toEqual([]);
  });
});

describe('🔴 完整補拉之後還收不齊的訊框：確認掉（SDK ADR 0081）', () => {
  /**
   * 中繼上只剩一部分訊框的訊息（其餘被天花板淘汰，或寄件端送到一半失敗、之後換新 id 整則重送）：
   * 收件人永遠重組不起來，以前就永遠不確認——每次連上都整批再下載一次，直到 7 天後過期。
   * 寄件端由簽收單（SDK ADR 0068）與摘要重送，不靠這幾顆。
   */
  function inbox(opts: { answered?: () => number; inboxAckBatch?: number } = {}) {
    const fake = new FakeTransport();
    const stored: Event[] = [];
    const alice = Identity.generate();
    const bob = Identity.generate();
    const matches = (e: Event, f: Filter) =>
      (f.kinds === undefined || f.kinds.includes(e.kind)) &&
      (f['#p'] === undefined || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]!))) &&
      (f.since === undefined || e.created_at >= f.since) &&
      (f.until === undefined || e.created_at <= f.until);
    const queryResult = async (filters: Filter[]) => {
      const answered = opts.answered?.() ?? 1;
      const events = answered === 0 ? [] : stored.filter((e) => filters.some((f) => matches(e, f))).sort((a, b) => b.created_at - a.created_at).slice(0, filters[0]?.limit ?? 500);
      return { events, answered, relays: [] };
    };
    const pool = {
      publish: (e: Event, o?: PublishOptions) => fake.publish(e, o),
      subscribe: (f: Filter[], h: SubscriptionHandlers) => fake.subscribe(f, h),
      query: async (f: Filter[]) => (await queryResult(f)).events,
      queryResult,
    } as unknown as VaultRelayPool;
    const sender = createNostrVaultTransport({ pool: { publish: pool.publish, subscribe: () => ({ close() {} }) } as VaultRelayPool, signer: alice, devices: [bob.pubkey], eventsPerMinute: 1e9 });
    // 建立就開始訂閱並補拉（連上了：沒有 status 的池算在線）——所以先寄、再建立收件人
    const open = () => createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey], inboxAckRelays: [R1], eventsPerMinute: 1e9, ...(opts.inboxAckBatch ? { inboxAckBatch: opts.inboxAckBatch } : {}) });
    const acked = () => fake.published.filter((e) => e.kind === INBOX_ACK_KIND).flatMap((e) => inboxAckIdsOf(e)!);
    /** 寄出一則，回傳它的訊框（只存進中繼 `keep` 指定的那幾顆） */
    const sendStored = async (message: VaultSyncMessage, keep?: (i: number) => boolean) => {
      const from = fake.published.length;
      await sender.send(message);
      const frames = fake.published.slice(from);
      frames.forEach((e, i) => {
        if (!keep || keep(i)) stored.push(e);
      });
      return frames;
    };
    return { fake, stored, open, acked, sendStored };
  }

  it('沒有起點的補拉翻完（整個收件匣都讀過）還缺訊框：確認收到的那幾顆；收齊的照常處理後確認', async () => {
    const { open, acked, sendStored } = inbox();
    const orphan = await sendStored(bigNode(), (i) => i !== 1); // 3 顆只剩 0、2
    const whole = await sendStored(want());
    const receiver = open();
    const got: VaultSyncMessage[] = [];
    receiver.onMessage((m) => {
      got.push(m);
      return Promise.resolve();
    });
    await receiver.backfill();
    await flush();
    await receiver.flushInboxAcks();
    expect(got.map((m) => m.type)).toEqual(['want']);
    expect(acked().sort()).toEqual([orphan[0]!.id, orphan[2]!.id, whole[0]!.id].sort());
  });

  it('沒翻完（撞到頁數上限、或沒有任何中繼回完）：不確認還缺訊框的', async () => {
    let answered = 1;
    const { open, acked, sendStored } = inbox({ answered: () => answered });
    await sendStored(bigNode(), (i) => i !== 1);
    answered = 0;
    const receiver = open();
    receiver.onMessage(() => Promise.resolve());
    await expect(receiver.backfill()).rejects.toThrow();
    await flush();
    await receiver.flushInboxAcks();
    expect(acked()).toEqual([]);
  });

  it('有起點的補拉（之前已經翻完過一次，這次只讀新的）：不確認還缺訊框的——沒讀過整個收件匣，缺的可能在更早', async () => {
    const { open, acked, sendStored, stored } = inbox();
    const receiver = open();
    receiver.onMessage(() => Promise.resolve());
    await receiver.backfill(); // 空的收件匣，翻完：之後的補拉有起點
    await sendStored(bigNode(), (i) => i === 2);
    for (const e of stored) e.created_at = Math.floor(Date.now() / 1000) + 60; // 落在起點之後
    await receiver.backfill();
    await flush();
    await receiver.flushInboxAcks();
    expect(acked()).toEqual([]);
  });

  it('確認過後缺的訊框又即時送到（寄件端剛好還在送）：照樣重組、處理，整則再確認一次', async () => {
    const { fake, open, acked, sendStored } = inbox();
    const frames = await sendStored(bigNode(), (i) => i === 0);
    const receiver = open();
    const got: VaultSyncMessage[] = [];
    receiver.onMessage((m) => {
      got.push(m);
      return Promise.resolve();
    });
    await receiver.backfill();
    await flush();
    await receiver.flushInboxAcks();
    expect(acked()).toEqual([frames[0]!.id]);
    fake.deliver(frames[1]!);
    fake.deliver(frames[2]!);
    await flush();
    await receiver.flushInboxAcks();
    expect(got).toHaveLength(1);
    expect(new Set(acked())).toEqual(new Set(frames.map((e) => e.id)));
  });
});

describe('🔴 每次啟動先從頭補拉一次（SDK ADR 0084）', () => {
  /**
   * ADR 0081 的「收不齊也確認」只在沒有起點的補拉翻完時觸發；CinderSync 這類應用每次都把上次同步的時間當起點傳進來，
   * 於是一直續讀的裝置（2026-10-14 錨點 1 的 A、B4）永遠走不到那條路，收不齊的 130 MiB 白放 7 天、每次連上都整批再下載。
   */
  function inbox(answered: () => number = () => 1) {
    const fake = new FakeTransport();
    const stored: Event[] = [];
    const filters: Filter[] = [];
    const alice = Identity.generate();
    const bob = Identity.generate();
    const matches = (e: Event, f: Filter) =>
      (f.kinds === undefined || f.kinds.includes(e.kind)) &&
      (f['#p'] === undefined || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]!))) &&
      (f.since === undefined || e.created_at >= f.since) &&
      (f.until === undefined || e.created_at <= f.until);
    const queryResult = async (fs: Filter[]) => {
      filters.push(...fs);
      const n = answered();
      const events = n === 0 ? [] : stored.filter((e) => fs.some((f) => matches(e, f))).sort((a, b) => b.created_at - a.created_at).slice(0, fs[0]?.limit ?? 500);
      return { events, answered: n, relays: [] };
    };
    const pool = {
      publish: (e: Event, o?: PublishOptions) => fake.publish(e, o),
      subscribe: (f: Filter[], h: SubscriptionHandlers) => fake.subscribe(f, h),
      query: async (f: Filter[]) => (await queryResult(f)).events,
      queryResult,
    } as unknown as VaultRelayPool;
    const sender = createNostrVaultTransport({ pool: { publish: pool.publish, subscribe: () => ({ close() {} }) } as VaultRelayPool, signer: alice, devices: [bob.pubkey], eventsPerMinute: 1e9 });
    const open = (extra: Partial<Parameters<typeof createNostrVaultTransport>[0]> = {}) =>
      createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey], inboxAckRelays: [R1], eventsPerMinute: 1e9, ...extra });
    const acked = () => fake.published.filter((e) => e.kind === INBOX_ACK_KIND).flatMap((e) => inboxAckIdsOf(e)!);
    const sendStored = async (message: VaultSyncMessage, keep?: (i: number) => boolean) => {
      const from = fake.published.length;
      await sender.send(message);
      const frames = fake.published.slice(from);
      frames.forEach((e, i) => {
        if (!keep || keep(i)) stored.push(e);
      });
      return frames;
    };
    return { open, acked, sendStored, filters };
  }
  const nowSec = () => Math.floor(Date.now() / 1000);

  it('應用給了起點（上次同步的時間）：這次啟動的第一次補拉仍從頭讀，翻完確認還缺訊框的；之後的補拉才用起點', async () => {
    const { open, acked, sendStored, filters } = inbox();
    const orphan = await sendStored(bigNode(), (i) => i !== 1); // 比起點還早的半則訊息
    const receiver = open({ since: nowSec() + 3600 });
    receiver.onMessage(() => Promise.resolve());
    await receiver.backfill();
    await flush();
    await receiver.flushInboxAcks();
    expect(filters[0]?.since).toBeUndefined();
    expect(acked().sort()).toEqual([orphan[0]!.id, orphan[2]!.id].sort());
    await receiver.backfill();
    expect(filters.at(-1)?.since).toBeDefined();
  });

  it('沒有任何宣告收件確認的中繼：照舊從起點補拉（確認不了，從頭讀只是白白下載）；宣告的中繼一到手就補做一次從頭補拉', async () => {
    const { open, acked, sendStored, filters } = inbox();
    const orphan = await sendStored(bigNode(), (i) => i !== 1);
    const receiver = open({ since: nowSec() + 3600, inboxAckRelays: [] });
    receiver.onMessage(() => Promise.resolve());
    await receiver.backfill();
    expect(filters.every((f) => f.since !== undefined)).toBe(true);
    receiver.setInboxAckRelays([R1]);
    await flush();
    await receiver.backfill();
    await flush();
    await receiver.flushInboxAcks();
    expect(filters.some((f) => f.since === undefined)).toBe(true);
    expect(acked().sort()).toEqual([orphan[0]!.id, orphan[2]!.id].sort());
  });

  it('一次啟動只從頭讀一次：從頭那次沒翻完（撞到頁數上限）也不反覆從頭；沒有中繼回完（失敗）下次再試', async () => {
    let answered = 0;
    const { open, sendStored, filters } = inbox(() => answered);
    for (let i = 0; i < 3; i++) await sendStored(want(`dev-${i}`));
    const receiver = open({ since: nowSec() + 3600, backfillPages: 1 });
    receiver.onMessage(() => Promise.resolve());
    await expect(receiver.backfill()).rejects.toThrow(); // 沒有中繼回完：不算讀過
    answered = 1;
    filters.length = 0;
    await receiver.backfill();
    expect(filters[0]?.since).toBeUndefined();
    filters.length = 0;
    await receiver.backfill();
    expect(filters.every((f) => f.since !== undefined)).toBe(true);
  });
});
