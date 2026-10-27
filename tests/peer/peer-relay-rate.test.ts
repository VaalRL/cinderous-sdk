// PeerNode 中繼軌 × SDK 中繼的每身分速率上限（SDK ADR 0043；ADR 0009 加註）。
//
// 中繼以**認證身分**計數（`relay-core` 的 `admit()`：`rateKey = authState.pubkey ?? event.pubkey`；ephemeral 也算），
// 每把公鑰每分鐘 120 則。v0.34 的預設 200 框／分鐘：已認證連線一分鐘連發 210 框只收下 120，其餘 `rate-limited: events:`。
// 這裡用真的 RelayCore（要求 NIP-42、每分鐘 120 則）＋真的 RelayPool＋虛擬時鐘。
import type { Event } from 'nostr-tools/core';
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { RELAY_FRAME_PAYLOAD_BYTES } from '../../src/peer/frames.js';
import { PeerNode, RELAY_FRAME_KIND, type PeerChannel } from '../../src/peer/peer-node.js';
import { MAX_EVENTS_PER_MINUTE } from '../../src/relay/host-config.js';
import { RelayEventBudget } from '../../src/relay-budget.js';
import { RelayPool, type PublishResult } from '../../src/relay-pool.js';
import type { PublishRejectionReport } from '../../src/publish-rejections.js';
import { CoreBridge } from '../core-bridge.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + n) % 256);

function world(maxEventsPerMinute: number) {
  let t = Date.now();
  const sleeps: number[] = [];
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  const bridge = new CoreBridge({ requireAuth: true, maxEventsPerMinute, now: () => Math.floor(t / 1000) });
  const pools: RelayPool[] = [];
  const nodes: PeerNode[] = [];
  /** 記下每一則中繼框的發布時間與結果 */
  const log: Array<{ at: number; result: PublishResult }> = [];
  const pool = (identity: Identity, record = false): RelayPool => {
    const p = new RelayPool({ urls: ['wss://core'], identity, createSocket: bridge.create });
    if (record) {
      const publish = p.publish.bind(p);
      p.publish = async (event: Event, ...rest) => {
        const result = await publish(event, ...rest);
        if (event.kind === RELAY_FRAME_KIND) log.push({ at: t, result });
        return result;
      };
    }
    p.connect();
    pools.push(p);
    return p;
  };
  const close = () => {
    for (const n of nodes) n.close();
    for (const p of pools) p.close();
  };
  return { clock, sleeps, log, pool, nodes, close };
}

/** 中繼的固定計數窗：從某一則起 60 秒內收下幾則（取最大） */
function maxAcceptedInAnyMinute(log: ReadonlyArray<{ at: number; result: PublishResult }>): number {
  const times = log.filter((x) => x.result.accepted.length > 0).map((x) => x.at);
  let best = 0;
  for (let i = 0; i < times.length; i += 1) {
    let n = 0;
    for (let j = i; j < times.length && times[j]! - times[i]! < 60_000; j += 1) n += 1;
    best = Math.max(best, n);
  }
  return best;
}

