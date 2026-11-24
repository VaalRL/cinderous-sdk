// 網狀（mesh）小群組通話（SDK ADR 0141）：每人直連每人，不經媒體伺服器，媒體仍是端到端的 DTLS-SRTP。
//
// - 信令：`protocol/group-call` 的 `group-*`，跟一對一同樣是 kind 21002 的 NIP-59 ephemeral Gift Wrap，逐人封裝。
// - 每一對只有一條連線：由 pubkey 字典序較小的那位發 offer（`groupCallOfferer`）。
//   加入的人廣播 `group-join`；已在通話裡的人收到後，若自己較小就發 offer，較大就回 `ack` 讓對方發。
// - 某一對打不通只影響那一對（`onPeerFailed`），其他人照常。
// - 本地媒體只取一次：一支麥克風、一顆鏡頭分送給每一條連線（每條各自的 sender）。靜音、關鏡頭對所有人生效。
//
// 吸收 Cinderous 真機驗收（Cinderous ADR-0424）的教訓：
// - 發 offer 的那方用 `addTransceiver('video', { streams })` 預鋪視訊並**綁 stream**；
// - 接 offer 的那方**不自己鋪**，套用 offer 後把媒體 `replaceTrack` 到協商過（mid != null）的 transceiver，並 `setStreams`；
// - 收端把每條軌（不管有沒有帶 stream）併進那個人的遠端串流，送新物件；
// - 換鏡頭遇到「鏡頭忙碌」（手機同時只能開一顆）就先停舊的再開新的，開不了就重開原本那顆，再不行降成語音。
import type { Identity } from '../identity.js';
import type { CallMedia } from '../protocol/call.js';
import { CALL_SIGNAL_KIND } from '../protocol/call.js';
import type { NostrEvent } from '../protocol/event.js';
import {
  GROUP_CALL_DEFAULT_MAX,
  GROUP_CALL_HARD_MAX,
  type GroupCallSignal,
  type GroupDeclineReason,
  parseGroupCallSignal,
} from '../protocol/group-call.js';
import {
  type CameraSelection,
  DEFAULT_VIDEO_QUALITY,
  type VideoQuality,
  videoConstraints,
  videoProfile,
} from '../protocol/video-quality.js';
import type { RelayTransport, Subscription } from '../relay-pool.js';
import {
  type CallPeerConnectionLike,
  type CallRtcFactory,
  type CreateMediaStream,
  defaultCallRtc,
  defaultCreateMediaStream,
  defaultGetUserMedia,
  type GetUserMedia,
  isCameraBusy,
  isNegotiated,
  type MediaStreamLike,
  type MediaTrackLike,
  type RtpSenderLike,
  type RtpTransceiverLike,
} from './media.js';

export interface GroupCallManagerOptions {
  identity: Identity;
  transport: RelayTransport;
  rtc?: CallRtcFactory;
  getUserMedia?: GetUserMedia;
  createStream?: CreateMediaStream;
  /** STUN／TURN；可為函式，每條連線建立時取當下的值 */
  iceServers?: unknown[] | (() => unknown[] | undefined);
  /** 封鎖的人邀我：不響鈴、不回應 */
  isBlocked?: (pubkey: string) => boolean;
  /** 另一個通話（例如一對一的 `CallManager`）進行中：群組邀請一律回忙線 */
  isBusy?: () => boolean;
  videoQuality?: VideoQuality;
  /** 含自己的人數上限，預設 `GROUP_CALL_DEFAULT_MAX`，不得超過 `GROUP_CALL_HARD_MAX` */
  maxParticipants?: number;
  /** 被邀的人多久沒回應就標 `no-answer`；收到邀請沒接聽的這一方也在這之後自己結束（毫秒，預設 45 秒） */
  ringTimeoutMs?: number;
  /**
   * 某一對加入之後多久還沒連上就當作打不通（毫秒，預設 30 秒）：offer／answer 在信令上遺失、
   * 對方送完 join 就斷線時，ICE 會永遠停在 new，不會自己變 failed。
   */
  connectTimeoutMs?: number;
}

/** 連線建立前暫存的 ICE candidate，每人最多幾則（多的丟掉：正常一對只有個位數） */
export const GROUP_CALL_MAX_PENDING_CANDIDATES = 32;
/** 同一個人在同一通裡最多能讓我重建幾次連線（重送 offer）；超過就忽略 */
const MAX_REOFFERS = 3;

export type GroupCallState = 'idle' | 'incoming' | 'in-call' | 'ended';
export type GroupParticipantStatus =
  | 'invited'
  | 'joined'
  | 'connecting'
  | 'connected'
  | 'declined'
  | 'busy'
  | 'full'
  | 'no-answer'
  | 'left'
  | 'failed';
export interface GroupParticipant {
  pubkey: string;
  status: GroupParticipantStatus;
  /** 對方在送什麼（對方告訴我們的；還沒說之前當作語音） */
  media: CallMedia;
}
/** left：我離開；declined：我拒接；empty：其他人都不在了；cancelled：還沒接，邀請的人就走了；no-answer：響鈴逾時我沒接 */
export type GroupCallEndReason = 'left' | 'declined' | 'empty' | 'cancelled' | 'no-answer';
export interface GroupIncomingCall {
  groupId: string;
  from: string;
  members: string[];
  media: CallMedia;
}

