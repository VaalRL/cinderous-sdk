// 版本歷史（SDK ADR 0063，v0.50 的儲存格式）測試用：`hc:` 的解碼與歸檔的完整性檢查。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { expect } from 'vitest';

import { type Device, str } from './harness.js';

export const HC_MAGIC = [0x00, 0x63, 0x68, 0x32];

export function decodeHc(value: Uint8Array): { owners: string[]; content: Uint8Array } | null {
  if (!HC_MAGIC.every((b, i) => value[i] === b)) return null;
  const len = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(4);
  return { owners: JSON.parse(new TextDecoder().decode(value.subarray(8, 8 + len))) as string[], content: value.subarray(8 + len) };
}

/**
 * 歸檔的完整性：每個 `hc:` 都是新格式、雜湊相符；參照它的檔案的 `ha:` 真的有版本參照它（或沒有參照者時在 `hq` 裡）；
 * 每個有內容的版本，`hc:` 都在。摘要（`hs:`）和 `ha:` 一致。
 */
export async function archiveIntegrity(d: Device): Promise<void> {
  await d.sync.idle();
  const store = d.store;
  const records = new Map<string, { entries: Array<{ hash: string; content: boolean; size: number; at: number; n: number; versionId: string }> }>();
  for (const key of await store.keys('ha:')) records.set(key.slice(3), JSON.parse(str((await store.get(key))!)));
  const own = JSON.parse(str((await store.get('hq')) ?? new TextEncoder().encode('{}'))) as Record<string, number>;
  const contents = new Map<string, string[]>();
  for (const key of await store.keys('hc:')) {
    const decoded = decodeHc((await store.get(key))!);
    expect(decoded, key).not.toBeNull();
    expect(bytesToHex(sha256(decoded!.content)), key).toBe(key.slice(3));
    contents.set(key.slice(3), decoded!.owners);
    if (decoded!.owners.length === 0) expect(own[key.slice(3)], `${key} 沒有參照者也不在 hq`).toBe(decoded!.content.length);
    for (const owner of decoded!.owners) expect(records.get(owner)?.entries.some((e) => e.content && e.hash === key.slice(3)), `${key} 的參照者 ${owner}`).toBe(true);
  }
  for (const [fileId, hf] of records) for (const e of hf.entries) if (e.content) expect(contents.get(e.hash), `${fileId} ${e.versionId}`).toContain(fileId);
  // 佔用＝各檔參照的內容（檔案內以雜湊去重）＋只有檢查點留著的內容
  let bytes = 0;
  for (const hf of records.values()) {
    const sizes = new Map<string, number>();
    for (const e of hf.entries) if (e.content) sizes.set(e.hash, e.size);
    for (const size of sizes.values()) bytes += size;
  }
  for (const size of Object.values(own)) bytes += size;
  expect(d.sync.historyStatus().bytes, `${d.name} bytes`).toBe(bytes);
  const summaries = new Map<string, { c: number; l: { versionId: string } | null }>();
  for (const key of await store.keys('hs:')) for (const [id, s] of Object.entries(JSON.parse(str((await store.get(key))!)) as Record<string, { c: number; l: { versionId: string } | null }>)) summaries.set(id, s);
  expect(new Set(summaries.keys())).toEqual(new Set(records.keys()));
  for (const [fileId, s] of summaries) {
    const entries = records.get(fileId)!.entries;
    expect(s.c, fileId).toBe(entries.length);
    expect(s.l?.versionId ?? null, fileId).toBe(entries.length > 0 ? entries[entries.length - 1]!.versionId : null);
  }
}
