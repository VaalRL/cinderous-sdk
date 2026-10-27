// 檔案樹同步協調器：各種情境（SDK ADR 0025）。
import { describe, expect, it } from 'vitest';

import { FILE_TIER_MAX_BYTES } from '../../../src/sync/ingest.js';
import { parseConflictCopyName } from '../../../src/sync/merge3.js';
import { MemorySyncStateStore, VaultSyncCoordinator, type VaultConflict, type VaultRemoteChange } from '../../../src/sync/vault/index.js';
import { MemoryVault, Net, text } from './harness.js';

async function pair(opts: ConstructorParameters<typeof Net>[0] = {}) {
  const net = new Net(opts);
  const a = await net.add('a');
  const b = await net.add('b');
  return { net, a, b };
}

function conflictsOf(...devices: { sync: VaultSyncCoordinator }[]): VaultConflict[] {
  return devices.flatMap((d) => d.sync.status().conflicts);
}

describe('單一操作同步', () => {
  it('新增、修改、刪除', async () => {
    const { net, a, b } = await pair();
    await a.edit('notes/a.md', '# A\n第一行');
    await net.settle();
    expect(b.vault.get('notes/a.md')).toBe('# A\n第一行');

    await a.edit('notes/a.md', '# A\n第一行\n第二行');
    await net.settle();
    expect(b.vault.get('notes/a.md')).toBe('# A\n第一行\n第二行');

    await b.remove('notes/a.md');
    await net.settle();
    expect(a.vault.files.has('notes/a.md')).toBe(false);
    expect(a.sync.tombstones()).toEqual([{ path: 'notes/a.md', deletedAt: expect.any(Number) }]);
    expect(conflictsOf(a, b)).toEqual([]);
  });

  it('改名是一個操作：保留檔案身分（對方只做改名，不是刪除＋新增）', async () => {
    const { net, a, b } = await pair();
    await a.edit('a.md', 'hello');
    await net.settle();
    const before = b.sync.index()[0]!;
    b.vault.log.length = 0;
    await a.rename('a.md', 'dir/b.md');
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'dir/b.md': 'hello' });
    expect(b.vault.log).toEqual(['rename a.md -> dir/b.md']);
    expect(b.sync.index()[0]!.fileId).toBe(before.fileId);
  });

  it('二進位檔', async () => {
    const { net, a, b } = await pair();
    await a.edit('img.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
    await net.settle();
    expect([...b.vault.files.get('img.png')!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  });

  it('三台裝置扇出', async () => {
    const net = new Net();
    const [a, b, c] = [await net.add('a'), await net.add('b'), await net.add('c')];
    await a.edit('x.md', 'x');
    await b.edit('y.md', 'y');
    await net.settle();
    for (const d of [a, b, c]) expect(d.vault.tree()).toEqual({ 'x.md': 'x', 'y.md': 'y' });
  });
});

describe('並發', () => {
  it('並發編輯同一檔不同段落：三方合併，兩邊都收斂到合併結果', async () => {
    const { net, a, b } = await pair();
    await a.edit('n.md', '一\n二\n三\n四');
    await net.settle();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.edit('n.md', '一（A）\n二\n三\n四');
    await b.edit('n.md', '一\n二\n三\n四（B）');
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'n.md': '一（A）\n二\n三\n四（B）' });
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(conflictsOf(a, b)).toEqual([]);
  });

  it('並發改同一行：較晚的留在主檔，另一方完整內容成為衝突副本（兩邊一致）', async () => {
    const { net, a, b } = await pair();
    await a.edit('n.md', '標題\n內文');
    await net.settle();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.edit('n.md', '標題\n內文 A');
    await net.clock.advance(10);
    await b.edit('n.md', '標題\n內文 B');
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    const tree = a.vault.tree();
    expect(b.vault.tree()).toEqual(tree);
    expect(tree['n.md']).toBe('標題\n內文 B');
    const copies = Object.entries(tree).filter(([p]) => p.startsWith('n (衝突-A-'));
    expect(copies).toHaveLength(1);
    expect(copies[0]![1]).toBe('標題\n內文 A');
    expect(conflictsOf(a, b).map((c) => c.kind)).toContain('text');
    // 協調器產生的副本名稱拆得回來（CinderSync G18）
    expect(parseConflictCopyName(copies[0]![0])).toMatchObject({ original: 'n.md', label: 'A' });
  });

  it('並發改二進位檔：產生衝突副本，不遺失任何一方', async () => {
    const { net, a, b } = await pair();
    await a.edit('f.bin', new Uint8Array([0, 1]));
    await net.settle();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.edit('f.bin', new Uint8Array([0, 1, 0xaa]));
    await b.edit('f.bin', new Uint8Array([0, 1, 0xbb]));
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    expect(b.vault.tree()).toEqual(a.vault.tree());
    const all = [...a.vault.files.values()].map((f) => [...f.bytes].join(','));
    expect(all.sort()).toEqual(['0,1,170', '0,1,187']);
    expect(conflictsOf(a).map((c) => c.kind)).toContain('binary');
  });

  it('一邊刪、一邊改：保留修改（不遺失），回報 delete-modify', async () => {
    const { net, a, b } = await pair();
    await a.edit('d.md', 'v1');
    await net.settle();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.remove('d.md');
    await b.edit('d.md', 'v2 重要修改');
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'd.md': 'v2 重要修改' });
    expect(b.vault.tree()).toEqual({ 'd.md': 'v2 重要修改' });
    expect(conflictsOf(a, b).map((c) => c.kind)).toContain('delete-modify');
  });

  it('兩邊都刪：刪掉，沒有衝突', async () => {
    const { net, a, b } = await pair();
    await a.edit('d.md', 'v1');
    await net.settle();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.remove('d.md');
    await b.remove('d.md');
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    expect(a.vault.tree()).toEqual({});
    expect(b.vault.tree()).toEqual({});
    expect(conflictsOf(a, b)).toEqual([]);
  });

  it('並發改名成不同名字：留較晚的名字，內容不變，只有一個檔案', async () => {
    const { net, a, b } = await pair();
    await a.edit('r.md', 'body');
    await net.settle();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.rename('r.md', 'ra.md');
    await net.clock.advance(5);
    await b.rename('r.md', 'rb.md');
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'rb.md': 'body' });
    expect(b.vault.tree()).toEqual({ 'rb.md': 'body' });
    expect(conflictsOf(a, b).find((c) => c.kind === 'rename-rename')?.otherPath).toBe('ra.md');
  });

  it('一邊改名、一邊修改：修改跟著套到新名字上', async () => {
    const { net, a, b } = await pair();
    await a.edit('old.md', '一\n二');
    await net.settle();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.rename('old.md', 'new.md');
    await b.edit('old.md', '一\n二\n三（B 加的）');
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'new.md': '一\n二\n三（B 加的）' });
    expect(b.vault.tree()).toEqual(a.vault.tree());
    expect(conflictsOf(a, b)).toEqual([]);
  });

  it('同一邊改名＋修改（一個操作）', async () => {
    const { net, a, b } = await pair();
    await a.edit('p.md', 'x');
    await net.settle();
    a.vault.userRename('p.md', 'q.md');
    a.vault.userWrite('q.md', 'x2');
    await a.sync.notifyLocalChange('q.md', 'rename', 'p.md');
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'q.md': 'x2' });
  });

  it('兩台各自新增同名檔案：先建立的留下，另一個改名成衝突副本（兩邊一致）', async () => {
    const { net, a, b } = await pair();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.edit('Untitled.md', 'from A');
    await net.clock.advance(3);
    await b.edit('Untitled.md', 'from B');
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    const tree = a.vault.tree();
    expect(b.vault.tree()).toEqual(tree);
    expect(tree['Untitled.md']).toBe('from A');
    expect(Object.values(tree).sort()).toEqual(['from A', 'from B']);
    expect(conflictsOf(a, b).map((c) => c.kind)).toContain('path-collision');
  });

  describe('G10（SDK ADR 0035）：同路徑、內容相同的兩個檔案直接收斂，不產生衝突副本', () => {
    it('🔴 新裝置帶著與 Vault 相同的檔案加入 → 零衝突副本；內容不同的那一個仍照舊產生副本', async () => {
      const net = new Net();
      const a = await net.add('a');
      await a.edit('notes/same.md', '# 一樣\n內容');
      await a.edit('img/logo.png', new Uint8Array([1, 2, 3, 4]));
      await a.edit('notes/diff.md', 'A 的版本');
      await net.settle();
      const vault = new MemoryVault();
      vault.userWrite('notes/same.md', '# 一樣\n內容');
      vault.userWrite('img/logo.png', new Uint8Array([1, 2, 3, 4]));
      vault.userWrite('notes/diff.md', 'C 的版本');
      await net.clock.advance(1000);
      const c = await net.add('c', { vault });
      await net.settle();
      expect(c.vault.tree()).toEqual(a.vault.tree());
      const paths = Object.keys(a.vault.tree()).sort();
      // 相同的兩個沒有副本；不同的那一個有一份副本（兩個版本都在）
      expect(paths.filter((p) => p.startsWith('notes/same') || p.startsWith('img/logo'))).toEqual(['img/logo.png', 'notes/same.md']);
      expect(paths.filter((p) => p.startsWith('notes/diff'))).toHaveLength(2);
      expect(Object.values(a.vault.tree()).filter((v) => v === 'A 的版本' || v === 'C 的版本').sort()).toEqual(['A 的版本', 'C 的版本']);
      const kinds = conflictsOf(a, c);
      expect(kinds.filter((k) => k.path === 'notes/same.md' || k.path === 'img/logo.png')).toEqual([]);
      expect(kinds.filter((k) => k.kind === 'path-collision' && k.path === 'notes/diff.md').length).toBeGreaterThan(0);
      expect([...a.errors, ...c.errors]).toEqual([]);
    });

    it('兩台離線各自建立同名、同內容的檔案 → 連上後只有一個，之後在任一台修改都同步得到另一台（兩邊一致）', async () => {
      const { net, a, b } = await pair();
      a.transport.setOnline(false);
      b.transport.setOnline(false);
      await a.edit('Untitled.md', '同一段');
      await net.clock.advance(3);
      await b.edit('Untitled.md', '同一段');
      a.transport.setOnline(true);
      b.transport.setOnline(true);
      await net.settle();
      expect(a.vault.tree()).toEqual({ 'Untitled.md': '同一段' });
      expect(b.vault.tree()).toEqual({ 'Untitled.md': '同一段' });
      expect(conflictsOf(a, b)).toEqual([]);
      // 後建立（輸掉路徑）的那台照常編輯：改動屬於留下來的那個檔案，傳得到另一台
      await b.edit('Untitled.md', '同一段\nB 加的');
      await net.settle();
      expect(a.vault.tree()).toEqual({ 'Untitled.md': '同一段\nB 加的' });
      await a.edit('Untitled.md', '同一段\nB 加的\nA 加的');
      await net.settle();
      expect(b.vault.tree()).toEqual({ 'Untitled.md': '同一段\nB 加的\nA 加的' });
      expect(conflictsOf(a, b)).toEqual([]);
    });

    it('第三台之後才加入：只收到一個檔案；重開協調器後仍然一致、不再產生副本', async () => {
      const { net, a, b } = await pair();
      a.transport.setOnline(false);
      await a.edit('x.md', 'X');
      await b.edit('x.md', 'X');
      a.transport.setOnline(true);
      await net.settle();
      const c = await net.add('c');
      await net.settle();
      for (const d of [a, b, c]) expect(d.vault.tree()).toEqual({ 'x.md': 'X' });
      await b.restart();
      await c.restart();
      await net.settle();
      for (const d of [a, b, c]) expect(d.vault.tree()).toEqual({ 'x.md': 'X' });
      expect(conflictsOf(a, b, c)).toEqual([]);
    });

    it('相撞之後、收斂之前，輸掉的那台又改了內容：修改不遺失（內容不同了，照舊產生副本）', async () => {
      const { net, a, b } = await pair();
      a.transport.setOnline(false);
      b.transport.setOnline(false);
      await a.edit('y.md', 'Y');
      await net.clock.advance(3);
      await b.edit('y.md', 'Y');
      b.transport.setOnline(true);
      await net.settle();
      // A 還離線時又改了一次（A 先建立，所以 A 是留下的那個；這裡讓輸的 B 也改）
      b.transport.setOnline(false);
      await b.edit('y.md', 'Y by B');
      a.transport.setOnline(true);
      b.transport.setOnline(true);
      await net.settle();
      expect(b.vault.tree()).toEqual(a.vault.tree());
      expect(Object.values(a.vault.tree())).toContain('Y by B');
    });
  });

  it('大小寫不同的同名檔案也算相撞（大小寫不分的檔案系統安全）', async () => {
    const { net, a, b } = await pair();
    a.transport.setOnline(false);
    await a.edit('Note.md', 'A');
    await b.edit('note.md', 'B');
    a.transport.setOnline(true);
    await net.settle();
    expect(Object.keys(a.vault.tree())).toHaveLength(2);
    expect(b.vault.tree()).toEqual(a.vault.tree());
  });

  it('互換名字（成環）：經暫存名完成，內容不混', async () => {
    const { net, a, b } = await pair();
    await a.edit('x.md', 'X');
    await a.edit('y.md', 'Y');
    await net.settle();
    a.vault.userRename('x.md', 'tmp.md');
    await a.sync.notifyLocalChange('tmp.md', 'rename', 'x.md');
    a.vault.userRename('y.md', 'x.md');
    await a.sync.notifyLocalChange('x.md', 'rename', 'y.md');
    a.vault.userRename('tmp.md', 'y.md');
    await a.sync.notifyLocalChange('y.md', 'rename', 'tmp.md');
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'x.md': 'Y', 'y.md': 'X' });
    expect(b.vault.tree()).toEqual({ 'x.md': 'Y', 'y.md': 'X' });
  });
});

