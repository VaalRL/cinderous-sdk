// 輕量成員（SDK ADR 0058）：知道整個 Vault 的版本資訊、只保存與寫入內容範圍內的檔案；按需取得、釘選、LRU 快取、
// 安全清除（不產生刪除版本）、沒有基準內容不得產生版本、允許新增的範圍、送出端依收件人裁剪、只有版本資訊的合併訊息。
import { describe, expect, it } from 'vitest';

import { FILE_TIER_MAX_BYTES } from '../../../src/sync/ingest.js';
import {
  compilePathFilter,
  isVaultScopeError,
  sparsePeerScopes,
  type VaultContentScope,
  type VaultRemoteChange,
  type VaultSyncMessage,
  type VaultSyncOptions,
} from '../../../src/sync/vault/index.js';
import { type Device, MemoryVault, Net, text } from './harness.js';

const DAILY: VaultContentScope = { content: ['Daily/'] };

/** 這台裝置送出過的刪除版本（不含合併） */
function deletesFrom(net: Net, device: string): VaultSyncMessage[] {
  return net.hub.messages.filter((m) => m.type === 'node' && m.from === device && m.node.deleted && m.node.parents.length <= 1);
}

/** 狀態儲存裡這個檔案有沒有保存任何內容 */
async function blobsOf(d: Device, path: string): Promise<string[]> {
  const entry = d.sync.lookup(path);
  if (!entry) return [];
  return d.store.keys(`b:${entry.fileId}:`);
}

function healthy(...devices: Device[]) {
  for (const d of devices) {
    expect(d.errors, d.name).toEqual([]);
    const s = d.sync.status();
    expect(s.waiting, `${d.name} waiting`).toBe(0);
    expect(s.pending, `${d.name} pending`).toEqual([]);
    expect(s.queue, `${d.name} queue`).toBe(0);
  }
}

/** a＝完整成員（有 Daily 與 Notes）、b＝輕量成員（只要 Daily） */
async function setup(opts: { b?: Partial<VaultSyncOptions>; p2p?: boolean; files?: Record<string, string> } = {}) {
  const net = new Net({ maxDelayMs: 30, ...(opts.p2p ? { p2p: true } : {}) });
  const vault = new MemoryVault();
  for (const [p, c] of Object.entries(opts.files ?? { 'Daily/2026-10-05.md': '# 今天\n', 'Notes/x.md': 'x 的內容', 'Notes/y.md': 'y 的內容' })) vault.userWrite(p, c);
  const a = await net.add('a', { vault, options: { peerScopes: { b: ['Daily/'] } } });
  await net.settle();
  const b = await net.add('b', { options: { scope: DAILY, ...opts.b } });
  await net.settle();
  return { net, a, b };
}

