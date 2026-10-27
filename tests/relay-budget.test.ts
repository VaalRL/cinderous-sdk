// 中繼事件預算（SDK ADR 0043；ADR 0009 加註）：預設值低於中繼的每身分每分鐘上限、與中繼和 NIP-11 是同一組數字（SSOT）、
// 滑動窗、依 NIP-11 取較小值、同一身分共用、限速拒收時退避再重送；Vault 同步、名單同步、星狀會話用同一套。
import type { Event } from 'nostr-tools/core';
import { describe, expect, it } from 'vitest';

import { Identity } from '../src/identity.js';
import { claimDevice, defaultDeviceId, NostrRosterSync, VaultMembership } from '../src/pairing/index.js';
import { DEFAULT_RELAY_FRAMES_PER_MINUTE, PeerNode } from '../src/peer/peer-node.js';
import { MAX_EVENTS_PER_MINUTE } from '../src/relay/host-config.js';
import { buildRelayInfo } from '../src/relay/nip11.js';
import {
  DEFAULT_RELAY_EVENTS_PER_MINUTE,
  publishPaced,
  rateLimitBackoffMs,
  RELAY_MAX_EVENTS_PER_MINUTE,
  RELAY_RATE_LIMIT_BACKOFF_MS,
  RelayEventBudget,
  relayEventsPerMinute,
  sharedRelayEventBudget,
} from '../src/relay-budget.js';
import { DEFAULT_RELAY_HEALTH_COOLDOWNS } from '../src/relay-health.js';
import type { PublishResult, RelayTransport } from '../src/relay-pool.js';
import { DEFAULT_STAR_RELAY_EVENTS_PER_MINUTE, starRelayBudget, starRelayEventsPerMinute } from '../src/star/index.js';
import { createNostrVaultTransport, type VaultSyncMessage } from '../src/sync/vault/index.js';
import { FakeTransport } from './fake-transport.js';

/** 虛擬時鐘：sleep 直接把時間往前推 */
function clock(start = 1_790_000_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => void (t += ms),
    sleeps,
  };
}

/** 任何 60 秒內最多幾則 */
function maxInAnyMinute(times: readonly number[]): number {
  let best = 0;
  for (let i = 0; i < times.length; i += 1) {
    let n = 0;
    for (let j = i; j < times.length && times[j]! - times[i]! < 60_000; j += 1) n += 1;
    best = Math.max(best, n);
  }
  return best;
}

describe('預設值與 SSOT', () => {
  it('客戶端預設 100 < 中繼上限 120；各元件是同一個數字；退避長度＝健康狀態的限速冷卻', () => {
    expect(RELAY_MAX_EVENTS_PER_MINUTE).toBe(MAX_EVENTS_PER_MINUTE);
    expect(DEFAULT_RELAY_EVENTS_PER_MINUTE).toBe(100);
    expect(DEFAULT_RELAY_EVENTS_PER_MINUTE).toBeLessThan(RELAY_MAX_EVENTS_PER_MINUTE);
    expect(DEFAULT_RELAY_FRAMES_PER_MINUTE).toBe(DEFAULT_RELAY_EVENTS_PER_MINUTE);
    expect(DEFAULT_STAR_RELAY_EVENTS_PER_MINUTE).toBe(DEFAULT_RELAY_EVENTS_PER_MINUTE);
    expect(RELAY_RATE_LIMIT_BACKOFF_MS).toBe(DEFAULT_RELAY_HEALTH_COOLDOWNS.rateLimitedMs);
  });

  it('NIP-11：SDK 中繼宣告 120 → 96；多座取最小；沒宣告回 fallback；星狀會話是同一個函式', () => {
    const doc = buildRelayInfo({});
    expect(doc.cinder_max_events_per_minute).toBe(MAX_EVENTS_PER_MINUTE);
    expect(relayEventsPerMinute(doc)).toBe(96);
    expect(relayEventsPerMinute([doc, { cinder_max_events_per_minute: 50 }])).toBe(40);
    expect(relayEventsPerMinute({ name: 'x' })).toBe(DEFAULT_RELAY_EVENTS_PER_MINUTE);
    expect(relayEventsPerMinute(undefined, 7)).toBe(7);
    expect(starRelayEventsPerMinute).toBe(relayEventsPerMinute);
    expect(starRelayBudget({})).toBe(100);
    expect(starRelayBudget({ relayInfo: doc })).toBe(96);
    expect(starRelayBudget({ relayEventsPerMinute: 30, relayInfo: doc })).toBe(30);
    expect(starRelayBudget({ relayEventsPerMinute: 1_000, relayInfo: { name: 'no limit declared' } })).toBe(1_000);
  });
});

