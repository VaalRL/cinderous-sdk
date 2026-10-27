// 批次串流（SDK ADR 0026）：多檔一條串流、邊收邊寫、每檔校驗、續傳、背壓、惡意對端。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it } from 'vitest';

import { bytesSource, FileTransfer } from '../../src/transfer/file-transfer.js';
import {
  bytesEntry,
  hashSource,
  isStreamMessage,
  MemoryStreamingStore,
  type ReceivedEntry,
  type StreamEntry,
  StreamInterruptedError,
  type StreamReceiveProgress,
  StreamRejectedError,
  StreamTransfer,
  STREAM_WIRE_VERSION,
} from '../../src/transfer/stream.js';
import { channelPair, controlRecords, CountingStore, dataRecord, patternHash, patternRead, rawMessage } from './stream-helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const track = (s: StreamTransfer) => (cleanups.push(() => s.close()), s);

const text = (s: string) => new TextEncoder().encode(s);
/** 任意長度的亂數內容（`randomBytes` 一次最多 64 KB） */
const rand = (n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536) out.set(randomBytes(Math.min(65_536, n - i)), i);
  return out;
};
const smallFiles = (n: number) => Array.from({ length: n }, (_, i) => bytesEntry(`f${i}`, text(`第 ${i} 個檔案：${'x'.repeat(i % 700)}`), { path: `notes/${i}.md` }));

function collect(stream: StreamTransfer, purpose = 'files', handler: Partial<Parameters<StreamTransfer['handle']>[1]> = {}) {
  const got: ReceivedEntry[] = [];
  stream.handle(purpose, { onEntry: (e) => void got.push(e), ...handler });
  return got;
}

describe('StreamTransfer：批次', () => {
  it('🔴 3,000 個小檔一條串流：內容一致、每檔都有結果、訊息數遠少於檔案數（多檔併成一則）', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    const receiver = track(StreamTransfer.for(pair.bob));
    const got = collect(receiver);
    const files = smallFiles(3000);
    const t0 = performance.now();
    const done: number[] = [];
    const result = await sender.send(files, { purpose: 'files', count: files.length, onEntryDone: (i) => done.push(i) });
    const ms = performance.now() - t0;
    expect(result.entries).toBe(3000);
    expect(result.results.every((r) => r.status === 'ok')).toBe(true);
    expect(done).toHaveLength(3000);
    expect(got.map((e) => e.id)).toEqual(files.map((f) => f.id));
    for (let i = 0; i < files.length; i += 1) {
      expect(bytesToHex(sha256(got[i]!.bytes!))).toBe(files[i]!.sha256);
      expect(got[i]!.meta).toEqual({ path: `notes/${i}.md` });
    }
    expect(pair.sentByAlice.length).toBeLessThan(files.length / 10);
    console.info(`[stream] 3000 個小檔：${ms.toFixed(0)} ms，送方 ${pair.sentByAlice.length} 則、收方 ${pair.sentByBob.length} 則`);
  });

  it('🔴 亂序、重複的訊息（兩個方向）：結果仍然正確', async () => {
    const pair = channelPair({ reorderRate: 0.3, duplicateRate: 0.2, seed: 7 });
    const sender = track(StreamTransfer.for(pair.alice, { flushBytes: 2048 }));
    const receiver = track(StreamTransfer.for(pair.bob));
    const got = collect(receiver);
    const files = smallFiles(400);
    const big = { id: 'big', size: 3_000_000, sha256: patternHash(3_000_000), read: async (o: number, l: number) => patternRead(o, l) };
    const store = new MemoryStreamingStore();
    receiver.handle('files', { store, onEntry: (e) => void got.push(e) });
    const result = await sender.send([...files.slice(0, 200), big, ...files.slice(200)], { purpose: 'files' });
    expect(result.results.every((r) => r.status === 'ok')).toBe(true);
    expect(got.map((e) => e.id)).toEqual([...files.slice(0, 200).map((f) => f.id), 'big', ...files.slice(200).map((f) => f.id)]);
    expect(bytesToHex(sha256(store.committed.get(big.sha256)!))).toBe(big.sha256);
  });

  it('空的批次、空檔案', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    const got = collect(track(StreamTransfer.for(pair.bob)));
    expect((await sender.send([], { purpose: 'files' })).entries).toBe(0);
    const result = await sender.send([bytesEntry('empty', new Uint8Array(0))], { purpose: 'files' });
    expect(result.results).toEqual([{ status: 'ok' }]);
    expect(got[0]!.bytes).toEqual(new Uint8Array(0));
  });

  it('非同步產生器當來源：不必事先把整批放進記憶體', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    const got = collect(track(StreamTransfer.for(pair.bob)));
    async function* gen() {
      for (let i = 0; i < 50; i += 1) yield bytesEntry(`g${i}`, text(`gen ${i}`));
    }
    const result = await sender.send(gen(), { purpose: 'files' });
    expect(result.entries).toBe(50);
    expect(got).toHaveLength(50);
  });

  it('收方的 accept：skip 的小檔回報 skipped、拒收的回報 failed，其他照收', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    const got = collect(track(StreamTransfer.for(pair.bob)), 'files', { accept: (h) => (h.id === 'f1' ? 'skip' : h.id === 'f2' ? false : true) });
    const result = await sender.send(smallFiles(4), { purpose: 'files' });
    expect(result.results.map((r) => r.status)).toEqual(['ok', 'skipped', 'failed', 'ok']);
    expect(got.map((e) => e.id)).toEqual(['f0', 'f3']);
  });

  it('沒有人處理的用途 → StreamRejectedError', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    collect(track(StreamTransfer.for(pair.bob)), 'files');
    await expect(sender.send(smallFiles(1), { purpose: 'other' })).rejects.toBeInstanceOf(StreamRejectedError);
  });

  it('對方不在（沒有任何回應）→ 逾時丟 StreamInterruptedError', async () => {
    const pair = channelPair();
    pair.tamper = (from) => (from === 'alice' ? null : new Uint8Array(0));
    const sender = track(new StreamTransfer(pair.alice, { openTimeoutMs: 50 }));
    await expect(sender.send(smallFiles(1), { purpose: 'files' })).rejects.toBeInstanceOf(StreamInterruptedError);
  });
});

