// 可攜的部署包與部署說明（SDK ADR 0050 §5、§7）：快照測試＋性質（可攜、不含秘密、MIT-0 標頭、確定性）。
import { describe, expect, it } from 'vitest';

import { CLOUDFLARE_TOKEN_SETUP_GUIDE } from '../../src/deploy/cloudflare-api/guide.js';
import {
  type DeployConfig,
  type DeployPackageContext,
  GENERATED_MANIFEST,
  modifiedGeneratedFiles,
  renderDeployGuide,
  renderDeployPackage,
} from '../../src/deploy/config/index.js';
import { relayEnvironment, renderCompose } from '../../src/deploy/render.js';

const ALICE = 'a'.repeat(63) + '1';
const ctx: DeployPackageContext = { sdkVersion: '0.0.0-test', licenseText: 'AGPL-3.0 LICENSE TEXT\n' };

const CONFIGS: Record<string, DeployConfig> = {
  cloudflare: {
    configVersion: 1,
    target: 'cloudflare',
    name: 'my-relay',
    site: { allowedPubkeys: [ALICE], relayName: 'My "relay"', maxFileMb: 17, appLanes: ['dochost'] },
    cloudflare: { accountId: '0123456789abcdef0123456789abcdef', workersDevSubdomain: 'me' },
    secrets: { cloudflareApiToken: { $env: 'CF_TOKEN' } },
  },
  docker: { configVersion: 1, target: 'docker', site: { allowedPubkeys: [ALICE], maxTtlDays: 30 }, node: { port: 9000, persist: true } },
  fly: { configVersion: 1, target: 'fly', name: 'fly-relay', site: { allowedPubkeys: [ALICE] }, node: { persist: true }, fly: { region: 'sin' } },
  'home-tunnel': {
    configVersion: 1,
    target: 'home-tunnel',
    name: 'home',
    site: { allowedPubkeys: [ALICE], maxFileMb: 17, relaySoftwareUrl: 'https://git.example.com/me/fork' },
    node: { persist: true },
    tunnel: { hostname: 'relay.example.com' },
    secrets: { tunnelToken: { $env: 'TUNNEL_TOKEN' } },
  },
  'cloudflare-api': { configVersion: 1, target: 'cloudflare-api', site: { allowedPubkeys: [ALICE] } },
};

const fileMap = (config: DeployConfig, c: DeployPackageContext = ctx) =>
  Object.fromEntries(renderDeployPackage(config, c).files.map((f) => [f.path, f.content]));

describe('renderDeployPackage：每個目標的檔案（快照）', () => {
  for (const [label, config] of Object.entries(CONFIGS)) {
    it(label, () => {
      const pkg = renderDeployPackage(config, ctx);
      expect(pkg.files.map((f) => f.path)).toMatchSnapshot('paths');
      for (const file of pkg.files) expect(file.content).toMatchSnapshot(file.path);
    });
  }
});

