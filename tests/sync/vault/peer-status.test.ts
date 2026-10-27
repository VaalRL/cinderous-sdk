// 各裝置已知的版本頭與接收狀態（SDK ADR 0053 §G17；CinderSync G17）：peerStatus／peerStatuses／knownHeads／notePeerActivity。
// 只用已經在收送的訊息，不為回報多送任何東西（CinderSync ADR 0019：不讓收到修改的裝置多送摘要）。
import { describe, expect, it } from 'vitest';

import type { VaultSyncMessage } from '../../../src/sync/vault/index.js';
import { type Device, Net } from './harness.js';

function spy(device: Device): VaultSyncMessage['type'][] {
  const log: VaultSyncMessage['type'][] = [];
  const send = device.transport.send.bind(device.transport);
  device.transport.send = async (message) => {
    await send(message);
    log.push(message.type);
  };
  return log;
}

describe('peerStatus：經中繼', () => {
  it('🔴 還沒有它的任何消息 → 不知道（known 0、reportedAt null）；收齊它的摘要 → 知道它有什麼；之後本機改了 → 它少一個', async () => {
    // 不簽收（舊版）：只靠摘要（簽收單另見 relay-receipts.test.ts 與下面的測試）
    const net = new Net({ options: { digestPolicy: 'manual', receipts: false } });
    const a = await net.add('a');
    const b = await net.add('b', { options: { receipts: false } });
    await a.edit('x.md', '1');
    await a.edit('y.md', '1');
    await net.settle();
    expect(b.vault.get('x.md')).toBe('1');
    expect(a.sync.peerStatus('b')).toEqual({ device: 'b', lastSeenAt: null, reportedAt: null, missing: 2, files: 2, known: 0, sparse: false });

    b.sync.resync(); // b 送一份摘要（例如啟動後第一次連上）
    await net.settle();
    const now = net.clock.now();
    expect(a.sync.peerStatus('b')).toMatchObject({ reportedAt: now, lastSeenAt: now, missing: 0, files: 2, known: 2 });

    await a.edit('x.md', '2');
    await net.settle();
    expect(a.sync.peerStatus('b').missing).toBe(1);
    await a.remove('y.md'); // 刪除也算
    await net.settle();
    expect(a.sync.peerStatus('b').missing).toBe(2);
    expect(a.sync.knownHeads('b').map((h) => h.heads.length)).toEqual([1, 1]);
  });

  it('🔴 它以我的版本為父版本送來新版本 → 它一定有我的版本（不必等摘要）；不簽收的收方不為回報多送任何訊息', async () => {
    const net = new Net({ options: { digestPolicy: 'manual', receipts: false } });
    const a = await net.add('a');
    const b = await net.add('b');
    const sentByB = spy(b);
    await a.edit('x.md', '1');
    await net.settle();
    expect(sentByB).toEqual([]); // 收到修改的裝置什麼都不送
    expect(a.sync.peerStatus('b').missing).toBe(1);
    await b.edit('x.md', '1\n2');
    await net.settle();
    expect(a.sync.peerStatus('b')).toMatchObject({ missing: 0, reportedAt: null });
    expect(a.sync.peerStatus('b').lastSeenAt).toBe(net.clock.now());
    expect(sentByB).toEqual(['node']);
  });

  it('🔴 簽收的收方（SDK ADR 0068，預設）：收到修改只回一份簽收單，寄件端就知道它有了（使用者 2026-10-12 第 3 項）', async () => {
    const net = new Net({ options: { digestPolicy: 'manual' } });
    const a = await net.add('a');
    const b = await net.add('b');
    const sentByB = spy(b);
    await a.edit('x.md', '1');
    await net.settle();
    expect(sentByB).toEqual(['receipt']);
    expect(a.sync.peerStatus('b')).toMatchObject({ missing: 0, known: 1, reportedAt: null });
  });

  it('lastSeenAt 與 reportedAt 跨重開保留；notePeerActivity 只往後推；peerStatuses 列出看過的裝置、不含自己', async () => {
    const net = new Net({ options: { digestPolicy: 'manual' } });
    const a = await net.add('a');
    const b = await net.add('b');
    b.sync.resync();
    await net.settle();
    // 最後一次看到 b＝收到它的摘要的時候（之後 a 回的簽收單計時又推進了時鐘）
    const t = a.sync.peerStatus('b').lastSeenAt!;
    await net.clock.advance(60_000);
    a.sync.notePeerActivity('b', t - 1000); // 比較舊：不動
    a.sync.notePeerActivity('a');
    await a.sync.idle();
    expect(a.sync.peerStatus('b').lastSeenAt).toBe(t);
    a.sync.notePeerActivity('b');
    const marked = net.clock.now();
    await a.restart();
    expect(a.sync.peerStatus('b')).toMatchObject({ lastSeenAt: marked, reportedAt: t });
    expect(a.sync.peerStatuses().map((s) => s.device)).toEqual(['b']);
  });
});

describe('peerStatus：經直連', () => {
  it('🔴 直連批次的送達確認＝它已經併入：不必等摘要就知道它全收到了', async () => {
    const net = new Net({ p2p: true, options: { digestPolicy: 'manual' } });
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    a.sync.setRelayBulkPerHour(0); // 只走直連
    for (let i = 0; i < 25; i += 1) a.vault.userWrite(`bulk/n-${i}.md`, `# ${i}`);
    await a.sync.scan();
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(a.sync.peerStatus('b')).toMatchObject({ missing: 0, files: 25, known: 25, reportedAt: null });
    expect(a.sync.peerStatus('b').lastSeenAt).not.toBeNull();
    expect(a.sync.peerStatuses().map((s) => s.device)).toEqual(['b']);
  });
});
