// 協調器訊息的線上格式與驗證（SDK ADR 0025 §5）；狀態儲存的每鍵序列化。
import { describe, expect, it } from 'vitest';

import { decodeVaultMessage, encodeVaultMessage, isSafeVaultPath, MemorySyncStateStore, sha256Hex, type VaultSyncMessage } from '../../../src/sync/vault/index.js';
import { SerializedStore } from '../../../src/sync/vault/state-store.js';

const content = new TextEncoder().encode('# hi');
const good: VaultSyncMessage = {
  type: 'node',
  from: 'mac-1',
  fileId: '0'.repeat(32),
  node: {
    id: '1'.repeat(32),
    parents: ['2'.repeat(32)],
    path: '筆記/hi.md',
    pathAt: 5,
    deleted: false,
    hash: sha256Hex(content),
    size: content.length,
    text: true,
    at: 6,
    device: 'mac-1',
    label: 'MacBook',
    p2p: false,
  },
  content,
};

function tamper(message: VaultSyncMessage, patch: (header: Record<string, unknown>) => void): Uint8Array {
  const bytes = encodeVaultMessage(message);
  const len = new DataView(bytes.buffer).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len))) as Record<string, unknown>;
  patch(header);
  const h = new TextEncoder().encode(JSON.stringify(header));
  const rest = bytes.subarray(4 + len);
  const out = new Uint8Array(4 + h.length + rest.length);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(rest, 4 + h.length);
  return out;
}

describe('線上格式', () => {
  it('三種訊息都能來回', () => {
    expect(decodeVaultMessage(encodeVaultMessage(good))).toEqual(good);
    const digest: VaultSyncMessage = { type: 'digest', from: 'a', digestId: 'f'.repeat(32), part: 0, parts: 2, files: [['0'.repeat(32), ['1'.repeat(32)]]] };
    expect(decodeVaultMessage(encodeVaultMessage(digest))).toEqual(digest);
    const want: VaultSyncMessage = { type: 'want', from: 'a', items: [['0'.repeat(32), '1'.repeat(32)]] };
    expect(decodeVaultMessage(encodeVaultMessage(want))).toEqual(want);
  });

  it('內容不經 base64：標頭之後就是原始位元組', () => {
    const bytes = encodeVaultMessage(good);
    expect([...bytes.subarray(bytes.length - content.length)]).toEqual([...content]);
  });

  it('內容與雜湊不符、長度不符 → 丟掉', () => {
    const bytes = encodeVaultMessage(good);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(decodeVaultMessage(bytes)).toBeNull();
    expect(decodeVaultMessage(tamper(good, (h) => (h.contentLength = 3)))).toBeNull();
  });

  it('危險路徑 → 丟掉', () => {
    for (const path of ['../etc/passwd', '/abs.md', 'C:/x.md', 'a/../b.md', 'a//b.md', 'a\\b.md', 'a/./b.md', '', 'x\u0000.md']) {
      expect(isSafeVaultPath(path), path).toBe(false);
      expect(decodeVaultMessage(tamper(good, (h) => ((h.node as Record<string, unknown>).path = path))), path).toBeNull();
    }
    expect(isSafeVaultPath('資料夾/檔案 (1).md')).toBe(true);
  });

  it('欄位型別不對、版本不對、未知類型 → 丟掉', () => {
    expect(decodeVaultMessage(tamper(good, (h) => (h.v = 2)))).toBeNull();
    expect(decodeVaultMessage(tamper(good, (h) => (h.type = 'bogus')))).toBeNull();
    expect(decodeVaultMessage(tamper(good, (h) => (h.from = 'bad id')))).toBeNull();
    expect(decodeVaultMessage(tamper(good, (h) => ((h.node as Record<string, unknown>).parents = ['1'.repeat(32)])))).toBeNull(); // 自己當父版本
    expect(decodeVaultMessage(tamper(good, (h) => ((h.node as Record<string, unknown>).at = -1)))).toBeNull();
    expect(decodeVaultMessage(new Uint8Array([0, 0, 0]))).toBeNull();
    expect(decodeVaultMessage(new Uint8Array([0xff, 0xff, 0xff, 0xff, 1]))).toBeNull();
  });

  it('刪除版本不能帶內容', () => {
    const del: VaultSyncMessage = { ...good, node: { ...(good as Extract<VaultSyncMessage, { type: 'node' }>).node, deleted: true, hash: '', size: 0 } } as VaultSyncMessage;
    expect(decodeVaultMessage(encodeVaultMessage(del))).toBeNull();
    const { content: _c, ...noContent } = del as Extract<VaultSyncMessage, { type: 'node' }>;
    expect(decodeVaultMessage(encodeVaultMessage(noContent))).toEqual(noContent);
  });
});

