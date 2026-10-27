// 送出端的中繼帳（SDK ADR 0068）：按收件人記帳、簽收扣帳、過期扣帳、等多久、持久化。
import { describe, expect, it } from 'vitest';

import { addRange, coversRange, RelayLedger } from '../../../src/sync/vault/relay-ledger.js';

const HOUR = 3_600_000;
const WINDOW = 7 * 24 * HOUR;

function ledger(start = 100 * HOUR) {
  let now = start;
  const l = new RelayLedger({ now: () => now, windowMs: () => WINDOW });
  return { l, advance: (ms: number) => (now += ms), at: () => now };
}

describe('序號區間', () => {
  it('addRange 合併相鄰與重疊；coversRange', () => {
    let r: Array<[number, number]> = [];
    for (const n of [5, 3, 4, 10, 1, 11, 2]) r = addRange(r, n, n);
    expect(r).toEqual([
      [1, 5],
      [10, 11],
    ]);
    r = addRange(r, 6, 9);
    expect(r).toEqual([[1, 11]]);
    expect([coversRange(r, 1), coversRange(r, 11), coversRange(r, 12), coversRange([], 1)]).toEqual([true, true, false, false]);
  });
});

describe('RelayLedger：按收件人記帳', () => {
  it('廣播的記在每一台；指定 to 的只記那幾台；簽收單劃掉那一台的帳，其他台不受影響', () => {
    const { l } = ledger();
    l.record({ rs: 1, f: 10 });
    l.record({ rs: 2, f: 5, to: ['b'] });
    l.record({ rs: 3, f: 7 });
    expect([l.used('a'), l.used('b')]).toEqual([17, 22]);
    l.receipt('a', [[1, 3]]);
    expect([l.used('a'), l.used('b')]).toEqual([0, 22]);
    l.receipt('b', [[2, 2]]);
    expect(l.used('b')).toBe(17);
  });

  it('沒有序號的（舊的帳、簽收單本身）簽收不掉，只會過期', () => {
    const { l, advance } = ledger();
    l.record({ rs: 0, f: 4 });
    l.receipt('a', [[0, 100]]);
    expect(l.used('a')).toBe(4);
    advance(WINDOW + HOUR);
    expect(l.used('a')).toBe(0);
  });

  it('過期：整小時都過了保存期才劃掉（寧可多算）', () => {
    const { l, advance } = ledger();
    l.record({ rs: 1, f: 3 });
    advance(WINDOW);
    expect(l.used('a')).toBe(3);
    advance(HOUR);
    expect(l.used('a')).toBe(0);
  });

  it('wait：加上這一則超過預算時，算出最早什麼時候夠（依過期）；帳是空的一律放行', () => {
    const { l, advance } = ledger(100 * HOUR + 10);
    expect(l.wait('a', 1000, 10)).toBe(0);
    l.record({ rs: 1, f: 6 });
    advance(2 * HOUR);
    l.record({ rs: 2, f: 3 });
    expect(l.wait('a', 1, 10)).toBe(0);
    // 9 + 2 > 10：要等第一筆過期（第 100 小時那一筆）
    expect(l.wait('a', 2, 10)).toBe(101 * HOUR + WINDOW - (102 * HOUR + 10));
    l.receipt('a', [[1, 1]]);
    expect(l.wait('a', 2, 10)).toBe(0);
  });

  it('receipt 回傳這次新劃掉、帶版本的那幾筆（給「對方已收到」用）；重複的簽收單不重複回傳', () => {
    const { l } = ledger();
    l.record({ rs: 1, f: 1, v: [['f1', 'n1']] });
    l.record({ rs: 2, f: 1 });
    l.record({ rs: 3, f: 1, to: ['b'], v: [['f2', 'n2']] });
    expect(l.receipt('a', [[1, 3]])).toEqual([[['f1', 'n1']]]);
    expect(l.receipt('a', [[1, 3]])).toEqual([]);
    expect(l.receipt('b', [[3, 3]])).toEqual([[['f2', 'n2']]]);
  });

  it('usage：每位收件人一列，最滿的在前', () => {
    const { l } = ledger();
    l.record({ rs: 1, f: 2 });
    l.record({ rs: 2, f: 5, to: ['b'] });
    l.receipt('c', [[1, 1]]);
    expect(l.usage(['a', 'b', 'c'])).toEqual([
      { device: 'b', used: 7 },
      { device: 'a', used: 2 },
      { device: 'c', used: 0 },
    ]);
  });

  it('prune：過期的、每一台都簽收了的丟掉；用不到的簽收區間也縮掉', () => {
    const { l } = ledger();
    l.record({ rs: 1, f: 1 });
    l.record({ rs: 2, f: 1, to: ['a'] });
    l.record({ rs: 3, f: 1 });
    l.receipt('a', [[1, 3]]);
    l.prune(['a', 'b']);
    expect(l.toJSON().e.map((e) => e[0])).toEqual([1, 3]);
    l.receipt('b', [[1, 1]]);
    l.prune(['a', 'b']);
    expect(l.toJSON().e.map((e) => e[0])).toEqual([3]);
    expect(l.toJSON().k).toEqual({ a: [[3, 3]] });
  });

  it('持久化往返；舊版的 relayUse（[小時, 塊數]）轉成沒有序號的廣播帳；壞資料略過', () => {
    const { l, at } = ledger();
    l.record({ rs: 1, f: 2, to: ['b'], v: [['f', 'n']] });
    l.receipt('a', [[1, 1]]);
    const back = RelayLedger.parse(JSON.parse(JSON.stringify(l.toJSON())), { now: at, windowMs: () => WINDOW });
    expect([back.used('a'), back.used('b')]).toEqual([0, 2]);
    expect(back.toJSON()).toEqual(l.toJSON());
    const legacy = RelayLedger.parse(undefined, { now: at, windowMs: () => WINDOW }, [
      [100, 5],
      [101, 3],
    ]);
    expect([legacy.used('a'), legacy.used('zz')]).toEqual([8, 8]);
    const bad = RelayLedger.parse({ e: [[1, -1, 0], 'x', [2, 3, 100, ['b']]], k: { a: [[2, 1]], '': [[1, 1]] } }, { now: at, windowMs: () => WINDOW });
    expect(bad.toJSON()).toEqual({ e: [[2, 3, 100, ['b']]], k: {} });
  });

  it('上限：帳太多筆時，最舊的併成一筆沒有序號的廣播帳（只會多算、不會少算）', () => {
    const { l } = ledger();
    for (let i = 1; i <= 120; i += 1) l.record({ rs: i, f: 1, to: ['b'] });
    l.compact(100);
    const json = l.toJSON();
    expect(json.e.length).toBeLessThanOrEqual(100);
    expect(l.used('b')).toBe(120);
    expect(l.used('a')).toBeGreaterThan(0);
  });
});

