// 名單上的改名宣告（SDK ADR 0069）：每台自己簽的名稱＋時間（與 `caps`、`standby`、`sparse` 並列的 `labels` 欄位），
// 較晚的蓋過；`devices()`／`selfDevice`／`declaredStandbys`／`sparseMembers` 都用宣告後的名稱。舊版略過、竄改的那一筆丟掉。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  acceptPairingUri,
  buildRosterEvents,
  claimDevice,
  createPairingOffer,
  CURRENT_DEVICE_CAPABILITIES,
  defaultDeviceId,
  ROSTER_LABEL_MAX,
  ROSTER_SPARSE_MAX_PATTERNS,
  VaultMembership,
  type MembershipChange,
  type VaultRosterData,
} from '../../src/pairing/index.js';
import { MERGE_RULES_CAPABILITY } from '../../src/sync/vault/index.js';
import { ManualClock } from '../sync/vault/harness.js';
import { FakeRelay, settle } from './fake-relay.js';

function add(m: VaultMembership, id: Identity, label: string) {
  const deviceId = defaultDeviceId(id.pubkey);
  return m.addDevice({ pubkey: id.pubkey, deviceId, label, claim: claimDevice(id, { deviceId, label }) });
}

function trio(now?: () => number) {
  const opts = now ? { now } : {};
  const [a, b, c] = [Identity.generate(), Identity.generate(), Identity.generate()];
  const ma = VaultMembership.create({ signer: a, label: 'Desktop' }, opts);
  add(ma, b, 'Phone');
  add(ma, c, 'Laptop');
  const mb = VaultMembership.fromRoster(b, ma.roster(), opts);
  const mc = VaultMembership.fromRoster(c, ma.roster(), opts);
  return { a, b, c, ma, mb, mc };
}

const labelOf = (m: VaultMembership, pubkey: string) => m.devices().find((d) => d.pubkey === pubkey)?.label;

