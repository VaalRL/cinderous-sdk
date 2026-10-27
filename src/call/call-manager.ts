// 音訊／視訊通話執行期（SDK ADR 0016）：把 `protocol/call` 的 `CallSession` 狀態機接上 WebRTC 與 getUserMedia。
//
// 做法照 Cinderous engine 的 `WebRtcCall`（同一套信令、同一組經驗），差別在：
// - 自己訂閱 kind 21002（`#p` 是自己），私鑰不離開 `Identity`；
// - WebRTC 與 getUserMedia 都可注入（瀏覽器預設取全域）；
// - 事件以 `onXxx(listener)` 註冊。
//
// 帶過來的經驗（Cinderous ADR 編號）：
// - 0338：一律預先協商視訊 transceiver，通話中切換只要 `replaceTrack`，不必重新協商；
//   答方要把自動建立的 recvonly 改成 sendrecv；開視訊失敗就回滾、不先通知對方。
// - 0337：視訊用畫質檔位的限制，不是裸 `true`（手機預設常是 720p 以上）。
// - 0243：連線失敗分「從未打通」與「連上後斷線」。
// - 相機一定真的 `stop()`：指示燈要誠實。
import type { Identity } from '../identity.js';
import type { NostrEvent } from '../protocol/event.js';
import {
  CALL_SIGNAL_KIND,
  type CallAction,
  type CallEndReason,
  type CallFailureReason,
  type CallMedia,
  CallSession,
  type CallSignal,
  type CallState,
  parseCallSignal,
} from '../protocol/call.js';
import { DEFAULT_VIDEO_QUALITY, type VideoQuality, videoConstraints, videoProfile } from '../protocol/video-quality.js';
import type { RelayTransport, Subscription } from '../relay-pool.js';
import {
  type CallPeerConnectionLike,
  type CallRtcFactory,
  defaultCallRtc,
  defaultGetUserMedia,
  type GetUserMedia,
  type MediaStreamLike,
  type RtpSenderLike,
  type RtpTransceiverLike,
} from './media.js';

export interface CallManagerOptions {
  identity: Identity;
  transport: RelayTransport;
  rtc?: CallRtcFactory;
  getUserMedia?: GetUserMedia;
  /** STUN／TURN；可為函式，每通電話建立連線時取當下的值 */
  iceServers?: unknown[] | (() => unknown[] | undefined);
  /** 封鎖的人打來：不響鈴、不回應 */
  isBlocked?: (pubkey: string) => boolean;
  videoQuality?: VideoQuality;
}

const SEEN_MEMORY = 4_096;

type ListenerName = 'incoming' | 'state' | 'localStream' | 'remoteStream' | 'media' | 'ended' | 'failed' | 'error';

function isVideoTransceiver(t: RtpTransceiverLike): boolean {
  return t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video';
}