describe('StreamTransfer：大檔、續傳、提交', () => {
  it('🔴 大檔寫進 StreamingFileStore，校驗通過才提交（commit）', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    const store = new MemoryStreamingStore();
    let peek: Uint8Array | undefined;
    const got = collect(track(StreamTransfer.for(pair.bob)), 'files', {
      store,
      // 監聽裡（提交之前）可以分段讀暫存
      onEntry: async (e) => {
        got.push(e);
        peek = await e.readRange(10, 5);
      },
    });
    const data = rand(5_000_000);
    const result = await sender.send([bytesEntry('video', data, { name: 'v.mp4' })], { purpose: 'files' });
    expect(result.results[0]).toEqual({ status: 'ok' });
    expect(got[0]!.bytes).toBeUndefined(); // 大檔不在記憶體裡
    expect(peek).toEqual(data.slice(10, 15));
    const hash = bytesToHex(sha256(data));
    expect(bytesToHex(sha256(store.committed.get(hash)!))).toBe(hash); // 大陣列用雜湊比，toEqual 逐元素比很慢
    expect(await store.size(hash)).toBe(0);
  });

  it('🔴 中途斷線 → 換一條通道（或 App 重開）再送同一個檔案：只補剩下的部分', async () => {
    const store = new MemoryStreamingStore(); // 模擬持久化的暫存：兩次連線共用
    const data = rand(2_000_000);
    const first = channelPair();
    const s1 = new StreamTransfer(first.alice, { chunkBytes: 50_000, flushBytes: 50_000 });
    const r1 = new StreamTransfer(first.bob);
    r1.handle('files', { store, onEntry: () => {} });
    let dataBytes = 0;
    first.tamper = (from, d) => {
      if (from === 'alice' && d.length > 1000) dataBytes += d.length;
      if (dataBytes > 700_000) first.disconnect();
      return d;
    };
    await expect(s1.send([bytesEntry('big', data)], { purpose: 'files' })).rejects.toBeInstanceOf(StreamInterruptedError);
    const kept = await store.size(bytesToHex(sha256(data)));
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(data.length);

    // 「重開」：全新的 StreamTransfer，暫存還在
    const second = channelPair();
    const s2 = track(new StreamTransfer(second.alice, { chunkBytes: 50_000, flushBytes: 50_000 }));
    const r2 = track(new StreamTransfer(second.bob));
    const got: ReceivedEntry[] = [];
    r2.handle('files', { store, onEntry: (e) => void got.push(e) });
    const result = await s2.send([bytesEntry('big', data)], { purpose: 'files' });
    expect(result.results[0]).toEqual({ status: 'ok' });
    expect(result.bytes).toBe(data.length - kept); // 只送剩下的
    expect(bytesToHex(sha256(store.committed.get(bytesToHex(sha256(data)))!))).toBe(bytesToHex(sha256(data)));
  });

  it('🔴 收方監聽丟例外 → 回報失敗、暫存保留；再送一次不必重傳資料', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    const store = new MemoryStreamingStore();
    let fail = true;
    const got: string[] = [];
    track(StreamTransfer.for(pair.bob)).handle('files', {
      store,
      onEntry: (e) => {
        if (fail) throw new Error('磁碟滿了');
        got.push(e.id);
      },
    });
    const data = rand(1_500_000);
    const first = await sender.send([bytesEntry('big', data)], { purpose: 'files' });
    expect(first.results[0]).toEqual({ status: 'failed', reason: '磁碟滿了' });
    expect(await store.size(bytesToHex(sha256(data)))).toBe(data.length);
    fail = false;
    const second = await sender.send([bytesEntry('big', data)], { purpose: 'files' });
    expect(second.results[0]).toEqual({ status: 'ok' });
    expect(second.bytes).toBe(0);
    expect(got).toEqual(['big']);
  });

  it('大檔 accept 回 skip：送方不送資料', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    collect(track(StreamTransfer.for(pair.bob)), 'files', { store: new MemoryStreamingStore(), accept: () => 'skip' });
    const result = await sender.send([bytesEntry('big', rand(2_000_000))], { purpose: 'files' });
    expect(result.results[0]).toEqual({ status: 'skipped' });
    expect(result.bytes).toBe(0);
  });

  it('收方沒有大檔儲存：大檔回報失敗、不佔記憶體，同一批的小檔照收', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    const got = collect(track(StreamTransfer.for(pair.bob)));
    const result = await sender.send([bytesEntry('a', text('a')), bytesEntry('big', rand(2_000_000)), bytesEntry('b', text('b'))], { purpose: 'files' });
    expect(result.results.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
    expect(result.bytes).toBe(2);
    expect(got.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('hashSource 分段算雜湊，與一次算的相同', async () => {
    const data = rand(300_000);
    expect(await hashSource(bytesSource('x', 'x', data), 7_000)).toBe(bytesToHex(sha256(data)));
  });
});

describe('StreamTransfer：記憶體與背壓', () => {
  async function sendPattern(size: number, appendDelayMs = 0) {
    const pair = channelPair();
    const sender = track(new StreamTransfer(pair.alice));
    const receiver = track(new StreamTransfer(pair.bob));
    const store = new CountingStore();
    store.appendDelayMs = appendDelayMs;
    receiver.handle('files', { store, onEntry: () => {} });
    const hash = patternHash(size);
    const entry: StreamEntry = { id: 'huge', size, sha256: hash, read: async (o, l) => patternRead(o, l) };
    const before = process.memoryUsage().arrayBuffers;
    let peakArrayBuffers = 0;
    const sampler = setInterval(() => {
      peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers - before);
    }, 5);
    const t0 = performance.now();
    const result = await sender.send([entry], { purpose: 'files' });
    const ms = performance.now() - t0;
    clearInterval(sampler);
    expect(result.results[0]).toEqual({ status: 'ok' });
    expect(store.committed.get(hash)).toBe(hash);
    return { sender: sender.stats(), receiver: receiver.stats(), pair, ms, peakArrayBuffers };
  }

  it('🔴 記憶體恆定：16 MB 與 128 MB 的檔案，收送兩端的緩衝峰值都在信用視窗內、不隨大小成長', { timeout: 120_000 }, async () => {
    const small = await sendPattern(16 * 1024 * 1024);
    const large = await sendPattern(128 * 1024 * 1024);
    const window = 4 * 1024 * 1024;
    for (const run of [small, large]) {
      expect(run.sender.peakInflightBytes).toBeLessThanOrEqual(window + 128 * 1024);
      expect(run.receiver.peakBufferedBytes).toBeLessThanOrEqual(window + 128 * 1024);
      expect(run.receiver.peakInlineBytes).toBe(0);
      expect(run.pair.peakInFlight).toBeLessThanOrEqual(window + 256 * 1024);
    }
    // 檔案大 8 倍，緩衝峰值沒有跟著變大
    expect(large.receiver.peakBufferedBytes).toBeLessThanOrEqual(small.receiver.peakBufferedBytes * 1.5 + 256 * 1024);
    expect(large.sender.peakInflightBytes).toBeLessThanOrEqual(small.sender.peakInflightBytes * 1.5 + 256 * 1024);
    // 行程層級（含 GC 延遲，寬鬆）：128 MB 的檔案，ArrayBuffer 增量遠小於檔案大小
    expect(large.peakArrayBuffers).toBeLessThan(64 * 1024 * 1024);
    const mbps = (bytes: number, ms: number) => ((bytes / 1024 / 1024) / (ms / 1000)).toFixed(1);
    console.info(
      `[stream] 16 MB：${small.ms.toFixed(0)} ms（${mbps(16 << 20, small.ms)} MB/s）；128 MB：${large.ms.toFixed(0)} ms（${mbps(128 << 20, large.ms)} MB/s）；` +
        `收方緩衝峰值 ${small.receiver.peakBufferedBytes}／${large.receiver.peakBufferedBytes} B；送方未確認峰值 ${small.sender.peakInflightBytes}／${large.sender.peakInflightBytes} B；` +
        `ArrayBuffer 增量峰值 ${(small.peakArrayBuffers / 1048576).toFixed(1)}／${(large.peakArrayBuffers / 1048576).toFixed(1)} MB`,
    );
  });

  it('🔴 背壓：收方寫得很慢時，送方停下來等，不會把資料堆在記憶體裡', { timeout: 30_000 }, async () => {
    const run = await sendPattern(12 * 1024 * 1024, 2);
    expect(run.sender.peakInflightBytes).toBeLessThanOrEqual(4 * 1024 * 1024 + 128 * 1024);
    expect(run.receiver.peakBufferedBytes).toBeLessThanOrEqual(4 * 1024 * 1024 + 128 * 1024);
  });
});

