// 順序、亂序、重送、中繼軌節流與隨機化性質測試（SDK ADR 0030 §4、§5、§8）。
import { afterEach, describe, expect, it } from 'vitest';

import { StarHost, type StarMessage } from '../../src/star/host.js';
import { starRelayEventsPerMinute, type LinkTuning } from '../../src/star/link.js';
import { joinMember, makeHost, read, rng, sleep, text, until, type Joined, type WireBehaviour } from './helpers.js';

const hosts: StarHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
});

/** 中繼軌測試用的快速參數（真實預設見 defaultTuning） */
const LOSSY: Partial<LinkTuning> = { batchWindowMs: 1, rtoMs: 40, ackDelayMs: 10, heartbeatMs: 80, timeoutMs: 10_000, gapTimeoutMs: 8_000, maxRetransmits: 50 };

describe('中繼軌：亂序、掉包、重複', () => {
  it('每則恰好一次、依 Host 序號交出（通道層的雙棘輪只解密不排序，排序與重送在星狀鏈路）', async () => {
    const r = rng(1234);
    const behaviour: WireBehaviour = { mode: 'relayed-websocket', delayMs: () => Math.floor(r() * 15), drop: () => r() < 0.2, duplicate: () => r() < 0.1 };
    const h = makeHost({ tuning: LOSSY, relayEventsPerMinute: 6_000_000 });
    hosts.push(h);
    const hostGot: StarMessage[] = [];
    h.onMessage((m) => hostGot.push(m));
    const a = await joinMember(h, { behaviour, member: { tuning: LOSSY, relayEventsPerMinute: 6_000_000 } });
    const b = await joinMember(h, { behaviour, member: { tuning: LOSSY, relayEventsPerMinute: 6_000_000 } });
    for (let i = 0; i < 150; i += 1) {
      a.member.send(text(`a${i}`));
      if (i % 10 === 9) await sleep(2);
    }
    await until(() => b.messages.length === 150 && hostGot.length === 150, 20_000, 'b 收齊');
    expect(b.messages.map((m) => read(m.payload))).toEqual(Array.from({ length: 150 }, (_, i) => `a${i}`));
    const seqs = b.messages.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(150);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(hostGot.map((m) => m.seq)).toEqual(seqs);
    expect(a.member.stats.retransmits + h.members().reduce((n, m) => n + m.stats.retransmits, 0)).toBeGreaterThan(0);
  }, 30_000);

  it('節流：每條走中繼的鏈路依事件預算拉開間隔，多筆更新合併成少數幾包', async () => {
    const h = makeHost({ tuning: { batchWindowMs: 1 }, relayEventsPerMinute: 1_200 }); // 每 50 ms 一包
    hosts.push(h);
    const a = await joinMember(h, { behaviour: { mode: 'relayed-websocket' }, member: { tuning: { batchWindowMs: 1 }, relayEventsPerMinute: 1_200 } });
    const b = await joinMember(h, { behaviour: { mode: 'relayed-websocket' }, member: { tuning: { batchWindowMs: 1 }, relayEventsPerMinute: 1_200 } });
    const before = b.hostSide.sentMessages;
    const started = Date.now();
    for (let i = 0; i < 60; i += 1) {
      a.member.send(text(`k${i}`));
      await sleep(2);
    }
    await until(() => b.messages.length === 60, 5_000);
    const elapsed = Date.now() - started;
    const packets = b.hostSide.sentMessages - before;
    // Host 有兩條中繼鏈路：每條間隔 60000×2/1200 = 100 ms
    expect(packets).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 2);
    expect(packets).toBeLessThan(60);
  });

  it('starRelayEventsPerMinute：NIP-11 宣告值 × 0.8，多座取最小，沒宣告用預設', () => {
    expect(starRelayEventsPerMinute({ cinder_max_events_per_minute: 120 })).toBe(96);
    expect(starRelayEventsPerMinute([{ cinder_max_events_per_minute: 240 }, { cinder_max_events_per_minute: 120 }, {}])).toBe(96);
    expect(starRelayEventsPerMinute({})).toBe(100);
    expect(starRelayEventsPerMinute(null, 50)).toBe(50);
  });
});

