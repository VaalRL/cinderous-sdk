// 版本歷史的純函式（SDK ADR 0063）：稀疏化與保留、容量上限、整個 Vault 回到時間點的預覽。
import { describe, expect, it } from 'vitest';

import {
  type ArchivedFile,
  type ArchivedVersion,
  buildRestorePlan,
  type CheckpointFile,
  type CurrentFile,
  decodeManifest,
  diffManifest,
  type EncodedManifest,
  encodeManifest,
  fileStateAt,
  isEmptyDiff,
  overByteBudget,
  thinHistory,
} from '../../../src/sync/vault/history.js';
import { rng } from './harness.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 2026-10-08 12:00 UTC */
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const OPTS = { keepDays: 30, maxVersions: 100 };

let seq = 0;
function v(at: number, extra: Partial<ArchivedVersion> = {}): ArchivedVersion {
  seq += 1;
  return {
    at,
    n: seq,
    versionId: `v${seq}`,
    path: 'a.md',
    device: 'd',
    label: 'D',
    hash: `h${seq}`,
    size: 10,
    deleted: false,
    text: true,
    content: true,
    ...extra,
  };
}

const ids = (xs: readonly { versionId: string }[]) => xs.map((x) => x.versionId);

describe('thinHistory：1 小時全留、1 天每小時一版、之後每天一版（裁示 3）', () => {
  it('1 小時內全留', () => {
    const entries = [v(NOW - 59 * MIN), v(NOW - 30 * MIN), v(NOW - 30 * MIN), v(NOW - 1)];
    const { keep, drop, cut } = thinHistory(entries, NOW, OPTS);
    expect(ids(keep)).toEqual(ids(entries));
    expect(drop).toEqual([]);
    expect(cut).toBeUndefined();
  });

  it('1 天內每個小時留最新的一版；1 小時內那一版所在的小時不再另留', () => {
    // 10:05、10:40、10:55（同一個小時）、09:10、09:50（同一個小時），11:30（1 小時內）
    const a = v(Date.UTC(2026, 9, 8, 10, 5));
    const b = v(Date.UTC(2026, 9, 8, 10, 40));
    const c = v(Date.UTC(2026, 9, 8, 10, 55));
    const d = v(Date.UTC(2026, 9, 8, 9, 10));
    const e = v(Date.UTC(2026, 9, 8, 9, 50));
    const f = v(Date.UTC(2026, 9, 8, 11, 30));
    const g = v(Date.UTC(2026, 9, 8, 11, 10)); // 現在 12:20：11:10 在 1 小時外，但同一個小時有 11:30（1 小時內）
    const { keep } = thinHistory([a, b, c, d, e, f, g], NOW + 20 * MIN, { ...OPTS, offset: () => 0 });
    expect(ids(keep)).toEqual(ids([e, c, f]));
  });

  it('超過 1 天：每個日期留最新的一版；超過保留天數的清掉並記下 cut', () => {
    const day = (d: number, h: number) => Date.UTC(2026, 9, 8 - d, h, 0);
    const old1 = v(day(40, 3));
    const old2 = v(day(31, 23));
    const d5a = v(day(5, 1));
    const d5b = v(day(5, 22));
    const d2a = v(day(2, 8));
    const d2b = v(day(2, 9));
    const latest = v(NOW - 2 * HOUR);
    const { keep, drop, cut } = thinHistory([old1, old2, d5a, d5b, d2a, d2b, latest], NOW, { ...OPTS, offset: () => 0 });
    expect(ids(keep)).toEqual(ids([d5b, d2b, latest]));
    expect(new Set(ids(drop))).toEqual(new Set(ids([old1, old2, d5a, d2a])));
    expect(cut).toBe(old2.at);
  });

  it('日期界線依 offset（當地日期）：UTC+8 的 07:00 與 09:00 是同一天、UTC 不是', () => {
    // UTC 前一天 23:00 與當天 01:00（台灣都是當天 07:00、09:00）
    const x = v(Date.UTC(2026, 9, 4, 23, 0));
    const y = v(Date.UTC(2026, 9, 5, 1, 0));
    const latest = v(NOW);
    expect(ids(thinHistory([x, y, latest], NOW, { ...OPTS, offset: () => 0 }).keep)).toEqual(ids([x, y, latest]));
    expect(ids(thinHistory([x, y, latest], NOW, { ...OPTS, offset: () => 8 * HOUR }).keep)).toEqual(ids([y, latest]));
  });

  it('最新的一版一律留下（超過保留天數也留）；最新的一版是刪除而且超過保留天數 → 整個清掉', () => {
    const old = v(NOW - 400 * DAY);
    expect(ids(thinHistory([v(NOW - 500 * DAY), old], NOW, OPTS).keep)).toEqual([old.versionId]);
    const created = v(NOW - 60 * DAY);
    const del = v(NOW - 31 * DAY, { deleted: true, hash: '', content: false });
    const result = thinHistory([created, del], NOW, OPTS);
    expect(result.keep).toEqual([]);
    expect(result.drop).toHaveLength(2);
    // 刪除還在保留期內：留著（「最近刪除的檔案」看得到）
    const recent = v(NOW - 29 * DAY, { deleted: true, hash: '', content: false });
    expect(ids(thinHistory([created, recent], NOW, OPTS).keep)).toEqual([recent.versionId]);
  });

  it('刪除不佔區段：同一天裡刪除之前的最後一版照留（最近刪除的檔案還原得回來）', () => {
    const created = v(NOW - 5 * DAY);
    const edited = v(NOW - 5 * DAY + 10 * MIN);
    const del = v(NOW - 5 * DAY + 20 * MIN, { deleted: true, hash: '', content: false });
    expect(ids(thinHistory([created, edited, del], NOW, OPTS).keep)).toEqual(ids([edited, del]));
  });

  it('同一個時間的版本以歸檔序號分先後（合併版本的時間等於父版本）', () => {
    const t = NOW - 3 * HOUR;
    const parent = v(t);
    const merge = v(t);
    expect(ids(thinHistory([merge, parent, v(NOW)], NOW, OPTS).keep)[0]).toBe(merge.versionId);
  });

  it('版本數上限：稀疏化後從最舊的清（記 cut），最新的不清', () => {
    const entries = Array.from({ length: 10 }, (_, i) => v(NOW - (10 - i) * MIN));
    const { keep, drop, cut } = thinHistory(entries, NOW, { ...OPTS, maxVersions: 3 });
    expect(ids(keep)).toEqual(ids(entries.slice(-3)));
    expect(drop).toHaveLength(7);
    expect(cut).toBe(entries[6]!.at);
    expect(thinHistory(entries, NOW, { ...OPTS, maxVersions: 0 }).keep).toHaveLength(1);
  });

  it('保留天數 Infinity：不因天數清（仍然稀疏化）', () => {
    const a = v(NOW - 3000 * DAY);
    const b = v(NOW - 3000 * DAY + HOUR);
    const latest = v(NOW);
    const { keep, cut } = thinHistory([a, b, latest], NOW, { keepDays: Infinity, maxVersions: Infinity });
    expect(ids(keep)).toEqual(ids([b, latest]));
    expect(cut).toBeUndefined();
  });

  it('性質：隔一段時間再做一次，結果和一次做到那個時間相同（不含版本數上限）', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const random = rng(seed);
      const entries: ArchivedVersion[] = [];
      for (let i = 0; i < 80; i += 1) entries.push(v(NOW - Math.floor(random() ** 3 * 40 * DAY), { deleted: random() < 0.05 }));
      const opts = { keepDays: 30, maxVersions: Infinity, offset: (at: number) => ((at / DAY) % 2 < 1 ? 8 * HOUR : 9 * HOUR) };
      const t1 = NOW + Math.floor(random() * 3 * DAY);
      const t2 = t1 + Math.floor(random() * 5 * DAY);
      const once = thinHistory(entries, t2, opts).keep;
      const twice = thinHistory(thinHistory(entries, t1, opts).keep, t2, opts).keep;
      expect(ids(twice), `seed ${seed}`).toEqual(ids(once));
    }
  });
});

