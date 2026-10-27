// 檔案傳輸與續傳（SDK ADR 0015）。
import { afterEach, describe, expect, it } from 'vitest';

import { LARGE_PAYLOAD_WARNING_BYTES } from '../../src/peer/peer-node.js';
import {
  bytesSource,
  type ByteChannel,
  FileRejectedError,
  FileTransfer,
  isFileTransferMessage,
  LargeFileOverRelayError,
  MemoryPartialStore,
  type ReceivedFile,
} from '../../src/transfer/file-transfer.js';

/** 一對記憶體通道：非同步送達；可打亂順序、可攔截、可「斷線」 */
function channelPair(opts: { reorder?: boolean; mode?: 'p2p-webrtc' | 'relayed-websocket' } = {}) {
  const make = (peer: string) => {
    const listeners = new Set<(d: Uint8Array) => void>();
    const closers = new Set<() => void>();
    return { peer, listeners, closers, closed: false };
  };
  const a = make('b'.repeat(64));
  const b = make('a'.repeat(64));
  const sent = { a: [] as Uint8Array[], b: [] as Uint8Array[] };
  let tamper: ((d: Uint8Array) => Uint8Array | null) | undefined;
  const queue: (() => void)[] = [];
  const flush = () => {
    if (opts.reorder) queue.reverse();
    for (const fn of queue.splice(0)) fn();
  };
  const channel = (self: ReturnType<typeof make>, other: ReturnType<typeof make>, log: Uint8Array[]): ByteChannel => ({
    peerPublicKey: self.peer,
    mode: opts.mode ?? 'p2p-webrtc',
    async send(data) {
      if (self.closed) throw new Error('closed');
      log.push(data);
      const delivered = tamper ? tamper(data) : data;
      if (delivered === null) return;
      queue.push(() => {
        if (!other.closed) for (const l of other.listeners) l(delivered.slice());
      });
      if (opts.reorder && queue.length < 3) return; // 攢幾則再一起倒序送出
      await Promise.resolve();
      flush();
    },
    onMessage(listener) {
      self.listeners.add(listener);
      return () => self.listeners.delete(listener);
    },
    onClose(listener) {
      self.closers.add(listener);
      return () => self.closers.delete(listener);
    },
  });
  return {
    alice: channel(a, b, sent.a),
    bob: channel(b, a, sent.b),
    sent,
    setTamper(fn: typeof tamper) {
      tamper = fn;
    },
    flush,
    disconnect() {
      for (const side of [a, b]) {
        side.closed = true;
        for (const c of side.closers) c();
      }
    },
  };
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256);
const transfers: FileTransfer[] = [];
const track = (t: FileTransfer) => (transfers.push(t), t);
afterEach(() => {
  for (const t of transfers.splice(0)) t.close();
});

function received(transfer: FileTransfer) {
  return new Promise<{ file: ReceivedFile; data: Uint8Array }>((resolve) =>
    transfer.onFile(async (file) => resolve({ file, data: await file.read() })),
  );
}

