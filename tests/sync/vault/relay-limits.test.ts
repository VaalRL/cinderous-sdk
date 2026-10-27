// 檔案車道對齊（SDK ADR 0029；Cinderous ADR-0371）：單檔 30 MB、依中繼 NIP-11 決定上限與補送預算、分頁取回。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../../src/identity.js';
import { finalizeEvent, generateSecretKey, type NostrEvent } from '../../../src/protocol/index.js';
import { MessageStore } from '../../../src/relay/message-store.js';
import { RelayCore } from '../../../src/relay/relay-core.js';
import { buildRelayInfo } from '../../../src/relay/nip11.js';
import type { PublishResult, SubscriptionHandlers } from '../../../src/relay-pool.js';
import { FILE_CHUNK_BYTES, FILE_CHUNK_KIND, FILE_CHUNK_MAX_TOTAL, parseFileChunk, RELAY_FILE_MAX_BYTES_CAP } from '../../../src/sync/file-relay.js';
import { forEachPage, queryPaged } from '../../../src/sync/hydrator.js';
import { classifyPayload, FILE_TIER_MAX_BYTES, relayTierMaxBytes } from '../../../src/sync/ingest.js';
import { encodedVaultMessageLength, encodeVaultMessage, validateVaultMessage, vaultFrameCount } from '../../../src/sync/vault/codec.js';
import {
  createNostrVaultTransport,
  DEFAULT_RELAY_FILE_LIMITS,
  fetchRelayFilePolicy,
  checkRelayAcceptsFiles,
  loadRelayFileLimits,
  RELAY_QUOTA_SAFETY,
  relayChunkBudget,
  relayFileLimits,
  safeRelayChunksPerHour,
  VAULT_MAX_FRAMES,
  type RelayInfoFetch,
  type VaultRelayPool,
  type VaultSyncMessage,
} from '../../../src/sync/vault/index.js';
import { sha256Hex } from '../../../src/sync/vault/graph.js';
import { type Device, MemoryVault, Net } from './harness.js';

const MiB = 1024 * 1024;

describe('單檔 30 MB 經中繼（收端上限、分塊數）', () => {
  it('🔴 30 MB（MiB）＝656 塊；收端的每一道防線都收得下', () => {
    expect(relayTierMaxBytes(30)).toBe(30 * MiB);
    expect(Math.ceil((30 * MiB) / FILE_CHUNK_BYTES)).toBe(656);
    // 一則帶 30 MB 內容的版本訊息，標頭塞得進最後一塊的餘裕：仍是 656 塊（中繼的配額就是以 656 算的）
    const content = new Uint8Array(30 * MiB);
    const message: VaultSyncMessage = {
      type: 'node',
      from: 'dev-a',
      fileId: 'a'.repeat(32),
      node: { id: 'b'.repeat(32), parents: ['c'.repeat(32)], path: 'attachments/影片 2026-09-29.mp4', pathAt: 1, deleted: false, hash: sha256Hex(content), size: content.length, text: false, at: 1, device: 'dev-a', label: 'MacBook', p2p: false },
      content,
    };
    expect(encodedVaultMessageLength(message)).toBe(encodeVaultMessage(message).length);
    expect(vaultFrameCount(encodedVaultMessageLength(message))).toBe(656);
    expect(VAULT_MAX_FRAMES).toBeGreaterThanOrEqual(656);
    expect(FILE_CHUNK_MAX_TOTAL).toBeGreaterThanOrEqual(656);
    expect(validateVaultMessage(message)).not.toBeNull();
  });

  it('🔴 仍有防 DoS 的絕對上限（64 MiB）：中繼宣告再大也夾住，收端也擋', () => {
    expect(relayTierMaxBytes(10_000)).toBe(RELAY_FILE_MAX_BYTES_CAP);
    const over = new Uint8Array(RELAY_FILE_MAX_BYTES_CAP + 1);
    const message = { type: 'node', from: 'dev-a', fileId: 'a'.repeat(32), node: { id: 'b'.repeat(32), parents: [], path: 'x.bin', pathAt: 1, deleted: false, hash: 'd'.repeat(64), size: over.length, text: false, at: 1, device: 'dev-a', label: 'A', p2p: false }, content: over };
    expect(validateVaultMessage(message)).toBeNull();
    const mk = (total: number) => ({ kind: FILE_CHUNK_KIND, tags: [], created_at: 0, id: 'x', pubkey: 'p', content: JSON.stringify({ tid: 't', seq: 0, total, name: 'a', mime: 'm', data: '' }) });
    expect(parseFileChunk(mk(656))).not.toBeNull();
    expect(parseFileChunk(mk(FILE_CHUNK_MAX_TOTAL + 1))).toBeNull();
  });

  it('分流門檻可以依中繼調整；沒給＝原本的 16.5 MB（舊版收端相容）', () => {
    const twenty = 20 * MiB;
    expect(classifyPayload(twenty)).toBe('p2p');
    expect(classifyPayload(twenty, relayTierMaxBytes(30))).toBe('file');
    expect(FILE_TIER_MAX_BYTES).toBe(360 * FILE_CHUNK_BYTES);
    expect(relayTierMaxBytes(Number.NaN)).toBe(FILE_TIER_MAX_BYTES);
  });
});