describe('overByteBudget：超過容量上限從最舊的清，每個檔案至少留一版', () => {
  const sizes = new Map<string, number>();
  const sizeOf = (h: string) => sizes.get(h) ?? 0;

  it('沒超過：不清', () => {
    sizes.set('x', 10);
    expect(overByteBudget(new Map([['f', [v(1, { hash: 'x' })]]]), sizeOf, 10)).toEqual([]);
  });

  it('從最舊的清；同一份內容（去重）要全部清掉才省下；每個檔案最新的一版不清；沒有內容的不清', () => {
    for (const h of ['a', 'b', 'c', 'd', 'e']) sizes.set(h, 100);
    const f1 = [v(1, { hash: 'a' }), v(2, { hash: 'b' }), v(9, { hash: 'c' })];
    const f2 = [v(3, { hash: 'a' }), v(4, { hash: 'bin', content: false, text: false }), v(5, { hash: 'd' })];
    const f3 = [v(0, { hash: 'e' })];
    // 總共 a b c d e＝500；上限 300：清 f1@1（a 還被 f2@3 用）、f1@2（b，省 100）、f2@3（a，省 100）
    const out = overByteBudget(new Map([['f1', f1], ['f2', f2], ['f3', f3]]), sizeOf, 300);
    expect(out.map((o) => `${o.fileId}:${o.entry.hash}`)).toEqual(['f1:a', 'f1:b', 'f2:a']);
    // 上限 0：清到每個檔案只剩最新的一版（沒有內容的那一版不清）
    const all = overByteBudget(new Map([['f1', f1], ['f2', f2], ['f3', f3]]), sizeOf, 0);
    expect(all.map((o) => `${o.fileId}:${o.entry.hash}`)).toEqual(['f1:a', 'f1:b', 'f2:a']);
  });
});

