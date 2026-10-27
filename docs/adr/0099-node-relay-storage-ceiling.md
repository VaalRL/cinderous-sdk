# 0099. Node 版中繼的空間上限：沿用 `DO_CEILINGS_MIB`，滿了拒收或淘汰可設定

- 狀態：**已接受（Accepted，2026-10-19）**——使用者 2026-10-19 依序討論後「開始實作」
- 日期：2026-10-19
- 對應：SDK ADR 0042（容量政策：保底、溢位帶、預警、丟棄計數）、0018（Docker／Fly 部署）、0050（部署設定器）；Cinderous ADR-0377（`DO_CEILINGS_MIB`）。同一次討論的另外兩項：0100（同時連線數）、0101（每月流量預算）

## Context

使用者想知道自己的網域加上 VPS 是否就等於一座用不完的中繼。結論是不會用完的不是中繼，而是 VPS 的硬碟、流量與運算資源。要讓站主能依自己的機器調整，SDK 必須提供設定。

Node 版中繼（`startNodeRelay`；docker／fly／home-tunnel 都是它）原本的空間上限寫死在預設值：離線訊息 128 MiB、快照 128 MiB，滿了拒收。Cloudflare 版的 `DO_CEILINGS_MIB` 等五個容量設定，Node 版一個都不讀。部署設定器甚至把它們列為「只有 Cloudflare 版」，給 Node 主機就拒絕部署。

## Decision

使用者 2026-10-19 逐項選定：

1. **設定方式**：沿用 `DO_CEILINGS_MIB`，格式不變（`strict=<離線 MiB>/<快照 MiB>`）。
   - Node 版只有一套嚴格政策，沒有車道與分片，所以**只認 `strict`** 這個對象。
   - 其他對象不生效、列進 `ignored`，啟動時 `console.warn`。部署設定器直接拒絕。
2. **最大值放寬**：Node 版每項最多 1 TiB（`NODE_CEILING_MAX_MIB = 1_048_576`）。10 GB 是 Cloudflare 單顆 Durable Object 的實體上限，VPS 沒有這個限制，實際上限交給硬碟。
3. **滿了之後可設定**：新變數 `CEILING_MODE`。
   - `reject`（預設）：維持原本的行為。寄件端收到 `blocked: ceiling`，可以改用別座。
   - `evict`：照收，淘汰最快到期的。
   - 寫錯的值當成 `reject`，並列進 `ignored`。
   - 實作沿用 store 既有的 `ceilingEvicts`：`DoCapacity` 多一個 `evicts` 欄位，只有 Node 版會給。Cloudflare 版仍由路由決定（主訊息平面拒收、車道淘汰）。
4. **一起開放**：`DO_NEAR_FULL_PERCENT`、`DO_DROP_NOTICES`、`DO_BORROW_PERCENT`、`DO_GUARANTEE_KIB`，規則與 Cloudflare 版相同：
   - **保底**只在 `evict` 生效。`reject` 模式設了，不生效並列進 `ignored`。
   - **溢位帶**兩種模式都接受。拒收制本來就借用，與 Cloudflare 主訊息平面相同；淘汰制要同時有保底，部署設定器沒有保底就拒絕。
     - 這點與討論時的說法「只在 evict 生效」不同：討論時漏了拒收制本來就會借用。這裡照中繼既有的語意做，避免同一個變數在兩座宿主意思不同。
5. **什麼都沒設**：`capacity` 不出現，store 用預設值，與這個 ADR 之前完全相同。
6. **NIP-11** 照實公告 `cinder_ceiling_policy` 與 `cinder_ceiling_bytes`。原本就由 `storeOptions` 推出，不另算一份。
7. **部署設定器**（`RelaySiteOptions`）：
   - 五個容量選項從 `WORKER_ONLY_SITE_OPTIONS` 移除；`storageBudgetBytes` 仍只給 Cloudflare 版，因為它是 Cloudflare 帳號總量的概念。
   - 新增只有 Node 主機的 `ceilingMode`（`NODE_ONLY_SITE_OPTIONS`），只寫在設定檔、沒有 CLI 旗標，與 `doCeilings` 相同。
   - JSON Schema 的天花板上限取較寬的 1 TiB，Cloudflare 版的 8192 由驗證規則守。

## Alternatives Considered

- **Node 專用的新變數**（例如 `MAX_STORAGE_MIB` 一個數字）：比較直覺，但兩座宿主變成兩套設定，搬家要改設定。
- **依硬碟剩餘空間自動算**：不用設數字，但上限會隨硬碟上其他檔案變動，不好預測。
- **最大值跟 Cloudflare 一樣 10 GB**：兩邊規則完全相同，但等於把 Cloudflare 的實體限制套到沒有這個限制的機器上。
- **滿了固定拒收或固定淘汰**：使用者選擇可設定。自架站常只服務自己，有人寧可一直收得進來。

## Consequences

- ＋ VPS 站主可以依硬碟大小設上限，也可以選擇滿了照收。
- ＋ 兩座宿主用同一組變數名稱與解析器，設錯的項目在兩邊都看得見。
- － `evict` 模式下，最舊的離線訊息可能在收件人上線前被刪掉，而且收件人不會知道。開 `DO_DROP_NOTICES=strict` 才會在收件匣看到丟棄計數。
- 驗證：
  - `tests/relay/node-capacity.test.ts`：解析規則；實際開一台 Node 中繼，`reject` 滿了回 `blocked: ceiling`、`evict` 照收，NIP-11 照實公告；
  - `tests/deploy/relay-site-options.test.ts`〈Node 主機的容量設定〉。
