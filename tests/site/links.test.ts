// 說明網站（SDK ADR 0113）：Markdown 裡的相對連結怎麼處理，以及哪些檔案是網站的頁面。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMarkdownRenderer } from 'vitepress';
import { describe, expect, it } from 'vitest';
import { PRIVATE_PATHS, REPO_URL, classifyLink, isPage, isPrivate, siteMarkdown } from '../../site/.vitepress/links.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
// VitePress 會快取同一個 renderer：整個檔案只建一次，掛上與網站相同的設定
const renderer = createMarkdownRenderer(root, { config: (m) => m.use(siteMarkdown) });

describe('classifyLink', () => {
  it('網站的頁面（.md）保留原樣，交給 VitePress 處理', () => {
    expect(classifyLink('docs/adr/0110-public-github-repo-not-npm.md', 'README.md')).toEqual({ kind: 'keep' });
    expect(classifyLink('0109-vps-self-host-guide.md#驗證', 'docs/adr/0110-x.md')).toEqual({ kind: 'keep' });
    expect(classifyLink('../../SECURITY.md', 'docs/guides/self-host-vps.md')).toEqual({ kind: 'keep' });
  });

  it('外部網址、站內絕對路徑、頁內錨點不動', () => {
    for (const href of ['https://github.com/nostr-protocol/nips', 'mailto:a@example.com', '/docs/adr/README.md', '#install', '//cdn.example.com/x']) {
      expect(classifyLink(href, 'README.md')).toEqual({ kind: 'keep' });
    }
  });

  it('不公開的路徑（ADR 0110）只留文字，不產生連結', () => {
    expect(classifyLink('docs/companion-specs/cindersync/README.md', 'README.md')).toEqual({ kind: 'text' });
    expect(classifyLink('../reports/iot-r0-poc.md', 'docs/adr/0049-x.md')).toEqual({ kind: 'text' });
    expect(classifyLink('RESEARCH-JOURNEY.md', 'PRD.md')).toEqual({ kind: 'text' });
    expect(classifyLink('poc/', 'README.md')).toEqual({ kind: 'text' });
  });

  it('其他檔案與資料夾連到 GitHub 上的同一個路徑（保留錨點）', () => {
    expect(classifyLink('LICENSE', 'README.md')).toEqual({ kind: 'github', href: `${REPO_URL}/blob/main/LICENSE` });
    expect(classifyLink('../../src/relay/worker.ts#L10', 'docs/adr/0111-x.md')).toEqual({
      kind: 'github',
      href: `${REPO_URL}/blob/main/src/relay/worker.ts#L10`,
    });
    expect(classifyLink('./examples/iot-device/', 'README.md')).toEqual({ kind: 'github', href: `${REPO_URL}/blob/main/examples/iot-device/` });
  });

  it('跳出 repo 根目錄的連結只留文字', () => {
    expect(classifyLink('../../../elsewhere.md', 'docs/adr/0001-x.md')).toEqual({ kind: 'text' });
  });
});

describe('哪些檔案是頁面', () => {
  it('不公開清單與匯出腳本用的是同一份（scripts/public-exclude.json）', () => {
    expect(PRIVATE_PATHS).toEqual(JSON.parse(readFileSync(`${root}scripts/public-exclude.json`, 'utf8')));
  });

  it('每一份被追蹤的 Markdown：不是頁面，就是在不公開清單裡', () => {
    const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) expect(isPage(file) !== isPrivate(file), file).toBe(true);
    expect(isPage('README.md')).toBe(true);
    expect(isPage('docs/companion-specs/cindersync/README.md')).toBe(false);
  });
});

describe('markdown-it 外掛：連結', () => {
  it('依分類改寫連結', async () => {
    const md = await renderer;
    const html = md.render(
      '[spec](docs/companion-specs/cindersync/README.md) [license](LICENSE) [adr](docs/adr/0110-public-github-repo-not-npm.md) [nips](https://github.com/nostr-protocol/nips)',
      { relativePath: 'README.md' },
    );
    expect(html).not.toContain('companion-specs');
    expect(html).toContain('spec');
    expect(html).toContain(`href="${REPO_URL}/blob/main/LICENSE"`);
    expect(html).toContain('0110-public-github-repo-not-npm');
    expect(html).toContain('href="https://github.com/nostr-protocol/nips"');
  });
});

describe('不認得的 HTML 標籤當文字（ADR 裡的 `<id>` 之類會讓 Vue 編譯失敗）', () => {
  it('佔位符跳脫、常見的 HTML 標籤保留', async () => {
    const md = await renderer;
    const html = md.render('第 0 顆＝blind("dev:<id>")，其餘＝blind("dev:<id>|<n>")<br>換行 <kbd>Ctrl</kbd>', { relativePath: 'docs/adr/0049-x.md' });
    expect(html).toContain('&lt;id&gt;');
    expect(html).toContain('&lt;n&gt;');
    expect(html).toContain('<br>');
    expect(html).toContain('<kbd>Ctrl</kbd>');
  });
});
