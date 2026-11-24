// 一對一 CallManager 對照 Cinderous 2026-11-17 真機發現（Cinderous ADR-0424；SDK ADR 0141 §一對一）。
// 用照瀏覽器真實行為寫的替身（realistic-rtc.ts）；舊替身照我們的理解寫，這幾個問題它都測不到。
import { afterEach, describe, expect, it } from 'vitest';

import { CallManager } from '../../src/call/call-manager.js';
import type { MediaStreamLike } from '../../src/call/media.js';
import { Identity } from '../../src/identity.js';
import { generateSecretKey, nsecEncode } from '../../src/protocol/index.js';
import { FakeTransport } from '../fake-transport.js';
import { createStream, RealisticMedia, RealisticNetwork } from './realistic-rtc.js';

const managers: CallManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
});

async function until(check: () => boolean, ms = 2_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('等不到條件成立');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function setup() {
  const transport = new FakeTransport();
  transport.relay = true;
  const network = new RealisticNetwork();
  const alice = Identity.fromNsec(nsecEncode(generateSecretKey()));
  const bob = Identity.fromNsec(nsecEncode(generateSecretKey()));
  const make = (identity: Identity) => {
    const media = new RealisticMedia();
    const m = new CallManager({
      identity,
      transport,
      rtc: network.factoryFor(identity.pubkey),
      getUserMedia: media.getUserMedia,
      createStream,
    });
    managers.push(m);
    const remote: (MediaStreamLike | null)[] = [];
    const local: (MediaStreamLike | null)[] = [];
    m.onRemoteStream((s) => remote.push(s));
    m.onLocalStream((s) => local.push(s));
    return { m, media, remote, local };
  };
  return { transport, network, alice, bob, A: make(alice), B: make(bob) };
}

const hasVideo = (s: MediaStreamLike | null | undefined) => !!s && s.getVideoTracks().length > 0;

async function connect(env: ReturnType<typeof setup>, media: 'audio' | 'video') {
  const ringing = new Promise((r) => env.B.m.onIncoming(r));
  await env.A.m.startCall(env.bob.pubkey, media);
  await ringing;
  await env.B.m.accept();
  await until(() => env.A.m.state === 'active' && env.B.m.state === 'active');
}

describe('一對一通話：Cinderous ADR-0424 的真機問題在 SDK 不能重演', () => {
  it('🔴 一開始就是視訊通話：接聽方的畫面真的送得出去（不是放在沒協商的那條）', async () => {
    const env = setup();
    await connect(env, 'video');
    expect(env.network.between(env.alice.pubkey, env.bob.pubkey)!.sends('video')).toBe(true);
    expect(env.network.between(env.bob.pubkey, env.alice.pubkey)!.sends('video')).toBe(true);
    await until(() => hasVideo(env.A.remote.at(-1)));
  });

  it('通話中才開的視訊（撥號方開）：接聽方的遠端串流有視訊軌（對方沒綁 stream 也要收）', async () => {
    const env = setup();
    await connect(env, 'audio');
    await env.A.m.setLocalMedia('video');
    expect(env.network.between(env.alice.pubkey, env.bob.pubkey)!.sends('video')).toBe(true);
    await until(() => hasVideo(env.B.remote.at(-1)));
  });

  it('🔴 接聽方通話中開視訊：送得出去', async () => {
    const env = setup();
    await connect(env, 'audio');
    expect(env.B.m.canChangeMedia()).toBe(true);
    await env.B.m.setLocalMedia('video');
    expect(env.network.between(env.bob.pubkey, env.alice.pubkey)!.sends('video')).toBe(true);
    await until(() => hasVideo(env.A.remote.at(-1)));
  });

  it('開／關視訊都送出新的本地串流物件（UI 才會重新綁 srcObject）', async () => {
    const env = setup();
    await connect(env, 'audio');
    const before = env.A.local.at(-1);
    await env.A.m.setLocalMedia('video');
    const withVideo = env.A.local.at(-1);
    expect(withVideo).not.toBe(before);
    expect(hasVideo(withVideo)).toBe(true);
    await env.A.m.setLocalMedia('audio');
    const audioOnly = env.A.local.at(-1);
    expect(audioOnly).not.toBe(withVideo);
    expect(hasVideo(audioOnly)).toBe(false);
    expect(env.A.media.liveCameras()).toBe(0);
  });
});

describe('一對一通話：程式碼審查（2026-11-18）——非同步操作晚回來', () => {
  it('🔴 接聽時還在等權限，對方就掛斷了：權限回來後麥克風與鏡頭都關掉', async () => {
    const env = setup();
    const ringing = new Promise((r) => env.B.m.onIncoming(r));
    await env.A.m.startCall(env.bob.pubkey, 'video');
    await ringing;
    env.B.media.holdPermission();
    const accepting = env.B.m.accept();
    await until(() => env.B.media.calls.length === 1); // 真的卡在權限提示（不是根本沒取）
    await env.A.m.hangup();
    await until(() => env.B.m.state === 'idle' || env.B.m.state === 'ended');
    env.B.media.release();
    await accepting;
    expect(env.B.media.liveDevices()).toBe(0);
  });

  it('🔴 開視訊時還在等鏡頭，又按了關：最後是語音、鏡頭沒開著、對方最後聽到的是語音', async () => {
    const env = setup();
    await connect(env, 'audio');
    env.A.media.holdPermission();
    const on = env.A.m.setLocalMedia('video');
    const off = env.A.m.setLocalMedia('audio');
    env.A.media.release();
    await Promise.all([on, off]);
    expect(env.A.m.localMedia).toBe('audio');
    expect(env.A.media.liveCameras()).toBe(0);
    expect(env.network.between(env.alice.pubkey, env.bob.pubkey)!.sends('video')).toBe(false);
  });

  it('🔴 開視訊時還在等鏡頭，通話就結束了：鏡頭不能留著亮', async () => {
    const env = setup();
    await connect(env, 'audio');
    env.A.media.holdPermission();
    const on = env.A.m.setLocalMedia('video');
    await env.B.m.hangup();
    await until(() => env.A.m.state === 'idle' || env.A.m.state === 'ended');
    env.A.media.release();
    await on;
    expect(env.A.media.liveDevices()).toBe(0);
  });
});