describe('fileStateAt 與 buildRestorePlan（裁示 6）', () => {
  const file = (fileId: string, entries: ArchivedVersion[], born?: number): ArchivedFile => ({ fileId, entries, ...(born !== undefined ? { born } : {}) });

  it('fileStateAt：at ≤ T 的最後一版；刪除或 T 在建立之前＝不存在；更早的被清掉＝不知道', () => {
    const a = v(100);
    const b = v(200, { path: 'b.md' });
    const del = v(300, { deleted: true });
    const f = file('f', [a, b, del], 100);
    expect(fileStateAt(f, 50)).toEqual({ known: true, entry: null });
    expect(fileStateAt(f, 150)).toEqual({ known: true, entry: a });
    expect(fileStateAt(f, 250)).toEqual({ known: true, entry: b });
    expect(fileStateAt(f, 300)).toEqual({ known: true, entry: null });
    expect(fileStateAt(file('g', [b]), 150)).toEqual({ known: false });
  });

  it('四類：改回（內容、改名）、復原、T 之後建立的（預設不刪）、無法還原', () => {
    const T = 1000;
    const edited = file('edited', [v(100, { path: 'e.md', hash: 'e1' }), v(2000, { path: 'e.md', hash: 'e2' })], 100);
    const renamed = file('renamed', [v(100, { path: 'old.md', hash: 'r1' }), v(2000, { path: 'new.md', hash: 'r1' })], 100);
    const deleted = file('deleted', [v(100, { path: 'gone.md', hash: 'g1' }), v(2000, { path: 'gone.md', deleted: true, hash: '' })], 100);
    const created = file('created', [v(2000, { path: 'later.md', hash: 'l1' })], 2000);
    const binary = file('binary', [v(100, { path: 'p.png', hash: 'p1', text: false, content: false }), v(2000, { path: 'p.png', hash: 'p2', text: false, content: false })], 100);
    const binMoved = file('binMoved', [v(100, { path: 'q.png', hash: 'q1', text: false, content: false }), v(2000, { path: 'img/q.png', hash: 'q1', text: false, content: false })], 100);
    const unknown = file('unknown', [v(2000, { path: 'u.md', hash: 'u1' })]);
    const same = file('same', [v(100, { path: 's.md', hash: 's1' })], 100);
    const current = new Map<string, CurrentFile>([
      ['edited', { state: 'live', path: 'e.md', hash: 'e2', versionId: edited.entries[1]!.versionId }],
      ['renamed', { state: 'live', path: 'new.md', hash: 'r1', versionId: renamed.entries[1]!.versionId }],
      ['deleted', { state: 'gone' }],
      ['created', { state: 'live', path: 'later.md', hash: 'l1', versionId: created.entries[0]!.versionId }],
      ['binary', { state: 'live', path: 'p.png', hash: 'p2', versionId: binary.entries[1]!.versionId }],
      ['binMoved', { state: 'live', path: 'img/q.png', hash: 'q1', versionId: binMoved.entries[1]!.versionId }],
      ['unknown', { state: 'live', path: 'u.md', hash: 'u1', versionId: unknown.entries[0]!.versionId }],
      ['same', { state: 'live', path: 's.md', hash: 's1', versionId: same.entries[0]!.versionId }],
    ]);
    const archived = (h: string) => ['e1', 'e2', 'r1', 'g1', 'l1', 'u1', 's1'].includes(h);
    const files = [edited, renamed, deleted, created, binary, binMoved, unknown, same];
    const plan = buildRestorePlan(T, files, (id) => current.get(id)!, { archived, now: 5000 });
    expect(plan.at).toBe(T);
    expect(plan.createdAt).toBe(5000);
    expect(plan.revert.map((i) => [i.fileId, i.from, i.path, i.hash])).toEqual([
      ['edited', 'e.md', 'e.md', 'e1'],
      ['renamed', 'new.md', 'old.md', 'r1'],
      ['binMoved', 'img/q.png', 'q.png', 'q1'], // 二進位檔：內容相同，只改回路徑
    ]);
    expect(plan.undelete.map((i) => [i.fileId, i.path, i.hash])).toEqual([['deleted', 'gone.md', 'g1']]);
    expect(plan.remove).toEqual([]);
    expect(plan.unrestorable.map((i) => [i.fileId, i.reason])).toEqual([
      ['binary', 'binary'],
      ['unknown', 'out-of-range'],
    ]);
    // removeCreatedAfter：T 之後建立的刪掉；只限路徑
    const withRemove = buildRestorePlan(T, files, (id) => current.get(id)!, { archived, now: 5000, removeCreatedAfter: true });
    expect(withRemove.remove.map((i) => [i.fileId, i.path, i.hash])).toEqual([['created', 'later.md', 'l1']]);
    const only = buildRestorePlan(T, files, (id) => current.get(id)!, { archived, now: 5000, include: (p) => p.startsWith('old') || p === 'gone.md' });
    expect([...only.revert, ...only.undelete].map((i) => i.fileId)).toEqual(['renamed', 'deleted']);
    expect(only.unrestorable).toEqual([]);
  });

  it('安全：要覆寫或刪掉的現有內容不在歸檔就不做（二進位檔不刪）；內容不在這台、被排除的回報', () => {
    const T = 1000;
    const bin = file('bin', [v(2000, { path: 'x.bin', hash: 'b1', text: false, content: false })], 2000);
    const overwrite = file('ow', [v(100, { path: 'o.md', hash: 'o1' }), v(2000, { path: 'o.md', hash: 'o2' })], 100);
    const sparse = file('sp', [v(100, { path: 'far/s.md', hash: 's1' })], 100);
    const excl = file('ex', [v(100, { path: '.private/x.md', hash: 'x1' })], 100);
    const textMissing = file('tm', [v(100, { path: 't.md', hash: 't1', content: false }), v(2000, { path: 't.md', deleted: true, hash: '' })], 100);
    const current = new Map<string, CurrentFile>([
      ['bin', { state: 'live', path: 'x.bin', hash: 'b1', versionId: bin.entries[0]!.versionId }],
      ['ow', { state: 'live', path: 'o.md', hash: 'o2', versionId: overwrite.entries[1]!.versionId }],
      ['sp', { state: 'not-local', path: 'far/s.md', reason: 'not-local' }],
      ['ex', { state: 'live', path: '.private/x.md', hash: 'x1', versionId: excl.entries[0]!.versionId }],
      ['tm', { state: 'gone' }],
    ]);
    const plan = buildRestorePlan(T, [bin, overwrite, sparse, excl, textMissing], (id) => current.get(id)!, {
      archived: (h) => h === 'o1' || h === 's1',
      excluded: (p) => p.startsWith('.private/'),
      now: 0,
      removeCreatedAfter: true,
    });
    expect([plan.revert, plan.undelete, plan.remove]).toEqual([[], [], []]);
    expect(plan.unrestorable.map((i) => [i.fileId, i.reason])).toEqual([
      ['ex', 'excluded'],
      ['sp', 'not-local'],
      ['ow', 'content-missing'],
      ['tm', 'content-missing'],
      ['bin', 'binary'],
    ]);
    expect(plan.irreversibleBytes).toBe(0);
  });

  it('removeCreatedBinaries（v0.50 裁示 1 乙）：T 之後建立的二進位檔列入刪除、標 irreversible，附總大小；只在 removeCreatedAfter 打開時有效', () => {
    const T = 1000;
    const bin = file('bin', [v(2000, { path: 'x.bin', hash: 'b1', size: 300, text: false, content: false })], 2000);
    const bin2 = file('bin2', [v(2500, { path: 'y.png', hash: 'b2', size: 200, text: false, content: false })], 2500);
    const textNew = file('txt', [v(2000, { path: 'n.md', hash: 't1' })], 2000);
    const textMissing = file('tm', [v(2000, { path: 'm.md', hash: 't2', content: false })], 2000);
    const current = new Map<string, CurrentFile>([
      // 現在的版本資訊（大小、是不是文字檔）由 current 提供：協調器不必為了預覽讀完整的歸檔
      ['bin', { state: 'live', path: 'x.bin', hash: 'b1', versionId: 'cur-bin', text: false, size: 300 }],
      ['bin2', { state: 'live', path: 'y.png', hash: 'b2', versionId: bin2.entries[0]!.versionId }],
      ['txt', { state: 'live', path: 'n.md', hash: 't1', versionId: textNew.entries[0]!.versionId }],
      ['tm', { state: 'live', path: 'm.md', hash: 't2', versionId: textMissing.entries[0]!.versionId, text: true, size: 9 }],
    ]);
    const files = [bin, bin2, textNew, textMissing];
    const archived = (h: string) => h === 't1';
    const plan = buildRestorePlan(T, files, (id) => current.get(id)!, { archived, now: 0, removeCreatedAfter: true, removeCreatedBinaries: true });
    expect(plan.remove.map((i) => [i.fileId, i.path, i.size, i.text, i.irreversible])).toEqual([
      ['txt', 'n.md', 10, true, undefined],
      ['bin', 'x.bin', 300, false, true],
      ['bin2', 'y.png', 200, false, true],
    ]);
    expect(plan.irreversibleBytes).toBe(500);
    // 文字檔的內容不在歸檔：照樣不刪（不是「二進位檔」）
    expect(plan.unrestorable.map((i) => [i.fileId, i.reason])).toEqual([['tm', 'content-missing']]);
    // removeCreatedAfter 沒打開：removeCreatedBinaries 沒有作用
    const off = buildRestorePlan(T, files, (id) => current.get(id)!, { archived, now: 0, removeCreatedBinaries: true });
    expect([off.remove, off.irreversibleBytes]).toEqual([[], 0]);
    // 預設（沒打開 removeCreatedBinaries）：二進位檔照舊回報 binary
    const def = buildRestorePlan(T, files, (id) => current.get(id)!, { archived, now: 0, removeCreatedAfter: true });
    expect(def.remove.map((i) => i.fileId)).toEqual(['txt']);
    expect(def.unrestorable.map((i) => [i.fileId, i.reason])).toEqual([
      ['tm', 'content-missing'],
      ['bin', 'binary'],
      ['bin2', 'binary'],
    ]);
  });
});