describe('隨機化性質測試（固定種子）', () => {
  for (const seed of [11, 22, 33]) {
    it(`種子 ${seed}：隨機加入／離開／踢出／斷線／送訊後，在線成員收到的序列一致、無重複、無遺漏`, async () => {
      const r = rng(seed);
      const h = makeHost({ tuning: LOSSY, relayEventsPerMinute: 6_000_000, maxMembers: 8, inboundRate: { messagesPerSecond: 1e6, burstMessages: 1e6 } });
      hosts.push(h);
      const hostGot: StarMessage[] = [];
      h.onMessage((m) => hostGot.push(m));
      /** Host 自己送的：序號 → 內容 */
      const hostSent = new Map<number, string>();
      const all: Joined[] = [];
      const firstSeq = new Map<Joined, number>();
      const unicastTargets = new Map<string, Set<string>>();
      let counter = 0;
      const online = () => all.filter((m) => !m.member.closed);

      for (let step = 0; step < 250; step += 1) {
        const x = r();
        const live = online();
        if (x < 0.1 && live.length < 8) {
          const relay = r() < 0.4;
          const net = rng(seed * 1_000 + all.length); // 網路的亂數與操作序列分開：操作序列只由種子決定
          const behaviour: WireBehaviour = relay
            ? { mode: 'relayed-websocket', delayMs: () => Math.floor(net() * 6), drop: () => net() < 0.1, duplicate: () => net() < 0.05 }
            : { mode: 'p2p-webrtc', delayMs: () => 1 };
          try {
            const j = await joinMember(h, { behaviour, member: { tuning: LOSSY, relayEventsPerMinute: 6_000_000 } });
            firstSeq.set(j, j.member.lastSeq + 1);
            all.push(j);
          } catch (error) {
            // 中繼軌斷線的成員 Host 要等心跳逾時才知道，這段時間名額還被佔著：`full` 是正確的
            expect(error).toMatchObject({ reason: 'full' });
          }
        } else if (x < 0.12 && live.length > 0) {
          await live[Math.floor(r() * live.length)]!.member.leave();
        } else if (x < 0.14 && live.length > 0) {
          h.kick(live[Math.floor(r() * live.length)]!.pubkey, { ban: false });
        } else if (x < 0.16 && live.length > 0) {
          const victim = live[Math.floor(r() * live.length)]!;
          victim.hostSide.close();
          victim.memberSide.close();
        } else if (x < 0.3) {
          const payload = `h${counter++}`;
          const seq = h.send(text(payload));
          if (seq !== undefined) hostSent.set(seq, payload);
        } else if (live.length > 0) {
          const sender = live[Math.floor(r() * live.length)]!;
          const payload = `m${counter++}`;
          if (r() < 0.2 && live.length > 1) {
            const target = live[Math.floor(r() * live.length)]!;
            unicastTargets.set(payload, new Set([target.pubkey]));
            sender.member.send(text(payload), { to: [target.pubkey] });
          } else {
            sender.member.send(text(payload), { echo: r() < 0.3 });
          }
        }
        if (r() < 0.3) await sleep(1);
      }

      // 靜止：等 Host 的佇列與未確認的都清空
      await until(
        () => h.members().every((m) => m.stats.queuedRecords === 0 && m.stats.unacked === 0) && online().every((m) => m.member.stats.queuedRecords === 0 && m.member.stats.unacked === 0),
        20_000,
        '靜止',
      );
      await sleep(150);

      // 全域真相：Host 看過的每一則廣播（成員送的）＋ Host 自己送的
      const truth = new Map<number, { from: string; payload: string; unicast: boolean }>();
      for (const m of hostGot) truth.set(m.seq, { from: m.from, payload: read(m.payload), unicast: m.unicast });
      for (const [seq, payload] of hostSent) truth.set(seq, { from: h.hostPubkey, payload, unicast: false });

      for (const j of all) {
        const seqs = j.messages.map((m) => m.seq);
        // 無重複、嚴格遞增
        expect(new Set(seqs).size, '無重複').toBe(seqs.length);
        expect([...seqs].sort((a, b) => a - b), '依序').toEqual(seqs);
        // 同一個序號，每個人看到的內容與寄件人一樣
        for (const m of j.messages) {
          const t = truth.get(m.seq);
          if (t) expect({ from: m.from, payload: read(m.payload) }).toEqual({ from: t.from, payload: t.payload });
          const targets = unicastTargets.get(read(m.payload));
          if (targets && m.from !== j.pubkey) expect(targets.has(j.pubkey), '單播只到指定的人').toBe(true);
        }
      }
      // 一直在線的人：加入後的每一則廣播（別人送的）都收到了
      for (const j of online()) {
        const got = new Set(j.messages.map((m) => m.seq));
        for (const [seq, t] of truth) {
          if (seq < firstSeq.get(j)! || t.unicast || t.from === j.pubkey) continue;
          expect(got.has(seq), `${j.pubkey.slice(0, 6)} 缺 #${seq}`).toBe(true);
        }
      }
      // 不同人之間：共同收到的那些，相對順序一致（序號遞增已保證），內容一致（上面已驗）
      expect(all.length).toBeGreaterThan(2);
    }, 60_000);
  }
});
