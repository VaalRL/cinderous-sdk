# 0113. 說明網站：VitePress＋GitHub Pages，直接用 repo 裡的 Markdown

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28 選定：VitePress、英文為預設語言＋`/zh-TW/`、Pages 由 Claude 以 `gh api` 開（開之前再確認）
- 日期：2026-10-28（v0.77.2）
- 對應：SDK ADR 0110（公開方式、不公開的路徑）、0112（公開後的整理）

## Context

SDK 公開後只有 GitHub 上的 README，沒有可以搜尋、可以瀏覽的說明頁。現有的文件已經很完整，而且都是 Markdown：README 兩份、`docs/guides/` 兩份指南、113 份 ADR、CHANGELOG、CONTRIBUTING、SECURITY。Cinderous 官網的開發者頁講的是怎麼接 Cinderous 的錨點，不是 SDK。

限制：

- 公開 repo 是 dev repo 的匯出（ADR 0110），網站的原始檔也要放在 dev repo、跟著發版匯出。
- dev repo 是私有的，不能也不該部署 Pages。
- 不公開的路徑（`poc/` 等）不能出現在網站上；有些公開文件連到它們。

## Decision

1. **VitePress 1.6.4**（`devDependencies`，版號釘死），設定在 `site/.vitepress/`，`srcDir` 指向 repo 根目錄：
   - 頁面＝所有 Markdown 扣掉不公開路徑，不另寫一份內容；路徑照原檔（例如 `/docs/adr/0110-….html`）。
   - 首頁 `site/index.md`、`site/zh-TW/index.md` 是新寫的短頁（SDK 是什麼、安裝、使用前要知道的事），用語照 `SECURITY.md`：寫「後量子混合金鑰交換、簽章仍是 secp256k1」，不寫抗量子。
   - 英文是預設語言，`/zh-TW/` 是繁中首頁與導覽；README 各一份，指南與 ADR 兩種語言共用。
   - 內建本機搜尋；字型是 VitePress 內附的檔案，不連 Google 字型，沒有追蹤。
   - 圖示直接用 `assets/logo.svg`（Vite 的 `publicDir` 指向 `assets/`）。
2. **不公開清單只有一份**：`scripts/public-exclude.json`，匯出腳本與網站都讀它；測試比對兩邊一致。
3. **相對連結**（`site/.vitepress/links.ts` 的 markdown-it 外掛）：
   - 指向頁面的 `.md`：交給 VitePress（它會檢查壞掉的連結，壞了建置失敗）；
   - 指向不公開路徑、或跳出 repo 的：只留文字；
   - 指向其他檔案或資料夾（`LICENSE`、`src/…`）：連到 GitHub 上 `main` 的同一個路徑，保留錨點。
4. **不認得的 inline HTML 標籤當文字**：ADR 裡的 `<id>` 這類佔位符沒放在反引號裡時，Vue 會當成元素而編譯失敗；常見的標籤（`br`、`kbd`、`details` 等）照常輸出。不改 ADR 原文。
5. **部署**：`.github/workflows/pages.yml` 只在 `VaalRL/cinderous-sdk` 跑（push 到 `main`，也就是每次匯出發版）；action 釘 commit SHA（與 Cinderous 官網相同的版本）。dev repo 與公開 repo 的 CI 都跑 `npm run docs:build`。

## Consequences

- ＋ 文件只有一份：改 README、指南或 ADR，下次發版網站就跟著更新。
- ＋ 壞掉的連結在 CI 就擋下來。
- － 多 165 個開發相依套件（只用來建網站，不進 `files`，使用方安裝 SDK 不會裝到）。其中 VitePress 帶的 vite 5／esbuild 0.21 有開發伺服器的公告（GHSA-67mh-4wv8-2f99）：只在 `docs:dev` 時有關，CI 只跑 `docs:build`；VitePress 2 正式版出來再升。
- － README 裡的徽章圖片（img.shields.io）由瀏覽器直接載入，訪客的 IP 會被 shields.io 看到（GitHub 上是經過它的代理）。
- － 網址是原檔路徑（`/docs/adr/…`、`/README.html`），不是另外設計的網址結構。
- － 只有兩頁首頁有真正的雙語切換；其他頁面兩種語言共用。

## 後續（未做）

- ~~P1：TypeDoc 產生 API 參考，發版時自動更新。~~（ADR 0115 已做）
- ~~P2：從部署參數描述表（`DEPLOY_OPTION_SPECS`）產生部署設定參考頁。~~（ADR 0116 已做）
- Cinderous 官網的開發者頁與這個網站互相連結。

## 驗證

- `tests/site/links.test.ts`：連結分類、不公開清單與匯出腳本一致、每份被追蹤的 Markdown 不是頁面就是不公開、markdown-it 外掛（連結改寫、佔位符跳脫）。先失敗，實作後通過。
- `npm run docs:build`：126 頁、沒有壞掉的連結；產出裡沒有不公開路徑的頁面、沒有 Google 字型或追蹤碼。
- 本機 `vitepress preview`：首頁、`/zh-TW/`、README、ADR 索引、ADR 0049（佔位符顯示成文字）、VPS 指南、CHANGELOG、圖示都是 200。
