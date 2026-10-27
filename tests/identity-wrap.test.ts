// Identity 的 NIP-59 封裝與拆封（SDK ADR 0009）：私鑰不離開 Identity。
import { describe, expect, it } from 'vitest';

import { Identity } from '../src/identity.js';

describe('Identity.sealAndWrap／openWrap', () => {
  it('封給對方 → 對方拆得開、看得到真正的寄件人；外層是一次性金鑰', () => {
    const alice = Identity.generate();
    const bob = Identity.generate();
    const wrap = alice.sealAndWrap(
      { kind: 21000, created_at: 1_700_000_000, tags: [], content: 'hi' },
      bob.pubkey,
      { kind: 21000, tags: [['p', bob.pubkey]] },
    );
    expect(wrap.kind).toBe(21000);
    expect(wrap.pubkey).not.toBe(alice.pubkey);
    const opened = bob.openWrap(wrap);
    expect(opened.sender).toBe(alice.pubkey);
    expect(opened.rumor.content).toBe('hi');
  });

  it('不是封給我的 → 丟例外', () => {
    const alice = Identity.generate();
    const wrap = alice.sealAndWrap({ kind: 14, created_at: 1, tags: [], content: 'x' }, Identity.generate().pubkey, { kind: 1059, tags: [] });
    expect(() => Identity.generate().openWrap(wrap)).toThrow();
  });
});

describe('seal 的 kind 必須是 13（NIP-59；SDK ADR 0012）', () => {
  it('外層包的是別種 kind 的簽章事件 → 拒絕', async () => {
    const { finalizeEvent, generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const { encrypt, getConversationKey } = await import('nostr-tools/nip44');
    const mallorySk = generateSecretKey();
    const bob = Identity.generate();
    const rumor = { kind: 14, created_at: 1, tags: [], content: 'x', pubkey: getPublicKey(mallorySk) };
    const { getEventHash } = await import('nostr-tools/pure');
    const fakeSeal = finalizeEvent(
      { kind: 1, created_at: 1, tags: [], content: encrypt(JSON.stringify({ ...rumor, id: getEventHash(rumor) }), getConversationKey(mallorySk, bob.pubkey)) },
      mallorySk,
    );
    const ephemeral = generateSecretKey();
    const wrap = finalizeEvent(
      { kind: 1059, created_at: 1, tags: [['p', bob.pubkey]], content: encrypt(JSON.stringify(fakeSeal), getConversationKey(ephemeral, bob.pubkey)) },
      ephemeral,
    );
    expect(() => bob.openWrap(wrap)).toThrow(/seal/);
  });
});
