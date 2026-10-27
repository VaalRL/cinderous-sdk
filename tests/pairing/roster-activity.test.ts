// 名單同步回報成員的動靜（SDK ADR 0053 §G17）：收到名單成員寄的名單或搬家通知時交出寄件人與寄出時間，
// 應用交給協調器的 notePeerActivity，「最後一次看到它」就含名單訊息。
import type { Event } from 'nostr-tools/core';
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  buildRelayMoveEvents,
  buildRosterEvents,
  claimDevice,
  defaultDeviceId,
  NostrRosterSync,
  openRosterEvent,
  VaultMembership,
  type RosterMemberActivity,
} from '../../src/pairing/index.js';
import { FakeRelay, settle } from './fake-relay.js';

function add(m: VaultMembership, id: Identity, label: string) {
  const deviceId = defaultDeviceId(id.pubkey);
  return m.addDevice({ pubkey: id.pubkey, deviceId, label, claim: claimDevice(id, { deviceId, label }) });
}

describe('NostrRosterSync：onMemberActivity', () => {
  it('🔴 名單成員寄的名單與搬家通知 → 交出公鑰、deviceId 與寄出時間；非成員的不交出；同一顆事件只交一次', async () => {
    const [a, b] = [Identity.generate(), Identity.generate()];
    const ma = VaultMembership.create({ signer: a, label: 'A' });
    add(ma, b, 'B');
    const mb = VaultMembership.fromRoster(b, ma.roster());
    const outsider = Identity.generate();
    const relay = new FakeRelay();
    const got: RosterMemberActivity[] = [];
    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb, onMemberActivity: (x) => got.push(x) });
    sb.start({ announce: false });

    const [roster] = buildRosterEvents(ma, a, [b.pubkey], { now: 1_790_000_000_000 });
    relay.inject(roster as unknown as Event);
    relay.inject(roster as unknown as Event);
    for (const e of buildRosterEvents(VaultMembership.create({ signer: outsider, label: 'X' }), outsider, [b.pubkey])) relay.inject(e as unknown as Event);
    for (const e of buildRelayMoveEvents({ from: 'wss://old.example', to: 'wss://new.example', at: 1_790_000_100_000 }, a, [b.pubkey])) relay.inject(e as unknown as Event);
    await settle();
    expect(got).toEqual([
      { pubkey: a.pubkey, deviceId: defaultDeviceId(a.pubkey), at: 1_790_000_000_000 },
      { pubkey: a.pubkey, deviceId: defaultDeviceId(a.pubkey), at: 1_790_000_100_000 },
    ]);
    sb.stop();
  });

  it('openRosterEvent 帶寄出時間（內層 rumor 的時間，毫秒；外層時間被 NIP-59 往前推過，不用它）', () => {
    const [a, b] = [Identity.generate(), Identity.generate()];
    const ma = VaultMembership.create({ signer: a, label: 'A' });
    add(ma, b, 'B');
    const [event] = buildRosterEvents(ma, a, [b.pubkey], { now: 1_790_000_000_999 });
    expect(openRosterEvent(event!, b)).toMatchObject({ sender: a.pubkey, sentAt: 1_790_000_000_000 });
  });
});
