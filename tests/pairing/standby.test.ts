// 備援中繼清單經名單共享（SDK ADR 0056，使用者裁示「甲」）：每台在名單上自己簽一份備援清單（能力宣告的延伸）；
// 收方只得到「建議新增的備援」——只新增、不移除、不碰主清單、網址要是公開的 wss://、要測得通、由應用（使用者）確認才採用；
// 被忽略的記住、不再建議；配對時歡迎訊息帶邀請方的備援清單（同樣只是建議）。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  acceptPairingUri,
  buildRosterEvents,
  claimDevice,
  createPairingOffer,
  defaultDeviceId,
  isShareableStandbyUrl,
  normalizeStandbyUrl,
  NostrRosterSync,
  planStandbyAdoption,
  ROSTER_STANDBY_MAX_URL_LENGTH,
  ROSTER_STANDBY_MAX_URLS,
  StandbySuggestions,
  VaultMembership,
  type DeclaredStandby,
  type MembershipChange,
  type VaultRosterData,
} from '../../src/pairing/index.js';
import { ManualClock } from '../sync/vault/harness.js';
import { FakeRelay, settle } from './fake-relay.js';

const X = 'wss://standby-x.example';
const Y = 'wss://standby-y.example/app/k7q2mxz4ab3cd5ef6gh7ij2kl3';
const Z = 'wss://standby-z.example';
const PRIMARY = 'wss://relay.example';

function add(m: VaultMembership, id: Identity, label: string) {
  const deviceId = defaultDeviceId(id.pubkey);
  return m.addDevice({ pubkey: id.pubkey, deviceId, label, claim: claimDevice(id, { deviceId, label }) });
}

function trio(now?: () => number) {
  const [a, b, c] = [Identity.generate(), Identity.generate(), Identity.generate()];
  const opts = now ? { now } : {};
  const ma = VaultMembership.create({ signer: a, label: 'A' }, opts);
  add(ma, b, 'B');
  add(ma, c, 'C');
  const mb = VaultMembership.fromRoster(b, ma.roster(), opts);
  const mc = VaultMembership.fromRoster(c, ma.roster(), opts);
  return { a, b, c, ma, mb, mc };
}

describe('網址驗證：只分享公開的 wss:// 中繼', () => {
  it('正規化：主機小寫、去掉結尾斜線；路徑與查詢保留', () => {
    expect(normalizeStandbyUrl('  wss://Standby-X.Example/  ')).toBe(X);
    expect(normalizeStandbyUrl('wss://h.example/app/AbC/')).toBe('wss://h.example/app/AbC');
    expect(normalizeStandbyUrl('wss://h.example:8443/?a=1')).toBe('wss://h.example:8443/?a=1');
  });

  it.each([
    ['ws://', 'ws://standby.example'],
    ['https', 'https://standby.example'],
    ['帳密', 'wss://user:pw@standby.example'],
    ['只有帳號', 'wss://user@standby.example'],
    ['片段', 'wss://standby.example/#x'],
    ['太長', `wss://standby.example/${'a'.repeat(ROSTER_STANDBY_MAX_URL_LENGTH)}`],
    ['localhost', 'wss://localhost'],
    ['*.localhost', 'wss://relay.localhost'],
    ['.local', 'wss://nas.local'],
    ['.lan', 'wss://nas.lan'],
    ['.home.arpa', 'wss://nas.home.arpa'],
    ['.internal', 'wss://relay.corp.internal'],
    ['單一標籤', 'wss://nas'],
    ['127/8', 'wss://127.0.0.1'],
    ['127 的其他寫法', 'wss://0x7f.1'],
    ['0.0.0.0', 'wss://0.0.0.0'],
    ['10/8', 'wss://10.1.2.3'],
    ['172.16/12', 'wss://172.20.0.1'],
    ['192.168/16', 'wss://192.168.1.10:7777'],
    ['169.254/16', 'wss://169.254.169.254'],
    ['100.64/10（CGNAT）', 'wss://100.100.1.1'],
    ['多播', 'wss://224.0.0.1'],
    ['::1', 'wss://[::1]'],
    ['::', 'wss://[::]'],
    ['fc00::/7', 'wss://[fd12:3456::1]'],
    ['fe80::/10', 'wss://[fe80::1]'],
    ['IPv4 對應', 'wss://[::ffff:127.0.0.1]'],
    ['不是網址', 'not a url'],
  ])('不收：%s', (_why, url) => {
    expect(isShareableStandbyUrl(url)).toBe(false);
    expect(normalizeStandbyUrl(url)).toBeUndefined();
  });

  it.each([['公開主機', X], ['私人路徑', Y], ['公開 IPv4', 'wss://203.0.113.9'], ['172.32 不是私有', 'wss://172.32.0.1'], ['公開 IPv6', 'wss://[2001:db8::1]'], ['.test（測試保留網域，不是區網）', 'wss://relay.test']])(
    '收：%s',
    (_why, url) => {
      expect(isShareableStandbyUrl(url)).toBe(true);
    },
  );
});

