// 名單同步與 Vault 傳輸層共用同一個 1060 訂閱（SDK ADR 0082）：名單的外層也是 1060，各開一個訂閱時
// 中繼把同一批檔案塊回兩次、兩邊各解一次。傳輸層把「解得開、但不是同步訊框」的事件交給應用，名單同步不必再訂閱。
import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools/core';

import { Identity } from '../../src/identity.js';
import { buildRosterEvents, claimDevice, defaultDeviceId, NostrRosterSync, VaultMembership } from '../../src/pairing/index.js';
import { createNostrVaultTransport, type VaultSyncMessage } from '../../src/sync/vault/index.js';
import { FakeRelay, settle } from './fake-relay.js';

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

const want = (from: string): VaultSyncMessage => ({ type: 'want', from, items: [['a'.repeat(32), 'b'.repeat(32)]] });

describe('傳輸層的 onOtherEvent（SDK ADR 0082）', () => {
  it('解得開但不是同步訊框的（名單）交給 onOtherEvent，同步訊框不交；同一顆只交一次', async () => {
    const relay = new FakeRelay();
    const { a, b, ma } = pair();
    const others: Event[] = [];
    const got: VaultSyncMessage[] = [];
    const receiver = createNostrVaultTransport({ pool: relay.pool('B'), signer: b, devices: [a.pubkey], onOtherEvent: (e) => others.push(e) });
    receiver.onMessage((m) => {
      got.push(m);
    });
    const sender = createNostrVaultTransport({ pool: relay.pool('A'), signer: a, devices: [b.pubkey] });
    await sender.send(want('dev-a'));
    const [roster] = buildRosterEvents(ma, a, [b.pubkey]);
    relay.inject(roster!);
    relay.inject(roster!);
    await settle();
    expect(got.map((m) => m.type)).toEqual(['want']);
    expect(others.map((e) => e.id)).toEqual([roster!.id]);
  });

  it('寄件人還不在信任名單上（剛配對的新裝置寄來的名單）也交出去——由名單同步自己判斷', async () => {
    const relay = new FakeRelay();
    const { a, b, ma } = pair();
    const others: Event[] = [];
    createNostrVaultTransport({ pool: relay.pool('B'), signer: b, devices: [], onOtherEvent: (e) => others.push(e) });
    const [roster] = buildRosterEvents(ma, a, [b.pubkey]);
    relay.inject(roster!);
    await settle();
    expect(others).toHaveLength(1);
  });

  it('解不開的（不是給我的）不交', async () => {
    const relay = new FakeRelay();
    const { a, ma } = pair();
    const stranger = Identity.generate();
    const others: Event[] = [];
    createNostrVaultTransport({ pool: relay.pool('S'), signer: stranger, devices: [], onOtherEvent: (e) => others.push(e) });
    const [roster] = buildRosterEvents(ma, a, [ma.roster().devices.find((d) => d.pubkey !== a.pubkey)!.pubkey]);
    const forged = { ...roster!, tags: [['p', stranger.pubkey]] };
    relay.inject(forged as Event);
    await settle();
    expect(others).toEqual([]);
  });
});

describe('NostrRosterSync 的 subscribe: false（SDK ADR 0082）', () => {
  it('不開自己的訂閱；由傳輸層的 onOtherEvent 餵進來照樣合併', async () => {
    const relay = new FakeRelay();
    const { a, b, ma, mb } = pair();
    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb, subscribe: false });
    createNostrVaultTransport({ pool: relay.pool('B'), signer: b, devices: [a.pubkey], onOtherEvent: (e) => sb.ingestEvents([e]) });
    sb.start({ announce: false });
    expect(relay.openSubs('B')).toBe(1); // 只有傳輸層那一個
    const sa = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma });
    sa.start({ announce: false });
    const c = Identity.generate();
    add(ma, c, 'c', 'C');
    await settle();
    expect(mb.roster().devices.map((d) => d.deviceId)).toContain('c');
  });

  it('沒開訂閱也照樣宣告、收送名單變動；stop 後不再送', async () => {
    const relay = new FakeRelay();
    const { a, b, ma, mb } = pair();
    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb, subscribe: false });
    sb.start();
    await settle();
    expect(relay.log.filter((l) => l.from === 'B')).toHaveLength(1); // 啟動時宣告
    const sa = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma });
    sa.start({ announce: false });
    sb.stop();
    add(mb, Identity.generate(), 'd', 'D');
    await settle();
    expect(relay.log.filter((l) => l.from === 'B')).toHaveLength(1);
  });
});
