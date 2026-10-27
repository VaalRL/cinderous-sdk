// 耐久度要求接進私訊、Vault 傳輸層、協調器、名單同步、檔案限制（SDK ADR 0041 §6）；預設行為與 v0.32 相同。
import type { Event } from 'nostr-tools/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DirectMessages } from '../../src/dm.js';
import { Identity } from '../../src/identity.js';
import { claimDevice, NostrRosterSync, VaultMembership } from '../../src/pairing/index.js';
import type { PublishOptions, PublishResult, RelayTransport } from '../../src/relay-pool.js';
import { RelayPool } from '../../src/relay-pool.js';
import {
  createNostrVaultTransport,
  isRelaysFullError,
  RelayRejectsFilesError,
  RelaysFullError,
  watchRelayFileLimits,
  type RelayInfoFetch,
} from '../../src/sync/vault/index.js';
import { SocketFactory } from '../fake-socket.js';
import { Net, type Device } from '../sync/vault/harness.js';

const A = 'wss://a.example';
const B = 'wss://b.example';
const S = 'wss://standby.example';

/** 記下每次 publish 的參數個數與選項，回固定結果 */
class RecordingTransport implements RelayTransport {
  readonly calls: { argc: number; options: PublishOptions | undefined }[] = [];
  constructor(public result: (event: Event) => PublishResult) {}
  publish(event: Event, ...rest: [PublishOptions?]): Promise<PublishResult> {
    this.calls.push({ argc: 1 + rest.length, options: rest[0] });
    return Promise.resolve(this.result(event));
  }
  subscribe() {
    return { close() {} };
  }
}

describe('🔴 預設行為與 v0.32 相同（沒設定 durability）', () => {
  it('私訊、Vault 傳輸層、名單同步都只傳一個參數給 publish；借用照舊算收下', async () => {
    const borrowedOnly = (): PublishResult => ({ accepted: [A], rejected: [], borrowed: [A] });
    const me = Identity.generate();
    const peer = Identity.generate();

    const dmTransport = new RecordingTransport(borrowedOnly);
    const dm = new DirectMessages({ transport: dmTransport, identity: me });
    expect(await dm.send(peer.pubkey, 'hi')).toMatchObject({ ok: true, accepted: [A] });
    expect(dmTransport.calls.map((c) => c.argc)).toEqual([1, 1]);

    const vaultPool = new RecordingTransport(borrowedOnly);
    const vault = createNostrVaultTransport({ pool: vaultPool, signer: me, devices: [peer.pubkey] });
    await vault.send({ type: 'want', from: 'a', items: [] });
    expect(vaultPool.calls.map((c) => c.argc)).toEqual([1]);
    vault.stop();
  });
});

