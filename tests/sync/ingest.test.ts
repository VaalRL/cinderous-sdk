// 三層分流（SDK ADR 0011 §2；PRD 2.4）。
import { describe, expect, it } from 'vitest';

import { generateSecretKey } from '../../src/protocol/index.js';
import { ADDRESSABLE_MAX_BYTES } from '../../src/relay/message-store.js';
import { classifyPayload, FILE_TIER_MAX_BYTES, SNAPSHOT_TIER_MAX_BYTES } from '../../src/sync/ingest.js';
import { buildSnapshotEvent } from '../../src/sync/snapshot.js';

describe('classifyPayload', () => {
  it('小的走快照、中的走檔案塊、大的等 P2P', () => {
    expect(classifyPayload(1_000)).toBe('snapshot');
    expect(classifyPayload(SNAPSHOT_TIER_MAX_BYTES)).toBe('snapshot');
    expect(classifyPayload(SNAPSHOT_TIER_MAX_BYTES + 1)).toBe('file');
    expect(classifyPayload(FILE_TIER_MAX_BYTES)).toBe('file');
    expect(classifyPayload(FILE_TIER_MAX_BYTES + 1)).toBe('p2p');
  });

  it('🔴 快照層的上限是「加密後放得進中繼」：真的包一顆最大的快照，大小不超過中繼上限', () => {
    const plaintext = 'x'.repeat(SNAPSHOT_TIER_MAX_BYTES);
    const event = buildSnapshotEvent(plaintext, generateSecretKey(), 'device-1');
    expect(JSON.stringify(event).length).toBeLessThanOrEqual(ADDRESSABLE_MAX_BYTES);
  });

  it('負數或非整數 → 丟例外', () => {
    expect(() => classifyPayload(-1)).toThrow();
    expect(() => classifyPayload(1.5)).toThrow();
  });
});
