// 部署設定參考頁（SDK ADR 0116）：從 DEPLOY_OPTION_SPECS 產生，提交進 docs/reference/；改了描述表沒重新產生就失敗。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEPLOY_OPTION_SPECS, type DeployOptionSpec } from '../../src/deploy/config/index.js';
import { DEPLOY_REFERENCE_FILES, renderDeployReference } from '../../site/deploy-reference.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const spec = (over: Partial<DeployOptionSpec>): DeployOptionSpec => ({
  path: 'site.example',
  type: 'string',
  group: 'basic',
  description: { 'zh-TW': '中文說明', en: 'English text' },
  ...over,
});

describe('renderDeployReference', () => {
  it('每個欄位一節：路徑、說明、型別、預設、旗標、環境變數', () => {
    const md = renderDeployReference(
      [spec({ path: 'site.maxTtlDays', type: 'integer', range: { min: 1, max: 30 }, default: 7, flag: 'max-ttl-days', env: 'MAX_TTL_DAYS', group: 'limits' })],
      'en',
    );
    expect(md).toContain('### `site.maxTtlDays`');
    expect(md).toContain('English text');
    expect(md).toContain('integer, 1–30');
    expect(md).toContain('`7`');
    expect(md).toContain('`--max-ttl-days`');
    expect(md).toContain('`MAX_TTL_DAYS`');
  });

  it('中文版用中文說明與中文標籤', () => {
    const md = renderDeployReference([spec({ flag: 'name' })], 'zh-TW');
    expect(md).toContain('中文說明');
    expect(md).not.toContain('English text');
    expect(md).toContain('旗標');
  });

  it('秘密、必填、危險、只限某宿主或目標都寫出來', () => {
    const md = renderDeployReference(
      [
        spec({ path: 'secrets.tunnelToken', type: 'secret-ref', secret: true, defaultEnv: 'TUNNEL_TOKEN', targets: ['home-tunnel'], requiredFor: ['home-tunnel'], group: 'secrets' }),
        spec({ path: 'site.appLanes', type: 'string-list', hosts: ['worker'], dangerous: true, group: 'lanes' }),
      ],
      'en',
    );
    expect(md).toContain('{ "$env": "NAME" }');
    expect(md).toContain('`TUNNEL_TOKEN`');
    expect(md).toMatch(/Required for.*`home-tunnel`/);
    expect(md).toMatch(/Cloudflare \(Worker\)/);
    expect(md).toMatch(/Dangerous/);
  });

  it('列舉值、長度、清單上限、格式都寫出來', () => {
    const md = renderDeployReference(
      [
        spec({ path: 'target', type: 'enum', enum: ['cloudflare', 'docker'] }),
        spec({ path: 'site.relayName', maxLength: 64 }),
        spec({ path: 'site.lanes', type: 'string-list', maxItems: 8, pattern: /^[a-z]+$/ }),
      ],
      'en',
    );
    expect(md).toContain('`cloudflare`, `docker`');
    expect(md).toContain('at most 64 characters');
    expect(md).toContain('at most 8 items');
    expect(md).toContain('`^[a-z]+$`');
  });

  it('說明裡反引號外的 <id> 之類跳脫成文字（GitHub 才不會吃掉），反引號裡的不動', () => {
    const md = renderDeployReference([spec({ description: { 'zh-TW': 'x', en: 'connect to wss://<host>/app/<id>, not `<b>`' } })], 'en');
    expect(md).toContain('wss://&lt;host&gt;/app/&lt;id&gt;');
    expect(md).toContain('`<b>`');
  });

  it('總覽表一列一個欄位（不連錨點：GitHub 與 VitePress 對 `site.x` 產生的錨點不同）', () => {
    const md = renderDeployReference([spec({ path: 'site.a', flag: 'x', env: 'A' }), spec({ path: 'b' })], 'en');
    expect(md).toContain('| `site.a` | `--x` | `A` |');
    expect(md).toContain('| `b` | — | — |');
  });
});

describe('docs/reference/ 的檔案', () => {
  for (const [lang, file] of Object.entries(DEPLOY_REFERENCE_FILES)) {
    it(`${file} 與描述表一致（不一致：npm run docs:reference）`, () => {
      expect(readFileSync(`${root}${file}`, 'utf8')).toBe(renderDeployReference(DEPLOY_OPTION_SPECS, lang as 'en' | 'zh-TW'));
    });
  }

  it('每個欄位都在頁面上', () => {
    const md = renderDeployReference(DEPLOY_OPTION_SPECS, 'en');
    for (const s of DEPLOY_OPTION_SPECS) expect(md).toContain(`### \`${s.path}\``);
  });
});