describe('名單上的備援宣告（能力宣告的延伸，裝置自己簽）', () => {
  it('declareStandby：自己簽、進名單、發 change（reason caps）；內容沒變不重簽', () => {
    const { a, ma } = trio();
    const changes: MembershipChange[] = [];
    ma.onChange((c) => changes.push(c));
    expect(ma.declareStandby([X, `${Y}/`])).toBe(true);
    expect(changes.map((c) => c.reason)).toEqual(['caps']);
    expect(ma.standbyOf(a.pubkey)).toEqual([X, Y]);
    expect(ma.roster().standby).toHaveLength(1);
    expect(ma.declareStandby([X, Y])).toBe(false);
    expect(changes).toHaveLength(1);
  });

  it('只宣告分享得出去的：本機／私有網段、ws:// 丟掉，去重，最多前幾座', () => {
    const { a, ma } = trio();
    const many = Array.from({ length: ROSTER_STANDBY_MAX_URLS + 2 }, (_, i) => `wss://s${i}.example`);
    ma.declareStandby(['wss://192.168.1.2', 'ws://plain.example', X, X, ...many]);
    expect(ma.standbyOf(a.pubkey)).toEqual([X, ...many].slice(0, ROSTER_STANDBY_MAX_URLS));
  });

  it('宣告空清單也會送出（拿掉全部備援）；其他裝置看到的是空清單，不是「沒宣告」', () => {
    const { a, ma, mb } = trio();
    ma.declareStandby([X]);
    mb.merge(ma.roster(), a.pubkey);
    expect(mb.standbyOf(a.pubkey)).toEqual([X]);
    expect(ma.declareStandby([])).toBe(true);
    mb.merge(ma.roster(), a.pubkey);
    expect(mb.standbyOf(a.pubkey)).toEqual([]);
  });

  it('declaredStandbys：只有其他有效成員的宣告（不含自己、沒宣告的、被撤銷的）', () => {
    const { a, b, c, ma, mb, mc } = trio();
    mb.declareStandby([X]);
    mc.declareStandby([Z]);
    ma.merge(mb.roster(), b.pubkey);
    ma.merge(mc.roster(), c.pubkey);
    ma.declareStandby([Y]);
    const list = ma.declaredStandbys();
    expect(list.map((d) => d.pubkey).sort()).toEqual([b.pubkey, c.pubkey].sort());
    expect(list.find((d) => d.pubkey === b.pubkey)).toMatchObject({ deviceId: defaultDeviceId(b.pubkey), label: 'B', urls: [X] });
    ma.revoke(c.pubkey);
    expect(ma.declaredStandbys().map((d) => d.pubkey)).toEqual([b.pubkey]);
    expect(ma.standbyOf(c.pubkey)).toBeUndefined();
    expect(ma.roster().standby!.map((s) => s.pubkey).sort()).toEqual([a.pubkey, b.pubkey].sort());
  });

  it('後宣告的蓋過先前的；舊的經合併也蓋不回來', () => {
    let t = 1_000;
    const { b, ma, mb } = trio(() => t);
    mb.declareStandby([X]);
    const old = mb.roster();
    t += 1;
    mb.declareStandby([X, Z]);
    ma.merge(mb.roster(), b.pubkey);
    ma.merge(old, b.pubkey);
    expect(ma.standbyOf(b.pubkey)).toEqual([X, Z]);
  });

  it('🔴 簽章涵蓋清單：別的成員改不了、也冒名不了某台的備援（那一筆丟掉，名單其他部分照收）', () => {
    const { b, c, ma, mb, mc } = trio();
    mb.declareStandby([X]);
    ma.merge(mb.roster(), b.pubkey);
    // C 把 B 的備援換成自己控制的中繼
    const tampered = mb.roster();
    tampered.standby = tampered.standby!.map((s) => ({ ...s, urls: ['wss://evil.example'] }));
    ma.merge(tampered, c.pubkey);
    expect(ma.standbyOf(b.pubkey)).toEqual([X]);
    // C 用自己的簽章替 B 宣告
    mc.declareStandby(['wss://evil.example']);
    const forged = mc.roster();
    forged.standby = forged.standby!.map((s) => ({ ...s, pubkey: b.pubkey, at: s.at + 10_000 }));
    ma.merge(forged, c.pubkey);
    expect(ma.standbyOf(b.pubkey)).toEqual([X]);
  });

  it('向下相容：沒有 standby 欄位的名單照收、不會遺失也不會一直發 change；舊名單的欄位不變', () => {
    const { a, b, ma, mb } = trio();
    ma.declareStandby([X]);
    mb.merge(ma.roster(), a.pubkey);
    const legacy = mb.roster() as Partial<VaultRosterData>;
    delete legacy.standby;
    expect(ma.merge(legacy, b.pubkey)).toBe(false);
    expect(ma.standbyOf(a.pubkey)).toEqual([X]);
    // 舊版只讀 v、vaultId、devices、revoked、keys、caps——這些欄位的形狀沒變
    expect(Object.keys(ma.roster()).sort()).toEqual(['devices', 'keys', 'revoked', 'standby', 'v', 'vaultId']);
    expect(VaultMembership.fromRoster(b, legacy).declaredStandbys()).toEqual([]);
  });

  it('NostrRosterSync：宣告後自動送給其他成員，對方的 declaredStandbys 看得到', async () => {
    const relay = new FakeRelay();
    const { a, b, ma, mb } = trio();
    const syncs = [new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma }), new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb })];
    for (const s of syncs) s.start({ announce: false });
    ma.declareStandby([X]);
    await settle();
    expect(mb.declaredStandbys()).toEqual([expect.objectContaining({ pubkey: a.pubkey, label: 'A', urls: [X] })]);
    for (const s of syncs) s.stop();
  });

  it('持久化：toJSON／restore 保留備援宣告', () => {
    const { a, ma } = trio();
    ma.declareStandby([X]);
    expect(VaultMembership.restore(ma.toJSON(), a).standbyOf(a.pubkey)).toEqual([X]);
  });

  it('上限：32 台都宣告塞滿的備援，名單事件仍在中繼的單顆上限（262,144 bytes）內', { timeout: 60_000 }, () => {
    const owner = Identity.generate();
    const m = VaultMembership.create({ signer: owner, label: '桌'.repeat(40) });
    const longUrls = (i: number) =>
      Array.from({ length: ROSTER_STANDBY_MAX_URLS }, (_, j) => {
        const base = `wss://s${i}-${j}.example/app/`;
        return base + 'k'.repeat(ROSTER_STANDBY_MAX_URL_LENGTH - base.length);
      });
    m.declareStandby(longUrls(0));
    m.declareCapabilities({ sdk: '10.20.30-beta.12345', maxRelayFileBytes: 67_108_864, f1: 'x'.repeat(12), f2: 123_456_789, zz: true });
    for (let i = 1; i < 32; i += 1) {
      const id = Identity.generate();
      add(m, id, '機'.repeat(40));
      const o = VaultMembership.fromRoster(id, m.roster());
      o.declareStandby(longUrls(i));
      o.declareCapabilities({ sdk: '10.20.30-beta.12345', maxRelayFileBytes: 67_108_864, f1: 'x'.repeat(12), f2: 123_456_789, zz: false });
      m.merge(o.roster(), id.pubkey);
    }
    expect(m.declaredStandbys()).toHaveLength(31);
    for (const outerKind of [1060, 1059] as const) {
      const [event] = buildRosterEvents(m, owner, [m.peerPubkeys()[0]!], { outerKind });
      expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThanOrEqual(262_144);
    }
  });
});

