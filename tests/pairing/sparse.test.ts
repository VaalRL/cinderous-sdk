// 名單上的輕量成員宣告（SDK ADR 0058）：每台自己簽的內容範圍（與 `caps`、`standby` 並列的 `sparse` 欄位），
// `scopeOf`／`sparseMembers`／`fullMembers`、能力宣告的 `allDeclare`；舊版略過、竄改的那一筆丟掉、配對時只帶邀請方自己的。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  acceptPairingUri,
  buildRosterEvents,
  claimDevice,
  createPairingOffer,
  CURRENT_DEVICE_CAPABILITIES,
  defaultDeviceId,
  normalizeSparsePatterns,
  ROSTER_SPARSE_MAX_PATTERN_LENGTH,
  ROSTER_SPARSE_MAX_PATTERNS,
  VaultMembership,
  type MembershipChange,
  type VaultRosterData,
} from '../../src/pairing/index.js';
import { compilePathScope, MERGE_RULES_CAPABILITY, sparsePeerScopes } from '../../src/sync/vault/index.js';
import { ManualClock } from '../sync/vault/harness.js';
import { FakeRelay, settle } from './fake-relay.js';

function add(m: VaultMembership, id: Identity, label: string) {
  const deviceId = defaultDeviceId(id.pubkey);
  return m.addDevice({ pubkey: id.pubkey, deviceId, label, claim: claimDevice(id, { deviceId, label }) });
}

function trio() {
  const [a, b, c] = [Identity.generate(), Identity.generate(), Identity.generate()];
  const ma = VaultMembership.create({ signer: a, label: 'Desktop' });
  add(ma, b, 'Phone');
  add(ma, c, 'Laptop');
  const mb = VaultMembership.fromRoster(b, ma.roster());
  const mc = VaultMembership.fromRoster(c, ma.roster());
  return { a, b, c, ma, mb, mc };
}