describe('輕量成員：知道整個架構、只有範圍內的內容', () => {
  it('初次加入：範圍內的寫進磁碟、範圍外的只有版本資訊（不寫磁碟、不保存內容）；remoteIndex 列出全部', async () => {
    const { a, b, net } = await setup();
    expect(b.vault.tree()).toEqual({ 'Daily/2026-10-05.md': '# 今天\n' });
    const index = b.sync.remoteIndex();
    expect(index.map((e) => [e.path, e.local, e.inScope, e.size, e.deleted])).toEqual([
      ['Daily/2026-10-05.md', true, true, 9, false],
      ['Notes/x.md', false, false, text('x 的內容').length, false],
      ['Notes/y.md', false, false, text('y 的內容').length, false],
    ]);
    // 雜湊、版本與完整成員一致
    const full = new Map(a.sync.index().map((e) => [e.path, e]));
    for (const e of index) expect([e.hash, e.versionId]).toEqual([full.get(e.path)!.hash, full.get(e.path)!.versionId]);
    expect(await blobsOf(b, 'Notes/x.md')).toEqual([]);
    expect(b.sync.lookup('notes/X.md')?.path).toBe('Notes/x.md'); // 預設不分大小寫
    expect(b.sync.lookup('Nope.md')).toBeNull();
    expect(b.sync.status().scope).toEqual({ local: { files: 1, bytes: 9 }, cached: { files: 0, bytes: 0 }, limit: 200 * 1024 * 1024, known: 3 });
    // 送出端裁剪：b 收到的訊息裡，範圍外的版本都沒有內容
    expect(net.hub.messages.some((m) => m.type === 'nodes' && m.from === 'a')).toBe(true);
    healthy(a, b);
  });

  it('之後的修改：範圍外的只收版本資訊（大小、雜湊跟著變），範圍內的照常寫入；摘要與 peerStatus 一致', async () => {
    const { a, b, net } = await setup();
    await a.edit('Notes/x.md', 'x 改了，變長了');
    await a.edit('Daily/2026-10-05.md', '# 今天\n- 開會\n');
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'Daily/2026-10-05.md': '# 今天\n- 開會\n' });
    const x = b.sync.lookup('Notes/x.md')!;
    expect([x.size, x.hash, x.local]).toEqual([text('x 改了，變長了').length, a.sync.index().find((e) => e.path === 'Notes/x.md')!.hash, false]);
    expect(await blobsOf(b, 'Notes/x.md')).toEqual([]);
    b.sync.resync();
    a.sync.resync();
    await net.settle();
    expect(a.sync.peerStatus('b')).toMatchObject({ missing: 0, sparse: true });
    expect(b.sync.peerStatus('a')).toMatchObject({ missing: 0, sparse: false });
    healthy(a, b);
  });

  it('完整成員沒有宣告 b 是輕量的（舊版、或還沒收到名單）：內容照送，b 照樣不保存、不寫入', async () => {
    const net = new Net({ maxDelayMs: 30 });
    const a = await net.add('a');
    await a.edit('Notes/x.md', 'x');
    const b = await net.add('b', { options: { scope: DAILY } });
    await net.settle();
    expect(b.vault.tree()).toEqual({});
    expect(b.sync.lookup('Notes/x.md')?.local).toBe(false);
    expect(await blobsOf(b, 'Notes/x.md')).toEqual([]);
    healthy(a, b);
  });

  it('傳輸層做不到依收件人送（舊的傳輸層）：不合成 nodes 訊息、內容照送；b 照樣不保存', async () => {
    const net = new Net({ maxDelayMs: 30 });
    net.hub.targeted = false;
    const a = await net.add('a', { options: { peerScopes: { b: ['Daily/'] } } });
    for (let i = 0; i < 5; i += 1) await a.edit(`Notes/${i}.md`, `n${i}`);
    const b = await net.add('b', { options: { scope: DAILY } });
    await net.settle();
    expect(net.hub.messages.some((m) => m.type === 'nodes')).toBe(false);
    expect(b.sync.remoteIndex()).toHaveLength(5);
    for (let i = 0; i < 5; i += 1) expect(await blobsOf(b, `Notes/${i}.md`)).toEqual([]);
    healthy(a, b);
  });
});

