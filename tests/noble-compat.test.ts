// @noble 2.4 相容性（SDK ADR 0034）：nostr-tools 經 overrides 改用 SDK 那一份 noble 2.4 後，行為不變。
//
// 1. NIP-44 官方測試向量（paulmillr/nip44 的 nip44.vectors.json，SHA-256 與 NIP-44 規格公布的一致）
//    用 nostr-tools 與 SDK 兩條路徑都跑一遍。
// 2. v0.28.0（noble 2.0.1）預存的產物（tests/fixtures/noble-2.0.1-artifacts.json）：
//    公鑰、確定性簽章、ECDH、NIP-44 密文、NIP-19 編碼要逐位元組相等；舊事件要驗得過、舊禮物包要解得開；
//    新版產出的事件與禮物包也要能被對方解開。
import { readFileSync } from 'node:fs';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as nip06 from 'nostr-tools/nip06';
import * as nip19 from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import * as nip49 from 'nostr-tools/nip49';
import * as nip59 from 'nostr-tools/nip59';
import { finalizeEvent as ntFinalizeEvent, getPublicKey as ntGetPublicKey, verifyEvent as ntVerifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  conversationKey,
  decryptWithKey,
  encryptWithKey,
  finalizeEvent,
  getPublicKey,
  npubEncode,
  nsecEncode,
  openWrap,
  sealAndWrap,
  verifyEvent,
  type NostrEvent,
} from '../src/protocol/index.js';

const vectorsRaw = readFileSync(new URL('./fixtures/nip44.vectors.json', import.meta.url));
const vectors = JSON.parse(vectorsRaw.toString('utf8')).v2;
const old = JSON.parse(readFileSync(new URL('./fixtures/noble-2.0.1-artifacts.json', import.meta.url), 'utf8'));

const sk1 = hexToBytes(old.keys.sk1);
const sk2 = hexToBytes(old.keys.sk2);

function installedVersion(dir: string): string {
  return JSON.parse(readFileSync(new URL(`../node_modules/${dir}/package.json`, import.meta.url), 'utf8')).version;
}

describe('前提：這支測試真的是在新版 noble 上跑', () => {
  it('預存產物來自 noble 2.0.1，目前安裝的是 2.4 以上', () => {
    expect(old._meta.versions['@noble/curves'].sdk).toBe('2.0.1');
    expect(installedVersion('@noble/curves')).not.toBe('2.0.1');
    expect(installedVersion('@noble/hashes')).not.toBe('2.0.1');
  });
});

