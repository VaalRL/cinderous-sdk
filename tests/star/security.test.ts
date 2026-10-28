// 安全審查的修正（SDK ADR 0030 §11）：每一項一個測試。
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { StarHost, type StarHostEvent } from '../../src/star/host.js';
import { encodeStarInvite, parseStarInvite, StarInviteError } from '../../src/star/invite.js';
import { encodePacket, encodeSend, MAX_RECORDS_PER_PACKET, decodePacket } from '../../src/star/wire.js';
import { joinMember, makeHost, memPair, sleep, text, until, type Joined } from './helpers.js';

const hosts: StarHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
});
function host(opts: Parameters<typeof makeHost>[0] = {}): StarHost {
  const h = makeHost(opts);
  hosts.push(h);
  return h;
}
function watch(h: StarHost): StarHostEvent[] {
  const events: StarHostEvent[] = [];
  h.onEvent((e) => events.push(e));
  return events;
}

describe('H1：灌量的人被請離開，不是無辜的慢成員', () => {
  it('預設值：P2P 成員一口氣送 9 則 1 MiB，被 rate-limit 的是它；慢成員留下', async () => {
    const h = host();
    const events = watch(h);
    const flooder = await joinMember(h);
    const slow = await joinMember(h);
    slow.hostSide.stalled = true;
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 9; i += 1) {
      try {
        flooder.member.send(big);
      } catch {
        break; // 它自己的佇列也可能先滿
      }
    }
    await until(() => events.some((e) => e.type === 'left'), 5_000);
    expect(events.filter((e) => e.type === 'left')).toEqual([expect.objectContaining({ pubkey: flooder.pubkey, reason: 'rate-limit' })]);
    expect(h.has(slow.pubkey)).toBe(true);
    slow.hostSide.unstall();
  });

  it('速率沒超過、但一個人佔滿慢成員佇列的一半以上：請灌的人離開，慢成員與其他人留下', async () => {
    const h = host({ tuning: { batchWindowMs: 1, maxQueueBytes: 64 * 1024 }, inboundRate: { messagesPerSecond: 1e6, burstMessages: 1e6, bytesPerSecond: 1e9, burstBytes: 1e9 } });
    const events = watch(h);
    const flooder = await joinMember(h);
    const slow = await joinMember(h);
    const bystander = await joinMember(h);
    slow.hostSide.stalled = true;
    // 被請離開之後就不能再送（send 會丟 closed）：機器快時迴圈還沒跑完就會發生
    for (let i = 0; i < 60 && !flooder.member.closed; i += 1) {
      flooder.member.send(new Uint8Array(2_000));
      if (i % 10 === 9) await sleep(5);
    }
    await until(() => events.some((e) => e.type === 'left'), 3_000);
    expect(events.find((e) => e.type === 'left')).toMatchObject({ pubkey: flooder.pubkey, reason: 'rate-limit' });
    expect(h.has(slow.pubkey)).toBe(true);
    expect(h.has(bystander.pubkey)).toBe(true);
    h.send(text('still here'));
    await until(() => bystander.messages.some((m) => new TextDecoder().decode(m.payload) === 'still here'));
    slow.hostSide.unstall();
  });

  it('真的是自己慢（大家都正常送）：慢的人才被請離開（overflow）', async () => {
    const h = host({ tuning: { batchWindowMs: 1, maxQueueRecords: 20 } });
    const events = watch(h);
    const members: Joined[] = [];
    for (let i = 0; i < 4; i += 1) members.push(await joinMember(h));
    const slow = members[0]!;
    slow.hostSide.stalled = true;
    for (let i = 0; i < 40; i += 1) {
      members[1 + (i % 3)]!.member.send(text(`u${i}`));
      if (i % 3 === 2) await sleep(3);
    }
    await until(() => events.some((e) => e.type === 'left'), 3_000);
    expect(events.find((e) => e.type === 'left')).toMatchObject({ pubkey: slow.pubkey, reason: 'overflow' });
    slow.hostSide.unstall();
  });
});

describe('H2：解析與暫存的上限', () => {
  it('一包最多 4,096 筆紀錄；除了 LEAVE 不能有空紀錄', () => {
    const many = Array.from({ length: MAX_RECORDS_PER_PACKET + 1 }, () => ({ type: 6, body: new Uint8Array(1) }));
    expect(decodePacket(encodePacket(true, 1, 0, many))).toBeNull();
    expect(decodePacket(encodePacket(true, 1, 0, [{ type: 6, body: new Uint8Array(0) }]))).toBeNull();
    expect(decodePacket(encodePacket(true, 1, 0, [{ type: 4, body: new Uint8Array(0) }]))).not.toBeNull();
  });

  it('P2P 軌跳號＝對方亂來：直接斷', async () => {
    const h = host();
    const events = watch(h);
    const m = await joinMember(h);
    m.memberSide.inject(encodePacket(true, m.member.stats.packetsSent + 5, 0, [encodeSend({ payload: text('x'), topic: 0, volatile: false, echo: false, to: undefined })]));
    await until(() => events.some((e) => e.type === 'left'));
    expect(events.find((e) => e.type === 'left')).toMatchObject({ reason: 'protocol' });
  });
});