describe('planStandbyAdoption：只新增備援的建議', () => {
  const declared = (pubkey: string, urls: string[], label = pubkey.slice(0, 4)): DeclaredStandby => ({ pubkey, deviceId: `d-${label}`, label, urls, at: 1 });

  it('排除自己已經有的（主清單或備援，比對時不分主機大小寫與結尾斜線）、被忽略的；同一個網址合併來源', () => {
    const plan = planStandbyAdoption({
      own: [PRIMARY, 'wss://Standby-Z.example/'],
      declared: [declared('b', [X, Z, `${PRIMARY}/`]), declared('c', [`${X}/`, Y])],
      ignored: [Y],
    });
    expect(plan).toEqual([{ url: X, sources: [{ pubkey: 'b', deviceId: 'd-b', label: 'b', via: 'roster' }, { pubkey: 'c', deviceId: 'd-c', label: 'c', via: 'roster' }] }]);
  });

  it('配對交來的也算一個來源（via: pairing）；不合規的網址不建議', () => {
    const plan = planStandbyAdoption({
      own: [PRIMARY],
      declared: [],
      offers: [{ source: { pubkey: 'm', deviceId: 'd-m', label: 'M' }, urls: [Z, 'wss://127.0.0.1', 'ws://x.example'] }],
    });
    expect(plan).toEqual([{ url: Z, sources: [{ pubkey: 'm', deviceId: 'd-m', label: 'M', via: 'pairing' }] }]);
  });

  it('isMember：不是有效成員的來源不算（例如配對之後被撤銷）', () => {
    const plan = planStandbyAdoption({
      own: [],
      declared: [declared('b', [X])],
      offers: [{ source: { pubkey: 'gone', deviceId: 'd', label: 'G' }, urls: [Z] }],
      isMember: (pk) => pk === 'b',
    });
    expect(plan.map((p) => p.url)).toEqual([X]);
  });
});