describe('讀中繼的檔案政策（NIP-11，車道路徑）', () => {
  /** 像錨點一樣依路徑回不同的 NIP-11（真正的 Worker 路由另在 tests/relay/worker.test.ts 驗） */
  const byPath = (seen: Array<{ url: string; accept: string | undefined }>): RelayInfoFetch => async (url, init) => {
    seen.push({ url, accept: init.headers.Accept });
    const lane = new URL(url).pathname === '/app/testgame';
    const doc = buildRelayInfo(lane ? { profile: 'app', knownLane: true, acceptsFiles: true, maxFileMb: 30 } : { acceptsFiles: false });
    return { status: 200, text: async () => JSON.stringify(doc) };
  };

  it('🔴 wss://<host>/app/<車道> → GET https://<host>/app/<車道>（Accept: application/nostr+json）：讀到車道自己的宣告', async () => {
    const seen: Array<{ url: string; accept: string | undefined }> = [];
    const policy = await fetchRelayFilePolicy('wss://relay.example/app/testgame', { fetch: byPath(seen) });
    expect(seen).toEqual([{ url: 'https://relay.example/app/testgame', accept: 'application/nostr+json' }]);
    expect(policy).toMatchObject({ acceptsFiles: true, maxFileMb: 30, fileChunksPerRecipient: 1440, retentionSeconds: 7 * 86_400 });
    // checkRelayAcceptsFiles 讀的是同一份（向下相容的名字）
    expect(await checkRelayAcceptsFiles('wss://relay.example/app/testgame', { fetch: byPath([]) })).toEqual(policy);
  });

  it('根路徑（主訊息平面）：不收檔案、也沒有上限', async () => {
    const policy = await fetchRelayFilePolicy('wss://relay.example', { fetch: byPath([]) });
    expect(policy.acceptsFiles).toBe(false);
    expect(policy.maxFileMb).toBeUndefined();
  });

  it('retention 的解析：明確涵蓋 1060 的那項優先，其次是不分 kind 的', async () => {
    const doc = (retention: unknown): RelayInfoFetch => async () => ({ status: 200, text: async () => JSON.stringify({ cinder_accepts_files: true, retention }) });
    expect((await fetchRelayFilePolicy('wss://r', { fetch: doc([{ time: 3600 }, { kinds: [[1000, 2000]], time: 60 }]) })).retentionSeconds).toBe(60);
    expect((await fetchRelayFilePolicy('wss://r', { fetch: doc([{ kinds: [1], time: 5 }, { time: 7200 }]) })).retentionSeconds).toBe(7200);
    expect((await fetchRelayFilePolicy('wss://r', { fetch: doc([{ time: null }]) })).retentionSeconds).toBeUndefined();
  });
});

