// 說明網站（SDK ADR 0113）：直接以 repo 根目錄當來源，README、指南、ADR、CHANGELOG 原檔就是頁面。
// 部署在 https://vaalrl.github.io/cinderous-sdk/（.github/workflows/pages.yml，只在公開 repo 跑）。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { PRIVATE_PATHS, REPO_URL, siteMarkdown } from './links.js';

const guide = (lang: 'en' | 'zh-TW') => {
  const zh = lang === 'zh-TW';
  return [
    {
      text: zh ? '開始' : 'Start',
      items: [
        { text: zh ? '說明（README）' : 'Overview (README)', link: zh ? '/README.zh-TW' : '/README' },
        { text: zh ? '產品規格（PRD）' : 'Product spec (PRD)', link: '/PRD' },
      ],
    },
    {
      text: zh ? '自架中繼' : 'Self-host a relay',
      items: [
        { text: zh ? 'VPS 自架指南' : 'VPS guide', link: '/docs/guides/self-host-vps' },
        { text: zh ? 'Cloudflare API token' : 'Cloudflare API token', link: '/docs/guides/cloudflare-api-token' },
        { text: zh ? 'IoT 裝置範例' : 'IoT device example', link: '/examples/iot-device/README' },
      ],
    },
    {
      text: zh ? '專案' : 'Project',
      items: [
        { text: zh ? '設計決策（ADR）' : 'Design decisions (ADR)', link: '/docs/adr/README' },
        { text: zh ? '版本紀錄' : 'Changelog', link: '/CHANGELOG' },
        { text: zh ? '安全政策' : 'Security', link: '/SECURITY' },
        { text: zh ? '貢獻指南' : 'Contributing', link: '/CONTRIBUTING' },
        { text: zh ? '第三方授權' : 'Third-party notices', link: '/THIRD-PARTY-NOTICES' },
      ],
    },
  ];
};

export default defineConfig({
  title: 'Cinderous SDK',
  description: 'Private, local-first sync and collaboration over Nostr — AGPL-3.0 TypeScript client and relay.',
  base: '/cinderous-sdk/',
  srcDir: '..',
  srcExclude: ['**/node_modules/**', 'dist/**', 'site/.vitepress/**', ...PRIVATE_PATHS.map((p) => (p.endsWith('.md') ? p : `${p}/**`))],
  rewrites: { 'site/index.md': 'index.md', 'site/zh-TW/index.md': 'zh-TW/index.md' },
  lastUpdated: false,
  head: [['link', { rel: 'icon', href: '/cinderous-sdk/logo.svg', type: 'image/svg+xml' }]],
  markdown: { config: (md) => md.use(siteMarkdown) },
  // 圖示直接用 repo 的 assets/（不另存一份）
  vite: { publicDir: fileURLToPath(new URL('../../assets', import.meta.url)) },
  themeConfig: {
    logo: '/logo.svg',
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: REPO_URL }],
    footer: { message: 'AGPL-3.0-only', copyright: 'Cinderous SDK contributors' },
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/README' },
          { text: 'Self-host', link: '/docs/guides/self-host-vps' },
          { text: 'ADR', link: '/docs/adr/README' },
          { text: 'Changelog', link: '/CHANGELOG' },
        ],
        sidebar: guide('en'),
      },
    },
    'zh-TW': {
      label: '繁體中文',
      lang: 'zh-TW',
      link: '/zh-TW/',
      themeConfig: {
        nav: [
          { text: '說明', link: '/README.zh-TW' },
          { text: '自架', link: '/docs/guides/self-host-vps' },
          { text: 'ADR', link: '/docs/adr/README' },
          { text: '版本紀錄', link: '/CHANGELOG' },
        ],
        sidebar: guide('zh-TW'),
      },
    },
  },
});
