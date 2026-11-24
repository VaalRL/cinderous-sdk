// 網狀小群組通話（SDK ADR 0141）：用照瀏覽器真實行為寫的替身（realistic-rtc.ts）。
import { afterEach, describe, expect, it } from 'vitest';

import { CallManager } from '../../src/call/call-manager.js';
import { GROUP_CALL_MAX_PENDING_CANDIDATES, GroupCallManager, type GroupCallManagerOptions } from '../../src/call/group-call.js';
import type { MediaStreamLike } from '../../src/call/media.js';
import { Identity } from '../../src/identity.js';
import { generateSecretKey, nsecEncode } from '../../src/protocol/index.js';
import { CALL_SIGNAL_KIND } from '../../src/protocol/call.js';
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

// ── 程式碼審查（2026-11-18）發現的問題 ───────────────────────────────────────
/** 以 `from` 的身分直接送一則群組信令給 `to`（模擬惡意或錯誤的對端） */
async function rawSignal(w: ReturnType<typeof world>, from: Person, to: Person, signal: Record<string, unknown>) {
  const event = from.id.sealAndWrap(
    { kind: CALL_SIGNAL_KIND, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ v: 1, ...signal }) },
    to.pk,
    { kind: CALL_SIGNAL_KIND, tags: [['p', to.pk]] },
  );
  await w.transport.publish(event);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('審查修正：非同步操作晚回來、連線卡住、惡意對端', () => {
  it('🔴 H1 接聽時還在等權限，對方就取消了：權限回來後不復活、麥克風與鏡頭都關掉、不送 join', async () => {
    const w = world();
    const a = w.person();
    const b = w.person();
    await a.m.start([b.pk], 'video');
    await until(() => b.incoming.length > 0);
    b.media.holdPermission();
    const accepting = b.m.accept();
    await a.m.leave();
    await until(() => b.m.state === 'ended');
    b.media.release();
    await accepting;
    expect(b.m.state).toBe('ended');
    expect(b.media.liveDevices()).toBe(0);
    expect(b.local.at(-1) ?? null).toBeNull();
  });

  it('🔴 H1 開通話時還在等權限就 close()：取得的裝置全部關掉，start 失敗', async () => {
    const w = world();
    const a = w.person();
    const b = w.person();
    a.media.holdPermission();
    const starting = a.m.start([b.pk], 'video');
    a.m.close();
    a.media.release();
    await expect(starting).rejects.toThrow();
    expect(a.media.liveDevices()).toBe(0);
    expect(b.incoming).toHaveLength(0);
  });

  it('🔴 H1 通話中開視訊、鏡頭還在開時通話就結束了：鏡頭不能留著亮', async () => {
    const w = world();
    const a = w.person();
    const b = w.person();
    await a.m.start([b.pk], 'audio');
    await until(() => b.incoming.length > 0);
    await b.m.accept();
    await until(() => w.status(a, b) === 'connected');
    a.media.holdPermission();
    const opening = a.m.setLocalMedia('video');
    await b.m.leave();
    await until(() => a.m.state === 'ended');
    a.media.release();
    await opening;
    expect(a.media.liveDevices()).toBe(0);
    expect(a.m.state).toBe('ended');
  });

  it('🔴 H1 連按兩次換鏡頭：最後只有一顆鏡頭開著、本地預覽就是送出去的那一顆', async () => {
    const w = world();
    const { a, b } = await threeWay(w, 'video');
    const first = a.m.setCamera({ facingMode: 'environment' });
    const second = a.m.setCamera({ facingMode: 'user' });
    await Promise.all([first, second]);
    expect(a.media.liveCameras()).toBe(1);
    const live = a.media.cameras.filter((c) => !c.stopped)[0]!;
    expect(a.local.at(-1)?.getVideoTracks()).toEqual([live]);
    const sent = w.network.between(a.pk, b.pk)!.transceivers.find((t) => t.kind === 'video' && t.mid != null)!.sender.track;
    expect(sent).toBe(live);
  });

  it('🔴 H2 對方的 offer 套不上（壞 SDP）：這一對清乾淨、標 failed 並通知，不會永遠卡在 connecting', async () => {
    const w = world();
    const a = w.person();
    const b = w.person();
    const [small, big] = a.pk < b.pk ? [a, b] : [b, a];
    w.network.rejectOffersAt.add(big.pk); // 小的發 offer、大的套不上
    await a.m.start([b.pk], 'audio');
    await until(() => b.incoming.length > 0);
    await b.m.accept();
    await until(() => w.status(big, small) === 'failed');
    expect(big.failed).toEqual([[small.pk, 'unreachable']]);
    expect(w.network.created.filter((pc) => pc.owner === big.pk && !pc.closed)).toHaveLength(0);
  });

  it('🔴 H3 有人送完 join 就沒下文（ICE 一直停在 new）：連線逾時後標 failed，只剩自己時通話結束', async () => {
    const w = world({ connectTimeoutMs: 300 });
    const a = w.person();
    const b = w.person();
    w.network.stalled.add([a.pk, b.pk].sort().join('|'));
    await a.m.start([b.pk], 'audio');
    await until(() => b.incoming.length > 0);
    await b.m.accept();
    await until(() => a.m.state === 'ended' && b.m.state === 'ended', 3_000);
    expect(a.failed).toEqual([[b.pk, 'unreachable']]);
    expect(a.ended).toEqual(['empty']);
    expect(a.media.liveDevices() + b.media.liveDevices()).toBe(0);
  });

  it('🔴 H3 三人中有一對卡住：只有那一對逾時，其他人照常', async () => {
    // 期限要比「整套測試同時跑時」正常連上的時間長（NIP-59 封裝在負載下很慢）
    const w = world({ connectTimeoutMs: 2_000, ringTimeoutMs: 30_000 });
    const a = w.person();
    const b = w.person();
    const c = w.person();
    w.network.stalled.add([b.pk, c.pk].sort().join('|'));
    await a.m.start([b.pk, c.pk], 'audio');
    await until(() => b.incoming.length > 0 && c.incoming.length > 0);
    await b.m.accept();
    await c.m.accept();
    await until(() => w.status(b, c) === 'failed' && w.status(c, b) === 'failed', 8_000);
    expect(w.status(a, b)).toBe('connected');
    expect(w.status(a, c)).toBe('connected');
    expect(a.m.state).toBe('in-call');
  }, 15_000);

  it('M1 該由我發 offer 的人送來 offer、或已經離開的人送 offer：忽略，不建連線、不讓他復活', async () => {
    const w = world();
    const { a, b, c } = await threeWay(w, 'audio');
    const before = w.network.created.length;
    const [small, big] = a.pk < b.pk ? [a, b] : [b, a];
    // big 不該對 small 發 offer：small 收到要忽略
    await rawSignal(w, big, small, { groupId: small.m.groupId, type: 'group-offer', sdp: 'rtc:none', media: 'audio' });
    await c.m.leave();
    await until(() => w.status(a, c) === 'left');
    // 已離開的 c 送 offer 給 a：忽略
    await rawSignal(w, c, a, { groupId: a.m.groupId, type: 'group-offer', sdp: 'rtc:none', media: 'audio' });
    await sleep(50);
    expect(w.network.created.length).toBe(before);
    expect(w.status(a, c)).toBe('left');
    expect(w.status(small, big)).toBe('connected');
  });

  it('M4 收到邀請一直不接：響鈴逾時後自己結束（no-answer），不會永遠佔著忙線', async () => {
    const w = world();
    const a = w.person();
    const b = w.person();
    await a.m.start([b.pk], 'audio');
    await until(() => b.incoming.length > 0);
    await until(() => b.m.state === 'ended', 3_000);
    expect(b.ended).toEqual(['no-answer']);
    expect(b.media.calls).toHaveLength(0);
  });

  it('M7 沒有連線前收到一大堆 candidate：只留上限內的', async () => {
    const w = world({ ringTimeoutMs: 60_000 }); // 送 80 則封裝信令很久：別讓響鈴先逾時（M4）
    const a = w.person();
    const b = w.person();
    const [small, big] = a.pk < b.pk ? [a, b] : [b, a];
    await small.m.start([big.pk], 'audio');
    await until(() => big.incoming.length > 0);
    for (let i = 0; i < 80; i++) await rawSignal(w, small, big, { groupId: big.m.groupId, type: 'group-candidate', candidate: `candidate:${i}` });
    await big.m.accept();
    await until(() => w.status(big, small) === 'connected');
    const pc = w.network.between(big.pk, small.pk)!;
    expect(pc.iceCandidatesAdded).toBeLessThanOrEqual(GROUP_CALL_MAX_PENDING_CANDIDATES + 2);
  }, 30_000);
});
