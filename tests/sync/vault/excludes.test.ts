// 協調器的同步排除範圍（SDK ADR 0047）：排除不等於刪除、執行中加入／移除、遠端被排除的版本略過不寫入、
// 各裝置規則不同時的收斂、重新納入時的合併與 G10 同內容收斂、啟動時的處理、大檔、向下相容。
import { describe, expect, it } from 'vitest';

import { FILE_TIER_MAX_BYTES } from '../../../src/sync/ingest.js';
import { compilePathFilter, compileSyncExcludes, type VaultSyncMessage } from '../../../src/sync/vault/index.js';
import { Net, text } from './harness.js';

const filter = (...patterns: string[]) => compilePathFilter(patterns);

/** 這台裝置送出過的刪除版本（不含合併版本） */
function deletesFrom(net: Net, device: string): VaultSyncMessage[] {
  return net.hub.messages.filter((m) => m.type === 'node' && m.from === device && m.node.deleted && m.node.parents.length <= 1);
}

async function twoDevices(opts: { a?: Parameters<Net['add']>[1]; b?: Parameters<Net['add']>[1] } = {}) {
  const net = new Net({ maxDelayMs: 50 });
  const a = await net.add('a', opts.a);
  const b = await net.add('b', opts.b);
  return { net, a, b };
}

function healthy(...devices: Array<{ name: string; errors: string[]; sync: { status(): { waiting: number; pending: unknown[]; queue: number } } }>) {
  for (const d of devices) {
    expect(d.errors, d.name).toEqual([]);
    const s = d.sync.status();
    expect(s.waiting, `${d.name} waiting`).toBe(0);
    expect(s.pending, `${d.name} pending`).toEqual([]);
    expect(s.queue, `${d.name} queue`).toBe(0);
  }
}

describe('向下相容', () => {
  it('沒有設定 excludes：isExcluded 只看 ignore，detached 是空的', async () => {
    const net = new Net();
    const a = await net.add('a', { options: { ignore: (p) => p.startsWith('.trash/') } });
    await a.edit('x.md', 'x');
    expect(a.sync.isExcluded('.trash/x.md')).toBe(true);
    expect(a.sync.isExcluded('x.md')).toBe(false);
    expect(a.sync.isExcluded('x.md.cinder-swap-0123abcd')).toBe(true);
    expect(a.sync.detached()).toEqual([]);
  });

  it('setExcludes(null) 等於沒有排除', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('p/x.md', 'x');
    await net.settle();
    await a.sync.setExcludes(filter('p/'));
    await a.sync.setExcludes(null);
    await net.settle();
    await b.edit('p/x.md', 'x2');
    await net.settle();
    expect(a.vault.get('p/x.md')).toBe('x2');
    expect(a.sync.detached()).toEqual([]);
    healthy(a, b);
  });
});

