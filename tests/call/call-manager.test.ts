// 音訊／視訊通話執行期（SDK ADR 0016）。
import { afterEach, describe, expect, it } from 'vitest';

import { CallManager, type CallManagerOptions } from '../../src/call/call-manager.js';
import { Identity } from '../../src/identity.js';
import { CALL_SIGNAL_KIND, createCallSignal, generateSecretKey, nsecEncode, readCallSignal } from '../../src/protocol/index.js';
import { FakeTransport } from '../fake-transport.js';
import { FakeCallNetwork, type FakeCallPc, FakeStream } from './fake-call-rtc.js';

const managers: CallManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
});

function setup(options: Partial<CallManagerOptions> = {}) {
  const transport = new FakeTransport();
  transport.relay = true;
  const network = new FakeCallNetwork();
  const make = (identity: Identity, extra: Partial<CallManagerOptions> = {}) => {
    const m = new CallManager({ identity, transport, rtc: network.factory, getUserMedia: network.getUserMedia, ...options, ...extra });
    managers.push(m);
    return m;
  };
  const aliceSk = generateSecretKey();
  const bobSk = generateSecretKey();
  const alice = Identity.fromNsec(nsecEncode(aliceSk));
  const bob = Identity.fromNsec(nsecEncode(bobSk));
  return { transport, network, alice, bob, aliceSk, bobSk, a: make(alice), b: make(bob), make };
}