describe('RelayEventBudget', () => {
  it('🔴 預設值：連發 250 則，任何一分鐘內都不超過 100（中繼的固定計數窗也就不會超過 120）', async () => {
    const c = clock();
    const budget = new RelayEventBudget({ now: c.now, sleep: c.sleep });
    const times: number[] = [];
    for (let i = 0; i < 250; i += 1) {
      await budget.take();
      times.push(c.now());
      c.advance(5); // 每則發布本身花一點時間
    }
    expect(maxInAnyMinute(times)).toBeLessThanOrEqual(DEFAULT_RELAY_EVENTS_PER_MINUTE);
    expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it('依 NIP-11 取較小值；每次從建構時的速率重算（不會越調越低、也不會超過建構時的速率）', () => {
    const budget = new RelayEventBudget({ perMinute: 100 });
    expect(budget.applyRelayInfo({ cinder_max_events_per_minute: 50 })).toBe(40);
    expect(budget.applyRelayInfo({ cinder_max_events_per_minute: 50 })).toBe(40);
    expect(budget.applyRelayInfo({ cinder_max_events_per_minute: 10_000 })).toBe(100);
    expect(budget.applyRelayInfo({})).toBe(100);
  });

  it('並發的 take 依呼叫順序排隊', async () => {
    const c = clock();
    const budget = new RelayEventBudget({ perMinute: 2, now: c.now, sleep: c.sleep });
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => budget.take().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3]);
    expect(c.sleeps).toEqual([60_000]); // 前兩則在 t，後兩則在 t + 60 秒
  });

  it('backoff：之後的 take 等到退避結束', async () => {
    const c = clock();
    const budget = new RelayEventBudget({ now: c.now, sleep: c.sleep });
    budget.backoff(60_000);
    await budget.take();
    expect(c.sleeps).toEqual([60_000]);
  });

  it('同一把公鑰共用一個預算', () => {
    const a = Identity.generate().pubkey;
    expect(sharedRelayEventBudget(a)).toBe(sharedRelayEventBudget(a));
    expect(sharedRelayEventBudget(a)).not.toBe(sharedRelayEventBudget(Identity.generate().pubkey));
    expect(sharedRelayEventBudget(a).perMinute).toBe(DEFAULT_RELAY_EVENTS_PER_MINUTE);
  });
});

describe('限速拒收的退避（ADR 0040 詞元）', () => {
  const limited = (token: string): PublishResult => ({
    accepted: [],
    rejected: [{ url: 'wss://r', reason: `rate-limited: ${token}: 太快了` }],
  });

  it('rateLimitBackoffMs：events／messages 一分鐘、ip 一秒、其他拒收不退避', () => {
    expect(rateLimitBackoffMs(limited('events'))).toBe(60_000);
    expect(rateLimitBackoffMs(limited('messages'))).toBe(60_000);
    expect(rateLimitBackoffMs(limited('ip'))).toBe(1_000);
    expect(rateLimitBackoffMs({ accepted: [], rejected: [{ url: 'wss://r', reason: 'blocked: files-disabled: x' }] })).toBeUndefined();
    expect(rateLimitBackoffMs({ accepted: ['wss://r'], rejected: [] })).toBeUndefined();
  });

  it('全部限速 → 退避一分鐘後重送；重送成功就回成功；重送次數有上限', async () => {
    const c = clock();
    const budget = new RelayEventBudget({ now: c.now, sleep: c.sleep });
    const answers = [limited('events'), { accepted: ['wss://r'], rejected: [] }];
    let calls = 0;
    const ok = await publishPaced(budget, async () => answers[calls++]!);
    expect(ok.accepted).toEqual(['wss://r']);
    expect(calls).toBe(2);
    expect(c.sleeps).toEqual([60_000]);

    let tries = 0;
    const fail = await publishPaced(budget, async () => (tries++, limited('events')), { retries: 2 });
    expect(fail.accepted).toEqual([]);
    expect(tries).toBe(3);
  });

  it('部分限速（另一座收下）：不重送，但之後的發布也退避', async () => {
    const c = clock();
    const budget = new RelayEventBudget({ now: c.now, sleep: c.sleep });
    let calls = 0;
    await publishPaced(budget, async () => (calls++, { accepted: ['wss://a'], rejected: [{ url: 'wss://b', reason: 'rate-limited: events: x' }] }));
    expect(calls).toBe(1);
    await budget.take();
    expect(c.sleeps).toEqual([60_000]);
  });
});