describe('PeerNode 中繼軌 × 中繼的每身分速率上限', () => {
  it('🔴 預設速率：210 框全部收下，沒有任何一則 rate-limited，任何一分鐘內不超過中繼上限', { timeout: 120_000 }, async () => {
    const w = world(MAX_EVENTS_PER_MINUTE);
    const alice = Identity.generate();
    const bob = Identity.generate();
    const rejections: PublishRejectionReport[] = [];
    // 預設速率（不指定 relayFramesPerMinute）＋虛擬時鐘：與 sharedRelayEventBudget 同一個預設值
    const a = new PeerNode({
      identity: alice,
      transport: w.pool(alice, true),
      rtc: null,
      relayBudget: new RelayEventBudget({ now: w.clock.now, sleep: w.clock.sleep }),
      onPublishRejected: (r) => rejections.push(r),
      now: w.clock.now,
    });
    const b = new PeerNode({ identity: bob, transport: w.pool(bob), rtc: null });
    w.nodes.push(a, b);
    await tick();

    const received: Uint8Array[] = [];
    b.onPeer((channel) => channel.onMessage((m) => received.push(m)));
    const toBob = await a.connectPeer(bob.pubkey);
    // 210 則小訊息＝210 框（大框只是讓加密變慢，速率看的是則數）
    for (let i = 0; i < 210; i += 1) await toBob.send(bytes(1 + (i % 7)));
    for (let i = 0; i < 50 && received.length < 210; i += 1) await tick();
    expect(received).toHaveLength(210);
    expect(received[209]).toEqual(bytes(1 + (209 % 7)));

    expect(w.log).toHaveLength(210);
    expect(rejections).toEqual([]);
    expect(w.log.every((x) => x.result.rejected.length === 0)).toBe(true);
    expect(maxAcceptedInAnyMinute(w.log)).toBeLessThanOrEqual(100);
    w.close();
  });

  it('🔴 對照：v0.34 的 200 框／分鐘撞上中繼上限（只收 120 則，其餘 rate-limited: events:）', { timeout: 120_000 }, async () => {
    const w = world(MAX_EVENTS_PER_MINUTE);
    const alice = Identity.generate();
    const pool = w.pool(alice, true);
    await tick();
    const results: PublishResult[] = [];
    // 直接以舊的速率（一分鐘內 200 則）發 ephemeral 中繼框
    for (let i = 0; i < 200; i += 1) {
      const event = alice.sealAndWrap({ kind: RELAY_FRAME_KIND, created_at: Math.floor(w.clock.now() / 1000), tags: [], content: 'x' }, Identity.generate().pubkey, {
        kind: RELAY_FRAME_KIND,
        tags: [],
      });
      results.push(await pool.publish(event as never));
    }
    expect(results.filter((r) => r.accepted.length > 0)).toHaveLength(MAX_EVENTS_PER_MINUTE);
    expect(results.filter((r) => r.rejected.some((x) => /^rate-limited: events:/.test(x.reason)))).toHaveLength(80);
    w.close();
  });

  it('🔴 收到 rate-limited: events: → 健康狀態標成退避、整個預算退避到計數窗結束、重送那一框；資料完整送達', { timeout: 120_000 }, async () => {
    // 中繼上限比節點的預算低很多（例如同一身分的其他裝置也在發、或站方調低了上限）
    const w = world(10);
    const alice = Identity.generate();
    const bob = Identity.generate();
    const rejections: PublishRejectionReport[] = [];
    const alicePool = w.pool(alice, true);
    const healthMarks: string[] = [];
    alicePool.onRelayHealthChange((_url, h) => healthMarks.push(...h.marks.map((m) => `${m.scope}/${m.state}/${m.kind}`)));
    const a = new PeerNode({
      identity: alice,
      transport: alicePool,
      rtc: null,
      relayFramesPerMinute: 1_000,
      sleep: w.clock.sleep,
      now: w.clock.now,
      onPublishRejected: (r) => rejections.push(r),
    });
    const b = new PeerNode({ identity: bob, transport: w.pool(bob), rtc: null });
    w.nodes.push(a, b);
    await tick();

    const incoming = new Promise<PeerChannel>((resolve) => b.onPeer(resolve));
    const toBob = await a.connectPeer(bob.pubkey);
    const data = bytes(RELAY_FRAME_PAYLOAD_BYTES * 3 + 1); // 一則 4 框的訊息夾在中間：重送不能讓它缺框
    for (let i = 0; i < 10; i += 1) await toBob.send(bytes(1));
    await toBob.send(data);
    for (let i = 0; i < 11; i += 1) await toBob.send(bytes(1)); // 共 25 框
    const fromAlice = await incoming;
    const got: Uint8Array[] = [];
    fromAlice.onMessage((m) => got.push(m));
    for (let i = 0; i < 50 && got.length < 22; i += 1) await tick();
    expect(got).toHaveLength(22);
    expect(got[10]).toEqual(data);

    // 有被限速過，而且是 ADR 0040 的 events 詞元
    const limited = rejections.flatMap((r) => r.rejected).filter((x) => x.kind === 'rate-limited');
    expect(limited.length).toBeGreaterThan(0);
    expect(limited.every((x) => x.token === 'events')).toBe(true);
    // 每次限速都退避一整分鐘（計數窗），而不是立刻重試
    expect(w.sleeps.filter((ms) => ms >= 60_000).length).toBe(limited.length);
    // 每一框最後都收下了：收下的框數＝25
    expect(w.log.filter((x) => x.result.accepted.length > 0)).toHaveLength(25);
    // ADR 0041 健康狀態：連線池把這座標成整座退避（之後收下又清掉——「任何一座收下就恢復」）
    expect(healthMarks).toContain('*/backoff/rate-limited');
    const health = alicePool.relayHealth().get('wss://core')!;
    expect(health.lastRejection?.kind).toBe('rate-limited');
    expect(health.marks).toEqual([]);
    w.close();
  });
});
