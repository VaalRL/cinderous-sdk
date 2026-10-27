// CinderSync 的協調器缺口（SDK ADR 0053）：G13 blocked 在佇列清空後重新驗證、G15 P2P 退避重設、G16 中繼補送速率執行中可調。
import { describe, expect, it } from 'vitest';

import { FILE_TIER_MAX_BYTES } from '../../../src/sync/ingest.js';
import { RelayRejectsFilesError } from '../../../src/sync/vault/index.js';
import type { VaultSyncMessage } from '../../../src/sync/vault/index.js';
import { type Device, flush, MemoryVault, Net } from './harness.js';

/** 假中繼拒收 1060：送出一律丟 RelayRejectsFilesError；回傳「站方開了」 */
function rejectFiles(device: Device): { fix: () => void; attempts: () => number } {
  const send = device.transport.send.bind(device.transport);
  let rejecting = true;
  let attempts = 0;
  device.transport.send = async (message) => {
    attempts += 1;
    if (rejecting) throw new RelayRejectsFilesError(['wss://my-relay']);
    return send(message);
  };
  return { fix: () => (rejecting = false), attempts: () => attempts };
}

/** 記下某台裝置經中繼送出的版本訊息數 */
function countRelayNodes(device: Device): () => number {
  let n = 0;
  const send = device.transport.send.bind(device.transport);
  device.transport.send = async (message: VaultSyncMessage) => {
    await send(message);
    if (message.type === 'node') n += 1;
  };
  return () => n;
}

function fill(vault: MemoryVault, n: number, prefix = 'bulk'): void {
  for (let i = 0; i < n; i += 1) vault.userWrite(`${prefix}/n-${i}.md`, `# ${i}\n`);
}

describe('G13：blocked 在佇列清空後重新驗證', () => {
  it('🔴 中繼不收檔案、佇列全部經直連送完 → blocked 與 error 狀態清掉（沒有東西卡在中繼上）', async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    rejectFiles(a);
    await a.edit('x.md', '經 P2P');
    await net.settle();
    expect(b.vault.get('x.md')).toBe('經 P2P');
    const status = a.sync.status();
    expect(status.queue).toBe(0);
    expect(status.blocked).toBeUndefined();
    expect(status.state).toBe('idle');
    expect(a.errors.filter((e) => e.startsWith('relay-rejects-files'))).toHaveLength(1);
  });

  it('🔴 下一則要經中繼的版本照樣驗證：還是不收 → 再標記一次、再回報一次；站方開了 → 不再標記', async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    const relay = rejectFiles(a);
    await a.edit('x.md', '1');
    await net.settle();
    expect(a.sync.status().blocked).toBeUndefined();

    // b 離線：只能經中繼 → 還是被拒
    b.transport.setOnline(false);
    net.mesh!.drop('b');
    await a.edit('y.md', '2');
    await net.clock.advance(1000);
    await a.sync.idle();
    expect(a.sync.status()).toMatchObject({ blocked: 'relay-rejects-files', queue: 1 });
    expect(a.errors.filter((e) => e.startsWith('relay-rejects-files'))).toHaveLength(2);

    relay.fix();
    b.transport.setOnline(true);
    await net.settle();
    expect(b.vault.get('y.md')).toBe('2');
    expect(a.sync.status().blocked).toBeUndefined();
    expect(a.sync.status().state).toBe('idle');
  });

  it('佇列還有其他裝置沒收到的：blocked 留著（真的還有東西卡在中繼上）', async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b');
    const c = await net.add('c');
    await net.settle();
    rejectFiles(a);
    c.transport.setOnline(false);
    net.mesh!.drop('c');
    await a.edit('x.md', '只有 b 在線');
    await net.clock.advance(5000);
    await a.sync.idle();
    expect(b.vault.get('x.md')).toBe('只有 b 在線');
    expect(a.sync.status()).toMatchObject({ blocked: 'relay-rejects-files', queue: 1 });
  });
});

