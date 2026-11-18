// 秘密檔的落盤（SDK ADR 0137）：資料夾自帶 `.gitignore`、檔案 600、絕不覆寫。
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeSecretFileToDisk } from '../../src/cli/secret-file.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cinder-secrets-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('writeSecretFileToDisk（SDK ADR 0137）', () => {
  it('建立資料夾、寫入內容，回傳實際路徑', () => {
    const dir = join(tmp(), '.secrets');
    const path = writeSecretFileToDisk(dir, 'a.env', 'X=1\n');
    expect(path).toBe(join(dir, 'a.env'));
    expect(readFileSync(path, 'utf8')).toBe('X=1\n');
  });

  it('資料夾裡自帶只有 * 的 .gitignore——不靠使用者專案的 .gitignore', () => {
    const dir = join(tmp(), '.secrets');
    writeSecretFileToDisk(dir, 'a.env', 'X=1\n');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('已經有 .gitignore 就不動它', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.gitignore'), 'mine\n');
    writeSecretFileToDisk(dir, 'a.env', 'X=1\n');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('🔴 絕不覆寫：同名檔已存在就改名（可能是另一把仍有效的秘密）', () => {
    const dir = tmp();
    const first = writeSecretFileToDisk(dir, 'a.env', 'OLD=1\n');
    const second = writeSecretFileToDisk(dir, 'a.env', 'NEW=2\n');
    expect(second).not.toBe(first);
    expect(second).toBe(join(dir, 'a-2.env'));
    expect(readFileSync(first, 'utf8')).toBe('OLD=1\n');
    expect(readFileSync(second, 'utf8')).toBe('NEW=2\n');
  });

  it.skipIf(process.platform === 'win32')('POSIX：檔案 600、資料夾 700', () => {
    const dir = join(tmp(), '.secrets');
    const path = writeSecretFileToDisk(dir, 'a.env', 'X=1\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('檔名不能帶路徑', () => {
    expect(() => writeSecretFileToDisk(tmp(), '../a.env', 'X=1\n')).toThrow();
  });
});
