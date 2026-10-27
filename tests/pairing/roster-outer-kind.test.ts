// 名單同步的外層 kind（SDK ADR 0043；ADR 0028 §5 加註）：預設 1060 不變；`outerKind: 1059` 用標準 NIP-59 禮物包，
// 在不收 1060 的中繼車道（`blocked: files-disabled:`）上也能同步；兩端外層相同才互通；滿載 32 台仍在單顆上限內。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  buildRosterEvents,
  claimDevice,
  DEFAULT_ROSTER_OUTER_KIND,
  defaultDeviceId,
  NostrRosterSync,
  openRosterEvent,
  ROSTER_MAX_DEVICES,
  ROSTER_MAX_REVOKED,
  VaultMembership,
  type RosterOuterKind,
} from '../../src/pairing/index.js';
import { TIMESTAMP_JITTER_SECONDS } from '../../src/protocol/nip59.js';
import { guardFor } from '../../src/relay/host-config.js';
import { MessageStore } from '../../src/relay/message-store.js';
import { RelayPool } from '../../src/relay-pool.js';
import { CoreBridge } from '../core-bridge.js';
import { FakeRelay, settle } from './fake-relay.js';

/** 所有 kind 共用的單顆事件上限（`relay-core` 的 `MAX_EVENT_BYTES`） */
const RELAY_EVENT_MAX_BYTES = 262_144;

function add(m: VaultMembership, id: Identity, deviceId = defaultDeviceId(id.pubkey), label = '') {
  return m.addDevice({ pubkey: id.pubkey, deviceId, label, claim: claimDevice(id, { deviceId, label }) });
}

function pair() {
  const [a, b] = [Identity.generate(), Identity.generate()];
  const ma = VaultMembership.create({ signer: a, label: 'A' });
  add(ma, b, defaultDeviceId(b.pubkey), 'B');
  const mb = VaultMembership.fromRoster(b, ma.roster());
  return { a, b, ma, mb };
}

describe('預設行為不變（1060）', () => {
  it('預設外層 1060：事件、訂閱、解開都只認 1060', () => {
    const { a, b, ma } = pair();
    expect(DEFAULT_ROSTER_OUTER_KIND).toBe(1060);
    const [event] = buildRosterEvents(ma, a, [b.pubkey]);
    expect(event!.kind).toBe(1060);
    expect(openRosterEvent(event!, b)).toMatchObject({ sender: a.pubkey });
    const sync = new NostrRosterSync({ pool: new FakeRelay().pool('A'), signer: a, membership: ma });
    expect(sync.outerKind).toBe(1060);
    expect(sync.filters()).toEqual([{ kinds: [1060], '#p': [a.pubkey] }]);
    // 1059 的名單事件在預設設定下不認
    const [gift] = buildRosterEvents(ma, a, [b.pubkey], { outerKind: 1059 });
    expect(openRosterEvent(gift!, b)).toBeNull();
    expect(openRosterEvent(gift!, b, { outerKind: 1059 })).toMatchObject({ sender: a.pubkey });
  });

  it('外層只能是 1059 或 1060', () => {
    const { a, b, ma } = pair();
    expect(() => buildRosterEvents(ma, a, [b.pubkey], { outerKind: 14 as RosterOuterKind })).toThrow(RangeError);
    expect(() => new NostrRosterSync({ pool: new FakeRelay().pool('A'), signer: a, membership: ma, outerKind: 30078 as RosterOuterKind })).toThrow(RangeError);
  });

  it('1059 的訂閱也往前退讓 NIP-59 的兩天', () => {
    const { a, ma } = pair();
    const sync = new NostrRosterSync({ pool: new FakeRelay().pool('A'), signer: a, membership: ma, outerKind: 1059, since: 1_000_000 });
    expect(sync.filters()).toEqual([{ kinds: [1059], '#p': [a.pubkey], since: 1_000_000 - TIMESTAMP_JITTER_SECONDS }]);
  });
});

describe('兩種外層的互通', () => {
  for (const outerKind of [1059, 1060] as const) {
    it(`兩端都用 ${outerKind}：新裝置加入 → 對方收到`, async () => {
      const relay = new FakeRelay();
      const { a, b, ma, mb } = pair();
      const sa = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma, outerKind });
      const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb, outerKind });
      sa.start({ announce: false });
      sb.start({ announce: false });
      const c = Identity.generate();
      add(ma, c, 'c', 'C');
      await settle();
      expect(mb.isMember(c.pubkey)).toBe(true);
      expect(relay.log.every((x) => x.event.kind === outerKind)).toBe(true);
      sa.stop();
      sb.stop();
    });
  }

  it('外層不同就不互通（1059 的一端收不到 1060 的，反之亦然）', async () => {
    const relay = new FakeRelay();
    const { a, b, ma, mb } = pair();
    const sa = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma, outerKind: 1059 });
    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb });
    sa.start({ announce: false });
    sb.start({ announce: false });
    const c = Identity.generate();
    add(ma, c, 'c', 'C');
    await settle();
    expect(mb.isMember(c.pubkey)).toBe(false);
    sa.stop();
    sb.stop();
  });
});