describe('SDK ADR 0048：衝突副本不再來回震盪、空檔不產生衝突副本', () => {
  /** 每個路徑被這台協調器當成目的地（寫入、改名到、串流寫入）幾次 */
  function writesPerPath(log: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const line of log) {
      const m = /^(?:write|write-stream) (.+)$/.exec(line) ?? /^rename .+ -> (.+)$/.exec(line);
      if (m) out.set(m[1]!, (out.get(m[1]!) ?? 0) + 1);
    }
    return out;
  }

  /** 兩台配對前各自就有的檔案（像複製資料夾）：同路徑不同內容、沒有共同祖先；兩台同時上線 */
  async function prepaired(opts: { seed: number; maxDelayMs: number; echoMs?: number; label?: string }) {
    const net = new Net({ seed: opts.seed, maxDelayMs: opts.maxDelayMs, ...(opts.echoMs !== undefined ? { echoMs: opts.echoMs } : {}) });
    const va = new MemoryVault();
    const vb = new MemoryVault();
    va.userWrite('歡迎.md', '這是你的新儲存庫。p');
    vb.userWrite('歡迎.md', '這是你的新儲存庫。');
    va.userWrite('notes/同一份.md', '一樣');
    vb.userWrite('notes/同一份.md', '一樣');
    va.userWrite('img/x.bin', new Uint8Array([1, 2, 3]));
    vb.userWrite('img/x.bin', new Uint8Array([1, 2, 4]));
    const options = opts.label ? { options: { deviceLabel: opts.label } } : {};
    const [a, b] = await Promise.all([net.add('a', { vault: va, ...options }), net.add('b', { vault: vb, ...options })]);
    await net.settle();
    return { net, a, b };
  }

  it('🔴 配對前兩台各自有同路徑、內容不同的檔案，兩台同時在線、協調器自己的寫入有回音：每台對每個路徑最多寫一次，兩邊一致、不遺失', async () => {
    for (const echoMs of [undefined, 0, 500]) {
      for (const maxDelayMs of [0, 50, 300, 3000]) {
        for (let seed = 1; seed <= 6; seed += 1) {
          // 實機：同一台電腦上的兩個 Vault，裝置名稱一樣（衝突副本檔名也就一樣）
          const { a, b } = await prepaired({ seed, maxDelayMs, echoMs, label: 'STOAKC' });
          const context = `echoMs=${echoMs} maxDelayMs=${maxDelayMs} seed=${seed}\nA: ${a.vault.log.join(' | ')}\nB: ${b.vault.log.join(' | ')}`;
          for (const d of [a, b]) {
            for (const [path, n] of writesPerPath(d.vault.log)) expect(n, `${context}\n${d.name} 寫了 ${path} ${n} 次`).toBeLessThanOrEqual(1);
            // 唯一允許的移除：G10 同內容收斂的刪除版本比留下的檔案先到（移除後立刻寫回同一份內容；SDK ADR 0048〈未處理〉）
            expect(d.vault.log.filter((l) => l.startsWith('remove ') && l !== 'remove notes/同一份.md'), context).toEqual([]);
            expect(d.errors, context).toEqual([]);
          }
          const tree = a.vault.tree();
          expect(b.vault.tree(), context).toEqual(tree);
          expect(Object.values(tree).filter((v) => v.startsWith('這是你的新儲存庫')).sort(), context).toEqual(['這是你的新儲存庫。', '這是你的新儲存庫。p']);
          expect(Object.keys(tree).filter((p) => p.startsWith('歡迎 (衝突-STOAKC-')), context).toHaveLength(1);
          expect(Object.keys(tree).filter((p) => p.startsWith('notes/')), context).toEqual(['notes/同一份.md']);
          const bins = [...a.vault.files].filter(([p]) => p.startsWith('img/')).map(([, f]) => [...f.bytes].join(','));
          expect(bins.sort(), context).toEqual(['1,2,3', '1,2,4']);
        }
      }
    }
  });

  it('回音：自己套用的改名、舊路徑隨即被另一個檔案佔用（互換名字），不被當成使用者的改名（不送出任何版本）', async () => {
    const net = new Net({ echoMs: 500 });
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('x.md', 'X');
    await a.edit('y.md', 'Y');
    await net.settle();
    a.vault.userRename('x.md', 'tmp.md');
    await a.sync.notifyLocalChange('tmp.md', 'rename', 'x.md');
    a.vault.userRename('y.md', 'x.md');
    await a.sync.notifyLocalChange('x.md', 'rename', 'y.md');
    a.vault.userRename('tmp.md', 'y.md');
    await a.sync.notifyLocalChange('y.md', 'rename', 'tmp.md');
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'x.md': 'Y', 'y.md': 'X' });
    expect(b.vault.tree()).toEqual({ 'x.md': 'Y', 'y.md': 'X' });
    expect(net.hub.messages.filter((m) => m.from === 'b' && m.type === 'node')).toEqual([]);
  });

  it('回音到達前使用者改了舊路徑上（留下的）那個檔案：照常是那個檔案的修改，不是改名、副本不受影響', async () => {
    const { net, a, b } = await pair();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.edit('u.md', 'A 的');
    await net.clock.advance(3);
    await b.edit('u.md', 'B 的');
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    // B 把自己輸的那個改名成副本、A 的寫進原路徑；使用者先改了原路徑，改名的回音才到
    expect(b.vault.log.slice(0, 2)).toEqual([expect.stringMatching(/^rename u\.md -> u \(衝突-B-/), 'write u.md']);
    const copy = Object.keys(b.vault.tree()).find((p) => p.startsWith('u (衝突-'))!;
    b.vault.userWrite('u.md', 'A 的\n使用者剛加的');
    await b.sync.notifyLocalChange(copy, 'rename', 'u.md');
    await net.settle();
    for (const d of [a, b]) expect(d.vault.tree()).toEqual({ 'u.md': 'A 的\n使用者剛加的', [copy]: 'B 的' });
  });

  describe('空檔（0 位元組）不產生衝突副本', () => {
    for (const emptyFirst of [true, false]) {
      it(`無共同祖先的路徑相撞，一方是空檔（空檔${emptyFirst ? '先' : '後'}建立）：採用有內容的一方，沒有副本、沒有衝突`, async () => {
        const { net, a, b } = await pair({ echoMs: 500 });
        a.transport.setOnline(false);
        b.transport.setOnline(false);
        await a.edit('2026-10-02.md', emptyFirst ? '' : '今天的筆記');
        await net.clock.advance(3);
        await b.edit('2026-10-02.md', emptyFirst ? '今天的筆記' : '');
        a.transport.setOnline(true);
        b.transport.setOnline(true);
        await net.settle();
        for (const d of [a, b]) expect(d.vault.tree()).toEqual({ '2026-10-02.md': '今天的筆記' });
        expect(conflictsOf(a, b)).toEqual([]);
        expect([...a.errors, ...b.errors]).toEqual([]);
        // 之後兩台照常編輯同一個檔案
        await a.edit('2026-10-02.md', '今天的筆記\nA');
        await net.settle();
        expect(b.vault.get('2026-10-02.md')).toBe('今天的筆記\nA');
        await b.edit('2026-10-02.md', '今天的筆記\nA\nB');
        await net.settle();
        expect(a.vault.get('2026-10-02.md')).toBe('今天的筆記\nA\nB');
      });
    }

    it('配對前就有：一邊是剛建立的空白每日筆記、另一邊有內容 → 兩台同時在線也只留有內容的一份；兩邊都空 → 一份空檔', async () => {
      for (let seed = 1; seed <= 6; seed += 1) {
        const net = new Net({ seed, maxDelayMs: 300, echoMs: 500 });
        const va = new MemoryVault();
        const vb = new MemoryVault();
        va.userWrite('2026-10-02.md', '');
        vb.userWrite('2026-10-02.md', '今天的內容');
        va.userWrite('空.md', '');
        vb.userWrite('空.md', '');
        const [a, b] = await Promise.all([net.add('a', { vault: va }), net.add('b', { vault: vb })]);
        await net.settle();
        for (const d of [a, b]) expect(d.vault.tree(), `seed=${seed}`).toEqual({ '2026-10-02.md': '今天的內容', '空.md': '' });
        expect(conflictsOf(a, b), `seed=${seed}`).toEqual([]);
      }
    });

    it('空檔還沒被收掉之前使用者在裡面打了字：不遺失（照舊產生副本）', async () => {
      const { net, a, b } = await pair();
      a.transport.setOnline(false);
      b.transport.setOnline(false);
      await a.edit('d.md', '');
      await net.clock.advance(3);
      await b.edit('d.md', 'B 的內容');
      // A 收到 B 的版本、要移除空檔的那一刻，使用者剛好打了字
      a.vault.beforeGuardedOp = (path) => {
        if (path !== 'd.md' || a.vault.get('d.md') !== '') return;
        a.vault.userWrite('d.md', 'A 剛打的字');
        void a.sync.notifyLocalChange('d.md', 'modify');
      };
      a.transport.setOnline(true);
      b.transport.setOnline(true);
      await net.settle();
      a.vault.beforeGuardedOp = undefined;
      await net.settle();
      expect(b.vault.tree()).toEqual(a.vault.tree());
      expect(Object.values(a.vault.tree()).sort()).toEqual(['A 剛打的字', 'B 的內容']);
    });

    for (const callouts of [false, true]) {
      it(`同一個檔案並發：一方清空、另一方修改 → 採用有內容的一方，沒有副本${callouts ? '也沒有 callout' : ''}`, async () => {
        const { net, a, b } = await pair(callouts ? { options: { conflictCallouts: true } } : {});
        await a.edit('n.md', '標題\n內文');
        await net.settle();
        a.transport.setOnline(false);
        b.transport.setOnline(false);
        await a.edit('n.md', '');
        await net.clock.advance(10);
        await b.edit('n.md', '標題\n內文 B');
        a.transport.setOnline(true);
        b.transport.setOnline(true);
        await net.settle();
        for (const d of [a, b]) expect(d.vault.tree()).toEqual({ 'n.md': '標題\n內文 B' });
        expect(conflictsOf(a, b)).toEqual([]);
      });
    }

    it('二進位檔一方是空檔：同樣採用有內容的一方', async () => {
      const { net, a, b } = await pair();
      await a.edit('f.bin', new Uint8Array([0, 1]));
      await net.settle();
      a.transport.setOnline(false);
      b.transport.setOnline(false);
      await a.edit('f.bin', new Uint8Array([0, 1, 0xaa]));
      await net.clock.advance(10);
      await b.edit('f.bin', new Uint8Array([]));
      a.transport.setOnline(true);
      b.transport.setOnline(true);
      await net.settle();
      for (const d of [a, b]) expect([...d.vault.files.keys()]).toEqual(['f.bin']);
      for (const d of [a, b]) expect([...d.vault.files.get('f.bin')!.bytes]).toEqual([0, 1, 0xaa]);
      expect(conflictsOf(a, b)).toEqual([]);
    });
  });
});

