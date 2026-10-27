// 等 P2P 才送的大檔佇列（PRD 2.4 第三層；SDK ADR 0015）。
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { PeerNode, type PeerChannel } from '../../src/peer/peer-node.js';
import { bytesSource, FileTransfer, type ReceivedFile } from '../../src/transfer/file-transfer.js';
import { P2PFileQueue } from '../../src/transfer/p2p-queue.js';
import { FakeTransport } from '../fake-transport.js';
import { FakeRtcNetwork } from '../peer/fake-rtc.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(mode: 'ok' | 'fail') {
  const transport = new FakeTransport();
  transport.relay = true;
  const network = new FakeRtcNetwork();
  network.mode = mode;
  const alice = Identity.generate();
  const bob = Identity.generate();
  const a = new PeerNode({ identity: alice, transport, rtc: network.factory, connectTimeoutMs: 3_000 });
  const b = new PeerNode({ identity: bob, transport, rtc: network.factory, connectTimeoutMs: 3_000 });
  const got: Uint8Array[] = [];
  b.onPeer((channel: PeerChannel) => {
    FileTransfer.for(channel).onFile(async (file: ReceivedFile) => {
      got.push(await file.read());
    });
  });
  const queue = new P2PFileQueue({ node: a });
  cleanups.push(() => {
    queue.close();
    a.close();
    b.close();
  });
  return { alice, bob, a, b, queue, got };
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 256);

describe('P2PFileQueue', () => {
  it('排進佇列不會立刻送；flush 時打通 P2P 就送出，Promise 在對方校驗通過後完成', async () => {
    const { bob, queue, got } = setup('ok');
    const delivered = queue.enqueue(bob.pubkey, bytesSource('影片.mp4', 'video/mp4', bytes(300_000)));
    expect(queue.pending(bob.pubkey)).toBe(1);
    expect(got).toHaveLength(0);
    await queue.flush(bob.pubkey);
    await delivered;
    expect(got[0]).toEqual(bytes(300_000));
    expect(queue.pending(bob.pubkey)).toBe(0);
  });

  it('🔴 只打得通中繼 → 留在佇列裡，不走中繼（這一層的檔案太大，本來就不該走中繼）', async () => {
    const { bob, queue, got } = setup('fail');
    queue.enqueue(bob.pubkey, bytesSource('大.zip', 'application/zip', bytes(1_000))).catch(() => {}); // 測試結束關佇列時會以例外結束
    await queue.flush(bob.pubkey);
    expect(got).toHaveLength(0);
    expect(queue.pending(bob.pubkey)).toBe(1);
  });

  it('對方先連上來（P2P）→ 自動把排著的檔案送過去', async () => {
    const { alice, bob, b, queue, got } = setup('ok');
    const delivered = queue.enqueue(bob.pubkey, bytesSource('a.bin', 'application/octet-stream', bytes(5_000)));
    // Bob 主動連 Alice：Alice 的 onPeer 收到 P2P 通道；Bob 自己開的通道不經 onPeer，要自己掛上接收端
    const channel = await b.connectPeer(alice.pubkey);
    FileTransfer.for(channel).onFile(async (file: ReceivedFile) => {
      got.push(await file.read());
    });
    await delivered;
    expect(got[0]).toEqual(bytes(5_000));
  });

  it('FileTransfer.for：同一條通道只有一個實例（不會兩個都回應同一個邀請）', async () => {
    const { bob, a } = setup('ok');
    const channel = await a.connectPeer(bob.pubkey);
    expect(FileTransfer.for(channel)).toBe(FileTransfer.for(channel));
  });

  it('close 之後排著的都以例外結束', async () => {
    const { bob, queue } = setup('ok');
    const delivered = queue.enqueue(bob.pubkey, bytesSource('a', 'a', bytes(10)));
    queue.close();
    await expect(delivered).rejects.toThrow(/關閉/);
  });
});