interface Leg {
  pc: CallPeerConnectionLike;
  everConnected: boolean;
  hasRemote: boolean;
  remoteTracks: MediaTrackLike[];
}
type Candidate = { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };

const SEEN_MEMORY = 4_096;
const HEX64 = /^[0-9a-f]{64}$/;
const ALIVE: ReadonlySet<GroupParticipantStatus> = new Set(['invited', 'joined', 'connecting', 'connected']);

function kindOf(t: RtpTransceiverLike): string | undefined {
  return t.receiver?.track?.kind ?? t.sender?.track?.kind;
}

function randomGroupId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Listeners = {
  incoming: (call: GroupIncomingCall) => void;
  state: (state: GroupCallState) => void;
  participants: (list: GroupParticipant[]) => void;
  localStream: (stream: MediaStreamLike | null) => void;
  remoteStream: (peer: string, stream: MediaStreamLike | null) => void;
  peerFailed: (peer: string, reason: 'unreachable' | 'lost') => void;
  ended: (reason: GroupCallEndReason) => void;
  error: (message: string) => void;
};

export class GroupCallManager {
  readonly #identity: Identity;
  readonly #transport: RelayTransport;
  readonly #rtc: CallRtcFactory;
  readonly #getUserMedia: GetUserMedia;
  readonly #createStream: CreateMediaStream;
  readonly #iceServers: GroupCallManagerOptions['iceServers'];
  readonly #isBlocked: (pubkey: string) => boolean;
  readonly #isBusyElsewhere: () => boolean;
  readonly #max: number;
  readonly #ringTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #subscription: Subscription;
  readonly #seen = new Set<string>();
  #videoQuality: VideoQuality;
  #camera: CameraSelection | undefined;

