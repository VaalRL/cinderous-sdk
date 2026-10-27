// `PeerNode`：一個身分一個節點，`connectPeer(對方公鑰)` 拿到一條加密通道（SDK ADR 0009；PRD 2.3、5.2 場景 A）。
//
// - 信令：Cinderous 的 kind 21000 NIP-59（`protocol/signaling`），只訂閱 `#p` 是自己的。
// - 先試 WebRTC DataChannel；8 秒內沒開或 ICE failed，就改走中繼（kind 20079，每框一次 NIP-59）。
// - 降級不需要新的信令類型：中繼框一到，接收端就把它交給對方的中繼通道。
import { base64 } from '@scure/base';

import type { Identity } from '../identity.js';
import { CandidateBatch, type IceCandidateData, parseSignal, SDP_SIGNAL_KIND, type Signal } from '../protocol/signaling.js';
import type { NostrEvent } from '../protocol/event.js';
import { reportPublishRejections, type PublishRejectionReport } from '../publish-rejections.js';
import { DEFAULT_RELAY_EVENTS_PER_MINUTE, publishPaced, RelayEventBudget, sharedRelayEventBudget } from '../relay-budget.js';
import type { RelayTransport, Subscription } from '../relay-pool.js';
import {
  encodeFrames,
  FRAME_PAYLOAD_BYTES,
  FrameAssembler,
  type FrameAssemblerOptions,
  RELAY_FRAME_PAYLOAD_BYTES,
} from './frames.js';
import { defaultRtcFactory, type RtcDataChannelLike, type RtcFactory, type RtcPeerConnectionLike } from './rtc.js';

/** 中繼軌的框（PRD 2.3）：ephemeral，中繼只轉發不存。 */
export const RELAY_FRAME_KIND = 20079;
/** 打洞逾時（PRD 2.3）：超過就改走中繼。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
/**
 * 中繼軌每分鐘最多幾框（SDK ADR 0043）：SDK 中繼以認證身分計數、每把公鑰每分鐘 120 則事件（ephemeral 也算），
 * 而同一身分的信令、名單同步、Vault 同步都落在同一個桶——所以預設 100（每框 48,000 B ⇒ 約每秒 80 KB），
 * 而且沒指定 `relayFramesPerMinute` 時與同一身分的其他元件共用 {@link sharedRelayEventBudget}。v0.34 以前是 200，會撞上限。
 */
export const DEFAULT_RELAY_FRAMES_PER_MINUTE = DEFAULT_RELAY_EVENTS_PER_MINUTE;
/** 走中繼時，超過這個大小建議提示使用者（PRD 2.3）。 */
export const LARGE_PAYLOAD_WARNING_BYTES = 20 * 1024 * 1024;
/** DataChannel 緩衝超過這麼多就先等一下再送，避免瀏覽器把整個檔案堆在記憶體裡。 */
const DATA_CHANNEL_HIGH_WATER = 4 * 1024 * 1024;
/** ICE 候選收集後等這麼久再一次送出（Cinderous A6 批次）。 */
const CANDIDATE_FLUSH_MS = 20;
/** 還沒人聽的訊息最多先收著幾則。 */
const MAX_BUFFERED_MESSAGES = 1_000;
const SEEN_EVENT_MEMORY = 4_096;

export type TransportMode = 'p2p-webrtc' | 'relayed-websocket';

