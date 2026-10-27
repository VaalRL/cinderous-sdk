// 家庭金鑰衍生與盲化（SDK ADR 0049 §2.1）：固定測試向量（跨語言實作以這組為準），並以 Node 內建的 HKDF／HMAC 獨立重算一次。
import { createHmac, hkdfSync } from 'node:crypto';

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { blindWith, deriveIotDeviceKey, deriveIotHome, generateIotHomeSecret, iotHomeSecretBytes, IOT_BLIND_LENGTH } from '../../src/iot/keys.js';
import { conversationKey, decryptWithKey, encryptWithKey, generateSecretKey, getPublicKey } from '../../src/protocol/index.js';

/** 家庭秘密 00 01 02 … 1f */
const SECRET = new Uint8Array(32).map((_, i) => i);

const VECTORS = {
  homeKey: '96b8ac56c895efbc1cc5637fa3eecd3f909d19bb002ab33c4dc59de70dba7ba9',
  homePub: 'c6b543cb761b8d48bc58237ddc7d3d270978a3908ffe23c10790b3db25ef4f2e',
  topicKey: 'f4110b3d34c9b29bdf61b64a7d157d0bab5c5b05d945fe924c17469ffc4d0847',
  homeTag: 'Yuhtu2E8duEFd2fBwJVO0X',
  blind: {
    'home/plug1/power': 'DNdxmfaToO2-syLkrVEV31',
    'dev:plug1': 'jxTXAANCpWVNNSj7FQHjw3',
    gw: 'nUmQrzKyPvpUpI2gpQ52BT',
    'sys:acl': 'nd2mXvgsCBs1VLAFS_zfHY',
  } as Record<string, string>,
  deviceKey: {
    'plug1|0': '38159142af1f222c6de98d9f31910f6ad1c890d4454c21fa1bf154fd2b710b04',
    'plug1|1': 'a53cf1a54646cd677b8333d2978f0a6cb324a4ebc0b264ac7b7e1c085dec0fea',
  } as Record<string, string>,
};

const nodeHkdf = (info: string): string => Buffer.from(hkdfSync('sha256', SECRET, new Uint8Array(0), Buffer.from(info, 'utf8'), 32)).toString('hex');
const nodeBlind = (topicKeyHex: string, value: string): string =>
  createHmac('sha256', Buffer.from(topicKeyHex, 'hex')).update(value, 'utf8').digest('base64url').slice(0, 22);

describe('deriveIotHome：固定向量', () => {
  const home = deriveIotHome(SECRET);

  it('homeKey、homePub、topicKey、homeTag', () => {
    expect(bytesToHex(home.homeKey)).toBe(VECTORS.homeKey);
    expect(home.homePub).toBe(VECTORS.homePub);
    expect(bytesToHex(home.topicKey)).toBe(VECTORS.topicKey);
    expect(home.homeTag).toBe(VECTORS.homeTag);
  });

  it('盲化：22 字元 base64url', () => {
    for (const [input, out] of Object.entries(VECTORS.blind)) {
      expect(home.blind(input)).toBe(out);
      expect(out).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    expect(IOT_BLIND_LENGTH).toBe(22);
  });

  it('設備金鑰（路線 C 用；epoch 不同金鑰不同）', () => {
    expect(bytesToHex(home.deviceKey('plug1', 0))).toBe(VECTORS.deviceKey['plug1|0']);
    expect(bytesToHex(home.deviceKey('plug1', 1))).toBe(VECTORS.deviceKey['plug1|1']);
    expect(bytesToHex(deriveIotDeviceKey(SECRET, 'plug1'))).toBe(VECTORS.deviceKey['plug1|0']);
  });

  it('以 Node 內建 HKDF／HMAC 獨立重算，結果相同（salt 為空、info 照 ADR）', () => {
    expect(nodeHkdf('cinder-iot/v1/enc')).toBe(VECTORS.homeKey);
    expect(nodeHkdf('cinder-iot/v1/topic')).toBe(VECTORS.topicKey);
    expect(nodeHkdf('cinder-iot/v1/device-key|plug1|0')).toBe(VECTORS.deviceKey['plug1|0']);
    expect(bytesToHex(schnorr.getPublicKey(Buffer.from(VECTORS.homeKey, 'hex')))).toBe(VECTORS.homePub);
    expect(nodeBlind(VECTORS.topicKey, 'home')).toBe(VECTORS.homeTag);
    for (const [input, out] of Object.entries(VECTORS.blind)) expect(nodeBlind(VECTORS.topicKey, input)).toBe(out);
    expect(blindWith(home.topicKey, 'gw')).toBe(VECTORS.blind.gw);
  });

  it('hex 字串與位元組得到同一個家', () => {
    expect(deriveIotHome(bytesToHex(SECRET)).homeTag).toBe(VECTORS.homeTag);
  });
});

describe('家庭秘密', () => {
  it('長度不對、不是 hex 都拒絕', () => {
    expect(() => iotHomeSecretBytes(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => iotHomeSecretBytes('zz')).toThrow(/32 bytes/);
    expect(() => deriveIotDeviceKey(SECRET, 'x', -1)).toThrow(/epoch/);
  });

  it('generateIotHomeSecret：64 位 hex、每次不同', () => {
    const a = generateIotHomeSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateIotHomeSecret()).not.toBe(a);
  });

  it('加密給 homePub 只需要寄件人自己的私鑰；任何持有家庭秘密的成員都解得開（一則只加密一次）', () => {
    const home = deriveIotHome(SECRET);
    const sender = generateSecretKey();
    const ct = encryptWithKey('{"hello":1}', conversationKey(sender, home.homePub));
    const member = deriveIotHome(SECRET); // 另一位成員自己導出
    expect(decryptWithKey(ct, conversationKey(member.homeKey, getPublicKey(sender)))).toBe('{"hello":1}');
    const stranger = deriveIotHome(new Uint8Array(32).fill(7));
    expect(() => decryptWithKey(ct, conversationKey(stranger.homeKey, getPublicKey(sender)))).toThrow();
  });
});
