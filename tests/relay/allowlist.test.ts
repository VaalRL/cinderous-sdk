// 白名單模式（PRD 5.2 場景 B、5.3 `--allowed-pubkeys`；SDK ADR 0008）：
// `ALLOWED_PUBKEYS` 設了就只有名單上的人能寫入，沒設＝開放中繼。
import { describe, expect, it } from 'vitest';

import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/index.js';
import { allowedKindsFrom, allowedPubkeysFrom } from '../../src/relay/host-config.js';
import { buildRelayInfo } from '../../src/relay/nip11.js';

const alice = getPublicKey(generateSecretKey());
const bob = getPublicKey(generateSecretKey());

describe('allowedPubkeysFrom', () => {
  it('沒設、空字串、只有空白 → undefined（開放中繼）', () => {
    expect(allowedPubkeysFrom(undefined)).toBeUndefined();
    expect(allowedPubkeysFrom('')).toBeUndefined();
    expect(allowedPubkeysFrom('  ,  ')).toBeUndefined();
  });

  it('npub 與 hex 可以混用，一律轉成小寫 hex', () => {
    expect(allowedPubkeysFrom(`${npubEncode(alice)}, ${bob.toUpperCase()}`)).toEqual([alice, bob]);
  });

  it('逗號、空白、換行都能分隔；重複的只留一個', () => {
    expect(allowedPubkeysFrom(`${alice}\n${bob} ${alice}`)).toEqual([alice, bob]);
  });

  it('🔴 有一筆寫錯就整個拒絕啟動——默默略過會讓那個人被擋在門外，而站方不知道為什麼', () => {
    expect(() => allowedPubkeysFrom(`${alice},npub1壞掉`)).toThrow(/第 2 筆/);
    expect(() => allowedPubkeysFrom(`${alice},abc123`)).toThrow(/第 2 筆/);
  });
});

describe('NIP-11：白名單站要標示 restricted_writes', () => {
  const limitation = (info: Record<string, unknown>) => info.limitation as Record<string, unknown>;

  it('設了白名單 → restricted_writes: true（就算沒有要求 AUTH）', () => {
    expect(limitation(buildRelayInfo({ writeRestricted: true })).restricted_writes).toBe(true);
  });

  it('沒設白名單也沒要求 AUTH → false', () => {
    expect(limitation(buildRelayInfo({})).restricted_writes).toBe(false);
  });
});

describe('NIP-86 相關的環境變數（SDK ADR 0132）', () => {
  it('allowedPubkeysFrom 可換錯誤訊息裡的變數名稱', () => {
    expect(() => allowedPubkeysFrom('abc', 'NIP86_ADMIN_PUBKEYS')).toThrow(/NIP86_ADMIN_PUBKEYS 第 1 筆/);
  });

  it('allowedKindsFrom：沒設＝undefined（全部接受）；逗號空白分隔、去重', () => {
    expect(allowedKindsFrom(undefined)).toBeUndefined();
    expect(allowedKindsFrom(' , ')).toBeUndefined();
    expect(allowedKindsFrom('1059, 20000 1059\n21000')).toEqual([1059, 20000, 21000]);
  });

  it('🔴 allowedKindsFrom：有一筆不是 0–65535 的整數就拒絕啟動', () => {
    expect(() => allowedKindsFrom('1059,abc')).toThrow(/ALLOWED_KINDS 第 2 筆/);
    expect(() => allowedKindsFrom('70000')).toThrow(/第 1 筆/);
    expect(() => allowedKindsFrom('-1')).toThrow(/第 1 筆/);
    expect(() => allowedKindsFrom('1.5')).toThrow(/第 1 筆/);
  });

  it('NIP-11：開了 NIP-86 才在 supported_nips 加 86', () => {
    expect(buildRelayInfo({}).supported_nips).not.toContain(86);
    expect(buildRelayInfo({ nip86: true }).supported_nips).toContain(86);
  });
});
