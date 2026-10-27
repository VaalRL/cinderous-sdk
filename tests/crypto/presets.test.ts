// 場景預設與自動協商（PRD 3.5.3；SDK ADR 0014）。
import { describe, expect, it } from 'vitest';

import { CinderEkKeyring } from '../../src/crypto/cinder-ek.js';
import {
  chooseEngine,
  CRYPTO_ENGINES_TAG,
  engineConfigFor,
  readEngineCapabilities,
  UnsupportedEngineError,
} from '../../src/crypto/presets.js';
import { Identity } from '../../src/identity.js';
import { EK_ANNOUNCE_KIND } from '../../src/protocol/index.js';

describe('能力宣告（kind 10040 的 crypto_engines 標籤）', () => {
  it('SDK 的公告預設宣告兩個引擎都支援', () => {
    const announce = CinderEkKeyring.create(Identity.generate()).buildAnnounce();
    expect(announce.tags).toContainEqual([CRYPTO_ENGINES_TAG, 'cinder-ek', 'double-ratchet']);
    expect(readEngineCapabilities(announce)).toEqual(['cinder-ek', 'double-ratchet']);
  });

  it('沒有這個標籤的公告（今天的 Cinderous App）→ 只當作支援 Cinder EK', () => {
    const bob = Identity.generate();
    const legacy = bob.sign({ kind: EK_ANNOUNCE_KIND, created_at: 1, tags: [], content: '{"v":1,"ek":"' + 'a'.repeat(64) + '"}' });
    expect(readEngineCapabilities(legacy)).toEqual(['cinder-ek']);
  });

  it('沒有公告 → 什麼都不知道（undefined）', () => {
    expect(readEngineCapabilities(undefined)).toBeUndefined();
  });

  it('不認得的引擎名稱會被略過，不會讓整份宣告作廢', () => {
    const bob = Identity.generate();
    const future = bob.sign({ kind: EK_ANNOUNCE_KIND, created_at: 1, tags: [[CRYPTO_ENGINES_TAG, 'cinder-ek', 'triple-ratchet']], content: '{}' });
    expect(readEngineCapabilities(future)).toEqual(['cinder-ek']);
  });
});

describe('chooseEngine', () => {
  const both = ['cinder-ek', 'double-ratchet'] as const;

  it('vault-sync：一律 Cinder EK（離線、多裝置都不會失步）', () => {
    expect(chooseEngine({ preset: 'vault-sync', peerOnline: true, peerCapabilities: [...both], recipients: 1 })).toBe('cinder-ek');
  });

  it('live-collaboration：雙棘輪', () => {
    expect(chooseEngine({ preset: 'live-collaboration', peerOnline: true, peerCapabilities: [...both], recipients: 1 })).toBe('double-ratchet');
  });

  it('🔴 live-collaboration 但對方明確不支援雙棘輪 → 丟例外，不默默換成別的引擎', () => {
    expect(() => chooseEngine({ preset: 'live-collaboration', peerOnline: true, peerCapabilities: ['cinder-ek'], recipients: 1 })).toThrow(
      UnsupportedEngineError,
    );
  });

  it('live-collaboration 但對方不在線 → 丟例外（雙棘輪只用在即時通道，ADR 0010）', () => {
    expect(() => chooseEngine({ preset: 'live-collaboration', peerOnline: false, peerCapabilities: [...both], recipients: 1 })).toThrow(
      UnsupportedEngineError,
    );
  });

  it('auto-negotiate：雙方在線、都支援、一對一 → 雙棘輪', () => {
    expect(chooseEngine({ preset: 'auto-negotiate', peerOnline: true, peerCapabilities: [...both], recipients: 1 })).toBe('double-ratchet');
  });

  it('auto-negotiate：對方離線、對方不支援、或要送給多台裝置 → Cinder EK', () => {
    expect(chooseEngine({ preset: 'auto-negotiate', peerOnline: false, peerCapabilities: [...both], recipients: 1 })).toBe('cinder-ek');
    expect(chooseEngine({ preset: 'auto-negotiate', peerOnline: true, peerCapabilities: ['cinder-ek'], recipients: 1 })).toBe('cinder-ek');
    expect(chooseEngine({ preset: 'auto-negotiate', peerOnline: true, peerCapabilities: undefined, recipients: 1 })).toBe('cinder-ek');
    expect(chooseEngine({ preset: 'auto-negotiate', peerOnline: true, peerCapabilities: [...both], recipients: 3 })).toBe('cinder-ek');
  });
});

describe('engineConfigFor（PRD 3.5.2 的 CryptoEngineConfig）', () => {
  it('兩個引擎的預設值：後量子開、跳過金鑰 2,000、EK 7 天輪替', () => {
    expect(engineConfigFor('double-ratchet')).toEqual({ engine: 'double-ratchet', postQuantumEnabled: true, maxSkippedKeys: 2_000 });
    expect(engineConfigFor('cinder-ek')).toEqual({ engine: 'cinder-ek', postQuantumEnabled: true, ekRotationIntervalSeconds: 604_800 });
  });
});
