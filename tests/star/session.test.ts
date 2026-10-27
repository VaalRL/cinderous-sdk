// 星狀會話（SDK ADR 0030）：加入、離開、踢出、轉送、寄件人不可冒充、單播、Host 斷線、邀請語意、背壓。
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { StarHost, type StarHostEvent, type StarMessage } from '../../src/star/host.js';
import { StarJoinError, StarMember, StarMemberError } from '../../src/star/member.js';
import { encodeDeliver, encodePacket, encodeSend } from '../../src/star/wire.js';
import { FAST, joinMember, makeHost, memPair, read, sleep, text, until, type Joined } from './helpers.js';

const hosts: StarHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
});
function host(opts: Parameters<typeof makeHost>[0] = {}): StarHost {
  const h = makeHost(opts);
  hosts.push(h);
  return h;
}

async function session(n: number, opts: Parameters<typeof makeHost>[0] = {}) {
  const h = host(opts);
  const hostMessages: StarMessage[] = [];
  const hostEvents: StarHostEvent[] = [];
  h.onMessage((m) => hostMessages.push(m));
  h.onEvent((e) => hostEvents.push(e));
  const members: Joined[] = [];
  for (let i = 0; i < n; i += 1) members.push(await joinMember(h, { label: `m${i}` }));
  return { h, members, hostMessages, hostEvents };
}

describe('加入與轉送', () => {
  for (const n of [3, 5, 8]) {
    it(`${n} 位成員：每則廣播送到其他所有人（含 Host），寄件人正確、序號全體一致`, async () => {
      const { h, members, hostMessages } = await session(n);
      expect(h.members()).toHaveLength(n);
      for (const [i, m] of members.entries()) m.member.send(text(`from-${i}`));
      h.send(text('from-host'));
      await until(() => members.every((m) => m.messages.length === n) && hostMessages.length === n, 3_000, '全部送達');

      for (const [i, m] of members.entries()) {
        const got = m.messages.map((x) => `${x.from.slice(0, 8)}:${read(x.payload)}`).sort();
        const want = [...members.flatMap((o, j) => (j === i ? [] : [`${o.pubkey.slice(0, 8)}:from-${j}`])), `${h.hostPubkey.slice(0, 8)}:from-host`].sort();
        expect(got).toEqual(want);
        // 序號嚴格遞增
        const seqs = m.messages.map((x) => x.seq);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      }
      // 同一則在每個人那裡的序號都一樣
      const seqOf = new Map<string, number>();
      for (const m of [...members.flatMap((x) => x.messages), ...hostMessages]) {
        const key = read(m.payload);
        if (seqOf.has(key)) expect(seqOf.get(key)).toBe(m.seq);
        else seqOf.set(key, m.seq);
      }
    });
  }

  it('名單：新成員拿到現有名單（含 Host）；其他人收到 joined', async () => {
    const { h, members } = await session(3);
    expect(members[2]!.member.members().map((m) => m.pubkey).sort()).toEqual([h.hostPubkey, members[0]!.pubkey, members[1]!.pubkey].sort());
    expect(members[2]!.member.members().find((m) => m.pubkey === members[0]!.pubkey)?.label).toBe('m0');
    await until(() => members[0]!.events.filter((e) => e.type === 'joined').length === 2);
    expect(members[0]!.member.members()).toHaveLength(3);
    expect(members[0]!.events.map((e) => e.type === 'joined' && e.label)).toEqual(['m1', 'm2']);
  });

  it('離開：其他人收到 left(left)，離開的人不再收到', async () => {
    const { h, members, hostEvents } = await session(3);
    await members[1]!.member.leave();
    await until(() => !h.has(members[1]!.pubkey));
    await until(() => members[0]!.events.some((e) => e.type === 'left'));
    expect(members[0]!.events.find((e) => e.type === 'left')).toMatchObject({ pubkey: members[1]!.pubkey, reason: 'left' });
    expect(hostEvents.find((e) => e.type === 'left')).toMatchObject({ pubkey: members[1]!.pubkey, reason: 'left' });
    h.send(text('after'));
    await until(() => members[0]!.messages.length === 1 && members[2]!.messages.length === 1);
    await sleep(20);
    expect(members[1]!.messages).toHaveLength(0);
    expect(() => members[1]!.member.send(text('x'))).toThrow(StarMemberError);
  });

  it('單播：只有指定的人收到；Host 被指定時 Host 收到', async () => {
    const { h, members, hostMessages } = await session(4);
    members[0]!.member.send(text('secret'), { to: [members[2]!.pubkey, h.hostPubkey] });
    await until(() => members[2]!.messages.length === 1 && hostMessages.length === 1);
    await sleep(20);
    expect(members[1]!.messages).toHaveLength(0);
    expect(members[3]!.messages).toHaveLength(0);
    expect(members[2]!.messages[0]).toMatchObject({ from: members[0]!.pubkey, unicast: true });
    h.send(text('only-3'), { to: [members[3]!.pubkey] });
    await until(() => members[3]!.messages.length === 1);
    expect(read(members[3]!.messages[0]!.payload)).toBe('only-3');
  });

  it('echo：寄件人也拿到自己這則（帶 Host 序號）；topic 與 volatile 照轉', async () => {
    const { members } = await session(2);
    members[0]!.member.send(text('chat'), { echo: true, topic: 2 });
    members[0]!.member.send(text('cursor'), { topic: 1, volatile: true });
    await until(() => members[0]!.messages.length === 1 && members[1]!.messages.length === 2);
    expect(members[0]!.messages[0]!.seq).toBe(members[1]!.messages[0]!.seq);
    expect(members[1]!.messages.map((m) => [m.topic, m.volatile])).toEqual([
      [2, false],
      [1, true],
    ]);
  });
});