describe('NIP-44 官方測試向量', () => {
  it('向量檔的 SHA-256 與 NIP-44 規格公布的一致', () => {
    expect(bytesToHex(sha256(vectorsRaw))).toBe('269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040');
  });

  it('get_conversation_key：nostr-tools 與 SDK 都算出同一把', () => {
    for (const v of vectors.valid.get_conversation_key) {
      expect(bytesToHex(nip44.v2.utils.getConversationKey(hexToBytes(v.sec1), v.pub2))).toBe(v.conversation_key);
      expect(bytesToHex(conversationKey(hexToBytes(v.sec1), v.pub2))).toBe(v.conversation_key);
    }
  });

  it('get_message_keys：HKDF-expand（@noble/hashes）導出相同的 ChaCha 金鑰、nonce 與 HMAC 金鑰', () => {
    const ck = hexToBytes(vectors.valid.get_message_keys.conversation_key);
    for (const v of vectors.valid.get_message_keys.keys) {
      const keys = expand(sha256, ck, hexToBytes(v.nonce), 76);
      expect(bytesToHex(keys.subarray(0, 32))).toBe(v.chacha_key);
      expect(bytesToHex(keys.subarray(32, 44))).toBe(v.chacha_nonce);
      expect(bytesToHex(keys.subarray(44, 76))).toBe(v.hmac_key);
    }
  });

  it('calc_padded_len', () => {
    for (const [len, padded] of vectors.valid.calc_padded_len) {
      expect(nip44.v2.utils.calcPaddedLen(len)).toBe(padded);
    }
  });

  it('encrypt_decrypt：固定 nonce 加密逐位元組相等，雙方都解得開', () => {
    for (const v of vectors.valid.encrypt_decrypt) {
      const ck = nip44.v2.utils.getConversationKey(hexToBytes(v.sec1), ntGetPublicKey(hexToBytes(v.sec2)));
      expect(bytesToHex(ck)).toBe(v.conversation_key);
      expect(nip44.v2.encrypt(v.plaintext, ck, hexToBytes(v.nonce))).toBe(v.payload);
      expect(nip44.v2.decrypt(v.payload, ck)).toBe(v.plaintext);
      // 反方向算出同一把對話金鑰，SDK 的解密也要過
      const ck2 = conversationKey(hexToBytes(v.sec2), ntGetPublicKey(hexToBytes(v.sec1)));
      expect(decryptWithKey(v.payload, ck2)).toBe(v.plaintext);
    }
  });

  it('encrypt_decrypt_long_msg：長訊息的明文與密文雜湊相符', () => {
    for (const v of vectors.valid.encrypt_decrypt_long_msg) {
      const plaintext = v.pattern.repeat(v.repeat);
      expect(bytesToHex(sha256(utf8ToBytes(plaintext)))).toBe(v.plaintext_sha256);
      const payload = nip44.v2.encrypt(plaintext, hexToBytes(v.conversation_key), hexToBytes(v.nonce));
      expect(bytesToHex(sha256(utf8ToBytes(payload)))).toBe(v.payload_sha256);
      expect(nip44.v2.decrypt(payload, hexToBytes(v.conversation_key))).toBe(plaintext);
    }
  });

  it('invalid.encrypt_msg_lengths：空明文拒絕加密（超過 65535 的長度見下一則）', () => {
    const ck = new Uint8Array(32).fill(1);
    expect(vectors.invalid.encrypt_msg_lengths).toContain(0);
    expect(() => nip44.v2.encrypt('', ck)).toThrow();
    expect(() => encryptWithKey('', ck)).toThrow();
  });

  it('nostr-tools 2.25 的擴充長度前綴：> 65535 的明文不再拒絕，而是可來回（與 noble 版本無關，早於本次升級）', () => {
    // 官方向量把 65536 以上列為不合法；nostr-tools 2.25 已實作 4 位元組長度前綴，這裡記錄現況，避免誤判為 noble 造成的差異
    const ck = new Uint8Array(32).fill(1);
    const big = 'a'.repeat(65_536);
    expect(nip44.v2.decrypt(nip44.v2.encrypt(big, ck), ck)).toBe(big);
  });

  it('invalid.get_conversation_key：不合法的私鑰或公鑰一律拒絕', () => {
    for (const v of vectors.invalid.get_conversation_key) {
      expect(() => nip44.v2.utils.getConversationKey(hexToBytes(v.sec1), v.pub2), v.note).toThrow();
      expect(() => conversationKey(hexToBytes(v.sec1), v.pub2), v.note).toThrow();
    }
  });

  it('invalid.decrypt：竄改、錯版號、錯長度一律拒絕', () => {
    for (const v of vectors.invalid.decrypt) {
      expect(() => nip44.v2.decrypt(v.payload, hexToBytes(v.conversation_key)), v.note).toThrow();
      expect(() => decryptWithKey(v.payload, hexToBytes(v.conversation_key)), v.note).toThrow();
    }
  });
});

