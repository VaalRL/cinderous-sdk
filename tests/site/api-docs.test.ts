// API 參考（SDK ADR 0115）：TypeDoc 的入口點從 package.json 的 exports 推導，不另外維護一份清單。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import typedocConfig, { apiEntryPoints, API_OUT, importPath } from '../../site/typedoc.config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { exports: Record<string, unknown> };

describe('apiEntryPoints', () => {
  it('每個有型別的子路徑都是一個入口點（用發佈出去的 .d.ts，使用方看到的就是這些）', () => {
    expect(
      apiEntryPoints({
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './relay/node': { types: './dist/relay/node.d.ts', import: './dist/relay/node.js' },
      }),
    ).toEqual(['dist/index.d.ts', 'dist/relay/node.d.ts']);
  });

  it('沒有型別的匯出（JSON Schema）不是入口點', () => {
    expect(apiEntryPoints({ './config.schema.json': './schema/cinderous.config.schema.json' })).toEqual([]);
  });

  it('真正的 package.json：除了 JSON Schema 之外每個子路徑都在，而且檔案存在', () => {
    const entries = apiEntryPoints(pkg.exports);
    expect(entries).toHaveLength(Object.keys(pkg.exports).length - 1);
    for (const entry of entries) expect(() => readFileSync(`${root}${entry}`)).not.toThrow();
  });

  it('產出放在 VitePress 的產出裡的 api/（同一個 Pages 部署）', () => {
    expect(API_OUT.replaceAll('\\', '/')).toMatch(/site\/\.vitepress\/dist\/api$/);
  });
});

describe('連結檢查', () => {
  it('連不到的 {@link} 讓建置失敗（CI 的 docs:build 會擋下來）', () => {
    expect(typedocConfig.validation).toMatchObject({ invalidLink: true });
    expect(typedocConfig.treatWarningsAsErrors).toBe(true);
  });
});

describe('importPath', () => {
  it('模組名稱改成使用方 import 的寫法', () => {
    expect(importPath('index')).toBe('@cinderous/client');
    expect(importPath('relay/node')).toBe('@cinderous/client/relay/node');
    expect(importPath('iot/push-gateway')).toBe('@cinderous/client/iot/push-gateway');
  });

  it('每個入口點改名後都是 package.json 裡真的有的子路徑', () => {
    const names = apiEntryPoints(pkg.exports).map((entry) =>
      importPath(entry.replace(/^dist\//, '').replace(/\.d\.ts$/, '').replace(/\/index$/, '')),
    );
    const subpaths = Object.keys(pkg.exports).map((k) => (k === '.' ? '@cinderous/client' : `@cinderous/client${k.slice(1)}`));
    for (const name of names) expect(subpaths).toContain(name);
  });
});