describe('按需取得、釘選、快取', () => {
  it('fetch：向完整成員要內容、寫進磁碟、成為快取；之後別台改了 → 跟著更新', async () => {
    const { a, b, net } = await setup();
    const fetching = b.sync.fetch('Notes/x.md');
    await net.settle();
    expect(new TextDecoder().decode(await fetching)).toBe('x 的內容');
    expect(b.vault.get('Notes/x.md')).toBe('x 的內容');
    expect(b.sync.lookup('Notes/x.md')).toMatchObject({ local: true, cached: true, inScope: true });
    // 已經在：直接回
    expect(new TextDecoder().decode(await b.sync.fetch('Notes/x.md'))).toBe('x 的內容');
    await a.edit('Notes/x.md', 'x 第二版');
    await net.settle();
    expect(b.vault.get('Notes/x.md')).toBe('x 第二版');
    // 快取的檔案可以改，改了照常送出
    await b.edit('Notes/x.md', 'x 在手機上改');
    await net.settle();
    expect(a.vault.get('Notes/x.md')).toBe('x 在手機上改');
    expect(b.sync.status().scope?.cached).toEqual({ files: 1, bytes: text('x 在手機上改').length });
    healthy(a, b);
  });

  it('fetch 的錯誤：不認得、已刪除、逾時（下載仍在背景進行）', async () => {
    const { a, b, net } = await setup();
    await expect(b.sync.fetch('Nope.md')).rejects.toMatchObject({ name: 'VaultScopeError', code: 'unknown' });
    await a.remove('Notes/y.md');
    await net.settle();
    await expect(b.sync.fetch('Notes/y.md')).rejects.toMatchObject({ code: 'deleted' });
    a.transport.setOnline(false);
    const pending = b.sync.fetch('Notes/x.md', { timeoutMs: 1000 }).catch((e: unknown) => e);
    await b.sync.idle();
    await net.clock.advance(1500);
    const error = await pending;
    expect(isVaultScopeError(error) && error.code).toBe('timeout');
    a.transport.setOnline(true);
    a.sync.resync();
    await net.clock.advance(5 * 60_000);
    await b.sync.tick();
    await net.settle();
    expect(b.vault.get('Notes/x.md')).toBe('x 的內容');
    expect(b.errors).toEqual([]);
  });

  it('LRU：超過 cacheBytes 時清掉最久沒用的；清掉不是刪除（沒有刪除版本，別台照常保留）', async () => {
    const files: Record<string, string> = {};
    for (const n of ['p', 'q', 'r']) files[`Notes/${n}.md`] = n.repeat(100);
    const { a, b, net } = await setup({ files, b: { scope: { ...DAILY, cacheBytes: 250 } } });
    const evicted: string[] = [];
    b.sync.on('evicted', (e) => evicted.push(`${e.reason}:${e.path}`));
    for (const n of ['p', 'q', 'r']) {
      const f = b.sync.fetch(`Notes/${n}.md`);
      await net.settle();
      await f;
      await net.clock.advance(1000);
    }
    expect(Object.keys(b.vault.tree()).sort()).toEqual(['Notes/q.md', 'Notes/r.md']);
    expect(evicted).toEqual(['lru:Notes/p.md']);
    expect(b.sync.lookup('Notes/p.md')).toMatchObject({ local: false, cached: false, deleted: false });
    expect(deletesFrom(net, 'b')).toEqual([]);
    expect(Object.keys(a.vault.tree()).sort()).toEqual(['Notes/p.md', 'Notes/q.md', 'Notes/r.md']);
    // 用過的會更新順序：再 fetch q（已在）→ 之後清的是 r
    await b.sync.fetch('Notes/q.md');
    await net.clock.advance(1000);
    const again = b.sync.fetch('Notes/p.md');
    await net.settle();
    await again;
    expect(Object.keys(b.vault.tree()).sort()).toEqual(['Notes/p.md', 'Notes/q.md']);
    healthy(a, b);
  });

  it('單一檔案比快取上限還大：最近抓的那一個不清（不然 fetch 永遠拿不到）', async () => {
    const { b, net } = await setup({ files: { 'Notes/big.md': 'x'.repeat(500) }, b: { scope: { ...DAILY, cacheBytes: 100 } } });
    const f = b.sync.fetch('Notes/big.md');
    await net.settle();
    expect((await f).length).toBe(500);
    expect(b.vault.get('Notes/big.md')).toBe('x'.repeat(500));
  });

  it('pin：抓下來、不受 LRU 影響、改名後仍釘著；unpin 變回一般快取', async () => {
    const { a, b, net } = await setup({ b: { scope: { ...DAILY, cacheBytes: 0 } } });
    await b.sync.pin('Notes/x.md');
    await net.settle();
    expect(b.vault.get('Notes/x.md')).toBe('x 的內容');
    expect(b.sync.pinned()).toEqual(['Notes/x.md']);
    await a.rename('Notes/x.md', 'Archive/x.md');
    await net.settle();
    expect(b.vault.get('Archive/x.md')).toBe('x 的內容');
    expect(b.sync.pinned()).toEqual(['Archive/x.md']);
    await b.sync.unpin('Archive/x.md');
    await net.settle();
    // cacheBytes 0：唯一的快取是最近用的那一個，留著；再抓一個就清掉它
    expect(b.vault.get('Archive/x.md')).toBe('x 的內容');
    const y = b.sync.fetch('Notes/y.md');
    await net.settle();
    await y;
    expect(b.vault.get('Archive/x.md')).toBeUndefined();
    expect(deletesFrom(net, 'b')).toEqual([]);
    await expect(b.sync.pin('Nope.md')).rejects.toMatchObject({ code: 'unknown' });
    healthy(a, b);
  });

  it('重啟後釘選與快取都還在', async () => {
    const { b, net } = await setup();
    await b.sync.pin('Notes/x.md');
    const f = b.sync.fetch('Notes/y.md');
    await net.settle();
    await f;
    await b.restart();
    await net.settle();
    expect(b.sync.pinned()).toEqual(['Notes/x.md']);
    expect(b.sync.lookup('Notes/y.md')).toMatchObject({ cached: true, local: true });
    expect(Object.keys(b.vault.tree()).sort()).toEqual(['Daily/2026-10-05.md', 'Notes/x.md', 'Notes/y.md']);
  });
});