describe('與 v0.28.0（noble 2.0.1）產物互通', () => {
  it('getPublicKey：nostr-tools 與 SDK 都算出同一把公鑰', () => {
    expect(ntGetPublicKey(sk1)).toBe(old.keys.pk1);
    expect(getPublicKey(sk1)).toBe(old.keys.pk1);
    expect(ntGetPublicKey(sk2)).toBe(old.keys.pk2);
  });

  it('BIP-340 確定性簽章（固定 auxRand）逐位元組相等', () => {
    const sig = schnorr.sign(hexToBytes(old.deterministic.msg), sk1, hexToBytes(old.deterministic.aux));
    expect(bytesToHex(sig)).toBe(old.deterministic.sig);
  });

  it('舊事件驗得過（nostr-tools 與 SDK），竄改後驗不過', () => {
    for (const ev of [old.ntEvent, old.sdkEvent] as NostrEvent[]) {
      expect(ntVerifyEvent({ ...ev })).toBe(true);
      expect(verifyEvent({ ...ev })).toBe(true);
      const tampered = { ...ev, sig: ev.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) };
      expect(ntVerifyEvent(tampered)).toBe(false);
      expect(verifyEvent(tampered)).toBe(false);
    }
  });

  it('新版簽的事件，兩邊都驗得過；與舊事件同 id', () => {
    const template = { kind: old.ntEvent.kind, created_at: old.ntEvent.created_at, tags: old.ntEvent.tags, content: old.ntEvent.content };
    const a = ntFinalizeEvent({ ...template }, sk1);
    const b = finalizeEvent({ ...template }, sk1);
    expect(a.id).toBe(old.ntEvent.id);
    expect(b.id).toBe(old.ntEvent.id);
    expect(verifyEvent(a)).toBe(true);
    expect(ntVerifyEvent(b)).toBe(true);
  });

  it('ECDH（getSharedSecret）結果相同', () => {
    expect(bytesToHex(secp256k1.getSharedSecret(sk1, hexToBytes(`02${old.keys.pk2}`)))).toBe(old.ecdh);
  });

  it('NIP-44：對話金鑰與固定 nonce 密文逐位元組相等，舊密文解得開', () => {
    const ck = nip44.v2.utils.getConversationKey(sk1, old.keys.pk2);
    expect(bytesToHex(ck)).toBe(old.nip44.conversationKey);
    expect(bytesToHex(conversationKey(sk2, old.keys.pk1))).toBe(old.nip44.conversationKey);
    const pt = nip44.v2.decrypt(old.nip44.payload, ck);
    expect(nip44.v2.encrypt(pt, ck, hexToBytes(old.nip44.nonce))).toBe(old.nip44.payload);
    expect(decryptWithKey(old.nip44.payload, ck)).toBe(pt);
  });

  it('NIP-19：npub／nsec／nprofile／nevent／naddr 編碼相同、可解回（含超過 90 字元的 TLV）', () => {
    expect(nip19.npubEncode(old.keys.pk1)).toBe(old.npub1);
    expect(nip19.nsecEncode(sk1)).toBe(old.nsec1);
    expect(npubEncode(old.keys.pk1)).toBe(old.sdkNpub1);
    expect(nsecEncode(sk1)).toBe(old.sdkNsec1);
    expect(old.nprofile.length).toBeGreaterThan(90);

    const p = nip19.decode(old.nprofile as string);
    expect(p.type).toBe('nprofile');
    if (p.type !== 'nprofile') throw new Error('unreachable');
    expect(nip19.nprofileEncode(p.data)).toBe(old.nprofile);

    const e = nip19.decode(old.nevent as string);
    if (e.type !== 'nevent') throw new Error('nevent 解碼失敗');
    expect(e.data.id).toBe(old.ntEvent.id);
    expect(nip19.neventEncode(e.data)).toBe(old.nevent);

    const a = nip19.decode(old.naddr as string);
    if (a.type !== 'naddr') throw new Error('naddr 解碼失敗');
    expect(a.data.identifier).toBe('cinderous-noble-24');
    expect(nip19.naddrEncode(a.data)).toBe(old.naddr);
  });

  it('NIP-59：舊的 nostr-tools 禮物包與 SDK 禮物包，兩邊都解得開', () => {
    expect(nip59.unwrapEvent(old.giftWrap, sk2).content).toBe('nostr-tools gift wrap（2.0.1）');
    expect(openWrap(old.giftWrap, sk2).rumor.content).toBe('nostr-tools gift wrap（2.0.1）');
    const opened = openWrap(old.sdkWrap, sk2);
    expect(opened.sender).toBe(old.keys.pk1);
    expect(opened.rumor.content).toBe('SDK sealAndWrap（2.0.1）');
    expect(nip59.unwrapEvent(old.sdkWrap, sk2).content).toBe('SDK sealAndWrap（2.0.1）');
  });

  it('NIP-59：新版產出的禮物包，另一邊也解得開', () => {
    const w1 = nip59.wrapEvent({ kind: 14, created_at: 1_790_000_000, tags: [['p', old.keys.pk2]], content: 'nt→sdk' }, sk1, old.keys.pk2);
    expect(openWrap(w1, sk2).rumor.content).toBe('nt→sdk');
    const w2 = sealAndWrap({ kind: 14, created_at: 1_790_000_000, tags: [], content: 'sdk→nt' }, sk1, old.keys.pk2, { kind: 1059, tags: [['p', old.keys.pk2]] });
    expect(nip59.unwrapEvent(w2, sk2).content).toBe('sdk→nt');
    // SDK 自己的 NIP-44 封裝也能給 nostr-tools 解
    const ck = conversationKey(sk1, old.keys.pk2);
    expect(nip44.v2.decrypt(encryptWithKey('x', ck), ck)).toBe('x');
  });

  it('NIP-49（scrypt + XChaCha20-Poly1305）：舊的 ncryptsec 解得回原私鑰', () => {
    expect(bytesToHex(nip49.decrypt(old.nip49.ncryptsec, old.nip49.password))).toBe(old.keys.sk1);
  });

  it('NIP-06（@scure/bip32／bip39 經 overrides 改用新版 noble）：助記詞導出同一把私鑰', () => {
    expect(bytesToHex(nip06.privateKeyFromSeedWords(old.nip06.mnemonic, undefined, 0))).toBe(old.nip06.sk0);
  });
});