describe('RelayLedger：新加入的收件人不算加入前的廣播（SDK ADR 0107）', () => {
  it('第一次 join：名單上的從 0 算（舊的廣播照算）；之後才出現的只算出現那個小時起的廣播，指定給它的照算', () => {
    const { l, advance } = ledger();
    l.record({ rs: 1, f: 10 });
    expect(l.join(['a'])).toBe(true);
    expect(l.used('a')).toBe(10);
    advance(HOUR);
    l.record({ rs: 2, f: 5 });
    l.record({ rs: 3, f: 2, to: ['c'] });
    advance(HOUR);
    expect(l.join(['a', 'c'])).toBe(true);
    expect(l.join(['a', 'c'])).toBe(false);
    expect([l.used('a'), l.used('c')]).toEqual([15, 2]);
    l.record({ rs: 4, f: 3 });
    expect([l.used('a'), l.used('c')]).toEqual([18, 5]);
    expect(l.usage(['a', 'c'])).toEqual([
      { device: 'a', used: 18 },
      { device: 'c', used: 5 },
    ]);
    // 同一個小時裡、加入之前的廣播照算（寧可多算）
    l.record({ rs: 5, f: 1 });
    expect(l.join(['a', 'c', 'd'])).toBe(true);
    expect(l.used('d')).toBe(4);
  });

  it('wait 也照這個算：新加入的不必等加入前的廣播過期', () => {
    const { l, advance } = ledger();
    l.join(['a']);
    l.record({ rs: 1, f: 10 });
    advance(HOUR);
    l.join(['a', 'c']);
    expect(l.wait('a', 1, 10)).toBeGreaterThan(0);
    expect(l.wait('c', 1, 10)).toBe(0);
  });

  it('持久化：記下的小時跟著存；舊版的帳（沒有 j）讀回來後第一次 join 從 0 算', () => {
    const { l, advance, at } = ledger();
    l.record({ rs: 1, f: 4 });
    const legacy = RelayLedger.parse(JSON.parse(JSON.stringify(l.toJSON())), { now: at, windowMs: () => WINDOW });
    expect(legacy.toJSON().j).toBeUndefined();
    advance(HOUR);
    legacy.join(['a']);
    expect(legacy.used('a')).toBe(4);
    advance(HOUR);
    legacy.join(['a', 'c']);
    const back = RelayLedger.parse(JSON.parse(JSON.stringify(legacy.toJSON())), { now: at, windowMs: () => WINDOW });
    expect(back.toJSON().j).toEqual({ a: 0, c: 102 });
    expect([back.used('a'), back.used('c')]).toEqual([4, 0]);
  });
});