describe('安全清除本機副本（evict）', () => {
  it('清掉快取：刪掉磁碟檔與內容、不產生刪除版本；再 fetch 抓得回來', async () => {
    const { a, b, net } = await setup();
    const f = b.sync.fetch('Notes/x.md');
    await net.settle();
    await f;
    expect(await b.sync.evict('Notes/x.md')).toEqual({ evicted: true });
    await net.settle();
    expect(b.vault.get('Notes/x.md')).toBeUndefined();
    expect(await blobsOf(b, 'Notes/x.md')).toEqual([]);
    expect(deletesFrom(net, 'b')).toEqual([]);
    expect(a.vault.get('Notes/x.md')).toBe('x 的內容');
    const again = b.sync.fetch('Notes/x.md');
    await net.settle();
    expect(new TextDecoder().decode(await again)).toBe('x 的內容');
    healthy(a, b);
  });

  it('在範圍內、不在本機、不認得 → 不清並說明原因；本機改了還沒送出 → 先收成版本、送出後自動清掉', async () => {
    const { a, b, net } = await setup();
    expect(await b.sync.evict('Daily/2026-10-05.md')).toEqual({ evicted: false, reason: 'in-scope' });
    expect(await b.sync.evict('Notes/x.md')).toEqual({ evicted: false, reason: 'not-local' });
    expect(await b.sync.evict('Nope.md')).toEqual({ evicted: false, reason: 'unknown' });
    const f = b.sync.fetch('Notes/x.md');
    await net.settle();
    await f;
    b.transport.setOnline(false);
    b.vault.userWrite('Notes/x.md', '離線時改的'); // 沒通知
    expect(await b.sync.evict('Notes/x.md')).toEqual({ evicted: false, reason: 'unsent' });
    expect(b.vault.get('Notes/x.md')).toBe('離線時改的');
    b.transport.setOnline(true);
    await net.settle();
    expect(a.vault.get('Notes/x.md')).toBe('離線時改的');
    // 送出了、完整成員簽收了（處理完、保存了；SDK ADR 0068）＝確認收到：自動清掉。不簽收的完整成員要等它的摘要（下一個測試前半）
    expect(b.vault.get('Notes/x.md')).toBeUndefined();
    expect(deletesFrom(net, 'b')).toEqual([]);
    healthy(a, b);
  });

  it('🔴 ADR 0047 §4 第 5 列的風險：滾動視窗（排除）裡應用自己刪掉本機副本 → 重新納入時變成刪除；改用 evict 就不會', async () => {
    const net = new Net({ maxDelayMs: 30 });
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('Daily/old.md', '舊的日記');
    await a.edit('Daily/old2.md', '舊的日記 2');
    await net.settle();
    await b.sync.setExcludes(compilePathFilter(['Daily/old*']));
    // 應用照「清掉視窗外的本機副本」的想法：一個直接刪檔（舊做法）、一個用 evict（新做法）
    b.vault.userRemove('Daily/old.md');
    await b.sync.notifyLocalChange('Daily/old.md', 'delete');
    expect(await b.sync.evict('Daily/old2.md')).toEqual({ evicted: true });
    expect(b.vault.get('Daily/old2.md')).toBeUndefined();
    expect(b.sync.detached()).toEqual([{ fileId: expect.any(String), path: 'Daily/old.md', reason: 'excluded' }]);
    await net.settle();
    // 視窗又涵蓋它們（重新納入）
    await b.sync.setExcludes(null);
    await net.settle();
    // evict 的：重新抓回來，不是刪除
    expect(b.vault.get('Daily/old2.md')).toBe('舊的日記 2');
    expect(a.vault.get('Daily/old2.md')).toBe('舊的日記 2');
    // 直接刪的：ADR 0047 定義為「排除期間被使用者刪掉」→ 一次本機刪除（這就是風險：應用的清理被當成使用者刪除）
    expect(a.vault.get('Daily/old.md')).toBeUndefined();
    // 同一個刪除版本可能因為摘要先到、a 來索取而再送一次：看的是有幾個刪除版本
    expect([...new Set(deletesFrom(net, 'b').map((m) => (m.type === 'node' ? `${m.node.path}:${m.node.id}` : '')))].map((k) => k.split(':')[0])).toEqual(['Daily/old.md']);
    healthy(a, b);
  });

  it('停止追蹤的本機副本被改過：不清（清了修改會遺失）；應用自己先刪了再 evict：記成清掉、不是刪除', async () => {
    const net = new Net({ maxDelayMs: 30 });
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('P/x.md', 'x');
    await a.edit('P/y.md', 'y');
    await net.settle();
    await b.sync.setExcludes(compilePathFilter(['P/']));
    b.vault.userWrite('P/x.md', '排除期間改了');
    expect(await b.sync.evict('P/x.md')).toEqual({ evicted: false, reason: 'modified' });
    expect(b.vault.get('P/x.md')).toBe('排除期間改了');
    b.vault.userRemove('P/y.md');
    expect(await b.sync.evict('P/y.md')).toEqual({ evicted: true });
    await b.sync.setExcludes(null);
    await net.settle();
    expect(a.vault.get('P/y.md')).toBe('y');
    expect(b.vault.get('P/y.md')).toBe('y');
    expect(a.vault.get('P/x.md')).toBe('排除期間改了');
    expect(deletesFrom(net, 'b')).toEqual([]);
  });
});

