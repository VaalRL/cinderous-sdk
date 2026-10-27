// 可持久化的「等 P2P 才送」佇列（SDK ADR 0026 §4）：跑在真的 PeerNode（假 WebRTC）上。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { PeerNode, type PeerChannel } from '../../src/peer/peer-node.js';
import { MemorySyncStateStore } from '../../src/sync/vault/state-store.js';
import { P2PStreamQueue, type QueuedStreamFile } from '../../src/transfer/stream-queue.js';
import { MemoryStreamingStore, type ReceivedEntry, StreamTransfer } from '../../src/transfer/stream.js';
import { FakeTransport } from '../fake-transport.js';
import { FakeRtcNetwork } from '../peer/fake-rtc.js';
import { patternHash, patternRead } from './stream-helpers.js';

const cleanups: Array<() => void> = [];
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
  // 打洞逾時給寬一點：信令走 NIP-59（加解密吃 CPU），整套測試同時跑時 300 ms 會在 `ok` 模式下也逾時、改走中繼，
  // 佇列（預設不走中繼）就什麼都沒送。`fail` 模式是 ICE 立刻失敗，不靠逾時
  const a = new PeerNode({ identity: alice, transport, rtc: network.factory, connectTimeoutMs: 10_000 });
  const b = new PeerNode({ identity: bob, transport, rtc: network.factory, connectTimeoutMs: 10_000 });
  const received: ReceivedEntry[] = [];
  const bobStore = new MemoryStreamingStore(); // 收方的暫存（持久化的）
  const bobChannels: PeerChannel[] = [];
  let onAppend: ((total: number) => void) | undefined;
  const append = bobStore.append.bind(bobStore);
  let appended = 0;
  bobStore.append = async (id, bytes) => {
    await append(id, bytes);
    appended += bytes.length;
    onAppend?.(appended);
  };
  b.onPeer((channel) => {
    bobChannels.push(channel);
    StreamTransfer.for(channel).handle('cinderous/file/1', { store: bobStore, onEntry: (e) => void received.push(e) });
  });
  cleanups.push(() => {
    a.close();
    b.close();
  });
  return {
    alice,
    bob,
    a,
    b,
    received,
    bobStore,
    bobChannels,
    setOnAppend: (fn: typeof onAppend) => (onAppend = fn),
  };
}

const SIZE = 3 * 1024 * 1024;
const bigFile = () => ({ id: 'movie', size: SIZE, sha256: patternHash(SIZE), meta: { name: 'movie.mp4' }, read: async (o: number, l: number) => patternRead(o, l) });

