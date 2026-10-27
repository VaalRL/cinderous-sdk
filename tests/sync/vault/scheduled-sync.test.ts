// G12（SDK ADR 0045）：排程同步（CinderSync ADR 0018）需要的協調器能力。
// (b) `whenSent()`：「這一輪送完了」的可等待訊號；(c) 重新連線時的摘要節流（`digestPolicy`）。
import { describe, expect, it } from 'vitest';

import { RelayRejectsFilesError } from '../../../src/sync/vault/index.js';
import { Net, type Device } from './harness.js';

const digestsFrom = (net: Net, device: string) => net.hub.messages.filter((m) => m.type === 'digest' && m.from === device).length;
const sentFrom = (net: Net, device: string) => net.hub.messages.filter((m) => m.from === device).length;

/** 一輪：連上 → 跑到靜止 → 斷線 */
async function round(net: Net, device: Device): Promise<void> {
  device.transport.setOnline(true);
  await net.settle();
  device.transport.setOnline(false);
  await net.settle();
}

describe('(b) whenSent：這一輪送完了', () => {
  it('送出佇列清空、沒有在途、連上時的摘要也送完 → sent', async () => {
    const net = new Net();
    const a = await net.add('a', { online: false });
    await net.add('b');
    await a.edit('x.md', 'hello');
    a.transport.setOnline(true);
    // 回報 sent 的時候，版本與摘要都已經交給傳輸層
    const done = a.sync.whenSent().then((result) => ({ result, types: net.hub.messages.filter((m) => m.from === 'a').map((m) => m.type) }));
    await net.settle();
    expect(await done).toEqual({ result: { state: 'sent', queue: 0 }, types: ['node', 'digest'] });
  });

  it('離線：立刻回報 offline 與待送數（不空等）', async () => {
    const net = new Net();
    const a = await net.add('a', { online: false });
    await a.edit('x.md', 'hello');
    await a.edit('y.md', 'world');
    expect(await a.sync.whenSent()).toEqual({ state: 'offline', queue: 2 });
  });

  it('中繼明確不收（blocked）：回報 blocked 與原因，不等退避', async () => {
    const net = new Net();
    const a = await net.add('a');
    await net.add('b');
    a.transport.send = async () => {
      throw new RelayRejectsFilesError(['wss://relay.example']);
    };
    await a.edit('x.md', 'hello');
    const result = await a.sync.whenSent();
    expect(result).toEqual({ state: 'blocked', queue: 1, blocked: 'relay-rejects-files' });
  });

  it('一般的送出失敗會一直退避重試：timeoutMs 到了回報 timeout', async () => {
    const net = new Net();
    const a = await net.add('a');
    a.transport.send = async () => {
      throw new Error('暫時失敗');
    };
    await a.edit('x.md', 'hello');
    const waiting = a.sync.whenSent({ timeoutMs: 10_000 });
    await net.clock.advance(10_000);
    expect(await waiting).toEqual({ state: 'timeout', queue: 1 });
  });

  it('剩下的都在等中繼補送的限速（批次模式、對方不在線）→ throttled，不空等到逾時（SDK ADR 0092）', async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 2 } });
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    b.transport.setOnline(false);
    for (let i = 0; i < 30; i += 1) a.vault.userWrite(`bulk/n-${i}.md`, `第 ${i} 則`);
    await a.sync.scan();
    const waiting = a.sync.whenSent({ timeoutMs: 600_000 });
    let result: Awaited<typeof waiting> | undefined;
    void waiting.then((r) => (result = r));
    for (let i = 0; i < 120 && result === undefined; i += 1) await net.clock.advance(1_000);
    expect(result).toMatchObject({ state: 'throttled' });
    expect(result?.queue).toBeGreaterThan(0);
    expect(result?.retryAt).toBeGreaterThan(net.clock.now());
  });

  it('沒有限速時照舊是 sent；限速的那一項送出去之後也不再回報 throttled', async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 2 } });
    const a = await net.add('a');
    await net.add('b');
    await net.settle();
    await a.edit('x.md', 'x');
    const waiting = a.sync.whenSent({ timeoutMs: 600_000 });
    await net.settle();
    expect(await waiting).toMatchObject({ state: 'sent', queue: 0 });
  });

  it('沉睡裝置暫停中 → paused（不空等）', async () => {
    const net = new Net();
    const a = await net.add('a');
    await net.add('b');
    await a.edit('x.md', 'x');
    await net.settle();
    await a.sync.stop();
    await net.clock.advance(31 * 86_400_000);
    await a.restart();
    expect(await a.sync.whenSent()).toMatchObject({ state: 'paused', pausedReason: 'stale-device' });
  });

  it('還在退避重試時 stop() → 等著的人拿到 stopped', async () => {
    const net = new Net();
    const a = await net.add('a');
    a.transport.send = async () => {
      throw new Error('暫時失敗');
    };
    await a.edit('x.md', 'x');
    const pending = a.sync.whenSent();
    await a.sync.stop();
    expect(await pending).toEqual({ state: 'stopped', queue: 1 });
  });
});

