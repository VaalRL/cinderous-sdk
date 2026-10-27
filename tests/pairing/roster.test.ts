// Vault 名單（SDK ADR 0028 §4、§5、§6）：合併、簽章、撤銷永遠贏、撤銷後輪換、並發輪換收斂、非成員的更新不收、
// deviceId 相撞、白名單、上限（部分保留、塞得進 NIP-44）、持久化、名單同步；以及安全審查 #1–#4 的攻擊情境。
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  buildRosterEvents,
  claimDevice,
  defaultDeviceId,
  NostrRosterSync,
  openRosterEvent,
  ROSTER_MAX_DEVICES,
  ROSTER_MAX_EPOCH,
  ROSTER_MAX_KEYS,
  ROSTER_MAX_REVOKED,
  CURRENT_DEVICE_CAPABILITIES,
  LEGACY_MAX_RELAY_FILE_BYTES,
  ROSTER_CAPS_MAX_JSON,
  ROSTER_STANDBY_MAX_URL_LENGTH,
  ROSTER_STANDBY_MAX_URLS,
  SDK_VERSION,
  VaultMembership,
  type MembershipChange,
  type VaultRosterData,
} from '../../src/pairing/index.js';
import { sealAndWrap } from '../../src/protocol/nip59.js';
import { RELAY_FILE_MAX_BYTES_CAP } from '../../src/sync/file-relay.js';
import { FILE_TIER_MAX_BYTES } from '../../src/sync/ingest.js';
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

/** 讓兩份名單互相合併到靜止 */
function sync(pairs: Array<[VaultMembership, VaultMembership]>, rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    for (const [x, y] of pairs) {
      y.merge(x.roster(), x.self);
      x.merge(y.roster(), y.self);
    }
  }
}