describe('多座中繼合成限制：取最嚴的', () => {
  const lane = { url: 'wss://a/app/x', httpUrl: '', acceptsFiles: true, maxFileMb: 30, fileChunksPerRecipient: 1440, retentionSeconds: 7 * 86_400 } as const;

  it('每一座都是檔案車道 → 30 MB、1440 塊、7 天，全部來自宣告', () => {
    expect(relayFileLimits([lane, { ...lane, url: 'wss://b/app/x' }])).toEqual({ maxFileBytes: 30 * MiB, chunksPerRecipient: 1440, retentionSeconds: 604_800, declared: true });
  });

  it('🔴 有一座讀不到或沒宣告 → 那幾項退回保守預設（取最小）', () => {
    const limits = relayFileLimits([lane, null]);
    expect(limits.maxFileBytes).toBe(FILE_TIER_MAX_BYTES);
    expect(limits.chunksPerRecipient).toBe(DEFAULT_RELAY_FILE_LIMITS.chunksPerRecipient);
    expect(limits.declared).toBe(false);
    const legacy = relayFileLimits([lane, { url: 'wss://b', httpUrl: '', acceptsFiles: true }]); // 全站開關、不宣告
    expect(legacy.maxFileBytes).toBe(FILE_TIER_MAX_BYTES);
  });

  it('明確不收檔案的那座不參與；保存期取最長、但不超過自己的過期章', () => {
    expect(relayFileLimits([lane, { url: 'wss://c', httpUrl: '', acceptsFiles: false }]).maxFileBytes).toBe(30 * MiB);
    expect(relayFileLimits([lane, { ...lane, retentionSeconds: 30 * 86_400 }]).retentionSeconds).toBe(604_800);
    expect(relayFileLimits([lane, { ...lane, retentionSeconds: 86_400, maxFileMb: 20 }])).toMatchObject({ retentionSeconds: 604_800, maxFileBytes: 20 * MiB });
  });

  it('沒有任何中繼資訊 → 整組保守預設', () => {
    expect(relayFileLimits([])).toEqual({ ...DEFAULT_RELAY_FILE_LIMITS });
    expect(DEFAULT_RELAY_FILE_LIMITS).toMatchObject({ maxFileBytes: FILE_TIER_MAX_BYTES, chunksPerRecipient: 848, retentionSeconds: 604_800, declared: false });
  });

  it('loadRelayFileLimits：讀不到的那座當未知，不丟例外', async () => {
    const fetch: RelayInfoFetch = async (url) => {
      if (url.startsWith('https://down')) throw new Error('ECONNREFUSED');
      return { status: 200, text: async () => JSON.stringify({ cinder_accepts_files: true, cinder_max_file_mb: 30, cinder_file_chunks_per_recipient: 1440, retention: [{ time: 604_800 }] }) };
    };
    const limits = await loadRelayFileLimits(['wss://up/app/x', 'wss://down/app/x'], { fetch });
    expect(limits.policies[1]).toBeNull();
    expect(limits.maxFileBytes).toBe(FILE_TIER_MAX_BYTES);
    const both = await loadRelayFileLimits(['wss://up/app/x'], { fetch });
    expect(both).toMatchObject({ maxFileBytes: 30 * MiB, chunksPerRecipient: 1440, declared: true });
  });

  it('安全速率＝配額 × 安全係數 ÷ 保存期：1440 塊／7 天 → 1080 塊預算、約 6.4 塊／小時', () => {
    expect(RELAY_QUOTA_SAFETY).toBe(0.75);
    expect(relayChunkBudget({ chunksPerRecipient: 1440 })).toBe(1080);
    expect(safeRelayChunksPerHour({ chunksPerRecipient: 1440, retentionSeconds: 604_800 })).toBeCloseTo(1080 / 168, 5);
    // 預算容得下一個上限檔（656 塊）——一則 30 MB 的訊息不會永遠卡住
    expect(relayChunkBudget({ chunksPerRecipient: 1440 })).toBeGreaterThanOrEqual(656);
  });
});

