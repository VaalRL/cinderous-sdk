// G12(d)（SDK ADR 0045）：名單送不出去（沒連線）時記住「有未送出的名單變動」，下次可送時重試。
// 預設行為不變（不自動重送）；`retryOnReconnect` 開了才在連線池變回 open 時自動重送；`pendingStore` 讓標記跨重開。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import { claimDevice, defaultDeviceId, NostrRosterSync, VaultMembership, type RosterPendingStore } from '../../src/pairing/index.js';
import type { RelayStatus } from '../../src/relay-pool.js';
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

/** FakeRelay 的連線池加上連線狀態（像 RelayPool 的 onStatusChange） */
function poolWithStatus(relay: FakeRelay, name: string) {
  const base = relay.pool(name);
  const listeners = new Set<(url: string, status: RelayStatus) => void>();
  return {
    ...base,
    onStatusChange(listener: (url: string, status: RelayStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOnline(online: boolean) {
      if (online) relay.offline.delete(name);
      else relay.offline.add(name);
      for (const l of listeners) l('wss://fake', online ? 'open' : 'closed');
    },
  };
}

class MemoryPending implements RosterPendingStore {
  value = false;
  saves: boolean[] = [];
  load() {
    return this.value;
  }
  save(pending: boolean) {
    this.value = pending;
    this.saves.push(pending);
  }
}

describe('名單送不出去：記住、下次可送時重試', () => {
  it('預設（釘住 v0.35 行為）：送失敗只記成 pending，連上後不自動重送', async () => {
    const relay = new FakeRelay();
    const { a, ma } = pair();
    const pool = poolWithStatus(relay, 'A');
    const sync = new NostrRosterSync({ pool, signer: a, membership: ma, onError: () => {} });
    sync.start({ announce: false });
    pool.setOnline(false);
    add(ma, Identity.generate(), 'c', 'C');
    await settle();
    expect(sync.pending).toBe(true);
    const before = relay.log.length;
    pool.setOnline(true);
    await settle();
    expect(relay.log.length).toBe(before);
    // 手動重送
    expect(await sync.retryPending()).toBe(true);
    expect(sync.pending).toBe(false);
    expect(relay.log.length).toBeGreaterThan(before);
    expect(await sync.retryPending()).toBe(false); // 沒有待送的就不送
    sync.stop();
  });

  it('retryOnReconnect：連線池變回 open 就重送整份名單，對方收到離線期間的變動', async () => {
    const relay = new FakeRelay();
    const { a, b, ma, mb } = pair();
    const pool = poolWithStatus(relay, 'A');
    const sa = new NostrRosterSync({ pool, signer: a, membership: ma, retryOnReconnect: true, onError: () => {} });
    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb });
    sa.start({ announce: false });
    sb.start({ announce: false });
    pool.setOnline(false);
    const c = Identity.generate();
    add(ma, c, 'c', 'C');
    await settle();
    expect(mb.isMember(c.pubkey)).toBe(false);
    expect(sa.pending).toBe(true);
    pool.setOnline(true);
    await settle();
    expect(mb.isMember(c.pubkey)).toBe(true);
    expect(sa.pending).toBe(false);
    sa.stop();
    sb.stop();
  });

  it('start() 時的宣告失敗也記成 pending', async () => {
    const relay = new FakeRelay();
    const { a, ma } = pair();
    relay.offline.add('A');
    const sync = new NostrRosterSync({ pool: relay.pool('A'), signer: a, membership: ma, onError: () => {} });
    sync.start();
    await settle();
    expect(sync.pending).toBe(true);
    sync.stop();
  });

  it('pendingStore：標記跨重開；重開後連上就重送，成功後存回 false', async () => {
    const relay = new FakeRelay();
    const { a, b, ma, mb } = pair();
    const store = new MemoryPending();
    const pool = poolWithStatus(relay, 'A');
    const first = new NostrRosterSync({ pool, signer: a, membership: ma, pendingStore: store, onError: () => {} });
    first.start({ announce: false });
    pool.setOnline(false);
    const c = Identity.generate();
    add(ma, c, 'c', 'C');
    await settle();
    expect(store.value).toBe(true);
    first.stop();

    const sb = new NostrRosterSync({ pool: relay.pool('B'), signer: b, membership: mb });
    sb.start({ announce: false });
    const second = new NostrRosterSync({ pool, signer: a, membership: ma, pendingStore: store, retryOnReconnect: true, onError: () => {} });
    second.start({ announce: false });
    await settle();
    expect(second.pending).toBe(true);
    pool.setOnline(true);
    await settle();
    expect(mb.isMember(c.pubkey)).toBe(true);
    expect(store.value).toBe(false);
    expect(store.saves.at(-1)).toBe(false);
    second.stop();
    sb.stop();
  });

  it('只送給指定收件人的 announce(recipients) 成功不會清掉 pending', async () => {
    const relay = new FakeRelay();
    const { a, b, ma } = pair();
    const pool = poolWithStatus(relay, 'A');
    const sync = new NostrRosterSync({ pool, signer: a, membership: ma, onError: () => {} });
    sync.start({ announce: false });
    pool.setOnline(false);
    add(ma, Identity.generate(), 'c', 'C');
    await settle();
    pool.setOnline(true);
    await sync.announce([b.pubkey]);
    expect(sync.pending).toBe(true);
    sync.stop();
  });
});