describe('離線、重連、重啟', () => {
  it('離線累積多次修改：只送最後狀態，重連後補送', async () => {
    const { net, a, b } = await pair();
    await a.edit('n.md', 'v0');
    await net.settle();
    a.transport.setOnline(false);
    for (let i = 1; i <= 5; i += 1) await a.edit('n.md', `v${i}`);
    await a.edit('m.md', 'new');
    expect(a.sync.status().state).toBe('offline');
    expect(a.sync.status().queue).toBe(2); // n.md 的五次修改合成一筆
    const before = net.hub.sent;
    a.transport.setOnline(true);
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'n.md': 'v5', 'm.md': 'new' });
    expect(a.sync.status().state).toBe('idle');
    expect(net.hub.messages.slice(before).filter((m) => m.type === 'node')).toHaveLength(2);
  });

  it('重啟後佇列續傳（離線時累積、關掉、重開、上線）', async () => {
    const { net, a, b } = await pair();
    a.transport.setOnline(false);
    await a.edit('1.md', 'one');
    await a.edit('2.md', 'two');
    await a.restart();
    expect(a.sync.status().queue).toBe(2);
    a.transport.setOnline(true);
    await net.settle();
    expect(b.vault.tree()).toEqual({ '1.md': 'one', '2.md': 'two' });
  });

  it('重啟後：索引與合併祖先都還在（重啟後的並發修改仍能三方合併）', async () => {
    const { net, a, b } = await pair();
    await a.edit('n.md', 'a\nb\nc');
    await net.settle();
    await a.restart();
    await b.restart();
    a.transport.setOnline(false);
    b.transport.setOnline(false);
    await a.edit('n.md', 'A\nb\nc');
    await b.edit('n.md', 'a\nb\nC');
    await a.restart();
    a.transport.setOnline(true);
    b.transport.setOnline(true);
    await net.settle();
    expect(a.vault.tree()).toEqual({ 'n.md': 'A\nb\nC' });
    expect(b.vault.tree()).toEqual({ 'n.md': 'A\nb\nC' });
  });

  it('離線期間（協調器沒在跑）的變更：啟動時全量掃描找出來（含改名偵測）', async () => {
    const { net, a, b } = await pair();
    await a.edit('keep.md', 'k');
    await a.edit('move.md', 'm');
    await a.edit('gone.md', 'g');
    await net.settle();
    await a.sync.stop();
    a.vault.userWrite('keep.md', 'k2');
    a.vault.userRename('move.md', 'moved/move.md');
    a.vault.userRemove('gone.md');
    a.vault.userWrite('fresh.md', 'f');
    b.vault.log.length = 0;
    await a.restart();
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'keep.md': 'k2', 'moved/move.md': 'm', 'fresh.md': 'f' });
    expect(b.vault.log).toContain('rename move.md -> moved/move.md');
  });

  it('送出失敗時退避重試', async () => {
    const net = new Net();
    const a = await net.add('a', { options: { retryInitialMs: 100, retryMaxMs: 400 } });
    const b = await net.add('b');
    let failures = 3;
    const send = a.transport.send.bind(a.transport);
    a.transport.send = async (m) => {
      if (m.type === 'node' && failures > 0) {
        failures -= 1;
        throw new Error('中繼拒絕');
      }
      return send(m);
    };
    const states: string[] = [];
    a.sync.on('status', (s) => states.push(s.state));
    await a.edit('r.md', 'retry');
    await net.settle();
    expect(b.vault.get('r.md')).toBe('retry');
    expect(states).toContain('error');
    expect(a.sync.status().state).toBe('idle');
  });

  it('沉睡裝置（離線超過 30 天）：暫停合併與送出，使用者確認後才繼續', async () => {
    const { net, a, b } = await pair();
    await a.edit('n.md', 'x');
    await net.settle();
    await b.sync.stop();
    await net.clock.advance(31 * 86_400_000);
    await b.restart();
    expect(b.sync.status()).toMatchObject({ state: 'paused', pausedReason: 'stale-device' });
    await a.edit('n.md', 'y');
    await net.settle();
    expect(b.vault.get('n.md')).toBe('x');
    await b.sync.confirmStaleResume();
    await net.settle();
    expect(b.vault.get('n.md')).toBe('y');
  });
});