describe('排除不等於刪除', () => {
  it('執行中加入排除：停止追蹤、本機檔案不動、不產生刪除版本、其他裝置照常保留', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('notes/a.md', 'a');
    await a.edit('private/s.md', 'secret');
    await net.settle();
    expect(b.vault.get('private/s.md')).toBe('secret');

    await a.sync.setExcludes(filter('private/'));
    await net.settle();
    expect(a.vault.get('private/s.md')).toBe('secret');
    expect(b.vault.get('private/s.md')).toBe('secret');
    expect(a.sync.index().map((e) => e.path)).toEqual(['notes/a.md']);
    expect(a.sync.detached()).toEqual([{ fileId: expect.any(String), path: 'private/s.md', reason: 'excluded' }]);
    expect(deletesFrom(net, 'a')).toEqual([]);
    expect(a.sync.tombstones()).toEqual([]);
    expect(b.sync.tombstones()).toEqual([]);

    // 排除後本機的修改與刪除都不送出
    await a.edit('private/s.md', 'changed locally');
    await a.remove('private/s.md');
    await a.sync.scan();
    await net.settle();
    expect(b.vault.get('private/s.md')).toBe('secret');
    expect(deletesFrom(net, 'a')).toEqual([]);
    healthy(a, b);
  });

  it('A 排除、B 沒排除、B 修改：A 不寫入、不卡住；B 不會因為 A 不回應而出錯', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('private/s.md', 'v1');
    await net.settle();
    await a.sync.setExcludes(filter('private/'));
    for (let i = 2; i <= 5; i += 1) {
      await b.edit('private/s.md', `v${i}`);
      await net.settle();
    }
    expect(a.vault.get('private/s.md')).toBe('v1');
    expect(b.vault.get('private/s.md')).toBe('v5');
    healthy(a, b);
    expect(await b.sync.whenSent({ timeoutMs: 1000 })).toMatchObject({ state: 'sent' });
    expect(await a.sync.whenSent({ timeoutMs: 1000 })).toMatchObject({ state: 'sent' });

    // 對帳：摘要來回之後不會反覆索取或補送（A 記得那些版本，只是不寫入）
    a.sync.resync();
    b.sync.resync();
    await net.settle();
    const before = net.hub.messages.length;
    a.sync.resync();
    b.sync.resync();
    await net.settle();
    // 只有兩份摘要（加上互相回的簽收單，SDK ADR 0068）
    expect(net.hub.messages.slice(before).filter((m) => m.type !== 'receipt').map((m) => m.type)).toEqual(['digest', 'digest']);
    healthy(a, b);
  });

  it('其他裝置新建在被排除路徑的檔案：不寫入；移除排除後寫入', async () => {
    const { net, a, b } = await twoDevices();
    await a.sync.setExcludes(filter('*.pdf'));
    await b.edit('docs/r.pdf', 'pdf-bytes');
    await net.settle();
    expect(a.vault.files.has('docs/r.pdf')).toBe(false);
    healthy(a, b);
    await a.sync.setExcludes(null);
    await net.settle();
    expect(a.vault.get('docs/r.pdf')).toBe('pdf-bytes');
    healthy(a, b);
  });

  it('其他裝置刪掉本機排除的檔案：本機那一份不動；移除排除後當作新檔加回去', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('private/s.md', 'keep me');
    await net.settle();
    await a.sync.setExcludes(filter('private/'));
    await b.remove('private/s.md');
    await net.settle();
    expect(a.vault.get('private/s.md')).toBe('keep me');
    await a.sync.setExcludes(null);
    await net.settle();
    expect(a.vault.get('private/s.md')).toBe('keep me');
    expect(b.vault.get('private/s.md')).toBe('keep me');
    healthy(a, b);
  });

  it('🔴 這台把檔案搬進自己排除的範圍：停止追蹤，不是刪除——其他裝置照常保留；移除排除後當作改名送出（ADR 0071）', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('notes/x.md', 'x');
    await net.settle();
    await a.sync.setExcludes(filter('private/'));
    await a.rename('notes/x.md', 'private/x.md');
    await net.settle();
    expect(deletesFrom(net, 'a')).toEqual([]);
    expect(b.vault.get('notes/x.md')).toBe('x');
    expect(a.sync.detached()).toEqual([{ fileId: expect.any(String), path: 'private/x.md', reason: 'excluded' }]);
    // 掃描也不會把它當成刪除
    await a.sync.scan();
    await net.settle();
    expect(deletesFrom(net, 'a')).toEqual([]);
    // B 之後的修改不寫進 A 排除的那一份
    await b.edit('notes/x.md', 'x by b');
    await net.settle();
    expect(a.vault.get('private/x.md')).toBe('x');
    expect(a.vault.files.has('notes/x.md')).toBe(false);
    // 移除排除：當作改名（以停止追蹤時的版本為父）與 B 的修改合併，兩台收斂在新路徑
    await a.sync.setExcludes(null);
    await net.settle();
    expect(a.vault.get('private/x.md')).toBe('x by b');
    expect(b.vault.get('private/x.md')).toBe('x by b');
    expect(b.vault.files.has('notes/x.md')).toBe(false);
    expect(a.sync.detached()).toEqual([]);
    healthy(a, b);
  });

  it('其他裝置把檔案搬進本機排除的範圍：本機原路徑的那一份留著（不刪）；改過之後當作新檔加入', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('notes/x.md', 'x');
    await net.settle();
    await a.sync.setExcludes(filter('private/'));
    await b.rename('notes/x.md', 'private/x.md');
    await net.settle();
    expect(a.vault.get('notes/x.md')).toBe('x');
    expect(a.vault.files.has('private/x.md')).toBe(false);
    expect(b.vault.files.has('notes/x.md')).toBe(false);
    expect(a.sync.detached()).toEqual([{ fileId: expect.any(String), path: 'notes/x.md', reason: 'moved-out' }]);
    // 掃描不會把留著的那一份當作新檔送回去
    await a.sync.scan();
    await net.settle();
    expect(b.vault.files.has('notes/x.md')).toBe(false);
    expect(deletesFrom(net, 'a')).toEqual([]);
    // B 之後修改、刪除它都不影響 A 留著的那一份
    await b.edit('private/x.md', 'x by b');
    await net.settle();
    expect(a.vault.get('notes/x.md')).toBe('x');
    // A 改了留著的那一份：變成一個新檔
    await a.edit('notes/x.md', 'x edited on a');
    await net.settle();
    expect(b.vault.get('notes/x.md')).toBe('x edited on a');
    expect(b.vault.get('private/x.md')).toBe('x by b');
    expect(a.sync.detached()).toEqual([]);
    healthy(a, b);
  });

  it('留著的那一份：別台之後把檔案刪了，它就是一個普通的本機檔案（下次掃描當作新檔加入，不會不見）', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('notes/x.md', 'x');
    await net.settle();
    await a.sync.setExcludes(filter('private/'));
    await b.rename('notes/x.md', 'private/x.md');
    await net.settle();
    await b.remove('private/x.md');
    await net.settle();
    expect(a.vault.get('notes/x.md')).toBe('x');
    await a.sync.scan();
    await net.settle();
    expect(b.vault.get('notes/x.md')).toBe('x');
    expect(a.sync.detached()).toEqual([]);
    healthy(a, b);
  });

  it('留著的那一份：別台又把它搬回同步範圍時恢復追蹤、跟著搬過去（不會多一份）', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('notes/x.md', 'x');
    await net.settle();
    await a.sync.setExcludes(filter('private/'));
    await b.rename('notes/x.md', 'private/x.md');
    await net.settle();
    await b.rename('private/x.md', 'archive/x.md');
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'archive/x.md': 'x' });
    expect(b.vault.tree()).toEqual({ 'archive/x.md': 'x' });
    expect(a.sync.detached()).toEqual([]);
    healthy(a, b);
  });

  it('本機把檔案搬進 ignore 的範圍（不是 excludes）＝離開同步範圍，其他裝置刪除（ADR 0071 只改 excludes）', async () => {
    const { net, a, b } = await twoDevices({ a: { options: { ignore: (p) => p.startsWith('tmp/') } } });
    await a.edit('notes/x.md', 'x');
    await net.settle();
    await a.rename('notes/x.md', 'tmp/x.md');
    await net.settle();
    expect(b.vault.files.has('notes/x.md')).toBe(false);
    expect(a.vault.get('tmp/x.md')).toBe('x');
    healthy(a, b);
  });

  it('遠端刪除排到啟動前：被排除的檔案在啟動時先停止追蹤，不會被刪', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('private/s.md', 's');
    await net.settle();
    a.transport.setOnline(false);
    await b.remove('private/s.md');
    await net.settle();
    await a.sync.stop();
    // 下次啟動時才帶上排除規則，而且不全量掃描
    const { VaultSyncCoordinator } = await import('../../../src/sync/vault/index.js');
    const sync = new VaultSyncCoordinator({ adapter: a.vault, store: a.store, transport: a.transport, deviceId: 'a', clock: net.clock, tickMs: 0, scanOnStart: false, excludes: filter('private/') });
    a.sync = sync;
    await sync.start();
    a.transport.setOnline(true);
    await net.settle();
    expect(a.vault.get('private/s.md')).toBe('s');
    expect(sync.detached().map((d) => d.path)).toEqual(['private/s.md']);
  });
});