describe('VaultMembership', () => {
  it('建立：查詢給協調器、PeerNode、白名單；每一筆都有簽章', () => {
    const { a, b, c, ma, mb } = trio();
    expect(ma.devices().map((d) => d.label).sort()).toEqual(['A', 'B', 'C']);
    expect(mb.peerPubkeys().sort()).toEqual([a.pubkey, c.pubkey].sort());
    expect(mb.peerDevices()).toEqual({ [defaultDeviceId(a.pubkey)]: a.pubkey, [defaultDeviceId(c.pubkey)]: c.pubkey });
    expect(mb.deviceIdOf(c.pubkey)).toBe(defaultDeviceId(c.pubkey));
    expect(ma.allowedPubkeys()).toEqual([a.pubkey, b.pubkey, c.pubkey].sort());
    const pending = Identity.generate().pubkey;
    expect(ma.allowedPubkeys([pending])).toContain(pending);
    expect(ma.currentKey().key).toHaveLength(32);
    expect(ma.currentKey().epoch).toBe(1);
    expect([...mb.currentKey().key]).toEqual([...ma.currentKey().key]);
    expect(ma.devicesAddedBy(a.pubkey).map((d) => d.pubkey).sort()).toEqual([b.pubkey, c.pubkey].sort());
  });

  it('加入要那台裝置自己的簽章；別的公鑰的預設 deviceId 不能拿來用', () => {
    const { ma, b } = trio();
    const x = Identity.generate();
    expect(() => ma.addDevice({ pubkey: x.pubkey, deviceId: 'x', claim: claimDevice(b, { deviceId: 'x' }) })).toThrow(/聲明/);
    expect(() => add(ma, x, defaultDeviceId(b.pubkey))).toThrow(/保留/);
    expect(add(ma, x, 'x')).toBe(true);
  });

  it('撤銷：從名單、白名單、收件人移除；輪換金鑰；被撤銷者的更新不再被接受；不能再加回來', () => {
    const { a, b, c, ma, mb, mc } = trio();
    const oldKey = ma.currentKey();
    const changes: MembershipChange[] = [];
    ma.onChange((ch) => changes.push(ch));
    ma.revoke(c.pubkey);
    expect(changes.at(-1)).toMatchObject({ reason: 'revoke', revoked: [c.pubkey], keyChanged: true });
    expect(ma.isMember(c.pubkey)).toBe(false);
    expect(ma.allowedPubkeys([c.pubkey])).not.toContain(c.pubkey);
    expect(ma.peerPubkeys()).toEqual([b.pubkey]);
    const newKey = ma.currentKey();
    expect(newKey.epoch).toBe(2);
    expect(ma.key(oldKey.id)).toBeDefined(); // 舊金鑰留著解舊內容

    expect(mb.merge(ma.roster(), a.pubkey)).toBe(true);
    expect([...mb.currentKey().key]).toEqual([...newKey.key]);
    add(mc, Identity.generate(), 'evil');
    expect(mb.merge(mc.roster(), c.pubkey)).toBe(false);
    expect(mb.devices().map((d) => d.deviceId)).not.toContain('evil');
    expect(() => add(ma, c, 'again')).toThrow(/撤銷/);
    expect(() => ma.revoke(a.pubkey)).toThrow(/自己/);
  });

  it('被撤銷的裝置收到名單時知道自己出局（selfRevoked），之後不能再改名單', () => {
    const { a, c, ma, mc } = trio();
    ma.revoke(c.pubkey);
    const changes: MembershipChange[] = [];
    mc.onChange((ch) => changes.push(ch));
    expect(mc.merge(ma.roster(), a.pubkey)).toBe(true);
    expect(changes.at(-1)?.selfRevoked).toBe(true);
    expect(mc.active).toBe(false);
    expect(mc.peerPubkeys()).toEqual([]);
    expect(() => add(mc, Identity.generate(), 'z')).toThrow(/不是成員/);
  });

  it('不是成員送來的、Vault 不同的、欄位或簽章不對的名單一律不收', () => {
    const { ma, mb, b } = trio();
    const stranger = Identity.generate();
    expect(ma.merge(mb.roster(), stranger.pubkey)).toBe(false);
    const other = VaultMembership.create({ signer: b });
    expect(ma.merge(other.roster(), b.pubkey)).toBe(false);
    const r = mb.roster();
    expect(ma.merge({ ...r, devices: [{ ...r.devices[0]!, label: 'renamed' }] }, b.pubkey)).toBe(false); // 簽章不符
    expect(ma.merge({ ...r, keys: [{ ...r.keys[0]!, id: '0'.repeat(16) }] }, b.pubkey)).toBe(false);
    expect(ma.merge({ ...r, revoked: [{ pubkey: stranger.pubkey, at: 1, by: b.pubkey, sig: r.devices[0]!.sig }] }, b.pubkey)).toBe(false);
  });

  it('並發：A 撤銷 C、同時 B 加入 D → 合併後 C 出局、D 在；兩邊一致', () => {
    const { c, ma, mb } = trio();
    const d = Identity.generate();
    ma.revoke(c.pubkey);
    add(mb, d, 'd');
    sync([[ma, mb]]);
    for (const m of [ma, mb]) {
      expect(m.isMember(c.pubkey)).toBe(false);
      expect(m.isMember(d.pubkey)).toBe(true);
    }
    expect(ma.roster()).toEqual(mb.roster());
  });

  it('並發撤銷兩台、各自輪換：合併後再輪換一次，收斂到同一把「兩台都不知道」的金鑰', () => {
    const [a, b, x, y] = [Identity.generate(), Identity.generate(), Identity.generate(), Identity.generate()];
    const ma = VaultMembership.create({ signer: a });
    for (const [id, name] of [[b, 'b'], [x, 'x'], [y, 'y']] as const) add(ma, id, name);
    const mb = VaultMembership.fromRoster(b, ma.roster());
    const my = VaultMembership.fromRoster(y, ma.roster());
    ma.revoke(x.pubkey); // A 不知道 Y 也要被撤：A 的新金鑰會送給 Y
    mb.revoke(y.pubkey);
    expect(my.merge(ma.roster(), a.pubkey)).toBe(true);
    const keyYKnows = ma.currentKey().id;
    sync([[ma, mb]]);
    expect(ma.roster()).toEqual(mb.roster());
    const current = ma.currentKey();
    expect(current.id).not.toBe(keyYKnows);
    expect(my.key(current.id)).toBeUndefined();
  });

  it('🔴 審查 #1：被入侵的成員 R 先塞一把 epoch 很大的金鑰（還偽稱 rv 已涵蓋自己的撤銷）→ R 被撤銷後那把金鑰不能當目前的金鑰', () => {
    const { a, b, c: r, ma, mb, mc: mr } = trio();
    // R 自己輪換很多次，最後一把的 epoch 最大；再把自己的名單送出去（還是成員時）
    for (let i = 0; i < 5; i += 1) mr.rotateKey();
    const rKey = mr.currentKey();
    expect(ma.merge(mr.roster(), r.pubkey)).toBe(true);
    expect(mb.merge(mr.roster(), r.pubkey)).toBe(true);
    expect(ma.currentKey().id).toBe(rKey.id);
    // 偽造「A 撤銷了 R」：簽章是 R 的，不是 A 的 → 整筆不收
    const forged: VaultRosterData = { ...mr.roster(), revoked: [{ pubkey: r.pubkey, at: 1, by: a.pubkey, sig: mr.roster().keys[0]!.sig }] };
    expect(mb.merge(forged, r.pubkey)).toBe(false);
    // 真的撤銷 R
    ma.revoke(r.pubkey);
    sync([[ma, mb]]);
    const current = ma.currentKey();
    expect(current.by).not.toBe(r.pubkey);
    expect(mr.key(current.id)).toBeUndefined();
    expect(mb.currentKey().id).toBe(current.id);
    expect(current.epoch).toBeLessThanOrEqual(rKey.epoch + 1);
    void b;
  });

  it('🔴 審查 #2：epoch 超過上限整筆不收；被撤銷者的超大 epoch 不影響之後的輪換', () => {
    const { b, ma, mb } = trio();
    const r = mb.roster();
    expect(ma.merge({ ...r, keys: r.keys.map((k) => ({ ...k, epoch: ROSTER_MAX_EPOCH + 1 })) }, b.pubkey)).toBe(false);
    expect(ma.merge({ ...r, keys: r.keys.map((k) => ({ ...k, epoch: Number.MAX_SAFE_INTEGER })) }, b.pubkey)).toBe(false);
  });

  it('🔴 審查 #3：別的成員改不了某台裝置的 deviceId、名稱或加入者（沒有那台的簽章）', () => {
    const { b, c, ma, mb } = trio();
    const r = mb.roster();
    const cEntry = r.devices.find((d) => d.pubkey === c.pubkey)!;
    // 就算 B 用自己的身分重簽整筆，claim 仍是 C 簽的「原本的 deviceId」
    const tampered = { ...r, devices: r.devices.map((d) => (d.pubkey === c.pubkey ? { ...cEntry, deviceId: '0', addedAt: 0, addedBy: b.pubkey } : d)) };
    expect(ma.merge(tampered, b.pubkey)).toBe(false);
    expect(ma.deviceIdOf(c.pubkey)).toBe(defaultDeviceId(c.pubkey));
  });

  it('🔴 審查 #4：被入侵的成員先塞滿撤銷紀錄，之後照樣撤銷得了它；兩個分區合計超過上限時部分保留並收斂', { timeout: 60_000 }, () => {
    const { a, b, c: r, ma, mb, mc: mr } = trio();
    const junk = Array.from({ length: ROSTER_MAX_REVOKED }, () => Identity.generate().pubkey);
    mr.revoke(junk);
    expect(ma.merge(mr.roster(), r.pubkey)).toBe(true);
    expect(ma.revocations()).toHaveLength(ROSTER_MAX_REVOKED);
    expect(() => ma.revoke(r.pubkey)).not.toThrow();
    expect(ma.isRevoked(r.pubkey)).toBe(true);
    expect(ma.revocations()).toHaveLength(ROSTER_MAX_REVOKED); // 丟的是 R 塞的那些
    sync([[ma, mb]]);
    expect(mb.isRevoked(r.pubkey)).toBe(true);

    // 分區：A、B 各自加到上限
    const [p, q] = [Identity.generate(), Identity.generate()];
    const mp = VaultMembership.create({ signer: p });
    add(mp, q, 'q');
    const mq = VaultMembership.fromRoster(q, mp.roster());
    for (let i = 0; i < ROSTER_MAX_DEVICES - 2; i += 1) add(mp, Identity.generate(), `p${i}`);
    for (let i = 0; i < ROSTER_MAX_DEVICES - 2; i += 1) add(mq, Identity.generate(), `q${i}`);
    sync([[mp, mq]]);
    expect(mp.roster()).toEqual(mq.roster());
    expect(mp.devices().length).toBeLessThanOrEqual(ROSTER_MAX_DEVICES);
    void a;
    void b;
  });

  it('deviceId 相撞（兩台同時各加一台同名的）：各台一致地只認較早加入的那台', () => {
    const { ma, mb } = trio();
    const [p, q] = [Identity.generate(), Identity.generate()];
    add(ma, p, 'phone');
    add(mb, q, 'phone');
    sync([[ma, mb]]);
    const winnerA = ma.devices().filter((d) => d.deviceId === 'phone');
    expect(winnerA).toHaveLength(1);
    expect(winnerA).toEqual(mb.devices().filter((d) => d.deviceId === 'phone'));
  });

  it('上限：32 台裝置＋32 筆撤銷＋8 把金鑰（名稱全用 40 個中文字）＋塞滿的備援宣告仍塞得進名單事件與歡迎訊息（NIP-44 明文上限）', { timeout: 60_000 }, () => {
    const owner = Identity.generate();
    const m = VaultMembership.create({ signer: owner, label: '桌'.repeat(40) });
    for (let i = 0; i < ROSTER_MAX_REVOKED; i += 1) {
      const id = Identity.generate();
      add(m, id, `r${i}`, '機'.repeat(40));
      m.revoke(id.pubkey);
    }
    // G9（SDK ADR 0035）：每一台都宣告了塞到上限的能力（未來版本的欄位也算進去）
    const bigCaps = (i: number) => ({ sdk: '10.20.30-beta.12345', maxRelayFileBytes: 67_108_864, f1: 'x'.repeat(12), f2: 123_456_789, zz: i % 2 === 0 });
    // SDK ADR 0056：每一台都宣告塞滿的備援（最多座數、最長網址）
    const bigStandby = (i: number) =>
      Array.from({ length: ROSTER_STANDBY_MAX_URLS }, (_, j) => {
        const base = `wss://s${i}-${j}.example/app/`;
        return base + 'k'.repeat(ROSTER_STANDBY_MAX_URL_LENGTH - base.length);
      });
    m.declareCapabilities(bigCaps(0));
    m.declareStandby(bigStandby(0));
    expect(JSON.stringify(m.capabilitiesOf(owner.pubkey)).length).toBeLessThanOrEqual(ROSTER_CAPS_MAX_JSON);
    const others: VaultMembership[] = [];
    for (let i = 1; i < ROSTER_MAX_DEVICES; i += 1) {
      const id = Identity.generate();
      add(m, id, `dev-${'x'.repeat(56)}${i}`, '機'.repeat(40));
      const o = VaultMembership.fromRoster(id, m.roster());
      o.declareCapabilities(bigCaps(i));
      o.declareStandby(bigStandby(i));
      others.push(o);
      m.merge(o.roster(), id.pubkey);
    }
    expect(m.minCapability().missing).toEqual([]);
    expect(() => add(m, Identity.generate(), 'one-more')).toThrow();
    expect(m.keys()).toHaveLength(ROSTER_MAX_KEYS);
    const peer = m.peerPubkeys()[0]!;
    expect(buildRosterEvents(m, owner, [peer])).toHaveLength(1);
    expect(m.declaredStandbys()).toHaveLength(ROSTER_MAX_DEVICES - 1);
    // 歡迎訊息：名單（備援宣告只留邀請方自己的）＋16 座長網址＋邀請方的備援，AEAD 後 base64，再包兩層 NIP-44
    const relays = Array.from({ length: 16 }, (_, i) => `wss://${'r'.repeat(500)}${i}`);
    const roster = m.roster();
    roster.standby = roster.standby!.filter((x) => x.pubkey === owner.pubkey);
    const plain = JSON.stringify({ roster, relays, standby: bigStandby(0) });
    const c = 'A'.repeat(Math.ceil(((plain.length + 40) * 4) / 3));
    const content = JSON.stringify({ v: 1, t: 'welcome', p: '0'.repeat(32), c });
    expect(content.length).toBeLessThanOrEqual(65_535);
    expect(() => sealAndWrap({ kind: 21003, created_at: 1, tags: [], content }, owner, peer, { kind: 21003, tags: [] })).not.toThrow();
  });

  it('持久化：toJSON／restore 來回；別的身分還原不了', () => {
    const { a, ma } = trio();
    const back = VaultMembership.restore(ma.toJSON(), a);
    expect(back.roster()).toEqual(ma.roster());
    expect(() => VaultMembership.restore(ma.toJSON(), Identity.generate())).toThrow();
  });

  it('名稱清掉控制字元、截到 40 字', () => {
    const m = VaultMembership.create({ signer: Identity.generate(), label: `a\u0000b‮${'c'.repeat(50)}` });
    expect(m.selfDevice!.label).toBe(`ab‮${'c'.repeat(37)}`);
  });
});