describe('檢查點清單的編碼（補充 1）', () => {
  const hex = (random: () => number, n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join('');
  function manifestOf(count: number, seed = 1): Map<string, CheckpointFile> {
    const random = rng(seed);
    const dirs = ['Daily/2026/10', 'Projects/Cinderous/notes', 'Inbox', 'Areas/健康', 'Resources/papers/crypto'];
    const out = new Map<string, CheckpointFile>();
    for (let i = 0; i < count; i += 1) {
      const dir = dirs[Math.floor(random() * dirs.length)]!;
      out.set(hex(random, 32), {
        path: `${dir}/筆記 ${i.toString().padStart(4, '0')}.md`,
        versionId: hex(random, 32),
        hash: hex(random, 64),
        size: Math.floor(random() * 50_000),
        text: random() < 0.9,
        local: random() < 0.95,
      });
    }
    return out;
  }

  it('完整清單：編碼再解回來一模一樣（含非 hex 的 id、中文路徑）', () => {
    const m = manifestOf(200);
    m.set('not-hex-id', { path: 'a/b.md', versionId: 'also-not-hex', hash: 'f'.repeat(64), size: 1, text: true, local: true });
    const encoded = JSON.parse(JSON.stringify(encodeManifest(m))) as EncodedManifest;
    expect(encoded.d).toBeUndefined();
    expect(decodeManifest(encoded)).toEqual(m);
  });

  it('差異：只記改了、新增、不在了的；套在前一個上得到下一個；沒有差異時是空的', () => {
    const prev = manifestOf(300, 2);
    const next = new Map(prev);
    const ids = [...prev.keys()];
    next.delete(ids[0]!);
    next.set(ids[1]!, { ...prev.get(ids[1]!)!, path: 'moved/elsewhere.md' });
    next.set(ids[2]!, { ...prev.get(ids[2]!)!, hash: 'a'.repeat(64), versionId: 'b'.repeat(32) });
    next.set('c'.repeat(32), { path: 'new.md', versionId: 'd'.repeat(32), hash: 'e'.repeat(64), size: 3, text: true, local: true });
    const diff = JSON.parse(JSON.stringify(diffManifest(prev, next))) as EncodedManifest;
    expect(diff.s).toHaveLength(3);
    expect(diff.d).toHaveLength(1);
    expect(isEmptyDiff(diff)).toBe(false);
    expect(decodeManifest(diff, prev)).toEqual(next);
    expect(prev.has(ids[0]!)).toBe(true); // 不改到 base
    expect(isEmptyDiff(diffManifest(next, new Map(next)))).toBe(true);
  });

  it('5,000 個檔案的完整清單在 600 KB 以內；改 10 個檔案的差異在 2 KB 以內', () => {
    const m = manifestOf(5000, 3);
    const full = JSON.stringify(encodeManifest(m)).length;
    const naive = JSON.stringify(Object.fromEntries(m)).length;
    expect(full).toBeLessThan(600 * 1024);
    expect(full).toBeLessThan(naive * 0.7);
    const next = new Map(m);
    for (const id of [...m.keys()].slice(0, 10)) next.set(id, { ...m.get(id)!, hash: 'a'.repeat(64) });
    expect(JSON.stringify(diffManifest(m, next)).length).toBeLessThan(2048);
  });
});