describe('🔴 寄件人不可冒充', () => {
  it('成員自己塞一個 DELIVER（假裝是別人）給 Host：Host 當協定錯誤請它離開，沒有人收到', async () => {
    const { members, hostMessages } = await session(3);
    const [attacker, victim, witness] = members as [Joined, Joined, Joined];
    const forged = encodeDeliver({ seq: 999, from: victim.pubkey, unicast: false, volatile: false, topic: 0, payload: text('我是 victim') });
    // 鏈路序號要接得上才會被處理：先看攻擊者已送了幾包（JOIN 是第 1 包）
    attacker.memberSide.inject(encodePacket(true, attacker.member.stats.packetsSent + 1, 0, [forged]));
    await until(() => attacker.member.closed, 2_000, '攻擊者被請離開');
    // Host 以協定錯誤請它離開（攻擊者那端看到的是 ended 或 host-lost，視哪一包先到）
    await until(() => witness.events.some((e) => e.type === 'left'));
    expect(witness.events.find((e) => e.type === 'left')).toMatchObject({ pubkey: attacker.pubkey, reason: 'protocol' });
    await sleep(30);
    expect(witness.messages).toHaveLength(0);
    expect(hostMessages).toHaveLength(0);
  });

  it('SEND 紀錄裡沒有寄件人欄位：Host 一律填通道認證的身分', async () => {
    const { members } = await session(3);
    const [a, , c] = members as [Joined, Joined, Joined];
    a.memberSide.inject(encodePacket(true, a.member.stats.packetsSent + 1, 0, [encodeSend({ payload: text('hi'), topic: 0, volatile: false, echo: false, to: undefined })]));
    await until(() => c.messages.length === 1);
    expect(c.messages[0]!.from).toBe(a.pubkey);
  });

  it('成員收到的 DELIVER 只可能來自 Host 的通道：通道的對方不是邀請裡的 Host 就拒絕加入', async () => {
    const h = host();
    const impostor = Identity.generate().pubkey;
    const [, memberSide] = memPair(impostor, Identity.generate().pubkey);
    const invite = h.createInvite({ relays: ['wss://relay.example'] }).uri;
    await expect(StarMember.over(memberSide, { invite })).rejects.toMatchObject({ reason: 'wrong-host' });
  });
});