describe('範圍改變（setScope）', () => {
  it('滾動視窗：離開範圍的清掉（不是刪除）、進入範圍的抓回來；改回完整成員全部抓回來', async () => {
    const files: Record<string, string> = {};
    for (let d = 1; d <= 9; d += 1) files[`Daily/2026-10-0${d}.md`] = `# 10/${d}`;
    const net = new Net({ maxDelayMs: 30 });
    const vault = new MemoryVault();
    for (const [p, c] of Object.entries(files)) vault.userWrite(p, c);
    const a = await net.add('a', { vault });
    await net.settle();
    const week = (last: number) => ({ content: Array.from({ length: 7 }, (_, i) => `/Daily/2026-10-0${last - i}.md`).filter((p) => !p.includes('-00')) });
    const b = await net.add('b', { options: { scope: week(7) } });
    await net.settle();
    expect(Object.keys(b.vault.tree()).sort()).toEqual(['01', '02', '03', '04', '05', '06', '07'].map((d) => `Daily/2026-10-${d}.md`));
    await b.sync.setScope(week(9));
    await net.settle();
    expect(Object.keys(b.vault.tree()).sort()).toEqual(['03', '04', '05', '06', '07', '08', '09'].map((d) => `Daily/2026-10-${d}.md`));
    expect(deletesFrom(net, 'b')).toEqual([]);
    expect(Object.keys(a.vault.tree())).toHaveLength(9);
    await b.sync.setScope(null);
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(b.sync.sparse).toBe(false);
    healthy(a, b);
  });
});