  #state: GroupCallState = 'idle';
  #groupId: string | null = null;
  #inviter: string | null = null;
  #inviteMedia: CallMedia = 'audio';
  #members: string[] = [];
  #parts = new Map<string, GroupParticipant>();
  #legs = new Map<string, Leg>();
  #pending = new Map<string, Candidate[]>();
  /** 還不在名單上的人送來的加入（名單更新可能晚到）：名單補上他之後重放 */
  #unknownJoins = new Map<string, GroupCallSignal>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 每一對「加入了但還沒連上」的期限（H3） */
  #connectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #incomingTimer: ReturnType<typeof setTimeout> | null = null;
  #reoffers = new Map<string, number>();
  /**
   * 每一通（以及關閉）遞增。非同步操作（取麥克風／鏡頭、建連線）在 await 前記下，回來時不同就代表這一通已經結束：
   * 取得的裝置要關掉、不能再改狀態或送信令（H1：否則通話會「復活」、相機一直亮）。
   */
  #epoch = 0;
  /** start() 正在取麥克風／鏡頭：算忙線，避免這段時間被別的邀請或第二個 start() 覆蓋 */
  #starting = false;
  /** 換鏡頭一次只做一個（連按時第二次要等第一次做完，否則會漏關一顆） */
  #cameraChain: Promise<void> = Promise.resolve();
  /** 使用者最後要的型態（開／關視訊連按時以最後一次為準） */
  #wantedMedia: CallMedia = 'audio';
  #localStream: MediaStreamLike | null = null;
  #audio: MediaTrackLike | null = null;
  #video: MediaTrackLike | null = null;
  #localMedia: CallMedia = 'audio';
  #muted = false;
  #closed = false;
  readonly #listeners: { [K in keyof Listeners]: Set<Listeners[K]> } = {
    incoming: new Set(),
    state: new Set(),
    participants: new Set(),
    localStream: new Set(),
    remoteStream: new Set(),
    peerFailed: new Set(),
    ended: new Set(),
    error: new Set(),
  };

  constructor(opts: GroupCallManagerOptions) {
    const max = opts.maxParticipants ?? GROUP_CALL_DEFAULT_MAX;
    if (!Number.isInteger(max) || max < 2 || max > GROUP_CALL_HARD_MAX) {
      throw new Error(`maxParticipants 必須是 2～${GROUP_CALL_HARD_MAX}（網狀拓撲每人上傳 N−1 份，見 SDK ADR 0141）`);
    }
    const rtc = opts.rtc ?? defaultCallRtc();
    const getUserMedia = opts.getUserMedia ?? defaultGetUserMedia();
    if (!rtc || !getUserMedia) throw new Error('這個環境沒有 WebRTC 或 getUserMedia，請注入 rtc 與 getUserMedia');
    this.#identity = opts.identity;
    this.#transport = opts.transport;
    this.#rtc = rtc;
    this.#getUserMedia = getUserMedia;
    this.#createStream = opts.createStream ?? defaultCreateMediaStream();
    this.#iceServers = opts.iceServers;
    this.#isBlocked = opts.isBlocked ?? (() => false);
    this.#isBusyElsewhere = opts.isBusy ?? (() => false);
    this.#videoQuality = opts.videoQuality ?? DEFAULT_VIDEO_QUALITY;
    this.#max = max;
    this.#ringTimeoutMs = opts.ringTimeoutMs ?? 45_000;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    this.#subscription = this.#transport.subscribe([{ kinds: [CALL_SIGNAL_KIND], '#p': [this.#identity.pubkey] }], {
      onEvent: (event) => void this.#onEvent(event as NostrEvent),
    });
  }

  // ── 事件 ─────────────────────────────────────────────────────────────────
  onIncoming(l: Listeners['incoming']): () => void {
    return this.#add('incoming', l);
  }
  onState(l: Listeners['state']): () => void {
    return this.#add('state', l);
  }
  onParticipants(l: Listeners['participants']): () => void {
    return this.#add('participants', l);
  }
  onLocalStream(l: Listeners['localStream']): () => void {
    return this.#add('localStream', l);
  }
  /** 每個人一個串流；內容變了送新物件，他離開或連線失敗時送 null */
  onRemoteStream(l: Listeners['remoteStream']): () => void {
    return this.#add('remoteStream', l);
  }
  /** 只有這一對打不通（unreachable）或斷線（lost）；其他人不受影響 */
  onPeerFailed(l: Listeners['peerFailed']): () => void {
    return this.#add('peerFailed', l);
  }
  onEnded(l: Listeners['ended']): () => void {
    return this.#add('ended', l);
  }
  onError(l: Listeners['error']): () => void {
    return this.#add('error', l);
  }

  get state(): GroupCallState {
    return this.#state;
  }
  get groupId(): string | null {
    return this.#groupId;
  }
  get localMedia(): CallMedia {
    return this.#localMedia;
  }
  get maxParticipants(): number {
    return this.#max;
  }
  participants(): GroupParticipant[] {
    return [...this.#parts.values()].map((p) => ({ ...p }));
  }

  // ── 操作 ─────────────────────────────────────────────────────────────────
  /** 開一通群組通話並邀請 `peers`（不含自己）。回傳 groupId。 */
  async start(peers: string[], media: CallMedia): Promise<string> {
    if (this.#closed) throw new Error('GroupCallManager 已關閉');
    if (this.#busy() || this.#isBusyElsewhere()) throw new Error('已經在通話中');
    const me = this.#identity.pubkey;
    const others = [...new Set(peers)].filter((p) => p !== me);
    if (others.length === 0) throw new Error('至少要邀請一個人');
    for (const p of others) if (!HEX64.test(p)) throw new Error(`不是合法的 pubkey：${p}`);
    if (others.length + 1 > this.#max) throw new Error(`人數超過上限 ${this.#max}（含自己）`);
    this.#reset();
    const epoch = this.#epoch;
    this.#groupId = randomGroupId();
    this.#members = [me, ...others];
    this.#inviteMedia = media;
    this.#starting = true;
    let acquired: boolean;
    try {
      acquired = await this.#acquire(media, epoch);
    } finally {
      this.#starting = false;
    }
    if (!acquired) throw new Error('取得麥克風／鏡頭時通話就被關掉了');
    this.#state = 'in-call';
    for (const p of others) {
      this.#parts.set(p, { pubkey: p, status: 'invited', media: 'audio' });
      this.#startRing(p);
    }
    this.#fire('state', this.#state);
    this.#emitParticipants();
    for (const p of others) await this.#send(p, { type: 'group-invite', media, members: this.#members });
    return this.#groupId;
  }

  async accept(): Promise<void> {
    if (this.#state !== 'incoming' || !this.#groupId) return;
    const epoch = this.#epoch;
    let acquired: boolean;
    try {
      acquired = await this.#acquire(this.#inviteMedia, epoch);
    } catch (error) {
      if (this.#epoch !== epoch) return;
      this.#fire('error', `無法取得麥克風／鏡頭：${String(error)}`);
      await this.reject();
      return;
    }
    // 🔴 H1：等權限的時候對方取消了、或我拒接了 ⇒ 裝置已在 #acquire 關掉，不能復活這一通
    if (!acquired || this.#state !== 'incoming') return;
    this.#clearIncomingTimer();
    this.#state = 'in-call';
    this.#fire('state', this.#state);
    const me = this.#identity.pubkey;
    for (const [p, part] of this.#parts) if (part.status === 'invited') this.#startRing(p);
    // 已在通話裡的人：開始計連線期限（我較大的那幾位要等對方的 offer，也可能永遠等不到）
    for (const [p, part] of this.#parts) if (part.status === 'joined') this.#armConnect(p);
    for (const p of this.#members) {
      if (p !== me) await this.#send(p, { type: 'group-join', members: this.#members });
      if (this.#epoch !== epoch) return;
    }
    // 已知在通話裡的人（至少有邀請者）：我較小就由我發 offer；我較大的，對方收到我的 join 會發
    for (const [p, part] of this.#parts) {
      if (part.status === 'joined' && me < p && !this.#legs.has(p)) await this.#offerTo(p);
      if (this.#epoch !== epoch) return;
    }
    this.#emitParticipants();
  }

  async reject(): Promise<void> {
    if (this.#state !== 'incoming') return;
    const me = this.#identity.pubkey;
    const notify = this.#members.filter((p) => p !== me);
    this.#end('declined');
    for (const p of notify) await this.#send(p, { type: 'group-decline', reason: 'declined' }).catch(() => {});
  }

  async leave(): Promise<void> {
    if (this.#state === 'incoming') return this.reject();
    if (this.#state !== 'in-call') return;
    const notify = [...this.#parts].filter(([, part]) => ALIVE.has(part.status)).map(([p]) => p);
    this.#end('left');
    for (const p of notify) await this.#send(p, { type: 'group-leave' }).catch(() => {});
  }

  /** 通話中再邀一位（任何已加入的人都可以）；名單變動會告訴其他人 */
  async invite(peer: string): Promise<void> {
    if (this.#state !== 'in-call') throw new Error('不在通話中');
    if (!HEX64.test(peer)) throw new Error(`不是合法的 pubkey：${peer}`);
    if (this.#members.includes(peer)) return;
    if (this.#members.length + 1 > this.#max) throw new Error(`人數超過上限 ${this.#max}（含自己）`);
    this.#members = [...this.#members, peer];
    this.#parts.set(peer, { pubkey: peer, status: 'invited', media: 'audio' });
    this.#startRing(peer);
    this.#emitParticipants();
    await this.#send(peer, { type: 'group-invite', media: this.#localMedia, members: this.#members });
    for (const [p, part] of this.#parts) {
      if (p !== peer && ALIVE.has(part.status)) await this.#send(p, { type: 'group-members', members: this.#members }).catch(() => {});
    }
  }

  /** 改自己這一方送什麼：對每一條連線都生效；先把相機換好，成功了才通知大家 */
  async setLocalMedia(media: CallMedia): Promise<void> {
    if (this.#state !== 'in-call' || this.#wantedMedia === media) return;
    this.#wantedMedia = media;
    if (media === 'video') {
      const epoch = this.#epoch;
      let track: MediaTrackLike;
      try {
        track = await this.#openCamera();
      } catch (error) {
        if (this.#epoch === epoch && this.#wantedMedia === 'video') {
          this.#wantedMedia = this.#localMedia;
          this.#fire('error', `無法開啟視訊：${String(error)}`);
        }
        return;
      }
      // 🔴 H1：鏡頭開好時通話已結束、使用者又按了關、或另一次開啟已先完成 ⇒ 關掉這顆，不送
      if (this.#epoch !== epoch || this.#wantedMedia !== 'video' || this.#video) {
        track.stop();
        return;
      }
      // M9：先記下，await 期間新建的連線（#offerTo／#answer）才拿得到這顆鏡頭
      this.#video = track;
      this.#replaceLocalTrack(track, null);
      await this.#putVideoOnAllLegs(track);
      if (this.#epoch !== epoch) return; // #end 已經關了 #video
      this.#applyVideoQuality();
    } else {
      this.#dropVideo();
    }
    this.#localMedia = media;
    await this.#broadcastMedia();
  }

  /** 靜音：麥克風軌 `enabled=false`，對所有人生效（裝置不關，解除時不用重新取用） */
  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (this.#audio) this.#audio.enabled = !muted;
  }

  get muted(): boolean {
    return this.#muted;
  }

  /**
   * 換鏡頭，所有連線一起換。先試著直接開新的（桌面可以同時開兩顆，沒有空窗）；
   * 🔴 遇到「鏡頭忙碌」（多數手機同時只能開一顆）就先停舊的再開。新的開不了就重開原本那顆；
   * 連原本的都開不了就降成語音並通知大家，不送一條死掉的軌（Cinderous ADR-0424）。
   */
  setCamera(selection: CameraSelection): Promise<void> {
    // 🔴 一次只換一個：連按兩次時，第二次以第一次換好的那顆為「舊的」，不會漏關
    const run = this.#cameraChain.then(() => this.#swapCamera(selection));
    this.#cameraChain = run.catch(() => {});
    return run;
  }

  async #swapCamera(selection: CameraSelection): Promise<void> {
    const previous = this.#camera;
    this.#camera = selection;
    const old = this.#video;
    if (!old || this.#state !== 'in-call') return;
    const epoch = this.#epoch;
    // 開好時這一通已結束、或視訊已被關掉／換掉 ⇒ 這顆不要了
    const stale = () => this.#epoch !== epoch || this.#video !== old;
    let track: MediaTrackLike;
    try {
      track = await this.#openCamera();
    } catch (error) {
      if (stale()) return;
      if (!isCameraBusy(error)) {
        this.#camera = previous;
        this.#fire('error', `無法切換鏡頭：${String(error)}`);
        return;
      }
      old.stop();
      try {
        track = await this.#openCamera();
      } catch (retryError) {
        if (stale()) return;
        this.#fire('error', `無法切換鏡頭：${String(retryError)}`);
        this.#camera = previous;
        try {
          track = await this.#openCamera();
        } catch {
          if (stale()) return;
          this.#dropVideo();
          this.#localMedia = 'audio';
          this.#wantedMedia = 'audio';
          await this.#broadcastMedia();
          return;
        }
      }
    }
    if (stale()) {
      track.stop();
      return;
    }
    this.#video = track;
    this.#replaceLocalTrack(track, old);
    await this.#putVideoOnAllLegs(track);
    old.stop();
    if (this.#epoch !== epoch) return;
    this.#applyVideoQuality();
  }

  setVideoQuality(quality: VideoQuality): void {
    this.#videoQuality = quality;
    this.#applyVideoQuality();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#epoch++;
    this.#subscription.close();
    if (this.#state === 'in-call' || this.#state === 'incoming') this.#end(this.#state === 'incoming' ? 'declined' : 'left');
  }

  // ── 信令 ─────────────────────────────────────────────────────────────────
  #add<K extends keyof Listeners>(name: K, listener: Listeners[K]): () => void {
    this.#listeners[name].add(listener);
    return () => this.#listeners[name].delete(listener);
  }

  #fire<K extends keyof Listeners>(name: K, ...args: Parameters<Listeners[K]>): void {
    for (const listener of this.#listeners[name]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch {
        // App 的監聽出錯不影響通話
      }
    }
  }

  #busy(): boolean {
    return this.#starting || this.#state === 'incoming' || this.#state === 'in-call';
  }

  async #send(peer: string, body: Record<string, unknown>): Promise<void> {
    if (!this.#groupId) return;
    const signal = { v: 1, groupId: this.#groupId, ...body };
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
    let signal: GroupCallSignal;
    try {
      const opened = this.#identity.openWrap(event);
      if (opened.rumor.kind !== CALL_SIGNAL_KIND) return;
      sender = opened.sender;
      signal = parseGroupCallSignal(opened.rumor.content); // 一對一信令在這裡丟例外 ⇒ 不歸我管
    } catch {
      return;
    }
    if (sender === this.#identity.pubkey || this.#isBlocked(sender)) return;
    try {
      await this.#handle(sender, signal);
    } catch (error) {
      this.#fire('error', `群組通話處理失敗：${String(error)}`);
    }
  }

  async #handle(sender: string, sig: GroupCallSignal): Promise<void> {
    const me = this.#identity.pubkey;
    if (sig.type === 'group-invite') {
      if (sig.groupId === this.#groupId) return;
      if (!sig.members.includes(me) || !sig.members.includes(sender)) return;
      if (this.#busy() || this.#isBusyElsewhere()) {
        await this.#reply(sig.groupId, sender, 'busy');
        return;
      }
      if (sig.members.length > this.#max) {
        await this.#reply(sig.groupId, sender, 'full');
        return;
      }
      this.#reset();
      this.#groupId = sig.groupId;
      this.#inviter = sender;
      this.#inviteMedia = sig.media;
      this.#members = [...sig.members];
      for (const p of sig.members) {
        if (p === me) continue;
        this.#parts.set(p, { pubkey: p, status: p === sender ? 'joined' : 'invited', media: p === sender ? sig.media : 'audio' });
      }
      this.#state = 'incoming';
      const epoch = this.#epoch;
      // M4：一直不接就自己結束，不會永遠佔著忙線（邀請方同一時間也會把我標成 no-answer）
      this.#incomingTimer = setTimeout(() => {
        this.#incomingTimer = null;
        if (this.#epoch === epoch && this.#state === 'incoming') this.#end('no-answer');
      }, this.#ringTimeoutMs);
      this.#fire('incoming', { groupId: sig.groupId, from: sender, members: [...sig.members], media: sig.media });
      this.#fire('state', this.#state);
      this.#emitParticipants();
      return;
    }
    if (sig.groupId !== this.#groupId || !this.#busy()) return;
    if (!this.#members.includes(sender)) {
      if (sig.type === 'group-join' && (this.#unknownJoins.has(sender) || this.#unknownJoins.size < this.#max)) this.#unknownJoins.set(sender, sig);
      return;
    }
    const part = this.#parts.get(sender);
    if (!part) return;
    switch (sig.type) {
      case 'group-join': {
        this.#clearRing(sender);
        if (part.status !== 'connecting' && part.status !== 'connected') part.status = 'joined';
        this.#mergeMembers(sig.members);
        if (this.#state === 'in-call' && !this.#legs.has(sender)) {
          this.#armConnect(sender);
          if (me < sender) await this.#offerTo(sender);
          else if (!sig.ack) await this.#send(sender, { type: 'group-join', members: this.#members, ack: true });
        }
        this.#emitParticipants();
        await this.#replayUnknownJoins();
        return;
      }
      case 'group-members':
        if (part.status === 'joined' || part.status === 'connecting' || part.status === 'connected') {
          this.#mergeMembers(sig.members);
          this.#emitParticipants();
          await this.#replayUnknownJoins();
        }
        return;
      case 'group-decline':
        this.#clearRing(sender);
        part.status = sig.reason === 'declined' ? 'declined' : sig.reason;
        this.#emitParticipants();
        this.#checkEnd();
        return;
      case 'group-leave':
        this.#clearRing(sender);
        this.#closeLeg(sender);
        part.status = 'left';
        this.#emitParticipants();
        if (this.#state === 'incoming') {
          if (![...this.#parts.values()].some((p) => p.status === 'joined')) this.#end('cancelled');
        } else {
          this.#checkEnd();
        }
        return;
      case 'group-offer': {
        if (this.#state !== 'in-call') return;
        // M1：這一對該由字典序小的發 offer——我比較小就不收；已拒接、離開、失敗的人也不能靠 offer 復活。
        // 「invited」要收：中途加入的人眼中，已在通話裡的人只是名單上的「invited」（他們直接發 offer，不另送 join）
        if (me < sender) return;
        if (!ALIVE.has(part.status)) return;
        const existing = this.#legs.get(sender);
        if (existing) {
          // M2：已連上的不讓對方隨便重建；重建次數有上限
          if (existing.pc.connectionState === 'connected') return;
          const n = (this.#reoffers.get(sender) ?? 0) + 1;
          if (n > MAX_REOFFERS) return;
          this.#reoffers.set(sender, n);
          this.#closeLeg(sender);
        }
        part.media = sig.media;
        await this.#answer(sender, sig.sdp);
        return;
      }
      case 'group-answer': {
        const leg = this.#legs.get(sender);
        if (!leg || leg.hasRemote) return;
        part.media = sig.media;
        leg.hasRemote = true; // 先標起來：await 期間重送的同一個 answer 不會再套一次
        try {
          await leg.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
        } catch (error) {
          this.#legFailed(sender, leg, error);
          return;
        }
        if (this.#legs.get(sender) !== leg) return;
        await this.#flushCandidates(sender, leg);
        this.#emitParticipants();
        return;
      }
      case 'group-candidate': {
        const candidate = { candidate: sig.candidate, sdpMid: sig.sdpMid ?? null, sdpMLineIndex: sig.sdpMLineIndex ?? null };
        const leg = this.#legs.get(sender);
        if (leg?.hasRemote) await leg.pc.addIceCandidate(candidate).catch(() => {});
        else {
          const queued = this.#pending.get(sender) ?? [];
          if (queued.length < GROUP_CALL_MAX_PENDING_CANDIDATES) this.#pending.set(sender, [...queued, candidate]);
        }
        return;
      }
      case 'group-media':
        part.media = sig.media;
        this.#emitParticipants();
        return;
    }
  }

  async #reply(groupId: string, peer: string, reason: GroupDeclineReason): Promise<void> {
    const signal = { v: 1, groupId, type: 'group-decline', reason };
    const event = this.#identity.sealAndWrap(
      { kind: CALL_SIGNAL_KIND, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(signal) },
      peer,
      { kind: CALL_SIGNAL_KIND, tags: [['p', peer]] },
    );
    await this.#transport.publish(event).catch(() => {});
  }

  #mergeMembers(list: string[]): void {
    const me = this.#identity.pubkey;
    for (const p of list) {
      if (this.#members.includes(p)) continue;
      if (this.#members.length >= this.#max) break;
      this.#members.push(p);
      if (p !== me && !this.#parts.has(p)) {
        this.#parts.set(p, { pubkey: p, status: 'invited', media: 'audio' });
        if (this.#state === 'in-call') this.#startRing(p);
      }
    }
  }

  async #replayUnknownJoins(): Promise<void> {
    for (const [sender, sig] of [...this.#unknownJoins]) {
      if (!this.#members.includes(sender)) continue;
      this.#unknownJoins.delete(sender);
      await this.#handle(sender, sig);
    }
  }

  #startRing(peer: string): void {
    this.#clearRing(peer);
    this.#timers.set(
      peer,
      setTimeout(() => {
        this.#timers.delete(peer);
        const part = this.#parts.get(peer);
        if (part?.status !== 'invited') return;
        part.status = 'no-answer';
        this.#emitParticipants();
        this.#checkEnd();
      }, this.#ringTimeoutMs),
    );
  }

  #clearRing(peer: string): void {
    const t = this.#timers.get(peer);
    if (t) clearTimeout(t);
    this.#timers.delete(peer);
  }

  #checkEnd(): void {
    if (this.#state !== 'in-call') return;
    if (![...this.#parts.values()].some((p) => ALIVE.has(p.status))) this.#end('empty');
  }

  #emitParticipants(): void {
    this.#fire('participants', this.participants());
  }

  async #broadcastMedia(): Promise<void> {
    for (const [p, part] of this.#parts) {
      if (part.status === 'joined' || part.status === 'connecting' || part.status === 'connected') {
        await this.#send(p, { type: 'group-media', media: this.#localMedia }).catch(() => {});
      }
    }
  }

  // ── 每一對的連線 ───────────────────────────────────────────────────────────
  #newLeg(peer: string): Leg {
    const servers = typeof this.#iceServers === 'function' ? this.#iceServers() : this.#iceServers;
    const pc = this.#rtc(servers ? { iceServers: servers } : {});
    const leg: Leg = { pc, everConnected: false, hasRemote: false, remoteTracks: [] };
    pc.onicecandidate = (event) => {
      const c = event.candidate;
      if (!c || this.#legs.get(peer) !== leg) return;
      void this.#send(peer, {
        type: 'group-candidate',
        candidate: c.candidate,
        ...(c.sdpMid != null ? { sdpMid: c.sdpMid } : {}),
        ...(c.sdpMLineIndex != null ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
      }).catch(() => {});
    };
    pc.ontrack = (event) => {
      if (this.#legs.get(peer) !== leg) return;
      // 🔴 ADR-0424：對方沒綁 stream 時 streams 是空的——每條軌都併進這個人的遠端串流，送新物件
      const incoming = [...(event.streams[0]?.getTracks() ?? []), ...(event.track ? [event.track] : [])];
      let changed = false;
      for (const track of incoming) {
        if (!leg.remoteTracks.includes(track)) {
          leg.remoteTracks.push(track);
          changed = true;
        }
      }
      if (changed) this.#fire('remoteStream', peer, this.#createStream(leg.remoteTracks));
    };
    pc.onconnectionstatechange = () => {
      if (this.#legs.get(peer) !== leg) return;
      const part = this.#parts.get(peer);
      if (pc.connectionState === 'connected') {
        leg.everConnected = true;
        this.#clearConnect(peer);
        if (part) part.status = 'connected';
        this.#emitParticipants();
      } else if (pc.connectionState === 'failed') {
        // 只有這一對：關掉這條、告訴 App，其他人照常
        this.#closeLeg(peer);
        if (part) part.status = 'failed';
        this.#fire('peerFailed', peer, leg.everConnected ? 'lost' : 'unreachable');
        this.#emitParticipants();
        this.#checkEnd();
      }
    };
    this.#legs.set(peer, leg);
    const part = this.#parts.get(peer);
    if (part) part.status = 'connecting';
    this.#armConnect(peer);
    return leg;
  }

  /** H3：這一對在期限內沒連上就當作打不通（ICE 停在 new 時不會自己變 failed） */
  #armConnect(peer: string): void {
    this.#clearConnect(peer);
    const epoch = this.#epoch;
    this.#connectTimers.set(
      peer,
      setTimeout(() => {
        this.#connectTimers.delete(peer);
        if (this.#epoch !== epoch || this.#state !== 'in-call') return;
        const part = this.#parts.get(peer);
        if (!part || (part.status !== 'joined' && part.status !== 'connecting')) return;
        const leg = this.#legs.get(peer);
        this.#closeLeg(peer);
        part.status = 'failed';
        this.#fire('peerFailed', peer, leg?.everConnected ? 'lost' : 'unreachable');
        this.#emitParticipants();
        this.#checkEnd();
      }, this.#connectTimeoutMs),
    );
  }

  #clearConnect(peer: string): void {
    const t = this.#connectTimers.get(peer);
    if (t) clearTimeout(t);
    this.#connectTimers.delete(peer);
  }

  #clearIncomingTimer(): void {
    if (this.#incomingTimer) clearTimeout(this.#incomingTimer);
    this.#incomingTimer = null;
  }

  /** H2：建這一對的連線時任何一步失敗：清乾淨、標 failed、通知；不讓他永遠卡在 connecting */
  #legFailed(peer: string, leg: Leg, error: unknown): void {
    if (this.#legs.get(peer) !== leg) return; // 已被換掉或這一通已結束
    this.#closeLeg(peer);
    this.#clearConnect(peer);
    const part = this.#parts.get(peer);
    if (part) part.status = 'failed';
    this.#fire('error', `和 ${peer.slice(0, 8)} 建立連線失敗：${String(error)}`);
    this.#fire('peerFailed', peer, 'unreachable');
    this.#emitParticipants();
    this.#checkEnd();
  }

  async #offerTo(peer: string): Promise<void> {
    const leg = this.#newLeg(peer);
    try {
      await this.#doOffer(peer, leg);
    } catch (error) {
      this.#legFailed(peer, leg, error);
    }
  }

  async #doOffer(peer: string, leg: Leg): Promise<void> {
    const { pc } = leg;
    const stream = this.#localStream ?? this.#createStream([]);
    if (this.#audio) pc.addTrack(this.#audio, stream);
    // 預鋪視訊並綁 stream（ADR-0424：不綁的話對方 ontrack 拿不到 stream）；通話中開關鏡頭只要 replaceTrack
    let video: RtpTransceiverLike | undefined;
    try {
      video = pc.addTransceiver('video', { direction: 'sendrecv', streams: [stream] }) as RtpTransceiverLike | undefined;
    } catch {
      // 舊環境沒有 addTransceiver：這一對只能照開始時的型態
    }
    video ??= pc.getTransceivers?.().find((t) => kindOf(t) === 'video');
    if (this.#video) {
      if (video) await video.sender.replaceTrack(this.#video);
      else pc.addTrack(this.#video, stream);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.#legs.get(peer) !== leg) return;
    this.#applyVideoQuality();
    await this.#send(peer, { type: 'group-offer', sdp: offer.sdp ?? '', media: this.#localMedia });
    this.#emitParticipants();
  }

  async #answer(peer: string, sdp: string): Promise<void> {
    const leg = this.#newLeg(peer);
    try {
      await this.#doAnswer(peer, leg, sdp);
    } catch (error) {
      this.#legFailed(peer, leg, error);
    }
  }

  async #doAnswer(peer: string, leg: Leg, sdp: string): Promise<void> {
    const { pc } = leg;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    if (this.#legs.get(peer) !== leg) return;
    const stream = this.#localStream ?? this.#createStream([]);
    const transceivers = pc.getTransceivers?.();
    if (transceivers) {
      // 🔴 ADR-0424：答方不自己鋪 transceiver，也不用 addTrack；直接放到 offer 帶來的（協商過的）那幾條
      for (const t of transceivers) {
        if (!isNegotiated(t)) continue;
        const kind = kindOf(t);
        t.direction = 'sendrecv';
        const track = kind === 'audio' ? this.#audio : kind === 'video' ? this.#video : null;
        if (track && !t.sender.track) await t.sender.replaceTrack(track);
        t.sender.setStreams?.(stream);
      }
    } else {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    }
    leg.hasRemote = true;
    await this.#flushCandidates(peer, leg);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (this.#legs.get(peer) !== leg) return;
    this.#applyVideoQuality();
    await this.#send(peer, { type: 'group-answer', sdp: answer.sdp ?? '', media: this.#localMedia });
    this.#emitParticipants();
  }

  async #flushCandidates(peer: string, leg: Leg): Promise<void> {
    for (const c of this.#pending.get(peer) ?? []) await leg.pc.addIceCandidate(c).catch(() => {});
    this.#pending.delete(peer);
  }

  #closeLeg(peer: string): void {
    const leg = this.#legs.get(peer);
    this.#pending.delete(peer);
    if (!leg) return;
    this.#legs.delete(peer);
    try {
      leg.pc.close();
    } catch {
      // 已關閉
    }
    this.#fire('remoteStream', peer, null);
  }

  // ── 本地媒體 ─────────────────────────────────────────────────────────────
  /** 取麥克風（與鏡頭）。回來時這一通已結束或已關閉 ⇒ 全部關掉、回 false（H1） */
  async #acquire(media: CallMedia, epoch: number): Promise<boolean> {
    const stream = await this.#getUserMedia({
      audio: true,
      // 不是裸 true（Cinderous ADR-0337）：網狀拓撲每人上傳 N−1 份，畫質上限更要守住
      video: media === 'video' ? videoConstraints(this.#videoQuality, this.#camera) : false,
    });
    const tracks = stream.getTracks();
    if (this.#epoch !== epoch || this.#closed) {
      for (const t of tracks) t.stop();
      return false;
    }
    this.#audio = tracks.find((t) => t.kind === 'audio') ?? null;
    this.#video = tracks.find((t) => t.kind === 'video') ?? null;
    if (this.#audio) this.#audio.enabled = !this.#muted;
    this.#localMedia = this.#video ? 'video' : 'audio';
    this.#wantedMedia = this.#localMedia;
    this.#localStream = this.#createStream(tracks);
    this.#fire('localStream', this.#localStream);
    return true;
  }

  async #openCamera(): Promise<MediaTrackLike> {
    const stream = await this.#getUserMedia({ audio: false, video: videoConstraints(this.#videoQuality, this.#camera) });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('取不到視訊軌');
    return track;
  }

  #videoSender(pc: CallPeerConnectionLike): RtpSenderLike | null {
    const videos = (pc.getTransceivers?.() ?? []).filter((t) => kindOf(t) === 'video' && isNegotiated(t));
    return videos[0]?.sender ?? null;
  }

  async #putVideoOnAllLegs(track: MediaTrackLike | null): Promise<void> {
    for (const [peer, leg] of this.#legs) {
      const sender = this.#videoSender(leg.pc);
      if (!sender) continue;
      try {
        await sender.replaceTrack(track);
      } catch (error) {
        this.#fire('error', `換不了送給 ${peer.slice(0, 8)} 的畫面：${String(error)}`);
      }
    }
  }

  #dropVideo(): void {
    const old = this.#video;
    void this.#putVideoOnAllLegs(null);
    if (old) old.stop(); // 真的關相機，指示燈要誠實
    this.#video = null;
    this.#replaceLocalTrack(null, old);
  }

  /** 本地串流換一條軌：送**新的**串流物件（UI 只在物件變了才重綁） */
  #replaceLocalTrack(add: MediaTrackLike | null, remove: MediaTrackLike | null): void {
    const kept = (this.#localStream?.getTracks() ?? []).filter((t) => t !== remove && t !== add);
    this.#localStream = this.#createStream(add ? [...kept, add] : kept);
    this.#fire('localStream', this.#localStream);
  }

  #applyVideoQuality(): void {
    const profile = videoProfile(this.#videoQuality);
    const legs = [...this.#legs.values()];
    const video = this.#video;
    void (async () => {
      try {
        for (const leg of legs) {
          for (const sender of leg.pc.getSenders()) {
            if (sender.track?.kind !== 'video' || !sender.getParameters || !sender.setParameters) continue;
            const params = sender.getParameters();
            const encodings = params.encodings?.length ? params.encodings : [{}];
            encodings[0]!.maxBitrate = profile.maxBitrate;
            await sender.setParameters({ ...params, encodings, degradationPreference: 'maintain-framerate' });
          }
        }
        await video?.applyConstraints?.(videoConstraints(this.#videoQuality, this.#camera));
      } catch {
        // 畫質是加分項，不是通話前提
      }
    })();
  }

  // ── 收尾 ─────────────────────────────────────────────────────────────────
  #end(reason: GroupCallEndReason): void {
    this.#epoch++;
    for (const peer of [...this.#legs.keys()]) this.#closeLeg(peer);
    this.#clearAllTimers();
    if (this.#localStream) for (const track of this.#localStream.getTracks()) track.stop();
    this.#audio?.stop();
    this.#video?.stop();
    this.#audio = null;
    this.#video = null;
    this.#localStream = null;
    this.#state = 'ended';
    this.#fire('localStream', null);
    this.#fire('ended', reason);
    this.#fire('state', this.#state);
  }

  #clearAllTimers(): void {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    for (const t of this.#connectTimers.values()) clearTimeout(t);
    this.#connectTimers.clear();
    this.#clearIncomingTimer();
  }

  #reset(): void {
    this.#epoch++;
    this.#clearAllTimers();
    this.#reoffers = new Map();
    this.#wantedMedia = 'audio';
    this.#parts = new Map();
    this.#legs = new Map();
    this.#pending = new Map();
    this.#unknownJoins = new Map();
    this.#members = [];
    this.#inviter = null;
    this.#groupId = null;
    this.#localMedia = 'audio';
  }

  /** 邀請我的人（還沒接聽時有意義） */
  get inviter(): string | null {
    return this.#inviter;
  }
}