async function until(check: () => boolean, ms = 2_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('等不到條件成立');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const incoming = (m: CallManager) => new Promise<{ peer: string; media: string }>((resolve) => m.onIncoming(resolve));

describe('通話生命週期', () => {
  it('語音：撥號 → 對方響鈴 → 接聽 → 雙方 active，各自收到對方的串流', async () => {
    const { a, b, alice, bob, network } = setup();
    const ringing = incoming(b);
    const remoteAtA: unknown[] = [];
    a.onRemoteStream((s) => remoteAtA.push(s));
    await a.startCall(bob.pubkey, 'audio');
    expect(await ringing).toEqual({ peer: alice.pubkey, media: 'audio' });
    expect(b.state).toBe('incoming');

    await b.accept();
    await until(() => a.state === 'active' && b.state === 'active');
    expect(remoteAtA.at(-1)).toBeInstanceOf(FakeStream);
    // 語音通話不開相機
    expect(network.media.every((m) => m.constraints.video === false)).toBe(true);
  });

  it('視訊：取相機用畫質檔位的限制，不是裸 true（Cinderous ADR-0337）', async () => {
    const { a, b, bob, network } = setup();
    const ringing = incoming(b);
    await a.startCall(bob.pubkey, 'video');
    await ringing;
    await b.accept();
    await until(() => a.state === 'active' && b.state === 'active');
    for (const m of network.media) {
      expect(m.constraints.video).not.toBe(true);
      expect(typeof m.constraints.video).toBe('object');
    }
  });

  it('拒接：撥號方收到 ended（declined），相機麥克風都關掉', async () => {
    const { a, b, bob, network } = setup();
    const ended: string[] = [];
    a.onEnded((reason) => ended.push(reason));
    const ringing = incoming(b);
    await a.startCall(bob.pubkey, 'audio');
    await ringing;
    await b.reject();
    await until(() => ended.length > 0);
    expect(ended).toEqual(['declined']);
    expect(network.media[0]!.stream.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('通話中掛斷：雙方都結束，所有軌道都停掉', async () => {
    const { a, b, bob, network } = setup();
    const ringing = incoming(b);
    await a.startCall(bob.pubkey, 'audio');
    await ringing;
    await b.accept();
    await until(() => a.state === 'active' && b.state === 'active');
    await a.hangup();
    await until(() => b.state === 'ended' || b.state === 'idle');
    expect(network.media.every((m) => m.stream.tracks.every((t) => t.stopped))).toBe(true);
    expect(network.created.every((pc) => pc.closed)).toBe(true);
  });

  it('忙線：已在通話中，第三人打來 → 對方收到 busy，原本的通話不受影響', async () => {
    const { a, b, bob, make } = setup();
    const ringing = incoming(b);
    await a.startCall(bob.pubkey, 'audio');
    await ringing;
    await b.accept();
    await until(() => b.state === 'active');

    const carol = make(Identity.generate());
    const ended: string[] = [];
    carol.onEnded((reason) => ended.push(reason));
    await carol.startCall(bob.pubkey, 'audio');
    await until(() => ended.length > 0);
    expect(ended).toEqual(['busy']);
    expect(b.state).toBe('active');
  });
});

describe('連線失敗（Cinderous ADR-0243）', () => {
  it('從未打通 → 雙方 onFailed(unreachable)，並乾淨結束', async () => {
    const { a, b, bob, network } = setup();
    network.mode = 'fail';
    const failures: string[] = [];
    a.onFailed((_peer, reason) => failures.push(reason));
    const ringing = incoming(b);
    await a.startCall(bob.pubkey, 'audio');
    await ringing;
    await b.accept();
    await until(() => failures.length > 0 && (b.state === 'ended' || b.state === 'idle'));
    expect(failures).toEqual(['unreachable']);
  });

  it('連上之後斷線 → onFailed(lost)', async () => {
    const { a, b, bob, network } = setup();
    const failures: string[] = [];
    a.onFailed((_peer, reason) => failures.push(reason));
    const ringing = incoming(b);
    await a.startCall(bob.pubkey, 'audio');
    await ringing;
    await b.accept();
    await until(() => a.state === 'active');
    (network.created[0] as FakeCallPc).setState('failed');
    await until(() => failures.length > 0);
    expect(failures).toEqual(['lost']);
  });
});

describe('通話中切換語音／視訊（Cinderous ADR-0338）', () => {
  async function activeCall() {
    const s = setup();
    const ringing = incoming(s.b);
    await s.a.startCall(s.bob.pubkey, 'audio');
    await ringing;
    await s.b.accept();
    await until(() => s.a.state === 'active' && s.b.state === 'active');
    return s;
  }

  it('🔴 答方把自動建立的 recvonly 視訊 transceiver 改成 sendrecv（否則永遠送不出視訊）', async () => {
    const { network } = await activeCall();
    const answererPc = network.created[1] as FakeCallPc;
    expect(answererPc.videoTransceiver()?.direction).toBe('sendrecv');
  });

  it('升級成視訊：取相機 → 換到既有的視訊 sender → 對方看到我在送視訊；不重新協商', async () => {
    const { a, b, network } = await activeCall();
    const remoteMedia: string[] = [];
    b.onMedia((_local, remote) => remoteMedia.push(remote));
    expect(a.canChangeMedia()).toBe(true);
    await a.setLocalMedia('video');
    await until(() => remoteMedia.at(-1) === 'video');
    const callerPc = network.created[0] as FakeCallPc;
    expect(callerPc.videoTransceiver()?.sender.track?.kind).toBe('video');
    expect(a.localMedia).toBe('video');
  });

  it('🔴 相機權限被拒 → 型態改回去、不通知對方（對方不會等一個永遠不來的畫面）', async () => {
    const { a, b, network, transport } = await activeCall();
    const errors: string[] = [];
    a.onError((e) => errors.push(e));
    const before = transport.published.length;
    network.denyNext = true;
    await a.setLocalMedia('video');
    expect(a.localMedia).toBe('audio');
    expect(errors).toHaveLength(1);
    expect(transport.published.length).toBe(before); // 沒送任何 call-media
    expect(b.remoteMedia).toBe('audio');
  });

  it('降級成語音：卸下視訊軌並真的停掉相機', async () => {
    const { a, network } = await activeCall();
    await a.setLocalMedia('video');
    const camera = (network.created[0] as FakeCallPc).videoTransceiver()!.sender.track!;
    await a.setLocalMedia('audio');
    expect((camera as unknown as { stopped: boolean }).stopped).toBe(true);
    expect((network.created[0] as FakeCallPc).videoTransceiver()!.sender.track).toBeNull();
  });
});

describe('信令', () => {
  it('🔴 kind 21002 的 NIP-59：外層看不出撥號者；格式與 Cinderous 相同（對方用 readCallSignal 讀得懂）', async () => {
    const { a, bob, bobSk, alice, transport } = setup();
    await a.startCall(bob.pubkey, 'audio');
    const invite = transport.published.find((e) => e.kind === CALL_SIGNAL_KIND)!;
    expect(invite.pubkey).not.toBe(alice.pubkey);
    expect(invite.tags).toContainEqual(['p', bob.pubkey]);
    const read = readCallSignal(invite, bobSk);
    expect(read.sender).toBe(alice.pubkey);
    expect(read.signal.type).toBe('call-invite');
  });

  it('Cinderous 送來的通話邀請，SDK 也接得起來', async () => {
    const { b, bob, transport } = setup();
    const ringing = incoming(b);
    const cinderousSk = generateSecretKey();
    transport.deliver(createCallSignal({ type: 'call-invite', callId: 'nb-call-1-0', media: 'audio', sdp: 'fake:none' }, cinderousSk, bob.pubkey));
    expect((await ringing).media).toBe('audio');
  });

  it('封鎖的人打來 → 不響鈴、不回應；陌生人照常響', async () => {
    const { bob, alice, make, transport } = setup();
    const guarded = make(Identity.fromNsec(bob.nsec()), { isBlocked: (pk) => pk === alice.pubkey });
    const callers: string[] = [];
    guarded.onIncoming(({ peer }) => callers.push(peer));

    await make(alice).startCall(bob.pubkey, 'audio');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callers).not.toContain(alice.pubkey);

    const stranger = generateSecretKey();
    transport.deliver(createCallSignal({ type: 'call-invite', callId: 'x', media: 'audio', sdp: 'fake:none' }, stranger, bob.pubkey));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callers).toHaveLength(1);
  });
});