describe('沒有基準內容不得產生版本、允許新增的範圍（裁示 3、SDK 第 4 項）', () => {
  it('在內容不在這台的檔案路徑上建立檔案 → 不產生版本、notifyLocalChange 以 VaultScopeError(base-missing) reject、error 事件只報一次', async () => {
    const { a, b, net } = await setup();
    b.vault.userWrite('Notes/x.md', '手機上直接打的');
    const error = await b.sync.notifyLocalChange('Notes/x.md', 'create').catch((e: unknown) => e);
    expect(isVaultScopeError(error) && [error.code, error.path]).toEqual(['base-missing', 'Notes/x.md']);
    await b.sync.scan();
    await net.settle();
    expect(b.errors.filter((e) => e.startsWith('sparse-base-missing'))).toHaveLength(1);
    expect(b.sync.blockedLocal()).toEqual([{ path: 'Notes/x.md', code: 'base-missing' }]);
    expect(a.vault.get('Notes/x.md')).toBe('x 的內容');
    expect(net.hub.messages.filter((m) => m.from === 'b' && m.type === 'node')).toEqual([]);
    // 不是同一個路徑的新檔照常同步
    await b.edit('Daily/2026-10-06.md', '明天');
    await net.settle();
    expect(a.vault.get('Daily/2026-10-06.md')).toBe('明天');
    b.errors.length = 0;
  });

  it('允許新增的範圍：範圍外的新檔不同步（create-outside）；範圍內的照常；改名與修改既有檔案不受限', async () => {
    const { a, b, net } = await setup({ b: { scope: { content: ['Daily/', 'Inbox/'], create: ['Daily/', 'Inbox/'] } } });
    expect(b.sync.canCreate('Inbox/新點子.md')).toBe(true);
    expect(b.sync.canCreate('Projects/p.md')).toBe(false);
    b.vault.userWrite('Projects/p.md', '不該同步');
    await expect(b.sync.notifyLocalChange('Projects/p.md', 'create')).rejects.toMatchObject({ code: 'create-outside' });
    await b.edit('Inbox/新點子.md', '點子');
    await net.settle();
    expect(a.vault.get('Inbox/新點子.md')).toBe('點子');
    expect(a.vault.get('Projects/p.md')).toBeUndefined();
    await b.rename('Inbox/新點子.md', 'Inbox/整理過的點子.md');
    await net.settle();
    expect(a.vault.get('Inbox/整理過的點子.md')).toBe('點子');
    expect(b.sync.blockedLocal()).toEqual([{ path: 'Projects/p.md', code: 'create-outside' }]);
    b.errors.length = 0;
    healthy(a, b);
  });
  it('被擋下的路徑之後由同步中的檔案佔用（使用者刪掉自己那一份、改抓同步的）：不再列在 blockedLocal（v0.49 修正）', async () => {
    const { a, b, net } = await setup();
    b.vault.userWrite('Notes/x.md', '手機上直接打的');
    await b.sync.notifyLocalChange('Notes/x.md', 'create').catch(() => {});
    expect(b.sync.blockedLocal()).toEqual([{ path: 'Notes/x.md', code: 'base-missing' }]);
    b.vault.userRemove('Notes/x.md'); // 沒有通知
    await Promise.all([b.sync.pin('Notes/x.md'), net.settle()]);
    await net.settle();
    expect(b.vault.get('Notes/x.md')).toBe('x 的內容');
    expect(b.sync.blockedLocal()).toEqual([]);
    b.errors.length = 0;
    healthy(a, b);
  });
});

