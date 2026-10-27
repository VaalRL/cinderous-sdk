// 身分（NIP-01 金鑰、NIP-19 編碼、事件簽章）——包住 nostr-tools 的純函式。
import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import { Identity } from '../src/identity.js';

describe('Identity', () => {
  it('generate 產生一組金鑰；npub／nsec 是 bech32，pubkey 是 64 位 hex', () => {
    const identity = Identity.generate();
    expect(identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.npub.startsWith('npub1')).toBe(true);
    expect(identity.nsec().startsWith('nsec1')).toBe(true);
    expect(Identity.generate().pubkey).not.toBe(identity.pubkey);
  });

  it('fromNsec 還原同一個身分；壞掉的 nsec 丟例外', () => {
    const original = Identity.generate();
    const restored = Identity.fromNsec(original.nsec());
    expect(restored.pubkey).toBe(original.pubkey);
    expect(restored.npub).toBe(original.npub);
    expect(() => Identity.fromNsec('nsec1garbage')).toThrow();
    expect(() => Identity.fromNsec(original.npub)).toThrow();
  });

  it('sign 產出可驗證、帶正確 pubkey 的事件', () => {
    const identity = Identity.generate();
    const event = identity.sign({
      kind: 20078,
      created_at: 1_700_000_000,
      tags: [['t', 'demo']],
      content: '{"type":"seek"}',
    });
    expect(event.pubkey).toBe(identity.pubkey);
    expect(event.id).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyEvent(event)).toBe(true);
    // 竄改內容後簽章失效（經 JSON 往返，去掉 nostr-tools 掛在物件上的「已驗證」快取符號）
    const tampered = JSON.parse(JSON.stringify({ ...event, content: 'tampered' }));
    expect(verifyEvent(tampered)).toBe(false);
  });
});

describe('Identity NIP-44', () => {
  it('encryptTo 的密文只有對方解得開；密文不含明文；被改過就解不開', () => {
    const alice = Identity.generate();
    const bob = Identity.generate();
    const payload = alice.encryptTo(bob.pubkey, '{"type":"accept","session":"abc"}');
    expect(payload).not.toContain('accept');
    expect(bob.decryptFrom(alice.pubkey, payload)).toBe('{"type":"accept","session":"abc"}');
    // 自己也解得開自己加的（對話金鑰對稱）
    expect(alice.decryptFrom(bob.pubkey, payload)).toBe('{"type":"accept","session":"abc"}');
    expect(() => Identity.generate().decryptFrom(alice.pubkey, payload)).toThrow();
    expect(() => bob.decryptFrom(alice.pubkey, `${payload.slice(0, -4)}AAAA`)).toThrow();
    // 同一段明文每次密文都不同（隨機 nonce）
    expect(alice.encryptTo(bob.pubkey, 'x')).not.toBe(alice.encryptTo(bob.pubkey, 'x'));
  });
});
