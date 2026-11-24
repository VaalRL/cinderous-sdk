// 網頁部署設定器的頁面（SDK ADR 0142）：🔴 不發網路請求、選擇不進網址、不存瀏覽器儲存空間；兩種語言都有入口與 CSP。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const component = read('site/.vitepress/components/WebConfigurator.vue');
// 註解裡可以提到這些字（說明為什麼不用），只檢查程式
const code = component.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');

describe('網頁設定器的頁面', () => {
  it('🔴 不發網路請求：沒有 fetch／XMLHttpRequest／WebSocket／EventSource／sendBeacon', () => {
    for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'RTCPeerConnection']) {
      expect(code.includes(api), api).toBe(false);
    }
  });

  it('🔴 選擇不進網址、不存瀏覽器儲存空間', () => {
    for (const api of ['location.search', 'location.hash', 'history.pushState', 'history.replaceState', 'URLSearchParams', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      expect(code.includes(api), api).toBe(false);
    }
  });

  it('只是薄殼：題目、驗證、產出都來自 src/deploy/config（不在頁面裡另寫規則）', () => {
    for (const fn of ['webFormGroups', 'setWebField', 'validateDeployConfig', 'webOutputs', 'webEstimate']) expect(component).toContain(fn);
  });

  it('兩種語言的頁面都有 connect-src none 的 CSP，並掛上設定器', () => {
    for (const [page, locale] of [
      ['site/configurator.md', 'en'],
      ['site/zh-TW/configurator.md', 'zh-TW'],
    ] as const) {
      const md = read(page);
      expect(md).toMatch(/http-equiv: Content-Security-Policy/);
      expect(md).toMatch(/connect-src 'none'/);
      expect(md).toContain(`<WebConfigurator locale="${locale}" />`);
    }
  });

  it('網站導覽（中英）、首頁都有入口，頁面有改寫到網站根目錄', () => {
    const config = read('site/.vitepress/config.mts');
    expect(config).toContain("'site/configurator.md': 'configurator.md'");
    expect(config).toContain("'site/zh-TW/configurator.md': 'zh-TW/configurator.md'");
    expect(config).toContain("link: '/configurator'");
    expect(config).toContain("link: '/zh-TW/configurator'");
    expect(read('site/index.md')).toContain('link: /configurator');
    expect(read('site/zh-TW/index.md')).toContain('link: /zh-TW/configurator');
  });
});

describe('元件的 script 用到的名稱都有宣告或匯入', () => {
  // 實測抓到：換目標時呼叫的 webSwitchTarget 沒匯入，丟 ReferenceError 被 Vue 吞掉，網站建置也不做型別檢查。
  it('編譯後的 <script setup> 沒有「找不到名稱」', async () => {
    const { parse, compileScript } = await import('@vue/compiler-sfc');
    const ts = await import('typescript');
    const { fileURLToPath } = await import('node:url');
    // TypeScript 內部一律用正斜線；Windows 的反斜線路徑會對不上虛擬檔名而被當成不存在（測試就假綠）
    const vuePath = fileURLToPath(new URL('../../site/.vitepress/components/WebConfigurator.vue', import.meta.url)).replace(/\\/g, '/');
    const { descriptor } = parse(component, { filename: vuePath });
    const script = compileScript(descriptor, { id: 'web-configurator' }).content;
    const virtual = `${vuePath}.check.ts`;
    const options: import('typescript').CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true, skipLibCheck: true, resolveJsonModule: true, allowImportingTsExtensions: true, types: [],
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang, ...rest) =>
      name === virtual ? ts.createSourceFile(name, script, lang) : getSourceFile(name, lang, ...rest);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (name) => name === virtual || fileExists(name);
    const program = ts.createProgram([virtual], options, host);
    expect(program.getSourceFile(virtual), '虛擬檔要真的被載入').toBeDefined();
    const missing = ts.getPreEmitDiagnostics(program, program.getSourceFile(virtual))
      .filter((d) => d.code === 2304 || d.code === 2552)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(missing).toEqual([]);
  }, 60_000); // 建一個 TypeScript 程式要載入整個 src/deploy，全套並行時會超過預設的 5 秒
});
