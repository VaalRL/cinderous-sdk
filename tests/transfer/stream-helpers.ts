// 批次串流測試用的記憶體通道：非同步送達，可以亂序、重送、竄改、斷線，並記下「網路上」的位元組峰值。
import type { ByteChannel } from '../../src/transfer/file-transfer.js';
import type { StreamingFileStore } from '../../src/transfer/stream.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairOptions {
  mode?: 'p2p-webrtc' | 'relayed-websocket';
  /** 每則有多少機率被延後（造成亂序） */
  reorderRate?: number;
  /** 每則有多少機率被重送一次 */
  duplicateRate?: number;
  seed?: number;
}

interface Side {
  peer: string;
  listeners: Set<(d: Uint8Array) => void>;
  closers: Set<() => void>;
  closed: boolean;
}

export interface Pair {
  alice: ByteChannel;
  bob: ByteChannel;
  /** alice 送出的每一則（原始） */
  sentByAlice: Uint8Array[];
  sentByBob: Uint8Array[];
  /** 竄改：回傳 null 表示丟掉 */
  tamper?: (from: 'alice' | 'bob', data: Uint8Array) => Uint8Array | null;
  /** 網路上還沒送達的位元組峰值 */
  peakInFlight: number;
  disconnect(): void;
}

export function channelPair(opts: PairOptions = {}): Pair {
  const random = rng(opts.seed ?? 1);
  const make = (peer: string): Side => ({ peer, listeners: new Set(), closers: new Set(), closed: false });
  const a = make('b'.repeat(64));
  const b = make('a'.repeat(64));
  let inFlight = 0;
  const pair: Pair = {
    alice: undefined as unknown as ByteChannel,
    bob: undefined as unknown as ByteChannel,
    sentByAlice: [],
    sentByBob: [],
    peakInFlight: 0,
    disconnect() {
      for (const side of [a, b]) {
        if (side.closed) continue;
        side.closed = true;
        for (const c of side.closers) c();
      }
    },
  };
  const deliver = (other: Side, data: Uint8Array) => {
    inFlight += data.length;
    pair.peakInFlight = Math.max(pair.peakInFlight, inFlight);
    const run = () => {
      inFlight -= data.length;
      if (!other.closed) for (const l of other.listeners) l(data.slice());
    };
    if (opts.reorderRate && random() < opts.reorderRate) setTimeout(run, 1 + Math.floor(random() * 5));
    else queueMicrotask(run);
  };
  const channel = (self: Side, other: Side, name: 'alice' | 'bob', log: Uint8Array[]): ByteChannel => ({
    peerPublicKey: self.peer,
    mode: opts.mode ?? 'p2p-webrtc',
    async send(data) {
      if (self.closed) throw new Error('closed');
      log.push(data);
      const out = pair.tamper ? pair.tamper(name, data) : data;
      if (out === null) return;
      deliver(other, out);
      if (opts.duplicateRate && random() < opts.duplicateRate) deliver(other, out);
      await Promise.resolve();
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
  pair.alice = channel(a, b, 'alice', pair.sentByAlice);
  pair.bob = channel(b, a, 'bob', pair.sentByBob);
  return pair;
}

/** 決定性的「大檔」：內容由位移算出，不必真的配置那麼多記憶體 */
export function patternByte(i: number): number {
  return (i * 2_654_435_761 + (i >>> 11)) & 0xff;
}

export function patternRead(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = patternByte(offset + i);
  return out;
}

export function patternHash(size: number, chunk = 1 << 20): string {
  const h = sha256.create();
  for (let offset = 0; offset < size; offset += chunk) h.update(patternRead(offset, Math.min(chunk, size - offset)));
  return bytesToHex(h.digest());
}

/**
 * 不保存內容、只記「寫到哪裡、雜湊多少」的暫存（量記憶體用：內容寫到「硬碟」就不佔記憶體）。
 * `readRange` 以產生器重建內容（假設寫進去的就是 pattern；測試另外檢查雜湊）。
 */
export class CountingStore implements StreamingFileStore {
  readonly sizes = new Map<string, number>();
  readonly hashers = new Map<string, ReturnType<typeof sha256.create>>();
  readonly committed = new Map<string, string>();
  appendDelayMs = 0;

  async size(id: string): Promise<number> {
    return this.sizes.get(id) ?? 0;
  }

  async append(id: string, bytes: Uint8Array): Promise<void> {
    if (this.appendDelayMs > 0) await new Promise((r) => setTimeout(r, this.appendDelayMs));
    this.sizes.set(id, (this.sizes.get(id) ?? 0) + bytes.length);
    let h = this.hashers.get(id);
    if (!h) this.hashers.set(id, (h = sha256.create()));
    h.update(bytes);
  }

  async read(): Promise<Uint8Array> {
    throw new Error('CountingStore 不支援整檔讀取');
  }

  async readRange(_id: string, offset: number, length: number): Promise<Uint8Array> {
    return patternRead(offset, length);
  }

  async commit(id: string): Promise<void> {
    this.committed.set(id, bytesToHex(this.hashers.get(id)!.digest()));
    this.sizes.delete(id);
    this.hashers.delete(id);
  }

  async delete(id: string): Promise<void> {
    this.sizes.delete(id);
    this.hashers.delete(id);
  }
}

// ── 手工組訊息（惡意對端測試用；格式照 stream.ts 開頭的說明） ──

export function rawMessage(opts: { version?: number; dir: number; sid: Uint8Array; seq: number; records: Array<[number, Uint8Array | object]> }): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(23);
  head[0] = 0xcb;
  head[1] = opts.version ?? 1;
  head[2] = opts.dir;
  head.set(opts.sid, 3);
  new DataView(head.buffer).setUint32(19, opts.seq);
  parts.push(head);
  for (const [type, body] of opts.records) {
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
    const rec = new Uint8Array(5 + bytes.length);
    rec[0] = type;
    new DataView(rec.buffer).setUint32(1, bytes.length);
    rec.set(bytes, 5);
    parts.push(rec);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function dataRecord(index: number, offset: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, index);
  view.setBigUint64(4, BigInt(offset));
  out.set(bytes, 12);
  return out;
}

/** 解出控制訊息裡的紀錄（測試看收方回了什麼） */
export function controlRecords(data: Uint8Array): Array<{ type: number; json: Record<string, unknown> }> {
  if (data[0] !== 0xcb || data[2] !== 1) return [];
  const out: Array<{ type: number; json: Record<string, unknown> }> = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = 23; at < data.length; ) {
    const type = data[at]!;
    const length = view.getUint32(at + 1);
    out.push({ type, json: JSON.parse(new TextDecoder().decode(data.subarray(at + 5, at + 5 + length))) as Record<string, unknown> });
    at += 5 + length;
  }
  return out;
}
