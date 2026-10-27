// 版本圖與確定性合併（SDK ADR 0025 §2、§4）。
import { describe, expect, it } from 'vitest';

import { bestCommonAncestor, ancestorsOf, computeHeads, deterministicId, planMerge, sha256Hex } from '../../../src/sync/vault/graph.js';
import type { VaultVersion } from '../../../src/sync/vault/types.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
let counter = 0;
const id = () => (++counter).toString(16).padStart(32, '0');

function v(parents: VaultVersion[], over: Partial<VaultVersion> & { content?: string; bytes?: Uint8Array } = {}): VaultVersion & { bytes?: Uint8Array } {
  const bytes = over.bytes ?? (over.content !== undefined ? enc.encode(over.content) : undefined);
  const deleted = over.deleted ?? false;
  const base = parents[0];
  return {
    id: over.id ?? id(),
    parents: parents.map((p) => p.id),
    path: over.path ?? base?.path ?? 'a.md',
    pathAt: over.pathAt ?? base?.pathAt ?? 1,
    deleted,
    hash: deleted ? '' : bytes ? sha256Hex(bytes) : base!.hash,
    size: deleted ? 0 : (bytes?.length ?? base!.size),
    text: over.text ?? true,
    at: over.at ?? Math.max(0, ...parents.map((p) => p.at)) + 1,
    device: over.device ?? 'd',
    label: over.label ?? 'D',
    p2p: false,
    ...(bytes ? { bytes } : {}),
  };
}

function world(...versions: (VaultVersion & { bytes?: Uint8Array })[]) {
  const nodes = Object.fromEntries(versions.map(({ bytes: _b, ...n }) => [n.id, n]));
  const contents = new Map<string, Uint8Array>();
  for (const x of versions) if (x.bytes) contents.set(x.hash, x.bytes);
  return { nodes, content: (hash: string) => contents.get(hash) };
}

describe('版本圖', () => {
  it('版本頭、祖先、最佳共同祖先', () => {
    const o = v([], { content: 'o' });
    const a = v([o], { content: 'a', device: 'a' });
    const b = v([o], { content: 'b', device: 'b' });
    const { nodes } = world(o, a, b);
    expect(computeHeads(nodes).sort()).toEqual([a.id, b.id].sort());
    expect(ancestorsOf(nodes, a.id)).toEqual(new Set([a.id, o.id]));
    expect(bestCommonAncestor(nodes, ancestorsOf(nodes, a.id), ancestorsOf(nodes, b.id))).toBe(o.id);
  });

  it('涵蓋規則：已被更完整的合併涵蓋的合併版本不算版本頭；互相涵蓋時留 id 小的', () => {
    const o = v([], { content: 'o' });
    const a = v([o], { content: 'a' });
    const b = v([o], { content: 'b' });
    const c = v([o], { content: 'c' });
    const mab = v([a, b], { content: 'ab', id: 'f'.repeat(32) });
    const mac = v([a, c], { content: 'ac' });
    const mabc1 = v([mac, b], { content: 'abc', id: 'e'.repeat(32) });
    const mabc2 = v([mac, b], { content: 'abc2', id: 'd'.repeat(32) });
    expect(computeHeads(world(o, a, b, c, mab, mac, mabc1).nodes)).toEqual([mabc1.id]);
    expect(computeHeads(world(o, a, b, c, mab, mac, mabc1, mabc2).nodes)).toEqual([mabc2.id]);
    // 真正的修改不會被涵蓋掉
    const edit = v([a], { content: 'a2' });
    expect(computeHeads(world(o, a, b, c, mab, mac, mabc1, edit).nodes).sort()).toEqual([mabc1.id, edit.id].sort());
  });
});

