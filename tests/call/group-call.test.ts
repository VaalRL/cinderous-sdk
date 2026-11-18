// 網狀小群組通話（SDK ADR 0141）：用照瀏覽器真實行為寫的替身（realistic-rtc.ts）。
import { afterEach, describe, expect, it } from 'vitest';

import { CallManager } from '../../src/call/call-manager.js';
import { GroupCallManager, type GroupCallManagerOptions } from '../../src/call/group-call.js';
import type { MediaStreamLike } from '../../src/call/media.js';
import { Identity } from '../../src/identity.js';
import { generateSecretKey, nsecEncode } from '../../src/protocol/index.js';
import { FakeTransport } from '../fake-transport.js';
import { createStream, RealisticMedia, RealisticNetwork, type RTrack } from './realistic-rtc.js';

const closers: { close(): void }[] = [];
afterEach(() => {
  for (const m of closers.splice(0)) m.close();
});

async function until(check: () => boolean, ms = 3_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('等不到條件成立');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Person {
  id: Identity;
  pk: string;
  m: GroupCallManager;
  media: RealisticMedia;
  remote: Map<string, MediaStreamLike | null>;
  local: (MediaStreamLike | null)[];
  incoming: { groupId: string; from: string; members: string[]; media: string }[];
  ended: string[];
  failed: [string, string][];
}

function world(extra: Partial<GroupCallManagerOptions> = {}) {
  const transport = new FakeTransport();
  transport.relay = true;
  const network = new RealisticNetwork();
  const person = (opts: Partial<GroupCallManagerOptions> = {}): Person => {
    const id = Identity.fromNsec(nsecEncode(generateSecretKey()));
    const media = new RealisticMedia();
    const m = new GroupCallManager({
      identity: id,
      transport,
      rtc: network.factoryFor(id.pubkey),
      getUserMedia: media.getUserMedia,
      createStream,
      ringTimeoutMs: 400,
      ...extra,
      ...opts,
    });
    closers.push(m);
    const p: Person = { id, pk: id.pubkey, m, media, remote: new Map(), local: [], incoming: [], ended: [], failed: [] };
    m.onRemoteStream((peer, s) => p.remote.set(peer, s));
    m.onLocalStream((s) => p.local.push(s));
    m.onIncoming((call) => p.incoming.push(call));
    m.onEnded((r) => p.ended.push(r));
    m.onPeerFailed((peer, r) => p.failed.push([peer, r]));
    return p;
  };
  const status = (p: Person, of: Person) => p.m.participants().find((x) => x.pubkey === of.pk)?.status;
  const sends = (from: Person, to: Person, kind: string) => network.between(from.pk, to.pk)?.sends(kind) ?? false;
  return { transport, network, person, status, sends };
}

const hasVideo = (s: MediaStreamLike | null | undefined) => !!s && s.getVideoTracks().length > 0;
const hasAudio = (s: MediaStreamLike | null | undefined) => !!s && s.getTracks().some((t) => t.kind === 'audio');

async function threeWay(w: ReturnType<typeof world>, media: 'audio' | 'video') {
  const a = w.person();
  const b = w.person();
  const c = w.person();
  await a.m.start([b.pk, c.pk], media);
  await until(() => b.incoming.length > 0 && c.incoming.length > 0);
  await b.m.accept();
  await c.m.accept();
  const all = [a, b, c];
  await until(() => all.every((x) => all.every((y) => x === y || w.status(x, y) === 'connected')));
  return { a, b, c, all };
}

describe('網狀小群組通話', () => {
  it('三人語音：每一對都直連、只有一條連線（字典序小的發 offer，沒有 glare），每人聽得到另外兩人', async () => {
    const w = world();
    const { all } = await threeWay(w, 'audio');
    for (const x of all) for (const y of all) if (x !== y) expect(w.sends(x, y, 'audio'), 'audio').toBe(true);
    // 每對兩端各一條 pc ⇒ 3 對 × 2 = 6
    expect(w.network.created.filter((pc) => !pc.closed)).toHaveLength(6);
    for (const x of all) for (const y of all) if (x !== y) await until(() => hasAudio(x.remote.get(y.pk)));
    // 一份麥克風分送給所有人：每人只取一次
    for (const x of all) expect(x.media.calls).toHaveLength(1);
  });

  it('🔴 三人視訊：每一對兩個方向都送得出畫面（接聽方不能放在沒協商的那條），對方沒綁 stream 也收得到', async () => {
    const w = world();
    const { all } = await threeWay(w, 'video');
    for (const x of all) for (const y of all) if (x !== y) expect(w.sends(x, y, 'video'), 'video').toBe(true);
    for (const x of all) for (const y of all) if (x !== y) await until(() => hasVideo(x.remote.get(y.pk)));
    // 一顆鏡頭分送給所有連線
    for (const x of all) expect(x.media.liveCameras()).toBe(1);
  });

  it('關鏡頭對所有連線生效、相機真的關；再開也對所有人生效，本地串流每次都是新物件', async () => {
    const w = world();
    const { a, b, c } = await threeWay(w, 'audio');
    const before = a.local.at(-1);
    await a.m.setLocalMedia('video');
    expect(a.local.at(-1)).not.toBe(before);
    expect(w.sends(a, b, 'video') && w.sends(a, c, 'video')).toBe(true);
    expect(a.media.liveCameras()).toBe(1);
    await until(() => b.m.participants().find((p) => p.pubkey === a.pk)?.media === 'video');
    await a.m.setLocalMedia('audio');
    expect(w.sends(a, b, 'video') || w.sends(a, c, 'video')).toBe(false);
    expect(a.media.liveCameras()).toBe(0);
    expect(hasVideo(a.local.at(-1))).toBe(false);
  });

  it('靜音：麥克風軌 enabled=false（裝置不關），解除後恢復', async () => {
    const w = world();
    const { a } = await threeWay(w, 'audio');
    const mic = a.local.at(-1)!.getTracks().find((t) => t.kind === 'audio') as RTrack;
    a.m.setMuted(true);
    expect(mic.enabled).toBe(false);
    expect(mic.stopped).toBe(false);
    a.m.setMuted(false);
    expect(mic.enabled).toBe(true);
  });

  it('某一對打不通只影響那一對：其他人照常通話', async () => {
    const w = world();
    const a = w.person();
    const b = w.person();
    const c = w.person();
    w.network.failing.add([b.pk, c.pk].sort().join('|'));
    await a.m.start([b.pk, c.pk], 'audio');
    await until(() => b.incoming.length > 0 && c.incoming.length > 0);
    await b.m.accept();
    await c.m.accept();
    await until(() => w.status(b, c) === 'failed' && w.status(c, b) === 'failed');
    expect(b.failed).toEqual([[c.pk, 'unreachable']]);
    await until(() => w.status(a, b) === 'connected' && w.status(a, c) === 'connected');
    expect(a.m.state).toBe('in-call');
    expect(b.m.state).toBe('in-call');
  });

  it('有人離開：其他人看到 left、他的串流變 null、其餘照常；最後只剩自己就結束（empty）', async () => {
    const w = world();
    const { a, b, c } = await threeWay(w, 'audio');
    await c.m.leave();
    expect(c.ended).toEqual(['left']);
    await until(() => w.status(a, c) === 'left' && w.status(b, c) === 'left');
    expect(a.remote.get(c.pk)).toBeNull();
    expect(w.sends(a, b, 'audio')).toBe(true);
    await b.m.leave();
    await until(() => a.ended.length > 0);
    expect(a.ended).toEqual(['empty']);
    expect(a.media.calls.length).toBe(1);
    expect(a.local.at(-1)).toBeNull();
  });

  it('拒接、忙線：邀請方看到對應狀態；全部都不來就結束', async () => {
    const w = world();
    const a = w.person();
    const b = w.person();
    const c = w.person({ isBusy: () => true });
    await a.m.start([b.pk, c.pk], 'audio');
    await until(() => b.incoming.length > 0);
    expect(c.incoming).toHaveLength(0);
    await b.m.reject();
    expect(b.ended).toEqual(['declined']);
    await until(() => w.status(a, b) === 'declined' && w.status(a, c) === 'busy');
    await until(() => a.ended.length > 0);
    expect(a.ended).toEqual(['empty']);
  });

  it('超過上限不能開；硬上限 6 也不能用設定繞過', async () => {
    const w = world();
    const a = w.person();
    const others = [1, 2, 3, 4].map(() => w.person().pk);
    await expect(a.m.start(others, 'audio')).rejects.toThrow();
    expect(() => w.person({ maxParticipants: 7 })).toThrow();
  });

  it('🔴 相容：只懂一對一的對端（CallManager）收到群組邀請不會響鈴；邀請方等到逾時標 no-answer', async () => {
    const w = world();
    const a = w.person();
    const oldId = Identity.fromNsec(nsecEncode(generateSecretKey()));
    const media = new RealisticMedia();
    const old = new CallManager({ identity: oldId, transport: w.transport, rtc: w.network.factoryFor(oldId.pubkey), getUserMedia: media.getUserMedia });
    closers.push(old);
    let rang = false;
    old.onIncoming(() => (rang = true));
    await a.m.start([oldId.pubkey], 'audio');
    await until(() => a.m.participants().find((p) => p.pubkey === oldId.pubkey)?.status === 'no-answer');
    expect(rang).toBe(false);
    expect(old.state).toBe('idle');
    await until(() => a.ended.length > 0);
    expect(a.ended).toEqual(['empty']);
  });

  it('通話中再邀一位：新成員和每個人都連上', async () => {
    const w = world();
    const a = w.person();
    const b = w.person();
    await a.m.start([b.pk], 'audio');
    await until(() => b.incoming.length > 0);
    await b.m.accept();
    await until(() => w.status(a, b) === 'connected');
    const c = w.person();
    await a.m.invite(c.pk);
    await until(() => c.incoming.length > 0);
    expect(c.incoming[0]!.members.sort()).toEqual([a.pk, b.pk, c.pk].sort());
    await c.m.accept();
    await until(() => w.status(c, a) === 'connected' && w.status(c, b) === 'connected' && w.status(b, c) === 'connected');
  });

  it('🔴 手機翻鏡頭（同時只能開一顆）：先停舊的再開新的，所有連線換上新鏡頭、從不同時開兩顆', async () => {
    const w = world();
    const a = w.person();
    a.media.oneCameraAtATime = true;
    const b = w.person();
    const c = w.person();
    await a.m.start([b.pk, c.pk], 'video');
    await until(() => b.incoming.length > 0 && c.incoming.length > 0);
    await b.m.accept();
    await c.m.accept();
    await until(() => w.status(a, b) === 'connected' && w.status(a, c) === 'connected');
    await a.m.setCamera({ facingMode: 'environment' });
    expect(a.media.liveCameras()).toBe(1);
    const live = a.media.cameras.find((t) => !t.stopped)!;
    expect(live.label).toBe('environment');
    expect(w.sends(a, b, 'video') && w.sends(a, c, 'video')).toBe(true);
    // 新鏡頭打不開：重開原本那顆，畫面不中斷
    a.media.broken.add('user');
    a.media.broken.add('broken-cam');
    await a.m.setCamera({ deviceId: 'broken-cam' });
    expect(a.media.liveCameras()).toBe(1);
    expect(a.media.cameras.find((t) => !t.stopped)!.label).toBe('environment');
    expect(w.sends(a, b, 'video')).toBe(true);
  });

  it('封鎖的人邀我：不響鈴', async () => {
    const w = world();
    const a = w.person();
    const b = w.person({ isBlocked: () => true });
    await a.m.start([b.pk], 'audio');
    await new Promise((r) => setTimeout(r, 50));
    expect(b.incoming).toHaveLength(0);
  });

  it('群組通話中有人一對一打來：CallManager 用 isBusy 回忙線', async () => {
    const w = world();
    const a = w.person();
    const b = w.person();
    await a.m.start([b.pk], 'audio');
    await until(() => b.incoming.length > 0);
    await b.m.accept();
    await until(() => w.status(a, b) === 'connected');
    const callerId = Identity.fromNsec(nsecEncode(generateSecretKey()));
    const caller = new CallManager({ identity: callerId, transport: w.transport, rtc: w.network.factoryFor(callerId.pubkey), getUserMedia: new RealisticMedia().getUserMedia });
    const aOneToOne = new CallManager({
      identity: a.id,
      transport: w.transport,
      rtc: w.network.factoryFor(a.pk),
      getUserMedia: a.media.getUserMedia,
      isBusy: () => a.m.state !== 'idle' && a.m.state !== 'ended',
    });
    closers.push(caller, aOneToOne);
    const ended: string[] = [];
    caller.onEnded((r) => ended.push(r));
    await caller.startCall(a.pk, 'audio');
    await until(() => ended.length > 0);
    expect(ended).toEqual(['busy']);
  });
});