describe('M1：等待名額', () => {
  it('名額滿了：最舊一條還沒送 JOIN 的被踢掉，真的要加入的人進得來', async () => {
    const h = host({ maxPendingJoins: 3 });
    const squatters = [0, 1, 2].map(() => memPair(h.hostPubkey, Identity.generate().pubkey)[0]);
    for (const s of squatters) h.attach(s);
    const real = await joinMember(h);
    expect(h.has(real.pubkey)).toBe(true);
    expect(squatters[0]!.closed).toBe(true);
  });
});

describe('M2：中繼軌的心跳也守預算', () => {
  it('節流間隔比心跳長時，心跳跟著拉長（不會每條鏈路各自超出預算）', async () => {
    const h = host({ tuning: { batchWindowMs: 1, heartbeatMs: 20, timeoutMs: 5_000 }, relayEventsPerMinute: 600 }); // 每條 100 ms
    const m = await joinMember(h, { behaviour: { mode: 'relayed-websocket' }, member: { tuning: { batchWindowMs: 1, heartbeatMs: 20, timeoutMs: 5_000 }, relayEventsPerMinute: 600 } });
    const before = m.hostSide.sentMessages;
    await sleep(500);
    expect(m.hostSide.sentMessages - before).toBeLessThanOrEqual(6); // 20 ms 心跳本來是 25 包
    expect(m.member.closed).toBe(false);
  });
});

describe('M3：邀請秘密不外露', () => {
  it('invites() 不含邀請字串', () => {
    const h = host();
    const inv = h.createInvite({ relays: ['wss://relay.example'] });
    const listed = JSON.stringify(h.invites());
    expect(listed).not.toContain(inv.uri);
    expect(listed).not.toContain('cinderous-star:');
    expect(h.invites()[0]).toMatchObject({ id: inv.id, uses: 0 });
  });
});

describe('M4：踢出一併撤銷它用的邀請', () => {
  it('多次邀請被踢的人用過：換一把新金鑰也回不來', async () => {
    const h = host();
    const multi = h.createInvite({ relays: ['wss://relay.example'], maxUses: 5 });
    const bad = await joinMember(h, { invite: multi.uri });
    h.kick(bad.pubkey);
    await expect(joinMember(h, { invite: multi.uri })).rejects.toMatchObject({ reason: 'revoked' });
  });
});

describe('L1：沒有有效邀請的人看不到會話狀態', () => {
  it('成員已滿時，亂猜的人拿到 invalid-invite 而不是 full', async () => {
    const h = host({ maxMembers: 1 });
    await joinMember(h);
    const other = host();
    const foreign = other.createInvite({ relays: ['wss://relay.example'] }).uri;
    const forged = encodeStarInvite({ ...parseStarInvite(foreign), host: h.hostPubkey });
    await expect(joinMember(h, { invite: forged })).rejects.toMatchObject({ reason: 'invalid-invite' });
  });
});

describe('L3：確認號不能超過已送出的', () => {
  it('對方確認了我還沒送的號碼：斷線', async () => {
    const h = host();
    const events = watch(h);
    const m = await joinMember(h);
    m.memberSide.inject(encodePacket(false, 0, 9_999, []));
    await until(() => events.some((e) => e.type === 'left'));
    expect(events.find((e) => e.type === 'left')).toMatchObject({ reason: 'protocol' });
  });
});

describe('其他', () => {
  it('approveJoin 一直不回：逾時當成拒絕', async () => {
    const h = host({ approveJoin: () => new Promise<boolean>(() => {}), approveTimeoutMs: 50 });
    await expect(joinMember(h)).rejects.toMatchObject({ reason: 'denied' });
  });

  it('邀請的中繼只收 wss://（與本機 ws://），不收帶帳號的網址', () => {
    const base = { host: Identity.generate().pubkey, secret: new Uint8Array(16), expiresAt: 2_000_000_000 };
    expect(() => encodeStarInvite({ ...base, relays: ['wss://user@evil.example'] })).toThrow(StarInviteError);
    expect(() => encodeStarInvite({ ...base, relays: ['ws://relay.example'] })).toThrow(StarInviteError);
    expect(parseStarInvite(encodeStarInvite({ ...base, relays: ['ws://localhost:7777'] })).relays).toEqual(['ws://localhost:7777']);
    const good = encodeStarInvite({ ...base, relays: ['wss://ok.example'] });
    expect(() => parseStarInvite(good.replace('ok.example', 'u@ok.example'))).toThrow(StarInviteError);
  });
});