/** PRD 2.3 的 `IDataChannelTransport`，外加關閉通知與大檔提示。 */
export interface PeerChannel {
  readonly mode: TransportMode;
  readonly peerPublicKey: string;
  /** 恆為 true：P2P 軌靠 DTLS，中繼軌靠 NIP-59 */
  readonly isEncrypted: true;
  readonly closed: boolean;
  send(data: Uint8Array): Promise<void>;
  /** 註冊前就到的訊息會在註冊當下交出 */
  onMessage(listener: (data: Uint8Array) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
  /** 走中繼且資料超過 20 MB：建議 App 提示使用者（連同一個 Wi-Fi 才能 P2P） */
  needsLargePayloadWarning(bytes: number): boolean;
}

export interface PeerNodeOptions {
  identity: Identity;
  transport: RelayTransport;
  /** 預設用全域 `RTCPeerConnection`；null＝不試 P2P，一律走中繼 */
  rtc?: RtcFactory | null;
  /** STUN／TURN；可以是函式，每條新連線取當下的值（例如 `TurnProvider.iceServers`，SDK ADR 0017） */
  iceServers?: unknown[] | (() => unknown[]);
  connectTimeoutMs?: number;
  /**
   * 中繼軌（框與信令）每分鐘最多幾則。指定了就用這個節點自己的預算（呼叫端自己負責與同一身分的其他元件分配）；
   * 省略＝與同一身分共用的 {@link sharedRelayEventBudget}（預設 {@link DEFAULT_RELAY_FRAMES_PER_MINUTE}）。
   */
  relayFramesPerMinute?: number;
  /** 直接指定預算（例如幾個元件共用一個自己建立的 `RelayEventBudget`）；優先於 `relayFramesPerMinute` */
  relayBudget?: RelayEventBudget;
  /**
   * 中繼的 NIP-11 文件（一份或多份）：有 `cinder_max_events_per_minute` 就自動取「宣告值 × 0.8」與目前速率的較小者
   *（SDK ADR 0043）。之後才拿到文件可以呼叫 `applyRelayInfo`。
   */
  relayInfo?: unknown;
  /** 誰可以找上門；預設所有人 */
  acceptFrom?: (pubkey: string) => boolean;
  assembler?: FrameAssemblerOptions;
  /**
   * 中繼軌的框有中繼拒收時回報（SDK ADR 0038 P0-C）。一框照舊以「至少一座收下」為送出；
   * 這裡讓應用看得到部分拒收（例如某一座限速或滿了）。
   */
  onPublishRejected?: (report: PublishRejectionReport) => void;
  /** 測試用 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Channel implements PeerChannel {
  readonly isEncrypted = true as const;
  #closed = false;
  readonly #messageListeners = new Set<(data: Uint8Array) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #buffered: Uint8Array[] = [];
  readonly #assembler: FrameAssembler;

  constructor(
    readonly mode: TransportMode,
    readonly peerPublicKey: string,
    private readonly sendFrame: (frame: Uint8Array) => Promise<void>,
    private readonly onCloseRequested: () => void,
    assembler: FrameAssemblerOptions | undefined,
  ) {
    this.#assembler = new FrameAssembler(assembler);
  }

  get closed(): boolean {
    return this.#closed;
  }

  async send(data: Uint8Array): Promise<void> {
    const payloadBytes = this.mode === 'p2p-webrtc' ? FRAME_PAYLOAD_BYTES : RELAY_FRAME_PAYLOAD_BYTES;
    for (const frame of encodeFrames(data, payloadBytes)) {
      if (this.#closed) throw new Error('通道已關閉');
      await this.sendFrame(frame);
    }
  }

  receiveFrame(frame: Uint8Array): void {
    if (this.#closed) return;
    const message = this.#assembler.push(frame);
    if (message === undefined) return;
    if (this.#messageListeners.size === 0) {
      if (this.#buffered.length < MAX_BUFFERED_MESSAGES) this.#buffered.push(message);
      return;
    }
    for (const listener of this.#messageListeners) listener(message);
  }

  onMessage(listener: (data: Uint8Array) => void): () => void {
    this.#messageListeners.add(listener);
    for (const message of this.#buffered.splice(0)) listener(message);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.onCloseRequested();
    this.markClosed();
  }

  markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }

  needsLargePayloadWarning(bytes: number): boolean {
    return this.mode === 'relayed-websocket' && bytes > LARGE_PAYLOAD_WARNING_BYTES;
  }
}

interface Session {
  readonly peer: string;
  /** 是我們呼叫 connectPeer 開的（決定要不要交給 onPeer） */
  initiatedByUs: boolean;
  role: 'offerer' | 'answerer' | 'relay';
  pc?: RtcPeerConnectionLike;
  remoteSet: boolean;
  pendingCandidates: IceCandidateData[];
  batch: CandidateBatch;
  flushTimer?: ReturnType<typeof setTimeout>;
  connectTimer?: ReturnType<typeof setTimeout>;
  channel?: Channel;
  waiters: ((channel: Channel) => void)[];
}

export class PeerNode {
  readonly #identity: Identity;
  readonly #transport: RelayTransport;
  readonly #rtc: RtcFactory | null;
  readonly #iceServers: unknown[] | (() => unknown[]) | undefined;
  readonly #connectTimeoutMs: number;
  readonly #budget: RelayEventBudget;
  readonly #acceptFrom: (pubkey: string) => boolean;
  readonly #assemblerOptions: FrameAssemblerOptions | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #onPublishRejected: ((report: PublishRejectionReport) => void) | undefined;
  readonly #sessions = new Map<string, Session>();
  readonly #peerListeners = new Set<(channel: PeerChannel) => void>();
  readonly #seen = new Set<string>();
  readonly #subscription: Subscription;
  #closed = false;