describe('私訊：durability', () => {
  it('minAccepted 沒達到 → ok false，訊息說明；選項原樣交給傳輸層；結果帶 durability', async () => {
    const me = Identity.generate();
    const peer = Identity.generate();
    const transport = new RecordingTransport(() => ({
      accepted: [A],
      rejected: [{ url: B, reason: 'blocked: ceiling: 滿了' }],
      durability: { minAccepted: 2, durable: [A], satisfied: false, standbyUsed: [], relaysFull: true, relays: [] },
    }));
    const durability = { minAccepted: 2, standby: [S] };
    const dm = new DirectMessages({ transport, identity: me, durability });
    const outcome = await dm.send(peer.pubkey, 'hi');
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe('只有 1 座中繼耐久收下（需要 2），其餘中繼都滿了');
    expect(outcome.durability).toMatchObject({ satisfied: false, relaysFull: true });
    expect(transport.calls.map((c) => c.options)).toEqual([{ durability }, { durability }]);
  });

  it('自訂傳輸層沒回報 durability：以「收下但不是借用」自己算', async () => {
    const me = Identity.generate();
    const transport = new RecordingTransport(() => ({ accepted: [A], rejected: [], borrowed: [A] }));
    const dm = new DirectMessages({ transport, identity: me, durability: {} });
    expect((await dm.send(Identity.generate().pubkey, 'hi')).ok).toBe(false);
  });

  it('真的 RelayPool：一座滿了、一座借用 → 延遲連上備援補發，私訊送出', async () => {
    vi.useFakeTimers();
    try {
      const factory = new SocketFactory();
      const pool = new RelayPool({ urls: [A, B], createSocket: factory.create, publishTimeoutMs: 1000 });
      pool.connect();
      factory.latest(A).open();
      factory.latest(B).open();
      const me = Identity.generate();
      const dm = new DirectMessages({ transport: pool, identity: me, durability: { standby: [S] } });
      const sending = dm.send(Identity.generate().pubkey, '在嗎');
      const okAll = (url: string, ok: boolean, reason: string) => {
        for (const [, event] of factory.latest(url).sentOfType('EVENT')) factory.latest(url).receive(['OK', (event as Event).id, ok, reason]);
      };
      okAll(A, false, 'blocked: ceiling: 滿了');
      okAll(B, true, 'warning: borrowed: 7200: 暫存');
      await vi.advanceTimersByTimeAsync(0);
      factory.latest(S).open();
      await vi.advanceTimersByTimeAsync(0);
      okAll(S, true, '');
      await vi.advanceTimersByTimeAsync(0);
      // 第二份（給自己）也同樣需要備援：同一條備援連線
      okAll(S, true, '');
      const outcome = await sending;
      expect(outcome).toMatchObject({ ok: true });
      expect(outcome.durability).toMatchObject({ satisfied: true, durable: [S], standbyUsed: [S] });
      expect(factory.forUrl(S)).toHaveLength(1);
      pool.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Vault 傳輸層：durability', () => {
  const signer = Identity.generate();
  const other = Identity.generate();
  const full = (relays: string[]): PublishResult => ({
    accepted: [],
    rejected: [],
    durability: {
      minAccepted: 1,
      durable: [],
      satisfied: false,
      standbyUsed: [],
      relaysFull: true,
      relays: relays.map((url) => ({ url, standby: false, outcome: 'skipped', kind: 'ceiling', reason: 'blocked: ceiling: 滿了' })),
    },
  });

  it('中繼都滿了 → RelaysFullError（協調器認得）', async () => {
    const transport = createNostrVaultTransport({ pool: new RecordingTransport(() => full([A, B])), signer, devices: [other.pubkey], durability: {} });
    const error = await transport.send({ type: 'want', from: 'a', items: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelaysFullError);
    expect((error as RelaysFullError).relays).toEqual([A, B]);
    expect(isRelaysFullError({ code: 'relays-full' })).toBe(true);
    transport.stop();
  });

  it('🔴 被健康狀態略過的中繼原因是「檔案事件未啟用」→ 仍是 RelayRejectsFilesError（ADR 0027 不因略過而失效）', async () => {
    const skippedFiles = (): PublishResult => ({
      accepted: [],
      rejected: [],
      durability: {
        minAccepted: 1,
        durable: [],
        satisfied: false,
        standbyUsed: [],
        relaysFull: false,
        relays: [{ url: A, standby: false, outcome: 'skipped', kind: 'policy', reason: 'blocked: files-disabled: 檔案事件未啟用（MAX_FILE_MB）' }],
      },
    });
    const transport = createNostrVaultTransport({ pool: new RecordingTransport(skippedFiles), signer, devices: [other.pubkey], durability: {} });
    expect(await transport.send({ type: 'want', from: 'a', items: [] }).catch((e: unknown) => e)).toBeInstanceOf(RelayRejectsFilesError);
    transport.stop();
  });

  it('只有借用、沒達到 minAccepted → 一般錯誤（照常退避）', async () => {
    const transport = createNostrVaultTransport({
      pool: new RecordingTransport(() => ({ accepted: [A], rejected: [], borrowed: [A] })),
      signer,
      devices: [other.pubkey],
      durability: { minAccepted: 1 },
    });
    const error = await transport.send({ type: 'want', from: 'a', items: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('只有 0 座中繼耐久收下（需要 1）');
    transport.stop();
  });
});

/** 傳輸層一律丟 RelaysFullError，直到解除 */
function relaysFull(device: Device, net: Net, attempts: number[]) {
  const send = device.transport.send.bind(device.transport);
  let full = true;
  device.transport.send = async (message) => {
    attempts.push(net.clock.now());
    if (full) throw new RelaysFullError([A, B]);
    return send(message);
  };
  return () => (full = false);
}

describe('協調器：relays-full（ADR 0038 §4，比照 ADR 0027）', () => {
  it('🔴 狀態 blocked: relays-full、只報一次錯、最長退避不風暴；任何一座收下就恢復', async () => {
    const net = new Net({ options: { retryMaxMs: 5 * 60_000 } });
    const a = await net.add('a');
    const b = await net.add('b');
    const attempts: number[] = [];
    const fix = relaysFull(a, net, attempts);
    await a.edit('note.md', '空間滿了');
    await net.clock.advance(30 * 60_000);
    expect(a.sync.status()).toMatchObject({ state: 'error', blocked: 'relays-full', queue: 1 });
    expect(a.errors.filter((e) => e.startsWith('relays-full'))).toHaveLength(1);
    expect(attempts.length).toBeLessThanOrEqual(8);
    fix();
    await net.settle();
    expect(b.vault.get('note.md')).toBe('空間滿了');
    expect(a.sync.status().blocked).toBeUndefined();
  });
});

describe('名單同步：durability', () => {
  it('收件人那一顆只被借用、沒達到 minAccepted → announce 失敗；選項原樣交給傳輸層；沒設定時照舊成功', async () => {
    const me = Identity.generate();
    const peer = Identity.generate();
    const membership = VaultMembership.create({ signer: me, deviceId: 'a', label: 'A' });
    membership.addDevice({ pubkey: peer.pubkey, deviceId: 'b', label: 'B', claim: claimDevice(peer, { deviceId: 'b', label: 'B' }) });
    const borrowedOnly = (): PublishResult => ({ accepted: [A], rejected: [], borrowed: [A] });

    const strict = new RecordingTransport(borrowedOnly);
    const durability = { minAccepted: 1, standby: [S] };
    const sync = new NostrRosterSync({ pool: strict, signer: me, membership, durability });
    await expect(sync.announce()).rejects.toThrow('名單送不出去（1 台）');
    expect(strict.calls).toEqual([{ argc: 2, options: { durability } }]);

    const lenient = new RecordingTransport(borrowedOnly);
    await new NostrRosterSync({ pool: lenient, signer: me, membership }).announce();
    expect(lenient.calls.map((c) => c.argc)).toEqual([1]);
  });
});

describe('watchRelayFileLimits：對實際寫入的那組取最小值（ADR 0038 §6）', () => {
  afterEach(() => vi.useRealTimers());

  it('某座被標成已滿 → 不列入；備援連上 → 併進來重算', async () => {
    vi.useFakeTimers();
    const factory = new SocketFactory();
    const pool = new RelayPool({ urls: [A, B], createSocket: factory.create, publishTimeoutMs: 1000 });
    pool.connect();
    factory.latest(A).open();
    factory.latest(B).open();
    const info: Record<string, unknown> = {
      'https://a.example/': { cinder_accepts_files: true, cinder_max_file_mb: 30, cinder_file_chunks_per_recipient: 1440, retention: [{ time: 604800 }] },
      'https://b.example/': { cinder_accepts_files: true, cinder_max_file_mb: 10, cinder_file_chunks_per_recipient: 400, retention: [{ time: 604800 }] },
      'https://standby.example/': { cinder_accepts_files: true, cinder_max_file_mb: 20, cinder_file_chunks_per_recipient: 800, retention: [{ time: 604800 }] },
    };
    const fetched: string[] = [];
    const fetch: RelayInfoFetch = async (url) => {
      fetched.push(url);
      return { status: 200, text: async () => JSON.stringify(info[url]) };
    };
    const seen: { chunks: number; set: readonly string[] }[] = [];
    const stop = watchRelayFileLimits({ pool, fetch, onLimits: (limits, set) => seen.push({ chunks: limits.chunksPerRecipient, set }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual({ chunks: 400, set: [A, B] });

    // B 的離線留言滿了 → 暫時不寫 B
    const event = Identity.generate().sign({ kind: 1060, created_at: 1, tags: [], content: 'x' });
    let publishing = pool.publish(event);
    factory.latest(A).receive(['OK', event.id, true, '']);
    factory.latest(B).receive(['OK', event.id, false, 'blocked: ceiling: 滿了']);
    await publishing;
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual({ chunks: 1440, set: [A] });

    // 備援連上 → 併進來
    const second = Identity.generate().sign({ kind: 1060, created_at: 2, tags: [], content: 'y' });
    publishing = pool.publish(second, { durability: { minAccepted: 2, standby: [S] } });
    factory.latest(A).receive(['OK', second.id, true, '']);
    await vi.advanceTimersByTimeAsync(0);
    factory.latest(S).open();
    await vi.advanceTimersByTimeAsync(0);
    factory.latest(S).receive(['OK', second.id, true, '']);
    await publishing;
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual({ chunks: 800, set: [A, S] });
    expect(new Set(fetched).size).toBe(fetched.length); // 每座只讀一次 NIP-11
    stop();
    pool.close();
  });
});