describe('G15：retryPeers 重設 P2P 退避', () => {
  it('🔴 打不通 → 退避中；網路恢復後 retryPeers(device) 立刻再試，不必等退避結束', async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 1 } });
    net.mesh!.reachable = () => false;
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    fill(a.vault, 30);
    await a.sync.scan();
    await net.clock.advance(1000);
    expect(net.mesh!.opened).toBe(0);
    expect(a.sync.status().bulk).toBe(true);

    net.mesh!.reachable = () => true;
    await net.clock.advance(1000); // 還在 30 秒的退避裡
    expect(net.mesh!.opened).toBe(0);
    a.sync.retryPeers('b');
    await flush();
    await a.sync.idle();
    await net.clock.advance(100);
    expect(net.mesh!.opened).toBe(1);
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
  });

  it('🔴 收方（沒有要送的）自己開了通道（應用探測對方在不在線）→ retryPeers(device) 在那條通道上掛收方：對方經它送來的大檔收得到（v0.44.0 修正）', async () => {
    const net = new Net({ p2p: true, streaming: true });
    net.mesh!.reachable = () => false;
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    const video = new Uint8Array(FILE_TIER_MAX_BYTES + 1_000_000);
    video[0] = 7;
    await a.edit('v.mp4', video);
    await net.settle();
    expect(a.sync.status().pushes).toBe(1);
    expect(b.sync.status().pending.map((p) => p.via)).toEqual(['p2p']);

    // 網路通了：b 這邊的應用先開一條通道（像 CinderSync 的 probe），a 看到對方找上門就送
    net.mesh!.reachable = (from, to) => from !== to;
    const appLink = net.mesh!.link('b', () => b.transport.online);
    expect(await appLink.open('a')).not.toBeNull();
    b.sync.retryPeers('a');
    await net.settle();
    expect(b.vault.files.get('v.mp4')?.bytes[0]).toBe(7);
    expect(a.sync.status().pushes).toBe(0);
    expect(b.sync.status().pending).toEqual([]);
  });

  it('retryPeers() 不帶裝置：所有裝置的退避都重設；名單外或自己的 id 忽略', async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 1 } });
    net.mesh!.reachable = () => false;
    const a = await net.add('a');
    await net.add('b');
    await net.add('c');
    await net.settle();
    fill(a.vault, 30);
    await a.sync.scan();
    await net.clock.advance(1000);
    net.mesh!.reachable = () => true;
    a.sync.retryPeers('nobody');
    a.sync.retryPeers('a');
    await flush();
    expect(net.mesh!.opened).toBe(0);
    a.sync.retryPeers();
    await flush();
    await a.sync.idle();
    await net.clock.advance(100);
    expect(net.mesh!.opened).toBe(2);
  });
});

describe('G16：中繼補送速率執行中可調', () => {
  it('🔴 setRelayBulkPerHour：調低／調高立刻生效；0＝暫停經中繼補送（直連照走），調回來就繼續', async () => {
    const net = new Net({ p2p: true, options: { relayBulkPerHour: 5 } });
    net.mesh!.reachable = () => false;
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    const relayNodes = countRelayNodes(a);
    a.sync.setRelayBulkPerHour(0);
    fill(a.vault, 40);
    await a.sync.scan();
    await net.clock.advance(2 * 3_600_000);
    expect(relayNodes()).toBe(0);
    expect(a.sync.status().queue).toBe(40);

    a.sync.setRelayBulkPerHour(10);
    await net.clock.advance(1000);
    expect(relayNodes()).toBe(10);
    a.sync.setRelayBulkPerHour(1000);
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(a.sync.relayBulkPerHour).toBe(1000);
  });

  it('不合法的值（負數、NaN、小數）：負數與 NaN 丟 RangeError，小數取整數', () => {
    const net = new Net({ p2p: true });
    return net.add('a').then((a) => {
      expect(() => a.sync.setRelayBulkPerHour(-1)).toThrow(RangeError);
      expect(() => a.sync.setRelayBulkPerHour(Number.NaN)).toThrow(RangeError);
      a.sync.setRelayBulkPerHour(7.9);
      expect(a.sync.relayBulkPerHour).toBe(7);
    });
  });
});
