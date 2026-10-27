// 打包好的中繼 Worker 不含秘密（SDK ADR 0064）：這份字串會跟著外掛發給每一個使用者，
// 部署到誰的 Cloudflare 帳號，帳號主人也能下載——裡面出現的任何東西都等於公開。
import { describe, expect, it } from 'vitest';

import { relayWorkerSource } from '../../src/deploy/cloudflare-api/index.js';

/**
 * bundle 裡允許出現的 64 位十六進位常數：都是 secp256k1 的公開參數（@noble/curves）。
 * 新出現的一律要人看過（是公開常數才加進來；是金鑰就是事故）。
 */
const PUBLIC_HEX_CONSTANTS = new Set([
  '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', // 生成點 Gx
  '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8', // 生成點 Gy
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', // 階 n
  'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f', // 質數 p
  '7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee', // GLV 自同態 beta
]);

describe('中繼 Worker bundle 不含秘密（SDK ADR 0064）', () => {
  it('🔴 沒有私鑰、憑證與 API 金鑰的樣子', () => {
    const patterns: Array<[string, RegExp]> = [
      ['Nostr 私鑰（nsec）', /nsec1[02-9ac-hj-np-z]{20,}/],
      ['PEM 私鑰', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['Apple .p8 檔名', /AuthKey_[A-Z0-9]{10}/],
      ['GitHub token', /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/],
      ['Google API key（FCM）', /AIza[0-9A-Za-z_-]{35}/],
      ['Stripe 類金鑰', /\bsk_(?:live|test)_[0-9A-Za-z]{10,}/],
      ['Bearer 字面值', /Bearer [A-Za-z0-9._-]{20,}/],
    ];
    for (const [name, pattern] of patterns) expect(relayWorkerSource, name).not.toMatch(pattern);
  });

  it('🔴 64 位十六進位常數只有已知的公開參數', () => {
    const found = new Set(relayWorkerSource.toLowerCase().match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g) ?? []);
    expect([...found].filter((hex) => !PUBLIC_HEX_CONSTANTS.has(hex))).toEqual([]);
  });

  it('沒有 source map（不附原始碼對照）、沒有本機路徑', () => {
    expect(relayWorkerSource).not.toMatch(/sourceMappingURL/);
    expect(relayWorkerSource).not.toMatch(/[A-Za-z]:\\\\Users\\\\|\/home\/|\/Users\//);
  });
});