describe('(c) 摘要節流：digestPolicy', () => {
  it("預設 'on-connect'（v0.35 行為，釘住）：每次離線 → 在線都送一份摘要", async () => {
    const net = new Net();
    const a = await net.add('a', { online: false });
    await net.add('b');
    for (let i = 0; i < 3; i += 1) await round(net, a);
    expect(digestsFrom(net, 'a')).toBe(3);
  });

  it("'on-change'：第一次連上送；之後沒有本機修改的一輪一則事件都不發；有修改才送；超過 digestMaxIntervalMs 也送", async () => {
    const net = new Net();
    const a = await net.add('a', { online: false, options: { digestPolicy: 'on-change', digestMaxIntervalMs: 24 * 3_600_000 } });
    const b = await net.add('b');
    await round(net, a);
    expect(digestsFrom(net, 'a')).toBe(1);
    const before = sentFrom(net, 'a');
    for (let i = 0; i < 3; i += 1) await round(net, a);
    expect(sentFrom(net, 'a')).toBe(before); // 沒有修改的三輪：零事件

    // 別台的修改照樣收得到（收不受節流影響）；收到的那一輪只回一份簽收單給 b（SDK ADR 0068），不送摘要
    await b.edit('from-b.md', 'b');
    await round(net, a);
    expect(a.vault.get('from-b.md')).toBe('b');
    expect(net.hub.messages.filter((m) => m.from === 'a').slice(before).map((m) => m.type)).toEqual(['receipt']);
    const afterReceipt = sentFrom(net, 'a');

    await a.edit('x.md', 'x');
    await round(net, a);
    expect(net.hub.messages.filter((m) => m.from === 'a').slice(afterReceipt).map((m) => m.type)).toEqual(['node', 'digest']);

    const afterChange = digestsFrom(net, 'a');
    await net.clock.advance(24 * 3_600_000);
    await round(net, a);
    expect(digestsFrom(net, 'a')).toBe(afterChange + 1);
  });

  it("'on-change' 的狀態跨重開：重開後沒有修改不送；離線期間有修改（持久化佇列）才送", async () => {
    const net = new Net();
    const a = await net.add('a', { online: false, options: { digestPolicy: 'on-change' } });
    await net.add('b');
    await round(net, a);
    const before = digestsFrom(net, 'a');
    await a.restart();
    await round(net, a);
    expect(digestsFrom(net, 'a')).toBe(before);
    await a.edit('x.md', 'x');
    await a.restart();
    await round(net, a);
    expect(digestsFrom(net, 'a')).toBe(before + 1);
  });

  it("'manual'：從不自動送；resync() 照送", async () => {
    const net = new Net();
    const a = await net.add('a', { online: false, options: { digestPolicy: 'manual' } });
    await net.add('b');
    await a.edit('x.md', 'x');
    await round(net, a);
    expect(digestsFrom(net, 'a')).toBe(0);
    a.transport.setOnline(true);
    a.sync.resync();
    await net.settle();
    expect(digestsFrom(net, 'a')).toBe(1);
  });

  it('digestMinIntervalMs：連上時的自動摘要不比這個間隔更密', async () => {
    const net = new Net();
    const a = await net.add('a', { online: false, options: { digestMinIntervalMs: 3_600_000 } });
    await net.add('b');
    await round(net, a);
    await round(net, a);
    expect(digestsFrom(net, 'a')).toBe(1);
    await net.clock.advance(3_600_000);
    await round(net, a);
    expect(digestsFrom(net, 'a')).toBe(2);
  });
});