describe('回環抑制與冪等', () => {
  it('套用遠端寫入後，外掛通知的變更不會再被送出', async () => {
    const { net, a, b } = await pair();
    b.sync.on('applied', (change) => {
      // 模擬 Obsidian：寫入後觸發 modify／create／rename／delete 事件
      if (change.type === 'rename') void b.sync.notifyLocalChange(change.to, 'rename', change.from);
      else void b.sync.notifyLocalChange(change.path, change.type === 'remove' ? 'delete' : 'modify');
    });
    await a.edit('l.md', 'one');
    await net.settle();
    await a.rename('l.md', 'm.md');
    await net.settle();
    await a.edit('m.md', 'two');
    await net.settle();
    await a.remove('m.md');
    await net.settle();
    const fromB = net.hub.messages.filter((m) => m.from === 'b' && m.type === 'node');
    expect(fromB).toEqual([]);
    await b.sync.scan();
    await net.settle();
    expect(net.hub.messages.filter((m) => m.from === 'b' && m.type === 'node')).toEqual([]);
  });

  it('重複與亂序的訊息：結果相同、沒有多餘的寫入', async () => {
    const net = new Net({ maxDelayMs: 500, duplicateRate: 1, seed: 3 });
    const a = await net.add('a');
    const b = await net.add('b', { online: false });
    await a.edit('o.md', '1');
    await a.edit('o.md', '1\n2');
    await a.edit('o.md', '1\n2\n3');
    await a.rename('o.md', 'p.md');
    await a.edit('q.md', 'q');
    await net.settle();
    b.transport.setOnline(true);
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'p.md': '1\n2\n3', 'q.md': 'q' });
    expect(b.sync.status()).toMatchObject({ waiting: 0, conflicts: [] });
    // 再把所有訊息重放一次：什麼都不變
    const log = b.vault.log.length;
    b.transport.delivered.clear();
    b.transport.setOnline(false);
    b.transport.setOnline(true);
    await net.settle();
    expect(b.vault.log.length).toBe(log);
    expect(b.vault.tree()).toEqual({ 'p.md': '1\n2\n3', 'q.md': 'q' });
  });

  it('子版本先到、父版本後到：先等著，到齊後依序套用', async () => {
    const net = new Net({ roundTrip: true });
    const a = await net.add('a');
    const b = await net.add('b', { online: false });
    await a.edit('c.md', 'v1');
    await net.settle();
    await a.edit('c.md', 'v2');
    await net.settle();
    const [first, second] = net.hub.messages.filter((m) => m.type === 'node');
    // 手動投遞：先送 v2 再送 v1
    b.transport.online = true;
    b.transport.deliver(second!);
    await b.sync.idle();
    expect(b.sync.status().waiting).toBe(1);
    expect(b.vault.files.has('c.md')).toBe(false);
    b.transport.deliver(first!);
    await b.sync.idle();
    expect(b.sync.status().waiting).toBe(0);
    expect(b.vault.get('c.md')).toBe('v2');
  });
});

