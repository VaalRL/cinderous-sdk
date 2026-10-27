/**
 * 假的 WebRTC 網路（SDK ADR 0009 測試用）：只模擬 `PeerNode` 用到的那些 API。
 * `mode` 決定這個網路上的打洞結果：`ok` 連上、`fail` ICE 失敗、`hang` 一直卡在 checking。
 */
import type {
  RtcDataChannelLike,
  RtcFactory,
  RtcIceCandidateLike,
  RtcPeerConnectionLike,
  RtcSessionDescriptionLike,
} from '../../src/peer/rtc.js';

export type FakeIceMode = 'ok' | 'fail' | 'hang';

export class FakeDataChannel implements RtcDataChannelLike {
  readyState: string = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  peer?: FakeDataChannel;
  readonly sent: Uint8Array[] = [];

  constructor(readonly label: string) {}

  send(data: Uint8Array): void {
    if (this.readyState !== 'open') throw new Error('DataChannel 還沒開');
    this.sent.push(data);
    const copy = data.slice();
    const peer = this.peer;
    queueMicrotask(() => peer?.onmessage?.({ data: copy.buffer }));
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    this.peer?.close();
  }
}

let nextId = 0;

export class FakePeerConnection implements RtcPeerConnectionLike {
  readonly id = `pc${nextId++}`;
  iceConnectionState: string = 'new';
  localDescription: RtcSessionDescriptionLike | null = null;
  remoteDescription: RtcSessionDescriptionLike | null = null;
  channel?: FakeDataChannel;
  readonly candidatesAdded: RtcIceCandidateLike[] = [];
  closed = false;
  onicecandidate: ((event: { candidate: RtcIceCandidateLike | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null = null;

  constructor(
    private readonly network: FakeRtcNetwork,
    readonly config: { iceServers?: unknown[] },
  ) {
    network.peers.set(this.id, this);
  }

  createDataChannel(label: string): RtcDataChannelLike {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  }

  async createOffer(): Promise<RtcSessionDescriptionLike> {
    return { type: 'offer', sdp: `fake:${this.id}` };
  }

  async createAnswer(): Promise<RtcSessionDescriptionLike> {
    return { type: 'answer', sdp: `fake:${this.id}` };
  }

  async setLocalDescription(description: RtcSessionDescriptionLike): Promise<void> {
    this.localDescription = description;
    setTimeout(() => {
      this.onicecandidate?.({ candidate: { candidate: `candidate:${this.id}`, sdpMid: '0', sdpMLineIndex: 0 } });
      this.onicecandidate?.({ candidate: null });
    }, 0);
  }

  async setRemoteDescription(description: RtcSessionDescriptionLike): Promise<void> {
    this.remoteDescription = description;
    if (description.type === 'answer') {
      const answerer = this.network.peers.get(String(description.sdp).slice('fake:'.length));
      if (answerer) this.network.link(this, answerer);
    }
  }

  async addIceCandidate(candidate: RtcIceCandidateLike): Promise<void> {
    this.candidatesAdded.push(candidate);
  }

  setIceState(state: string): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }

  close(): void {
    this.closed = true;
    this.iceConnectionState = 'closed';
    this.channel?.close();
  }
}

export class FakeRtcNetwork {
  mode: FakeIceMode = 'ok';
  readonly peers = new Map<string, FakePeerConnection>();
  readonly created: FakePeerConnection[] = [];

  readonly factory: RtcFactory = (config) => {
    const pc = new FakePeerConnection(this, config);
    this.created.push(pc);
    return pc;
  };

  /** 兩端都交換完描述後，依 `mode` 決定打洞結果 */
  link(offerer: FakePeerConnection, answerer: FakePeerConnection): void {
    setTimeout(() => {
      if (offerer.closed || answerer.closed) return;
      if (this.mode === 'hang') {
        offerer.setIceState('checking');
        answerer.setIceState('checking');
        return;
      }
      if (this.mode === 'fail') {
        offerer.setIceState('failed');
        answerer.setIceState('failed');
        return;
      }
      offerer.setIceState('connected');
      answerer.setIceState('connected');
      const local = offerer.channel;
      if (!local) return;
      const remote = new FakeDataChannel(local.label);
      local.peer = remote;
      remote.peer = local;
      answerer.channel = remote;
      answerer.ondatachannel?.({ channel: remote });
      local.open();
      remote.open();
    }, 5);
  }
}
