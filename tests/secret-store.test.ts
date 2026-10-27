// 私鑰持久化：有就還原、沒有就產一把新的存回去、壞掉的自癒。用記憶體 SecretStore。
import { describe, expect, it } from 'vitest';

import { Identity } from '../src/identity.js';
import { loadOrCreateIdentity, type SecretStore } from '../src/secret-store.js';

function memoryStore(initial: string | null = null): SecretStore & { value: string | null } {
  const store = {
    value: initial,
    get: () => Promise.resolve(store.value),
    set: (nsec: string) => {
      store.value = nsec;
      return Promise.resolve();
    },
  };
  return store;
}

describe('loadOrCreateIdentity', () => {
  it('空的：產一把新的並存起來', async () => {
    const store = memoryStore();
    const identity = await loadOrCreateIdentity(store);
    expect(identity.nsec()).toBe(store.value);
    expect(identity.npub.startsWith('npub1')).toBe(true);
  });

  it('有存著：還原同一個身分，不覆蓋', async () => {
    const original = Identity.generate();
    const store = memoryStore(original.nsec());
    const restored = await loadOrCreateIdentity(store);
    expect(restored.pubkey).toBe(original.pubkey);
    expect(store.value).toBe(original.nsec());
  });

  it('壞掉的值：當作沒有，產新的覆蓋掉', async () => {
    const store = memoryStore('nsec1garbage');
    const identity = await loadOrCreateIdentity(store);
    expect(store.value).toBe(identity.nsec());
    expect(store.value).not.toBe('nsec1garbage');
    expect(() => Identity.fromNsec(identity.nsec())).not.toThrow();
  });
});