describe('不收 1060 的 SDK 中繼車道（guardFor("app")）', () => {
  /** 真的 RelayCore（第三方車道政策、沒開檔案事件）＋真的 RelayPool */
  function lane() {
    const bridge = new CoreBridge({ store: new MessageStore(), ...guardFor('app') });
    const pools: RelayPool[] = [];
    const pool = (identity: Identity) => {
      const p = new RelayPool({ urls: ['wss://lane'], identity, createSocket: bridge.create });
      p.connect();
      pools.push(p);
      return p;
    };
    return { pool, close: () => pools.forEach((p) => p.close()) };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('🔴 預設 1060 被拒（files-disabled）；1059 同步得到', async () => {
    const { pool, close } = lane();
    const { a, b, ma, mb } = pair();

    // 1060：中繼整類拒收，送不出去
    const errors: unknown[] = [];
    const rejections: string[] = [];
    const s1060 = new NostrRosterSync({
      pool: pool(a),
      signer: a,
      membership: ma,
      eventsPerMinute: 10_000,
      onError: (e) => errors.push(e),
      onPublishRejected: (r) => rejections.push(...r.rejected.map((x) => x.reason)),
    });
    await tick();
    await expect(s1060.announce([b.pubkey])).rejects.toThrow(/名單送不出去/);
    expect(rejections.some((r) => /^blocked: files-disabled:/.test(r))).toBe(true);

    // 1059：同一座中繼收得下，對方合併得到
    const sa = new NostrRosterSync({ pool: pool(a), signer: a, membership: ma, outerKind: 1059, eventsPerMinute: 10_000 });
    const sb = new NostrRosterSync({ pool: pool(b), signer: b, membership: mb, outerKind: 1059, eventsPerMinute: 10_000 });
    sb.start({ announce: false });
    sa.start({ announce: false });
    await tick();
    const c = Identity.generate();
    add(ma, c, 'c', 'C');
    for (let i = 0; i < 50 && !mb.isMember(c.pubkey); i += 1) await tick();
    expect(mb.isMember(c.pubkey)).toBe(true);
    sa.stop();
    sb.stop();
    close();
  });

  it('🔴 名單滿載（32 台＋32 筆撤銷、40 個中文字的名稱）包成 1059 仍在單顆上限內，車道收得下、對方解得開', { timeout: 120_000 }, async () => {
    const owner = Identity.generate();
    const m = VaultMembership.create({ signer: owner, label: '桌'.repeat(40) });
    for (let i = 0; i < ROSTER_MAX_REVOKED; i += 1) {
      const id = Identity.generate();
      add(m, id, `r${i}`, '機'.repeat(40));
      m.revoke(id.pubkey);
    }
    const bigCaps = (i: number) => ({ sdk: '10.20.30-beta.12345', maxRelayFileBytes: 67_108_864, f1: 'x'.repeat(12), f2: 123_456_789, zz: i % 2 === 0 });
    m.declareCapabilities(bigCaps(0));
    const members: Identity[] = [];
    for (let i = 1; i < ROSTER_MAX_DEVICES; i += 1) {
      const id = Identity.generate();
      add(m, id, `dev-${'x'.repeat(56)}${i}`, '機'.repeat(40));
      const o = VaultMembership.fromRoster(id, m.roster());
      o.declareCapabilities(bigCaps(i));
      m.merge(o.roster(), id.pubkey);
      members.push(id);
    }
    expect(m.devices()).toHaveLength(ROSTER_MAX_DEVICES);
    const peer = members[0]!;
    const [event] = buildRosterEvents(m, owner, [peer.pubkey], { outerKind: 1059 });
    const bytes = JSON.stringify(event).length;
    expect(bytes).toBeGreaterThan(100_000); // 確實是滿載（實測約 110 KB）
    expect(bytes).toBeLessThanOrEqual(RELAY_EVENT_MAX_BYTES);

    const { pool, close } = lane();
    const sender = pool(owner);
    const received: unknown[] = [];
    const sub = pool(peer).subscribe([{ kinds: [1059], '#p': [peer.pubkey] }], { onEvent: (e) => received.push(openRosterEvent(e, peer, { outerKind: 1059 })) });
    await tick();
    const result = await sender.publish(event as never);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual(['wss://lane']);
    await tick();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sender: owner.pubkey });
    sub.close();
    close();
  });
});
