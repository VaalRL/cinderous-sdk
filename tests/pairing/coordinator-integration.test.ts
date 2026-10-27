// 配對＋名單＋協調器（SDK ADR 0028 §6）：新裝置以 QR 配對加入後，經協調器同步；
// 還沒收到名單的裝置擋掉新裝置的訊息，名單到了之後 `resync()` 補齊；撤銷後不再收送。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { acceptPairingUri, claimDevice, createPairingOffer, NostrRosterSync, VaultMembership } from '../../src/pairing/index.js';
import { Net } from '../sync/vault/harness.js';
import { FakeRelay, settle } from './fake-relay.js';

describe('配對後經協調器同步', () => {
  it('新裝置 C 經 A 配對；B 晚收到名單：名單到之前 C 的變更被 B 擋掉，名單到了之後 resync 補齊；撤銷 C 之後 B 不再收它的變更', async () => {
    const net = new Net({ seed: 5 });
    const relay = new FakeRelay();
    const members = new Map<string, { id: Identity; m: VaultMembership; sync: NostrRosterSync }>();
    const join = (name: string, id: Identity, m: VaultMembership) => {
      const sync = new NostrRosterSync({ pool: relay.pool(name), signer: id, membership: m });
      m.onChange((change) => {
        if (change.added.length > 0) net.devices.find((d) => d.name === name)?.sync.resync();
      });
      sync.start({ announce: false });
      members.set(name, { id, m, sync });
    };
    const [ia, ib] = [Identity.generate(), Identity.generate()];
    const ma = VaultMembership.create({ signer: ia, deviceId: 'a', label: 'A' });
    ma.addDevice({ pubkey: ib.pubkey, deviceId: 'b', label: 'B', claim: claimDevice(ib, { deviceId: 'b', label: 'B' }) });
    join('a', ia, ma);
    join('b', ib, VaultMembership.fromRoster(ib, ma.roster()));
    net.hub.trust = (receiver, sender) => {
      const r = members.get(receiver);
      const s = members.get(sender);
      return !!r && !!s && r.m.isMember(s.id.pubkey);
    };
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('x.md', 'hello');
    await net.settle();
    expect(b.vault.get('x.md')).toBe('hello');

    // B 的名單同步斷線中；C 掃 A 的 QR
    members.get('b')!.sync.stop();
    const ic = Identity.generate();
    const offer = createPairingOffer({ role: 'invite', signer: ia, pool: relay.pool('a-pair'), membership: ma, relays: ['wss://relay.example'], clock: net.clock });
    const scan = acceptPairingUri(offer.uri!, { signer: ic, pool: relay.pool('c-pair'), clock: net.clock, device: { deviceId: 'c', label: 'C' } });
    await settle();
    expect(scan.sas).toBe(offer.sas);
    offer.confirm();
    scan.confirm();
    await settle();
    const { membership: mc } = await scan.result;
    join('c', ic, mc);
    const c = await net.add('c');
    await net.settle();
    expect(c.vault.get('x.md')).toBe('hello'); // 經 A 補齊

    // A 離線；C 的新檔案送到 B 時，B 還不認得 C → 擋掉
    a.transport.setOnline(false);
    await c.edit('y.md', 'from c');
    await net.settle();
    expect(b.vault.files.has('y.md')).toBe(false);

    // B 的名單同步回來 → 收到名單（加入 C）→ resync → 補齊
    members.get('b')!.sync.start({ announce: false });
    await settle();
    expect(members.get('b')!.m.isMember(ic.pubkey)).toBe(true);
    await net.settle();
    expect(b.vault.get('y.md')).toBe('from c');

    // B 撤銷 C：之後 C 的變更 B 不收；C 不在 B 的白名單與收件人裡
    members.get('b')!.m.revoke(ic.pubkey);
    await settle();
    expect(members.get('b')!.m.allowedPubkeys()).not.toContain(ic.pubkey);
    expect(members.get('b')!.m.peerPubkeys()).toEqual([ia.pubkey]);
    await c.edit('z.md', 'after revoke');
    await net.settle();
    expect(b.vault.files.has('z.md')).toBe(false);
  });
});