describe('踢出', () => {
  it('被踢的人收到 ended(kicked)、不能再收發；其他人收到 left(kicked)，其他通道不受影響', async () => {
    const { h, members } = await session(3);
    const [a, b, c] = members as [Joined, Joined, Joined];
    expect(h.kick(b.pubkey)).toBe(true);
    await until(() => b.member.closed);
    expect(b.member.endedBy).toEqual({ type: 'ended', reason: 'kicked' });
    await until(() => a.events.some((e) => e.type === 'left'));
    expect(a.events.find((e) => e.type === 'left')).toMatchObject({ pubkey: b.pubkey, reason: 'kicked' });
    expect(() => b.member.send(text('x'))).toThrow(/不在會話/);
    // 被踢的人繞過 API 直接塞封包：Host 那端的通道已關，不會轉送
    b.memberSide.inject(encodePacket(true, 99, 0, [encodeSend({ payload: text('ghost'), topic: 0, volatile: false, echo: false, to: undefined })]));
    h.send(text('still-works'));
    a.member.send(text('a→c'));
    await until(() => c.messages.length === 2 && a.messages.length === 1);
    await sleep(30);
    expect(c.messages.map((m) => read(m.payload)).sort()).toEqual(['a→c', 'still-works']);
    expect(b.messages).toHaveLength(0);
  });

  it('被踢的人（預設封鎖）拿新邀請也回不來；unban 後可以', async () => {
    const h = host();
    const b = await joinMember(h);
    h.kick(b.pubkey);
    await until(() => b.member.closed);
    await expect(joinMember(h, { pubkey: b.pubkey })).rejects.toMatchObject({ reason: expect.stringMatching(/banned|closed/) });
    h.unban(b.pubkey);
    const again = await joinMember(h, { pubkey: b.pubkey });
    expect(h.has(again.pubkey)).toBe(true);
  });
});

describe('Host 斷線', () => {
  it('Host 關閉會話：成員收到 ended(host-closed)', async () => {
    const { h, members } = await session(3);
    h.close();
    await until(() => members.every((m) => m.member.closed));
    for (const m of members) expect(m.member.endedBy).toEqual({ type: 'ended', reason: 'host-closed' });
  });

  it('通道斷了（P2P）：成員收到 host-lost(closed)', async () => {
    const { members } = await session(2);
    members[0]!.hostSide.close();
    await until(() => members[0]!.member.closed);
    expect(members[0]!.events.at(-1)).toEqual({ type: 'host-lost', reason: 'closed' });
  });

  it('Host 當機（中繼軌沒有關閉通知）：心跳逾時後成員收到 host-lost(timeout)；Host 那端也把它請出去', async () => {
    const h = host({ tuning: { batchWindowMs: 1, heartbeatMs: 30, timeoutMs: 150 } });
    const events: StarHostEvent[] = [];
    h.onEvent((e) => events.push(e));
    const m = await joinMember(h, { behaviour: { mode: 'relayed-websocket' }, member: { tuning: { batchWindowMs: 1, heartbeatMs: 30, timeoutMs: 150 } } });
    await sleep(100);
    expect(m.member.closed).toBe(false); // 心跳讓它活著
    m.hostSide.silent = true; // Host 送的全部消失
    m.memberSide.silent = true;
    await until(() => m.member.closed, 2_000);
    expect(m.events.at(-1)).toEqual({ type: 'host-lost', reason: 'timeout' });
    await until(() => events.some((e) => e.type === 'left'), 2_000);
    expect(events.find((e) => e.type === 'left')).toMatchObject({ reason: 'timeout' });
  });
});