describe('不無聲覆蓋', () => {
  it('寫入前使用者剛好改了檔案（前置條件不符）：先收成本機版本再合併，使用者的內容保留', async () => {
    const { net, a, b } = await pair();
    await a.edit('race.md', 'l1\nl2\nl3');
    await net.settle();
    let injected = false;
    b.vault.beforeGuardedOp = (path) => {
      if (path === 'race.md' && !injected) {
        injected = true;
        b.vault.userWrite('race.md', 'l1\nl2\nl3 (B 剛打的字)');
      }
    };
    await a.edit('race.md', 'l1 (A)\nl2\nl3');
    await net.settle();
    expect(b.vault.get('race.md')).toBe('l1 (A)\nl2\nl3 (B 剛打的字)');
    expect(a.vault.get('race.md')).toBe('l1 (A)\nl2\nl3 (B 剛打的字)');
  });

  it('遠端要建立的路徑上已經有一個還沒同步的本機檔案：不覆蓋，改走路徑相撞', async () => {
    const { net, a, b } = await pair();
    b.vault.userWrite('same.md', 'B 的本機檔案（還沒通知協調器）');
    await a.edit('same.md', 'A 的檔案');
    await net.settle();
    await b.sync.scan();
    await net.settle();
    const contents = Object.values(b.vault.tree()).sort();
    expect(contents).toEqual(['A 的檔案', 'B 的本機檔案（還沒通知協調器）']);
    expect(a.vault.tree()).toEqual(b.vault.tree());
  });

  it('applyRemote：由外掛自己執行遠端變更', async () => {
    const net = new Net();
    const a = await net.add('a');
    const seen: VaultRemoteChange['type'][] = [];
    const vault = new MemoryVault();
    const b = await net.add('b', {
      vault,
      options: {
        applyRemote: async (change) => {
          seen.push(change.type);
          if (change.type === 'write') return vault.write(change.path, change.bytes, change.expect);
          if (change.type === 'remove') return vault.remove(change.path, change.expect);
          return vault.rename(change.from, change.to, change.expect);
        },
      },
    });
    await a.edit('x.md', '1');
    await net.settle();
    await a.rename('x.md', 'y.md');
    await net.settle();
    await a.remove('y.md');
    await net.settle();
    expect(seen).toEqual(['write', 'rename', 'remove']);
    expect(b.vault.tree()).toEqual({});
  });
});