describe('planMerge', () => {
  it('文字檔不同段落 → merge3 乾淨合併；id 由內容決定（兩台算出同一個）', () => {
    const o = v([], { content: '1\n2\n3' });
    const a = v([o], { content: 'A\n2\n3', device: 'a' });
    const b = v([o], { content: '1\n2\nB', device: 'b' });
    const w = world(o, a, b);
    const plan = planMerge(w.nodes, computeHeads(w.nodes), w.content);
    expect(dec.decode(plan.bytes)).toBe('A\n2\nB');
    expect(plan.copies).toEqual([]);
    expect(plan.version.parents).toEqual([a.id, b.id].sort());
    const again = planMerge(w.nodes, [b.id, a.id].sort(), w.content);
    expect(again.version.id).toBe(plan.version.id);
  });

  it('同一行衝突 → 較晚的留主檔，另一方完整內容成為副本', () => {
    const o = v([], { content: 'x' });
    const a = v([o], { content: 'xa', at: 10, device: 'a' });
    const b = v([o], { content: 'xb', at: 20, device: 'b' });
    const w = world(o, a, b);
    const plan = planMerge(w.nodes, computeHeads(w.nodes), w.content);
    expect(dec.decode(plan.bytes)).toBe('xb');
    expect(plan.copies.map((c) => dec.decode(c.bytes))).toEqual(['xa']);
    expect(plan.notes).toEqual([{ kind: 'text', copyIndex: 0 }]);
  });

  it('找不到共同祖先的內容 → 不猜，改走衝突副本', () => {
    const o = v([], { content: 'x' });
    const a = v([o], { content: 'xa\n' });
    const b = v([o], { content: 'x\nb' });
    const nodes = world(o, a, b).nodes;
    const contents = new Map([
      [a.hash, a.bytes!],
      [b.hash, b.bytes!],
    ]);
    const plan = planMerge(nodes, computeHeads(nodes), (h) => contents.get(h));
    expect(plan.copies).toHaveLength(1);
  });

  it('二進位兩邊都改 → 衝突副本', () => {
    const o = v([], { bytes: new Uint8Array([1]), text: false, path: 'f.bin' });
    const a = v([o], { bytes: new Uint8Array([2]), text: false });
    const b = v([o], { bytes: new Uint8Array([3]), text: false });
    const w = world(o, a, b);
    const plan = planMerge(w.nodes, computeHeads(w.nodes), w.content);
    expect(plan.copies).toHaveLength(1);
    expect(plan.notes[0]!.kind).toBe('binary');
  });

  it('一刪一改內容 → 保留修改；一刪一只改名 → 刪除', () => {
    const o = v([], { content: 'x' });
    const del = v([o], { deleted: true });
    const mod = v([o], { content: 'x2' });
    let w = world(o, del, mod);
    let plan = planMerge(w.nodes, computeHeads(w.nodes), w.content);
    expect(plan.version.deleted).toBe(false);
    expect(dec.decode(plan.bytes)).toBe('x2');
    expect(plan.notes).toEqual([{ kind: 'delete-modify' }]);

    const moved = v([o], { path: 'moved.md', pathAt: 5 });
    w = world(o, del, moved);
    plan = planMerge(w.nodes, computeHeads(w.nodes), w.content);
    expect(plan.version.deleted).toBe(true);
  });

  it('改名＋修改：路徑取改名那邊、內容取修改那邊', () => {
    const o = v([], { content: 'x', path: 'old.md' });
    const renamed = v([o], { path: 'new.md', pathAt: 9 });
    const edited = v([o], { content: 'x2' });
    const w = world(o, renamed, edited);
    const plan = planMerge(w.nodes, computeHeads(w.nodes), w.content);
    expect(plan.version.path).toBe('new.md');
    expect(dec.decode(plan.bytes)).toBe('x2');
    expect(plan.notes).toEqual([]);
  });

  it('兩邊改成不同名字 → 取較晚的，記 rename-rename', () => {
    const o = v([], { content: 'x', path: 'o.md' });
    const a = v([o], { path: 'a.md', at: 5 });
    const b = v([o], { path: 'b.md', at: 6 });
    const w = world(o, a, b);
    const plan = planMerge(w.nodes, computeHeads(w.nodes), w.content);
    expect(plan.version.path).toBe('b.md');
    expect(plan.notes).toEqual([{ kind: 'rename-rename', otherPath: 'a.md' }]);
  });

  it('三個版本頭：依序合併，每個版本的修改都在（主檔或副本）', () => {
    const o = v([], { content: '1\n2\n3\n4\n5' });
    const a = v([o], { content: 'A\n2\n3\n4\n5', at: 3 });
    const b = v([o], { content: '1\n2\nB\n4\n5', at: 4 });
    const c = v([o], { content: '1\n2\n3\n4\nC', at: 5 });
    const w = world(o, a, b, c);
    const plan = planMerge(w.nodes, computeHeads(w.nodes), w.content);
    expect(dec.decode(plan.bytes)).toBe('A\n2\nB\n4\nC');
  });

  it('deterministicId 穩定', () => {
    expect(deterministicId('x', 'y')).toBe(deterministicId('x', 'y'));
    expect(deterministicId('x', 'y')).not.toBe(deterministicId('xy'));
    expect(deterministicId('a')).toMatch(/^[0-9a-f]{32}$/);
  });
});
