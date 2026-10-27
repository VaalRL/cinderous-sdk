# 0019. 中繼的預設值改為中立：文件網址不預設、站名與軟體來源指向 SDK

- Status: Accepted
- Date: 2026-09-28
- 相關：ADR 0007（中繼搬進 SDK）；Cinderous ADR-0260（NIP-11）、ADR-0368（拒絕連線時指向文件）、ADR-0370

## Context

中繼程式碼從 Cinderous 原樣搬進 SDK 時，三個預設值是 Cinderous 專屬的：

| 位置 | 原本的預設 | 問題 |
|---|---|---|
| `DEVELOPER_DOCS_URL` | Cinderous 官網的開發者頁 | 別人用 SDK 架的站拒絕連線時，把使用者指到 Cinderous 官網 |
| NIP-11 `name` | `Cinderous relay` | 別人的站沒設 `RELAY_NAME` 時對外自稱 Cinderous |
| NIP-11 `software` | Cinderous 的 GitHub | 這座站跑的其實是 SDK 的中繼程式 |

路由名單（`APP_LANES`）與白名單（`ALLOWED_PUBKEYS`）本來就沒有預設值，只讀環境變數；Cinderous 的名單寫在 Cinderous repo 的 `wrangler.toml`。這三個預設值是同一原則下漏掉的。

## Decision

1. **`DEVELOPER_DOCS_URL` 不預設**。沒設時，拒絕連線的 `NOTICE` 與關閉原因都不附網址，只說明原因。
   - SDK 拿掉這個常數。它是 Cinderous 的事實，搬回 Cinderous 的部署設定。
2. **NIP-11 預設 `name` 改為 `Cinderous SDK relay`**，`software` 改為 SDK 的 repo。
3. **Cinderous 錨點行為不變**：
   - 在自己的 `wrangler.toml` 設 `DEVELOPER_DOCS_URL`（官網開發者頁）與 `RELAY_NAME`（`Cinderous relay`）；
   - Cinderous 的 Node 主機入口預設帶 `RELAY_NAME`。
4. 沒改的：HTTP `GET /` 的純文字本文仍是 `Cinderous relay`。那是健康檢查的回應，契約只看 200（Cinderous ADR-0089），沒有任何客戶端比對這串文字。

## Consequences

- ＋ 用 SDK 架的站不再冒用 Cinderous 的名稱或把人指到 Cinderous 官網。
- － 已經用 SDK 架站、又沒設 `RELAY_NAME` 的站，NIP-11 的站名會從 `Cinderous relay` 變成 `Cinderous SDK relay`。