describe('大檔（第 3 批才做 P2P）', () => {
  it('超過檔案塊層上限：只同步中繼資料，標記「待 P2P」、發事件，supplyContent 後寫入', async () => {
    const { net, a, b } = await pair();
    const big = new Uint8Array(FILE_TIER_MAX_BYTES + 1).fill(7);
    const pending: string[] = [];
    b.sync.on('pending', (p) => pending.push(`${p.path}:${p.via}`));
    await a.edit('video.mp4', big);
    await net.settle();
    const node = net.hub.messages.find((m) => m.type === 'node');
    expect(node).toMatchObject({ type: 'node', node: { p2p: true } });
    expect(node && 'content' in node ? node.content : undefined).toBeUndefined();
    expect(b.vault.files.has('video.mp4')).toBe(false);
    expect(pending).toEqual(['video.mp4:p2p']);
    expect(b.sync.status().pending).toHaveLength(1);
    const { fileId, versionId } = b.sync.status().pending[0]!;
    const bytes = await a.sync.readVersionContent(fileId, versionId);
    expect(bytes?.length).toBe(big.length);
    await expect(b.sync.supplyContent(fileId, versionId, new Uint8Array(3))).rejects.toThrow('雜湊不符');
    await b.sync.supplyContent(fileId, versionId, bytes!);
    expect(b.vault.files.get('video.mp4')?.bytes.length).toBe(big.length);
    expect(b.sync.status().pending).toEqual([]);
  });
});