describe('從排除移除：重新納入', () => {
  async function excludedThen(change: { local?: string; remote?: string }) {
    const { net, a, b } = await twoDevices();
    await a.edit('p/n.md', 'l1\nl2\nl3');
    await net.settle();
    await a.sync.setExcludes(filter('p/'));
    if (change.local !== undefined) {
      a.vault.userWrite('p/n.md', change.local);
      await a.sync.notifyLocalChange('p/n.md');
    }
    if (change.remote !== undefined) await b.edit('p/n.md', change.remote);
    await net.settle();
    await a.sync.setExcludes(null);
    await net.settle();
    return { net, a, b };
  }

  it('本機沒改、別台改了：寫入別台的內容（不是衝突）', async () => {
    const { a, b } = await excludedThen({ remote: 'l1\nB\nl3' });
    expect(a.vault.get('p/n.md')).toBe('l1\nB\nl3');
    expect(a.sync.status().conflicts).toEqual([]);
    expect(b.sync.status().conflicts).toEqual([]);
    healthy(a, b);
  });

  it('本機改了、別台沒改：本機的修改照常送出（不是衝突）', async () => {
    const { a, b } = await excludedThen({ local: 'A\nl2\nl3' });
    expect(b.vault.get('p/n.md')).toBe('A\nl2\nl3');
    expect(a.vault.tree()).toEqual({ 'p/n.md': 'A\nl2\nl3' });
    expect(a.sync.status().conflicts).toEqual([]);
    healthy(a, b);
  });

  it('兩邊改不同行：以停止追蹤時的版本為祖先三方合併', async () => {
    const { a, b } = await excludedThen({ local: 'A\nl2\nl3', remote: 'l1\nl2\nB' });
    expect(a.vault.get('p/n.md')).toBe('A\nl2\nB');
    expect(b.vault.get('p/n.md')).toBe('A\nl2\nB');
    expect(a.vault.tree()).toEqual(b.vault.tree());
    expect(a.sync.status().conflicts).toEqual([]);
    healthy(a, b);
  });

  it('兩邊改同一行：照常產生衝突副本，兩份內容都在', async () => {
    const { a, b } = await excludedThen({ local: 'A\nl2\nl3', remote: 'B\nl2\nl3' });
    expect(a.vault.tree()).toEqual(b.vault.tree());
    const all = Object.values(a.vault.tree()).join('\n');
    expect(all).toContain('A');
    expect(all).toContain('B');
    healthy(a, b);
  });

  it('兩邊都沒改：什麼都不送', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('p/n.md', 'n');
    await net.settle();
    const sent = net.hub.sent;
    await a.sync.setExcludes(filter('p/'));
    await a.sync.setExcludes(null);
    await net.settle();
    expect(net.hub.messages.slice(sent).filter((m) => m.type === 'node')).toEqual([]);
    expect(a.sync.detached()).toEqual([]);
    healthy(a, b);
  });

  it('排除期間本機新建、別台同路徑同內容：重新納入時收斂成一個檔案（G10），不產生衝突副本', async () => {
    const { net, a, b } = await twoDevices();
    await a.sync.setExcludes(filter('p/'));
    a.vault.userWrite('p/same.md', 'same');
    await b.edit('p/same.md', 'same');
    await net.settle();
    await a.sync.setExcludes(null);
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'p/same.md': 'same' });
    expect(b.vault.tree()).toEqual({ 'p/same.md': 'same' });
    expect(a.sync.status().conflicts).toEqual([]);
    healthy(a, b);
  });

  it('排除期間本機新建、別台同路徑不同內容：產生衝突副本，兩份都留著', async () => {
    const { net, a, b } = await twoDevices();
    await a.sync.setExcludes(filter('p/'));
    a.vault.userWrite('p/d.md', 'from a');
    await b.edit('p/d.md', 'from b');
    await net.settle();
    await a.sync.setExcludes(null);
    await net.settle();
    expect(a.vault.tree()).toEqual(b.vault.tree());
    expect(Object.values(a.vault.tree()).sort()).toEqual(['from a', 'from b']);
    healthy(a, b);
  });

  it('排除期間本機刪掉被排除的檔案：排除期間不送出；重新納入時才當作一次本機刪除', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('p/n.md', 'n');
    await net.settle();
    await a.sync.setExcludes(filter('p/'));
    a.vault.userRemove('p/n.md');
    await a.sync.notifyLocalChange('p/n.md', 'delete');
    await a.sync.scan();
    await net.settle();
    expect(b.vault.get('p/n.md')).toBe('n');
    expect(deletesFrom(net, 'a')).toEqual([]);
    await a.sync.setExcludes(null);
    await net.settle();
    expect(a.vault.files.has('p/n.md')).toBe(false);
    expect(b.vault.files.has('p/n.md')).toBe(false);
    healthy(a, b);
  });

  it('排除期間本機刪掉、別台改了：重新納入時保留別台的修改（一刪一改保留修改）', async () => {
    const { net, a, b } = await twoDevices();
    await a.edit('p/n.md', 'n');
    await net.settle();
    await a.sync.setExcludes(filter('p/'));
    a.vault.userRemove('p/n.md');
    await b.edit('p/n.md', 'n by b');
    await net.settle();
    await a.sync.setExcludes(null);
    await net.settle();
    expect(a.vault.get('p/n.md')).toBe('n by b');
    expect(b.vault.get('p/n.md')).toBe('n by b');
    healthy(a, b);
  });

  it('重啟後規則不同：沒有規則就重新納入、跟別台合併', async () => {
    const net = new Net({ maxDelayMs: 50 });
    const a = await net.add('a', { options: { excludes: filter('p/') } });
    const b = await net.add('b');
    await b.edit('p/n.md', 'v1');
    await net.settle();
    expect(a.vault.files.has('p/n.md')).toBe(false);
    await b.edit('p/n.md', 'v2');
    await net.settle();
    await a.sync.stop();
    const { VaultSyncCoordinator } = await import('../../../src/sync/vault/index.js');
    a.sync = new VaultSyncCoordinator({ adapter: a.vault, store: a.store, transport: a.transport, deviceId: 'a', clock: net.clock, tickMs: 0 });
    await a.sync.start();
    await net.settle();
    expect(a.vault.get('p/n.md')).toBe('v2');
    healthy(a, b);
  });
});

