/**
 * 假的通話 WebRTC 與媒體（SDK ADR 0016 測試用）。
 * `mode`：`ok` 連上、`fail` 從未打通就失敗、`lost` 連上之後斷線（由測試呼叫 `drop()`）。
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

export class FakeTrack implements MediaTrackLike {
  stopped = false;
  constructor(readonly kind: string) {}
  stop() {
    this.stopped = true;
  }
}

export class FakeStream implements MediaStreamLike {
  constructor(public tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(track: MediaTrackLike) {
    this.tracks.push(track as FakeTrack);
  }
  removeTrack(track: MediaTrackLike) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

class FakeSender implements RtpSenderLike {
  constructor(public track: MediaTrackLike | null) {}
  async replaceTrack(track: MediaTrackLike | null) {
    this.track = track;
  }
}

class FakeTransceiver implements RtpTransceiverLike {
  readonly sender: FakeSender;
  readonly receiver: { track: MediaTrackLike | null };
  constructor(
    public direction: string,
    kind: string,
  ) {
    this.sender = new FakeSender(null);
    this.receiver = { track: new FakeTrack(kind) };
  }
}

let nextId = 0;

export class FakeCallPc implements CallPeerConnectionLike {
  readonly id = `call-pc${nextId++}`;
  connectionState = 'new';
  closed = false;
  readonly tracks: MediaTrackLike[] = [];
  readonly transceivers: FakeTransceiver[] = [];
  readonly senders: FakeSender[] = [];
  readonly candidatesAdded: unknown[] = [];
  onicecandidate: CallPeerConnectionLike['onicecandidate'] = null;
  ontrack: CallPeerConnectionLike['ontrack'] = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(private readonly network: FakeCallNetwork) {
    network.pcs.set(this.id, this);
  }

  async createOffer() {
    return { type: 'offer', sdp: `fake:${this.id}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `fake:${this.id}` };
  }
  async setLocalDescription() {
    setTimeout(() => {
      this.onicecandidate?.({ candidate: { candidate: `candidate:${this.id}`, sdpMid: '0', sdpMLineIndex: 0 } });
      this.onicecandidate?.({ candidate: null });
    }, 0);
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    if (description.type === 'offer' && !this.transceivers.some((t) => t.receiver.track?.kind === 'video')) {
      // 真的瀏覽器：答方為對方的視訊 m-line 自動建立 recvonly 的 transceiver（ADR-0338 §3 的坑）
      this.transceivers.push(new FakeTransceiver('recvonly', 'video'));
    }
    if (description.type === 'answer') {
      const answerer = this.network.pcs.get(description.sdp.slice('fake:'.length));
      if (answerer) this.network.link(this, answerer);
    }
  }
  async addIceCandidate(candidate: unknown) {
    this.candidatesAdded.push(candidate);
  }
  addTrack(track: MediaTrackLike) {
    this.tracks.push(track);
    this.senders.push(new FakeSender(track));
  }
  addTransceiver(kind: string, init: { direction: string }) {
    this.transceivers.push(new FakeTransceiver(init.direction, kind));
  }
  getTransceivers() {
    return this.transceivers;
  }
  getSenders(): RtpSenderLike[] {
    return [...this.senders, ...this.transceivers.map((t) => t.sender)];
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
  setState(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  videoTransceiver() {
    return this.transceivers.find((t) => t.receiver.track?.kind === 'video');
  }
}

export class FakeCallNetwork {
  mode: 'ok' | 'fail' = 'ok';
  readonly pcs = new Map<string, FakeCallPc>();
  readonly created: FakeCallPc[] = [];
  readonly factory: CallRtcFactory = () => {
    const pc = new FakeCallPc(this);
    this.created.push(pc);
    return pc;
  };
  readonly media: { constraints: { audio: boolean; video: unknown }; stream: FakeStream }[] = [];
  /** 下一次 getUserMedia 要失敗（例如使用者不給相機權限） */
  denyNext = false;
  readonly getUserMedia: GetUserMedia = async (constraints) => {
    if (this.denyNext) {
      this.denyNext = false;
      throw new Error('NotAllowedError');
    }
    const tracks = [...(constraints.audio ? [new FakeTrack('audio')] : []), ...(constraints.video ? [new FakeTrack('video')] : [])];
    const stream = new FakeStream(tracks);
    this.media.push({ constraints, stream });
    return stream;
  };

  link(offerer: FakeCallPc, answerer: FakeCallPc) {
    setTimeout(() => {
      if (offerer.closed || answerer.closed) return;
      if (this.mode === 'fail') {
        offerer.setState('failed');
        answerer.setState('failed');
        return;
      }
      offerer.setState('connected');
      answerer.setState('connected');
      offerer.ontrack?.({ streams: [new FakeStream(answerer.tracks as FakeTrack[])] });
      answerer.ontrack?.({ streams: [new FakeStream(offerer.tracks as FakeTrack[])] });
    }, 5);
  }
}