  constructor(opts: PeerNodeOptions) {
    this.#identity = opts.identity;
    this.#transport = opts.transport;
    this.#rtc = opts.rtc === undefined ? defaultRtcFactory() : opts.rtc;
    this.#iceServers = opts.iceServers;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#acceptFrom = opts.acceptFrom ?? (() => true);
    this.#assemblerOptions = opts.assembler;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#onPublishRejected = opts.onPublishRejected;
    this.#now = opts.now ?? Date.now;
    this.#budget =
      opts.relayBudget ??
      (opts.relayFramesPerMinute !== undefined
        ? new RelayEventBudget({ perMinute: opts.relayFramesPerMinute, now: this.#now, sleep: this.#sleep })
        : sharedRelayEventBudget(this.#identity.pubkey));
    if (opts.relayInfo !== undefined) this.#budget.applyRelayInfo(opts.relayInfo);
    this.#subscription = this.#transport.subscribe(
      [{ kinds: [SDP_SIGNAL_KIND, RELAY_FRAME_KIND], '#p': [this.#identity.pubkey] }],
      { onEvent: (event) => this.#onEvent(event as NostrEvent) },
    );
  }

  /** 有人找上門（對方呼叫 connectPeer）時通知；回傳取消函式 */
  onPeer(listener: (channel: PeerChannel) => void): () => void {
    this.#peerListeners.add(listener);
    return () => this.#peerListeners.delete(listener);
  }

  /** 連到對方：先試 P2P，打不通就改走中繼。已經有開著的通道就直接回傳它。 */
  async connectPeer(pubkey: string): Promise<PeerChannel> {
    if (this.#closed) throw new Error('PeerNode 已關閉');
    if (pubkey === this.#identity.pubkey) throw new Error('不能連到自己');
    const existing = this.#sessions.get(pubkey);
    if (existing) {
      existing.initiatedByUs = true;
      if (existing.channel && !existing.channel.closed) return existing.channel;
      if (!existing.channel) return new Promise((resolve) => existing.waiters.push(resolve));
      this.#sessions.delete(pubkey);
    }

    const session = this.#newSession(pubkey, true);
    const settled = new Promise<Channel>((resolve) => session.waiters.push(resolve));
    if (!this.#rtc) {
      this.#settleRelayed(session);
      return settled;
    }
    session.role = 'offerer';
    const pc = this.#createPc(session);
    this.#wireDataChannel(session, pc.createDataChannel('cinderous', { ordered: true }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.#startTimer(session);
    await this.#sendSignal(pubkey, { type: 'offer', sdp: offer.sdp ?? '' });
    return settled;
  }

  /** 關掉節點：退訂、關掉所有通道 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscription.close();
    for (const session of this.#sessions.values()) this.#teardown(session);
    this.#sessions.clear();
  }

  #newSession(peer: string, initiatedByUs: boolean): Session {
    const session: Session = {
      peer,
      initiatedByUs,
      role: 'relay',
      remoteSet: false,
      pendingCandidates: [],
      batch: new CandidateBatch(),
      waiters: [],
    };
    this.#sessions.set(peer, session);
    return session;
  }

  #createPc(session: Session): RtcPeerConnectionLike {
    const servers = typeof this.#iceServers === 'function' ? this.#iceServers() : this.#iceServers;
    const pc = this.#rtc!(servers ? { iceServers: servers } : {});
    session.pc = pc;
    pc.onicecandidate = (event) => {
      if (session.pc !== pc) return;
      if (event.candidate) {
        const data: IceCandidateData = { candidate: event.candidate.candidate };
        if (typeof event.candidate.sdpMid === 'string') data.sdpMid = event.candidate.sdpMid;
        if (typeof event.candidate.sdpMLineIndex === 'number') data.sdpMLineIndex = event.candidate.sdpMLineIndex;
        session.batch.add(data);
        if (!session.flushTimer) session.flushTimer = setTimeout(() => this.#flushCandidates(session), CANDIDATE_FLUSH_MS);
      } else {
        this.#flushCandidates(session);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (session.pc === pc && pc.iceConnectionState === 'failed') this.#settleRelayed(session);
    };
    pc.ondatachannel = (event) => {
      if (session.pc === pc) this.#wireDataChannel(session, event.channel);
    };
    return pc;
  }

  #wireDataChannel(session: Session, dc: RtcDataChannelLike): void {
    dc.binaryType = 'arraybuffer';
    let channel: Channel | undefined;
    const open = () => {
      if (session.channel) return;
      channel = new Channel(
        'p2p-webrtc',
        session.peer,
        async (frame) => {
          while (dc.bufferedAmount > DATA_CHANNEL_HIGH_WATER) await this.#sleep(10);
          dc.send(frame);
        },
        () => this.#teardown(session),
        this.#assemblerOptions,
      );
      this.#settle(session, channel);
    };
    dc.onopen = open;
    dc.onmessage = (event) => {
      const data = event.data;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : undefined;
      if (bytes) session.channel?.receiveFrame(bytes);
    };
    dc.onclose = () => {
      if (channel && session.channel === channel) {
        channel.markClosed();
        if (this.#sessions.get(session.peer) === session) this.#sessions.delete(session.peer);
      }
    };
    if (dc.readyState === 'open') open();
  }

  #startTimer(session: Session): void {
    clearTimeout(session.connectTimer);
    session.connectTimer = setTimeout(() => this.#settleRelayed(session), this.#connectTimeoutMs);
  }

  /** 放棄 P2P、改走中繼 */
  #settleRelayed(session: Session): void {
    if (session.channel) return;
    this.#closePc(session);
    session.role = 'relay';
    const channel = new Channel(
      'relayed-websocket',
      session.peer,
      (frame) => this.#sendRelayFrame(session.peer, frame),
      () => this.#teardown(session),
      this.#assemblerOptions,
    );
    this.#settle(session, channel);
  }

  #settle(session: Session, channel: Channel): void {
    if (session.channel) return;
    clearTimeout(session.connectTimer);
    session.channel = channel;
    for (const resolve of session.waiters.splice(0)) resolve(channel);
    if (!session.initiatedByUs) for (const listener of this.#peerListeners) listener(channel);
  }

  #closePc(session: Session): void {
    clearTimeout(session.flushTimer);
    clearTimeout(session.connectTimer);
    const pc = session.pc;
    session.pc = undefined;
    if (pc) {
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.ondatachannel = null;
      pc.close();
    }
  }

  #teardown(session: Session): void {
    this.#closePc(session);
    session.channel?.markClosed();
    if (this.#sessions.get(session.peer) === session) this.#sessions.delete(session.peer);
  }

  #flushCandidates(session: Session): void {
    clearTimeout(session.flushTimer);
    session.flushTimer = undefined;
    const signal = session.batch.drain();
    if (signal) void this.#sendSignal(session.peer, signal).catch(() => {});
  }

  async #sendSignal(peer: string, signal: Signal): Promise<void> {
    // 信令也算進同一個桶（SDK ADR 0043），但不重送：ICE 候選過時了重送也沒用。等到預算才封裝（時間戳是送出的時間）
    await publishPaced(
      this.#budget,
      () =>
        this.#transport.publish(
          this.#identity.sealAndWrap(
            { kind: SDP_SIGNAL_KIND, created_at: Math.floor(this.#now() / 1000), tags: [], content: JSON.stringify(signal) },
            peer,
            { kind: SDP_SIGNAL_KIND, tags: [['p', peer]] },
          ),
        ),
      { retries: 0 },
    );
  }

  /** 依中繼的 NIP-11 調整中繼軌速率（SDK ADR 0043）；共用預算時同一身分的其他元件也跟著調。回傳新的每分鐘則數 */
  applyRelayInfo(nip11: unknown): number {
    return this.#budget.applyRelayInfo(nip11);
  }

  /** 中繼軌目前每分鐘幾則 */
  get relayFramesPerMinute(): number {
    return this.#budget.perMinute;
  }

  async #sendRelayFrame(peer: string, frame: Uint8Array): Promise<void> {
    // 滑動一分鐘的預算；中繼回 `rate-limited:` 就整個預算退避到計數窗結束、重送這一框（SDK ADR 0043）
    // 等到預算才封裝（可能等了一分鐘）；重送用同一顆（被拒的不留在中繼的重放快取）
    let event: NostrEvent | undefined;
    const result = await publishPaced(
      this.#budget,
      () => {
        event ??= this.#identity.sealAndWrap(
          { kind: RELAY_FRAME_KIND, created_at: Math.floor(this.#now() / 1000), tags: [], content: base64.encode(frame) },
          peer,
          { kind: RELAY_FRAME_KIND, tags: [['p', peer]] },
        );
        return this.#transport.publish(event);
      },
      // 每一次嘗試的拒收都回報（含之後重送成功的限速拒收；SDK ADR 0038 P0-C）
      { onAttempt: (r) => reportPublishRejections(event!.id, r, this.#onPublishRejected) },
    );
    if (result.accepted.length === 0) {
      const reasons = result.rejected.map((r) => `${r.url}：${r.reason}`).join('；');
      throw new Error(`沒有任何中繼收下這一框${reasons ? `（${reasons}）` : ''}`);
    }
  }

  #onEvent(event: NostrEvent): void {
    if (this.#closed || (event.kind !== SDP_SIGNAL_KIND && event.kind !== RELAY_FRAME_KIND)) return;
    if (this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    if (this.#seen.size > SEEN_EVENT_MEMORY) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }

    let sender: string;
    let content: string;
    try {
      const opened = this.#identity.openWrap(event);
      if (opened.rumor.kind !== event.kind) return;
      sender = opened.sender;
      content = opened.rumor.content;
    } catch {
      return; // 不是給我的、壞掉的、偽造的
    }
    if (sender === this.#identity.pubkey || !this.#acceptFrom(sender)) return;

    if (event.kind === RELAY_FRAME_KIND) {
      let frame: Uint8Array;
      try {
        frame = base64.decode(content);
      } catch {
        return;
      }
      this.#onRelayFrame(sender, frame);
      return;
    }
    let signal: Signal;
    try {
      signal = parseSignal(content);
    } catch {
      return;
    }
    void this.#onSignal(sender, signal).catch(() => {});
  }

  #onRelayFrame(sender: string, frame: Uint8Array): void {
    let session = this.#sessions.get(sender);
    if (session?.channel?.closed) {
      this.#sessions.delete(sender);
      session = undefined;
    }
    if (!session) session = this.#newSession(sender, false);
    // 對方已經先改走中繼了：我們這邊也不用再等 P2P
    if (!session.channel) this.#settleRelayed(session);
    session.channel!.receiveFrame(frame);
  }

  async #onSignal(sender: string, signal: Signal): Promise<void> {
    if (!this.#rtc) return; // 沒有 WebRTC：不回應，對方逾時後自然改走中繼
    let session = this.#sessions.get(sender);

    if (signal.type === 'offer') {
      if (session && !session.channel && session.role === 'offerer') {
        // 雙方同時呼叫（glare）：公鑰較小的一方讓步，改當回應方；較大的一方不理對方的 offer
        if (this.#identity.pubkey > sender) return;
        this.#closePc(session);
        session.remoteSet = false;
        session.pendingCandidates = [];
      } else if (session && !session.channel) {
        return; // 已經在回應這個人了
      } else {
        if (session) this.#teardown(session); // 對方重新連線：舊的通道作廢
        session = this.#newSession(sender, false);
      }
      session.role = 'answerer';
      const pc = this.#createPc(session);
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      this.#remoteReady(session, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.#startTimer(session);
      await this.#sendSignal(sender, { type: 'answer', sdp: answer.sdp ?? '' });
      return;
    }

    if (!session?.pc || session.channel) return;
    const pc = session.pc;
    if (signal.type === 'answer') {
      if (session.role !== 'offerer' || session.remoteSet) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      this.#remoteReady(session, pc);
      return;
    }
    if (signal.type !== 'candidate' && signal.type !== 'candidates') return;
    const candidates = signal.type === 'candidate' ? [signal] : signal.candidates;
    for (const candidate of candidates) {
      const data: IceCandidateData = { candidate: candidate.candidate };
      if (candidate.sdpMid !== undefined) data.sdpMid = candidate.sdpMid;
      if (candidate.sdpMLineIndex !== undefined) data.sdpMLineIndex = candidate.sdpMLineIndex;
      if (session.remoteSet) await pc.addIceCandidate(data).catch(() => {});
      else session.pendingCandidates.push(data);
    }
  }

  #remoteReady(session: Session, pc: RtcPeerConnectionLike): void {
    if (session.pc !== pc) return;
    session.remoteSet = true;
    for (const candidate of session.pendingCandidates.splice(0)) void pc.addIceCandidate(candidate).catch(() => {});
  }
}