describe('各裝置規則不同', () => {
  it('三台：A 排除、B 與 C 同時改（分岔）→ A 不合併、不等內容；B、C 收斂', async () => {
    const net = new Net({ maxDelayMs: 50 });
    const a = await net.add('a');
    const b = await net.add('b');
    const c = await net.add('c');
    await a.edit('p/n.md', 'l1\nl2\nl3');
    await net.settle();
    await a.sync.setExcludes(filter('p/'));
    b.transport.setOnline(false);
    c.transport.setOnline(false);
    await b.edit('p/n.md', 'B\nl2\nl3');
    await c.edit('p/n.md', 'l1\nl2\nC');
    b.transport.setOnline(true);
    c.transport.setOnline(true);
    await net.settle();
    expect(b.vault.get('p/n.md')).toBe('B\nl2\nC');
    expect(c.vault.get('p/n.md')).toBe('B\nl2\nC');
    expect(a.vault.get('p/n.md')).toBe('l1\nl2\nl3');
    healthy(a, b, c);
    await a.sync.setExcludes(null);
    await net.settle();
    expect(a.vault.get('p/n.md')).toBe('B\nl2\nC');
    healthy(a, b, c);
  });

  it('A 排除 docs/、B 排除 *.tmp：各自的檔案留在自己那裡，共同的範圍一致', async () => {
    const { net, a, b } = await twoDevices();
    await a.sync.setExcludes(filter('docs/'));
    await b.sync.setExcludes(filter('*.tmp'));
    await a.edit('docs/a.md', 'a-docs');
    await a.edit('x.tmp', 'a-tmp');
    await b.edit('docs/b.md', 'b-docs');
    await b.edit('y.tmp', 'b-tmp');
    await a.edit('shared.md', 's');
    await net.settle();
    // 每台的排除範圍只影響自己：A 不送 docs/、B 不送 *.tmp，也都不收
    expect(a.vault.tree()).toEqual({ 'docs/a.md': 'a-docs', 'shared.md': 's', 'x.tmp': 'a-tmp' });
    expect(b.vault.tree()).toEqual({ 'docs/b.md': 'b-docs', 'shared.md': 's', 'y.tmp': 'b-tmp' });
    // B 再改 docs/b.md：A 照樣不收
    await b.edit('docs/b.md', 'b-docs 2');
    await net.settle();
    expect(a.vault.files.has('docs/b.md')).toBe(false);
    healthy(a, b);
  });

  it('compileSyncExcludes 直接傳給協調器（兩層）', async () => {
    const net = new Net();
    const excludes = compileSyncExcludes({ fixed: ['/.trash/'], user: ['*.tmp'] });
    const a = await net.add('a', { options: { excludes } });
    expect(a.sync.isExcluded('.trash/a.md')).toBe(true);
    expect(a.sync.isExcluded('a.TMP')).toBe(true);
    expect(a.sync.isExcluded('a.md')).toBe(false);
    a.vault.userWrite('a.tmp', 't');
    a.vault.userWrite('Thumbs.db', 'not excluded: user list was given explicitly');
    await a.sync.scan();
    expect(a.sync.index().map((e) => e.path)).toEqual(['Thumbs.db']);
  });
});

