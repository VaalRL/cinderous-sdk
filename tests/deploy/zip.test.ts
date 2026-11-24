// 網頁設定器的 zip 部署包（SDK ADR 0142）：不加相依的最小 STORE（不壓縮）zip 產生器與 CRC-32。
// 驗法：CRC 對標準測試向量與 node:zlib 的 crc32；結構照 PKWARE APPNOTE 逐欄解析；有 `unzip` 就真的解一次。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { crc32, createStoreZip } from '../../src/deploy/zip.js';

const enc = new TextEncoder();

describe('crc32', () => {
  it('標準測試向量：「123456789」＝ 0xCBF43926；空資料＝0', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('與 node:zlib 的 crc32 一致（含中文與二進位）', () => {
    const z = (zlib as unknown as { crc32?: (d: Uint8Array) => number }).crc32;
    const samples = [enc.encode('中繼設定 cinderous.config.json'), Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) & 255)];
    for (const s of samples) {
      if (z) expect(crc32(s)).toBe(z(s));
      else expect(crc32(s)).toBeGreaterThanOrEqual(0);
    }
  });
});

/** 照 APPNOTE 解析：回傳每個中央目錄項目，並對照本機標頭 */
function parseZip(bytes: Uint8Array): { name: string; data: Uint8Array; crc: number; method: number; flags: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  expect(cdOffset + cdSize).toBe(eocd);
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    expect(view.getUint32(p + 24, true)).toBe(size); // STORE：壓縮後＝原大小
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    const lNameLen = view.getUint16(local + 26, true);
    const lExtra = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtra;
    out.push({ name, data: bytes.subarray(start, start + size), crc, method, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('createStoreZip', () => {
  const files = [
    { path: 'cinderous.config.json', content: '{\n  "target": "docker"\n}\n' },
    { path: 'src/entry.mjs', content: '// 中繼入口\nexport default {};\n' },
    { path: 'README-DEPLOY.md', content: '# 部署說明\n' },
  ];

  it('每個檔案都在、內容逐位元組相同、CRC 正確、STORE、UTF-8 檔名旗標', () => {
    const zip = createStoreZip(files, { date: new Date(Date.UTC(2026, 10, 18, 12, 0, 0)) });
    const entries = parseZip(zip);
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.path));
    for (const [i, e] of entries.entries()) {
      const expected = enc.encode(files[i]!.content);
      expect(Array.from(e.data)).toEqual(Array.from(expected));
      expect(e.crc).toBe(crc32(expected));
      expect(e.method).toBe(0);
      expect(e.flags & 0x0800).toBe(0x0800);
    }
  });

  it('可以放進一層根資料夾（解壓後不會散在目前目錄）', () => {
    const entries = parseZip(createStoreZip(files, { root: 'cinder-relay' }));
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => `cinder-relay/${f.path}`));
  });

  it('同樣輸入＋同樣日期 → 同樣位元組（可重現）', () => {
    const date = new Date(Date.UTC(2026, 0, 1));
    expect(Array.from(createStoreZip(files, { date }))).toEqual(Array.from(createStoreZip(files, { date })));
  });

  it('拒絕不安全的路徑：絕對路徑、..、反斜線、空字串、重複', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a\\b', '', 'C:/x']) {
      expect(() => createStoreZip([{ path: bad, content: 'x' }])).toThrow();
    }
    expect(() => createStoreZip([{ path: 'a', content: '1' }, { path: 'a', content: '2' }])).toThrow();
  });

  it('真的 unzip 解得開（有 unzip 才跑）', () => {
    let hasUnzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      hasUnzip = false;
    }
    if (!hasUnzip) return;
    const dir = mkdtempSync(join(tmpdir(), 'cinder-zip-'));
    try {
      writeFileSync(join(dir, 'p.zip'), createStoreZip(files));
      execFileSync('unzip', ['-q', 'p.zip', '-d', 'out'], { cwd: dir });
      for (const f of files) expect(readFileSync(join(dir, 'out', f.path), 'utf8')).toBe(f.content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
