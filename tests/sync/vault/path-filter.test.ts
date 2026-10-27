// 同步排除範圍的語法（SDK ADR 0047）：gitignore 風格、大小寫、路徑分隔、資料夾、萬用字元、反向、驗證訊息。
import { describe, expect, it } from 'vitest';

import {
  combinePathFilters,
  compilePathFilter,
  compileSyncExcludes,
  DEFAULT_USER_EXCLUDES,
  literalPathPattern,
  validatePattern,
} from '../../../src/sync/vault/index.js';

const ex = (patterns: string[] | string, path: string, opts?: { caseInsensitive?: boolean }) => compilePathFilter(patterns, opts).isExcluded(path);

describe('compilePathFilter：基本比對', () => {
  it('沒有斜線的規則比對任何一層的名稱', () => {
    expect(ex(['*.tmp'], 'a.tmp')).toBe(true);
    expect(ex(['*.tmp'], 'notes/sub/a.tmp')).toBe(true);
    expect(ex(['*.tmp'], 'notes/a.tmp.md')).toBe(false);
    expect(ex(['Thumbs.db'], 'photos/2024/Thumbs.db')).toBe(true);
    expect(ex(['Thumbs.db'], 'photos/Thumbs.db.bak')).toBe(false);
  });

  it('名稱比對到資料夾：底下全部排除', () => {
    expect(ex(['node_modules'], 'node_modules/x/index.js')).toBe(true);
    expect(ex(['node_modules'], 'proj/node_modules/x.js')).toBe(true);
    expect(ex(['build'], 'build')).toBe(true);
  });

  it('開頭或中間有斜線：從 Vault 根目錄算起', () => {
    expect(ex(['/build'], 'build/a.js')).toBe(true);
    expect(ex(['/build'], 'src/build/a.js')).toBe(false);
    expect(ex(['docs/private'], 'docs/private/a.md')).toBe(true);
    expect(ex(['docs/private'], 'x/docs/private/a.md')).toBe(false);
    expect(ex(['docs/*.pdf'], 'docs/a.pdf')).toBe(true);
    expect(ex(['docs/*.pdf'], 'docs/sub/a.pdf')).toBe(false);
  });

  it('結尾斜線只比對資料夾', () => {
    expect(ex(['cache/'], 'cache/a.bin')).toBe(true);
    expect(ex(['cache/'], 'x/cache/y/a.bin')).toBe(true);
    // 叫 cache 的檔案不受影響
    expect(ex(['cache/'], 'cache')).toBe(false);
    expect(ex(['cache/'], 'x/cache')).toBe(false);
  });

  it('* 不跨斜線；? 一個字元', () => {
    expect(ex(['/a*'], 'abc/d.md')).toBe(true);
    expect(ex(['/a/*.md'], 'a/b/c.md')).toBe(false);
    expect(ex(['?.md'], 'x/a.md')).toBe(true);
    expect(ex(['?.md'], 'x/ab.md')).toBe(false);
    expect(ex(['a?b'], 'a/b')).toBe(false);
  });

  it('** 的三種位置；其他位置的 ** 等同 *', () => {
    expect(ex(['**/tmp'], 'tmp/x')).toBe(true);
    expect(ex(['**/tmp'], 'a/b/tmp/x')).toBe(true);
    expect(ex(['/logs/**'], 'logs/a/b.txt')).toBe(true);
    expect(ex(['/logs/**'], 'logs')).toBe(false);
    expect(ex(['a/**/b.md'], 'a/b.md')).toBe(true);
    expect(ex(['a/**/b.md'], 'a/x/y/b.md')).toBe(true);
    expect(ex(['a/**/b.md'], 'z/a/x/b.md')).toBe(false);
    expect(ex(['/x**y'], 'xaay')).toBe(true);
    expect(ex(['/x**y'], 'xa/ay')).toBe(false);
  });

  it('字元集合、範圍、反向集合（不含斜線）', () => {
    expect(ex(['file[0-9].md'], 'file3.md')).toBe(true);
    expect(ex(['file[0-9].md'], 'filex.md')).toBe(false);
    expect(ex(['file[!0-9].md'], 'filex.md')).toBe(true);
    expect(ex(['file[^0-9].md'], 'file3.md')).toBe(false);
    expect(ex(['/a[!x]b'], 'a/b')).toBe(false);
    expect(ex(['[]]x'], ']x')).toBe(true);
  });

  it('反斜線跳脫特殊字元', () => {
    expect(ex(['\\*.md'], '*.md')).toBe(true);
    expect(ex(['\\*.md'], 'a.md')).toBe(false);
    expect(ex(['\\#todo'], '#todo')).toBe(true);
    expect(ex(['\\!important'], '!important')).toBe(true);
    expect(ex(['what\\?.md'], 'what?.md')).toBe(true);
    expect(ex(['what\\?.md'], 'whatx.md')).toBe(false);
  });

  it('正規表示式的特殊字元照字面比對', () => {
    expect(ex(['a+b (1).md'], 'x/a+b (1).md')).toBe(true);
    expect(ex(['a.md'], 'aXmd')).toBe(false);
    expect(ex(['$^{}|.md'], '$^{}|.md')).toBe(true);
  });

  it('空行、註解、前後空白、CRLF', () => {
    const f = compilePathFilter('# 暫存檔\r\n\r\n  *.tmp  \r\n');
    expect(f.patterns).toEqual(['*.tmp']);
    expect(f.isExcluded('a.tmp')).toBe(true);
    expect(compilePathFilter([]).isExcluded('a.md')).toBe(false);
  });

  it('開頭的斜線、NFC 正規化', () => {
    expect(ex(['*.tmp'], '/a.tmp')).toBe(true);
    // 「é」：NFD（e + 組合重音）與 NFC 是同一個名稱
    expect(ex(['café.md'.normalize('NFD')], 'notes/café.md'.normalize('NFC'))).toBe(true);
    expect(ex(['café.md'.normalize('NFC')], 'notes/café.md'.normalize('NFD'))).toBe(true);
  });
});