describe('寄件序號與簽收單（SDK ADR 0068）', () => {
  it('每一種訊息都可以帶寄件序號 rs（正整數）；不合法的 rs 整則丟掉', () => {
    const withRs = { ...good, rs: 42 } as VaultSyncMessage;
    expect(decodeVaultMessage(encodeVaultMessage(withRs))).toEqual(withRs);
    const want: VaultSyncMessage = { type: 'want', from: 'mac-1', items: [['0'.repeat(32), '1'.repeat(32)]], rs: 7 };
    expect(decodeVaultMessage(encodeVaultMessage(want))).toEqual(want);
    for (const bad of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 2]) expect(decodeVaultMessage(tamper(good, (h) => (h.rs = bad)))).toBeNull();
    // 沒有 rs：照舊
    expect(decodeVaultMessage(encodeVaultMessage(good))).toEqual(good);
  });

  it('receipt：給誰（for）、處理完的序號區間；區間要遞增、不重疊、lo ≤ hi、最多 1000 段；不能帶 rs 與內容', () => {
    const receipt: VaultSyncMessage = { type: 'receipt', from: 'phone', for: 'mac-1', ranges: [[1, 5], [9, 9]] };
    expect(decodeVaultMessage(encodeVaultMessage(receipt))).toEqual(receipt);
    const bads: Array<(h: Record<string, unknown>) => void> = [
      (h) => (h.for = ''),
      (h) => (h.ranges = []),
      (h) => (h.ranges = [[5, 1]]),
      (h) => (h.ranges = [[0, 1]]),
      (h) => (h.ranges = [[1, 5], [3, 9]]),
      (h) => (h.ranges = [[1, 5], [6, 9]]),
      (h) => (h.ranges = Array.from({ length: 1001 }, (_, i) => [i * 3 + 1, i * 3 + 1])),
      (h) => (h.rs = 3),
    ];
    for (const patch of bads) expect(decodeVaultMessage(tamper(receipt, patch))).toBeNull();
  });
});

describe('狀態儲存', () => {
  it('每鍵序列化：同一個鍵的寫入依序完成，讀取等前面的寫入', async () => {
    const order: string[] = [];
    const inner = new MemorySyncStateStore();
    const slow = {
      get: (k: string) => inner.get(k),
      keys: (p: string) => inner.keys(p),
      delete: (k: string) => inner.delete(k),
      set: async (k: string, v: Uint8Array) => {
        const text = new TextDecoder().decode(v);
        await new Promise((r) => setTimeout(r, text === '1' ? 20 : 1));
        order.push(text);
        await inner.set(k, v);
      },
    };
    const store = new SerializedStore(slow);
    const enc = new TextEncoder();
    void store.set('k', enc.encode('1'));
    void store.set('k', enc.encode('2'));
    const value = await store.get('k');
    expect(new TextDecoder().decode(value!)).toBe('2');
    expect(order).toEqual(['1', '2']);
    await store.flush();
  });

  it('寫入失敗不會卡住之後的寫入', async () => {
    let fail = true;
    const inner = new MemorySyncStateStore();
    const store = new SerializedStore({
      get: (k) => inner.get(k),
      keys: (p) => inner.keys(p),
      delete: (k) => inner.delete(k),
      set: async (k, v) => {
        if (fail) {
          fail = false;
          throw new Error('disk full');
        }
        await inner.set(k, v);
      },
    });
    await expect(store.set('k', new Uint8Array([1]))).rejects.toThrow('disk full');
    await store.set('k', new Uint8Array([2]));
    expect([...(await store.get('k'))!]).toEqual([2]);
  });
});
