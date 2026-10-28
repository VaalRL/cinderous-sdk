# 0123. IoT 即時通道 C′：換家庭秘密（撤銷成員）的 CLI，不做 keyWrap

- 狀態：**已接受（Accepted，2026-10-28）**——使用者 2026-10-28：「好，先做，不做 keyWrap」
- 日期：2026-10-28
- 對應：SDK ADR 0049（§2.6 金鑰輪換與撤銷、`keyWrap`）、0121（`iot realtime home|device`）、0122（設備與閘道的輪換）

## Context

C′ 的一切都從家庭秘密 `homeSecret` 推出來：`homeTag`（relay 據此找到這個家，也是 DO 的名字）、`homePub`、每台設備的盲化 id、設備金鑰 `deviceKey(id, epoch)`、名單公告的 `aclBlindId`。家裡每支手機都持有它。

把某人從角色名單拿掉，只擋得住他**下指令**。手機的訂閱不要求 NIP-42（ADR 0120 §7），他知道 `homeTag` 就訂得到。手上的家庭秘密又推得出每台設備的金鑰，所以之後的狀態與 retained 他照樣讀得懂。ADR 0049 §2.6 的結論是「撤銷成員＝輪換家庭秘密」，但一直沒有工具，只能手動重算所有值。

ADR 0049 另外提了 `keyWrap`：以新秘密包住舊的設備金鑰，延後重燒。代價是**重燒之前被踢的人仍然讀得懂那些設備**。使用者決定不做。

## Decision

### 1. `cinderous iot realtime home --rotate-secret [--remove <npub>…] [--new-operator-secret]`

- 讀取的環境變數：
  - `IOT_HOME_SECRET`：舊秘密，用來找到這一家；
  - `IOT_NEW_HOME_SECRET`：新秘密。沒給就產生一把，只印一次。給的和舊的相同是用法錯誤；
  - `IOT_GATEWAY_KEYS`：既有的整份私鑰。
- 這一家在 `iot-realtime.json` 裡**整筆改寫**：
  - `homeTag`、`homePub`、`aclBlindId`、每台設備的 `blindId` 都改成新秘密推出的值；
  - 名單拿掉 `--remove` 指定的人（npub 或 hex，可以給多次）。不在名單裡的人、或拿掉之後沒有 owner 了，都會拒絕；
  - 設備的 `previousEpoch` 拿掉：網址和金鑰一次切換，寬限沒有意義。
- **不變的東西**：
  - 設備權杖：隨機產生，不是從家庭秘密推出來的，家人也沒有；
  - `epoch`；
  - 閘道私鑰：家人沒有它。`IOT_GATEWAY_KEYS` 裡同一把私鑰改放到新的 `homeTag` 底下，手機的 `realtime.gateway` 不必換。
- **operator 秘密**：
  - 被踢的人是 operator 或 owner 時，他也持有 operator 秘密，做得出門鎖的 down 金鑰，所以一併換掉，印出新的 `IOT_OPERATOR_SECRET`；
  - 被踢的是 viewer 時不換。門鎖的 down 金鑰不變，CLI 會註明；
  - `--new-operator-secret` 一定換。
- 輸出：
  - 每台設備一段，內容是新網址 `/iot/v1/dev/<新 homeTag>/<新 blindId>`，以及 `IOT_DEVICE_ID`／`BLIND_ID`／`KID`／`KEY`。換了 operator 秘密時，門鎖類多一行 `KEY_DOWN`；
  - 手機端的 `IOT_PHONE_DEVICES`（公開值）；
  - 整份 `IOT_GATEWAY_KEYS`；
  - 兩則提醒：留下來的人要以配對（ADR 0028）拿到新秘密；**名單以設定檔為準**。
- 失敗時不寫檔。

### 2. 不做 keyWrap：每台設備都要重燒

- 重新部署之後，舊的 `homeTag` 不再是這座 relay 服務的家，連家庭端點都連不上。新的家要等設備重燒過才連得回來。
- 優點是一換完就乾淨：被踢的人連訂閱都做不到。用 keyWrap 的話，舊金鑰的設備在重燒前流量照樣讀得懂。
- 家用的 C′ 每家最多 64 台設備，實際通常是個位數，重燒的成本可以接受。

### 3. 名單以設定檔為準

- relay 啟動時優先用已存的名單（`aclStore`，owner 用 App 改的），存在舊家庭的 DO 裡。新的家是新的 DO，只看得到設定檔的名單。
- CLI 讀不到 relay 執行時的名單，所以明白提醒先確認檔案裡的名單是對的，不偷偷猜。
- 舊家庭的 DO 留下的資料（retained、額度計數、名單）不會自動刪除。設定裡沒有這一家之後就到不了它；Cloudflare 上會留著一顆不再使用的 DO，資料很小。

## Alternatives Considered

- **keyWrap**：使用者決定不做，理由見 §2。
- **CLI 順便從 relay 讀回目前的名單**：要 CLI 連上 relay，以 owner 身分查 `$sys/acl`，等於把手機端的一部分搬進 CLI。改成提醒，由 owner 自己把設定檔的名單更新好。
- **換家庭秘密時一律換閘道私鑰與 operator 秘密**：家人沒有閘道私鑰，換了只會多一件要發給手機的事。operator 秘密只有在被踢的人拿得到時才需要換。
- **換家庭秘密時一律換權杖**：權杖只在設備上，家人沒有；要換可以另外跑 `device --new-token`（ADR 0122）。

## Consequences

- ＋ 撤銷成員終於是一行指令：讀和寫都擋住，而且一換完就生效。
- ＋ 端到端驗證過：CLI 印出來的值直接拿去起 relay、燒設備、給手機，就能用。
- － 每台設備都要重燒；重燒之前那台設備離線。
- － 留下來的家人都要重新配對。
- － 用 App 改過的名單要先手動同步到設定檔。
- － 只處理 C′（`iot-realtime.json`）。路線 A／B 的閘道（`iot bridge`）用到家庭秘密的部分，還是照原本的方式更換。

## 驗證

- `tests/cli/cli-iot-realtime.test.ts`（6 個）：
  - 踢 viewer：整筆改寫、名單、權杖／epoch／閘道公鑰不變、寬限拿掉、私鑰改放到新 `homeTag`、每台的新金鑰、不印 operator 秘密、設定檔沒有秘密、兩則提醒；
  - 沒給新秘密時產生一把，並印出 `IOT_PHONE_DEVICES`；
  - 踢 operator 時換 operator 秘密和門鎖的 down 金鑰；
  - `--new-operator-secret`；
  - 擋下來的七種情況都不寫檔；
  - npub 與多次 `--remove`。
- `tests/cli/cli-iot-realtime-e2e.test.ts`：以 CLI 的輸出起真的 Node 中繼。重燒的設備加上新秘密的手機開得了燈；被踢的人用舊 `homeTag` 連不上。
- 破壞測試：讓 CLI 不改盲化 id，單元測試與端到端測試都失敗。
