// 建立 Cloudflare API Token 的步驟說明（SDK ADR 0022）。外掛設定頁直接渲染這份資料，
// 所以它必須跟實作對得上：每個錯誤分類都有說明、權限與 Token 名稱來自同一份常數。
import { describe, expect, it } from 'vitest';

import {
  buildCloudflareTokenSetupGuide,
  buildTokenCreationUrl,
  CLOUDFLARE_ERROR_KINDS,
  CLOUDFLARE_TOKEN_SETUP_GUIDE,
  type CloudflareErrorKind,
  DEFAULT_TOKEN_NAME,
  REQUIRED_TOKEN_PERMISSIONS,
  TOKEN_GUIDE_LOCALES,
} from '../../src/deploy/cloudflare-api/index.js';

const guides = TOKEN_GUIDE_LOCALES.map((locale) => [locale, CLOUDFLARE_TOKEN_SETUP_GUIDE[locale]] as const);
const allText = (guide: (typeof CLOUDFLARE_TOKEN_SETUP_GUIDE)['en']): string =>
  [
    ...guide.prerequisites,
    ...guide.steps.flatMap((step) => [step.title, step.body]),
    ...Object.values(guide.troubleshooting).flatMap((t) => [t.symptom, t.cause, t.fix]),
    ...guide.notes,
  ].join('\n');

describe('CLOUDFLARE_TOKEN_SETUP_GUIDE', () => {
  it('提供 zh-TW 與 en 兩種語言', () => {
    expect([...TOKEN_GUIDE_LOCALES].sort()).toEqual(['en', 'zh-TW']);
    expect(Object.keys(CLOUDFLARE_TOKEN_SETUP_GUIDE).sort()).toEqual(['en', 'zh-TW']);
  });

  it('CLOUDFLARE_ERROR_KINDS 列出 CloudflareApiError 的每一種 kind', () => {
    // 型別層面：新增 kind 時 Record<CloudflareErrorKind, …> 會讓 typecheck 失敗；這裡再守一次執行期
    const kinds: CloudflareErrorKind[] = [
      'token-invalid',
      'permission',
      'account-ambiguous',
      'subdomain-missing',
      'name-conflict',
      'quota',
      'network',
      'lane-change',
      'health',
      'worker-download',
      'worker-integrity',
      'api',
    ];
    expect([...CLOUDFLARE_ERROR_KINDS].sort()).toEqual([...kinds].sort());
  });

  for (const [locale, guide] of guides) {
    describe(locale, () => {
      it('每個錯誤分類都有「看到什麼、原因、怎麼做」', () => {
        expect(Object.keys(guide.troubleshooting).sort()).toEqual([...CLOUDFLARE_ERROR_KINDS].sort());
        for (const kind of CLOUDFLARE_ERROR_KINDS) {
          const entry = guide.troubleshooting[kind];
          expect(entry.symptom.trim(), `${locale} ${kind} symptom`).not.toBe('');
          expect(entry.cause.trim(), `${locale} ${kind} cause`).not.toBe('');
          expect(entry.fix.trim(), `${locale} ${kind} fix`).not.toBe('');
        }
      });

      it('有事前準備與 9 個有序步驟（0–8），每步都有標題與說明', () => {
        expect(guide.prerequisites.length).toBeGreaterThan(0);
        expect(guide.steps).toHaveLength(9);
        for (const step of guide.steps) {
          expect(step.title.trim()).not.toBe('');
          expect(step.body.trim()).not.toBe('');
        }
      });

      it('步驟列出的權限正是 REQUIRED_TOKEN_PERMISSIONS，且沒有別的權限', () => {
        const permissionStep = guide.steps.find((step) => step.permissions !== undefined);
        expect(permissionStep?.permissions).toEqual(REQUIRED_TOKEN_PERMISSIONS.map((p) => p.label));
        for (const label of REQUIRED_TOKEN_PERMISSIONS.map((p) => p.label)) {
          expect(permissionStep!.body).toContain(label);
        }
        // 其他步驟不會寫出不在清單裡的「Account → … → …」權限
        const mentioned = allText(guide).match(/Account → [^→\n]+ → (?:Edit|Read)/g) ?? [];
        for (const label of mentioned) {
          expect(REQUIRED_TOKEN_PERMISSIONS.map((p) => p.label)).toContain(label);
        }
      });

      it('Token 名稱與 DEFAULT_TOKEN_NAME 一致', () => {
        expect(guide.tokenName).toBe(DEFAULT_TOKEN_NAME);
        expect(allText(guide)).toContain(DEFAULT_TOKEN_NAME);
      });

      it('Token 建立頁的網址就是 buildTokenCreationUrl() 的結果', () => {
        expect(guide.links.createToken).toBe(buildTokenCreationUrl());
        expect(guide.links.signUp).toBe('https://dash.cloudflare.com/sign-up');
        expect(guide.links.apiTokens).toBe('https://dash.cloudflare.com/profile/api-tokens');
      });

      it('提到 token 只顯示一次、外掛不保存 token', () => {
        const text = allText(guide);
        if (locale === 'zh-TW') {
          expect(text).toContain('只會顯示這一次');
          expect(text).toContain('不會保存');
        } else {
          expect(text).toMatch(/only once/i);
          expect(text).toMatch(/does not store|never stores/i);
        }
      });
    });
  }

  it('兩種語言的步驟數與按鈕名稱對得上（英文介面名稱照 Cloudflare 原文）', () => {
    const zh = CLOUDFLARE_TOKEN_SETUP_GUIDE['zh-TW'];
    const en = CLOUDFLARE_TOKEN_SETUP_GUIDE.en;
    expect(zh.steps.length).toBe(en.steps.length);
    for (const button of ['Continue to summary', 'Create Token', 'Copy', 'All accounts']) {
      expect(allText(zh)).toContain(button);
      expect(allText(en)).toContain(button);
    }
  });

  it('自訂 Token 名稱時，說明與網址一起換', () => {
    const guide = buildCloudflareTokenSetupGuide({ tokenName: 'My vault relay' });
    expect(guide.en.tokenName).toBe('My vault relay');
    expect(guide.en.links.createToken).toBe(buildTokenCreationUrl({ name: 'My vault relay' }));
    expect(allText(guide['zh-TW'])).toContain('My vault relay');
    expect(allText(guide['zh-TW'])).not.toContain(DEFAULT_TOKEN_NAME);
  });

  it('應用名稱預設 Obsidian，可以換', () => {
    const paste = (g: (typeof CLOUDFLARE_TOKEN_SETUP_GUIDE)['en']) => g.steps.find((s) => s.id === 'paste-and-deploy')!.body;
    expect(paste(CLOUDFLARE_TOKEN_SETUP_GUIDE['zh-TW'])).toContain('回到 Obsidian');
    expect(paste(CLOUDFLARE_TOKEN_SETUP_GUIDE.en)).toContain('Back in Obsidian');
    const custom = buildCloudflareTokenSetupGuide({ appName: 'My App' });
    expect(paste(custom['zh-TW'])).toContain('回到 My App');
    expect(paste(custom.en)).toContain('Back in My App');
  });

  it('是純資料：可以 JSON 序列化，而且凍結', () => {
    expect(JSON.parse(JSON.stringify(CLOUDFLARE_TOKEN_SETUP_GUIDE))).toEqual(CLOUDFLARE_TOKEN_SETUP_GUIDE);
    expect(Object.isFrozen(CLOUDFLARE_TOKEN_SETUP_GUIDE)).toBe(true);
    expect(Object.isFrozen(CLOUDFLARE_TOKEN_SETUP_GUIDE.en.steps)).toBe(true);
  });
});
