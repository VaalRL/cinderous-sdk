/**
 * 照「瀏覽器真的怎麼做」寫的 WebRTC 替身（SDK ADR 0141）。
 *
 * 舊的 `fake-call-rtc.ts` 照我們對規格的理解寫，Cinderous 2026-11-17 真機驗收（Cinderous ADR-0424）
 * 證明那套理解有四處跟瀏覽器不一樣。這個替身把那四處照實模擬：
 *
 * 1. `addTransceiver` 沒給 `streams` ⇒ 對端 `ontrack` 的 `streams` 是空陣列（只有 `track`）。
 * 2. JSEP：套用遠端 offer 時，只有 `addTrack` 建的 transceiver 會被重用；自己 `addTransceiver` 的那條
 *    不會被 offer 採用，`mid` 恆為 `null`、不在 SDP 裡，從它送出的畫格對方收不到。
 * 3. `addTrack` 重用「第一條」同類、沒上過軌的 transceiver——就算它已經 `stop()`，
 *    也會挑到它然後丟 `InvalidAccessError`，不會跳到下一條。
 * 4. （`RealisticMedia.oneCameraAtATime`）多數手機同時只能開一顆鏡頭：第二顆丟 `NotReadableError`。
 *
 * 「對方收不收得到」不看 ontrack（真的瀏覽器在協商時就給軌，有沒有畫格是另一回事），
 * 而是看 {@link RealisticPc.sends}：我在某條**協商過**的 transceiver 上有活著的軌，對端同一個 mid 的那條在收。
 */
import type {
  CallPeerConnectionLike,
  CallRtcFactory,
  GetUserMedia,
  MediaStreamLike,
  MediaTrackLike,
  RtpSenderLike,
  RtpTransceiverLike,
} from '../../src/call/media.js';

let seq = 0;

export class RTrack implements MediaTrackLike {
  readonly id = `t${seq++}`;
  stopped = false;
  enabled = true;
  constructor(
    readonly kind: string,
    readonly label = '',
  ) {}
  stop() {
    this.stopped = true;
  }
}

export class RStream implements MediaStreamLike {
  readonly id: string;
  tracks: MediaTrackLike[];
  constructor(tracks: MediaTrackLike[] = [], id = `s${seq++}`) {
    this.tracks = [...tracks];
    this.id = id;
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(track: MediaTrackLike) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }
  removeTrack(track: MediaTrackLike) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

class RSender implements RtpSenderLike {
  track: MediaTrackLike | null = null;
  streams: RStream[] = [];
  /** 上過軌的 sender 不再被 addTrack 重用 */
  everUsed = false;
  constructor(private readonly owner: RTransceiver) {}
  async replaceTrack(track: MediaTrackLike | null) {
    if (this.owner.direction === 'stopped') throw new Error('InvalidStateError: transceiver is stopped');
    if (track && track.kind !== this.owner.kind) throw new Error('TypeError: kind mismatch');
    this.track = track;
    if (track) this.everUsed = true;
  }
  setStreams(...streams: MediaStreamLike[]) {
    this.streams = streams as RStream[];
  }
  params: { encodings: Record<string, unknown>[] } = { encodings: [{}] };
  getParameters() {
    return this.params;
  }
  async setParameters(p: unknown) {
    this.params = p as { encodings: Record<string, unknown>[] };
  }
}

export class RTransceiver implements RtpTransceiverLike {
  mid: string | null = null;
  direction: string;
  readonly sender: RSender;
  readonly receiver: { track: RTrack };
  constructor(
    readonly kind: string,
    direction: string,
    readonly createdBy: 'addTrack' | 'addTransceiver' | 'remote',
  ) {
    this.direction = direction;
    this.sender = new RSender(this);
    this.receiver = { track: new RTrack(kind, 'remote') };
  }
  stop() {
    this.direction = 'stopped';
  }
  get sendsMedia() {
    return this.direction === 'sendrecv' || this.direction === 'sendonly';
  }
  get receivesMedia() {
    return this.direction === 'sendrecv' || this.direction === 'recvonly';
  }
}

interface MLine {
  mid: string;
  kind: string;
  /** 送端綁的 stream id（msid）；空＝沒綁 */
  streamIds: string[];
}

export class RealisticPc implements CallPeerConnectionLike {
  readonly id = `pc${seq++}`;
  connectionState = 'new';
  closed = false;
  readonly transceivers: RTransceiver[] = [];
  onicecandidate: CallPeerConnectionLike['onicecandidate'] = null;
  ontrack: CallPeerConnectionLike['ontrack'] = null;
  onconnectionstatechange: (() => void) | null = null;
  /** 我的 offer／answer 裡的 m-line */
  localLines: MLine[] = [];
  remote: RealisticPc | null = null;
  #nextMid = 0;
  /** 收到的遠端軌：id → 對端的 stream 物件（同一個 msid 共用同一個物件，照瀏覽器） */
  readonly #remoteStreams = new Map<string, RStream>();

