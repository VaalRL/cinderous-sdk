// 批次串流（SDK ADR 0026）：在任何位元組通道（`PeerChannel`、`SecureChannel`）上，把多個檔案合成一條串流，
// 接收端邊收邊寫入（小檔在記憶體、大檔寫進注入的 `StreamingFileStore`），每檔 SHA-256 校驗，
// 大檔可以從斷點續傳（連 App 重開都行），記憶體占用與檔案大小無關（以信用視窗做背壓）。
//
// 線路格式（與 `FileTransfer` 的 0xCF 完全分開，舊客戶端看到 0xCB 直接略過）：
//   [0]     0xCB 標記
//   [1]     線路版本（`STREAM_WIRE_VERSION`）；不認得的版本整則略過
//   [2]     方向：0＝送方 → 收方（資料），1＝收方 → 送方（控制）
//   [3..19) 工作階段 id（16 位元組）
//   [19..23) 這個方向的序號（u32 大端序）；收端依序號重排、去重
//   [23..)  一串紀錄：[類型 u8][長度 u32][內容]；不認得的類型略過（向前相容）
//
// 送方紀錄：1 OPEN、2 ENTRY、3 DATA（[索引 u32][位移 u64][資料]）、4 END、5 CANCEL
// 收方紀錄：16 READY、17 REJECT、18 HAVE、19 ACK、20 DONE、21 FINISH
// 除了 DATA，內容都是 UTF-8 JSON。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, randomBytes } from '@noble/hashes/utils.js';

import type { ByteChannel, PartialFileStore } from './file-transfer.js';

export const STREAM_MAGIC = 0xcb;
/** 串流線路格式版本；日後改格式要升版，收端略過不認得的版本 */
export const STREAM_WIRE_VERSION = 1;
/** 送方每次讀多少、每個 DATA 紀錄最多多大 */
export const DEFAULT_STREAM_CHUNK_BYTES = 64 * 1024;
/** 送方累積到這麼多位元組就送出一則（小檔的多個紀錄併成一則，省下中繼軌的事件數） */
export const DEFAULT_STREAM_FLUSH_BYTES = 64 * 1024;
/** 收方給的信用視窗：送出但還沒被處理完（寫進儲存）的位元組上限 */
export const DEFAULT_STREAM_WINDOW_BYTES = 4 * 1024 * 1024;
/** 不超過這個大小的檔案在記憶體裡組起來；更大的寫進 `StreamingFileStore`，可以續傳 */
export const DEFAULT_STREAM_INLINE_BYTES = 1024 * 1024;
/** 單檔上限（寫進儲存時）：64 GiB。收方可以調整；宣告超過就拒收那個檔案 */
export const DEFAULT_MAX_STREAM_ENTRY_BYTES = 64 * 1024 * 1024 * 1024;
/** 一個工作階段最多幾個檔案 */
export const DEFAULT_MAX_STREAM_ENTRIES = 100_000;
/** 同時進行的收方工作階段上限 */
export const DEFAULT_MAX_STREAM_SESSIONS = 8;
/** 多久沒有任何進展就放棄（收方保留已寫入的部分，下次續傳） */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
/** 送方等收方回應 OPEN 多久 */
export const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 15_000;
/** 每個檔案（與工作階段）附帶的中繼資料 JSON 上限 */
export const MAX_STREAM_META_BYTES = 64 * 1024;

const HEADER = 23;
const DIR_DATA = 0;
const DIR_CONTROL = 1;
const R_OPEN = 1;
const R_ENTRY = 2;
const R_DATA = 3;
const R_END = 4;
const R_CANCEL = 5;
const R_READY = 16;
const R_REJECT = 17;
const R_HAVE = 18;
const R_ACK = 19;
const R_DONE = 20;
const R_FINISH = 21;
const ENTRY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PURPOSE = /^[A-Za-z0-9._:/-]{1,64}$/;
/** 送方收控制訊息的亂序暫存上限（則） */
const MAX_CONTROL_AHEAD = 1024;
/** 送方收控制訊息的亂序暫存上限（位元組） */
const MAX_CONTROL_BUFFER_BYTES = 4 * 1024 * 1024;
/** 收方超過視窗的寬容量（誠實的送方最多超過一則） */
const WINDOW_SLACK = 2 * 1024 * 1024;
const REMEMBER_CLOSED = 1024;
const ACK_DELAY_MS = 20;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 收方的大檔暫存：`PartialFileStore` 加上分段讀取，選配原子提交。 */
export interface StreamingFileStore extends PartialFileStore {
  /** 讀暫存裡的一段（續傳時重算雜湊、交給 App 時分段讀；不必整檔進記憶體） */
  readRange(id: string, offset: number, length: number): Promise<Uint8Array>;
  /**
   * 整檔校驗通過、而且 App 的監聽都成功之後呼叫：把暫存原子地變成正式檔案（例如 rename 暫存檔 → 目的地）。
   * 提交之後 `size(id)` 應回 0。沒有實作就改呼叫 `delete(id)`。校驗失敗的暫存一律 `delete`，不會提交。
   */
  commit?(id: string, info: StreamCommitInfo): Promise<void>;
  /**
   * 這份暫存是本機的**單一檔案**時回傳它的路徑（SDK ADR 0089）：整檔校驗通過後放進 `ReceivedEntry.stagedPath`，
   * App 可以直接改名取用、不必讀出再寫（行動版經原生橋接的讀寫很耗記憶體）。呼叫前要把還在記憶體的部分寫進檔案。
   * App 取走之後這份暫存就不在了：之後的 `commit`／`delete` 要容忍檔案不存在。沒有實作＝沒有這個路徑。
   */
  localPath?(id: string): Promise<string | undefined>;
}

export interface StreamCommitInfo {
  sha256: string;
  size: number;
  entryId: string;
  meta: Record<string, unknown>;
  from: string;
  purpose: string;
}

/** 記憶體實作（測試與範例）。`committed` 是提交後的內容。 */
export class MemoryStreamingStore implements StreamingFileStore {
  readonly #parts = new Map<string, Uint8Array[]>();
  readonly committed = new Map<string, Uint8Array>();