describe('NostrRosterSync', () => {
  it('新裝置加入 → 其他成員收到名單；撤銷 → 被撤銷的收不到新金鑰，其他人收到', async () => {
    const relay = new FakeRelay();
    const { a, b, c, ma, mb, mc } = trio();
    const syncs = [
      new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma }),
      new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb }),
      new NostrRosterSync({ pool: relay.pool('C'), signer: c, membership: mc }),
    ];
    for (const s of syncs) s.start({ announce: false });
    const d = Identity.generate();
    add(ma, d, 'd', 'D');
    await settle();
    expect(mb.isMember(d.pubkey)).toBe(true);
    expect(mc.isMember(d.pubkey)).toBe(true);

    const toC = () => relay.log.filter((x) => x.event.tags.some((t) => t[0] === 'p' && t[1] === c.pubkey)).length;
    const before = toC();
    mb.revoke(c.pubkey);
    await settle();
    expect(ma.isMember(c.pubkey)).toBe(false);
    expect([...ma.currentKey().key]).toEqual([...mb.currentKey().key]);
    expect(toC()).toBe(before + 1); // 撤銷之後只寄給 C 一份撤銷通知（SDK ADR 0105），沒有新金鑰
    expect(mc.key(mb.currentKey().id)).toBeUndefined();
    const toA = relay.log.filter((x) => x.event.tags.some((t) => t[0] === 'p' && t[1] === a.pubkey)).at(-1)!.event;
    expect(toA.kind).toBe(1060);
    expect(toA.tags.some((t) => t[0] === 'expiration')).toBe(true);
    expect(openRosterEvent(toA, a)).toMatchObject({ sender: b.pubkey });
    for (const s of syncs) s.stop();
  });

  it('啟動時補送目前的名單（給離線超過保留期的成員）；非成員送的名單事件不理', async () => {
    const relay = new FakeRelay();
    const { a, b, ma, mb } = trio();
    const d = Identity.generate();
    add(ma, d, 'd'); // B 離線時發生
    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb });
    sb.start({ announce: false });
    const sa = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma });
    sa.start();
    await settle();
    expect(mb.isMember(d.pubkey)).toBe(true);
    const stranger = Identity.generate();
    const evil = VaultMembership.create({ signer: stranger });
    for (const e of buildRosterEvents(evil, stranger, [b.pubkey])) relay.inject(e as never);
    await settle();
    expect(mb.isMember(stranger.pubkey)).toBe(false);
    sa.stop();
    sb.stop();
  });
});

