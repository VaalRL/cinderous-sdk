// 密碼學函式庫的守門測試（SDK ADR 0034；取代 ADR 0020 的「與 nostr-tools 釘同一版」）。
//
// 1. 安全下限：SDK 宣告與實際安裝的 @noble／@scure 版本不得低於下表。
//    - @noble/curves ≥ 2.4.0：2.3.0 起常數時間由「盡力」改為實際保證（純量盲化、固定視窗乘法）與 Trail of Bits 審查修正；
//      2.4.0 起 ECDH／ECDSA 拒收無窮遠點、DER 長度設限。
//    - @noble/hashes ≥ 2.4.0：選項防汙染、zeroization 改善（Security and correctness）。
//    - @noble/ciphers ≥ 2.4.0：2.3.0 AEAD／padding 強化、2.4.0 拒收部分重疊的輸出緩衝區。
//    - @scure/base ≥ 2.4.0：bech32 拒收非 ASCII 大小寫折疊、base58 長度上限。
// 2. 只有一份：SDK 開發樹（package-lock.json）裡每個套件只能出現一次——nostr-tools 仍釘 2.0.1，
//    靠 package.json 的 `overrides` 導向同一份。拿掉 overrides 或降到下限以下，這裡會變紅。
//    （nostr-tools／post-quantum 換釘版時會被 overrides 壓回 SDK 的版本，這裡不會紅；升級它們時看 release notes 決定 SDK 要不要跟。）
//
// 不再要求等於 nostr-tools 的釘版：SDK 無法替使用方決定 nostr-tools 的相依，使用方要自己加 overrides（README）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SECURITY_FLOORS: Record<string, string> = {
  '@noble/curves': '2.4.0',
  '@noble/hashes': '2.4.0',
  '@noble/ciphers': '2.4.0',
  '@scure/base': '2.4.0',
};

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const sdk = readJson('../package.json') as { dependencies: Record<string, string>; overrides?: Record<string, unknown> };
const lock = readJson('../package-lock.json') as { packages: Record<string, { version?: string }> };

/** 把 `2.4.0`、`^2.4.0`、`~2.4.0`、`>=2.4.0` 取出下限版本；其他寫法（`*`、`||`、git）一律視為不合格。 */
function lowerBound(spec: string): [number, number, number] | undefined {
  const m = /^(?:\^|~|>=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(spec.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function atLeast(version: string, floor: string): boolean {
  const a = lowerBound(version);
  const b = lowerBound(floor)!;
  if (!a) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

/** package-lock 裡某個套件的所有安裝位置（`node_modules/x`、`node_modules/y/node_modules/x`…）。 */
function copiesInLock(name: string): Array<{ path: string; version: string | undefined }> {
  return Object.entries(lock.packages)
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([path, meta]) => ({ path, version: meta.version }));
}

describe('lowerBound／atLeast（守門測試自己的比較）', () => {
  it('確切版本與 ^／~／>= 範圍取下限，其他寫法不合格', () => {
    expect(atLeast('2.4.0', '2.4.0')).toBe(true);
    expect(atLeast('^2.4.1', '2.4.0')).toBe(true);
    expect(atLeast('~2.10.0', '2.4.0')).toBe(true);
    expect(atLeast('>=3.0.0', '2.4.0')).toBe(true);
    expect(atLeast('2.3.9', '2.4.0')).toBe(false);
    expect(atLeast('^2.0.1', '2.4.0')).toBe(false);
    expect(atLeast('*', '2.4.0')).toBe(false);
    expect(atLeast('2.0.1 || 2.4.0', '2.4.0')).toBe(false);
  });
});

describe('密碼學函式庫：安全下限', () => {
  for (const [name, floor] of Object.entries(SECURITY_FLOORS)) {
    it(`${name}：package.json 宣告的版本 ≥ ${floor}`, () => {
      expect(atLeast(sdk.dependencies[name] ?? '', floor), `${name}@${sdk.dependencies[name]}`).toBe(true);
    });

    it(`${name}：實際安裝的每一份都 ≥ ${floor}`, () => {
      const copies = copiesInLock(name);
      expect(copies.length).toBeGreaterThan(0);
      for (const c of copies) expect(atLeast(c.version ?? '', floor), `${c.path}@${c.version}`).toBe(true);
    });
  }
});

describe('密碼學函式庫：開發樹裡只有一份（nostr-tools 經 overrides 共用）', () => {
  for (const name of Object.keys(SECURITY_FLOORS)) {
    it(`${name} 在 package-lock.json 只出現一次`, () => {
      expect(copiesInLock(name).map((c) => `${c.path}@${c.version}`)).toEqual([`node_modules/${name}@${copiesInLock(name)[0]?.version}`]);
    });

    it(`${name} 有 overrides，指回 SDK 自己的相依`, () => {
      expect(sdk.overrides?.[name]).toBe(`$${name}`);
    });
  }
});

// @scure/base 2.3.0 移除了內部的 `utils`，而 nostr-tools 釘的 @scure/bip39 2.0.1 會 `import { utils } from '@scure/base'`。
// 只把 @scure/base 導到 2.4 會讓 nostr-tools 根入口與 nip06 在載入時就丟 SyntaxError（實測）。
// 所以 bip32／bip39 也要一起導到不再依賴舊 base 的版本（bip39 ≥ 2.3.0 已拿掉 @scure/base 相依）。
describe('@scure/bip32／bip39 跟著 @scure/base 一起導向新版', () => {
  for (const name of ['@scure/bip32', '@scure/bip39']) {
    it(`${name} 有 overrides，且安裝的版本 ≥ 2.4.0`, () => {
      expect(atLeast(String(sdk.overrides?.[name] ?? ''), '2.4.0'), `${name} overrides=${String(sdk.overrides?.[name])}`).toBe(true);
      const copies = copiesInLock(name);
      expect(copies).toHaveLength(1);
      expect(atLeast(copies[0]?.version ?? '', '2.4.0'), `${copies[0]?.path}@${copies[0]?.version}`).toBe(true);
    });
  }
});