describe('邀請', () => {
  it('一次性：第二個人用同一張 → used', async () => {
    const h = host();
    const invite = h.createInvite({ relays: ['wss://relay.example'] }).uri;
    await joinMember(h, { invite });
    await expect(joinMember(h, { invite })).rejects.toMatchObject({ reason: 'used' });
  });

  it('過期 → expired（Host 的時鐘為準；成員這端也會提早失敗）', async () => {
    let now = Date.now();
    const h = host({ timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (x) => clearTimeout(x as ReturnType<typeof setTimeout>), now: () => now } });
    const invite = h.createInvite({ relays: ['wss://relay.example'], ttlMs: 60_000 }).uri;
    now += 61_000;
    await expect(joinMember(h, { invite })).rejects.toMatchObject({ reason: 'expired' });
  });

  it('撤銷 → revoked；撤銷不影響已加入的人', async () => {
    const h = host();
    const multi = h.createInvite({ relays: ['wss://relay.example'], maxUses: 3 });
    const a = await joinMember(h, { invite: multi.uri });
    expect(h.revokeInvite(multi.id)).toBe(true);
    await expect(joinMember(h, { invite: multi.uri })).rejects.toMatchObject({ reason: 'revoked' });
    expect(h.has(a.pubkey)).toBe(true);
  });

  it('綁定公鑰：別人拿到也進不來', async () => {
    const h = host();
    const intended = Identity.generate().pubkey;
    const invite = h.createInvite({ relays: ['wss://relay.example'], forPubkey: intended }).uri;
    await expect(joinMember(h, { invite })).rejects.toMatchObject({ reason: 'invalid-invite' });
    const ok = await joinMember(h, { invite, pubkey: intended });
    expect(h.has(ok.pubkey)).toBe(true);
  });

  it('亂猜的秘密 → invalid-invite', async () => {
    const h = host();
    const real = h.createInvite({ relays: ['wss://relay.example'] }).uri;
    const forged = real.replace(/\.([A-Za-z0-9_-]{71})\./, (_, core: string) => `.${core.slice(0, 50)}${core[50] === 'A' ? 'B' : 'A'}${core.slice(51)}.`);
    await expect(joinMember(h, { invite: forged })).rejects.toMatchObject({ reason: 'invalid-invite' });
  });

  it('App 核准被拒 → denied；成員上限 → full（不耗邀請次數）', async () => {
    const h = host({ approveJoin: ({ label }) => label !== 'bad', maxMembers: 2 });
    await expect(joinMember(h, { label: 'bad' })).rejects.toMatchObject({ reason: 'denied' });
    await joinMember(h);
    await joinMember(h);
    const spare = h.createInvite({ relays: ['wss://relay.example'] });
    await expect(joinMember(h, { invite: spare.uri })).rejects.toMatchObject({ reason: 'full' });
    expect(h.invites().find((i) => i.id === spare.id)?.uses).toBe(0);
  });

  it('連上後遲遲不送加入請求 → Host 關掉它', async () => {
    const h = host({ joinTimeoutMs: 50 });
    const [hostSide] = memPair(h.hostPubkey, Identity.generate().pubkey);
    h.attach(hostSide);
    await until(() => hostSide.closed, 1_000);
  });

  it('🔴 加入前送大封包或一堆亂序封包：Host 直接關掉（未加入的連線撐不爆記憶體）', async () => {
    const h = host();
    const [big] = memPair(h.hostPubkey, Identity.generate().pubkey);
    h.attach(big);
    big.peer.inject(encodePacket(true, 1, 0, [{ type: 1, body: new Uint8Array(4_096) }]));
    await until(() => big.closed, 1_000);
    const [flood] = memPair(h.hostPubkey, Identity.generate().pubkey);
    h.attach(flood);
    for (let lseq = 2; lseq < 12; lseq += 1) flood.peer.inject(encodePacket(true, lseq, 0, [{ type: 6, body: new Uint8Array(100) }]));
    await until(() => flood.closed, 1_000);
  });

  it('StarJoinError 帶原因；加入逾時 → timeout', async () => {
    const h = host();
    const [, memberSide] = memPair(h.hostPubkey, Identity.generate().pubkey); // Host 那端沒人 attach
    const invite = h.createInvite({ relays: ['wss://relay.example'] }).uri;
    const error = await StarMember.over(memberSide, { invite, joinTimeoutMs: 50, tuning: FAST }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StarJoinError);
    expect((error as StarJoinError).reason).toBe('timeout');
  });
});