describe('G9（SDK ADR 0035）：名單上的裝置能力宣告', () => {
  it('常數與同步零件、package.json 一致（配對子路徑不匯入同步零件，所以另外釘住）', () => {
    expect(LEGACY_MAX_RELAY_FILE_BYTES).toBe(FILE_TIER_MAX_BYTES);
    expect(CURRENT_DEVICE_CAPABILITIES.maxRelayFileBytes).toBe(RELAY_FILE_MAX_BYTES_CAP);
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
    expect(CURRENT_DEVICE_CAPABILITIES.sdk).toBe(pkg.version);
  });

  it('declareCapabilities：自己簽、進名單、同步給其他成員；預設宣告這一版 SDK 的能力', () => {
    const { a, b, ma, mb } = trio();
    const changes: MembershipChange[] = [];
    ma.onChange((c) => changes.push(c));
    expect(ma.declareCapabilities()).toBe(true);
    expect(changes.map((c) => c.reason)).toEqual(['caps']);
    expect(ma.capabilitiesOf(a.pubkey)).toEqual(CURRENT_DEVICE_CAPABILITIES);
    expect(ma.roster().caps).toHaveLength(1);
    expect(mb.merge(ma.roster(), a.pubkey)).toBe(true);
    expect(mb.capabilitiesOf(a.pubkey)).toEqual(CURRENT_DEVICE_CAPABILITIES);
    expect(mb.capabilitiesOf(b.pubkey)).toBeUndefined();
    // 內容沒變就不重簽、不發 change（啟動時每次呼叫也不會讓名單一直同步）
    expect(ma.declareCapabilities()).toBe(false);
    expect(changes).toHaveLength(1);
  });

  it('minCapability：任何一台沒宣告（舊版）→ 門檻用舊版的 16.5 MB，並列出是哪幾台；全部宣告後取最小值', () => {
    const { a, b, c, ma, mb, mc } = trio();
    expect(ma.minCapability()).toEqual({ maxRelayFileBytes: LEGACY_MAX_RELAY_FILE_BYTES, sdk: null, missing: [a.pubkey, b.pubkey, c.pubkey].sort() });
    ma.declareCapabilities({ sdk: '0.30.0', maxRelayFileBytes: 64 * 1024 * 1024 });
    mb.declareCapabilities({ sdk: '0.31.2', maxRelayFileBytes: 40 * 1024 * 1024 });
    sync([[ma, mb], [mb, mc], [ma, mc]]);
    expect(ma.minCapability()).toEqual({ maxRelayFileBytes: LEGACY_MAX_RELAY_FILE_BYTES, sdk: null, missing: [c.pubkey] });
    mc.declareCapabilities({ sdk: '0.30.10', maxRelayFileBytes: 50 * 1024 * 1024 });
    sync([[ma, mb], [mb, mc], [ma, mc]]);
    for (const m of [ma, mb, mc]) expect(m.minCapability()).toEqual({ maxRelayFileBytes: 40 * 1024 * 1024, sdk: '0.30.0', missing: [] });
  });

  it('被撤銷的裝置的能力不算；撤銷後門檻只看剩下的成員', () => {
    const { b, c, ma, mb, mc } = trio();
    ma.declareCapabilities({ sdk: '0.30.0', maxRelayFileBytes: 64 * 1024 * 1024 });
    mb.declareCapabilities({ sdk: '0.30.0', maxRelayFileBytes: 64 * 1024 * 1024 });
    sync([[ma, mb], [ma, mc]]);
    expect(ma.minCapability().missing).toEqual([c.pubkey]);
    ma.revoke(c.pubkey);
    expect(ma.minCapability()).toEqual({ maxRelayFileBytes: 64 * 1024 * 1024, sdk: '0.30.0', missing: [] });
    expect(ma.capabilitiesOf(c.pubkey)).toBeUndefined();
    void b;
  });

  it('後宣告的蓋過先前的（升級後重新宣告）；舊的宣告經合併也蓋不回來', () => {
    let t = 1_000;
    const [a, b] = [Identity.generate(), Identity.generate()];
    const ma = VaultMembership.create({ signer: a }, { now: () => t });
    add(ma, b);
    const mb = VaultMembership.fromRoster(b, ma.roster(), { now: () => t });
    mb.declareCapabilities({ sdk: '0.30.0', maxRelayFileBytes: 20 * 1024 * 1024 });
    const old = mb.roster();
    t += 1;
    mb.declareCapabilities({ sdk: '0.31.0', maxRelayFileBytes: 64 * 1024 * 1024 });
    ma.merge(mb.roster(), b.pubkey);
    expect(ma.capabilitiesOf(b.pubkey)).toEqual({ sdk: '0.31.0', maxRelayFileBytes: 64 * 1024 * 1024 });
    ma.merge(old, b.pubkey);
    expect(ma.capabilitiesOf(b.pubkey)).toEqual({ sdk: '0.31.0', maxRelayFileBytes: 64 * 1024 * 1024 });
  });

  it('🔴 簽章涵蓋能力：別的成員改不了、也冒名不了某台裝置的能力（整份名單不收）', () => {
    const { a, b, c, ma, mb, mc } = trio();
    mb.declareCapabilities({ sdk: '0.30.0', maxRelayFileBytes: 20 * 1024 * 1024 });
    ma.merge(mb.roster(), b.pubkey);
    // C 竄改 B 的能力（想讓大家送更大的檔給 B）
    const tampered = mb.roster();
    tampered.caps = tampered.caps!.map((x) => ({ ...x, caps: { ...x.caps, maxRelayFileBytes: 64 * 1024 * 1024 } }));
    expect(ma.merge(tampered, c.pubkey)).toBe(false);
    expect(ma.capabilitiesOf(b.pubkey)).toEqual({ sdk: '0.30.0', maxRelayFileBytes: 20 * 1024 * 1024 });
    // C 用自己的簽章替 B 宣告：一樣不收
    mc.declareCapabilities({ sdk: '0.30.0', maxRelayFileBytes: 64 * 1024 * 1024 });
    const forged = mc.roster();
    forged.caps = forged.caps!.map((x) => ({ ...x, pubkey: b.pubkey }));
    expect(ma.merge(forged, c.pubkey)).toBe(false);
    void a;
  });

  it('向下相容：沒有 caps 欄位的舊名單照收；舊版裝置轉送時丟掉 caps，合併回來不會遺失、也不會一直發 change', () => {
    const { a, b, ma, mb } = trio();
    ma.declareCapabilities();
    mb.merge(ma.roster(), a.pubkey);
    const legacy = mb.roster() as Partial<VaultRosterData>;
    delete legacy.caps;
    expect(ma.merge(legacy, b.pubkey)).toBe(false);
    expect(ma.capabilitiesOf(a.pubkey)).toEqual(CURRENT_DEVICE_CAPABILITIES);
    // 從沒有 caps 的名單建立、還原
    const restored = VaultMembership.fromRoster(b, legacy);
    expect(restored.minCapability().missing).toHaveLength(3);
  });

  it('未來版本多出來的能力欄位原樣保留、簽章照驗；格式不對或太大的不收', () => {
    const { a, b, ma, mb } = trio();
    ma.declareCapabilities({ sdk: '0.40.0', maxRelayFileBytes: 64 * 1024 * 1024, streamingV2: true, maxP2pMb: 512 });
    expect(mb.merge(ma.roster(), a.pubkey)).toBe(true);
    expect(mb.capabilitiesOf(a.pubkey)).toEqual({ sdk: '0.40.0', maxRelayFileBytes: 64 * 1024 * 1024, streamingV2: true, maxP2pMb: 512 });
    expect(() => mb.declareCapabilities({ sdk: 'not-semver', maxRelayFileBytes: 1 })).toThrow();
    expect(() => mb.declareCapabilities({ sdk: '0.30.0', maxRelayFileBytes: 0 })).toThrow();
    expect(() => mb.declareCapabilities({ sdk: '0.30.0', maxRelayFileBytes: 1, huge: 'x'.repeat(200) })).toThrow();
    expect(() => mb.declareCapabilities({ sdk: '0.30.0', maxRelayFileBytes: 1, nested: { a: 1 } } as never)).toThrow();
    void b;
  });

  it('持久化：toJSON／restore 保留能力宣告', () => {
    const { a, ma } = trio();
    ma.declareCapabilities();
    expect(VaultMembership.restore(ma.toJSON(), a).capabilitiesOf(a.pubkey)).toEqual(CURRENT_DEVICE_CAPABILITIES);
  });
});