describe('StandbySuggestions：測試、記住忽略、通知', () => {
  function setup(reachable: Record<string, boolean>) {
    let t = 0;
    const probes: string[] = [];
    const s = new StandbySuggestions({
      probe: async (url) => {
        probes.push(url);
        return reachable[url] ?? false;
      },
      now: () => t,
      ignored: ['wss://ignored.example'],
    });
    return { s, probes, advance: (ms: number) => (t += ms) };
  }
  const b: DeclaredStandby = { pubkey: 'b', deviceId: 'dev-b', label: 'B', urls: [X, Z, 'wss://ignored.example'], at: 1 };

  it('新的建議先是 pending，測完變 reachable／unreachable；每個網址只測一次；有變化就通知', async () => {
    const { s, probes } = setup({ [X]: true });
    let changes = 0;
    s.onChange(() => (changes += 1));
    s.update({ own: [PRIMARY], declared: [b] });
    expect(s.list().map((x) => [x.url, x.probe])).toEqual([
      [X, 'pending'],
      [Z, 'pending'],
    ]);
    await settle();
    expect(s.list().map((x) => [x.url, x.probe])).toEqual([
      [X, 'reachable'],
      [Z, 'unreachable'],
    ]);
    expect(s.list()[0]!.sources).toEqual([{ pubkey: 'b', deviceId: 'dev-b', label: 'B', via: 'roster' }]);
    expect(changes).toBeGreaterThanOrEqual(2);
    s.update({ own: [PRIMARY], declared: [b] });
    await settle();
    expect(probes.sort()).toEqual([X, Z].sort());
  });

  it('ignore：從清單拿掉、記在 ignored()（應用存起來，下次建構時傳回）；之後再宣告也不建議', async () => {
    const { s } = setup({ [X]: true });
    s.update({ own: [], declared: [b] });
    await settle();
    s.ignore(`${X}/`);
    expect(s.list().map((x) => x.url)).toEqual([Z]);
    expect(s.ignored().sort()).toEqual(['wss://ignored.example', X].sort());
    s.update({ own: [], declared: [b] });
    expect(s.list().map((x) => x.url)).toEqual([Z]);
  });

  it('採用之後（自己的清單有了）就不再建議', async () => {
    const { s } = setup({ [X]: true });
    s.update({ own: [], declared: [b] });
    await settle();
    s.update({ own: [X], declared: [b] });
    expect(s.list().map((x) => x.url)).toEqual([Z]);
  });

  it('測不通的：refresh() 過了重試間隔才重測；測通後變 reachable', async () => {
    const reachable: Record<string, boolean> = {};
    const { s, probes, advance } = setup(reachable);
    s.update({ own: [], declared: [{ ...b, urls: [Z] }] });
    await settle();
    expect(s.list()[0]!.probe).toBe('unreachable');
    reachable[Z] = true;
    await s.refresh();
    expect(probes).toEqual([Z]);
    advance(60 * 60_000);
    await s.refresh();
    expect(probes).toEqual([Z, Z]);
    expect(s.list()[0]!.probe).toBe('reachable');
  });

  it('offer：配對交來的建議與名單上的合併；isMember 過濾掉不是成員的來源', async () => {
    const { s } = setup({ [Y]: true });
    s.offer({ pubkey: 'm', deviceId: 'dev-m', label: 'M' }, [Y]);
    s.update({ own: [], declared: [], isMember: (pk) => pk === 'm' });
    await settle();
    expect(s.list()).toEqual([expect.objectContaining({ url: Y, probe: 'reachable', sources: [{ pubkey: 'm', deviceId: 'dev-m', label: 'M', via: 'pairing' }] })]);
    s.update({ own: [], declared: [], isMember: () => false });
    expect(s.list()).toEqual([]);
  });
});