export class CallManager {
  readonly #identity: Identity;
  readonly #transport: RelayTransport;
  readonly #rtc: CallRtcFactory;
  readonly #getUserMedia: GetUserMedia;
  readonly #iceServers: CallManagerOptions['iceServers'];
  readonly #isBlocked: (pubkey: string) => boolean;
  readonly #subscription: Subscription;
  readonly #seen = new Set<string>();
  #session = new CallSession();
  #pc: CallPeerConnectionLike | null = null;
  #peer: string | null = null;
  #media: CallMedia | null = null;
  #localStream: MediaStreamLike | null = null;
  #hasRemote = false;
  #pendingCandidates: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }[] = [];
  #everConnected = false;
  #videoQuality: VideoQuality;
  #closed = false;
  readonly #listeners = {
    incoming: new Set<(call: { peer: string; media: CallMedia }) => void>(),
    state: new Set<(peer: string | null, state: CallState, media: CallMedia | null) => void>(),
    localStream: new Set<(stream: MediaStreamLike | null) => void>(),
    remoteStream: new Set<(stream: MediaStreamLike | null) => void>(),
    media: new Set<(local: CallMedia, remote: CallMedia) => void>(),
    ended: new Set<(reason: CallEndReason) => void>(),
    failed: new Set<(peer: string, reason: CallFailureReason) => void>(),
    error: new Set<(message: string) => void>(),
  };

  constructor(opts: CallManagerOptions) {
    const rtc = opts.rtc ?? defaultCallRtc();
    const getUserMedia = opts.getUserMedia ?? defaultGetUserMedia();
    if (!rtc || !getUserMedia) throw new Error('這個環境沒有 WebRTC 或 getUserMedia，請注入 rtc 與 getUserMedia');
    this.#identity = opts.identity;
    this.#transport = opts.transport;
    this.#rtc = rtc;
    this.#getUserMedia = getUserMedia;
    this.#iceServers = opts.iceServers;
    this.#isBlocked = opts.isBlocked ?? (() => false);
    this.#videoQuality = opts.videoQuality ?? DEFAULT_VIDEO_QUALITY;
    this.#subscription = this.#transport.subscribe([{ kinds: [CALL_SIGNAL_KIND], '#p': [this.#identity.pubkey] }], {
      onEvent: (event) => void this.#onEvent(event as NostrEvent),
    });
  }

  // ── 事件 ─────────────────────────────────────────────────────────────────
  onIncoming(listener: (call: { peer: string; media: CallMedia }) => void): () => void {
    return this.#add('incoming', listener);
  }
  onState(listener: (peer: string | null, state: CallState, media: CallMedia | null) => void): () => void {
    return this.#add('state', listener);
  }
  onLocalStream(listener: (stream: MediaStreamLike | null) => void): () => void {
    return this.#add('localStream', listener);
  }
  onRemoteStream(listener: (stream: MediaStreamLike | null) => void): () => void {
    return this.#add('remoteStream', listener);
  }
  /** 我在送什麼、對方在送什麼：兩者各自獨立（「我送視訊、他只送語音」是合法狀態） */
  onMedia(listener: (local: CallMedia, remote: CallMedia) => void): () => void {
    return this.#add('media', listener);
  }
  onEnded(listener: (reason: CallEndReason) => void): () => void {
    return this.#add('ended', listener);
  }
  /** P2P 連不通（unreachable：多為限制網路、需要 TURN）或斷線（lost） */
  onFailed(listener: (peer: string, reason: CallFailureReason) => void): () => void {
    return this.#add('failed', listener);
  }
  onError(listener: (message: string) => void): () => void {
    return this.#add('error', listener);
  }

  get state(): CallState {
    return this.#session.state;
  }
  get peer(): string | null {
    return this.#peer;
  }
  get localMedia(): CallMedia | null {
    return this.#session.localMedia;
  }
  get remoteMedia(): CallMedia | null {
    return this.#session.remoteMedia;
  }

  // ── 操作 ─────────────────────────────────────────────────────────────────
  async startCall(peer: string, media: CallMedia): Promise<void> {
    if (this.#closed || this.#busy()) return;
    this.#session = new CallSession();
    this.#peer = peer;
    this.#media = media;
    this.#ensurePc();
    const callId = `sdk-call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await this.#run(this.#session.startCall(callId, media));
  }

  async accept(): Promise<void> {
    await this.#run(this.#session.accept());
  }

  async reject(): Promise<void> {
    await this.#run(this.#session.reject());
  }

  async hangup(): Promise<void> {
    await this.#run(this.#session.hangup());
  }

  /** 這通能不能在通話中切換語音／視訊（對方的 offer 沒有視訊 m-line 就不行；UI 據此不顯示按鈕） */
  canChangeMedia(): boolean {
    return this.#videoSender() !== null;
  }

  /** 通話中改變自己這一方的型態：先把相機換好，成功了才通知對方；失敗就改回去。 */
  async setLocalMedia(media: CallMedia): Promise<void> {
    const previous = this.#session.localMedia;
    const actions = this.#session.setLocalMedia(media);
    if (actions.length === 0) return;
    try {
      if (media === 'video') await this.#attachVideo();
      else this.#detachVideo();
    } catch (error) {
      if (previous) this.#session.setLocalMedia(previous); // 回滾，而且不送任何信令
      this.#fire('error', `無法開啟視訊：${String(error)}`);
      this.#emitMedia();
      return;
    }
    for (const action of actions) if (action.type === 'send') await this.#exec(action);
    this.#emitMedia();
  }

  /** 畫質檔位：通話中呼叫立即生效（改編碼上限與擷取解析度） */
  setVideoQuality(quality: VideoQuality): void {
    this.#videoQuality = quality;
    this.#applyVideoQuality();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscription.close();
    this.#teardown();
  }

  // ── 內部 ─────────────────────────────────────────────────────────────────
  #add(name: ListenerName, listener: unknown): () => void {
    const set = this.#listeners[name] as Set<unknown>;
    set.add(listener);
    return () => set.delete(listener);
  }

  #fire(name: ListenerName, ...args: unknown[]): void {
    for (const listener of this.#listeners[name] as Set<(...a: unknown[]) => void>) {
      try {
        listener(...args);
      } catch {
        // App 的監聽出錯不影響通話
      }
    }
  }

  #busy(): boolean {
    return this.#session.state !== 'idle' && this.#session.state !== 'ended';
  }

  async #publish(signal: CallSignal, peer: string): Promise<void> {
    const event = this.#identity.sealAndWrap(
      { kind: CALL_SIGNAL_KIND, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(signal) },
      peer,
      { kind: CALL_SIGNAL_KIND, tags: [['p', peer]] },
    );
    await this.#transport.publish(event);
  }

  async #onEvent(event: NostrEvent): Promise<void> {
    if (this.#closed || event.kind !== CALL_SIGNAL_KIND || this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    if (this.#seen.size > SEEN_MEMORY) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    let sender: string;
    let signal: CallSignal;
    try {
      const opened = this.#identity.openWrap(event);
      if (opened.rumor.kind !== CALL_SIGNAL_KIND) return;
      sender = opened.sender;
      signal = parseCallSignal(opened.rumor.content);
    } catch {
      return;
    }
    if (sender === this.#identity.pubkey || this.#isBlocked(sender)) return;

    if (signal.type === 'call-candidate') {
      if (this.#peer !== sender || this.#session.activeCallId !== signal.callId) return;
      const candidate = { candidate: signal.candidate, sdpMid: signal.sdpMid ?? null, sdpMLineIndex: signal.sdpMLineIndex ?? null };
      if (this.#hasRemote) await this.#pc?.addIceCandidate(candidate).catch(() => {});
      else this.#pendingCandidates.push(candidate);
      return;
    }

    if (signal.type === 'call-invite') {
      if (this.#busy()) {
        await this.#publish({ type: 'call-reject', callId: signal.callId, reason: 'busy' }, sender).catch(() => {});
        return;
      }
      this.#session = new CallSession();
      this.#peer = sender;
      this.#media = signal.media;
      this.#ensurePc();
      await this.#run(this.#session.onSignal(signal));
      this.#fire('incoming', { peer: sender, media: signal.media });
      return;
    }

    if (this.#peer !== sender) return;
    await this.#run(this.#session.onSignal(signal));
    if (signal.type === 'call-media') this.#emitMedia();
  }

  #ensurePc(): void {
    this.#everConnected = false;
    const servers = typeof this.#iceServers === 'function' ? this.#iceServers() : this.#iceServers;
    const pc = this.#rtc(servers ? { iceServers: servers } : {});
    pc.onicecandidate = (event) => {
      const c = event.candidate;
      const callId = this.#session.activeCallId;
      if (!c || !this.#peer || !callId) return;
      const signal: CallSignal = {
        type: 'call-candidate',
        callId,
        candidate: c.candidate,
        ...(c.sdpMid != null ? { sdpMid: c.sdpMid } : {}),
        ...(c.sdpMLineIndex != null ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
      };
      void this.#publish(signal, this.#peer).catch(() => {});
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) this.#fire('remoteStream', stream);
    };
    pc.onconnectionstatechange = () => {
      if (this.#pc !== pc) return;
      if (pc.connectionState === 'connected') {
        this.#everConnected = true;
        void this.#run(this.#session.onConnected());
      } else if (pc.connectionState === 'failed') {
        const peer = this.#peer;
        const reason: CallFailureReason = this.#everConnected ? 'lost' : 'unreachable';
        if (peer) this.#fire('failed', peer, reason);
        // 走正常掛斷：送 hangup 給對方（經中繼，與失敗的 P2P 不同路，對方也能乾淨結束）
        void this.#run(this.#session.hangup());
      }
    };
    // 一律預先協商視訊 transceiver（ADR-0338）：語音通話也有，之後升級只要 replaceTrack
    try {
      pc.addTransceiver('video', { direction: 'sendrecv' });
    } catch {
      // 舊環境沒有 addTransceiver：這通不能切換型態（canChangeMedia 回 false）
    }
    this.#pc = pc;
  }

  #videoSender(): RtpSenderLike | null {
    const pc = this.#pc;
    if (!pc) return null;
    const transceiver = pc.getTransceivers?.().find(isVideoTransceiver);
    if (transceiver) return transceiver.sender;
    return pc.getSenders().find((s) => s.track?.kind === 'video') ?? null;
  }

  async #attachVideo(): Promise<void> {
    const sender = this.#videoSender();
    if (!sender) throw new Error('這通沒有可用的視訊軌道');
    const stream = await this.#getUserMedia({ audio: false, video: videoConstraints(this.#videoQuality) });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('取不到視訊軌');
    try {
      await sender.replaceTrack(track);
      this.#localStream?.addTrack?.(track);
    } catch (error) {
      track.stop(); // 取到之後失敗一定要停掉：不然相機一直亮著
      throw error;
    }
    this.#applyVideoQuality();
    if (this.#localStream) this.#fire('localStream', this.#localStream);
  }

  #detachVideo(): void {
    const sender = this.#videoSender();
    const track = sender?.track ?? null;
    void sender?.replaceTrack(null);
    if (track) {
      track.stop(); // 真的關相機，不只是送黑畫面
      this.#localStream?.removeTrack?.(track);
    }
    if (this.#localStream) this.#fire('localStream', this.#localStream);
  }

  async #run(actions: CallAction[]): Promise<void> {
    for (const action of actions) {
      try {
        await this.#exec(action);
      } catch (error) {
        this.#fire('error', `通話處理失敗：${String(error)}`);
      }
    }
    this.#fire('state', this.#peer, this.#session.state, this.#session.effectiveMedia ?? this.#media);
  }

  async #exec(action: CallAction): Promise<void> {
    const pc = this.#pc;
    switch (action.type) {
      case 'acquire-media':
        await this.#acquireMedia(action.media);
        return;
      case 'create-offer': {
        if (!pc) return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await this.#run(this.#session.localDescription(offer.sdp ?? ''));
        return;
      }
      case 'create-answer': {
        if (!pc) return;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.#run(this.#session.localDescription(answer.sdp ?? ''));
        return;
      }
      case 'set-remote': {
        if (!pc) return;
        await pc.setRemoteDescription({ type: action.kind, sdp: action.sdp });
        // 🔴 ADR-0338 §3：答方為對方視訊 m-line 自動建立的 transceiver 是 recvonly，不改就永遠送不出視訊
        if (action.kind === 'offer') {
          for (const t of pc.getTransceivers?.() ?? []) if (isVideoTransceiver(t) && t.direction === 'recvonly') t.direction = 'sendrecv';
        }
        this.#hasRemote = true;
        for (const candidate of this.#pendingCandidates.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
        return;
      }
      case 'send':
        if (this.#peer) await this.#publish(action.signal, this.#peer);
        return;
      case 'ended':
        this.#fire('ended', action.reason);
        return;
      case 'close':
        this.#teardown();
        return;
    }
  }

  async #acquireMedia(media: CallMedia): Promise<void> {
    if (!this.#pc) return;
    const stream = await this.#getUserMedia({
      audio: true,
      // 不是裸 true（ADR-0337）：裸 true 拿相機預設，使用者付行動數據、站方付 TURN 流量，兩邊都不知道
      video: media === 'video' ? videoConstraints(this.#videoQuality) : false,
    });
    this.#localStream = stream;
    for (const track of stream.getTracks()) this.#pc.addTrack(track, stream);
    this.#applyVideoQuality();
    this.#fire('localStream', stream);
  }

  #applyVideoQuality(): void {
    const pc = this.#pc;
    if (!pc) return;
    const profile = videoProfile(this.#videoQuality);
    void (async () => {
      try {
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind !== 'video' || !sender.getParameters || !sender.setParameters) continue;
          const params = sender.getParameters();
          const encodings = params.encodings?.length ? params.encodings : [{}];
          encodings[0]!.maxBitrate = profile.maxBitrate;
          await sender.setParameters({ ...params, encodings, degradationPreference: 'maintain-framerate' });
        }
        for (const track of this.#localStream?.getVideoTracks() ?? []) await track.applyConstraints?.(videoConstraints(this.#videoQuality));
      } catch {
        // 畫質是加分項，不是通話前提
      }
    })();
  }

  #emitMedia(): void {
    const local = this.#session.localMedia;
    const remote = this.#session.remoteMedia;
    if (local && remote) this.#fire('media', local, remote);
  }

  #teardown(): void {
    if (this.#localStream) for (const track of this.#localStream.getTracks()) track.stop();
    const pc = this.#pc;
    if (pc) {
      // 換上來的視訊軌不在 localStream 裡時也要停
      for (const sender of pc.getSenders()) sender.track?.stop();
      try {
        pc.close();
      } catch {
        // 已關閉
      }
    }
    this.#pc = null;
    this.#localStream = null;
    this.#hasRemote = false;
    this.#pendingCandidates = [];
    this.#fire('localStream', null);
    this.#fire('remoteStream', null);
    this.#peer = null;
  }
}
