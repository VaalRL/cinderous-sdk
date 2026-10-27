// 端對端（SDK ADR 0067 實作計畫第 3 項）：真的 Node 中繼（SQLite）＋三台裝置（真的連線池、NIP-42、加解密、協調器）。
// 支援與否從真的 NIP-11 讀；到期時間直接讀中繼的 SQLite（`offline_msgs.expiration`）。
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event } from 'nostr-tools/core';
import { afterEach, describe, expect, it } from 'vitest';

import { Identity } from '../../../src/identity.js';
import { startNodeRelay } from '../../../src/relay/node-relay.js';
import { RelayPool, type PublishOptions } from '../../../src/relay-pool.js';
import {
  createNostrVaultTransport,
  fetchRelayFilePolicy,
  inboxAckRelays,
  MemorySyncStateStore,
  VaultSyncCoordinator,
} from '../../../src/sync/vault/index.js';
import { MemoryVault } from './harness.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

const DAY = 86_400;
const GRACE = 7_200;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('等不到條件成立');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function setup() {
  const port = 44_000 + Math.floor(Math.random() * 2_000);
  const dbPath = join(tmpdir(), `cinderous-inbox-ack-${port}-${Date.now()}.db`);
  const relay = startNodeRelay({ PORT: String(port), DB_PATH: dbPath, MAX_FILE_MB: '17' });
  const db = new DatabaseSync(dbPath);
  cleanups.push(() => {
    relay.close();
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const url = `ws://127.0.0.1:${port}`;
  /** 寄給某人、還在庫裡的列 */
  const rowsTo = (pubkey: string) =>
    db.prepare('SELECT id, expiration FROM offline_msgs WHERE recipient = ?').all(pubkey) as { id: string; expiration: number }[];

  // NIP-11 照實讀：這座宣告了才送
  const declared = inboxAckRelays([await fetchRelayFilePolicy(url)]);
  expect(declared).toEqual([url]);

  const device = (identity: Identity, peers: string[], opts: { deviceId: string; inboxAck?: boolean }) => {
    const pool = new RelayPool({ urls: [url], identity });
    // 記下這台送出的每一顆（之後對照中繼上的列是誰寄的）
    const sent = new Set<string>();
    const publish = pool.publish.bind(pool);
    pool.publish = (event: Event, options?: PublishOptions) => {
      sent.add(event.id);
      return publish(event, options);
    };
    pool.connect();
    const transport = createNostrVaultTransport({
      pool,
      signer: identity,
      devices: peers,
      inboxAckRelays: declared,
      ...(opts.inboxAck === false ? { inboxAck: false } : {}),
    });
    const vault = new MemoryVault();
    const sync = new VaultSyncCoordinator({ adapter: vault, store: new MemorySyncStateStore(), transport, deviceId: opts.deviceId, tickMs: 0 });
    cleanups.push(() => {
      void sync.stop();
      transport.stop();
      pool.close();
    });
    return { sent, transport, vault, sync };
  };
  return { rowsTo, device };
}

describe('收件確認端對端（SDK ADR 0067）', () => {
  it('處理完的包降為「現在＋2 小時」到期；不在信任名單的寄件人寄來的不動', async () => {
    const { rowsTo, device } = await setup();
    const [ida, idb, idm] = [Identity.generate(), Identity.generate(), Identity.generate()];
    const a = device(ida, [idb.pubkey], { deviceId: 'dev-a' });
    const b = device(idb, [ida.pubkey], { deviceId: 'dev-b' });
    const mallory = device(idm, [idb.pubkey], { deviceId: 'dev-m' });
    await new Promise((resolve) => setTimeout(resolve, 500)); // 等 AUTH 與訂閱就緒
    await b.sync.start();
    await a.sync.start();
    await mallory.sync.start();

    a.vault.userWrite('n.md', '你好');
    await a.sync.notifyLocalChange('n.md', 'create');
    mallory.vault.userWrite('evil.md', '不該被確認');
    await mallory.sync.notifyLocalChange('evil.md', 'create');
    await until(() => b.vault.get('n.md') === '你好');
    const fromA = () => rowsTo(idb.pubkey).filter((r) => a.sent.has(r.id));
    const fromMallory = () => rowsTo(idb.pubkey).filter((r) => mallory.sent.has(r.id));
    await until(() => fromA().length > 0 && fromMallory().length > 0);

    await until(async () => {
      await b.sync.idle();
      await b.transport.flushInboxAcks();
      const now = Math.floor(Date.now() / 1000);
      return fromA().every((r) => r.expiration <= now + GRACE);
    });
    const now = Math.floor(Date.now() / 1000);
    // a 寄來、b 處理完的：都在寬限附近（不是被刪掉、也不是隨便一個時間）
    for (const r of fromA()) expect(r.expiration).toBeGreaterThan(now + GRACE - 60);
    // mallory 不在 b 的信任名單：一顆都沒被確認，仍是 7 天
    for (const r of fromMallory()) expect(r.expiration).toBeGreaterThan(now + 7 * DAY - 120);
    // b 的收件匣裡只有這兩位寄的
    expect(rowsTo(idb.pubkey).length).toBe(fromA().length + fromMallory().length);
  }, 30_000);

  it('舊客戶端（不送確認）：包照舊放 7 天', async () => {
    const { rowsTo, device } = await setup();
    const [ida, idb] = [Identity.generate(), Identity.generate()];
    const a = device(ida, [idb.pubkey], { deviceId: 'dev-a' });
    const b = device(idb, [ida.pubkey], { deviceId: 'dev-b', inboxAck: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await b.sync.start();
    await a.sync.start();
    a.vault.userWrite('n.md', '你好');
    await a.sync.notifyLocalChange('n.md', 'create');
    await until(() => b.vault.get('n.md') === '你好');
    await b.sync.idle();
    await b.transport.flushInboxAcks();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const now = Math.floor(Date.now() / 1000);
    const rows = rowsTo(idb.pubkey);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.expiration).toBeGreaterThan(now + 7 * DAY - 120);
  }, 30_000);
});