// ───────────────────────── 協調器 ─────────────────────────

function spyFrames(device: Device, net: Net): Array<{ at: number; frames: number; content: boolean }> {
  const log: Array<{ at: number; frames: number; content: boolean }> = [];
  const send = device.transport.send.bind(device.transport);
  device.transport.send = async (message) => {
    await send(message);
    log.push({ at: net.clock.now(), frames: vaultFrameCount(encodedVaultMessageLength(message)), content: 'content' in message && message.content !== undefined });
  };
  return log;
}

describe('協調器：依中繼限制決定走哪一層', () => {
  it('🔴 中繼宣告 30 MB：20 MB 的檔案經中繼送（帶內容）；沒宣告時照舊只走 P2P', { timeout: 60_000 }, async () => {
    const file = new Uint8Array(20 * MiB).fill(3);
    for (const [limits, viaRelay] of [[{ maxFileBytes: 30 * MiB }, true], [undefined, false]] as const) {
      const net = new Net({ roundTrip: false, options: limits ? { relayLimits: limits } : {} });
      const a = await net.add('a');
      const b = await net.add('b');
      await a.edit('big.bin', file);
      await net.settle();
      const node = a.sync.index().find((i) => i.path === 'big.bin');
      expect(node).toBeDefined();
      const sent = net.hub.messages.find((m) => m.type === 'node' && m.node.path === 'big.bin');
      expect(sent && sent.type === 'node' ? sent.node.p2p : undefined).toBe(!viaRelay);
      if (viaRelay) expect(b.vault.files.get('big.bin')?.bytes.length).toBe(20 * MiB);
    }
  });

  it('setRelayLimits：連線後讀到 NIP-11 再調整，之後的檔案照新門檻', { timeout: 60_000 }, async () => {
    const net = new Net();
    const a = await net.add('a');
    await net.add('b');
    a.sync.setRelayLimits({ maxFileBytes: 30 * MiB });
    await a.edit('later.bin', new Uint8Array(18 * MiB).fill(1));
    await net.settle();
    const sent = net.hub.messages.find((m) => m.type === 'node' && m.node.path === 'later.bin');
    expect(sent?.type === 'node' && sent.node.p2p).toBe(false);
  });
});

describe('G9（SDK ADR 0035）：門檻也要所有成員都收得下', () => {
  it('🔴 中繼宣告 30 MB、但名單上有舊版（16.5 MB）→ 20 MB 的檔案照舊只走 P2P；全員宣告 64 MiB 後改走中繼', { timeout: 60_000 }, async () => {
    const net = new Net({ roundTrip: false, options: { relayLimits: { maxFileBytes: 30 * MiB } } });
    const a = await net.add('a');
    await net.add('b');
    a.sync.setMemberCapabilities({ maxRelayFileBytes: FILE_TIER_MAX_BYTES });
    expect(a.sync.relayMaxFileBytes).toBe(FILE_TIER_MAX_BYTES);
    await a.edit('old.bin', new Uint8Array(20 * MiB).fill(1));
    await net.settle();
    const first = net.hub.messages.find((m) => m.type === 'node' && m.node.path === 'old.bin');
    expect(first?.type === 'node' && first.node.p2p).toBe(true);
    a.sync.setMemberCapabilities({ maxRelayFileBytes: 64 * MiB });
    expect(a.sync.relayMaxFileBytes).toBe(30 * MiB); // 取中繼與成員的較小者
    await a.edit('new.bin', new Uint8Array(20 * MiB).fill(2));
    await net.settle();
    const second = net.hub.messages.find((m) => m.type === 'node' && m.node.path === 'new.bin');
    expect(second?.type === 'node' && second.node.p2p).toBe(false);
  });

  it('選項 memberCapabilities 也可以在建構時給；壞值不理', async () => {
    const net = new Net({ roundTrip: false, options: { relayLimits: { maxFileBytes: 30 * MiB }, memberCapabilities: { maxRelayFileBytes: 20 * MiB } } });
    const a = await net.add('a');
    expect(a.sync.relayMaxFileBytes).toBe(20 * MiB);
    a.sync.setMemberCapabilities({ maxRelayFileBytes: Number.NaN });
    expect(a.sync.relayMaxFileBytes).toBe(20 * MiB);
  });
});

