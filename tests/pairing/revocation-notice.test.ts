// 撤銷通知（SDK ADR 0105；2026-10-22 Pixel 8a 實機發現）：撤銷之後的名單只送給還是成員的裝置，
// 被撤銷的那台永遠收不到「自己被撤銷」——一直以為自己在同步（狀態 running、沒有任何提示），寫的內容卻沒有人收。
// 撤銷的那台另外送它一份精簡名單：只有它自己的撤銷紀錄＋它本來就有的舊金鑰，沒有裝置清單、沒有新金鑰。
// 用一般名單的格式送，所以被撤銷的裝置即使是舊版也照樣 `merge` 出 `selfRevoked`。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  buildRevocationNotice,
  claimDevice,
  defaultDeviceId,
  NostrRosterSync,
  openRosterEvent,
  VaultMembership,
  type MembershipChange,
  type VaultRosterData,
} from '../../src/pairing/index.js';
import { FakeRelay, settle } from './fake-relay.js';

function add(m: VaultMembership, id: Identity, deviceId = defaultDeviceId(id.pubkey), label = '') {
  return m.addDevice({ pubkey: id.pubkey, deviceId, label, claim: claimDevice(id, { deviceId, label }) });
}

function trio() {
  const [a, b, c] = [Identity.generate(), Identity.generate(), Identity.generate()];
  const ma = VaultMembership.create({ signer: a, label: 'A' });
  add(ma, b, defaultDeviceId(b.pubkey), 'B');
  add(ma, c, defaultDeviceId(c.pubkey), 'C');
  const mb = VaultMembership.fromRoster(b, ma.roster());
  const mc = VaultMembership.fromRoster(c, ma.roster());
  return { a, b, c, ma, mb, mc };
}

const toward = (relay: FakeRelay, pubkey: string) => relay.log.filter((x) => x.event.tags.some((t) => t[0] === 'p' && t[1] === pubkey));

describe('🔴 撤銷通知：被撤銷的裝置知道自己出局（SDK ADR 0105）', () => {
  it('在線時被撤銷：馬上收到、selfRevoked，拿不到新金鑰', async () => {
    const relay = new FakeRelay();
    const { a, b, c, ma, mb, mc } = trio();
    const syncs = [
      new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma }),
      new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb }),
      new NostrRosterSync({ pool: relay.pool('C'), signer: c, membership: mc }),
    ];
    for (const s of syncs) s.start({ announce: false });
    const changes: MembershipChange[] = [];
    mc.onChange((change) => changes.push(change));
    const before = toward(relay, c.pubkey).length;
    ma.revoke(c.pubkey);
    await settle();
    expect(toward(relay, c.pubkey).length).toBe(before + 1); // 只有那一份通知
    expect(mc.active).toBe(false);
    expect(changes.some((ch) => ch.selfRevoked)).toBe(true);
    expect(mc.key(ma.currentKey().id)).toBeUndefined();
    // 其他成員照常：B 收到撤銷與新金鑰
    expect(mb.isMember(c.pubkey)).toBe(false);
    expect([...mb.currentKey().key]).toEqual([...ma.currentKey().key]);
    for (const s of syncs) s.stop();
  });

  it('撤銷時離線：之後上線從收件匣補到，一樣 selfRevoked', async () => {
    const relay = new FakeRelay();
    const { a, c, ma, mc } = trio();
    const sa = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma });
    sa.start({ announce: false });
    ma.revoke(c.pubkey);
    await settle();
    const sc = new NostrRosterSync({ pool: relay.pool('C'), signer: c, membership: mc });
    sc.start({ announce: false });
    await settle();
    expect(mc.active).toBe(false);
    sa.stop();
    sc.stop();
  });

  it('通知的內容：沒有裝置清單、只有它自己的撤銷紀錄、沒有撤銷後的新金鑰', async () => {
    const relay = new FakeRelay();
    const { a, b, c, ma } = trio();
    const sa = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma });
    sa.start({ announce: false });
    ma.revoke(b.pubkey);
    ma.revoke(c.pubkey);
    await settle();
    const last = toward(relay, c.pubkey).at(-1)!.event;
    const opened = openRosterEvent(last, c)!;
    expect(opened.sender).toBe(a.pubkey);
    const roster = opened.roster as VaultRosterData;
    expect(roster.devices).toEqual([]);
    expect(roster.revoked.map((r) => r.pubkey)).toEqual([c.pubkey]);
    expect(roster.keys.map((k) => k.id)).not.toContain(ma.currentKey().id);
    expect(roster.keys.length).toBeGreaterThan(0);
    expect(roster.caps ?? []).toEqual([]);
    expect(roster.standby ?? []).toEqual([]);
    expect(roster.labels ?? []).toEqual([]);
    sa.stop();
  });

  it('buildRevocationNotice：不是被撤銷的裝置、或沒有舊金鑰可放時回 null', () => {
    const { a, b, ma } = trio();
    expect(buildRevocationNotice(ma, a, b.pubkey, { excludeKeyIds: [] })).toBeNull();
    ma.revoke(b.pubkey);
    const all = ma.roster().keys.map((k) => k.id);
    expect(buildRevocationNotice(ma, a, b.pubkey, { excludeKeyIds: all })).toBeNull();
    expect(buildRevocationNotice(ma, a, b.pubkey, { excludeKeyIds: [ma.currentKey().id] })).not.toBeNull();
  });

  it('其他成員從合併得知撤銷時不重送通知（只有撤銷的那台送）', async () => {
    const relay = new FakeRelay();
    const { a, b, c, ma, mb, mc } = trio();
    const sa = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma });
    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb });
    sa.start({ announce: false });
    sb.start({ announce: false });
    ma.revoke(c.pubkey);
    await settle();
    expect(toward(relay, c.pubkey).filter((x) => x.from === 'B')).toEqual([]);
    expect(toward(relay, c.pubkey).filter((x) => x.from === 'A').length).toBe(1);
    void mc;
    sa.stop();
    sb.stop();
  });
});
