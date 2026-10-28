# 0115. API 參考：TypeDoc 從發佈出去的 `.d.ts` 產生，放在說明網站的 `/api/`

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28：「用 TypeDoc 產生 API 參考頁」（ADR 0113〈後續〉P1）
- 日期：2026-10-28
- 對應：SDK ADR 0113（說明網站）、0110（公開方式）

## Context

說明網站（ADR 0113）只有 README、指南與 ADR。SDK 有 20 個有型別的子路徑匯出，每個匯出的說明都寫在原始碼的 JSDoc 裡，卻只能在 GitHub 上讀原始碼或 `dist/*.d.ts`。

- 型別設定分成三份（瀏覽器／DOM、Cloudflare Worker、Node），沒有一份涵蓋全部的 `src/`。
- `dist/` 是提交進 repo 的建置產出，`.d.ts` 保留了 JSDoc，也正是使用方實際看到的型別。
- 有兩種做法：TypeDoc 產生 HTML（自己的版面、搜尋），或用 `typedoc-plugin-markdown` 產生 Markdown 交給 VitePress。後者要再加兩個外掛，而且 API 的型別簽章（泛型 `<T>`、大量頁面）會碰到 ADR 0113 處理過的 Vue 編譯問題。

## Decision

1. **TypeDoc 0.28.20**（`devDependencies`，版號釘死），只用內建的 HTML 輸出、不加主題或 Markdown 外掛。
2. **來源是 `dist/*.d.ts`**，用 `tsconfig.typedoc.json`（只含 `dist/**/*.d.ts`）：
   - 入口點從 `package.json` 的 `exports` 推導（有 `types` 的子路徑；JSON Schema 不算），不另外維護清單——`site/typedoc.config.mjs` 的 `apiEntryPoints`。
   - 模組名稱改成使用方 import 的寫法（`@cinderous/client/relay/node`）：`site/typedoc-plugin.mjs`。
   - 來源是 `.d.ts`，所以不產生原始碼連結（`disableSources`）。
3. **產出放在 VitePress 產出的 `api/`**：`npm run docs:build` 先建 VitePress、再跑 TypeDoc，同一個 Pages 部署（`pages.yml` 不用改）。導覽列與兩個首頁連到 `/api/`，帶 `target="_self"`：它不是 VitePress 的頁面，不能經過 VitePress 的路由。
4. **註解裡連不到的 `{@link}`（連到沒有匯出的常數）是警告，不讓建置失敗**；沒有說明的匯出不警告。

## Consequences

- ＋ 每次發版，API 參考跟著 `dist/` 更新；新增子路徑匯出時自動出現（測試保證每個子路徑都有入口點、檔案存在）。
- ＋ 頁面上的型別就是使用方拿到的型別，不會因為三份 tsconfig 而不一致。
- ＋ 多 18 個開發相依套件；`npm audit` 沒有因此多出新的公告。只用來建網站，不進 `files`。
- － API 參考的版面是 TypeDoc 的，和 VitePress 網站不一樣；搜尋也是分開的。
- － 產出約 1,600 個檔案、23 MB（根模組重新匯出各子路徑，同一個符號會出現在多個模組下）；GitHub Pages 的上限是 1 GB。
- － 目前有 17 個連不到的 `{@link}` 警告（連到 `INBOX_ACK_KIND`、`READONLY_LANES_MAX` 等沒有匯出的常數）。
- － 註解是中文為主，API 參考沒有英文版。

## 後續（未做）

- 修掉 17 個 `{@link}` 警告（匯出那些常數，或改成文字），之後把警告當錯誤（`treatWarningsAsErrors`）。
- ~~ADR 0113 的 P2：從 `DEPLOY_OPTION_SPECS` 產生部署設定參考頁。~~（ADR 0116 已做）

## 驗證

- `tests/site/api-docs.test.ts`：入口點的推導、真正的 `package.json` 每個有型別的子路徑都有入口點且檔案存在、模組改名後都是真的子路徑、產出位置（先失敗，實作後通過）。
- `npm run docs:build`：VitePress 與 TypeDoc 都完成（0 個錯誤、17 個警告）。
- 本機 `vitepress preview`：`/api/`、模組頁、`startNodeRelay` 函式頁（有 JSDoc 說明）、搜尋索引都是 200；導覽列的連結帶 `target="_self"`。
