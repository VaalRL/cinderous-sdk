// QR 配對握手（SDK ADR 0028 §3）：正常配對（兩種角色）、過期、重放、錯誤秘密、中間人、QR 被搶先使用、
// 使用者拒絕、被撤銷的裝置、deviceId 相撞、訊息遺失與重送、逾時。全部用真的身分金鑰與 NIP-59。
import type { Event } from 'nostr-tools/core';
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  acceptPairingUri,
  createPairingOffer,
  encodePairingUri,
  PAIRING_KIND,
  parsePairingUri,
  type PairingSession,
  VaultMembership,
  claimDevice,
} from '../../src/pairing/index.js';
import { pairingId } from '../../src/pairing/crypto.js';
import { openWrap, sealAndWrap } from '../../src/protocol/nip59.js';
import { ManualClock } from '../sync/vault/harness.js';
import { FakeRelay, settle } from './fake-relay.js';

const RELAYS = ['wss://r1.example', 'wss://r2.example', 'wss://r3.example'];

function setup() {
  const relay = new FakeRelay();
  const clock = new ManualClock();
  const member = Identity.generate();
  const joiner = Identity.generate();
  const membership = VaultMembership.create({ signer: member, label: 'Desktop' }, { now: () => clock.now() });
  return { relay, clock, member, joiner, membership };
}

async function failure(session: PairingSession): Promise<string> {
  try {
    await session.result;
  } catch (error) {
    return (error as { reason: string }).reason;
  }
  return 'ok';
}

/** 解開某顆配對事件（給測試看訊息類型） */
function typeOf(event: Event, to: Identity): string | null {
  try {
    const opened = openWrap(event as never, to);
    return (JSON.parse(opened.rumor.content) as { t: string }).t;
  } catch {
    return null;
  }
}

describe('正常配對', () => {
  it('invite（成員顯示、新裝置掃）：兩邊 SAS 相同；新裝置拿到同一份名單與共享金鑰；私鑰沒有被交付', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    expect(parsePairingUri(offer.uri!).relays).toEqual(RELAYS.slice(0, 2));
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, device: { label: 'Phone' } });
    await settle();
    expect(offer.state).toBe('confirming');
    expect(scan.state).toBe('confirming');
    expect(offer.sas).toMatch(/^\d{6}$/);
    expect(scan.sas).toBe(offer.sas);
    expect(offer.peer).toMatchObject({ pubkey: joiner.pubkey, label: 'Phone' });
    expect(scan.peer).toMatchObject({ pubkey: member.pubkey, label: 'Desktop' });

    scan.confirm();
    await settle();
    expect(membership.isMember(joiner.pubkey)).toBe(false); // 成員還沒確認
    offer.confirm();
    await settle();
    const [a, b] = await Promise.all([offer.result, scan.result]);
    expect(a.acknowledged).toBe(true);
    expect(a.membership).toBe(membership);
    expect(b.membership.vaultId).toBe(membership.vaultId);
    expect(b.relays).toEqual(RELAYS);
    const pubkeys = (m: VaultMembership) => m.devices().map((d) => d.pubkey).sort();
    expect(pubkeys(b.membership)).toEqual(pubkeys(membership));
    expect(pubkeys(membership)).toEqual([member.pubkey, joiner.pubkey].sort());
    expect([...b.membership.currentKey().key]).toEqual([...membership.currentKey().key]);
    expect(b.membership.peerPubkeys()).toEqual([member.pubkey]);
    expect(membership.peerPubkeys()).toEqual([joiner.pubkey]);
    // 線上沒有任何一則訊息帶著私鑰
    const nsecs = [member.nsec(), joiner.nsec()];
    for (const { event } of relay.log) for (const nsec of nsecs) expect(JSON.stringify(event)).not.toContain(nsec);
    // 一次性秘密用完即焚
    expect([...offer.invite.secret].every((x) => x === 0)).toBe(true);
    // 成員結束就關訂閱；新裝置多聽一會兒再關
    expect(relay.openSubs('M')).toBe(0);
    await clock.advance(120_000);
    expect(relay.openSubs('J')).toBe(0);
  });

  it('join（新裝置顯示、成員掃）：同樣完成；確認順序顛倒也可以', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const offer = createPairingOffer({ role: 'join', signer: joiner, pool: relay.pool('J'), relays: RELAYS, clock, device: { label: 'New desktop' } });
    const scan = acceptPairingUri(offer.uri!, { signer: member, pool: relay.pool('M'), membership, clock, relays: RELAYS });
    await settle();
    expect(offer.side).toBe('joiner');
    expect(scan.side).toBe('member');
    expect(offer.sas).toBe(scan.sas);
    scan.confirm(); // 成員先確認
    await settle();
    expect(scan.state).toBe('confirming');
    offer.confirm();
    await settle();
    const [joined, added] = await Promise.all([offer.result, scan.result]);
    expect(joined.membership.isMember(member.pubkey)).toBe(true);
    expect(added.membership.isMember(joiner.pubkey)).toBe(true);
    expect(added.acknowledged).toBe(true);
    expect(joined.membership.selfDevice?.label).toBe('New desktop');
  });

  it('訊息遺失：每一種訊息的第一則都被丟掉，靠重送完成', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const dropped = new Set<string>();
    relay.intercept = (event) => {
      if (event.kind !== PAIRING_KIND) return [event];
      const t = typeOf(event, member) ?? typeOf(event, joiner) ?? '?';
      if (dropped.has(t)) return [event];
      dropped.add(t);
      return [];
    };
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock });
    for (let i = 0; i < 10 && !offer.sas; i += 1) await clock.advance(3_000);
    expect(scan.sas).toBe(offer.sas);
    scan.confirm();
    offer.confirm();
    for (let i = 0; i < 20 && offer.state !== 'complete'; i += 1) await clock.advance(3_000);
    const [a, b] = await Promise.all([offer.result, scan.result]);
    expect(a.acknowledged).toBe(true);
    expect(b.membership.isMember(joiner.pubkey)).toBe(true);
    expect([...dropped].sort()).toEqual(['accept', 'confirm', 'done', 'hello', 'ok', 'welcome']);
  });
});