describe('大小寫', () => {
  it('預設不分大小寫（與 defaultPathKey 一致）', () => {
    expect(ex(['.DS_Store'], 'a/.ds_store')).toBe(true);
    expect(ex(['Archive/'], 'ARCHIVE/x.md')).toBe(true);
    expect(ex(['*.TMP'], 'a.tmp')).toBe(true);
    expect(ex(['[A-C].md'], 'b.md')).toBe(true);
    expect(compilePathFilter([]).caseInsensitive).toBe(true);
  });

  it('caseInsensitive: false 區分大小寫', () => {
    expect(ex(['Archive/'], 'archive/x.md', { caseInsensitive: false })).toBe(false);
    expect(ex(['Archive/'], 'Archive/x.md', { caseInsensitive: false })).toBe(true);
    expect(ex(['[A-C].md'], 'b.md', { caseInsensitive: false })).toBe(false);
  });

  it('小寫化後範圍會顛倒的集合照樣可用', () => {
    // Z(0x5A) < a(0x61) 合法；小寫後 z > a 會是不合法的範圍
    const f = compilePathFilter(['[Z-a].md']);
    expect(f.isExcluded('_.md')).toBe(true);
    expect(f.isExcluded('Z.md')).toBe(true);
  });
});

describe('反向（!）', () => {
  it('最後一條符合的規則決定', () => {
    const f = compilePathFilter(['*.pdf', '!keep.pdf']);
    expect(f.isExcluded('a.pdf')).toBe(true);
    expect(f.isExcluded('x/keep.pdf')).toBe(false);
    const g = compilePathFilter(['!keep.pdf', '*.pdf']);
    expect(g.isExcluded('keep.pdf')).toBe(true);
  });

  it('上層資料夾被排除時無法用 ! 重新納入（同 git）', () => {
    const f = compilePathFilter(['archive/', '!archive/keep.md']);
    expect(f.isExcluded('archive/keep.md')).toBe(true);
    expect(f.explain('archive/keep.md')).toEqual({ excluded: true, pattern: 'archive/', via: 'archive' });
    // 正確寫法：排除資料夾裡的內容、而不是資料夾本身
    const g = compilePathFilter(['/archive/**', '!/archive/keep.md']);
    expect(g.isExcluded('archive/a.md')).toBe(true);
    expect(g.isExcluded('archive/keep.md')).toBe(false);
  });

  it('explain 回報決定的規則', () => {
    const f = compilePathFilter(['*.pdf', '!keep.pdf']);
    expect(f.explain('a.pdf')).toEqual({ excluded: true, pattern: '*.pdf' });
    expect(f.explain('keep.pdf')).toEqual({ excluded: false, pattern: '!keep.pdf' });
    expect(f.explain('a.md')).toEqual({ excluded: false });
  });

  it('沒有反向規則時的快速路徑與完整路徑結果相同', () => {
    const patterns = ['*.tmp', 'cache/', '/logs/**', 'a/**/b', 'x?y', '[0-9]*'];
    const fast = compilePathFilter(patterns);
    const slow = compilePathFilter([...patterns, '!never-matches-anything-zzz']);
    const paths = ['a.tmp', 'cache/x', 'logs/a', 'logs', 'a/q/b', 'a/b', 'xzy', '9.md', 'n/9x/y', 'ok.md', 'cache', 'x/cache/y'];
    for (const p of paths) expect(fast.isExcluded(p), p).toBe(slow.isExcluded(p));
  });
});

