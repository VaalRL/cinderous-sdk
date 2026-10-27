// 白名單模式（PRD 5.2 場景 B、5.3 `--allowed-pubkeys`；SDK ADR 0008）：
// `ALLOWED_PUBKEYS` 設了就只有名單上的人能寫入，沒設＝開放中繼。
import { describe, expect, it } from 'vitest';

import { generateSecretKey, getPublicKey, npubEncode } from '../../src/protocol/index.js';
import { allowedPubkeysFrom } from '../../src/relay/host-config.js';
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