describe('過期、逾時、重放、錯誤秘密', () => {
  it('過期：顯示方 5 分鐘後作廢；過期的 QR 掃描方直接拒絕', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    await clock.advance(5 * 60_000 + 1_000);
    expect(await failure(offer)).toBe('expired');
    expect(relay.openSubs('M')).toBe(0);
    await clock.advance(3 * 60_000); // 超過容許的時鐘誤差
    const late = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock });
    expect(await failure(late)).toBe('expired');
    expect(relay.log).toHaveLength(0); // 什麼都沒送
  });

  it('過期後才到的 hello 不理（顯示方時鐘為準）', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock, ttlMs: 60_000 });
    relay.offline.add('M'); // 顯示方暫時收不到
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, handshakeTimeoutMs: 5 * 60_000 });
    await settle();
    expect(offer.peer).toBeUndefined();
    await clock.advance(61_000);
    relay.offline.delete('M');
    await clock.advance(60_000); // 掃描方繼續重送 hello
    expect(await failure(offer)).toBe('expired');
    expect(offer.peer).toBeUndefined();
    await clock.advance(5 * 60_000);
    expect(await failure(scan)).toBe('timeout');
  });

  it('使用者一直不確認 → 兩邊逾時；名單沒有變', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock });
    await settle();
    expect(offer.sas).toBeDefined();
    await clock.advance(4 * 60_000);
    expect(await failure(offer)).toBe('timeout');
    expect(['timeout', 'peer-rejected']).toContain(await failure(scan));
    expect(membership.devices()).toHaveLength(1);
  });

  it('重放：上一次配對的 hello／welcome 在新的一次配對裡都被忽略；同一則重複投遞是冪等的', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const first = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const firstScan = acceptPairingUri(first.uri!, { signer: joiner, pool: relay.pool('J'), clock });
    await settle();
    // 同一則 hello 再投遞三次：不會變成「第二台」
    const hello = relay.log.find((x) => x.from === 'J')!.event;
    for (let i = 0; i < 3; i += 1) relay.inject(hello);
    await settle();
    expect(first.state).toBe('confirming');
    first.confirm();
    firstScan.confirm();
    await settle();
    await Promise.all([first.result, firstScan.result]);
    const old = relay.log.map((x) => x.event);

    // 第二次配對（另一台新裝置）：把第一次的所有事件重放進去
    const other = Identity.generate();
    const second = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M2'), membership, relays: RELAYS, clock });
    for (const event of old) relay.inject(event);
    await settle();
    expect(second.peer).toBeUndefined();
    expect(second.state).toBe('waiting');
    const secondScan = acceptPairingUri(second.uri!, { signer: other, pool: relay.pool('O'), clock });
    for (const event of old) relay.inject(event);
    await settle();
    expect(second.peer?.pubkey).toBe(other.pubkey);
    expect(secondScan.sas).toBe(second.sas);
  });

  it('錯誤秘密（QR 抄錯或偽造）：顯示方算不出同一個配對 id，完全不回應 → 掃描方逾時', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const invite = parsePairingUri(offer.uri!);
    const wrong = encodePairingUri({ ...invite, secret: invite.secret.map((b) => b ^ 1) });
    const scan = acceptPairingUri(wrong, { signer: joiner, pool: relay.pool('J'), clock });
    await clock.advance(61_000);
    expect(await failure(scan)).toBe('timeout');
    expect(offer.peer).toBeUndefined();
    expect(relay.log.filter((x) => x.from === 'M')).toHaveLength(0);
  });
});