describe('FileTransfer', () => {
  it('送一個多塊的檔案：收到的內容一模一樣，雙方都有進度', async () => {
    const pair = channelPair();
    const sender = track(new FileTransfer(pair.alice, { chunkSize: 16_384 }));
    const receiver = track(new FileTransfer(pair.bob));
    const got = received(receiver);
    const data = bytes(100_000);
    const progress: number[] = [];
    await sender.sendFile(bytesSource('照片.jpg', 'image/jpeg', data), { onProgress: (p) => progress.push(p.done) });
    const { file, data: out } = await got;
    expect(file).toMatchObject({ name: '照片.jpg', mime: 'image/jpeg', size: 100_000 });
    expect(out).toEqual(data);
    expect(progress.at(-1)).toBe(100_000);
  });

  it('空檔案也送得過去', async () => {
    const pair = channelPair();
    const sender = track(new FileTransfer(pair.alice));
    const got = received(track(new FileTransfer(pair.bob)));
    await sender.sendFile(bytesSource('空.txt', 'text/plain', new Uint8Array(0)));
    expect((await got).data).toEqual(new Uint8Array(0));
  });

  it('亂序到達也組得對', async () => {
    const pair = channelPair({ reorder: true });
    const sender = track(new FileTransfer(pair.alice, { chunkSize: 1_000 }));
    const got = received(track(new FileTransfer(pair.bob)));
    const data = bytes(10_500);
    const sending = sender.sendFile(bytesSource('a.bin', 'application/octet-stream', data));
    const timer = setInterval(() => pair.flush(), 1);
    await sending;
    clearInterval(timer);
    expect((await got).data).toEqual(data);
  });

  it('🔴 續傳：斷線後重新連上、用同一個 id 再送，只補剩下的部分', async () => {
    const store = new MemoryPartialStore();
    const data = bytes(50_000);
    const id = 'f'.repeat(32);

    const first = channelPair();
    const sender1 = track(new FileTransfer(first.alice, { chunkSize: 10_000 }));
    track(new FileTransfer(first.bob, { store }));
    let chunks = 0;
    first.setTamper((d) => {
      if (d[1] === 4) chunks += 1;
      if (chunks === 3) first.disconnect(); // 送了兩塊半就斷線
      return d;
    });
    await expect(sender1.sendFile(bytesSource('大.pdf', 'application/pdf', data), { id })).rejects.toThrow();
    const kept = await store.size(id);
    expect(kept).toBeGreaterThan(0);

    const second = channelPair();
    const sender2 = track(new FileTransfer(second.alice, { chunkSize: 10_000 }));
    const got = received(track(new FileTransfer(second.bob, { store })));
    await sender2.sendFile(bytesSource('大.pdf', 'application/pdf', data), { id });
    expect((await got).data).toEqual(data);
    const resentChunks = second.sent.a.filter((d) => d[1] === 4).length;
    expect(resentChunks).toBe(Math.ceil((50_000 - kept) / 10_000));
    expect(await store.size(id)).toBe(0); // 交出去之後暫存清掉
  });

  it('🔴 傳輸途中內容被改 → 整檔校驗失敗：送方丟例外、收方不交出檔案、暫存清掉', async () => {
    const pair = channelPair();
    const store = new MemoryPartialStore();
    const sender = track(new FileTransfer(pair.alice, { chunkSize: 1_000 }));
    const receiver = track(new FileTransfer(pair.bob, { store }));
    let delivered = false;
    receiver.onFile(() => {
      delivered = true;
    });
    pair.setTamper((d) => {
      if (d[1] === 4 && d.length > 30) {
        const copy = d.slice();
        copy[copy.length - 1]! ^= 0xff;
        return copy;
      }
      return d;
    });
    await expect(sender.sendFile(bytesSource('x', 'x', bytes(3_000)), { id: 'e'.repeat(32) })).rejects.toThrow(/校驗/);
    expect(delivered).toBe(false);
    expect(await store.size('e'.repeat(32))).toBe(0);
  });

  it('收方拒絕（onOffer 回 false）→ 送方丟 FileRejectedError', async () => {
    const pair = channelPair();
    const sender = track(new FileTransfer(pair.alice));
    track(new FileTransfer(pair.bob, { onOffer: () => false }));
    await expect(sender.sendFile(bytesSource('x', 'x', bytes(10)))).rejects.toBeInstanceOf(FileRejectedError);
  });

  it('超過收方的大小上限 → 拒絕，不配置任何記憶體', async () => {
    const pair = channelPair();
    const sender = track(new FileTransfer(pair.alice));
    track(new FileTransfer(pair.bob, { maxFileBytes: 1_000 }));
    await expect(sender.sendFile(bytesSource('x', 'x', bytes(2_000)))).rejects.toThrow(/太大/);
  });

  it('🔴 走中繼且超過 20 MB：預設不送（PRD 2.3），要明確允許', async () => {
    const pair = channelPair({ mode: 'relayed-websocket' });
    const sender = track(new FileTransfer(pair.alice));
    const huge = { name: 'movie.mp4', mime: 'video/mp4', size: LARGE_PAYLOAD_WARNING_BYTES + 1, read: async () => new Uint8Array(0) };
    await expect(sender.sendFile(huge)).rejects.toBeInstanceOf(LargeFileOverRelayError);
    expect(pair.sent.a).toHaveLength(0); // 一則都沒送
  });

  it('isFileTransferMessage：App 自己的訊息監聽可以據此略過檔案傳輸的訊息', () => {
    expect(isFileTransferMessage(new Uint8Array([0xcf, 1]))).toBe(true);
    expect(isFileTransferMessage(new TextEncoder().encode('{"hello":1}'))).toBe(false);
  });
});
