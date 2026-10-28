# 0112. 公開後的整理：Schema `$id` 改成網址、DCO、CHANGELOG、Docker 映像的名稱

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28 選定：貢獻條款用 DCO、`$id` 用 raw.githubusercontent 網址、Docker「只改文件名稱」
- 日期：2026-10-28（v0.77.1）
- 對應：SDK ADR 0050（部署設定與 JSON Schema；§8 當時用 URN）、0110（公開方式；〈後續〉列了這幾項）

## Context

ADR 0110〈後續〉列了公開後要做的事，其中三項：

- JSON Schema 的 `$id` 是 `urn:cinderous:deploy-config:1`。ADR 0050 §8 的理由是「SDK 公開前沒有可解析的網址」，現在有了。
- Docker 映像原本預定叫 `cinderous/relay-lite`，但 Docker Hub 的 `cinderous` 是別人的帳號。目前根本沒有發布映像，部署包都在主機上自己建（`--build`）。
- 沒有 `CONTRIBUTING.md`，也沒有 `CHANGELOG.md`：版本紀錄散在各份 ADR 與 commit 裡。

## Decision

1. **`$id` 改成 `https://raw.githubusercontent.com/VaalRL/cinderous-sdk/main/schema/cinderous.config.schema.json`**。現在就打得開，不必等 GitHub Pages。
   - 測試檢查 `$id` 指向 `package.json` 匯出的 `./config.schema.json` 那個路徑，檔案搬家時測試會失敗。
   - 用 `main` 而不是 tag：`$id` 識別的是「這份 schema」，設定檔版本由 `configVersion` 區分（schema 裡是 `const`）。日後有 `configVersion: 2`，要另外決定是否換檔名。
   - 設定檔裡的 `$schema` 仍由使用者自己寫（相對路徑或這個網址都可以），驗證不看 `$id`。
2. **Docker 只改文件裡的名稱**：預定名稱改為 `ghcr.io/vaalrl/cinderous-relay-lite`，並寫明「還沒發布、目前自己建」。不加發布映像的 Action，產生的部署包也不變。
3. **貢獻條款用 DCO**（`git commit -s`，Developer Certificate of Origin 1.1）：
   - 不用 CLA：不需要簽署平台，外部貢獻者門檻低；代價是日後若要改授權（雙授權、商業授權），要所有貢獻者同意。
   - 授權維持 AGPL-3.0-only，著作權留在貢獻者。
   - `CONTRIBUTING.md` 寫明公開 repo 是匯出：PR 不直接合併，由維護者套到開發 repo，保留 `Co-authored-by` 與簽署，下一版出現。
   - 不安裝 DCO 檢查的 GitHub App（有外部 PR 再說）。
4. **`CHANGELOG.md` 從 git 紀錄產生**：每個 tag 一節，列出上一個 tag 到這個 tag 之間的 commit 標題（去掉結尾的版號）；理由看標題引用的 ADR。
   - 只改到不公開路徑（ADR 0110 第 6 項）的 commit、scope 是 `poc` 或 `reports` 的 commit，不列。
   - 之後每次發版，在 `## Unreleased` 寫好，打 tag 時改成版號與日期。
   - 內容是繁體中文（照 commit），開頭有英文說明。

## Consequences

- ＋ 編輯器與驗證工具可以用 `$id` 取得 schema；ADR 0110〈後續〉又少三項。
- ＋ 外部貢獻有明確流程，也說清楚 PR 不會直接合併的原因。
- － `$id` 指向 `main`：`main` 上的 schema 改了，舊版 SDK 的設定檔若用這個網址當 `$schema`，編輯器會用新版提示。要固定版本，請把 `$schema` 寫成 tag 的網址。
- － CHANGELOG 只有中文；英文讀者要看 ADR 或自己翻。
- － Docker 映像仍然沒有，使用者照舊自己建。

## 驗證

- `tests/deploy/deploy-config.test.ts`：新增 `$id` 的測試（先失敗，改後通過）；schema 與描述表一致的測試照舊。
- `npm run check`。
