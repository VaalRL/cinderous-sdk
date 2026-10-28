// 說明網站（SDK ADR 0113）的頁面範圍與相對連結的處理。
// 頁面＝repo 裡所有 Markdown，扣掉不公開的路徑（ADR 0110；清單與匯出腳本共用 scripts/public-exclude.json）。
// 相對連結：指向頁面的交給 VitePress；指向不公開路徑的只留文字；指向其他檔案的連到 GitHub 上的同一個路徑。
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

export const REPO_URL = 'https://github.com/VaalRL/cinderous-sdk';

export const PRIVATE_PATHS: readonly string[] = JSON.parse(
  readFileSync(new URL('../../scripts/public-exclude.json', import.meta.url), 'utf8'),
) as string[];

/** repo 根目錄起算的路徑是否在不公開清單裡（清單項目本身或它底下） */
export function isPrivate(path: string): boolean {
  const p = path.replace(/\/+$/, '');
  return PRIVATE_PATHS.some((e) => p === e || p.startsWith(`${e}/`));
}

/** repo 根目錄起算的路徑是否是網站的頁面 */
export function isPage(path: string): boolean {
  return path.endsWith('.md') && !isPrivate(path);
}

export type LinkTarget = { kind: 'keep' } | { kind: 'text' } | { kind: 'github'; href: string };

/** `href` 寫在 `fromPage`（repo 根目錄起算）裡時該怎麼處理 */
export function classifyLink(href: string, fromPage: string): LinkTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return { kind: 'keep' };
  const hashAt = href.indexOf('#');
  const path = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const resolved = posix.normalize(posix.join(posix.dirname(fromPage), path));
  if (resolved === '..' || resolved.startsWith('../')) return { kind: 'text' };
  if (isPrivate(resolved)) return { kind: 'text' };
  if (isPage(resolved)) return { kind: 'keep' };
  const trailing = path.endsWith('/') && !resolved.endsWith('/') ? '/' : '';
  return { kind: 'github', href: `${REPO_URL}/blob/main/${resolved}${trailing}${hash}` };
}

type Token = { type: string; tag: string; content: string; attrs: [string, string][] | null; children: Token[] | null };
type Md = { core: { ruler: { push(name: string, fn: (state: { tokens: Token[]; env: { relativePath?: string } }) => void): void } } };

/** markdown-it 外掛：依 `classifyLink` 改寫 inline 連結；只留文字的連結改成 `<span>` */
export function siteLinks(md: Md): void {
  md.core.ruler.push('cinderous_site_links', (state) => {
    const from = state.env.relativePath ?? '';
    for (const block of state.tokens) {
      const stack: Token[] = [];
      for (const t of block.children ?? []) {
        if (t.type === 'link_open') {
          const href = t.attrs?.find(([k]) => k === 'href')?.[1] ?? '';
          const target = classifyLink(href, from);
          if (target.kind === 'text') {
            t.tag = 'span';
            t.attrs = null;
          } else if (target.kind === 'github') {
            t.attrs = (t.attrs ?? []).map(([k, v]) => [k, k === 'href' ? target.href : v]);
          }
          stack.push(t);
        } else if (t.type === 'link_close') {
          const open = stack.pop();
          if (open?.tag === 'span') t.tag = 'span';
        }
      }
    }
  });
}

/** 頁面裡可以照原樣輸出的 HTML 標籤；其他的（例如 ADR 裡的 `<id>` 佔位符）Vue 會當成元素而編譯失敗 */
const KNOWN_HTML = new Set(['a', 'b', 'br', 'code', 'details', 'div', 'em', 'i', 'img', 'kbd', 'p', 'pre', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr']);

/** markdown-it 外掛：不認得的 inline HTML 標籤改成文字 */
export function escapeUnknownHtml(md: Md): void {
  md.core.ruler.push('cinderous_escape_unknown_html', (state) => {
    for (const block of state.tokens) {
      for (const t of block.children ?? []) {
        if (t.type !== 'html_inline') continue;
        const name = /^<\/?([A-Za-z][\w-]*)/.exec(t.content)?.[1]?.toLowerCase();
        if (name === undefined || !KNOWN_HTML.has(name)) t.type = 'text';
      }
    }
  });
}

/** 網站用的 markdown-it 設定（config.mts 與測試共用） */
export function siteMarkdown(md: Md): void {
  siteLinks(md);
  escapeUnknownHtml(md);
}