describe('大檔（P2P）', () => {
  it('其他裝置的大檔在本機排除的範圍：不收內容（送方當作送達），不卡在 pending／pushes', async () => {
    const net = new Net({ p2p: true, streaming: true });
    const a = await net.add('a', { options: { excludes: filter('media/') } });
    const b = await net.add('b');
    const big = new Uint8Array(FILE_TIER_MAX_BYTES + 1000);
    big.set(text('big'), 0);
    await b.edit('media/v.bin', big);
    await net.settle();
    for (let i = 0; i < 3; i += 1) {
      await net.clock.advance(31 * 60_000);
      await a.sync.tick();
      await b.sync.tick();
      await net.settle();
    }
    expect(a.vault.files.has('media/v.bin')).toBe(false);
    expect(a.sync.status().pending).toEqual([]);
    expect(b.sync.status().pushes).toBe(0);
    expect(net.mesh!.traffic.get('b->a') ?? 0).toBeLessThan(1 << 20);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  }, 60_000);

  it('唯一有內容的那台在對方送摘要時正好排除了它（停止追蹤、不直送）：重新納入後，對方背景維護再要一次就收得到（v0.49 修正）', async () => {
    const net = new Net({ p2p: true, streaming: true });
    const a = await net.add('a');
    const big = new Uint8Array(FILE_TIER_MAX_BYTES + 1000);
    big.set(text('big'), 0);
    await a.edit('media/v.bin', big);
    await net.settle();
    await a.sync.setExcludes(filter('*.bin'));
    const b = await net.add('b');
    await net.settle();
    expect(b.sync.status().pending.map((p) => p.path)).toEqual(['media/v.bin']);
    await a.sync.setExcludes(null);
    await net.settle();
    for (let i = 0; i < 3 && b.sync.status().pending.length > 0; i += 1) {
      await net.clock.advance(6 * 60_000);
      await b.sync.tick();
      await net.settle();
    }
    expect(b.vault.files.get('media/v.bin')?.bytes.length).toBe(big.length);
    healthy(a, b);
  }, 60_000);
});