describe('declareLabel：裝置自己帶時間重新簽名稱', () => {
  it('宣告、簽章、經名單合併到別台；devices()／selfDevice 用新名稱；沒變不重簽', () => {
    const { b, ma, mb } = trio();
    const changes: MembershipChange[] = [];
    mb.onChange((c) => changes.push(c));
    expect(mb.declareLabel('Pixel 8')).toBe(true);
    expect(changes.map((c) => c.reason)).toEqual(['caps']);
    expect(mb.declareLabel('Pixel 8')).toBe(false);
    expect(mb.selfDevice?.label).toBe('Pixel 8');
    expect(labelOf(mb, b.pubkey)).toBe('Pixel 8');
    expect(labelOf(ma, b.pubkey)).toBe('Phone');
    expect(ma.merge(mb.roster(), b.pubkey)).toBe(true);
    expect(labelOf(ma, b.pubkey)).toBe('Pixel 8');
    // 配對時的聲明（claim）不動，名單裡的原始那一筆照舊驗得過
    expect(ma.roster().devices.find((d) => d.pubkey === b.pubkey)?.label).toBe('Phone');
  });

  it('和配對時的名稱一樣、沒宣告過：不重簽；改回配對時的名稱：要宣告（蓋過較早的改名）', () => {
    const { b, ma, mb } = trio();
    expect(mb.declareLabel('Phone')).toBe(false);
    expect(mb.roster().labels).toBeUndefined();
    mb.declareLabel('Pixel 8');
    ma.merge(mb.roster(), b.pubkey);
    expect(mb.declareLabel('Phone')).toBe(true);
    ma.merge(mb.roster(), b.pubkey);
    expect(labelOf(ma, b.pubkey)).toBe('Phone');
  });

  it('名稱照配對時的規則清理（去控制字元、去頭尾空白、最長 40 字）；空字串也是合法的名稱', () => {
    const { mb } = trio();
    mb.declareLabel(`  手機\u0000${'機'.repeat(ROSTER_LABEL_MAX)}  `);
    expect(mb.selfDevice?.label).toBe(`手機${'機'.repeat(ROSTER_LABEL_MAX - 2)}`);
    expect(mb.declareLabel('')).toBe(true);
    expect(mb.selfDevice?.label).toBe('');
  });

  it('較晚的蓋過，與合併順序無關；同一毫秒連改兩次也是後改的贏', () => {
    let t = 1_000;
    const { a, b, ma, mb, mc } = trio(() => t);
    mb.declareLabel('First');
    const first = mb.roster();
    mb.declareLabel('Second'); // 同一毫秒：時間 +1
    const second = mb.roster();
    t = 2_000;
    ma.merge(second, b.pubkey);
    ma.merge(first, b.pubkey);
    mc.merge(first, b.pubkey);
    mc.merge(second, b.pubkey);
    expect(labelOf(ma, b.pubkey)).toBe('Second');
    expect(labelOf(mc, b.pubkey)).toBe('Second');
    // 轉手（a 轉給 c）也一樣
    expect(ma.roster().labels).toEqual(mc.roster().labels);
    expect(labelOf(VaultMembership.fromRoster(a, ma.roster()), b.pubkey)).toBe('Second');
  });

  it('🔴 竄改與冒名的那一筆丟掉，名單其他部分照收；沒有 labels 的舊名單照收、不震盪', () => {
    const { a, b, c, ma, mb, mc } = trio();
    mb.declareLabel('Pixel 8');
    mc.declareLabel('MacBook');
    const tampered = mb.roster() as VaultRosterData;
    tampered.labels = tampered.labels!.map((x) => ({ ...x, label: 'Evil' }));
    expect(ma.merge(tampered, b.pubkey)).toBe(false);
    expect(labelOf(ma, b.pubkey)).toBe('Phone');
    // c 的改名被 b 冒名搬過去（簽章對不上 b 的公鑰）
    const forged = { ...mc.roster().labels![0]!, pubkey: b.pubkey };
    ma.merge({ ...mb.roster(), labels: [forged] }, b.pubkey);
    expect(labelOf(ma, b.pubkey)).toBe('Phone');
    // 沒清理過的名稱（含控制字元）：那一筆丟掉
    const dirty = mb.roster() as VaultRosterData;
    dirty.labels = [{ ...dirty.labels![0]!, label: 'a\u0000b' }];
    ma.merge(dirty, b.pubkey);
    expect(labelOf(ma, b.pubkey)).toBe('Phone');
    ma.merge(mc.roster(), c.pubkey);
    expect(labelOf(ma, c.pubkey)).toBe('MacBook');
    // 舊版（沒有這一欄）的名單：照收，宣告留著
    const old = ma.roster() as VaultRosterData;
    delete old.labels;
    const before = JSON.stringify(ma.roster());
    expect(ma.merge(old, a.pubkey)).toBe(false);
    expect(JSON.stringify(ma.roster())).toBe(before);
  });

  it('只有自己能改自己的名稱：別人的名單帶來的別台宣告照收，但驗的是那一台的簽章', () => {
    const { b, c, ma, mb, mc } = trio();
    mc.declareLabel('MacBook');
    mb.merge(mc.roster(), c.pubkey);
    // b 轉手 c 的改名給 a：簽章是 c 的，照收
    ma.merge(mb.roster(), b.pubkey);
    expect(labelOf(ma, c.pubkey)).toBe('MacBook');
  });

  it('撤銷的裝置的宣告丟掉；持久化保留宣告；declaredStandbys、sparseMembers 用新名稱', () => {
    const { a, b, ma, mb } = trio();
    mb.declareLabel('Pixel 8');
    mb.declareStandby(['wss://standby.example']);
    mb.declareSparse(['Daily/']);
    ma.merge(mb.roster(), b.pubkey);
    expect(ma.declaredStandbys().map((s) => s.label)).toEqual(['Pixel 8']);
    expect(ma.sparseMembers().map((s) => s.label)).toEqual(['Pixel 8']);
    expect(labelOf(VaultMembership.restore(ma.toJSON(), a), b.pubkey)).toBe('Pixel 8');
    ma.revoke(b.pubkey);
    expect(ma.roster().labels).toBeUndefined();
  });

  it('被撤銷（不是成員）時不能宣告', () => {
    const { b, ma, mb } = trio();
    ma.revoke(b.pubkey);
    mb.merge(ma.roster(), ma.self);
    expect(mb.active).toBe(false);
    expect(() => mb.declareLabel('X')).toThrow();
  });

  it('上限：32 台都改名、能力／備援／輕量宣告塞滿，名單事件仍在中繼的單顆上限內', { timeout: 60_000 }, () => {
    const owner = Identity.generate();
    const m = VaultMembership.create({ signer: owner, label: '桌'.repeat(40) });
    const full = (i: number) => Array.from({ length: ROSTER_SPARSE_MAX_PATTERNS }, (_, j) => `/${i}-${j}/${'p'.repeat(40)}/`);
    m.declareSparse(full(0));
    m.declareLabel('改'.repeat(40));
    for (let i = 1; i < 32; i += 1) {
      const id = Identity.generate();
      add(m, id, '機'.repeat(40));
      const o = VaultMembership.fromRoster(id, m.roster());
      o.declareSparse(full(i));
      o.declareStandby(Array.from({ length: 4 }, (_, j) => `wss://s${i}-${j}.example/app/${'k'.repeat(160)}`));
      o.declareCapabilities({ ...CURRENT_DEVICE_CAPABILITIES, conflictCallouts: true, [MERGE_RULES_CAPABILITY]: true });
      o.declareLabel('名'.repeat(40));
      m.merge(o.roster(), id.pubkey);
    }
    expect(m.roster().labels).toHaveLength(32);
    for (const outerKind of [1060, 1059] as const) {
      const [event] = buildRosterEvents(m, owner, [m.peerPubkeys()[0]!], { outerKind });
      expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThanOrEqual(262_144);
    }
  });
});

describe('配對：歡迎訊息只帶邀請方自己的改名', () => {
  it('其他成員的改名之後經名單同步補上', async () => {
    const relay = new FakeRelay();
    const clock = new ManualClock();
    const [member, other, joiner] = [Identity.generate(), Identity.generate(), Identity.generate()];
    const membership = VaultMembership.create({ signer: member, label: 'Desktop' }, { now: () => clock.now() });
    add(membership, other, 'Phone');
    const mo = VaultMembership.fromRoster(other, membership.roster());
    mo.declareLabel('Pixel 8');
    membership.merge(mo.roster(), other.pubkey);
    membership.declareLabel('Workstation');
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: ['wss://r.example'], clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, device: { label: 'Tablet' } });
    await settle();
    scan.confirm();
    offer.confirm();
    await settle();
    const j = await scan.result;
    expect(labelOf(j.membership, member.pubkey)).toBe('Workstation');
    expect(labelOf(j.membership, other.pubkey)).toBe('Phone');
    j.membership.merge(membership.roster(), member.pubkey);
    expect(labelOf(j.membership, other.pubkey)).toBe('Pixel 8');
  });
});