describe('renderDeployPackage：性質', () => {
  it('共同檔案：設定檔、兩份說明、.env.example、.gitignore、LICENSE、SOURCE.md、清單', () => {
    for (const config of Object.values(CONFIGS)) {
      const paths = renderDeployPackage(config, ctx).files.map((f) => f.path);
      for (const p of ['cinderous.config.json', 'README-DEPLOY.md', 'README-DEPLOY.en.md', '.env.example', '.gitignore', 'LICENSE', 'SOURCE.md', GENERATED_MANIFEST]) {
        expect(paths, `${config.target}: ${p}`).toContain(p);
      }
    }
  });

  it('🔴 可攜：沒有絕對路徑（Windows 磁碟代號、/home、/Users、反斜線路徑）', () => {
    for (const config of Object.values(CONFIGS)) {
      for (const [path, content] of Object.entries(fileMap(config))) {
        expect(content, `${config.target}:${path}`).not.toMatch(/(?<![A-Za-z0-9_-])[A-Za-z]:[\\/]|\/home\/|\/Users\/|node_modules\/@cinderous/);
      }
    }
  });

  it('🔴 不含秘密值：環境裡的 Token 不會出現在任何檔案；.env 與 .secrets/ 被 .gitignore 與 .dockerignore 排除', () => {
    const files = fileMap(CONFIGS['home-tunnel']!);
    expect(files['.gitignore']).toMatch(/^\.env$/m);
    expect(files['.gitignore']).toMatch(/^\.secrets\/$/m);
    expect(files['.dockerignore']).toMatch(/^\.env$/m);
    expect(files['.env.example']).toMatch(/^TUNNEL_TOKEN=$/m);
    expect(files['docker-compose.yml']).toContain('${TUNNEL_TOKEN:?');
  });

  it('產生的設定與膠水程式有 MIT-0 標頭；預打包的中繼是 AGPL', () => {
    const pkg = renderDeployPackage(CONFIGS.cloudflare!, { ...ctx, selfContained: true, relayWorkerSource: 'export default {};' });
    for (const file of pkg.files) {
      if (['wrangler.toml', 'src/entry.mjs', '.env.example', '.gitignore', '.dev.vars.example'].includes(file.path)) {
        expect(file.content, file.path).toContain('SPDX-License-Identifier: MIT-0');
        expect(file.license).toBe('MIT-0');
      }
    }
    expect(pkg.files.find((f) => f.path === 'src/relay.mjs')).toMatchObject({ license: 'AGPL-3.0-only' });
    expect(pkg.files.find((f) => f.path === 'src/relay.mjs')!.content).toContain('SPDX-License-Identifier: AGPL-3.0-only');
    expect(pkg.files.find((f) => f.path === 'LICENSE')!.content).toBe(ctx.licenseText);
    expect(pkg.copySdk).toBe(false);
    const entry = pkg.files.find((f) => f.path === 'src/entry.mjs')!.content;
    expect(entry).toContain("from './relay.mjs'");
    expect(JSON.parse(pkg.files.find((f) => f.path === 'package.json')!.content).dependencies).toBeUndefined();
  });

  it('SDK 來源：預設內嵌 sdk/（file:./sdk）；spec 改成套件相依、Dockerfile 不複製 sdk/', () => {
    expect(renderDeployPackage(CONFIGS.docker!, ctx).copySdk).toBe(true);
    expect(JSON.parse(fileMap(CONFIGS.docker!)['package.json']!).dependencies['@cinderous/client']).toBe('file:./sdk');
    const spec = { ...ctx, sdkSource: { kind: 'spec' as const, spec: 'github:VaalRL/cinderous-sdk#v0.0.0-test' } };
    const pkg = renderDeployPackage(CONFIGS.docker!, spec);
    expect(pkg.copySdk).toBe(false);
    const files = Object.fromEntries(pkg.files.map((f) => [f.path, f.content]));
    expect(JSON.parse(files['package.json']!).dependencies['@cinderous/client']).toBe('github:VaalRL/cinderous-sdk#v0.0.0-test');
    expect(files.Dockerfile).not.toContain('COPY sdk');
  });

  it('Workers 的入口 import 套件名稱（不寫路徑），wrangler.toml 指向它；Account ID 寫死時進 wrangler.toml', () => {
    const files = fileMap(CONFIGS.cloudflare!);
    expect(files['src/entry.mjs']).toContain("from '@cinderous/client/relay/worker'");
    expect(files['wrangler.toml']).toContain('main = "src/entry.mjs"');
    expect(files['wrangler.toml']).toContain('account_id = "0123456789abcdef0123456789abcdef"');
    expect(files['wrangler.toml']).toContain('APP_LANES = "dochost"');
    expect(JSON.parse(files['package.json']!).devDependencies.wrangler).toBe('^4');
    expect(files['.env.example']).toMatch(/^CF_TOKEN=$/m);
  });

  it('home-tunnel：relay 不發布埠、TRUST_PROXY=1、cloudflared 從 .env 讀 Token；與 docker 目標同一個產生器', () => {
    const compose = fileMap(CONFIGS['home-tunnel']!)['docker-compose.yml']!;
    expect(compose).not.toContain('ports:');
    expect(compose).toContain('expose:');
    expect(compose).toContain('TRUST_PROXY: "1"');
    expect(compose).toContain('RELAY_SOFTWARE_URL: "https://git.example.com/me/fork"');
    expect(compose).toContain('cloudflared:');
    expect(compose).toContain('image: "cloudflare/cloudflared:latest"');
    // 沒有 tunnel 的 compose 與 v0.37 逐位元組相同（只差標頭）
    const plain = renderCompose({ name: 'r', port: 8080, environment: relayEnvironment({ persist: true, trustProxy: false }) });
    expect(plain).toContain('ports:');
    expect(plain).not.toContain('cloudflared');
  });

  it('設定檔寫回時記下 SDK 版號，鍵的順序固定', () => {
    const written = JSON.parse(fileMap(CONFIGS.docker!)['cinderous.config.json']!) as Record<string, unknown>;
    expect(written.sdk).toBe('0.0.0-test');
    expect(Object.keys(written)).toEqual(['configVersion', 'sdk', 'target', 'site', 'node']);
  });

  it('確定性：同一份設定產生同一組檔案（沒有時間戳記）', () => {
    for (const config of Object.values(CONFIGS)) expect(renderDeployPackage(config, ctx)).toEqual(renderDeployPackage(config, ctx));
  });

  it('設定有錯就丟例外並列出全部錯誤；--self-contained 只給 Workers', () => {
    expect(() => renderDeployPackage({ configVersion: 1, target: 'docker', site: { appLanes: ['x'], maxTtlDays: 0 } }, ctx)).toThrow(/2 個錯誤[\s\S]*appLanes[\s\S]*maxTtlDays/);
    expect(() => renderDeployPackage(CONFIGS.docker!, { ...ctx, selfContained: true, relayWorkerSource: 'x' })).toThrow('Workers');
  });

  it('清單：重新產生前找出被手改過的檔案', () => {
    const files = fileMap(CONFIGS.docker!);
    const manifest = files[GENERATED_MANIFEST]!;
    expect(modifiedGeneratedFiles(manifest, (p) => files[p])).toEqual([]);
    expect(modifiedGeneratedFiles(manifest, (p) => (p === 'docker-compose.yml' ? `${files[p]}# 手改\n` : files[p]))).toEqual(['docker-compose.yml']);
    expect(modifiedGeneratedFiles(manifest, () => undefined)).toEqual([]); // 不存在的檔案不算手改
  });
});