describe('StreamTransfer：自我審查補的洞', () => {
  it('🔴 兩個對端（兩條通道）同時送同一份大檔、共用同一個暫存：不會交錯寫壞，一個成功、另一個稍後再送就略過', async () => {
    const store = new MemoryStreamingStore();
    const data = rand(3_000_000);
    const hash = bytesToHex(sha256(data));
    const got: string[] = [];
    const pairs = [channelPair(), channelPair()];
    const senders = pairs.map((p) => track(new StreamTransfer(p.alice, { chunkBytes: 32_768, flushBytes: 32_768 })));
    for (const p of pairs) track(new StreamTransfer(p.bob)).handle('files', { store, onEntry: async (e) => void got.push(bytesToHex(sha256(await e.read()))) });
    const results = await Promise.all(senders.map((s) => s.send([bytesEntry('big', data)], { purpose: 'files' })));
    const statuses = results.map((r) => r.results[0]!.status).sort();
    expect(statuses).toEqual(['failed', 'ok']); // 第二個遇到「正在接收中」
    expect(got).toEqual([hash]); // 交出去的內容是對的
    expect(bytesToHex(sha256(store.committed.get(hash)!))).toBe(hash);
  });

  it('🔴 序號一下跳很遠（塞空訊息撐爆亂序緩衝）→ 中止', async () => {
    const pair = channelPair();
    const receiver = track(new StreamTransfer(pair.bob));
    receiver.handle('files', { onEntry: () => {} });
    const sid = randomBytes(16);
    await pair.alice.send(rawMessage({ dir: 0, sid, seq: 0, records: [[1, { purpose: 'files' }]] }));
    await pair.alice.send(rawMessage({ dir: 0, sid, seq: 5_000, records: [] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(pair.sentByBob.flatMap(controlRecords).some((r) => r.type === 17 && r.json.reason === '序號跳太遠')).toBe(true);
  });
});

describe('StreamTransfer：惡意對端與線路相容', () => {
  /** 直接對收方送手工組的訊息，回傳收方回了哪些紀錄 */
  async function attack(messages: Uint8Array[], handler: Partial<Parameters<StreamTransfer['handle']>[1]> = {}) {
    const pair = channelPair();
    const receiver = track(new StreamTransfer(pair.bob, { maxSessions: 2 }));
    const got: ReceivedEntry[] = [];
    const store = new MemoryStreamingStore();
    receiver.handle('files', { store, onEntry: (e) => void got.push(e), ...handler });
    for (const m of messages) await pair.alice.send(m);
    await new Promise((r) => setTimeout(r, 60));
    const replies = pair.sentByBob.flatMap(controlRecords);
    return { replies, got, store, receiver };
  }
  const sid = () => randomBytes(16);
  const hash = (b: Uint8Array) => bytesToHex(sha256(b));

  it('🔴 假雜湊：內容與宣告不符 → 失敗、不交出、暫存清掉', async () => {
    const s = sid();
    const data = text('real content');
    const { replies, got } = await attack([
      rawMessage({ dir: 0, sid: s, seq: 0, records: [[1, { purpose: 'files' }]] }),
      rawMessage({ dir: 0, sid: s, seq: 1, records: [[2, { i: 0, id: 'a', size: data.length, sha256: 'f'.repeat(64), meta: {} }], [3, dataRecord(0, 0, data)]] }),
    ]);
    expect(got).toHaveLength(0);
    expect(replies.find((r) => r.type === 20)?.json).toEqual({ r: [[0, 2, '整檔校驗不符']] });

    // 大檔版本：暫存不留下
    const s2 = sid();
    const big = rand(1_200_000);
    const fake = hash(randomBytes(8));
    const second = await attack([
      rawMessage({ dir: 0, sid: s2, seq: 0, records: [[1, { purpose: 'files' }]] }),
      rawMessage({ dir: 0, sid: s2, seq: 1, records: [[2, { i: 0, id: 'b', size: big.length, sha256: fake, meta: {} }], [3, dataRecord(0, 0, big)]] }),
    ]);
    expect(second.got).toHaveLength(0);
    expect(await second.store.size(fake)).toBe(0);
  });

  it('🔴 超過宣告大小的資料 → 整個工作階段中止（REJECT），暫存清掉', async () => {
    const s = sid();
    const { replies, got } = await attack([
      rawMessage({ dir: 0, sid: s, seq: 0, records: [[1, { purpose: 'files' }]] }),
      rawMessage({ dir: 0, sid: s, seq: 1, records: [[2, { i: 0, id: 'a', size: 3, sha256: hash(text('abc')), meta: {} }], [3, dataRecord(0, 0, text('abcdef'))]] }),
    ]);
    expect(got).toHaveLength(0);
    expect(replies.some((r) => r.type === 17)).toBe(true);
  });

  it('🔴 超大宣告（遠超上限）→ 那個檔案拒收，不配置任何東西；檔案數超過上限 → 整批拒收', async () => {
    const s = sid();
    const { replies, store } = await attack(
      [
        rawMessage({ dir: 0, sid: s, seq: 0, records: [[1, { purpose: 'files' }]] }),
        rawMessage({ dir: 0, sid: s, seq: 1, records: [[2, { i: 0, id: 'a', size: Number.MAX_SAFE_INTEGER, sha256: 'a'.repeat(64), meta: {} }]] }),
      ],
      { maxEntryBytes: 1024 * 1024 * 1024 },
    );
    expect(replies.find((r) => r.type === 18)?.json).toEqual({ i: 0, skip: true });
    expect(await store.size('a'.repeat(64))).toBe(0);

    const s2 = sid();
    const second = await attack([rawMessage({ dir: 0, sid: s2, seq: 0, records: [[1, { purpose: 'files', count: 10 }]] })], { maxEntries: 5 });
    expect(second.replies.some((r) => r.type === 17)).toBe(true);
  });

  it('🔴 ENTRY 序號跳號、DATA 位移不連續、END 清單雜湊不符 → 拒絕', async () => {
    const data = text('abc');
    const cases: Array<Array<[number, Uint8Array | object]>> = [
      [[2, { i: 5, id: 'a', size: 3, sha256: hash(data), meta: {} }]],
      [[2, { i: 0, id: 'a', size: 3, sha256: hash(data), meta: {} }], [3, dataRecord(0, 1, data.subarray(1))]],
    ];
    for (const records of cases) {
      const s = sid();
      const { replies } = await attack([rawMessage({ dir: 0, sid: s, seq: 0, records: [[1, { purpose: 'files' }]] }), rawMessage({ dir: 0, sid: s, seq: 1, records })]);
      expect(replies.some((r) => r.type === 17)).toBe(true);
    }
    const s = sid();
    const { replies } = await attack([
      rawMessage({ dir: 0, sid: s, seq: 0, records: [[1, { purpose: 'files' }]] }),
      rawMessage({ dir: 0, sid: s, seq: 1, records: [[2, { i: 0, id: 'a', size: 3, sha256: hash(data), meta: {} }], [3, dataRecord(0, 0, data)], [4, { count: 1, manifest: '0'.repeat(64) }]] }),
    ]);
    expect(replies.find((r) => r.type === 21)?.json).toMatchObject({ ok: false });
  });

  it('🔴 超過信用視窗還一直灌 → 中止；同時開太多工作階段 → 拒絕', async () => {
    const s = sid();
    const flood = Array.from({ length: 120 }, (_, i) => rawMessage({ dir: 0, sid: s, seq: i + 5, records: [[99, rand(64 * 1024)]] }));
    const { replies } = await attack([rawMessage({ dir: 0, sid: s, seq: 0, records: [[1, { purpose: 'files' }]] }), ...flood]);
    expect(replies.some((r) => r.type === 17 && r.json.reason === '超過信用視窗')).toBe(true);

    const opens = [sid(), sid(), sid()].map((x) => rawMessage({ dir: 0, sid: x, seq: 1, records: [] }));
    const second = await attack(opens);
    expect(second.replies.filter((r) => r.type === 17)).toHaveLength(1);
  });

  it('🔴 線路相容：新版本的訊息整則略過；舊的 FileTransfer 看到串流訊息不回應、串流看到 0xCF 也不理', async () => {
    const s = sid();
    const { replies } = await attack([rawMessage({ version: STREAM_WIRE_VERSION + 1, dir: 0, sid: s, seq: 0, records: [[1, { purpose: 'files' }]] })]);
    expect(replies).toHaveLength(0);

    // 舊客戶端：只有 FileTransfer 的一端收到整條串流
    const pair = channelPair();
    const legacy = new FileTransfer(pair.bob);
    cleanups.push(() => legacy.close());
    const sender = track(new StreamTransfer(pair.alice, { openTimeoutMs: 50 }));
    await expect(sender.send(smallFiles(3), { purpose: 'files' })).rejects.toBeInstanceOf(StreamInterruptedError);
    expect(pair.sentByBob).toHaveLength(0); // 舊的一端什麼都沒回、也沒有丟例外
    expect(isStreamMessage(pair.sentByAlice[0]!)).toBe(true);

    // 反過來：串流的一端收到 FileTransfer 的邀請，不理它
    const pair2 = channelPair();
    track(new StreamTransfer(pair2.bob));
    const oldSender = new FileTransfer(pair2.alice);
    cleanups.push(() => oldSender.close());
    void oldSender.sendFile(bytesSource('a', 'a', text('a'))).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(pair2.sentByBob).toHaveLength(0);
  });
});

describe('StreamTransfer：收方進度與結束通知（SDK ADR 0053 §G14）', () => {
  const snapshot = (p: StreamReceiveProgress): StreamReceiveProgress => ({ ...p, ...(p.entry ? { entry: { ...p.entry } } : {}) });

  it('🔴 onProgress：每段資料之後回報這個檔案收到多少、整批收到多少、幾個檔案有結果；onSessionEnd 結束時叫一次', async () => {
    const pair = channelPair();
    const sender = track(new StreamTransfer(pair.alice, { chunkBytes: 100_000, flushBytes: 100_000 }));
    const store = new MemoryStreamingStore();
    const progress: StreamReceiveProgress[] = [];
    const ended: Array<[string, string]> = [];
    track(StreamTransfer.for(pair.bob)).handle('files', {
      store,
      onEntry: () => {},
      onProgress: (p) => progress.push(snapshot(p)),
      onSessionEnd: (info, outcome) => ended.push([info.purpose, outcome]),
    });
    const data = rand(1_000_000);
    const small = text('小檔');
    await sender.send([bytesEntry('small', small, { path: 's.md' }), bytesEntry('big', data, { path: 'v.mp4' })], {
      purpose: 'files',
      count: 2,
      bytes: data.length + small.length,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const last = progress[progress.length - 1]!;
    expect(last).toMatchObject({ bytes: data.length + small.length, entries: 2, session: { count: 2, bytes: data.length + small.length } });
    const big = progress.filter((p) => p.entry?.id === 'big');
    expect(big.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < big.length; i += 1) expect(big[i]!.entry!.received).toBeGreaterThanOrEqual(big[i - 1]!.entry!.received);
    expect(big[big.length - 1]!.entry).toMatchObject({ index: 1, size: data.length, received: data.length, meta: { path: 'v.mp4' } });
    expect(ended).toEqual([['files', 'finished']]);
  });

  it('🔴 續傳：檔案的 received 從已經有的位置起算，整批的 bytes 只算這次真的收到的', async () => {
    const store = new MemoryStreamingStore();
    const data = rand(2_000_000);
    const first = channelPair();
    const s1 = new StreamTransfer(first.alice, { chunkBytes: 50_000, flushBytes: 50_000 });
    const firstEnded: string[] = [];
    new StreamTransfer(first.bob).handle('files', { store, onEntry: () => {}, onSessionEnd: (_info, outcome) => firstEnded.push(outcome) });
    let dataBytes = 0;
    first.tamper = (from, d) => {
      if (from === 'alice' && d.length > 1000) dataBytes += d.length;
      if (dataBytes > 700_000) first.disconnect();
      return d;
    };
    await expect(s1.send([bytesEntry('big', data)], { purpose: 'files' })).rejects.toBeInstanceOf(StreamInterruptedError);
    expect(firstEnded).toEqual(['dropped']);
    const kept = await store.size(bytesToHex(sha256(data)));
    expect(kept).toBeGreaterThan(0);

    const second = channelPair();
    const s2 = track(new StreamTransfer(second.alice, { chunkBytes: 50_000, flushBytes: 50_000 }));
    const progress: StreamReceiveProgress[] = [];
    track(new StreamTransfer(second.bob)).handle('files', { store, onEntry: () => {}, onProgress: (p) => progress.push(snapshot(p)) });
    await s2.send([bytesEntry('big', data)], { purpose: 'files' });
    expect(progress[0]!.entry).toMatchObject({ id: 'big', received: kept });
    expect(progress[progress.length - 1]).toMatchObject({ bytes: data.length - kept, entries: 1 });
  });

  it('監聽丟例外不影響傳輸；被拒的工作階段（收方拒絕）回 rejected', async () => {
    const pair = channelPair();
    const sender = track(StreamTransfer.for(pair.alice));
    const got: ReceivedEntry[] = [];
    const ended: string[] = [];
    track(StreamTransfer.for(pair.bob)).handle('files', {
      onEntry: (e) => void got.push(e),
      onProgress: () => {
        throw new Error('壞掉的監聽');
      },
      onSessionEnd: (_info, outcome) => ended.push(outcome),
    });
    const result = await sender.send(smallFiles(20), { purpose: 'files' });
    expect(result.results.every((r) => r.status === 'ok')).toBe(true);
    expect(got).toHaveLength(20);

    const pair2 = channelPair();
    const ended2: string[] = [];
    track(StreamTransfer.for(pair2.bob)).handle('files', { onSession: () => false, onEntry: () => {}, onSessionEnd: (_info, outcome) => ended2.push(outcome) });
    await expect(track(StreamTransfer.for(pair2.alice)).send(smallFiles(2), { purpose: 'files' })).rejects.toBeInstanceOf(StreamRejectedError);
    expect(ended2).toEqual(['rejected']);
    expect(ended).toEqual(['finished']);
  });
});