  async size(id: string): Promise<number> {
    return (this.#parts.get(id) ?? []).reduce((n, p) => n + p.length, 0);
  }

  async append(id: string, bytes: Uint8Array): Promise<void> {
    const parts = this.#parts.get(id) ?? [];
    parts.push(bytes.slice());
    this.#parts.set(id, parts);
  }

  async read(id: string): Promise<Uint8Array> {
    return concatBytes(...(this.#parts.get(id) ?? []));
  }

  async readRange(id: string, offset: number, length: number): Promise<Uint8Array> {
    // 只複製需要的那一段（不先把整個檔案接起來）
    const out: Uint8Array[] = [];
    let at = 0;
    const end = offset + length;
    for (const part of this.#parts.get(id) ?? []) {
      const next = at + part.length;
      if (next > offset && at < end) out.push(part.subarray(Math.max(0, offset - at), Math.min(part.length, end - at)));
      if (next >= end) break;
      at = next;
    }
    return concatBytes(...out);
  }

  async commit(id: string): Promise<void> {
    this.committed.set(id, await this.read(id));
    this.#parts.delete(id);
  }

  async delete(id: string): Promise<void> {
    this.#parts.delete(id);
  }
}

/** 要送的一個檔案。`sha256` 必須事先知道（大檔用 `hashSource` 分段算，不必整檔進記憶體）。 */
export interface StreamEntry {
  /** 英數與 `._:-`，最長 128 */
  id: string;
  size: number;
  /** 整檔 SHA-256（小寫 hex） */
  sha256: string;
  meta?: Record<string, unknown>;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bytesEntry(id: string, bytes: Uint8Array, meta?: Record<string, unknown>): StreamEntry {
  const entry: StreamEntry = { id, size: bytes.length, sha256: bytesToHex(sha256(bytes)), read: async (offset, length) => bytes.subarray(offset, offset + length) };
  if (meta) entry.meta = meta;
  return entry;
}

/** 分段算整檔 SHA-256，記憶體只佔一段。 */
export async function hashSource(source: { size: number; read(offset: number, length: number): Promise<Uint8Array> }, chunkBytes = DEFAULT_STREAM_CHUNK_BYTES): Promise<string> {
  const hasher = sha256.create();
  for (let offset = 0; offset < source.size; offset += chunkBytes) {
    const piece = await source.read(offset, Math.min(chunkBytes, source.size - offset));
    if (piece.length !== Math.min(chunkBytes, source.size - offset)) throw new Error('hashSource：讀到的長度不對');
    hasher.update(piece);
  }
  return bytesToHex(hasher.digest());
}

export type StreamEntryResult = { status: 'ok' } | { status: 'skipped' } | { status: 'failed'; reason: string };

export interface StreamSessionInfo {
  /** 工作階段 id（hex） */
  id: string;
  /** 對方公鑰（通道已認證） */
  from: string;
  purpose: string;
  /** 送方宣告的檔案數、總位元組數（只是提示；實際以收到的為準，各有上限） */
  count?: number;
  bytes?: number;
  meta?: Record<string, unknown>;
}

export interface StreamEntryHeader {
  index: number;
  id: string;
  size: number;
  sha256: string;
  meta: Record<string, unknown>;
}

/** 收到、已通過 SHA-256 校驗的一個檔案 */
export interface ReceivedEntry extends StreamEntryHeader {
  session: StreamSessionInfo;
  /** 小檔（≤ inline 上限）在記憶體裡的內容；大檔沒有這個欄位，請用 `readRange` */
  bytes?: Uint8Array;
  readRange(offset: number, length: number): Promise<Uint8Array>;
  /** 整檔讀進記憶體（大檔請避免） */
  read(): Promise<Uint8Array>;
  /**
   * 暫存區回報的本機檔案路徑（`StreamingFileStore.localPath`；SDK ADR 0089）：內容已通過整檔 SHA-256 校驗，
   * App 可以直接改名取用。只有存進暫存區（大檔）、而且暫存區實作了 `localPath` 時才有
   */
  stagedPath?: string;
}

/**
 * 某一種用途（`purpose`）的收方處理器。同一條通道可以有多種用途（例如 Vault 同步與一般檔案佇列），
 * 各自有自己的儲存與規則；送方宣告的用途沒有人處理就拒收。
 */
export interface StreamHandler {
  /** 大檔（> `inlineBytes`）寫到哪裡；沒有就拒收大檔 */
  store?: StreamingFileStore;
  inlineBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  /** 要不要開這個工作階段；預設要 */
  onSession?(info: StreamSessionInfo): boolean | Promise<boolean>;
  /**
   * 收資料之前決定這個檔案：`true` 收、`'skip'` 不需要（例如已經有了）、`false` 拒收。
   * 大檔選 skip／false 時送方不會送資料；小檔的資料已經在路上，收到就丟。預設 `true`。
   */
  accept?(header: StreamEntryHeader, session: StreamSessionInfo): boolean | 'skip' | Promise<boolean | 'skip'>;
  /**
   * 校驗通過的檔案。這個函式結束之後：大檔的暫存會被提交（`commit`）或刪除。
   * 丟例外＝這個檔案失敗（送方收到 failed），大檔的暫存保留，下次續傳不必重送。
   */
  onEntry(entry: ReceivedEntry): void | Promise<void>;
  /**
   * 收方進度（SDK ADR 0053 §G14）：開始收一個檔案（含續傳的起點）、每段資料、每個檔案有結果之後通知。同步呼叫、次數多，
   * 要更新畫面請自己節流；丟例外不影響傳輸。
   */
  onProgress?(progress: StreamReceiveProgress): void;
  /**
   * 工作階段結束（SDK ADR 0053 §G14）：`finished`＝送方送完（END）、`rejected`＝收方拒絕或協定錯誤、
   * `dropped`＝斷線、逾時或送方取消。只在 OPEN 之後（找得到處理器）才通知，每個工作階段一次。
   */
  onSessionEnd?(session: StreamSessionInfo, outcome: StreamSessionOutcome): void;
}

/** 收方的工作階段怎麼結束的（`onSessionEnd`） */
export type StreamSessionOutcome = 'finished' | 'rejected' | 'dropped';

/** 收方進度（`StreamHandler.onProgress`） */
export interface StreamReceiveProgress {
  session: StreamSessionInfo;
  /** 已經有結果的檔案數（收完、略過、拒收、失敗） */
  entries: number;
  /** 這個工作階段實際收到的資料位元組（續傳時不含之前已經有的部分） */
  bytes: number;
  /** 正在收的檔案；`received` 含續傳之前已經有的部分 */
  entry?: { index: number; id: string; size: number; received: number; meta: Record<string, unknown> };
}

/** 可注入的時間來源與計時器（測試用假的時鐘；形狀與 Vault 協調器的 `VaultSyncClock` 相同） */
export interface StreamTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: StreamTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface StreamTransferOptions {
  timers?: StreamTimers;
  chunkBytes?: number;
  flushBytes?: number;
  /** 收方給送方的信用視窗 */
  windowBytes?: number;
  maxSessions?: number;
  idleTimeoutMs?: number;
  openTimeoutMs?: number;
}

export interface SendStreamOptions {
  /** 收方依這個找處理器（英數與 `._:/-`，最長 64） */
  purpose: string;
  meta?: Record<string, unknown>;
  /** 預計的檔案數、總位元組數（給收方的 onSession 參考） */
  count?: number;
  bytes?: number;
  /** 每個檔案有結果時通知（收方校驗、處理完之後） */
  onEntryDone?(index: number, id: string, result: StreamEntryResult): void;
  onProgress?(progress: { entries: number; bytes: number }): void;
}

export interface StreamSendResult {
  results: StreamEntryResult[];
  entries: number;
  /** 實際送出的資料位元組（續傳時不含對方已有的部分） */
  bytes: number;
}

export class StreamRejectedError extends Error {
  override readonly name = 'StreamRejectedError';
}

/** 串流中斷（斷線、逾時）。`results` 是中斷前已經有結果的檔案，其餘的下次再送（大檔會續傳）。 */
export class StreamInterruptedError extends Error {
  override readonly name = 'StreamInterruptedError';
  constructor(
    message: string,
    readonly results: ReadonlyArray<StreamEntryResult | undefined>,
  ) {
    super(message);
  }
}

/** 收方回報整批清單不符（檔案數或清單雜湊對不上：有檔案在途中被加入或漏掉） */
export class StreamIntegrityError extends Error {
  override readonly name = 'StreamIntegrityError';
}

export function isStreamMessage(data: Uint8Array): boolean {
  return data[0] === STREAM_MAGIC;
}

/** 收發兩端共用的統計（測試量記憶體占用用） */
export interface StreamStats {
  /** 收方：收到但還沒處理完的位元組峰值 */
  peakBufferedBytes: number;
  /** 送方：送出但還沒被確認的位元組峰值 */
  peakInflightBytes: number;
  /** 收方：組在記憶體裡的小檔位元組峰值 */
  peakInlineBytes: number;
}

// ───────────────────────────── 編碼 ─────────────────────────────

function header(dir: number, sid: Uint8Array, seq: number): Uint8Array {
  const out = new Uint8Array(HEADER);
  out[0] = STREAM_MAGIC;
  out[1] = STREAM_WIRE_VERSION;
  out[2] = dir;
  out.set(sid, 3);
  new DataView(out.buffer).setUint32(19, seq);
  return out;
}

function record(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

const jsonRecord = (type: number, body: object) => record(type, encoder.encode(JSON.stringify(body)));

function parseRecords(bytes: Uint8Array): Array<{ type: number; body: Uint8Array }> | null {
  const out: Array<{ type: number; body: Uint8Array }> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; ) {
    if (at + 5 > bytes.length) return null;
    const type = bytes[at]!;
    const length = view.getUint32(at + 1);
    if (at + 5 + length > bytes.length) return null;
    out.push({ type, body: bytes.subarray(at + 5, at + 5 + length) });
    at += 5 + length;
  }
  return out;
}

function parseJson(body: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(decoder.decode(body)) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const isMeta = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function checkEntry(entry: StreamEntry): Uint8Array {
  if (!ENTRY_ID.test(entry.id)) throw new TypeError('StreamEntry.id 只能用英數與 ._:-，最長 128');
  if (!isCount(entry.size)) throw new TypeError('StreamEntry.size 必須是非負整數');
  if (!HEX64.test(entry.sha256)) throw new TypeError('StreamEntry.sha256 必須是 64 字元小寫 hex');
  const meta = entry.meta ?? {};
  const body = encoder.encode(JSON.stringify({ id: entry.id, size: entry.size, sha256: entry.sha256, meta }));
  if (body.length > MAX_STREAM_META_BYTES + 512) throw new RangeError('StreamEntry.meta 太大');
  return body;
}

// ───────────────────────────── 狀態 ─────────────────────────────

interface SendSession {
  sid: Uint8Array;
  sidHex: string;
  seq: number;
  pending: Uint8Array[];
  pendingBytes: number;
  sizes: Map<number, number>;
  inflight: number;
  ctlNext: number;
  ctlBuffer: Map<number, Uint8Array>;
  ready?: { window: number; inline: number };
  have: Map<number, { have: number; skip: boolean }>;
  results: Array<StreamEntryResult | undefined>;
  ids: string[];
  finished?: { ok: boolean; reason?: string };
  failure?: Error;
  wake: Set<() => void>;
  lastActivity: number;
  opts: SendStreamOptions;
}

interface Incoming {
  header: StreamEntryHeader;
  mode: 'inline' | 'store' | 'discard' | 'skipped';
  /** 送方要從哪裡開始送（大檔續傳）；資料的位移必須從這裡連續 */
  received: number;
  hasher: ReturnType<typeof sha256.create>;
  parts: Uint8Array[];
  key: string;
  decision: boolean | 'skip';
}

interface RecvSession {
  sid: Uint8Array;
  sidHex: string;
  from: string;
  next: number;
  buffer: Map<number, Uint8Array>;
  bufferBytes: number;
  processing: boolean;
  handler?: StreamHandler;
  info?: StreamSessionInfo;
  inline: number;
  maxEntryBytes: number;
  maxEntries: number;
  nextIndex: number;
  current?: Incoming;
  manifest: ReturnType<typeof sha256.create>;
  outSeq: number;
  outRecords: Uint8Array[];
  unacked: number;
  processedSeq: number;
  ackTimer?: unknown;
  idleTimer?: unknown;
  done: boolean;
  /** 這個工作階段實際收到的資料位元組（進度用） */
  bytes: number;
  /** 已經有結果的檔案數（進度用） */
  results: number;
}

class Violation extends Error {}

const perChannel = new WeakMap<ByteChannel, StreamTransfer>();
/**
 * 每個儲存正在寫入的暫存鍵。放在模組層級：同一個儲存常被好幾條通道共用（例如 Vault 協調器的 staging），
 * 兩個對端同時送同一份內容時，第二個一定要等（回 skip），否則兩邊的 append 交錯寫進同一份暫存。
 */
const activeByStore = new WeakMap<StreamingFileStore, Set<string>>();

/**
 * 批次串流的一端（收送兩用）。同一條通道只用一個實例（`StreamTransfer.for`），用途不同的處理器用 `handle` 掛上。
 *
 * ```ts
 * const stream = StreamTransfer.for(channel);
 * stream.handle('files', { store, onEntry: async (entry) => save(entry) });
 * await stream.send(entries, { purpose: 'files' });
 * ```
 */
export class StreamTransfer {
  static for(channel: ByteChannel, opts?: StreamTransferOptions): StreamTransfer {
    let stream = perChannel.get(channel);
    if (!stream || stream.#closed) {
      stream = new StreamTransfer(channel, opts);
      perChannel.set(channel, stream);
    }
    return stream;
  }

  readonly #channel: ByteChannel;
  readonly #chunk: number;
  readonly #flushBytes: number;
  readonly #window: number;
  readonly #maxSessions: number;
  readonly #idleMs: number;
  readonly #openMs: number;
  readonly #t: StreamTimers;
  readonly #handlers = new Map<string, StreamHandler>();
  readonly #sends = new Map<string, SendSession>();
  readonly #recvs = new Map<string, RecvSession>();
  readonly #closedSids = new Set<string>();
  /** 正在寫入的大檔暫存鍵（以儲存為單位，跨通道）：兩個工作階段不同時寫同一份 */
  #activeKeys(store: StreamingFileStore): Set<string> {
    let set = activeByStore.get(store);
    if (!set) activeByStore.set(store, (set = new Set()));
    return set;
  }
  /** 累積的檔案結果（小檔一批一批回報，不必每個檔案一則） */
  readonly #doneBatch = new WeakMap<RecvSession, Array<[number, number, string?]>>();
  readonly #offMessage: () => void;
  readonly #offClose: (() => void) | undefined;
  readonly #stats: StreamStats = { peakBufferedBytes: 0, peakInflightBytes: 0, peakInlineBytes: 0 };
  #closed = false;

  constructor(channel: ByteChannel, opts: StreamTransferOptions = {}) {
    this.#channel = channel;
    this.#t = opts.timers ?? realTimers;
    this.#chunk = opts.chunkBytes ?? DEFAULT_STREAM_CHUNK_BYTES;
    this.#flushBytes = opts.flushBytes ?? DEFAULT_STREAM_FLUSH_BYTES;
    this.#window = opts.windowBytes ?? DEFAULT_STREAM_WINDOW_BYTES;
    this.#maxSessions = opts.maxSessions ?? DEFAULT_MAX_STREAM_SESSIONS;
    this.#idleMs = opts.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.#openMs = opts.openTimeoutMs ?? DEFAULT_STREAM_OPEN_TIMEOUT_MS;
    for (const [name, value] of [['chunkBytes', this.#chunk], ['flushBytes', this.#flushBytes], ['windowBytes', this.#window]] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必須是正整數`);
    }
    this.#offMessage = channel.onMessage((data) => {
      if (isStreamMessage(data)) this.#onMessage(data);
    });
    this.#offClose = channel.onClose?.(() => this.#shutdown(new StreamInterruptedError('通道已關閉', [])));
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** 收發的記憶體峰值（測試與監控用） */
  stats(): StreamStats {
    return { ...this.#stats };
  }

  /** 掛上某種用途的收方處理器；回傳取消函式 */
  handle(purpose: string, handler: StreamHandler): () => void {
    if (!PURPOSE.test(purpose)) throw new TypeError('purpose 只能用英數與 ._:/-，最長 64');
    this.#handlers.set(purpose, handler);
    return () => {
      if (this.#handlers.get(purpose) === handler) this.#handlers.delete(purpose);
    };
  }

  /**
   * 送一批檔案（可以是陣列、產生器或非同步產生器；檔案依序送出）。
   * 收方處理完最後一個檔案、而且整批清單相符時完成。中途斷線丟 `StreamInterruptedError`（附已有的結果）。
   */
  async send(entries: Iterable<StreamEntry> | AsyncIterable<StreamEntry>, opts: SendStreamOptions): Promise<StreamSendResult> {
    if (this.#closed) throw new StreamInterruptedError('StreamTransfer 已關閉', []);
    if (!PURPOSE.test(opts.purpose)) throw new TypeError('purpose 只能用英數與 ._:/-，最長 64');
    const sid = randomBytes(16);
    const s: SendSession = {
      sid,
      sidHex: bytesToHex(sid),
      seq: 0,
      pending: [],
      pendingBytes: 0,
      sizes: new Map(),
      inflight: 0,
      ctlNext: 0,
      ctlBuffer: new Map(),
      have: new Map(),
      results: [],
      ids: [],
      wake: new Set(),
      lastActivity: this.#t.now(),
      opts,
    };
    this.#sends.set(s.sidHex, s);
    try {
      const open: Record<string, unknown> = { purpose: opts.purpose };
      if (opts.count !== undefined) open.count = opts.count;
      if (opts.bytes !== undefined) open.bytes = opts.bytes;
      if (opts.meta) open.meta = opts.meta;
      this.#push(s, jsonRecord(R_OPEN, open));
      await this.#flush(s);
      await this.#wait(s, () => s.ready !== undefined, this.#openMs, '對方沒有回應（可能不在線上）');
      const inline = s.ready!.inline;
      const manifest = sha256.create();
      let index = 0;
      let bytes = 0;
      for await (const entry of this.#withKeepalive(s, entries)) {
        const body = checkEntry(entry);
        s.ids[index] = entry.id;
        manifest.update(body);
        this.#push(s, record(R_ENTRY, concatBytes(encoder.encode(`{"i":${index},`), body.subarray(1))));
        let from = 0;
        if (entry.size > inline) {
          await this.#flush(s);
          const i = index;
          await this.#wait(s, () => s.have.has(i), this.#idleMs, '對方沒有回應');
          const have = s.have.get(i)!;
          s.have.delete(i);
          if (have.skip) {
            index += 1;
            continue;
          }
          from = have.have;
        }
        for (let offset = from; offset < entry.size; offset += this.#chunk) {
          if (this.#closed) throw new StreamInterruptedError('通道已關閉', s.results);
          const want = Math.min(this.#chunk, entry.size - offset);
          const piece = await entry.read(offset, want);
          if (piece.length !== want) throw new Error(`讀取 ${entry.id} 時長度不對（檔案在傳送途中被改了？）`);
          const head = new Uint8Array(12);
          const view = new DataView(head.buffer);
          view.setUint32(0, index);
          view.setBigUint64(4, BigInt(offset));
          this.#push(s, record(R_DATA, concatBytes(head, piece)));
          bytes += piece.length;
          if (s.pendingBytes >= this.#flushBytes) await this.#flush(s);
          opts.onProgress?.({ entries: index, bytes });
        }
        index += 1;
      }
      this.#push(s, jsonRecord(R_END, { count: index, manifest: bytesToHex(manifest.digest()) }));
      await this.#flush(s);
      await this.#wait(s, () => s.finished !== undefined, this.#idleMs, '對方沒有回應');
      opts.onProgress?.({ entries: index, bytes });
      if (!s.finished!.ok) throw new StreamIntegrityError(`對方回報整批不符：${s.finished!.reason ?? ''}`);
      return { results: s.results.map((r) => r ?? { status: 'failed', reason: '沒有結果' }), entries: index, bytes };
    } catch (error) {
      if (!(error instanceof StreamInterruptedError) && !(error instanceof StreamRejectedError) && !this.#closed) {
        // 告訴對方放棄這一批（收方保留大檔的暫存，下次續傳）
        s.pending = [];
        s.pendingBytes = 0;
        this.#push(s, jsonRecord(R_CANCEL, {}));
        void this.#flush(s, true).catch(() => {});
      }
      if (error instanceof StreamInterruptedError) throw new StreamInterruptedError(error.message, s.results);
      throw error;
    } finally {
      this.#sends.delete(s.sidHex);
    }
  }

  close(): void {
    this.#shutdown(new StreamInterruptedError('StreamTransfer 已關閉', []));
  }

  /** 逐一取來源；取得很慢時（每 1/3 閒置逾時）送一則空訊息當心跳 */
  async *#withKeepalive(s: SendSession, entries: Iterable<StreamEntry> | AsyncIterable<StreamEntry>): AsyncGenerator<StreamEntry> {
    const iterator = Symbol.asyncIterator in entries ? entries[Symbol.asyncIterator]() : (entries as Iterable<StreamEntry>)[Symbol.iterator]();
    for (;;) {
      const next = Promise.resolve(iterator.next());
      let timer: unknown;
      const beat = () => {
        timer = this.#t.setTimeout(() => {
          if (this.#closed || s.failure) return;
          void this.#flush(s, true, true).catch(() => {});
          beat();
        }, Math.max(1, Math.floor(this.#idleMs / 3)));
      };
      beat();
      let result: IteratorResult<StreamEntry>;
      try {
        result = await next;
      } finally {
        this.#t.clearTimeout(timer);
      }
      if (result.done) return;
      yield result.value;
    }
  }

  #shutdown(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#offMessage();
    this.#offClose?.();
    for (const s of this.#sends.values()) {
      s.failure = error;
      for (const wake of s.wake) wake();
    }
    for (const r of this.#recvs.values()) this.#dropRecv(r);
  }

  // ───────────────────────────── 送方 ─────────────────────────────

  #push(s: SendSession, rec: Uint8Array): void {
    s.pending.push(rec);
    s.pendingBytes += rec.length;
  }

  async #flush(s: SendSession, force = false, keepalive = false): Promise<void> {
    if (s.pending.length === 0 && !keepalive) return;
    const message = concatBytes(header(DIR_DATA, s.sid, s.seq), ...s.pending);
    s.pending = [];
    s.pendingBytes = 0;
    if (!force && s.ready) {
      const window = s.ready.window;
      await this.#wait(s, () => s.inflight === 0 || s.inflight + message.length <= window, this.#idleMs, '對方處理太慢或沒有回應');
    }
    const seq = s.seq;
    s.seq += 1;
    s.sizes.set(seq, message.length);
    s.inflight += message.length;
    if (s.inflight > this.#stats.peakInflightBytes) this.#stats.peakInflightBytes = s.inflight;
    await this.#channel.send(message);
  }

  /** 等條件成立；對方拒絕、通道關閉、太久（`idleMs`）沒有任何回應都會丟例外 */
  #wait(s: SendSession, ready: () => boolean, idleMs: number, timeoutMessage: string): Promise<void> {
    const start = this.#t.now();
    return new Promise<void>((resolve, reject) => {
      let timer: unknown;
      const done = () => {
        this.#t.clearTimeout(timer);
        s.wake.delete(check);
      };
      const check = () => {
        if (s.failure) {
          done();
          reject(s.failure instanceof StreamInterruptedError ? new StreamInterruptedError(s.failure.message, s.results) : s.failure);
          return;
        }
        if (ready()) {
          done();
          resolve();
          return;
        }
        this.#t.clearTimeout(timer);
        const since = Math.max(start, s.lastActivity);
        const left = idleMs - (this.#t.now() - since);
        if (left <= 0) {
          done();
          reject(new StreamInterruptedError(timeoutMessage, s.results));
          return;
        }
        timer = this.#t.setTimeout(check, left);
      };
      s.wake.add(check);
      check();
    });
  }

  #onControl(sidHex: string, seq: number, body: Uint8Array): void {
    const s = this.#sends.get(sidHex);
    if (!s) return;
    if (seq < s.ctlNext || s.ctlBuffer.has(seq)) return; // 重複
    if (seq - s.ctlNext > MAX_CONTROL_AHEAD) return;
    let buffered = 0;
    for (const b of s.ctlBuffer.values()) buffered += b.length + HEADER;
    if (buffered + body.length > MAX_CONTROL_BUFFER_BYTES) return;
    s.ctlBuffer.set(seq, body.slice());
    for (let next = s.ctlBuffer.get(s.ctlNext); next !== undefined; next = s.ctlBuffer.get(s.ctlNext)) {
      s.ctlBuffer.delete(s.ctlNext);
      s.ctlNext += 1;
      this.#applyControl(s, next);
    }
    s.lastActivity = this.#t.now();
    for (const wake of [...s.wake]) wake();
  }

  #applyControl(s: SendSession, body: Uint8Array): void {
    const records = parseRecords(body);
    if (!records) {
      s.failure = new StreamRejectedError('對方的回覆格式不正確');
      return;
    }
    for (const { type, body: raw } of records) {
      if (type === R_ACK || type === R_READY || type === R_REJECT || type === R_HAVE || type === R_DONE || type === R_FINISH) {
        const json = parseJson(raw);
        if (!json) continue;
        switch (type) {
          case R_READY:
            if (isCount(json.window) && json.window > 0 && isCount(json.inline)) s.ready ??= { window: json.window, inline: json.inline };
            break;
          case R_REJECT:
            s.failure ??= new StreamRejectedError(`對方拒收：${typeof json.reason === 'string' ? json.reason : ''}`);
            break;
          case R_HAVE:
            if (isCount(json.i)) s.have.set(json.i, { have: isCount(json.have) ? json.have : 0, skip: json.skip === true });
            break;
          case R_ACK:
            if (isCount(json.seq)) {
              for (const [seq, size] of s.sizes) {
                if (seq > json.seq) continue;
                s.sizes.delete(seq);
                s.inflight -= size;
              }
            }
            break;
          case R_DONE:
            if (Array.isArray(json.r)) {
              for (const item of json.r) {
                if (!Array.isArray(item) || !isCount(item[0])) continue;
                const [i, code, reason] = item as [number, unknown, unknown];
                const result: StreamEntryResult =
                  code === 0 ? { status: 'ok' } : code === 1 ? { status: 'skipped' } : { status: 'failed', reason: typeof reason === 'string' ? reason : '失敗' };
                if (s.results[i] !== undefined) continue;
                s.results[i] = result;
                try {
                  s.opts.onEntryDone?.(i, s.ids[i] ?? '', result);
                } catch {
                  // App 的回呼出錯不影響傳輸
                }
              }
            }
            break;
          case R_FINISH:
            s.finished ??= json.ok === true ? { ok: true } : { ok: false, reason: typeof json.reason === 'string' ? json.reason : '' };
            break;
        }
      }
    }
  }

  // ───────────────────────────── 收方 ─────────────────────────────

  #onMessage(data: Uint8Array): void {
    if (this.#closed || data.length < HEADER || data[1] !== STREAM_WIRE_VERSION) return; // 不認得的版本：略過
    const dir = data[2];
    const sid = data.subarray(3, 19);
    const sidHex = bytesToHex(sid);
    const seq = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(19);
    const body = data.subarray(HEADER);
    if (dir === DIR_CONTROL) {
      this.#onControl(sidHex, seq, body);
      return;
    }
    if (dir !== DIR_DATA || this.#closedSids.has(sidHex)) return;
    let r = this.#recvs.get(sidHex);
    if (!r) {
      if (this.#recvs.size >= this.#maxSessions) {
        // 太多同時進行的工作階段：拒絕（對方稍後再試）
        this.#rejectUnknown(sid, sidHex, '同時進行的批次太多');
        return;
      }
      r = {
        sid: sid.slice(),
        sidHex,
        from: this.#channel.peerPublicKey,
        next: 0,
        buffer: new Map(),
        bufferBytes: 0,
        processing: false,
        inline: DEFAULT_STREAM_INLINE_BYTES,
        maxEntryBytes: DEFAULT_MAX_STREAM_ENTRY_BYTES,
        maxEntries: DEFAULT_MAX_STREAM_ENTRIES,
        nextIndex: 0,
        manifest: sha256.create(),
        outSeq: 0,
        outRecords: [],
        unacked: 0,
        processedSeq: -1,
        done: false,
        bytes: 0,
        results: 0,
      };
      this.#recvs.set(sidHex, r);
    }
    this.#touch(r);
    if (seq < r.next || r.buffer.has(seq)) return; // 重複
    if (seq - r.next > MAX_CONTROL_AHEAD) {
      this.#abort(r, '序號跳太遠');
      return;
    }
    r.buffer.set(seq, body.slice());
    r.bufferBytes += body.length + HEADER;
    if (r.bufferBytes > this.#stats.peakBufferedBytes) this.#stats.peakBufferedBytes = r.bufferBytes;
    if (r.bufferBytes > this.#window + WINDOW_SLACK) {
      this.#abort(r, '超過信用視窗');
      return;
    }
    void this.#process(r);
  }

  #rejectUnknown(sid: Uint8Array, sidHex: string, reason: string): void {
    this.#remember(sidHex);
    void this.#channel.send(concatBytes(header(DIR_CONTROL, sid, 0), jsonRecord(R_REJECT, { reason }))).catch(() => {});
  }

  #touch(r: RecvSession): void {
    this.#t.clearTimeout(r.idleTimer);
    r.idleTimer = this.#t.setTimeout(() => {
      if (r.processing) {
        // 還在處理（例如 App 正在把大檔寫進目的地）：告訴送方我們還活著，再等一輪
        this.#flushControl(r, true);
        this.#touch(r);
      } else this.#dropRecv(r);
    }, r.processing ? Math.max(1, Math.floor(this.#idleMs / 3)) : this.#idleMs);
  }

  async #process(r: RecvSession): Promise<void> {
    if (r.processing) return;
    r.processing = true;
    this.#touch(r);
    try {
      for (let body = r.buffer.get(r.next); body !== undefined && !r.done; body = r.buffer.get(r.next)) {
        const seq = r.next;
        r.buffer.delete(seq);
        r.next += 1;
        try {
          const records = parseRecords(body);
          if (!records) throw new Violation('紀錄格式不正確');
          for (const { type, body: raw } of records) {
            if (r.done) break;
            await this.#record(r, type, raw);
          }
        } catch (error) {
          if (error instanceof Violation) {
            this.#abort(r, error.message);
            return;
          }
          this.#abort(r, '處理失敗');
          return;
        } finally {
          r.bufferBytes -= body.length + HEADER;
        }
        if (r.done) return;
        r.processedSeq = seq;
        r.unacked += body.length + HEADER;
        this.#touch(r);
        this.#maybeAck(r);
      }
    } finally {
      r.processing = false;
    }
    // 處理期間又有新的訊息到：接著處理
    if (!r.done && r.buffer.has(r.next)) void this.#process(r);
  }

  async #record(r: RecvSession, type: number, raw: Uint8Array): Promise<void> {
    switch (type) {
      case R_OPEN:
        return this.#onOpen(r, raw);
      case R_ENTRY:
        return this.#onEntry(r, raw);
      case R_DATA:
        return this.#onData(r, raw);
      case R_END:
        return this.#onEnd(r, raw);
      case R_CANCEL:
        this.#dropRecv(r);
        return;
      default:
        return; // 不認得的紀錄：略過（向前相容）
    }
  }

  async #onOpen(r: RecvSession, raw: Uint8Array): Promise<void> {
    if (r.info) throw new Violation('重複的 OPEN');
    const json = parseJson(raw);
    if (!json || typeof json.purpose !== 'string' || !PURPOSE.test(json.purpose)) throw new Violation('OPEN 格式不正確');
    const info: StreamSessionInfo = { id: r.sidHex, from: r.from, purpose: json.purpose };
    if (json.count !== undefined) {
      if (!isCount(json.count)) throw new Violation('OPEN 格式不正確');
      info.count = json.count;
    }
    if (json.bytes !== undefined) {
      if (!isCount(json.bytes)) throw new Violation('OPEN 格式不正確');
      info.bytes = json.bytes;
    }
    if (json.meta !== undefined) {
      if (!isMeta(json.meta) || raw.length > MAX_STREAM_META_BYTES + 256) throw new Violation('OPEN 格式不正確');
      info.meta = json.meta;
    }
    const handler = this.#handlers.get(info.purpose);
    if (!handler) throw new Violation(`沒有處理「${info.purpose}」的收方`);
    r.handler = handler;
    r.info = info;
    r.inline = Math.max(0, handler.inlineBytes ?? DEFAULT_STREAM_INLINE_BYTES);
    r.maxEntryBytes = handler.maxEntryBytes ?? (handler.store ? DEFAULT_MAX_STREAM_ENTRY_BYTES : r.inline);
    r.maxEntries = handler.maxEntries ?? DEFAULT_MAX_STREAM_ENTRIES;
    if (info.count !== undefined && info.count > r.maxEntries) throw new Violation(`檔案太多（上限 ${r.maxEntries}）`);
    let ok = true;
    try {
      ok = handler.onSession ? await handler.onSession(info) : true;
    } catch {
      ok = false;
    }
    if (!ok) throw new Violation('收方拒絕');
    this.#out(r, jsonRecord(R_READY, { window: this.#window, inline: r.inline }), true);
  }

  async #onEntry(r: RecvSession, raw: Uint8Array): Promise<void> {
    if (!r.info || !r.handler) throw new Violation('ENTRY 在 OPEN 之前');
    if (r.current) throw new Violation('上一個檔案還沒收完');
    const json = parseJson(raw);
    if (!json) throw new Violation('ENTRY 格式不正確');
    const { i, id, size, sha256: hash, meta } = json;
    if (i !== r.nextIndex) throw new Violation('ENTRY 序號不對');
    if (typeof id !== 'string' || !ENTRY_ID.test(id) || !isCount(size) || typeof hash !== 'string' || !HEX64.test(hash) || !isMeta(meta)) throw new Violation('ENTRY 格式不正確');
    if (raw.length > MAX_STREAM_META_BYTES + 512) throw new Violation('ENTRY 中繼資料太大');
    if (r.nextIndex >= r.maxEntries) throw new Violation(`檔案太多（上限 ${r.maxEntries}）`);
    // 清單雜湊：送方算的是去掉 i 之後的 {id,size,sha256,meta}
    r.manifest.update(encoder.encode(JSON.stringify({ id, size, sha256: hash, meta })));
    r.nextIndex += 1;
    const headerInfo: StreamEntryHeader = { index: i, id, size, sha256: hash, meta };
    const big = size > r.inline;
    const current: Incoming = { header: headerInfo, mode: big ? 'store' : 'inline', received: 0, hasher: sha256.create(), parts: [], key: hash, decision: true };
    r.current = current;
    let decision: boolean | 'skip' = true;
    if (size > r.maxEntryBytes) decision = false;
    else {
      try {
        decision = r.handler.accept ? await r.handler.accept(headerInfo, r.info) : true;
      } catch {
        decision = false;
      }
    }
    current.decision = decision;
    const reason = size > r.maxEntryBytes ? `檔案太大（上限 ${r.maxEntryBytes} 位元組）` : '收方拒收';
    if (!big) {
      if (decision !== true) current.mode = 'discard';
      if (decision === true) this.#progress(r);
      if (size === 0) await this.#complete(r, current, reason);
      return;
    }
    // 大檔：告訴送方從哪裡開始送（或不必送）
    const store = r.handler.store;
    if (decision !== true || !store || this.#activeKeys(store).has(hash)) {
      current.mode = 'skipped';
      this.#out(r, jsonRecord(R_HAVE, { i, skip: true }), true);
      this.#done(r, i, decision === 'skip' ? 1 : 2, !store ? '收方沒有大檔儲存' : decision !== true ? reason : '同一份內容正在接收中');
      r.current = undefined;
      return;
    }
    this.#activeKeys(store).add(hash);
    let have = await store.size(hash);
    if (have > size) {
      await store.delete(hash);
      have = 0;
    }
    // 續傳：已有的部分分段重算雜湊（不必整檔進記憶體）
    for (let offset = 0; offset < have; offset += this.#chunk) {
      current.hasher.update(await store.readRange(hash, offset, Math.min(this.#chunk, have - offset)));
    }
    current.received = have;
    this.#out(r, jsonRecord(R_HAVE, { i, have }), true);
    this.#progress(r);
    if (have === size) await this.#complete(r, current, reason);
  }

  async #onData(r: RecvSession, raw: Uint8Array): Promise<void> {
    const current = r.current;
    if (!current || raw.length < 12) throw new Violation('DATA 沒有對應的檔案');
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const index = view.getUint32(0);
    const offset = Number(view.getBigUint64(4));
    const bytes = raw.subarray(12);
    if (index !== current.header.index || current.mode === 'skipped') throw new Violation('DATA 檔案序號不對');
    if (offset !== current.received || bytes.length === 0) throw new Violation('DATA 位移不連續');
    if (current.received + bytes.length > current.header.size) throw new Violation('超過宣告的大小');
    if (current.mode === 'inline') {
      current.parts.push(bytes.slice());
      if (current.received + bytes.length > this.#stats.peakInlineBytes) this.#stats.peakInlineBytes = current.received + bytes.length;
    } else if (current.mode === 'store') {
      await r.handler!.store!.append(current.key, bytes.slice());
    }
    if (current.mode !== 'discard') current.hasher.update(bytes);
    current.received += bytes.length;
    r.bytes += bytes.length;
    this.#progress(r);
    if (current.received === current.header.size) await this.#complete(r, current, '收方拒收');
  }

  async #complete(r: RecvSession, current: Incoming, rejectReason: string): Promise<void> {
    r.current = undefined;
    const { header: h } = current;
    if (current.mode === 'discard') {
      this.#done(r, h.index, current.decision === 'skip' ? 1 : 2, rejectReason);
      return;
    }
    const store = r.handler!.store;
    const release = () => {
      if (current.mode === 'store') this.#activeKeys(store!).delete(current.key);
    };
    if (bytesToHex(current.hasher.digest()) !== h.sha256) {
      if (current.mode === 'store') await store!.delete(current.key).catch(() => {});
      release();
      this.#done(r, h.index, 2, '整檔校驗不符');
      return;
    }
    const inline = current.mode === 'inline' ? concatBytes(...current.parts) : undefined;
    current.parts = [];
    const entry: ReceivedEntry = {
      ...h,
      session: r.info!,
      readRange: async (offset, length) => (inline ? inline.slice(offset, offset + length) : store!.readRange(current.key, offset, length)),
      read: async () => (inline ? inline.slice() : store!.readRange(current.key, 0, h.size)),
    };
    if (inline) entry.bytes = inline;
    if (current.mode === 'store' && store!.localPath) {
      try {
        const path = await store!.localPath(current.key);
        if (path) entry.stagedPath = path;
      } catch {
        // 拿不到路徑：照舊分段讀
      }
    }
    try {
      await r.handler!.onEntry(entry);
    } catch (error) {
      release();
      this.#done(r, h.index, 2, error instanceof Error ? error.message.slice(0, 200) : '收方處理失敗');
      return;
    }
    if (current.mode === 'store') {
      try {
        if (store!.commit) {
          await store!.commit(current.key, { sha256: h.sha256, size: h.size, entryId: h.id, meta: h.meta, from: r.from, purpose: r.info!.purpose });
        } else await store!.delete(current.key);
      } catch (error) {
        release();
        this.#done(r, h.index, 2, error instanceof Error ? `提交失敗：${error.message.slice(0, 200)}` : '提交失敗');
        return;
      }
    }
    release();
    this.#done(r, h.index, 0);
  }

  async #onEnd(r: RecvSession, raw: Uint8Array): Promise<void> {
    if (!r.info || r.current) throw new Violation('END 的時機不對');
    const json = parseJson(raw);
    if (!json) throw new Violation('END 格式不正確');
    const ok = json.count === r.nextIndex && json.manifest === bytesToHex(r.manifest.digest());
    this.#out(r, jsonRecord(R_FINISH, ok ? { ok: true, count: r.nextIndex } : { ok: false, reason: '檔案清單不符', count: r.nextIndex }), true);
    this.#finish(r, ok ? 'finished' : 'rejected');
  }

  #done(r: RecvSession, index: number, code: number, reason?: string): void {
    let batch = this.#doneBatch.get(r);
    if (!batch) this.#doneBatch.set(r, (batch = []));
    batch.push(reason !== undefined && code === 2 ? [index, code, reason] : [index, code]);
    r.results += 1;
    this.#progress(r);
  }

  #out(r: RecvSession, rec: Uint8Array, urgent = false): void {
    r.outRecords.push(rec);
    if (urgent) this.#flushControl(r);
  }

  #maybeAck(r: RecvSession): void {
    if (r.unacked >= this.#window / 4 || (this.#doneBatch.get(r)?.length ?? 0) >= 512) {
      this.#flushControl(r);
      return;
    }
    if (!r.ackTimer) r.ackTimer = this.#t.setTimeout(() => this.#flushControl(r), ACK_DELAY_MS);
  }

  #flushControl(r: RecvSession, keepalive = false): void {
    this.#t.clearTimeout(r.ackTimer);
    r.ackTimer = undefined;
    const batch = this.#doneBatch.get(r);
    const records: Uint8Array[] = [];
    if (batch && batch.length > 0) {
      records.push(jsonRecord(R_DONE, { r: batch }));
      this.#doneBatch.delete(r);
    }
    records.push(...r.outRecords.splice(0));
    if (r.processedSeq >= 0 && r.unacked > 0) {
      records.push(jsonRecord(R_ACK, { seq: r.processedSeq }));
      r.unacked = 0;
    }
    if (records.length === 0 && !keepalive) return;
    // 回報順序：檔案結果 → 其他（HAVE／READY／FINISH）→ 確認
    const ordered = [...records.filter((x) => x[0] === R_DONE), ...records.filter((x) => x[0] !== R_DONE)];
    const message = concatBytes(header(DIR_CONTROL, r.sid, r.outSeq), ...ordered);
    r.outSeq += 1;
    void this.#channel.send(message).catch(() => {});
  }

  #abort(r: RecvSession, reason: string): void {
    if (r.done) return;
    const current = r.current;
    // 協定錯誤：這個檔案的暫存不可信，丟掉
    if (current?.mode === 'store' && r.handler?.store) {
      void r.handler.store.delete(current.key).catch(() => {});
      this.#activeKeys(r.handler.store).delete(current.key);
    }
    r.current = undefined;
    this.#out(r, jsonRecord(R_REJECT, { reason }), false);
    this.#flushControl(r);
    this.#finish(r, 'rejected');
  }

  #finish(r: RecvSession, outcome: StreamSessionOutcome): void {
    r.done = true;
    this.#t.clearTimeout(r.idleTimer);
    this.#t.clearTimeout(r.ackTimer);
    if (r.outRecords.length > 0 || (this.#doneBatch.get(r)?.length ?? 0) > 0) this.#flushControl(r);
    this.#recvs.delete(r.sidHex);
    this.#remember(r.sidHex);
    this.#ended(r, outcome);
  }

  /** 收方進度（SDK ADR 0053 §G14）：監聽丟例外不影響傳輸 */
  #progress(r: RecvSession): void {
    const handler = r.handler;
    if (!handler?.onProgress || !r.info) return;
    const current = r.current;
    const progress: StreamReceiveProgress = { session: r.info, entries: r.results, bytes: r.bytes };
    if (current) {
      const h = current.header;
      progress.entry = { index: h.index, id: h.id, size: h.size, received: current.received, meta: h.meta };
    }
    try {
      handler.onProgress(progress);
    } catch {
      // 應用的監聽器出錯不影響傳輸
    }
  }

  #ended(r: RecvSession, outcome: StreamSessionOutcome): void {
    if (!r.info || !r.handler?.onSessionEnd) return;
    try {
      r.handler.onSessionEnd(r.info, outcome);
    } catch {
      // 同上
    }
  }

  /** 斷線、逾時或對方取消：保留大檔的暫存（下次續傳），不回任何東西 */
  #dropRecv(r: RecvSession): void {
    if (r.done) return;
    r.done = true;
    this.#t.clearTimeout(r.idleTimer);
    this.#t.clearTimeout(r.ackTimer);
    if (r.current?.mode === 'store' && r.handler?.store) this.#activeKeys(r.handler.store).delete(r.current.key);
    r.current = undefined;
    r.buffer.clear();
    this.#recvs.delete(r.sidHex);
    this.#remember(r.sidHex);
    this.#ended(r, 'dropped');
  }

  #remember(sidHex: string): void {
    this.#closedSids.add(sidHex);
    if (this.#closedSids.size > REMEMBER_CLOSED) this.#closedSids.delete(this.#closedSids.values().next().value!);
  }
}