describe('中間人與 QR 外洩', () => {
  it('中繼竄改：改動任何一則事件的內容 → 解不開、被忽略，配對不會以錯的金鑰完成', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    relay.intercept = (event, from) => (from === 'M' ? [{ ...event, content: event.content.slice(0, -8) + 'AAAAAAAA' }] : [event]);
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock });
    await settle();
    expect(offer.peer?.pubkey).toBe(joiner.pubkey);
    expect(scan.sas).toBeUndefined();
    await clock.advance(61_000);
    expect(await failure(scan)).toBe('timeout');
  });

  it('沒有秘密的攻擊者：冒充顯示方回 accept（用自己的身分封裝）→ 掃描方只信 QR 上的公鑰，不理', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const mallory = Identity.generate();
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    relay.offline.add('M'); // 真的顯示方收不到
    relay.intercept = (event, from) => {
      if (from === 'J' && event.kind === PAIRING_KIND) {
        // 攻擊者把「真的 accept 內容」換成自己封裝：要偽造 seal 簽章就得有顯示方的私鑰
        // 就算攻擊者知道配對 id（例如也拍到了 QR），seal 的簽章者不是 QR 上的公鑰就不理
        const content = JSON.stringify({ v: 1, t: 'accept', p: pairingId(parsePairingUri(offer.uri!).secret), e: mallory.pubkey, d: 'dx', l: '', m: '00' });
        relay.inject(sealAndWrap({ kind: PAIRING_KIND, created_at: 1, tags: [], content }, mallory, joiner.pubkey, { kind: PAIRING_KIND, tags: [['p', joiner.pubkey]] }) as unknown as Event);
      }
      return [event];
    };
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock });
    await settle();
    expect(relay.log.filter((x) => x.from === 'J')).not.toHaveLength(0);
    expect(scan.peer).toBeUndefined();
    expect(scan.sas).toBeUndefined();
    expect(scan.state).toBe('handshake');
  });

  it('QR 被拍到、攻擊者搶先：真的裝置再來 → contested，兩個工作階段都作廢', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const mallory = Identity.generate();
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const evil = acceptPairingUri(offer.uri!, { signer: mallory, pool: relay.pool('X'), clock, device: { label: 'Phone' } });
    await settle();
    expect(offer.peer?.pubkey).toBe(mallory.pubkey);
    const real = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, device: { label: 'Phone' } });
    await settle();
    expect(await failure(offer)).toBe('contested');
    expect(await failure(evil)).toBe('contested');
    expect(await failure(real)).toBe('contested'); // 第二台也收到通知（安全審查 #7），請重新掃新的 QR
    expect(membership.devices()).toHaveLength(1);
  });

  it('QR 被拍到＋攻擊者控制中繼（擋下真的裝置）：真的裝置沒有 SAS、攻擊者的 SAS 只出現在成員這邊 → 使用者比對不到而拒絕', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const mallory = Identity.generate();
    relay.intercept = (event, from) => (from === 'J' ? [] : [event]); // 真的裝置送的全被擋
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const real = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, device: { label: 'Phone' } });
    const evil = acceptPairingUri(offer.uri!, { signer: mallory, pool: relay.pool('X'), clock, device: { label: 'Phone' } });
    await settle();
    expect(offer.peer?.pubkey).toBe(mallory.pubkey);
    expect(offer.sas).toBe(evil.sas);
    expect(real.sas).toBeUndefined(); // 真的手機上沒有任何數字可以比對
    offer.reject(); // 使用者看到手機上沒有這組數字
    await settle();
    expect(await failure(offer)).toBe('rejected');
    expect(await failure(evil)).toBe('peer-rejected');
    expect(membership.isMember(mallory.pubkey)).toBe(false);
  });

  it('join 角色：攻擊者冒充成員掃新裝置的 QR 並擋下真的成員 → 新裝置上的 SAS 在成員那邊不存在；新裝置拒絕', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const mallory = Identity.generate();
    const evilVault = VaultMembership.create({ signer: mallory });
    relay.intercept = (event, from) => (from === 'M' ? [] : [event]);
    const offer = createPairingOffer({ role: 'join', signer: joiner, pool: relay.pool('J'), relays: RELAYS, clock });
    const real = acceptPairingUri(offer.uri!, { signer: member, pool: relay.pool('M'), membership, clock });
    const evil = acceptPairingUri(offer.uri!, { signer: mallory, pool: relay.pool('X'), membership: evilVault, clock });
    await settle();
    expect(offer.peer?.pubkey).toBe(mallory.pubkey);
    expect(real.sas).toBeUndefined();
    offer.reject();
    await settle();
    expect(await failure(evil)).toBe('peer-rejected');
    expect(evilVault.isMember(joiner.pubkey)).toBe(false);
  });

  it('SAS 綁定雙方身分與臨時金鑰：兩次配對同一對裝置，SAS 不同', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const { relay, clock, member, joiner, membership } = setup();
      const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
      acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock });
      await settle();
      codes.add(offer.sas!);
    }
    expect(codes.size).toBe(3);
  });
});

