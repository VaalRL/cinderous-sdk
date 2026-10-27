// 部分拒收往上回報（SDK ADR 0038 P0-C）：私訊、Vault、名單同步、PeerNode 仍以「至少一座收下」為成功，
// 但有中繼拒收時要讓應用知道（冗餘默默少了一份）。
import { describe, expect, it } from 'vitest';

import { DirectMessages } from '../src/dm.js';
import { Identity } from '../src/identity.js';
import { claimDevice, defaultDeviceId, NostrRosterSync, VaultMembership } from '../src/pairing/index.js';
import { PeerNode } from '../src/peer/peer-node.js';
import { publishRejections, type PublishRejectionReport } from '../src/relay-pool.js';
import { createNostrVaultTransport, RelayRejectsFilesError } from '../src/sync/vault/index.js';
import { FakeTransport } from './fake-transport.js';

const CEILING = { url: 'wss://full.example', reason: 'blocked: ceiling: 本站離線留言空間已滿' };

describe('publishRejections', () => {
  it('補齊分類；「not connected」不算拒收（那一座根本沒送到）', () => {
    const rejections = publishRejections({
      accepted: ['wss://a'],
      rejected: [CEILING, { url: 'wss://down', reason: 'not connected' }, { url: 'wss://slow', reason: 'timeout' }],
    });
    expect(rejections.map((r) => [r.url, r.kind])).toEqual([
      [CEILING.url, 'ceiling'],
      ['wss://slow', 'timeout'],
    ]);
  });
});

describe('DirectMessages.send：部分拒收', () => {
  it('仍然 ok，但 SendOutcome 帶收件人那一份的 accepted／rejected，onPublishRejected 每一份各報一次', async () => {
    const transport = new FakeTransport();
    transport.alsoRejected = [CEILING];
    const reports: PublishRejectionReport[] = [];
    const me = Identity.generate();
    const dm = new DirectMessages({ transport, identity: me, onPublishRejected: (r) => reports.push(r) });
    const outcome = await dm.send(Identity.generate().pubkey, 'hi');
    expect(outcome.ok).toBe(true);
    expect(outcome.accepted).toEqual(['wss://fake']);
    expect(outcome.rejected).toEqual([expect.objectContaining({ url: CEILING.url, kind: 'ceiling', retryable: true })]);
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.eventId).sort()).toEqual(transport.published.map((e) => e.id).sort());
  });

  it('全部收下：rejected 是空的、不回報', async () => {
    const transport = new FakeTransport();
    const reports: PublishRejectionReport[] = [];
    const dm = new DirectMessages({ transport, identity: Identity.generate(), onPublishRejected: (r) => reports.push(r) });
    const outcome = await dm.send(Identity.generate().pubkey, 'hi');
    expect(outcome).toMatchObject({ ok: true, rejected: [] });
    expect(reports).toEqual([]);
  });

  it('全部拒收：ok false，rejected 帶分類', async () => {
    const transport = new FakeTransport();
    transport.accepted = [];
    transport.alsoRejected = [CEILING];
    const dm = new DirectMessages({ transport, identity: Identity.generate() });
    const outcome = await dm.send(Identity.generate().pubkey, 'hi');
    expect(outcome.ok).toBe(false);
    expect(outcome.rejected?.map((r) => r.kind)).toEqual(['unknown', 'ceiling']); // FakeTransport 的 'blocked' 沒有冒號，不是 NIP-01 前綴
  });
});

describe('NostrVaultTransport.send：部分拒收', () => {
  it('送出成功，但回報是哪一座、什麼原因', async () => {
    const pool = new FakeTransport();
    pool.alsoRejected = [CEILING];
    const reports: PublishRejectionReport[] = [];
    const t = createNostrVaultTransport({
      pool,
      signer: Identity.generate(),
      devices: [Identity.generate().pubkey],
      onPublishRejected: (r) => reports.push(r),
    });
    await t.send({ type: 'want', from: 'dev-a', items: [['a'.repeat(32), 'b'.repeat(32)]] });
    expect(reports).toEqual([{ eventId: pool.published[0]!.id, accepted: ['wss://fake'], rejected: [expect.objectContaining({ kind: 'ceiling' })] }]);
  });

  it('每一座都回「files-disabled」詞元：照舊丟 RelayRejectsFilesError（ADR 0027）', async () => {
    const pool = new FakeTransport();
    pool.accepted = [];
    const t = createNostrVaultTransport({ pool, signer: Identity.generate(), devices: [Identity.generate().pubkey] });
    // FakeTransport 全拒時的原因是 'blocked'；換成真正的中繼句子
    pool.publish = async (event) => {
      pool.published.push(event);
      return { accepted: [], rejected: [{ url: 'wss://x', reason: 'blocked: files-disabled: 檔案事件未啟用（MAX_FILE_MB）' }] };
    };
    await expect(t.send({ type: 'want', from: 'dev-a', items: [] })).rejects.toBeInstanceOf(RelayRejectsFilesError);
  });
});

describe('NostrRosterSync.announce：部分拒收', () => {
  it('每位收件人至少一座收下仍算成功，但回報拒收', async () => {
    const [a, b] = [Identity.generate(), Identity.generate()];
    const ma = VaultMembership.create({ signer: a, label: 'A' });
    ma.addDevice({ pubkey: b.pubkey, deviceId: defaultDeviceId(b.pubkey), label: 'B', claim: claimDevice(b, { deviceId: defaultDeviceId(b.pubkey), label: 'B' }) });
    const pool = new FakeTransport();
    pool.alsoRejected = [CEILING];
    const reports: PublishRejectionReport[] = [];
    const sync = new NostrRosterSync({ pool, signer: a, membership: ma, onPublishRejected: (r) => reports.push(r) });
    await sync.announce();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.rejected[0]).toMatchObject({ url: CEILING.url, kind: 'ceiling' });
  });
});

describe('PeerNode（中繼軌）：部分拒收', () => {
  it('這一框照樣送出，但回報拒收', async () => {
    const transport = new FakeTransport();
    transport.relay = true;
    const reports: PublishRejectionReport[] = [];
    const alice = Identity.generate();
    const bob = Identity.generate();
    const a = new PeerNode({ identity: alice, transport, rtc: null, onPublishRejected: (r) => reports.push(r) });
    const b = new PeerNode({ identity: bob, transport, rtc: null });
    const toBob = await a.connectPeer(bob.pubkey);
    transport.alsoRejected = [CEILING];
    await toBob.send(new Uint8Array([1, 2, 3]));
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports.at(-1)!.rejected[0]).toMatchObject({ kind: 'ceiling' });
    a.close();
    b.close();
  });
});