describe('配對：歡迎訊息帶邀請方的備援清單（建議，要確認）', () => {
  const RELAYS = ['wss://r1.example', 'wss://r2.example'];

  async function pair(memberOpts: { standby?: readonly string[] }, declare?: string[]) {
    const relay = new FakeRelay();
    const clock = new ManualClock();
    const member = Identity.generate();
    const joiner = Identity.generate();
    const membership = VaultMembership.create({ signer: member, label: 'Desktop' }, { now: () => clock.now() });
    if (declare) membership.declareStandby(declare);
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock, ...memberOpts });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, device: { label: 'Phone' } });
    await settle();
    scan.confirm();
    offer.confirm();
    await settle();
    const [m, j] = await Promise.all([offer.result, scan.result]);
    return { member, m, j };
  }

  it('預設帶邀請方在名單上宣告的備援；新裝置的 result.standby 拿到（要使用者確認才加入）', async () => {
    const { member, m, j } = await pair({}, [X, Y]);
    expect(j.standby).toEqual([X, Y]);
    expect(m.standby).toEqual([X, Y]);
    expect(j.relays).toEqual(RELAYS);
    // 名單本身照樣帶著邀請方的宣告（之後名單同步也會帶）
    expect(j.membership.standbyOf(member.pubkey)).toEqual([X, Y]);
  });

  it('opts.standby 指定要交的備援；不合規的（私有網段、ws://）不交', async () => {
    const { j } = await pair({ standby: [Z, 'wss://192.168.0.2', 'ws://plain.example'] });
    expect(j.standby).toEqual([Z]);
  });

  it('歡迎訊息裡的名單只帶邀請方自己的備援宣告（其他成員的之後經名單同步補上）', async () => {
    const relay = new FakeRelay();
    const clock = new ManualClock();
    const [member, other, joiner] = [Identity.generate(), Identity.generate(), Identity.generate()];
    const membership = VaultMembership.create({ signer: member, label: 'Desktop' }, { now: () => clock.now() });
    add(membership, other, 'Laptop');
    const mo = VaultMembership.fromRoster(other, membership.roster());
    mo.declareStandby([Z]);
    membership.merge(mo.roster(), other.pubkey);
    membership.declareStandby([X]);
    const offer = createPairingOffer({ role: 'invite', signer: member, pool: relay.pool('M'), membership, relays: RELAYS, clock });
    const scan = acceptPairingUri(offer.uri!, { signer: joiner, pool: relay.pool('J'), clock, device: { label: 'Phone' } });
    await settle();
    scan.confirm();
    offer.confirm();
    await settle();
    const j = await scan.result;
    expect(j.standby).toEqual([X]);
    expect(j.membership.standbyOf(member.pubkey)).toEqual([X]);
    expect(j.membership.standbyOf(other.pubkey)).toBeUndefined();
    j.membership.merge(membership.roster(), member.pubkey);
    expect(j.membership.standbyOf(other.pubkey)).toEqual([Z]);
  });

  it('沒有備援 → 空清單', async () => {
    const { j } = await pair({});
    expect(j.standby).toEqual([]);
  });
});