describe('🔴 協調器：批次補送不會把收件人還沒領的塊擠掉（1440 塊／7 天）', () => {
  it('P2P 打不通、大量帶內容的變更、收件端不簽收（舊版）：任何 7 天內寄給同一位收件人的塊 ≤ 1080，模擬的 FIFO 中繼從不淘汰；最後仍收斂', { timeout: 300_000 }, async () => {
    const QUOTA = 1440;
    const RETENTION_MS = 7 * 86_400_000;
    const net = new Net({ p2p: true, roundTrip: false, options: { relayLimits: { chunksPerRecipient: QUOTA, retentionSeconds: RETENTION_MS / 1000 }, relayBulkPerHour: 1000 } });
    net.mesh!.reachable = () => false;
    const vault = new MemoryVault();
    // 每個 200 KB（5 塊）× 300 個＝1,500 塊以上：塞不進一份 7 天的預算
    for (let i = 0; i < 300; i += 1) vault.userWrite(`att/${i}.bin`, new Uint8Array(200 * 1024).fill(i & 0xff));
    const a = await net.add('a', { vault, online: false });
    const log = spyFrames(a, net);
    const b = await net.add('b', { options: { receipts: false } });
    a.transport.setOnline(true);
    await net.settle();
    expect(Object.keys(b.vault.tree())).toHaveLength(300);

    // 模擬中繼：每位收件人 FIFO 1,440 塊、每塊待 7 天
    let stored: Array<{ expires: number; n: number }> = [];
    let evicted = 0;
    for (const { at, frames } of log) {
      stored = stored.filter((s) => s.expires > at);
      stored.push({ expires: at + RETENTION_MS, n: frames });
      const total = stored.reduce((sum, s) => sum + s.n, 0);
      if (total > QUOTA) evicted += total - QUOTA;
    }
    expect(evicted).toBe(0);
    // 任何 7 天的窗內 ≤ 預算（1080）＋門檻以下不限速的尾巴（批次模式在剩不到 10 則時結束，每則 5 塊）
    for (const first of log) {
      const inWindow = log.filter((x) => x.at >= first.at && x.at < first.at + RETENTION_MS).reduce((s, x) => s + x.frames, 0);
      expect(inWindow).toBeLessThanOrEqual(1080 + 10 * 5);
    }
    // 真的被限速了：1,500 塊以上要超過一份保存期才送得完
    expect(log.at(-1)!.at - log[0]!.at).toBeGreaterThan(RETENTION_MS);
    expect(a.errors).toEqual([]);
  });

  it('🔴 同樣的情境、收件端簽收（SDK ADR 0068）：帳隨簽收空出來，一天內送完；任何時候還沒簽收的不超過預算', { timeout: 300_000 }, async () => {
    const QUOTA = 1440;
    const RETENTION_MS = 7 * 86_400_000;
    const net = new Net({ p2p: true, roundTrip: false, options: { relayLimits: { chunksPerRecipient: QUOTA, retentionSeconds: RETENTION_MS / 1000 }, relayBulkPerHour: 1000 } });
    net.mesh!.reachable = () => false;
    const vault = new MemoryVault();
    for (let i = 0; i < 300; i += 1) vault.userWrite(`att/${i}.bin`, new Uint8Array(200 * 1024).fill(i & 0xff));
    const a = await net.add('a', { vault, online: false });
    const log = spyFrames(a, net);
    const b = await net.add('b');
    let peak = 0;
    const offStatus = a.sync.on('status', (s) => (peak = Math.max(peak, s.relayQuota?.used ?? 0)));
    a.transport.setOnline(true);
    await net.settle();
    offStatus();
    expect(Object.keys(b.vault.tree())).toHaveLength(300);
    expect(log.at(-1)!.at - log[0]!.at).toBeLessThan(86_400_000);
    // 還沒簽收的（中繼上 b 還沒處理的）不超過預算＋一則
    expect(peak).toBeLessThanOrEqual(1080 + 5);
    expect([a.errors, b.errors]).toEqual([[], []]);
  });

  it('用量跨重開保留：重開後不會把同一份預算再用一次', { timeout: 120_000 }, async () => {
    const net = new Net({ p2p: true, options: { relayLimits: { chunksPerRecipient: 200, retentionSeconds: 7 * 86_400 }, relayBulkPerHour: 1000 } });
    net.mesh!.reachable = () => false;
    const vault = new MemoryVault();
    for (let i = 0; i < 60; i += 1) vault.userWrite(`att/${i}.bin`, new Uint8Array(100 * 1024).fill(i));
    const a = await net.add('a', { vault, online: false });
    await net.add('b');
    a.transport.setOnline(true);
    await net.clock.advance(60_000);
    for (let i = 0; i < 20; i += 1) await net.clock.advance(1000);
    const before = a.sync.status().relayQuota!;
    expect(before.budget).toBe(150);
    expect(before.used).toBeGreaterThan(0);
    expect(before.used).toBeLessThanOrEqual(150 + 3);
    await a.restart();
    expect(a.sync.status().relayQuota!.used).toBe(before.used);
  });
});