describe('其他預設發送速率也走同一個預算', () => {
  it('PeerNode：沒指定速率＝同一身分共用的預算（100）；relayInfo 取較小值；指定速率＝自己的預算', () => {
    const id = Identity.generate();
    const transport = new FakeTransport();
    const node = new PeerNode({ identity: id, transport, rtc: null });
    expect(node.relayFramesPerMinute).toBe(100);
    sharedRelayEventBudget(id.pubkey).applyRelayInfo({ cinder_max_events_per_minute: 60 });
    expect(node.relayFramesPerMinute).toBe(48); // 同一身分的其他元件調了，這個節點也跟著
    node.close();

    const other = Identity.generate();
    const withInfo = new PeerNode({ identity: other, transport, rtc: null, relayInfo: buildRelayInfo({}) });
    expect(withInfo.relayFramesPerMinute).toBe(96);
    expect(sharedRelayEventBudget(other.pubkey).perMinute).toBe(96);
    withInfo.close();

    const own = new PeerNode({ identity: Identity.generate(), transport, rtc: null, relayFramesPerMinute: 500 });
    expect(own.relayFramesPerMinute).toBe(500);
    expect(own.applyRelayInfo(buildRelayInfo({}))).toBe(96);
    own.close();
  });

  it('Vault 同步：一則多顆的訊息依預算分批送出；限速拒收時退避再重送那一顆', async () => {
    const c = clock();
    const sender = Identity.generate();
    const devices = [Identity.generate(), Identity.generate(), Identity.generate()].map((i) => i.pubkey);
    const published: Event[] = [];
    let limitOnce = true;
    const pool: RelayTransport = {
      publish: async (event) => {
        published.push(event);
        if (published.length === 2 && limitOnce) {
          limitOnce = false;
          return { accepted: [], rejected: [{ url: 'wss://r', reason: 'rate-limited: events: 太快了' }] };
        }
        return { accepted: ['wss://r'], rejected: [] };
      },
      subscribe: () => ({ close: () => {} }),
    };
    const transport = createNostrVaultTransport({
      pool,
      signer: sender,
      devices,
      relayBudget: new RelayEventBudget({ perMinute: 2, now: c.now, sleep: c.sleep }),
    });
    const message: VaultSyncMessage = {
      type: 'node',
      from: 'dev-a',
      fileId: 'a'.repeat(32),
      node: { id: 'b'.repeat(32), parents: [], path: 'x.md', pathAt: 1, deleted: false, hash: 'c'.repeat(64), size: 0, text: true, at: 1, device: 'dev-a', label: 'A', p2p: false },
    };
    await transport.send(message); // 3 台 × 1 顆，第 2 顆被限速一次
    expect(published).toHaveLength(4);
    expect(published[1]!.id).toBe(published[2]!.id); // 重送的是同一顆
    expect(c.sleeps[0]).toBe(60_000);
  });

  it('名單同步：滿載一次 31 顆，依預算分批；預設與同一身分共用', async () => {
    const c = clock();
    const owner = Identity.generate();
    const m = VaultMembership.create({ signer: owner });
    for (let i = 0; i < 5; i += 1) {
      const id = Identity.generate();
      m.addDevice({ pubkey: id.pubkey, deviceId: defaultDeviceId(id.pubkey), label: '', claim: claimDevice(id, { deviceId: defaultDeviceId(id.pubkey), label: '' }) });
    }
    const transport = new FakeTransport();
    const sync = new NostrRosterSync({ pool: transport, signer: owner, membership: m, relayBudget: new RelayEventBudget({ perMinute: 2, now: c.now, sleep: c.sleep }) });
    await sync.announce();
    expect(transport.published).toHaveLength(5);
    expect(c.sleeps).toEqual([60_000, 60_000]);
  });
});