describe('declareSparse／scopeOf／sparseMembers／fullMembers', () => {
  it('宣告、簽章、經名單合併到別台；compilePathScope 編成判斷函式；sparsePeerScopes 給協調器', () => {
    const { a, b, ma, mb } = trio();
    const changes: MembershipChange[] = [];
    mb.onChange((c) => changes.push(c));
    expect(mb.declareSparse(['Daily/', '  Inbox/ ', '', '# 註解', 'Daily/'])).toBe(true);
    expect(changes.map((c) => c.reason)).toEqual(['caps']);
    expect(mb.declareSparse(['Daily/', 'Inbox/'])).toBe(false); // 沒變不重簽
    ma.merge(mb.roster(), b.pubkey);
    expect(ma.scopeOf(b.pubkey)).toEqual(['Daily/', 'Inbox/']);
    expect(ma.scopeOf(a.pubkey)).toBeNull();
    expect(ma.scopeOf(Identity.generate().pubkey)).toBeUndefined();
    expect(ma.sparseMembers().map((m) => [m.label, m.patterns])).toEqual([['Phone', ['Daily/', 'Inbox/']]]);
    expect(ma.fullMembers().map((d) => d.label)).toEqual(['Desktop', 'Laptop']);
    expect(sparsePeerScopes(ma)).toEqual({ [defaultDeviceId(b.pubkey)]: ['Daily/', 'Inbox/'] });
    expect(sparsePeerScopes(mb)).toEqual({}); // 自己不算
    const inScope = compilePathScope(ma.scopeOf(b.pubkey)!);
    expect([inScope('Daily/2026-10-05.md'), inScope('Inbox/x.md'), inScope('Notes/x.md')]).toEqual([true, true, false]);
  });

  it('宣告 null＝改回完整成員（較晚的蓋過）；沒宣告過的宣告 null 不重簽', () => {
    const { b, ma, mb, mc } = trio();
    expect(mc.declareSparse(null)).toBe(false);
    mb.declareSparse(['Daily/']);
    ma.merge(mb.roster(), b.pubkey);
    mb.declareSparse(null);
    ma.merge(mb.roster(), b.pubkey);
    expect(ma.scopeOf(b.pubkey)).toBeNull();
    expect(ma.sparseMembers()).toEqual([]);
    expect(ma.fullMembers()).toHaveLength(3);
  });

  it('不合規的規則丟 RangeError：太多、太長、控制字元', () => {
    const { mb } = trio();
    expect(() => mb.declareSparse(Array.from({ length: ROSTER_SPARSE_MAX_PATTERNS + 1 }, (_, i) => `d${i}/`))).toThrow(RangeError);
    expect(() => mb.declareSparse(['x'.repeat(ROSTER_SPARSE_MAX_PATTERN_LENGTH + 1)])).toThrow(RangeError);
    expect(() => mb.declareSparse(['a\u0000b'])).toThrow(RangeError);
    expect(normalizeSparsePatterns(['a', 1])).toBeNull();
  });

  it('🔴 竄改與冒名的那一筆丟掉，名單其他部分照收；沒有 sparse 的舊名單照收、不震盪', () => {
    const { a, b, c, ma, mb, mc } = trio();
    mb.declareSparse(['Daily/']);
    mc.declareSparse(['Inbox/']);
    const data = mb.roster() as VaultRosterData;
    data.sparse = data.sparse!.map((s) => (s.pubkey === b.pubkey ? { ...s, patterns: ['/'] } : s));
    // c 的宣告被 b 冒名搬過去（簽章對不上 b 的公鑰）
    const forged = { ...mc.roster().sparse![0]!, pubkey: b.pubkey };
    ma.merge(data, b.pubkey);
    expect(ma.scopeOf(b.pubkey)).toBeNull();
    ma.merge({ ...mb.roster(), sparse: [forged] }, b.pubkey);
    expect(ma.scopeOf(b.pubkey)).toBeNull();
    ma.merge(mc.roster(), c.pubkey);
    expect(ma.scopeOf(c.pubkey)).toEqual(['Inbox/']);
    // 舊版（沒有這一欄）的名單：照收，宣告留著
    const old = ma.roster() as VaultRosterData;
    delete old.sparse;
    const before = JSON.stringify(ma.roster());
    ma.merge(old, a.pubkey);
    expect(JSON.stringify(ma.roster())).toBe(before);
  });

  it('撤銷的裝置的宣告丟掉；持久化保留宣告', () => {
    const { a, b, ma, mb } = trio();
    mb.declareSparse(['Daily/']);
    ma.merge(mb.roster(), b.pubkey);
    expect(VaultMembership.restore(ma.toJSON(), a).scopeOf(b.pubkey)).toEqual(['Daily/']);
    ma.revoke(b.pubkey);
    expect(ma.roster().sparse).toBeUndefined();
    expect(ma.sparseMembers()).toEqual([]);
  });

  it('allDeclare：所有有效成員（含自己）都宣告了才是 true；舊版（沒宣告）就是 false', () => {
    const { a, b, c, ma, mb, mc } = trio();
    const on = { ...CURRENT_DEVICE_CAPABILITIES, [MERGE_RULES_CAPABILITY]: true };
    ma.declareCapabilities(on);
    mb.declareCapabilities(on);
    ma.merge(mb.roster(), b.pubkey);
    expect(ma.allDeclare(MERGE_RULES_CAPABILITY)).toBe(false);
    mc.declareCapabilities({ ...on, [MERGE_RULES_CAPABILITY]: false });
    ma.merge(mc.roster(), c.pubkey);
    expect(ma.allDeclare(MERGE_RULES_CAPABILITY)).toBe(false);
    mc.declareCapabilities(on);
    ma.merge(mc.roster(), c.pubkey);
    expect(ma.allDeclare(MERGE_RULES_CAPABILITY)).toBe(true);
    expect(VaultMembership.restore(ma.toJSON(), a).allDeclare(MERGE_RULES_CAPABILITY)).toBe(true);
  });

  it('上限：32 台都宣告塞滿（含備援），名單事件仍在中繼的單顆上限內', { timeout: 60_000 }, () => {
    const owner = Identity.generate();
    const m = VaultMembership.create({ signer: owner, label: '桌'.repeat(40) });
    const full = (i: number) => Array.from({ length: ROSTER_SPARSE_MAX_PATTERNS }, (_, j) => `/${i}-${j}/${'p'.repeat(40)}/`);
    m.declareSparse(full(0));
    for (let i = 1; i < 32; i += 1) {
      const id = Identity.generate();
      add(m, id, '機'.repeat(40));
      const o = VaultMembership.fromRoster(id, m.roster());
      o.declareSparse(full(i));
      o.declareStandby(Array.from({ length: 4 }, (_, j) => `wss://s${i}-${j}.example/app/${'k'.repeat(160)}`));
      o.declareCapabilities({ ...CURRENT_DEVICE_CAPABILITIES, conflictCallouts: true, [MERGE_RULES_CAPABILITY]: true });
      m.merge(o.roster(), id.pubkey);
    }
    expect(m.sparseMembers()).toHaveLength(32);
    for (const outerKind of [1060, 1059] as const) {
      const [event] = buildRosterEvents(m, owner, [m.peerPubkeys()[0]!], { outerKind });
      expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThanOrEqual(262_144);
    }
  });
});

describe('配對：歡迎訊息只帶邀請方自己的輕量宣告', () => {
  it('其他成員的宣告之後經名單同步補上', async () => {
    const relay = new FakeRelay();
    const clock = new ManualClock();
    const [member, other, joiner] = [Identity.generate(), Identity.generate(), Identity.generate()];
    const membership = VaultMembership.create({ signer: member, label: 'Desktop' }, { now: () => clock.now() });
    add(membership, other, 'Phone');
    const mo = VaultMembership.fromRoster(other, membership.roster());
    mo.declareSparse(['Daily/']);
    membership.merge(mo.roster(), other.pubkey);
    membership.declareSparse(['Notes/']);
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: ['wss://r.example'], clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, device: { label: 'Tablet' } });
    await settle();
    scan.confirm();
    offer.confirm();
    await settle();
    const j = await scan.result;
    expect(j.membership.scopeOf(member.pubkey)).toEqual(['Notes/']);
    expect(j.membership.scopeOf(other.pubkey)).toBeNull();
    j.membership.merge(membership.roster(), member.pubkey);
    expect(j.membership.scopeOf(other.pubkey)).toEqual(['Daily/']);
  });
});