// ───────────────────────── 分頁 ─────────────────────────

/** SDK 自己的 RelayCore 當中繼（有 REQ 位元組預算、不回報截斷），包成連線池 */
function coreRelay(maxQueryBytes: number) {
  const core = new RelayCore({ store: new MessageStore(), acceptFileEvents: true, maxQueryBytes });
  let n = 0;
  const conn = 'c1';
  core.connect(conn);
  const req = (filters: object[]): NostrEvent[] => {
    const id = `q${(n += 1)}`;
    const out = core.handle(conn, JSON.stringify(['REQ', id, ...filters]));
    core.handle(conn, JSON.stringify(['CLOSE', id]));
    return out.map((o) => o.message as unknown[]).filter((m) => m[0] === 'EVENT' && m[1] === id).map((m) => m[2] as NostrEvent);
  };
  const pool: VaultRelayPool & { requests: number } = {
    requests: 0,
    async publish(event) {
      core.handle(conn, JSON.stringify(['EVENT', event]));
      return { accepted: ['wss://core'], rejected: [] } satisfies PublishResult;
    },
    subscribe(filters, handlers: SubscriptionHandlers) {
      for (const e of req(filters)) handlers.onEvent(e as never, 'wss://core');
      handlers.onEose?.();
      return { close() {} };
    },
    async query(filters) {
      pool.requests += 1;
      return req(filters) as never;
    },
  };
  return { core, pool, req };
}