describe('P2PStreamQueue', () => {
  it('排著不送；flush 打通 P2P 就一條串流送完（小檔＋大檔），Promise 在對方處理完後完成', async () => {
    const env = setup('ok');
    const queue = new P2PStreamQueue({ node: env.a });
    cleanups.push(() => queue.close());
    const small = new TextEncoder().encode('小檔');
    const p1 = queue.enqueue(env.bob.pubkey, { id: 'a', size: small.length, read: async (o, l) => small.subarray(o, o + l) });
    const p2 = queue.enqueue(env.bob.pubkey, bigFile());
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.pending(env.bob.pubkey)).toBe(2);
    expect(env.received).toHaveLength(0);
    await queue.flush(env.bob.pubkey);
    expect(await p1).toEqual({ status: 'ok' });
    expect(await p2).toEqual({ status: 'ok' });
    expect(env.received.map((e) => e.id).sort()).toEqual(['a', 'movie']);
    expect(env.bobStore.committed.has(patternHash(SIZE))).toBe(true);
    expect(queue.pending()).toBe(0);
  });

  it('🔴 只打得通中繼 → 留在佇列（預設不走中繼）；allowRelay 才送', async () => {
    const env = setup('fail');
    const queue = new P2PStreamQueue({ node: env.a });
    cleanups.push(() => queue.close());
    const data = new TextEncoder().encode('x');
    void queue.enqueue(env.bob.pubkey, { id: 'x', size: 1, read: async () => data }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    await queue.flush(env.bob.pubkey);
    expect(queue.pending()).toBe(1);
    expect(env.received).toHaveLength(0);

    const relayed = new P2PStreamQueue({ node: env.a, allowRelay: true });
    cleanups.push(() => relayed.close());
    const done = relayed.enqueue(env.bob.pubkey, { id: 'y', size: 1, read: async () => data });
    await new Promise((r) => setTimeout(r, 10));
    await relayed.flush(env.bob.pubkey);
    expect(await done).toEqual({ status: 'ok' });
  }, 20_000);

  it('🔴 送到一半斷線、送方 App 重開：restore 讀回佇列、open 重新打開檔案，收方從斷點續傳', async () => {
    const env = setup('ok');
    const store = new MemorySyncStateStore(); // 送方的持久化儲存
    const first = new P2PStreamQueue({ node: env.a, store });
    void first.enqueue(env.bob.pubkey, bigFile()).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.keys('sq:')).toHaveLength(1);
    // 收到約 1 MB 時，收方那端的通道斷掉（例如 Wi-Fi 斷線）
    env.setOnAppend((total) => {
      if (total > 1024 * 1024) env.bobChannels.at(-1)?.close();
    });
    await first.flush(env.bob.pubkey);
    first.close(); // 送方 App 關掉
    env.setOnAppend(undefined);
    const kept = await env.bobStore.size(patternHash(SIZE));
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(SIZE);
    expect(await store.keys('sq:')).toHaveLength(1); // 佇列還在

    // 重開：新的佇列實例，同一份儲存
    const opened: QueuedStreamFile[] = [];
    const second = new P2PStreamQueue({
      node: env.a,
      store,
      open: async (file) => {
        opened.push(file);
        return async (o, l) => patternRead(o, l);
      },
    });
    cleanups.push(() => second.close());
    const settled: Array<[string, string]> = [];
    second.onSettled((file, result) => settled.push([file.id, result.status]));
    expect(await second.restore()).toBe(1);
    await second.flush(env.bob.pubkey);
    expect(opened.map((f) => f.meta)).toEqual([{ name: 'movie.mp4' }]);
    expect(settled).toEqual([['movie', 'ok']]);
    expect(env.bobStore.committed.has(patternHash(SIZE))).toBe(true);
    expect(await store.keys('sq:')).toHaveLength(0);
  }, 20_000);

  it('🔴 對方回報暫時的失敗（例如寫入失敗）：留在佇列，下次再送就成功；不會一次就丟掉', async () => {
    const env = setup('ok');
    const queue = new P2PStreamQueue({ node: env.a });
    cleanups.push(() => queue.close());
    const data = new TextEncoder().encode('內容');
    let fail = true;
    env.b.onPeer((channel) => {
      StreamTransfer.for(channel).handle('cinderous/file/1', {
        onEntry: () => {
          if (fail) throw new Error('磁碟被鎖住');
        },
      });
    });
    const done = queue.enqueue(env.bob.pubkey, { id: 'x', size: data.length, read: async (o, l) => data.subarray(o, o + l) });
    await new Promise((r) => setTimeout(r, 10));
    await queue.flush(env.bob.pubkey);
    expect(queue.pending()).toBe(1);
    fail = false;
    await queue.flush(env.bob.pubkey);
    expect(await done).toEqual({ status: 'ok' });
    expect(queue.pending()).toBe(0);
  });

  it('重開後檔案不見了（open 回 null）→ 那一筆以失敗結束、移出佇列', async () => {
    const env = setup('ok');
    const store = new MemorySyncStateStore();
    const first = new P2PStreamQueue({ node: env.a, store });
    void first.enqueue(env.bob.pubkey, { id: 'gone', size: 3, sha256: bytesToHex(sha256(new Uint8Array(3))), read: async () => new Uint8Array(3) }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    first.close();
    const second = new P2PStreamQueue({ node: env.a, store, open: async () => null });
    cleanups.push(() => second.close());
    const settled: string[] = [];
    second.onSettled((_f, r) => settled.push(r.status));
    await second.restore();
    await second.flush(env.bob.pubkey);
    expect(settled).toEqual(['failed']);
    expect(await store.keys('sq:')).toHaveLength(0);
  });
});