describe('validatePattern', () => {
  it('合法的規則、空行、註解', () => {
    expect(validatePattern('*.tmp')).toEqual({ ok: true, kind: 'rule' });
    expect(validatePattern('!keep.md')).toEqual({ ok: true, kind: 'negation' });
    expect(validatePattern('   ')).toEqual({ ok: true, kind: 'blank' });
    expect(validatePattern('# 說明')).toEqual({ ok: true, kind: 'comment' });
    expect(validatePattern('/Archive/')).toEqual({ ok: true, kind: 'rule' });
  });

  it.each([
    ['folder\\sub', 'backslash'],
    ['a\\', 'backslash'],
    ['C:/Users/x', 'absolute'],
    ['../x', 'dot-segment'],
    ['a/./b', 'dot-segment'],
    ['a//b', 'empty-segment'],
    ['file[0-9.md', 'unclosed-bracket'],
    ['!', 'empty'],
    ['/', 'empty'],
    ['!/', 'empty'],
    ['a\u0007b', 'control-char'],
    ['x'.repeat(513), 'too-long'],
  ])('%s → %s', (pattern, code) => {
    const result = validatePattern(pattern);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(code);
    expect(result.error?.message.length).toBeGreaterThan(4);
  });

  it('錯誤訊息是給人看的', () => {
    expect(validatePattern('a\\b').error?.message).toMatch(/請用 \/ 分隔/);
    expect(validatePattern('[a').error?.message).toMatch(/\[ 沒有對應的 \]/);
    expect(validatePattern('!').kind).toBe('negation');
  });

  it('排除整個 Vault 的規則給警告（仍然合法）', () => {
    for (const p of ['*', '**', '**/*', '/*']) {
      const r = validatePattern(p);
      expect(r.ok, p).toBe(true);
      if (p !== '/*') expect(r.warning?.code, p).toBe('matches-everything');
    }
    expect(validatePattern('*.md').warning).toBeUndefined();
    expect(validatePattern('!*').warning).toBeUndefined();
  });

  it('compilePathFilter：預設遇到不合法的規則丟錯；skip 略過', () => {
    expect(() => compilePathFilter(['ok.md', 'a\\b'])).toThrow(RangeError);
    expect(() => compilePathFilter(['ok.md', 'a\\b'])).toThrow(/a\\b/);
    const f = compilePathFilter(['ok.md', 'a\\b', '[x'], { invalid: 'skip' });
    expect(f.patterns).toEqual(['ok.md']);
  });

  it('每一條預設規則都合法、沒有警告', () => {
    for (const p of DEFAULT_USER_EXCLUDES) expect(validatePattern(p), p).toEqual({ ok: true, kind: 'rule' });
  });
});

describe('DEFAULT_USER_EXCLUDES', () => {
  const f = compilePathFilter(DEFAULT_USER_EXCLUDES);
  it.each([
    '.DS_Store',
    'notes/.DS_Store',
    'notes/._photo.jpg',
    'Thumbs.db',
    'pics/ehthumbs.db',
    'Desktop.ini',
    'docs/~$報告.docx',
    'docs/.~lock.報告.odt#',
    'a/b.tmp',
    'a/.b.md.swp',
    'a/.b.md.swo',
    'downloads/x.zip.crdownload',
  ])('排除 %s', (path) => expect(f.isExcluded(path)).toBe(true));

  it.each(['notes/a.md', 'a.pdf', 'tmp/a.md', 'notes~.md', 'a.bak', 'a.part', 'Desktop/x.md', '報告.docx', 'lock.md'])('不排除 %s', (path) =>
    expect(f.isExcluded(path)).toBe(false),
  );

  it('凍結，不會被意外改掉', () => {
    expect(Object.isFrozen(DEFAULT_USER_EXCLUDES)).toBe(true);
  });
});

