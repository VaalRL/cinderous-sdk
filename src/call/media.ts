// 通話執行期用到的 WebRTC 與媒體介面（SDK ADR 0016）：只列 `CallManager` 用到的部分。
// 瀏覽器的 `RTCPeerConnection`、`MediaStream`、`navigator.mediaDevices.getUserMedia` 直接符合；
// 測試與非瀏覽器環境可以注入自己的實作。

export interface MediaTrackLike {
  readonly kind: string;
  /** 靜音用（SDK ADR 0141）：設 false＝送靜音／黑畫面，但裝置還開著 */
  enabled?: boolean;
  stop(): void;
  applyConstraints?(constraints: unknown): Promise<void>;
}

export interface MediaStreamLike {
  getTracks(): MediaTrackLike[];
  getVideoTracks(): MediaTrackLike[];
  addTrack?(track: MediaTrackLike): void;
  removeTrack?(track: MediaTrackLike): void;
}

export interface RtpSenderLike {
  readonly track: MediaTrackLike | null;
  replaceTrack(track: MediaTrackLike | null): Promise<void>;
  getParameters?(): { encodings?: Record<string, unknown>[] };
  setParameters?(params: unknown): Promise<void>;
  /** 補綁 msid（SDK ADR 0141）：舊版對端的 `ontrack` 才拿得到 stream */
  setStreams?(...streams: MediaStreamLike[]): void;
}

export interface RtpTransceiverLike {
  direction: string;
  /**
   * 協商過才有（SDK ADR 0141，Cinderous ADR-0424）：自己 `addTransceiver`、卻沒被遠端 offer 採用的那條恆為 `null`，
   * 從它送出去的畫格對方收不到。沒有這個欄位的環境當作都協商過。
   */
  readonly mid?: string | null;
  stop?(): void;
  readonly sender: RtpSenderLike;
  readonly receiver: { readonly track: MediaTrackLike | null };
}

export interface CallPeerConnectionLike {
  readonly connectionState: string;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  addIceCandidate(candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): Promise<void>;
  addTrack(track: MediaTrackLike, stream: MediaStreamLike): unknown;
  addTransceiver(kind: string, init: { direction: string; streams?: MediaStreamLike[] }): unknown;
  getTransceivers(): RtpTransceiverLike[];
  getSenders(): RtpSenderLike[];
  close(): void;
  onicecandidate: ((event: { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }) => void) | null;
  /** 🔴 `streams` 可能是空的（對方的 transceiver 沒綁 stream）：一定要看 `track`（Cinderous ADR-0424） */
  ontrack: ((event: { streams: readonly MediaStreamLike[]; track?: MediaTrackLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
}

export type CallRtcFactory = (config: { iceServers?: unknown[] }) => CallPeerConnectionLike;
export type GetUserMedia = (constraints: { audio: boolean; video: unknown }) => Promise<MediaStreamLike>;
/** 用一組軌建一個新的串流物件（瀏覽器是 `new MediaStream(tracks)`） */
export type CreateMediaStream = (tracks: MediaTrackLike[]) => MediaStreamLike;

/** 沒有 `MediaStream` 的環境用的最小串流 */
class PlainStream implements MediaStreamLike {
  #tracks: MediaTrackLike[];
  constructor(tracks: MediaTrackLike[]) {
    this.#tracks = [...tracks];
  }
  getTracks() {
    return [...this.#tracks];
  }
  getVideoTracks() {
    return this.#tracks.filter((t) => t.kind === 'video');
  }
  addTrack(track: MediaTrackLike) {
    if (!this.#tracks.includes(track)) this.#tracks.push(track);
  }
  removeTrack(track: MediaTrackLike) {
    this.#tracks = this.#tracks.filter((t) => t !== track);
  }
}

/** 瀏覽器預設 `new MediaStream(tracks)`；沒有就用最小實作 */
export function defaultCreateMediaStream(): CreateMediaStream {
  const Ctor = (globalThis as { MediaStream?: new (tracks: unknown[]) => unknown }).MediaStream;
  return typeof Ctor === 'function' ? (tracks) => new Ctor(tracks) as MediaStreamLike : (tracks) => new PlainStream(tracks);
}

/** 鏡頭忙碌（多數手機不能同時開兩顆）：只有這類錯誤才值得「先關舊的再開新的」（Cinderous ADR-0424） */
export function isCameraBusy(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError';
}

/** 協商過（或環境沒有 mid 可看）、還沒停的 transceiver */
export function isNegotiated(t: RtpTransceiverLike): boolean {
  return t.mid !== null && t.direction !== 'stopped';
}

/** 瀏覽器預設；沒有就回 null，建構 `CallManager` 時要自己注入 */
export function defaultCallRtc(): CallRtcFactory | null {
  const Ctor = (globalThis as { RTCPeerConnection?: new (config: unknown) => unknown }).RTCPeerConnection;
  return typeof Ctor === 'function' ? (config) => new Ctor(config) as CallPeerConnectionLike : null;
}

export function defaultGetUserMedia(): GetUserMedia | null {
  const devices = (globalThis as { navigator?: { mediaDevices?: { getUserMedia?: (c: unknown) => Promise<unknown> } } }).navigator?.mediaDevices;
  return devices?.getUserMedia ? (constraints) => devices.getUserMedia!(constraints) as Promise<MediaStreamLike> : null;
}