describe('拒絕、撤銷、衝突', () => {
  it('新裝置按「不符」→ 成員收到 peer-rejected；名單不變', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock });
    await settle();
    offer.confirm();
    scan.reject();
    await settle();
    expect(await failure(scan)).toBe('rejected');
    expect(await failure(offer)).toBe('peer-rejected');
    expect(membership.devices()).toHaveLength(1);
  });

  it('被撤銷的裝置不能再配對（要在那台重設身分）', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const other = Identity.generate();
    membership.addDevice({ pubkey: other.pubkey, deviceId: 'other', claim: claimDevice(other, { deviceId: 'other' }) });
    membership.addDevice({ pubkey: joiner.pubkey, deviceId: 'phone', claim: claimDevice(joiner, { deviceId: 'phone' }) });
    membership.revoke(joiner.pubkey);
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, device: { deviceId: 'phone' } });
    await settle();
    expect(await failure(offer)).toBe('revoked-device');
    expect(await failure(scan)).toBe('revoked-device');
    // join 角色：成員掃到被撤銷裝置的 QR，當場拒絕
    const join = createPairingOffer({ role: 'join', signer: joiner, pool: relay.pool('J2'), relays: RELAYS, clock });
    const memberScan = acceptPairingUri(join.uri!, { signer: member, pool: relay.pool('M2'), membership, clock });
    expect(await failure(memberScan)).toBe('revoked-device');
  });

  it('deviceId 和 Vault 裡另一台相同 → device-id-conflict', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    const squatter = Identity.generate();
    membership.addDevice({ pubkey: squatter.pubkey, deviceId: 'phone', claim: claimDevice(squatter, { deviceId: 'phone' }) });
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, device: { deviceId: 'phone' } });
    await settle();
    expect(await failure(offer)).toBe('device-id-conflict');
    expect(await failure(scan)).toBe('device-id-conflict'); // 顯示方以 abort 告知
  });

  it('角色不對：成員一側沒有 membership → wrong-role；不能和自己配對', async () => {
    const { relay, clock, member, membership } = setup();
    expect(() => createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), relays: RELAYS, clock })).toThrow(/VaultMembership/);
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const self = acceptPairingUri(offer.uri!, { signer: member, pool: relay.pool('M2'), clock });
    expect(await failure(self)).toBe('wrong-role');
  });

  it('done 遺失：成員在確認時限到時仍算完成（acknowledged: false），新裝置已在名單上', async () => {
    const { relay, clock, member, joiner, membership } = setup();
    relay.intercept = (event, from) => (from === 'J' && typeOf(event, member) === 'done' ? [] : [event]);
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock });
    await settle();
    scan.confirm();
    offer.confirm();
    await settle();
    expect((await scan.result).membership.isMember(joiner.pubkey)).toBe(true);
    await clock.advance(4 * 60_000);
    const a = await offer.result;
    expect(a.acknowledged).toBe(false);
    expect(membership.isMember(joiner.pubkey)).toBe(true);
  });
});