describe('renderDeployGuide（zh-TW、en）', () => {
  it('🔴 Cloudflare 的 Token 步驟取自 CLOUDFLARE_TOKEN_SETUP_GUIDE（不另外抄一份）', () => {
    for (const locale of ['zh-TW', 'en'] as const) {
      const guide = renderDeployGuide(CONFIGS.cloudflare!, locale, { sdkVersion: '1.2.3' });
      const source = CLOUDFLARE_TOKEN_SETUP_GUIDE[locale];
      for (const id of ['check-permissions', 'account-resources', 'ttl', 'create', 'copy'] as const) {
        expect(guide, `${locale}:${id}`).toContain(source.steps.find((s) => s.id === id)!.body);
      }
      expect(guide).toContain(source.links.createToken);
      expect(guide).toContain('npx wrangler@4 login');
    }
  });

  it('每個目標兩種語言都有：健康檢查、回滾、升級、安全檢查清單、授權', () => {
    for (const config of Object.values(CONFIGS)) {
      const zh = renderDeployGuide(config, 'zh-TW', { sdkVersion: '1.2.3' });
      const en = renderDeployGuide(config, 'en', { sdkVersion: '1.2.3' });
      for (const [text, heading] of [[zh, '## 5. 健康檢查'], [zh, '## 6. 回滾'], [zh, '## 7. 升級'], [zh, '## 9. 安全檢查清單'], [zh, '## 10. 授權'], [en, '## 5. Health check'], [en, '## 6. Roll back'], [en, '## 7. Upgrade'], [en, '## 9. Security checklist'], [en, '## 10. License']] as const) {
        expect(text, `${config.target}:${heading}`).toContain(heading);
      }
      expect(zh).toContain('/healthz');
      expect(en).toContain('application/nostr+json');
      expect(en).toContain('`1.2.3`');
    }
  });

  it('🔴 Workers 的回滾段落警告 appLanes：回滾拿不回舊 DO 的資料', () => {
    expect(renderDeployGuide(CONFIGS.cloudflare!, 'zh-TW', { sdkVersion: '1' })).toContain('回滾拿不回舊 DO 的資料');
    expect(renderDeployGuide(CONFIGS.cloudflare!, 'en', { sdkVersion: '1' })).toContain('does not bring the old DO');
  });

  it('端點：workers.dev 子網域、fly.dev、Tunnel 主機名稱、localhost', () => {
    expect(renderDeployGuide(CONFIGS.cloudflare!, 'en', { sdkVersion: '1' })).toContain('wss://my-relay.me.workers.dev');
    expect(renderDeployGuide(CONFIGS.fly!, 'en', { sdkVersion: '1' })).toContain('wss://fly-relay.fly.dev');
    expect(renderDeployGuide(CONFIGS['home-tunnel']!, 'en', { sdkVersion: '1' })).toContain('wss://relay.example.com');
    expect(renderDeployGuide(CONFIGS.docker!, 'en', { sdkVersion: '1' })).toContain('ws://localhost:9000');
  });

  it('沒有白名單時在摘要與安全清單都標紅', () => {
    const guide = renderDeployGuide({ configVersion: 1, target: 'docker' }, 'zh-TW', { sdkVersion: '1' });
    expect(guide).toContain('🔴 沒有——這是開放中繼');
    expect(guide).toContain('🔴 沒有白名單');
  });
});