describe('🔴 分頁取回：中繼的位元組預算截斷、而且不回報', () => {
  const sk = generateSecretKey();
  const me = 'e'.repeat(64);
  const mk = (i: number, createdAt: number) => finalizeEvent({ kind: 1060, created_at: createdAt, tags: [['p', me]], content: `${i}:${'x'.repeat(2000)}` }, sk);

  it('300 顆、每頁只放得下約 20 顆：以 until 一頁一頁翻，全部拿到，最後一頁是空的就停', { timeout: 60_000 }, async () => {
    const { pool, req } = coreRelay(50_000);
    for (let i = 0; i < 300; i += 1) await pool.publish(mk(i, 1_800_000_000 - i * 7) as never);
    const filter = { kinds: [1060], '#p': [me] };
    expect(req([filter]).length).toBeLessThan(30); // 不分頁：只拿得到最新的一小段
    const all = await queryPaged(pool as never, [filter]);
    expect(all).toHaveLength(300);
    expect(new Set(all.map((e) => e.id)).size).toBe(300);
    expect(pool.requests).toBeGreaterThan(10);
  });

  it('同一秒的事件跨頁：until 含邊界，不漏；不會無限迴圈', { timeout: 60_000 }, async () => {
    const { pool } = coreRelay(20_000);
    for (let i = 0; i < 40; i += 1) await pool.publish(mk(i, 1_800_000_000 - Math.floor(i / 4)) as never); // 每 4 顆同一秒
    const got = await queryPaged(pool as never, [{ kinds: [1060], '#p': [me] }]);
    expect(got).toHaveLength(40);
  });

  it('since 以下的不翻；maxPages 封頂（惡意中繼一直回更舊的也會停）', { timeout: 60_000 }, async () => {
    const { pool } = coreRelay(20_000);
    for (let i = 0; i < 100; i += 1) await pool.publish(mk(i, 1_800_000_000 - i * 10) as never);
    const recent = await queryPaged(pool as never, [{ kinds: [1060], '#p': [me], since: 1_800_000_000 - 295 }]);
    expect(recent).toHaveLength(30);
    let pages = 0;
    let t = 2_000_000_000;
    const endless = { query: async () => [{ id: `x${(pages += 1)}`, created_at: (t -= 1) }] as never };
    expect(await forEachPage(endless, [{ kinds: [1] }], () => {}, { maxPages: 5 })).toEqual({ events: 5, complete: false });
    expect(pages).toBe(5);
  });
});

describe('🔴 NostrVaultTransport：離線回來時分頁補拉，一則大訊息的訊框不會只收到一半', () => {
  it('訂閱只拿得到最新的一段；啟動時的補拉把其餘的訊框翻回來，訊息完整重組', { timeout: 60_000 }, async () => {
    const alice = Identity.generate();
    const bob = Identity.generate();
    const { pool } = coreRelay(300_000); // 每頁約 2 顆訊框（每顆 ~131 KB）
    const sender = createNostrVaultTransport({ pool: { publish: pool.publish, subscribe: () => ({ close() {} }) }, signer: alice, devices: [bob.pubkey] });
    const content = new Uint8Array(1024 * 1024).fill(9); // 1 MiB ≈ 22 個訊框
    const message: VaultSyncMessage = {
      type: 'node',
      from: 'dev-a',
      fileId: 'a'.repeat(32),
      node: { id: 'b'.repeat(32), parents: [], path: 'a.bin', pathAt: 1, deleted: false, hash: sha256Hex(content), size: content.length, text: false, at: 1, device: 'dev-a', label: 'A', p2p: false },
      content,
    };
    await sender.send(message);

    const got: VaultSyncMessage[] = [];
    const withoutBackfill = createNostrVaultTransport({ pool: { ...pool, query: undefined } as VaultRelayPool, signer: bob, devices: [alice.pubkey] });
    withoutBackfill.onMessage((m) => got.push(m));
    await Promise.resolve();
    expect(got).toHaveLength(0); // v0.24 的行為：只收到最新幾個訊框，重組不起來

    const receiver = createNostrVaultTransport({ pool, signer: bob, devices: [alice.pubkey] });
    receiver.onMessage((m) => got.push(m));
    await receiver.backfill();
    expect(got).toHaveLength(1);
    expect(got[0]!.type === 'node' && got[0]!.content?.length).toBe(content.length);
  });
});