describe('自我審查補的洞', () => {
  it('start() 之前就收到的通知：等狀態讀回後才處理，不會對既有檔案重複建檔', async () => {
    const { net, a, b } = await pair();
    await a.edit('x.md', 'x');
    await net.settle();
    await a.sync.stop();
    const { VaultSyncCoordinator: Coordinator } = await import('../../../src/sync/vault/index.js');
    const early = new Coordinator({ adapter: a.vault, store: a.store, transport: a.transport, deviceId: 'a', clock: net.clock, tickMs: 0, scanOnStart: false });
    const pending = early.notifyLocalChange('x.md', 'modify');
    await early.start();
    await pending;
    expect(early.index()).toHaveLength(1);
    expect(early.status().queue).toBe(0);
    await early.stop();
    expect(b.vault.tree()).toEqual({ 'x.md': 'x' });
  });

  it('自訂傳輸層交來的訊息也會驗證：危險路徑直接丟掉、回報錯誤', async () => {
    const { a, b } = await pair({ roundTrip: false });
    const errors: string[] = [];
    b.sync.on('error', (e) => errors.push(e.context));
    b.transport.deliver({
      type: 'node',
      from: 'a',
      fileId: 'f'.repeat(32),
      node: { id: 'e'.repeat(32), parents: [], path: '../escape.md', pathAt: 1, deleted: true, hash: '', size: 0, text: false, at: 1, device: 'a', label: 'A', p2p: false },
    });
    await b.sync.idle();
    expect(errors).toEqual(['invalid-message']);
    expect(b.vault.tree()).toEqual({});
    void a;
  });

  it('送出失敗過的版本不再被本機編輯合併掉（可能已經有裝置收到）', async () => {
    const net = new Net();
    const a = await net.add('a', { options: { retryInitialMs: 50 } });
    const b = await net.add('b');
    let fail = 1;
    const send = a.transport.send.bind(a.transport);
    a.transport.send = async (m) => {
      if (m.type === 'node' && fail > 0) {
        fail -= 1;
        await send(m); // 其實送到了……
        throw new Error('其中一座中繼拒絕'); // ……但回報失敗
      }
      return send(m);
    };
    await a.edit('n.md', '1\n2');
    await a.edit('n.md', '1\n2\n3');
    expect(a.sync.status().queue).toBe(2);
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'n.md': '1\n2\n3' });
    expect(a.vault.tree()).toEqual(b.vault.tree());
    expect(conflictsOf(a, b)).toEqual([]);
  });

  it('轉接器一直拒絕寫入：不空轉，回報錯誤，背景維護時再試', async () => {
    const { net, a, b } = await pair();
    const write = b.vault.write.bind(b.vault);
    let broken = true;
    let attempts = 0;
    b.vault.write = async (path, bytes, expect) => {
      if (broken && path === 'stuck.md') {
        attempts += 1;
        return false;
      }
      return write(path, bytes, expect);
    };
    const errors: string[] = [];
    b.sync.on('error', (e) => errors.push(e.context));
    await a.edit('stuck.md', 's');
    await net.settle();
    expect(errors).toContain('converge');
    expect(attempts).toBeLessThan(20);
    broken = false;
    await b.sync.tick();
    await net.settle();
    expect(b.vault.get('stuck.md')).toBe('s');
  });

  it('一直在線但沒有任何變更超過 30 天：不算沉睡裝置', async () => {
    const net = new Net({ options: { tickMs: 86_400_000 } });
    const a = await net.add('a');
    await a.edit('x.md', 'x');
    await net.clock.advance(31 * 86_400_000);
    await a.restart();
    expect(a.sync.status().state).not.toBe('paused');
    await a.sync.stop();
  });
});