describe('送出端裁剪與流量', () => {
  it('初次加入（5,000 個檔案、範圍內 50 個）：輕量成員收到的訊息數與位元組遠小於完整成員', { timeout: 600_000 }, async () => {
    const measure = async (scope: VaultContentScope | null) => {
      const net = new Net();
      const vault = new MemoryVault();
      for (let i = 0; i < 5000; i += 1) vault.userWrite(`${i < 50 ? 'Daily' : `folder-${i % 40}`}/note-${i}.md`, `# ${i}\n${'內容'.repeat(200)}\n`);
      const a = await net.add('a', { vault, options: scope ? { peerScopes: { b: ['Daily/'] } } : {} });
      await net.settle();
      const b = await net.add('b', { options: scope ? { scope } : {} });
      await net.settle();
      expect(b.sync.remoteIndex()).toHaveLength(5000);
      expect(Object.keys(b.vault.tree())).toHaveLength(scope ? 50 : 5000);
      healthy(a, b);
      return net.hub.received.get('b')!;
    };
    const full = await measure(null);
    const sparse = await measure(DAILY);
    console.log(`[sparse] 5,000 檔加入：完整成員 ${full.messages} 則／${full.bytes} B；輕量成員 ${sparse.messages} 則／${sparse.bytes} B`);
    expect(sparse.messages * 20).toBeLessThan(full.messages);
    expect(sparse.bytes * 4).toBeLessThan(full.bytes);
  });

  it('直連（P2P 批次）：範圍外只送版本資訊；大檔不直送給範圍外的輕量成員，fetch 時才直送', { timeout: 60_000 }, async () => {
    const net = new Net({ maxDelayMs: 30, p2p: true });
    const a = await net.add('a', { options: { peerScopes: { b: ['Daily/'] } } });
    for (let i = 0; i < 30; i += 1) await a.edit(`Notes/${i}.md`, 'n'.repeat(5000));
    const big = new Uint8Array(FILE_TIER_MAX_BYTES + 1000).fill(7);
    a.vault.userWrite('Notes/big.bin', big);
    await a.sync.notifyLocalChange('Notes/big.bin', 'create');
    await net.settle();
    const b = await net.add('b', { options: { scope: DAILY } });
    await net.settle();
    expect(b.sync.remoteIndex()).toHaveLength(31);
    expect(b.vault.tree()).toEqual({});
    const toB = net.mesh!.traffic.get('a->b') ?? 0;
    expect(toB).toBeLessThan(200_000);
    const f = b.sync.fetch('Notes/big.bin');
    await net.settle();
    expect((await f).length).toBe(big.length);
    expect(b.vault.files.get('Notes/big.bin')?.bytes.length).toBe(big.length);
    healthy(a, b);
  });

  it('輕量成員不是內容來源：手上沒有的內容不回索取；新加入的完整成員從完整成員拿到全部', async () => {
    const { a, net } = await setup();
    a.transport.setOnline(false);
    const c = await net.add('c');
    await net.settle();
    // a 離線：c 只拿得到 b 有的（Daily），其他的版本資訊有、內容等 a
    expect(Object.keys(c.vault.tree())).toEqual(['Daily/2026-10-05.md']);
    expect(c.sync.status().pending.map((p) => p.path).sort()).toEqual(['Notes/x.md', 'Notes/y.md']);
    // b 回 c 的摘要時只給得出版本資訊（每個檔案一則）；c 之後再要內容（fetch），b 手上沒有就不回
    const fromB = () => net.hub.messages.filter((m) => m.from === 'b' && m.type === 'node' && m.node.path.startsWith('Notes/'));
    expect(fromB().map((m) => (m.type === 'node' ? [m.node.path, m.content === undefined] : []))).toEqual([
      ['Notes/x.md', true],
      ['Notes/y.md', true],
    ]);
    await net.clock.advance(10 * 60_000);
    await c.sync.tick();
    await net.settle();
    expect(fromB()).toHaveLength(2);
    expect(net.hub.messages.some((m) => m.from === 'c' && m.type === 'want' && m.fetch === true)).toBe(true);
    a.transport.setOnline(true);
    a.sync.resync();
    await net.clock.advance(10 * 60_000);
    await c.sync.tick();
    await net.settle();
    expect(c.vault.tree()).toEqual(a.vault.tree());
  });

  it('sparsePeerScopes：名單上宣告為輕量的其他成員 → peerScopes（不含自己）', () => {
    const membership = {
      self: 'pk-a',
      sparseMembers: () => [
        { pubkey: 'pk-a', deviceId: 'a', patterns: ['x/'] },
        { pubkey: 'pk-b', deviceId: 'b', patterns: ['Daily/', 'Inbox/'] },
      ],
    };
    expect(sparsePeerScopes(membership)).toEqual({ b: ['Daily/', 'Inbox/'] });
  });
});