describe('兩層：compileSyncExcludes', () => {
  it('固定排除不能被使用者的 ! 重新納入', () => {
    const f = compileSyncExcludes({ fixed: ['/.obsidian/', '.*'], user: ['!.obsidian/plugins/x.js', '!.hidden.md'] });
    expect(f.isExcluded('.obsidian/plugins/x.js')).toBe(true);
    expect(f.isExcluded('.hidden.md')).toBe(true);
    expect(f.explain('.hidden.md')).toEqual({ excluded: true, pattern: '.*', layer: 'fixed' });
  });

  it('使用者清單省略時用預設值；空清單＝不排除任何東西', () => {
    expect(compileSyncExcludes().isExcluded('a/Thumbs.db')).toBe(true);
    expect(compileSyncExcludes({ user: [] }).isExcluded('a/Thumbs.db')).toBe(false);
    expect(compileSyncExcludes({ user: '' }).user.patterns).toEqual([]);
  });

  it('explain 標示哪一層', () => {
    const f = compileSyncExcludes({ fixed: ['/.trash/'], user: ['*.tmp'] });
    expect(f.explain('a.tmp')).toEqual({ excluded: true, pattern: '*.tmp', layer: 'user' });
    expect(f.explain('.trash/a.md')).toEqual({ excluded: true, pattern: '/.trash/', via: '.trash', layer: 'fixed' });
    expect(f.explain('a.md')).toEqual({ excluded: false });
  });

  it('使用者清單的不合法規則預設略過；固定排除一律丟錯', () => {
    expect(compileSyncExcludes({ user: ['a\\b', '*.tmp'] }).user.patterns).toEqual(['*.tmp']);
    expect(() => compileSyncExcludes({ user: ['a\\b'], invalid: 'throw' })).toThrow(RangeError);
    expect(() => compileSyncExcludes({ fixed: ['a\\b'] })).toThrow(RangeError);
  });

  it('大小寫設定套用到兩層', () => {
    const f = compileSyncExcludes({ fixed: ['/Config/'], user: ['*.TMP'], caseInsensitive: false });
    expect(f.isExcluded('config/a')).toBe(false);
    expect(f.isExcluded('Config/a')).toBe(true);
    expect(f.isExcluded('a.tmp')).toBe(false);
  });
});

describe('literalPathPattern、combinePathFilters', () => {
  it('把確切的路徑變成只比對它的規則', () => {
    expect(literalPathPattern('.obsidian', { dirOnly: true })).toBe('/.obsidian/');
    const p = literalPathPattern('my [config]*!');
    expect(validatePattern(p).ok).toBe(true);
    const f = compilePathFilter([p]);
    expect(f.isExcluded('my [config]*!')).toBe(true);
    expect(f.isExcluded('my [config]*!/a.json')).toBe(true);
    expect(f.isExcluded('my c*!')).toBe(false);
    expect(f.isExcluded('x/my [config]*!')).toBe(false);
  });

  it('combinePathFilters：任何一個排除就排除，接受函式與 null', () => {
    const f = combinePathFilters(compilePathFilter(['*.tmp']), (p) => p.startsWith('x/'), null, undefined);
    expect(f.isExcluded('a.tmp')).toBe(true);
    expect(f.isExcluded('x/a.md')).toBe(true);
    expect(f.isExcluded('a.md')).toBe(false);
  });

  it('CinderSync 現有的固定排除可以用規則表示', () => {
    // sync-paths.ts：configDir、.trash、.git、node_modules（根目錄）、備份資料夾、任何一段以點開頭；不分大小寫
    const f = compileSyncExcludes({ fixed: [literalPathPattern('.obsidian'), '/.trash', '/.git', '/node_modules', '.*'], user: [] });
    for (const p of ['.obsidian/app.json', '.trash/cindersync-backup/a.md', 'Node_Modules/x.js', 'a/.hidden/b.md', '.git/HEAD', 'node_modules']) {
      expect(f.isExcluded(p), p).toBe(true);
    }
    for (const p of ['notes/a.md', 'a/node_modules/x.js', 'x.git/y']) expect(f.isExcluded(p), p).toBe(false);
  });
});