describe('其他', () => {
  it('忽略的路徑不同步', async () => {
    const net = new Net({ options: { ignore: (p) => p.startsWith('.obsidian/') } });
    const a = await net.add('a');
    const b = await net.add('b');
    await a.edit('.obsidian/workspace.json', '{}');
    await a.edit('ok.md', 'ok');
    await net.settle();
    expect(b.vault.tree()).toEqual({ 'ok.md': 'ok' });
  });

  it('index()：路徑 → 版本；status 事件帶佇列長度', async () => {
    const { net, a } = await pair();
    const queues: number[] = [];
    a.sync.on('status', (s) => queues.push(s.queue));
    await a.edit('i.md', 'i');
    await net.settle();
    expect(a.sync.index()).toEqual([{ fileId: expect.stringMatching(/^[0-9a-f]{32}$/), path: 'i.md', versionId: expect.stringMatching(/^[0-9a-f]{32}$/), hash: expect.any(String), size: 1 }]);
    expect(queues).toContain(1);
    expect(queues.at(-1)).toBe(0);
  });

  it('新裝置加入：以摘要補齊既有檔案（中繼上的舊訊息已過期也行）', async () => {
    const net = new Net();
    const a = await net.add('a');
    await a.edit('old1.md', '1');
    await a.edit('old2.md', '2');
    await net.settle();
    // 新裝置只收得到之後的訊息：把中繼的舊紀錄標成已投遞，模擬過期
    const c = await net.add('c', { online: false });
    for (let i = 0; i < net.hub.messages.length; i += 1) c.transport.delivered.add(i);
    a.transport.setOnline(false);
    c.transport.setOnline(true);
    a.transport.setOnline(true); // a 重新上線時送摘要；c 的摘要讓 a 補送 c 沒有的檔案
    await net.settle();
    expect(c.vault.tree()).toEqual({ 'old1.md': '1', 'old2.md': '2' });
  });

  it('deviceId 格式檢查', () => {
    expect(
      () =>
        new VaultSyncCoordinator({
          adapter: new MemoryVault(),
          store: new MemorySyncStateStore(),
          transport: null as never,
          deviceId: 'bad id/',
        }),
    ).toThrow('deviceId');
  });

  it('本機編輯產生的內容與文字判斷', async () => {
    const { net, a, b } = await pair();
    await a.edit('t.md', text('é\n'));
    await net.settle();
    const node = net.hub.messages.find((m) => m.type === 'node');
    expect(node).toMatchObject({ node: { text: true } });
    expect(b.vault.get('t.md')).toBe('é\n');
  });
});
