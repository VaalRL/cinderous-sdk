// 協調器測試用的假環境：手動時鐘、記憶體 Vault、假中繼（扇出、斷線、延遲、亂序、重送）。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { ByteChannel } from '../../../src/transfer/file-transfer.js';
import { MemoryStreamingStore } from '../../../src/transfer/stream.js';
import {
  decodeVaultMessage,
  encodedVaultMessageLength,
  encodeVaultMessage,
  MemorySyncStateStore,
  VaultSyncCoordinator,
  type VaultAdapter,
  type VaultContentSource,
  type VaultFileStat,
  type VaultPeerLink,
  type VaultPrecondition,
  type VaultRemoveOptions,
  type VaultSendOptions,
  type VaultSyncClock,
  type VaultSyncMessage,
  type VaultSyncOptions,
  type VaultSyncTransport,
  type LocalChangeKind,
} from '../../../src/sync/vault/index.js';

/** 可重現的亂數（mulberry32） */
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

export function hexIds(random: () => number): () => string {
  return () => Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
}

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export class ManualClock implements VaultSyncClock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void; seq: number }>();

  constructor(start = Date.UTC(2026, 8, 29, 0, 0, 0)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn, seq: id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  nextAt(): number | undefined {
    let min: number | undefined;
    for (const t of this.#timers.values()) if (min === undefined || t.at < min) min = t.at;
    return min;
  }

  get pending(): number {
    return this.#timers.size;
  }

  /** 前進到 `to`，依序執行到期的計時器（每個之後讓 microtask 跑完） */
  async advanceTo(to: number): Promise<void> {
    for (;;) {
      let next: [number, { at: number; fn: () => void; seq: number }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at > to) continue;
        if (!next || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[1].seq < next[1].seq)) next = entry;
      }
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = Math.max(this.#now, next[1].at);
      next[1].fn();
      await flush();
    }
    this.#now = Math.max(this.#now, to);
    await flush();
  }

  advance(ms: number): Promise<void> {
    return this.advanceTo(this.#now + ms);
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
export const text = (s: string) => encoder.encode(s);
export const str = (b: Uint8Array) => decoder.decode(b);

/** 記憶體 Vault。前置條件在同一個同步區段內檢查並執行（原子）。 */
export class MemoryVault implements VaultAdapter {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  #mtime = 1;
  /** 協調器每次帶前置條件的寫入前呼叫（測試用它在「讀與寫之間」插入使用者的編輯） */
  beforeGuardedOp: ((path: string) => void) | undefined;
  readonly log: string[] = [];
  /** 協調器每次 `remove` 收到的第三個參數（G23：清掉本機副本時帶 `evict`；真正的刪除不帶） */
  readonly removeCalls: Array<{ path: string; options: VaultRemoveOptions | undefined; args: number }> = [];
  /** 選配的串流讀寫（SDK ADR 0026）；`new MemoryVault({ streaming: true })` 才有 */
  readRange?: (path: string, offset: number, length: number) => Promise<Uint8Array>;
  writeStream?: (path: string, source: VaultContentSource, expectHash: string | null) => Promise<boolean>;
  /** 串流寫入時單次讀取的最大位元組（驗證是分段寫的） */
  maxStreamChunk = 0;
  streamWrites = 0;
  /** 協調器寫入、刪除、改名的回音（`watch`）；使用者操作（user*）不經過這裡，測試自己通知 */
  #echo: ((path: string, kind: LocalChangeKind, oldPath?: string) => void) | undefined;
  readonly #echoPending = new Map<string, { kind: LocalChangeKind; oldPath?: string; timer: unknown }>();
  #echoClock: ManualClock | undefined;
  #echoMs = 500;

  constructor(opts: { streaming?: boolean } = {}) {
    if (!opts.streaming) return;
    this.readRange = async (path, offset, length) => {
      const f = this.files.get(path);
      if (!f) throw new Error(`ENOENT ${path}`);
      return f.bytes.slice(offset, offset + length);
    };
    this.writeStream = async (path, source, expectHash) => {
      // 先寫到暫存（這裡是一個新陣列）、全部寫完、確認目的地沒變，再原子地取代
      const out = new Uint8Array(source.size);
      for (let offset = 0; offset < source.size; offset += 1 << 20) {
        const piece = await source.read(offset, Math.min(1 << 20, source.size - offset));
        this.maxStreamChunk = Math.max(this.maxStreamChunk, piece.length);
        out.set(piece, offset);
      }
      this.beforeGuardedOp?.(path);
      const current = this.files.get(path);
      if (expectHash === null ? current !== undefined : !current || bytesToHex(sha256(current.bytes)) !== expectHash) return false;
      const existed = this.files.has(path);
      this.files.set(path, { bytes: out, mtime: this.#tick() });
      this.streamWrites += 1;
      this.log.push(`write-stream ${path}`);
      this.#onPlain(path, existed ? 'modify' : 'create');
      return true;
    };
  }

  /**
   * 像 Obsidian＋CinderSync 的監聽（SDK ADR 0048）：協調器自己的寫入、刪除、改名一樣觸發 Vault 事件，
   * 每個路徑防抖 `debounceMs` 後通知（改名帶最早的舊路徑、取消舊路徑待送的通知；同一路徑已有待送的就保留它的種類）。
   */
  watch(clock: ManualClock, notify: (path: string, kind: LocalChangeKind, oldPath?: string) => void, debounceMs = 500): void {
    this.#echo = notify;
    this.#echoClock = clock;
    this.#echoMs = debounceMs;
  }

  #schedule(key: string, change: { kind: LocalChangeKind; oldPath?: string }): void {
    const clock = this.#echoClock!;
    this.#cancel(key);
    const timer = clock.setTimeout(() => {
      const entry = this.#echoPending.get(key);
      this.#echoPending.delete(key);
      if (entry) this.#echo?.(key, entry.kind, entry.oldPath);
    }, this.#echoMs);
    this.#echoPending.set(key, { ...change, timer });
  }

  #cancel(key: string): void {
    const entry = this.#echoPending.get(key);
    if (!entry) return;
    this.#echoClock!.clearTimeout(entry.timer);
    this.#echoPending.delete(key);
  }

  #onPlain(path: string, kind: LocalChangeKind): void {
    if (!this.#echo) return;
    const existing = this.#echoPending.get(path);
    this.#schedule(path, existing ? { kind: existing.kind, ...(existing.oldPath !== undefined ? { oldPath: existing.oldPath } : {}) } : { kind });
  }

  #onRename(from: string, to: string): void {
    if (!this.#echo) return;
    const previous = this.#echoPending.get(from);
    this.#cancel(from);
    this.#schedule(to, { kind: 'rename', oldPath: previous?.oldPath ?? from });
  }

  #tick(): number {
    this.#mtime += 1;
    return this.#mtime;
  }

  async list(): Promise<VaultFileStat[]> {
    return [...this.files].map(([path, f]) => ({ path, size: f.bytes.length, mtime: f.mtime }));
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT ${path}`);
    return f.bytes.slice();
  }

  async write(path: string, bytes: Uint8Array, expect?: VaultPrecondition): Promise<boolean> {
    this.beforeGuardedOp?.(path);
    if (expect && !expect(this.files.get(path)?.bytes ?? null)) return false;
    const existed = this.files.has(path);
    this.files.set(path, { bytes: bytes.slice(), mtime: this.#tick() });
    this.log.push(`write ${path}`);
    this.#onPlain(path, existed ? 'modify' : 'create');
    return true;
  }

  async remove(path: string, expect?: VaultPrecondition, options?: VaultRemoveOptions): Promise<boolean> {
    this.removeCalls.push({ path, options, args: arguments.length });
    this.beforeGuardedOp?.(path);
    const f = this.files.get(path);
    if (expect && !expect(f?.bytes ?? null)) return false;
    this.files.delete(path);
    this.log.push(`remove ${path}`);
    this.#onPlain(path, 'delete');
    return true;
  }

  async rename(from: string, to: string, expect?: VaultPrecondition): Promise<boolean> {
    this.beforeGuardedOp?.(from);
    const f = this.files.get(from);
    if (!f || this.files.has(to)) return false;
    if (expect && !expect(f.bytes)) return false;
    this.files.delete(from);
    this.files.set(to, f);
    this.log.push(`rename ${from} -> ${to}`);
    this.#onRename(from, to);
    return true;
  }

  async stat(path: string): Promise<VaultFileStat | null> {
    const f = this.files.get(path);
    return f ? { path, size: f.bytes.length, mtime: f.mtime } : null;
  }

  // ── 使用者操作（同步、直接改檔案，不通知協調器） ──
  userWrite(path: string, content: string | Uint8Array): void {
    this.files.set(path, { bytes: typeof content === 'string' ? text(content) : content.slice(), mtime: this.#tick() });
  }

  userRemove(path: string): void {
    this.files.delete(path);
  }

  userRename(from: string, to: string): void {
    const f = this.files.get(from);
    if (!f || this.files.has(to)) throw new Error(`rename ${from} -> ${to}`);
    this.files.delete(from);
    this.files.set(to, { ...f, mtime: this.#tick() });
  }

  get(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? str(f.bytes) : undefined;
  }

  /** 路徑 → 內容（排序後），比較收斂用 */
  tree(): Record<string, string> {
    return Object.fromEntries([...this.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, f]) => [p, str(f.bytes)]));
  }
}

export interface HubOptions {
  random?: () => number;
  /** 投遞延遲上限（毫秒） */
  maxDelayMs?: number;
  /** 每則被重送一次的機率 */
  duplicateRate?: number;
  /** 訊息經過編碼再解碼（驗證線上格式） */
  roundTrip?: boolean;
}

/** 假中繼：存下所有訊息（像中繼的離線信箱），線上的裝置延遲投遞，重新上線的補送全部沒收過的（亂序）。 */
export class FakeHub {
  readonly #clock: ManualClock;
  readonly #random: () => number;
  readonly #opts: HubOptions;
  readonly #log: VaultSyncMessage[] = [];
  readonly #senders: string[] = [];
  readonly #options: Array<VaultSendOptions | undefined> = [];
  /** 每台收到幾則、多少位元組（編碼後；拿掉內容的照拿掉後算） */
  readonly received = new Map<string, { messages: number; bytes: number }>();
  /** 傳輸層照收件人送（`to`／`omitContentFor`）；false＝像舊的傳輸層一樣全部廣播、完整地送 */
  targeted = process.env.HUB_UNTARGETED !== '1';
  readonly #transports = new Map<string, FakeTransport>();
  inflight = 0;
  sent = 0;
  /** 收件裝置是否信任寄件裝置（像 `NostrVaultTransport` 的信任名單）；不信任的訊息直接丟掉，不會補送 */
  trust: ((receiver: string, sender: string) => boolean) | undefined;
  /** 中繼收下了（寄件人看到成功）卻弄丟了（例如收件匣滿了被淘汰）：回 true 的訊息誰都收不到、也不會補送 */
  drop: ((from: string, message: VaultSyncMessage, options?: VaultSendOptions) => boolean) | undefined;

  constructor(clock: ManualClock, opts: HubOptions = {}) {
    this.#clock = clock;
    this.#opts = opts;
    this.#random = opts.random ?? Math.random;
  }

  transport(device: string, online = true): FakeTransport {
    const t = new FakeTransport(this, device, online);
    this.#transports.set(device, t);
    return t;
  }

  get messages(): readonly VaultSyncMessage[] {
    return this.#log;
  }

  /** 每一則送出的訊息：誰送的、收件人（`undefined`＝廣播；傳輸層不照收件人送時一律是廣播） */
  get sends(): ReadonlyArray<{ from: string; message: VaultSyncMessage; to: readonly string[] | undefined }> {
    return this.#log.map((message, i) => ({ from: this.#senders[i]!, message, to: this.#options[i]?.to }));
  }

  /** 除了 `device` 以外的每一台（SDK ADR 0068 的收件人） */
  others(device: string): string[] {
    return [...this.#transports.keys()].filter((d) => d !== device);
  }

  /** @internal */
  accept(from: string, message: VaultSyncMessage, options?: VaultSendOptions): void {
    if (this.drop?.(from, message, options)) {
      this.sent += 1;
      return;
    }
    const copy = this.#opts.roundTrip === false ? message : decodeVaultMessage(encodeVaultMessage(message));
    if (!copy) throw new Error('訊息編碼後解不回來');
    const index = this.#log.length;
    this.#log.push(copy);
    this.#senders.push(from);
    this.#options.push(this.targeted ? options : undefined);
    this.sent += 1;
    for (const t of this.#transports.values()) {
      if (t.device === from || !t.online || !this.#addressed(index, t.device)) continue;
      this.#schedule(t, index);
      if (this.#random() < (this.#opts.duplicateRate ?? 0)) this.#schedule(t, index);
    }
  }

  /** @internal */
  replay(t: FakeTransport): void {
    for (let i = 0; i < this.#log.length; i += 1) {
      if (this.#senders[i] === t.device || t.delivered.has(i) || !this.#addressed(i, t.device)) continue;
      this.#schedule(t, i);
    }
  }

  #schedule(t: FakeTransport, index: number): void {
    this.inflight += 1;
    const delay = Math.floor(this.#random() * (this.#opts.maxDelayMs ?? 0));
    this.#clock.setTimeout(() => {
      this.inflight -= 1;
      if (!t.online) return; // 斷線了：之後重新上線會補送
      t.delivered.add(index);
      if (this.trust && !this.trust(t.device, this.#senders[index]!)) return;
      let message = this.#log[index]!;
      if (message.type === 'node' && message.content && this.#options[index]?.omitContentFor?.includes(t.device)) {
        const { content: _content, ...meta } = message;
        message = meta;
      }
      const stats = this.received.get(t.device) ?? { messages: 0, bytes: 0 };
      stats.messages += 1;
      stats.bytes += encodedVaultMessageLength(message);
      this.received.set(t.device, stats);
      t.deliver(message);
    }, delay);
  }

  #addressed(index: number, device: string): boolean {
    const to = this.#options[index]?.to;
    return to === undefined || to.includes(device);
  }
}

export class FakeTransport implements VaultSyncTransport {
  readonly delivered = new Set<number>();
  readonly #hub: FakeHub;
  readonly device: string;
  online: boolean;
  readonly #messageListeners = new Set<(m: VaultSyncMessage) => void>();
  readonly #statusListeners = new Set<(online: boolean) => void>();

  constructor(hub: FakeHub, device: string, online: boolean) {
    this.#hub = hub;
    this.device = device;
    this.online = online;
  }

  get targeted(): boolean {
    return this.#hub.targeted;
  }

  recipients(): string[] {
    return this.#hub.others(this.device);
  }

  async send(message: VaultSyncMessage, options?: VaultSendOptions): Promise<void> {
    if (!this.online) throw new Error('offline');
    this.#hub.accept(this.device, message, options);
  }

  onMessage(listener: (m: VaultSyncMessage) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onStatusChange(listener: (online: boolean) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  isOnline(): boolean {
    return this.online;
  }

  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    if (online) this.#hub.replay(this);
    for (const l of this.#statusListeners) l(online);
  }

  /** @internal */
  deliver(message: VaultSyncMessage): void {
    for (const l of this.#messageListeners) l(message);
  }
}

export interface Device {
  name: string;
  vault: MemoryVault;
  store: MemorySyncStateStore;
  transport: FakeTransport;
  sync: VaultSyncCoordinator;
  /** 協調器回報的錯誤（context: error） */
  errors: string[];
  /** 停掉協調器、用同一份狀態與 Vault 重新啟動 */
  restart(): Promise<void>;
  /** 使用者改了檔案並通知協調器 */
  edit(path: string, content: string | Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}


/**
 * 假的 P2P 網路（SDK ADR 0026 測試用）：每一對裝置一條記憶體通道，非同步送達。
 * 預設兩台都在線（假中繼的 `online`）才連得上；`reachable` 可以改規則（例如永遠打不通）。
 */
export class FakePeerMesh {
  readonly #clock: ManualClock;
  readonly #online = new Map<string, () => boolean>();
  readonly #incoming = new Map<string, Set<(device: string, channel: ByteChannel) => void>>();
  readonly #channels = new Map<string, { a: MeshSide; b: MeshSide }>();
  mode: 'p2p-webrtc' | 'relayed-websocket' = 'p2p-webrtc';
  reachable: (from: string, to: string) => boolean = (from, to) => (this.#online.get(from)?.() ?? false) && (this.#online.get(to)?.() ?? false);
  opened = 0;
  bytes = 0;
  /** 每個方向送了多少位元組（`a->b`） */
  readonly traffic = new Map<string, number>();

  constructor(clock: ManualClock) {
    this.#clock = clock;
  }

  get clock(): ManualClock {
    return this.#clock;
  }

  link(device: string, online: () => boolean): VaultPeerLink {
    this.#online.set(device, online);
    return {
      devices: () => [...this.#online.keys()],
      open: async (target, opts) => {
        if (opts?.fresh) this.#dropPair(device, target);
        return this.#open(device, target);
      },
      onIncoming: (listener) => {
        let set = this.#incoming.get(device);
        if (!set) this.#incoming.set(device, (set = new Set()));
        set.add(listener);
        return () => set.delete(listener);
      },
    };
  }

  /** 斷掉某台裝置的所有通道（例如它離線了） */
  drop(device: string): void {
    for (const [key, pair] of this.#channels) {
      if (pair.a.device !== device && pair.b.device !== device) continue;
      this.#channels.delete(key);
      pair.a.close();
      pair.b.close();
    }
  }

  #dropPair(x: string, y: string): void {
    const key = [x, y].sort().join('|');
    const pair = this.#channels.get(key);
    if (!pair) return;
    this.#channels.delete(key);
    pair.a.close();
  }

  #open(from: string, to: string): ByteChannel | null {
    if (from === to || !this.reachable(from, to)) return null;
    const key = [from, to].sort().join('|');
    const existing = this.#channels.get(key);
    if (existing && !existing.a.closed) return existing.a.device === from ? existing.a.channel : existing.b.channel;
    const a = new MeshSide(from, this.mode, this);
    const b = new MeshSide(to, this.mode, this);
    a.other = b;
    b.other = a;
    this.#channels.set(key, { a, b });
    this.opened += 1;
    // 對方那端：像 PeerNode 的 onPeer 一樣通知
    for (const listener of this.#incoming.get(to) ?? []) listener(from, b.channel);
    return a.channel;
  }
}

class MeshSide {
  other!: MeshSide;
  closed = false;
  readonly listeners = new Set<(d: Uint8Array) => void>();
  readonly closers = new Set<() => void>();
  readonly channel: ByteChannel;

  constructor(
    readonly device: string,
    mode: 'p2p-webrtc' | 'relayed-websocket',
    mesh: FakePeerMesh,
  ) {
    // 對方看到的公鑰：用裝置名稱代替
    const self = this;
    this.channel = {
      get peerPublicKey() {
        return self.other.device;
      },
      mode,
      async send(data) {
        if (self.closed) throw new Error('通道已關閉');
        mesh.bytes += data.length;
        const dir = `${self.device}->${self.other.device}`;
        mesh.traffic.set(dir, (mesh.traffic.get(dir) ?? 0) + data.length);
        const copy = data.slice();
        queueMicrotask(() => {
          if (!self.other.closed) for (const l of self.other.listeners) l(copy);
        });
      },
      onMessage(listener) {
        self.listeners.add(listener);
        return () => self.listeners.delete(listener);
      },
      onClose(listener) {
        self.closers.add(listener);
        return () => self.closers.delete(listener);
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.closers) c();
    this.other.close();
  }
}

export interface NetOptions extends HubOptions {
  seed?: number;
  options?: Partial<VaultSyncOptions>;
  /** 裝置之間有 P2P（假網路）；協調器會拿到 `peers` */
  p2p?: boolean;
  /** MemoryVault 支援串流讀寫 */
  streaming?: boolean;
  /** 協調器自己的寫入也觸發事件、防抖這麼多毫秒後通知（像 Obsidian＋CinderSync；SDK ADR 0048） */
  echoMs?: number;
}

export class Net {
  readonly clock = new ManualClock();
  readonly hub: FakeHub;
  readonly devices: Device[] = [];
  readonly #seed: number;
  readonly #options: Partial<VaultSyncOptions>;
  readonly mesh: FakePeerMesh | undefined;
  readonly #streaming: boolean;
  readonly #echoMs: number | undefined;

  constructor(opts: NetOptions = {}) {
    this.#echoMs = opts.echoMs;
    this.#seed = opts.seed ?? 1;
    this.hub = new FakeHub(this.clock, { ...opts, random: opts.random ?? rng(this.#seed * 7919) });
    this.#options = opts.options ?? {};
    if (opts.p2p) this.mesh = new FakePeerMesh(this.clock);
    this.#streaming = opts.streaming ?? false;
  }

  async add(name: string, opts: { online?: boolean; vault?: MemoryVault; options?: Partial<VaultSyncOptions> } = {}): Promise<Device> {
    const vault = opts.vault ?? new MemoryVault({ streaming: this.#streaming });
    const store = new MemorySyncStateStore();
    const transport = this.hub.transport(name, opts.online ?? true);
    const peers = this.mesh?.link(name, () => transport.online);
    // 收方的大檔暫存：像持久化的一樣，重開協調器後還在
    const staging = new MemoryStreamingStore();
    const ids = hexIds(rng(this.#seed * 1000 + this.devices.length + 17));
    const errors: string[] = [];
    const make = () => {
      const sync = new VaultSyncCoordinator({
        adapter: vault,
        store,
        transport,
        deviceId: name,
        deviceLabel: name.toUpperCase(),
        clock: this.clock,
        randomId: ids,
        tickMs: 0,
        ...(peers ? { peers, staging } : {}),
        ...this.#options,
        ...opts.options,
      });
      sync.on('error', ({ context, error }) => errors.push(`${context}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
      return sync;
    };
    const device: Device = {
      name,
      vault,
      store,
      transport,
      sync: make(),
      errors,
      restart: async () => {
        await device.sync.stop();
        device.sync = make();
        await device.sync.start();
      },
      edit: async (path, content) => {
        const existed = vault.files.has(path);
        vault.userWrite(path, content);
        await device.sync.notifyLocalChange(path, existed ? 'modify' : 'create');
      },
      remove: async (path) => {
        vault.userRemove(path);
        await device.sync.notifyLocalChange(path, 'delete');
      },
      rename: async (from, to) => {
        vault.userRename(from, to);
        await device.sync.notifyLocalChange(to, 'rename', from);
      },
    };
    if (this.#echoMs !== undefined) vault.watch(this.clock, (path, kind, oldPath) => void device.sync.notifyLocalChange(path, kind, oldPath), this.#echoMs);
    this.devices.push(device);
    await device.sync.start();
    return device;
  }

  /** 讓所有投遞、重試都跑完，直到沒有事情可做 */
  async settle(maxSteps = 100_000): Promise<void> {
    for (let step = 0; step < maxSteps; step += 1) {
      await flush();
      for (const d of this.devices) await d.sync.idle();
      await flush();
      const next = this.clock.nextAt();
      if (next === undefined) {
        const busy = this.devices.some((d) => d.transport.online && d.sync.status().queue > 0);
        if (!busy) return;
        continue;
      }
      await this.clock.advanceTo(next);
    }
    throw new Error('settle：一直沒有停下來');
  }

  trees(): Record<string, string>[] {
    return this.devices.map((d) => d.vault.tree());
  }
}
