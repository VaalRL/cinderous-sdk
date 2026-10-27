// 直連傳輸的進度（SDK ADR 0053 §G14；CinderSync G14）：transfers()、on('progress')、status().p2pBytes。
import { describe, expect, it } from 'vitest';

import { FILE_TIER_MAX_BYTES } from '../../../src/sync/ingest.js';
import type { VaultTransferProgress } from '../../../src/sync/vault/index.js';
import { type Device, Net } from './harness.js';

function record(device: Device): VaultTransferProgress[] {
  const events: VaultTransferProgress[] = [];
  device.sync.on('progress', (p) => events.push(p));
  return events;
}

const big = (n: number, seed = 1) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 4096) out[i] = (i * seed) & 0xff;
  out[0] = seed;
  return out;
};

describe('直連進度', () => {
  it('🔴 批次：送方與收方各一筆傳輸，開始與結束一定通知（時鐘不動時中間被節流）；累計位元組兩邊一致；結束後 transfers() 清空', async () => {
    const net = new Net({ p2p: true });
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    const sent = record(a);
    const got = record(b);
    for (let i = 0; i < 30; i += 1) a.vault.userWrite(`bulk/n-${i}.md`, `# ${i}\n${'內容'.repeat(50)}`);
    await a.sync.scan();
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());

    const sends = sent.filter((p) => p.direction === 'send');
    expect(sends.length).toBeGreaterThanOrEqual(2);
    const first = sends[0]!;
    expect(first).toMatchObject({ device: 'b', mode: 'p2p-webrtc', files: { done: 0, total: 30 }, bytes: { done: 0 } });
    expect(first.bytes.total).toBeGreaterThan(30 * 100);
    const last = sends[sends.length - 1]!;
    expect(last).toMatchObject({ id: first.id, ended: 'finished', files: { done: 30, total: 30 } });
    // 時鐘沒動：每筆只有開始與結束兩次
    expect(sends.filter((p) => p.id === first.id)).toHaveLength(2);

    const receives = got.filter((p) => p.direction === 'receive');
    expect(receives[0]).toMatchObject({ device: 'a', files: { done: 0, total: 30 } });
    // 收方只算真的收到的（送方開始後才發現已經經中繼送到的項目不會出現在串流裡）
    const end = receives[receives.length - 1]!;
    expect(end.ended).toBe('finished');
    expect(end.files.done).toBeGreaterThan(20);
    expect(end.files.done).toBeLessThanOrEqual(30);

    const sentBytes = a.sync.status().p2pBytes!.sent;
    expect(sentBytes).toBeGreaterThan(30 * 100);
    expect(b.sync.status().p2pBytes!.received).toBe(sentBytes);
    expect(last.bytes.done).toBe(sentBytes);
    expect(a.sync.transfers()).toEqual([]);
    expect(b.sync.transfers()).toEqual([]);
  });

  it('🔴 大檔直送：progressIntervalMs: 0 時每段都通知，current 帶路徑與已傳位元組（遞增到檔案大小）；傳輸中 transfers() 看得到', { timeout: 60_000 }, async () => {
    const net = new Net({ p2p: true, options: { progressIntervalMs: 0 } });
    const a = await net.add('a');
    const b = await net.add('b');
    await net.settle();
    const sent = record(a);
    const got = record(b);
    let seenWhileRunning: VaultTransferProgress[] = [];
    b.sync.on('progress', () => {
      if (seenWhileRunning.length === 0) seenWhileRunning = b.sync.transfers();
    });
    const video = big(FILE_TIER_MAX_BYTES + 200_000, 5);
    await a.edit('media/video.mp4', video);
    await net.settle();
    expect(b.vault.files.get('media/video.mp4')!.bytes.length).toBe(video.length);

    const sendCurrent = sent.filter((p) => p.current?.path === 'media/video.mp4').map((p) => p.current!.done);
    expect(sendCurrent.length).toBeGreaterThan(5);
    for (let i = 1; i < sendCurrent.length; i += 1) expect(sendCurrent[i]!).toBeGreaterThanOrEqual(sendCurrent[i - 1]!);
    expect(sendCurrent[sendCurrent.length - 1]).toBe(video.length);

    const recvCurrent = got.filter((p) => p.current?.path === 'media/video.mp4');
    expect(recvCurrent.length).toBeGreaterThan(5);
    expect(recvCurrent[recvCurrent.length - 1]!.current).toMatchObject({ size: video.length, done: video.length });
    expect(seenWhileRunning).toEqual([expect.objectContaining({ direction: 'receive', device: 'a' })]);
    expect(b.sync.status().p2pBytes!.received).toBeGreaterThanOrEqual(video.length);
  });

  it('沒有 peers：status 沒有 p2pBytes、transfers() 是空的', async () => {
    const net = new Net();
    const a = await net.add('a');
    expect(a.sync.status().p2pBytes).toBeUndefined();
    expect(a.sync.transfers()).toEqual([]);
  });
});
