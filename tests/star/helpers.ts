// 星狀會話測試用：記憶體裡的成對通道（模擬 secureChannel 的介面），可以加延遲、亂序、掉包、重複、卡住。
import { Identity } from '../../src/identity.js';
import type { TransportMode } from '../../src/peer/peer-node.js';
import { StarHost, type StarHostOptions, type StarMessage } from '../../src/star/host.js';
import type { LinkTuning, StarChannel } from '../../src/star/link.js';
import { StarMember, type StarMemberEvent, type StarMemberOptions } from '../../src/star/member.js';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const text = (s: string) => new TextEncoder().encode(s);
export const read = (b: Uint8Array) => new TextDecoder().decode(b);

/** 固定種子的亂數（mulberry32） */
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

export interface WireBehaviour {
  mode?: TransportMode;
  /** 每則的延遲（毫秒）；給亂數就會亂序 */
  delayMs?: () => number;
  drop?: () => boolean;
  duplicate?: () => boolean;
}

export class MemChannel implements StarChannel {
  readonly engineType = 'double-ratchet' as const;
  readonly postQuantum = false;
  closed = false;
  peer!: MemChannel;
  /** 卡住：send 不會完成，直到 `unstall()` */
  stalled = false;
  /** 靜默：送出的全部丟掉（模擬對方當機，但通道沒關） */
  silent = false;
  sentBytes = 0;
  sentMessages = 0;
  readonly #listeners = new Set<(data: Uint8Array) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #buffered: Uint8Array[] = [];
  #waiters: (() => void)[] = [];

  constructor(
    readonly peerPublicKey: string,
    readonly mode: TransportMode,
    private readonly behaviour: WireBehaviour,
  ) {}

  async send(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('通道已關閉');
    while (this.stalled) await new Promise<void>((resolve) => this.#waiters.push(resolve));
    if (this.closed) throw new Error('通道已關閉');
    this.sentBytes += data.length;
    this.sentMessages += 1;
    if (this.silent || this.behaviour.drop?.()) return;
    const copy = data.slice();
    const delay = this.behaviour.delayMs?.() ?? 0;
    setTimeout(() => this.peer.receive(copy), delay);
    if (this.behaviour.duplicate?.()) setTimeout(() => this.peer.receive(copy.slice()), delay + 1);
  }

  unstall(): void {
    this.stalled = false;
    for (const w of this.#waiters.splice(0)) w();
  }

  /** 測試直接把原始位元組塞到對方（繞過鏈路，模擬惡意成員） */
  inject(data: Uint8Array): void {
    setTimeout(() => this.peer.receive(data.slice()), 0);
  }

  receive(data: Uint8Array): void {
    if (this.closed) return;
    if (this.#listeners.size === 0) {
      this.#buffered.push(data);
      return;
    }
    for (const l of this.#listeners) l(data);
  }

  onMessage(listener: (data: Uint8Array) => void): () => void {
    this.#listeners.add(listener);
    for (const d of this.#buffered.splice(0)) listener(d);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unstall();
    for (const l of [...this.#closeListeners]) l();
    // P2P：DataChannel 關了兩邊都知道；中繼軌：對方不會收到任何通知（只能靠心跳）
    if (this.mode === 'p2p-webrtc') setTimeout(() => this.peer.close(), 0);
  }
}

/** 一對記憶體通道：`[Host 那端, 成員那端]` */
export function memPair(hostPk: string, memberPk: string, behaviour: WireBehaviour = {}): [MemChannel, MemChannel] {
  const mode = behaviour.mode ?? 'p2p-webrtc';
  const hostSide = new MemChannel(memberPk, mode, behaviour);
  const memberSide = new MemChannel(hostPk, mode, behaviour);
  hostSide.peer = memberSide;
  memberSide.peer = hostSide;
  return [hostSide, memberSide];
}

export const FAST: Partial<LinkTuning> = { batchWindowMs: 1 };

export interface Joined {
  member: StarMember;
  pubkey: string;
  hostSide: MemChannel;
  memberSide: MemChannel;
  messages: StarMessage[];
  events: StarMemberEvent[];
}

export function makeHost(opts: Partial<StarHostOptions> = {}): StarHost {
  return new StarHost({ identity: Identity.generate(), tuning: FAST, ...opts });
}

export async function joinMember(
  host: StarHost,
  opts: { behaviour?: WireBehaviour; member?: Partial<StarMemberOptions>; invite?: string; pubkey?: string; label?: string } = {},
): Promise<Joined> {
  const pubkey = opts.pubkey ?? Identity.generate().pubkey;
  const [hostSide, memberSide] = memPair(host.hostPubkey, pubkey, opts.behaviour);
  host.attach(hostSide);
  const invite = opts.invite ?? host.createInvite({ relays: ['wss://relay.example'] }).uri;
  const member = await StarMember.over(memberSide, { invite, tuning: FAST, ...(opts.label ? { label: opts.label } : {}), ...(opts.member ?? {}) });
  const joined: Joined = { member, pubkey, hostSide, memberSide, messages: [], events: [] };
  member.onMessage((m) => joined.messages.push(m));
  member.onEvent((e) => joined.events.push(e));
  return joined;
}

/** 等條件成立（輪詢），逾時丟例外 */
export async function until(cond: () => boolean, timeoutMs = 3_000, what = '條件'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等不到${what}`);
    await sleep(5);
  }
}