describe('背壓', () => {
  it('🔴 慢成員的佇列滿了：它被請離開（overflow），其他人照常收到每一則', async () => {
    const { h, members } = await session(3, { tuning: { batchWindowMs: 1, maxQueueRecords: 20 } });
    const [slow, a, b] = members as [Joined, Joined, Joined];
    slow.hostSide.stalled = true; // Host 送給它的卡住
    const events: StarHostEvent[] = [];
    h.onEvent((e) => events.push(e));
    for (let i = 0; i < 100; i += 1) {
      h.send(text(`u${i}`));
      if (i % 5 === 4) await sleep(3); // 正常速度：快的成員跟得上，慢的越積越多
    }
    await until(() => events.some((e) => e.type === 'left' && e.reason === 'overflow'));
    await until(() => a.messages.length === 100 && b.messages.length === 100, 3_000, '其他人全收到');
    expect(a.messages.map((m) => read(m.payload))).toEqual(Array.from({ length: 100 }, (_, i) => `u${i}`));
    expect(h.has(slow.pubkey)).toBe(false);
    slow.hostSide.unstall();
  });

  it('可丟棄（volatile）的先丟：慢成員不會因為游標更新被踢', async () => {
    const { h, members } = await session(2, { tuning: { batchWindowMs: 1, maxQueueRecords: 10, maxBatchBytes: 64 } });
    const [slow] = members as [Joined, Joined];
    slow.hostSide.stalled = true;
    for (let i = 0; i < 50; i += 1) h.send(text(`cursor${i}`), { volatile: true });
    h.send(text('doc-update'));
    await sleep(20);
    expect(h.has(slow.pubkey)).toBe(true);
    slow.hostSide.unstall();
    await until(() => slow.messages.some((m) => read(m.payload) === 'doc-update'));
    expect(slow.messages.length).toBeLessThan(51);
  });

  it('成員這端佇列滿了：send 丟 backpressure（不會默默丟非 volatile 的）', async () => {
    const h = host();
    const m = await joinMember(h, { member: { tuning: { batchWindowMs: 1, maxQueueRecords: 5 } } });
    m.memberSide.stalled = true;
    const tryMany = () => {
      for (let i = 0; i < 20; i += 1) m.member.send(text(`x${i}`));
    };
    expect(tryMany).toThrow(expect.objectContaining({ code: 'backpressure' }) as Error);
    m.memberSide.unstall();
  });

  it('一個成員灌爆（超過進站速率）：它被請離開（rate-limit），不會拖垮別人', async () => {
    const { h, members } = await session(2, { inboundRate: { messagesPerSecond: 10, burstMessages: 20 } });
    const events: StarHostEvent[] = [];
    h.onEvent((e) => events.push(e));
    for (let i = 0; i < 40; i += 1) members[0]!.member.send(text(`flood${i}`));
    await until(() => events.some((e) => e.type === 'left' && e.reason === 'rate-limit'));
    expect(members[1]!.messages.length).toBeLessThanOrEqual(20);
  });

  it('超過酬載上限：送的一方直接丟例外', async () => {
    const { h, members } = await session(1, { maxPayloadBytes: 100 });
    expect(() => members[0]!.member.send(new Uint8Array(101))).toThrow(expect.objectContaining({ code: 'too-large' }) as Error);
    expect(() => h.send(new Uint8Array(101))).toThrow(/上限/);
  });
});

describe('同一身分重新加入', () => {
  it('舊連線被取代（replaced），新連線繼續收', async () => {
    const h = host();
    const a = await joinMember(h);
    const other = await joinMember(h);
    const again = await joinMember(h, { pubkey: a.pubkey });
    await until(() => a.member.closed);
    expect(a.member.endedBy).toEqual({ type: 'ended', reason: 'replaced' });
    other.member.send(text('hello'));
    await until(() => again.messages.length === 1);
    expect(h.members()).toHaveLength(2);
  });
});