  constructor(
    private readonly network: RealisticNetwork,
    readonly owner: string,
  ) {
    network.pcs.set(this.id, this);
  }

  async createOffer() {
    return { type: 'offer', sdp: `rtc:${this.id}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `rtc:${this.id}` };
  }
  async setLocalDescription(description: { type: string; sdp?: string }) {
    if (description.type === 'offer') {
      for (const t of this.transceivers) if (t.mid == null && t.direction !== 'stopped') t.mid = String(this.#nextMid++);
    }
    // offer／answer 產生的當下把 msid 拍下來：answer 之後才 setStreams 的，對方看不到
    this.localLines = this.transceivers
      .filter((t) => t.mid != null && t.direction !== 'stopped')
      .map((t) => ({ mid: t.mid!, kind: t.kind, streamIds: t.sender.streams.map((s) => s.id) }));
    setTimeout(() => {
      this.onicecandidate?.({ candidate: { candidate: `candidate:${this.id}`, sdpMid: '0', sdpMLineIndex: 0 } });
      this.onicecandidate?.({ candidate: null });
    }, 0);
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    const other = this.network.pcs.get(description.sdp.slice('rtc:'.length));
    if (!other) throw new Error('unknown remote sdp');
    this.remote = other;
    if (description.type === 'offer') {
      for (const line of other.localLines) {
        // JSEP：只重用 addTrack 建的、還沒有 mid 的同類 transceiver；自己 addTransceiver 的那條不算
        const reuse = this.transceivers.find((t) => t.kind === line.kind && t.mid == null && t.createdBy === 'addTrack' && t.direction !== 'stopped');
        const t = reuse ?? new RTransceiver(line.kind, 'recvonly', 'remote');
        if (!reuse) this.transceivers.push(t);
        t.mid = line.mid;
        this.#fireTrack(t, line);
      }
    } else {
      other.remote = this;
      for (const line of other.localLines) {
        const t = this.transceivers.find((x) => x.mid === line.mid);
        if (t) this.#fireTrack(t, line);
      }
      this.network.link(this, other);
    }
  }
  #fireTrack(t: RTransceiver, line: MLine) {
    const streams = line.streamIds.map((id) => {
      let s = this.#remoteStreams.get(id);
      if (!s) {
        s = new RStream([], `remote-${id}`);
        this.#remoteStreams.set(id, s);
      }
      s.addTrack(t.receiver.track);
      return s;
    });
    this.ontrack?.({ track: t.receiver.track, streams });
  }
  async addIceCandidate() {}
  addTrack(track: MediaTrackLike, stream: MediaStreamLike) {
    const pick = this.transceivers.find((t) => t.kind === track.kind && t.sender.track === null && !t.sender.everUsed);
    if (pick?.direction === 'stopped') throw new Error('InvalidAccessError: The existing transceiver is stopping');
    if (pick) {
      pick.sender.track = track;
      pick.sender.everUsed = true;
      pick.sender.streams = [stream as RStream];
      if (pick.direction === 'recvonly') pick.direction = 'sendrecv';
      return pick.sender;
    }
    const t = new RTransceiver(track.kind, 'sendrecv', 'addTrack');
    t.sender.track = track;
    t.sender.everUsed = true;
    t.sender.streams = [stream as RStream];
    this.transceivers.push(t);
    return t.sender;
  }
  addTransceiver(kind: string, init: { direction: string; streams?: MediaStreamLike[] }) {
    const t = new RTransceiver(kind, init.direction, 'addTransceiver');
    t.sender.streams = (init.streams ?? []) as RStream[];
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  getSenders(): RtpSenderLike[] {
    return this.transceivers.filter((t) => t.direction !== 'stopped').map((t) => t.sender);
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
  setState(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  /** 對方真的收得到我送的這一類媒體嗎（有畫格）？ */
  sends(kind: string): boolean {
    const peer = this.remote;
    if (!peer || this.closed || peer.closed) return false;
    return this.transceivers.some((t) => {
      if (t.kind !== kind || t.mid == null || !t.sendsMedia) return false;
      const track = t.sender.track as RTrack | null;
      if (!track || track.stopped) return false;
      const theirs = peer.transceivers.find((x) => x.mid === t.mid);
      return !!theirs && theirs.receivesMedia;
    });
  }
}

export class RealisticNetwork {
  readonly pcs = new Map<string, RealisticPc>();
  readonly created: RealisticPc[] = [];
  /** 這兩人之間打不通（`'a|b'`，順序不拘） */
  readonly failing = new Set<string>();
  factoryFor(owner: string): CallRtcFactory {
    return () => {
      const pc = new RealisticPc(this, owner);
      this.created.push(pc);
      return pc;
    };
  }
  /** 某兩人之間的那條（還開著的）連線，從 `from` 這邊看 */
  between(from: string, to: string): RealisticPc | undefined {
    return [...this.created].reverse().find((pc) => pc.owner === from && !pc.closed && pc.remote?.owner === to);
  }
  link(a: RealisticPc, b: RealisticPc) {
    setTimeout(() => {
      if (a.closed || b.closed) return;
      const key = [a.owner, b.owner].sort().join('|');
      const state = this.failing.has(key) ? 'failed' : 'connected';
      a.setState(state);
      b.setState(state);
    }, 5);
  }
}

/** getUserMedia 替身：記下每次取用；可模擬「同時只能開一顆鏡頭」（手機） */
export class RealisticMedia {
  readonly calls: { audio: boolean; video: unknown }[] = [];
  readonly cameras: RTrack[] = [];
  oneCameraAtATime = false;
  /** 這些鏡頭（facingMode 或 deviceId）根本打不開 */
  readonly broken = new Set<string>();
  readonly getUserMedia: GetUserMedia = async (constraints) => {
    this.calls.push(constraints);
    const tracks: RTrack[] = [];
    if (constraints.audio) tracks.push(new RTrack('audio', 'mic'));
    if (constraints.video) {
      const v = constraints.video as { facingMode?: { ideal?: string }; deviceId?: { exact?: string } };
      const label = v.deviceId?.exact ?? v.facingMode?.ideal ?? 'user';
      if (this.broken.has(label)) throw Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });
      if (this.oneCameraAtATime && this.cameras.some((c) => !c.stopped)) {
        throw Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });
      }
      const cam = new RTrack('video', label);
      this.cameras.push(cam);
      tracks.push(cam);
    }
    return new RStream(tracks);
  };
  liveCameras(): number {
    return this.cameras.filter((c) => !c.stopped).length;
  }
}

export const createStream = (tracks: MediaTrackLike[]): MediaStreamLike => new RStream(tracks);
