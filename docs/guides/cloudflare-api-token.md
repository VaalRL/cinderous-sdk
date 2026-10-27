# 建立 Cloudflare API Token 並部署中繼 / Create a Cloudflare API token and deploy a relay

> 這份指南的步驟文字與 `@cinderous/client/deploy/cloudflare-api` 匯出的 `CLOUDFLARE_TOKEN_SETUP_GUIDE` 一致；那份資料是唯一來源（[ADR 0022](../adr/0022-token-setup-guide-as-sdk-data.md)），改步驟請先改 `src/deploy/cloudflare-api/guide.ts`，再同步這份文件。
>
> The step text here matches `CLOUDFLARE_TOKEN_SETUP_GUIDE` exported by `@cinderous/client/deploy/cloudflare-api`, which is the single source of truth ([ADR 0022](../adr/0022-token-setup-guide-as-sdk-data.md)). Change `src/deploy/cloudflare-api/guide.ts` first, then this page.

- [繁體中文](#繁體中文)
- [English](#english)
- [給開發者 / For developers](#給開發者--for-developers)

---

## 繁體中文

### 事前準備

一個 Cloudflare 帳號（免費方案即可）。還沒有的話，到 <https://dash.cloudflare.com/sign-up> 註冊並完成 email 驗證。

### 步驟

0. **事前準備**：準備好 Cloudflare 帳號（見上）。
1. **開啟 Cloudflare 的 Token 建立頁**：在外掛設定頁按「建立 Cloudflare Token」。瀏覽器會開啟 Cloudflare 的「建立 API Token」頁，權限已預先填好。還沒登入的話會先要求登入，登入後會回到這一頁。
2. **確認預填的名稱與權限**：確認已自動填好：
   - Token 名稱「Cinderous relay deploy」
   - Permissions 兩列：`Account → Workers Scripts → Edit`、`Account → Account Settings → Read`

   不要新增其他權限。
3. **選擇帳號範圍（Account Resources）**：預設是「All accounts」。只有一個帳號的話可以不改；有多個帳號時，建議改成「Include → 你要部署的那個帳號」，讓權限範圍最小。Zone Resources 不需要設定：中繼不需要任何網域權限。
4. **（建議）設定到期日**：在 TTL 設一個很近的到期日（例如明天）。這把 Token 只用來部署這一次，到期會自動失效，比較安全。Client IP Address Filtering 留空。
5. **檢查摘要並建立**：按「Continue to summary」，確認摘要裡只有上面兩項權限，再按「Create Token」。
6. **複製 Token**：畫面會顯示 Token。**它只會顯示這一次**，關掉就看不到了。按「Copy」複製。
7. **貼回來並部署**：回到 Obsidian，把 Token 貼到「Cloudflare API Token」欄位，按「部署」。外掛會先驗證 Token，再依序確認 workers.dev 子網域、上傳中繼、開啟 workers.dev 路由、做健康檢查。通常數秒到半分鐘完成，完成後會自動填入 `wss://…workers.dev` 的中繼網址。如果外掛請你選帳號或取一個子網域名稱，請看下方的常見問題。
8. **部署完成後刪除 Token**：外掛**不會保存** Token。建議回到 Cloudflare 的 API Tokens 頁（<https://dash.cloudflare.com/profile/api-tokens>）把這把 Token 刪除。之後要重新部署時再建立一把新的；重新部署是安全的，不會清掉既有設定。

### 常見問題

錯誤依 `CloudflareApiError.kind` 分類。

| kind | 看到什麼 | 原因 | 怎麼做 |
|---|---|---|---|
| `token-invalid` | Token 無效或無法使用 | 沒有複製完整、已經過期，或已經在 Cloudflare 刪除或停用 | 按「建立 Cloudflare Token」重新建立一把，完整複製後再貼上 |
| `permission` | 權限不足，或 Token 看不到任何帳號 | 建立時權限列被改動或刪掉，或 Account Resources 沒包含你的帳號 | 用外掛按鈕重新開啟預填頁，不要改動權限列，確認 Account Resources 包含要部署的帳號，再建立一把新的 |
| `account-ambiguous` | 外掛列出好幾個帳號請你選 | Token 能用不只一個帳號 | 在清單中選擇帳號後再部署；或在第 3 步把 Account Resources 限定成單一帳號，重建 Token |
| `subdomain-missing` | 外掛請你輸入 workers.dev 子網域名稱 | 帳號還沒有 workers.dev 子網域（新帳號第一次用 Workers 時會發生） | 輸入想要的名稱（全球唯一，只能用小寫英文字母、數字與連字號），它會成為 `<中繼名稱>.<子網域>.workers.dev` 的一部分；也可以先到 Cloudflare 儀表板的 Workers 頁面設定 |
| `name-conflict` | 名稱衝突 | 帳號裡已有同名、但不是 Cinderous 中繼的 Worker；或你輸入的子網域已被別人使用 | 換一個中繼名稱（Worker 名稱）；子網域被佔用就換一個子網域名稱。外掛不會覆蓋別的 Worker |
| `quota` | 超過額度或請求太頻繁 | Worker 數量或腳本大小到了方案上限，或短時間內呼叫 API 太多次 | 等幾分鐘再試；Worker 數量到上限就刪掉不用的 Worker 或查看方案 |
| `network` | 連不到 Cloudflare | 裝置沒網路，或防火牆、VPN、代理擋住 `api.cloudflare.com` | 確認網路後再按一次「部署」 |
| `lane-change` | 重新部署時顯示已知租戶名單或私人路徑與線上的不同，沒有上傳 | 應用車道名單（`appLanes`）或私人路徑（`privateLane`）和線上的不一樣；換了＝換一個儲存空間（Durable Object），舊資料不會搬過去、等它到期；換了私人路徑，舊網址不能再寫入（有唯讀寬限期時到期前還能讀，SDK ADR 0052） | 用和上次一樣的名單或私人路徑重新部署（例如在已經有這個網址的裝置上部署）；確定要改就在應用程式裡確認（`allowLaneChange`）；應用程式支援搬家通知時其他裝置會自動改用新網址，否則讓每台裝置改用新網址、重新同步一次 |
| `health` | 上傳完成，但健康檢查沒過 | 中繼還沒在 Cloudflare 網路上生效。外掛會自動重試約 1 分鐘（預設 20 次、每次間隔 3 秒）；新註冊的 workers.dev 子網域，DNS 可能要幾分鐘才生效 | 等幾分鐘後再按一次「部署」；外掛要等健康檢查通過才會填入中繼網址 |
| `api` | Cloudflare API 失敗，附錯誤碼 | Cloudflare 回了其他錯誤 | 稍後再試；持續失敗就記下錯誤碼與訊息回報，或查看 Cloudflare 狀態頁 |

### 補充

- Cloudflare 介面語言是中文時，按鈕會顯示對應的中文譯名（上面寫的是英文介面的原文）。
- 費用以 Cloudflare 官方方案為準：<https://developers.cloudflare.com/workers/platform/pricing/>。2026-09-29 查證時，Workers 免費方案每天 100,000 次請求；SQLite 型 Durable Objects 在免費方案可用（每天 100,000 次請求、13,000 GB-s，總儲存 5 GB）。個人使用的中繼通常在免費額度內，但額度可能調整，請以官方頁面為準。
- 也可以不部署，直接在設定頁填入既有的中繼網址（`wss://…`）。

---

## English

### Before you start

A Cloudflare account (the free plan is enough). If you don't have one, sign up at <https://dash.cloudflare.com/sign-up> and verify your email.

### Steps

0. **Before you start**: have a Cloudflare account ready (see above).
1. **Open the Cloudflare token page**: in the plugin settings, click "Create Cloudflare token". Your browser opens Cloudflare's "Create API Token" page with the permissions already filled in. If you are not signed in, Cloudflare asks you to sign in first and then returns to that page.
2. **Check the pre-filled name and permissions**:
   - Token name "Cinderous relay deploy"
   - Two Permissions rows: `Account → Workers Scripts → Edit` and `Account → Account Settings → Read`

   Do not add any other permissions.
3. **Choose the account scope (Account Resources)**: the default is "All accounts". With one account you can leave it. With several, we recommend "Include → the account you want to deploy to", so the token can do as little as possible. Leave Zone Resources alone: the relay needs no zone (domain) permissions.
4. **(Recommended) Set an expiry**: set TTL to a date very soon (for example, tomorrow). The token is only needed for this one deployment, so letting it expire automatically is safer. Leave Client IP Address Filtering empty.
5. **Review the summary and create**: click "Continue to summary", check that only the two permissions above are listed, then click "Create Token".
6. **Copy the token**: Cloudflare shows the token. **It is shown only once.** Click "Copy".
7. **Paste it back and deploy**: back in Obsidian, paste the token into the "Cloudflare API token" field and click "Deploy". The plugin verifies the token, then checks your workers.dev subdomain, uploads the relay, enables the workers.dev route and runs a health check. This usually takes a few seconds to half a minute; the `wss://…workers.dev` relay URL is then filled in for you. If the plugin asks you to pick an account or a subdomain name, see Troubleshooting.
8. **Delete the token afterwards**: the plugin **does not store** the token. We recommend deleting it on Cloudflare's API Tokens page (<https://dash.cloudflare.com/profile/api-tokens>). Create a new one whenever you redeploy; redeploying is safe and does not wipe your existing setup.

### Troubleshooting

| kind | What you see | Cause | What to do |
|---|---|---|---|
| `token-invalid` | Token invalid or unusable | Not copied completely, expired, or deleted/disabled in Cloudflare | Click "Create Cloudflare token", create a new one and paste all of it |
| `permission` | Permission denied, or the token sees no account | Permission rows were changed, or Account Resources excludes your account | Reopen the pre-filled page with the plugin button, leave the permissions as they are, include your account, create a new token |
| `account-ambiguous` | The plugin asks you to choose an account | The token can use more than one account | Pick one and deploy again, or limit Account Resources to one account in step 3 |
| `subdomain-missing` | The plugin asks for a workers.dev subdomain | The account has no workers.dev subdomain yet (first use of Workers) | Enter a name (globally unique; lowercase letters, digits, hyphens). It becomes part of `<relay name>.<subdomain>.workers.dev`. You can also set it on the Workers page of the dashboard first |
| `name-conflict` | Name conflict | A Worker with that name exists and is not a Cinderous relay, or the subdomain is taken | Choose another relay (Worker) name, or another subdomain. The plugin never overwrites another Worker |
| `quota` | Quota or rate-limit error | Plan limit on Worker count or script size, or too many API calls | Wait a few minutes; if at the Worker limit, delete unused Workers or check your plan |
| `network` | Cloudflare cannot be reached | Offline, or a firewall/VPN/proxy blocks `api.cloudflare.com` | Check your connection and click "Deploy" again |
| `lane-change` | Redeploy says the known app lanes or the private path differ from the live relay; nothing uploaded | The app lane list (`appLanes`) or the private path (`privateLane`) differs from the live one; changing it moves to new storage (a Durable Object) and old data is not moved — it expires; a new private path also stops writes to the old URL (with a read-only grace period it stays readable until it expires, SDK ADR 0052) | Redeploy with the same list or private path as last time (e.g. from a device that already has the URL); to really change it, confirm in the app (`allowLaneChange`); apps that send a move notice switch your other devices automatically, otherwise switch every device to the new URL and let it sync once more |
| `health` | Upload finished, health check failed | Not live on Cloudflare's network yet. The plugin retries for about a minute (20 attempts, 3 s apart by default); a new workers.dev subdomain can take a few minutes for DNS | Wait a few minutes and deploy again; the URL is filled in only after the check passes |
| `api` | Cloudflare API error with an error code | Some other Cloudflare error | Try later; if it persists, report the code and message or check Cloudflare's status page |

### Notes

- If your Cloudflare dashboard is in another language, buttons show the translated names.
- Pricing is whatever Cloudflare's official plans say: <https://developers.cloudflare.com/workers/platform/pricing/>. As checked on 2026-09-29, the Workers Free plan includes 100,000 requests per day, and SQLite-backed Durable Objects are available on the Free plan (100,000 requests and 13,000 GB-s per day, 5 GB total storage). A personal relay usually fits, but limits can change.
- You can also skip deployment and enter an existing relay URL (`wss://…`) in settings.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects on Workers Free plan (2025-04-07)](https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/), [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [API token template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).

---

## 給開發者 / For developers

設定頁直接渲染 SDK 的資料，不要自己抄一份步驟文字。Render the SDK data; do not copy the step text.

```typescript
import { moment, Setting } from 'obsidian';
import {
  buildTokenCreationUrl,
  CLOUDFLARE_TOKEN_SETUP_GUIDE,
  CloudflareApiError,
  type TokenGuideLocale,
} from '@cinderous/client/deploy/cloudflare-api';

const locale: TokenGuideLocale = moment.locale().startsWith('zh') ? 'zh-TW' : 'en';
const guide = CLOUDFLARE_TOKEN_SETUP_GUIDE[locale];

const list = containerEl.createEl('ol', { cls: 'my-plugin-token-steps', attr: { start: '0' } });
for (const step of guide.steps) {
  const item = list.createEl('li');
  item.createEl('strong', { text: step.title });
  item.createEl('p', { text: step.body });
  if (step.id === 'open-token-page') {
    new Setting(item).addButton((b) =>
      b.setButtonText('建立 Cloudflare Token').onClick(() => window.open(buildTokenCreationUrl())),
    );
  }
}

// 部署失敗時顯示對應的疑難排解 / On failure, show the matching troubleshooting entry
function explain(error: unknown): string {
  if (!(error instanceof CloudflareApiError)) return String(error);
  const t = guide.troubleshooting[error.kind];
  return `${t.symptom}\n${t.cause}\n${t.fix}`;
}
```

- `guide.steps[i].id`：穩定識別碼（`prepare`、`open-token-page`、`check-permissions`、`account-resources`、`ttl`、`create`、`copy`、`paste-and-deploy`、`clean-up`），用來決定按鈕與輸入欄放在哪一步。
- `guide.steps[i].permissions`：只有 `check-permissions` 有，等於 `REQUIRED_TOKEN_PERMISSIONS` 的標籤。
- `guide.troubleshooting`：以 `CloudflareApiError.kind` 為鍵，涵蓋 `CLOUDFLARE_ERROR_KINDS` 的每一種。
- `guide.links`：`signUp`、`createToken`（等於 `buildTokenCreationUrl()`）、`apiTokens`、`pricing`。
- 自訂 Token 名稱或應用名稱時用 `buildCloudflareTokenSetupGuide({ tokenName, appName })`，並把同一個 `tokenName` 傳給 `buildTokenCreationUrl({ name })`。預設應用名稱是 `DEFAULT_GUIDE_APP_NAME`（`Obsidian`）。
- 按鈕與欄位名稱（「建立 Cloudflare Token」「Cloudflare API Token」「部署」／"Create Cloudflare token", "Cloudflare API token", "Deploy"）要與步驟文字一致。
- Token 輸入欄用 password 型、不保存；部署完成後清空。