describe('清掉本機副本時告訴應用原因（ADR 0060，CinderSync G23）', () => {
  const FILES = {
    'Daily/2026-10-04.md': '# 昨天\n',
    'Daily/2026-10-05.md': '# 今天\n',
    'Notes/x.md': 'x 的內容',
    'Notes/p.md': 'p'.repeat(100),
    'Notes/q.md': 'q'.repeat(100),
  };

  /** 依序：evict（應用呼叫）→ LRU → 一次真正的刪除（別台刪的）→ 範圍改變 */
  async function scenario(b: Device, a: Device, net: Net) {
    const fetched = async (path: string) => {
      const f = b.sync.fetch(path);
      await net.settle();
      await f;
      await net.clock.advance(1000);
    };
    await fetched('Notes/x.md');
    expect(await b.sync.evict('Notes/x.md')).toEqual({ evicted: true });
    await fetched('Notes/p.md');
    await fetched('Notes/q.md'); // 200 B > 150 B：清掉最久沒用的 p
    await a.remove('Daily/2026-10-04.md');
    await net.settle();
    await b.sync.setScope({ content: [], cacheBytes: 150 });
    await net.settle();
    expect(Object.keys(b.vault.tree())).toEqual(['Notes/q.md']);
    expect(deletesFrom(net, 'b')).toEqual([]);
  }

  async function seeded() {
    const net = new Net({ maxDelayMs: 30 });
    const vault = new MemoryVault();
    for (const [p, c] of Object.entries(FILES)) vault.userWrite(p, c);
    const a = await net.add('a', { vault, options: { peerScopes: { b: ['Daily/'] } } });
    await net.settle();
    return { net, a };
  }

  it('applyRemote：清掉的 remove 帶 evict（scope／lru／evict，與 evicted 事件一致）；真正的刪除物件不變（沒有 evict 欄位）', async () => {
    const { net, a } = await seeded();
    const vault = new MemoryVault();
    const removes: VaultRemoteChange[] = [];
    const applyRemote = async (c: VaultRemoteChange) => {
      if (c.type === 'remove') {
        removes.push(c);
        return vault.remove(c.path, c.expect);
      }
      if (c.type === 'write') return vault.write(c.path, c.bytes, c.expect);
      return vault.rename(c.from, c.to, c.expect);
    };
    const b = await net.add('b', { vault, options: { scope: { content: ['Daily/'], cacheBytes: 150 }, applyRemote } });
    await net.settle();
    const events: string[] = [];
    b.sync.on('evicted', (e) => events.push(`${e.reason}:${e.path}`));
    await scenario(b, a, net);
    expect(removes.map((c) => (c.type === 'remove' ? [c.path, c.evict ?? 'delete'] : []))).toEqual([
      ['Notes/x.md', 'evict'],
      ['Notes/p.md', 'lru'],
      ['Daily/2026-10-04.md', 'delete'],
      ['Daily/2026-10-05.md', 'scope'],
    ]);
    expect(events).toEqual(['evict:Notes/x.md', 'lru:Notes/p.md', 'scope:Daily/2026-10-05.md']);
    // 真正的刪除：與 v0.46.0 完全相同的物件形狀
    expect(Object.keys(removes[2]!).sort()).toEqual(['expect', 'fileId', 'path', 'type']);
    healthy(a, b);
  });

  it('沒有 applyRemote：adapter.remove 第三個參數 { evict }；真正的刪除照舊只帶兩個參數', async () => {
    const { net, a } = await seeded();
    const b = await net.add('b', { options: { scope: { content: ['Daily/'], cacheBytes: 150 } } });
    await net.settle();
    await scenario(b, a, net);
    expect(b.vault.removeCalls.map((c) => [c.path, c.args, c.options])).toEqual([
      ['Notes/x.md', 3, { evict: 'evict' }],
      ['Notes/p.md', 3, { evict: 'lru' }],
      ['Daily/2026-10-04.md', 2, undefined],
      ['Daily/2026-10-05.md', 3, { evict: 'scope' }],
    ]);
    healthy(a, b);
  });

  it('清掉因排除而停止追蹤的本機副本（完整成員也適用）：一樣帶 evict', async () => {
    const net = new Net({ maxDelayMs: 30 });
    const a = await net.add('a');
    const removes: VaultRemoteChange[] = [];
    const vault = new MemoryVault();
    const b = await net.add('b', {
      vault,
      options: {
        applyRemote: async (c) => {
          if (c.type === 'remove') {
            removes.push(c);
            return vault.remove(c.path, c.expect, c.evict ? { evict: c.evict } : undefined);
          }
          if (c.type === 'write') return vault.write(c.path, c.bytes, c.expect);
          return vault.rename(c.from, c.to, c.expect);
        },
      },
    });
    await a.edit('P/x.md', 'x');
    await net.settle();
    await b.sync.setExcludes(compilePathFilter(['P/']));
    expect(await b.sync.evict('P/x.md')).toEqual({ evicted: true });
    expect(removes.map((c) => (c.type === 'remove' ? [c.path, c.evict] : []))).toEqual([['P/x.md', 'evict']]);
    expect(vault.removeCalls.map((c) => c.options)).toEqual([{ evict: 'evict' }]);
    expect(deletesFrom(net, 'b')).toEqual([]);
  });
});
