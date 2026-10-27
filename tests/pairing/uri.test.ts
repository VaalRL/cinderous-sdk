// 配對 QR 字串（SDK ADR 0028 §2）：格式、壓縮、容量、驗證。
import { describe, expect, it } from 'vitest';

import { Identity } from '../../src/identity.js';
import {
  compactRelayUrl,
  encodePairingUri,
  isPairingError,
  MAX_PAIRING_URI_BYTES,
  PAIRING_SECRET_BYTES,
  parsePairingUri,
  qrVersionFor,
  type PairingInvite,
} from '../../src/pairing/index.js';

const pubkey = Identity.generate().pubkey;
const secret = new Uint8Array(PAIRING_SECRET_BYTES).fill(7);
const base: PairingInvite = {
  version: 1,
  role: 'invite',
  pubkey,
  secret,
  expiresAt: 1_800_000_000,
  relays: ['wss://cinder-relay.myaccount1.workers.dev', 'wss://relay.example.org/nostr'],
};

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return isPairingError(error) ? error.reason : 'other';
  }
  return undefined;
}

describe('配對 QR 字串', () => {
  it('來回：角色、公鑰、秘密、到期、中繼都保留', () => {
    for (const role of ['invite', 'join'] as const) {
      const uri = encodePairingUri({ ...base, role });
      expect(uri.startsWith('cinderous-pair:1.')).toBe(true);
      const back = parsePairingUri(uri);
      expect(back).toEqual({ ...base, role, secret: back.secret });
      expect([...back.secret]).toEqual([...secret]);
    }
  });

  it('wss:// 省略、ws:// 照寫；結尾的 / 去掉；含逗號或空白的中繼放不進 QR', () => {
    expect(compactRelayUrl('wss://a.example/')).toBe('a.example');
    expect(compactRelayUrl('WSS://A.example')).toBe('A.example');
    expect(compactRelayUrl('ws://localhost:8787')).toBe('ws://localhost:8787');
    expect(compactRelayUrl('wss://a.example/x,y')).toBeNull();
    expect(compactRelayUrl('https://a.example')).toBeNull();
    const uri = encodePairingUri({ ...base, relays: ['wss://bad.example/a,b', 'ws://localhost:8787'] });
    expect(parsePairingUri(uri).relays).toEqual(['ws://localhost:8787']);
  });

  it('容量：兩座一般長度的中繼，整串 ≤ 213 bytes＝QR 版本 10（錯誤修正 M）', () => {
    const uri = encodePairingUri(base);
    expect(uri.length).toBeLessThanOrEqual(MAX_PAIRING_URI_BYTES);
    expect(qrVersionFor(uri, 'M')).toBeLessThanOrEqual(10);
    // 一座 workers.dev 中繼：124 bytes＝版本 8
    const one = encodePairingUri({ ...base, relays: ['wss://cinder-relay.myaccount1.workers.dev'] });
    expect(one.length).toBe(17 + 71 + 1 + 'cinder-relay.myaccount1.workers.dev'.length);
    expect(qrVersionFor(one, 'M')).toBe(8);
  });

  it('中繼太長：放得下幾座放幾座（最多 2 座）；第一座就放不下 → 丟例外', () => {
    const long = `wss://${'x'.repeat(100)}.example`;
    const uri = encodePairingUri({ ...base, relays: [base.relays[0]!, long, 'wss://c.example', 'wss://d.example'] });
    expect(parsePairingUri(uri).relays).toEqual([base.relays[0], 'wss://c.example']);
    expect(uri.length).toBeLessThanOrEqual(MAX_PAIRING_URI_BYTES);
    expect(reason(() => encodePairingUri({ ...base, relays: [`wss://${'y'.repeat(130)}`] }))).toBe('bad-uri');
    // 最壞情況（兩座都用到長度上限內能放的最長）仍 ≤ 版本 10
    const worst = encodePairingUri({ ...base, relays: [`wss://${'a'.repeat(60)}`, `wss://${'b'.repeat(60)}`] });
    expect(qrVersionFor(worst, 'M')).toBeLessThanOrEqual(10);
  });

  it('解析拒絕：前綴、版本、長度、保留旗標、不在曲線上的公鑰、壞中繼、太多中繼', () => {
    const uri = encodePairingUri(base);
    const core = uri.slice(17, 17 + 71);
    expect(reason(() => parsePairingUri('https://example.com'))).toBe('bad-uri');
    expect(reason(() => parsePairingUri(uri.replace('cinderous-pair:1.', 'cinderous-pair:2.')))).toBe('unsupported-version');
    expect(reason(() => parsePairingUri(uri.replace(core, core.slice(1))))).toBe('bad-uri');
    // 保留位元
    const flagged = `cinderous-pair:1.${'C'}${core.slice(1)}.${uri.split('.').slice(2).join('.')}`;
    expect(reason(() => parsePairingUri(flagged))).toBe('bad-uri');
    // 公鑰不在曲線上（全 0xff）
    const badPk = encodePairingUri(base).replace(core, `A${'_'.repeat(42)}${core.slice(43)}`);
    expect(reason(() => parsePairingUri(badPk))).toBe('bad-uri');
    expect(reason(() => parsePairingUri(`${uri.split('.')[0]}.${core}.`))).toBe('bad-uri');
    expect(reason(() => parsePairingUri(`${uri.split('.')[0]}.${core}.a.example,b.example,c.example`))).toBe('bad-uri');
    expect(reason(() => parsePairingUri(`${uri.split('.')[0]}.${core}.https://x`))).toBe('bad-uri');
  });

  it('編碼拒絕：秘密長度、到期時間、公鑰', () => {
    expect(reason(() => encodePairingUri({ ...base, secret: new Uint8Array(8) }))).toBe('bad-uri');
    expect(reason(() => encodePairingUri({ ...base, expiresAt: 2 ** 32 }))).toBe('bad-uri');
    expect(reason(() => encodePairingUri({ ...base, pubkey: 'ff'.repeat(32) }))).toBe('bad-uri');
  });

  it('QR 容量表：位元組模式', () => {
    expect(qrVersionFor('x'.repeat(213), 'M')).toBe(10);
    expect(qrVersionFor('x'.repeat(214), 'M')).toBe(11);
    expect(qrVersionFor('x'.repeat(14), 'M')).toBe(1);
    expect(qrVersionFor('x'.repeat(271), 'L')).toBe(10);
    expect(qrVersionFor('x'.repeat(1000), 'M')).toBeNull();
  });
});
