# Changelog / 版本紀錄

Releases are git tags; install one with `npm install github:VaalRL/cinderous-sdk#vX.Y.Z`. Each entry lists the changes in that release, taken from the commit history. The reasoning behind each change is in the ADR it cites ([docs/adr/](docs/adr/README.md)). Entries are in Traditional Chinese, as the commits are.

每個版本是一個 git tag，安裝方式是 `npm install github:VaalRL/cinderous-sdk#vX.Y.Z`。每一版列出那一版的改動（取自 commit 紀錄）；每項改動的理由寫在它引用的 ADR 裡（[docs/adr/](docs/adr/README.md)）。

## v0.86.0 — 2026-10-30

- feat(relay): Worker 讀 `MAX_EVENTS_PER_MINUTE`／`MAX_MESSAGES_PER_MINUTE`——照 ADR 0037 只能調高到 600／1200，0、負數、低於預設、壞值都當沒設（Cloudflare 每則訊息都計費，不能關掉）；車道與嚴格平面同一組；轉出 `workerRateLimitsFrom`、`WORKER_MAX_EVENTS_PER_MINUTE`、`WORKER_MAX_MESSAGES_PER_MINUTE`（`@cinderous/client/relay` 的 host-config）。NIP-11 的 `cinder_max_events_per_minute` 改成兩座宿主實際套用的值（原本一律 120；Node 版設 0 時不宣告）（ADR 0129）
- docs(adr): ADR 0038／0039／0042 的「錨點尚未部署」更正為已部署（Cinderous PR #9，2026-10-28）；ADR 0128 補上部署後驗證結果

## v0.85.1 — 2026-10-30

- fix(relay): 清理鬧鐘不會永久停掉——`alarm()` 的清理拋錯時記錄並照樣排下一次（原本走不到 `setAlarm`，Cloudflare 重試 6 次用完就不再跑）；DO 醒來時鬧鐘停在過去也重排。2026-10-22 錨點 1 的 CinderSync 車道撞到額度後一週沒有清理，過期的檔案塊佔著八成空間、每次寫入都回 `near-full`（ADR 0128）

## v0.85.0 — 2026-10-29

- fix(relay): 喚醒與分頁補拉只讀需要的列——pubkey/kind 回填只看 `pubkey` 並先建索引（建 store 4,631→4 列；每次喚醒建兩次）；新選項 `MessageStoreOptions.sizeUpperBound`（DO 宿主給 `ctx.storage.sql.databaseSize`），證明放得下、沒到預警線就不 `SUM` 整張表（喚醒後第一次寫入 6,949→2,321 列，可尋址事件不再每次寫入都掃全表）；離線留言照分桶索引的順序排序，`#p`＋kinds 分頁讀滿一頁就停（4,098→2,048 列）。2026-10-22 錨點 1 的 CinderSync 車道就是這樣讀了 535 萬列、撞到每日 500 萬列的上限（ADR 0126）
- fix(relay): 已經連著的連線也說清楚「額度用完」——新選項 `RelayCoreOptions.isStorageExhausted`（DO 宿主給 `doFailureKind`），處理到一半撞到每日讀寫列數上限時，EVENT 回 `OK false over quota:`、REQ 回 `CLOSED over quota:`，再一則 NOTICE 並以 1013 關閉（原本只回 `error: internal`、連線不關，客戶端一直重送到重置）；喚醒還原與存訂閱時撞到也接住；轉出 `storageExhausted`、`STORAGE_QUOTA_REJECTION`，句子改成「rows read or written」，升級被拒共用（前綴不變）（ADR 0127）

## v0.84.0 — 2026-10-29

- feat(relay-pool): 連不上時分辨「邊緣代答」與「網路斷了」——連續兩次還沒連上就斷，抓兩次 NIP-11（一般與 `no-cors`）：一般失敗、`no-cors` 成功＝主機有回應但不是中繼（Cloudflare 每日請求數用完的 1027 就是這樣）；照 1013 處理：`onRelayReject` 的 `source: 'probe'`、`kind: 'unavailable'`、`token: 'edge'`，整座 5 分鐘不用、重連等到那時。每座最多 5 分鐘探測一次。新選項 `edgeProbe`（預設：內建 WebSocket＋有 `fetch` 時開，注入 `createSocket` 時關）；轉出 `probeRelayEdge`、`relayInfoUrlOf`、`EDGE_ANSWERED_TOKEN`、`EDGE_ANSWERED_REASON`、`DEFAULT_EDGE_PROBE_*`（ADR 0125）

## v0.83.1 — 2026-10-29

- fix(relay-pool): 常駐訂閱的去重表有上限——每 1024 則整理一次、忘掉早於補訂閱 since 而且收到超過 10 分鐘的 id；新選項 `maxSeenPerSubscription`（預設 50,000，超過先忘最早收到的）。原本每個訂閱的 id 只進不出，一開好幾天的聊天 App 會被心跳慢慢吃掉記憶體（ADR 0124）

## v0.83.0 — 2026-10-28

- feat(cli): `iot realtime home --rotate-secret [--remove <npub>…] [--new-operator-secret]`——撤銷成員＝換家庭秘密：這一家整筆改寫成新秘密推出的值、名單拿掉那些人、每台設備的新網址與金鑰各印一次（要重燒，不做 keyWrap）；權杖、epoch、閘道私鑰不變；拿掉 operator／owner 時 operator 秘密也換（ADR 0123）

## v0.82.0 — 2026-10-28

- fix(relay-pool): 關閉碼 4429 `iot-quota:<reset>` 分類成 `unavailable`、詞元 `iot-quota`、帶 `reset`（`IOT_QUOTA_CLOSE_CODE`、`RELAY_REJECT_TOKENS.iotQuota`）；健康標記與重連等到重置時間（加最多 60 秒抖動、最多一天）；在等的發布以詞元結案——原本當一般斷線，每分鐘重連一次（ADR 0122）
- fix(iot): C′ 連線被 4429 關掉時 `command`／`deviceLink` 回 `quota`（附 `reset`），已經被關之後下的指令不送、馬上回——原本是 `relay-rejected` 或空的拒收清單（ADR 0122）
- feat(iot): 手機端 `realtime.devices[id].previousEpoch`：寬限內舊版本的回報照收，指令跟著設備最近開口的版本（ADR 0122）
- feat(cli): `iot realtime device <id> --rotate [--grace-sec]`（換金鑰版本，印出新金鑰與手機端設定 `IOT_PHONE_DEVICE`）、`--new-token`（換權杖）、`iot realtime home --rotate-gateway`（換閘道私鑰，沒有寬限）；設定檢查 `previousEpoch.epoch` 要比 `epoch` 小（ADR 0122）

## v0.81.0 — 2026-10-28

- feat(iot): C′ 即時通道的手機端——`IotClient` 新增 `realtime`（`devices`、`operatorSecret`、選配 `pool`／`gateway`）、`urgency: 'realtime'`（ttl 15、等 ack 5 秒、逾時回 `unknown` 並自動查詢，結果在 `after`）、`ackTimeoutMs`、`deviceLink()`、`quota` 狀態與 `reset`、ack 帶回的 `state`；`subscribeState`／`getRetained`／`query` 涵蓋 C′ 設備（ADR 0120）
- feat(iot): 新子路徑 `@cinderous/client/iot/device`：`connectIotDevice`、`memoryIotDeviceCounterStore`（中立、零 Node 內建模組）；`./iot` 新增信封明文的格式 `parseIotDownMessage`／`parseIotUpMessage`（ADR 0120）
- feat(relay): NIP-11 `cinder_iot.realtime`（`ws`、`longpoll: false`、`heartbeat_sec`；不列家庭）；`iotRealtimeAnnouncement`（ADR 0120）
- fix(budget): `rate-limited: iot-quota:` 不再讓同一身分的事件預算退避重送（ADR 0120）
- feat(deploy): C′ 進四條部署路徑——`RelaySiteOptions.iotRealtime`（`IOT_REALTIME`）、`iotHomeDailyRequests`（Cloudflare）、`RelayWorkerSecrets.iotGatewayKeys`（`IOT_GATEWAY_KEYS`；`iotGatewayKeysSecret` 比對 `gatewayPubkey`）；docker 以 compose 必填代入、fly 以 `fly secrets import` 上傳；部署設定檔 `site.iotRealtime`／`site.iotHomeDailyRequests`／`secrets.iotGatewayKeys`（ADR 0121）
- feat(deploy): Workers 一律帶 `IOT_HOME` 綁定，遷移新增 **v2**（`IotHomeRoom`）；入口與打包好的 Worker 轉出 `IotHomeRoom`。🔴 下一次重新部署任何 Worker 都會套用 v2（ADR 0121）
- feat(cli): `cinderous iot realtime home|device`（產生 C′ 設定；閘道私鑰、operator 秘密、設備權杖與金鑰只印一次）、`relay start --iot-realtime <檔>`（ADR 0121）
- feat(relay): 家庭設定的 `aclBlindId` → relay 以 31170 公告角色名單（`myRole()`／`getAcl()` 在 C′ 可用）；`checkIotRealtimeConfig`／`checkIotRealtimeAclShape` 與部署設定器共用（ADR 0121）
- fix(relay): 名單公告的 `created_at` 嚴格遞增：同一秒內的兩則由 id 決勝，改名單後新名單可能被舊的蓋掉（ADR 0121）
- fix(relay): C′ 每個家庭的可尋址上限改成 65（原本沿用嚴格平面的 5，第 6 台設備以後的 retained 被拒）（ADR 0121）
- fix(iot): 只連 C′ 時 `updateAcl` 的 `$sys/acl` 改加密給閘道公鑰（原本加密給 `homePub`，relay 解不開）（ADR 0121）

## v0.80.0 — 2026-10-28

- fix(relay)!: Node 中繼取 `X-Forwarded-For` 改為從右邊數第 `TRUST_PROXY` 段（`TRUST_PROXY=<層數>`，1–10；新增 `clientIpFrom`、`trustedProxyHopsFrom`）——原本取第一段，nginx 的 `$proxy_add_x_forwarded_for`、Cloudflare、Fly 後方客戶端能偽造 IP 躲過每個 IP 的上限（ADR 0119）
- feat(relay,cli): `HOST` 環境變數與 `relay start --host`：只聽某個位址；沒設照舊所有位址（ADR 0119）
- feat(deploy)!: docker 目標新增 `node.bindAddress`；開了 `node.trustProxy` 沒指定時，compose 只發布在 `127.0.0.1`（Docker 發布的埠會繞過 ufw）；`0.0.0.0`／`::`＋`trustProxy` 警告；部署說明的安全檢查清單補「Docker 會繞過 ufw」（ADR 0119）
- docs(guides): VPS 自架指南改成不必手改 compose、systemd 加 `HOST=127.0.0.1`、nginx 兩種寫法都安全（ADR 0119）

## v0.79.0 — 2026-10-28

- feat(deploy): TURN 進站台參數（`turnKeyId`、`turnTtlSeconds`）；Token 是 `RelayWorkerSecrets.turnApiToken`，REST 以 `secret_text` 綁定、wrangler 以 `wrangler secret put`（值走 stdin）上傳；`CommandRunner` 多一個可選的 `input`；部署包與說明列出 Token、寫明 TURN 另外計費（ADR 0118）
- feat(deploy): `@cinderous/client/deploy/config` 新增 `cloudflareApiOptionsFromConfig`；`relay deploy --config` 接上 `cloudflare-api` 目標（ADR 0118）
- feat(cli): `cinderous config migrate [檔] [--dry-run]`；新增 `migrateDeployConfig`、`DEPLOY_CONFIG_MIGRATIONS`（ADR 0118）

## v0.78.0 — 2026-10-28

- feat(cli): `cinderous init` 精靈——題目從 `DEPLOY_OPTION_SPECS` 推出、危險選項要打出欄位名稱才開；`@cinderous/client/deploy/config` 新增 `runInitWizard`、`wizardQuestions`、`parseWizardAnswer`、`dangerousChoices`、`isDangerousValue`、`dangerConfirmWord`、`renderDeployConfigFile`（ADR 0117）
- fix(deploy): 部署說明的安全檢查清單改由 `dangerous` 產生，補上原本漏掉的 `site.appLanes`；docker 沒開 `trustProxy` 時不再列那條（ADR 0117）

## v0.77.8 — 2026-10-28

- docs(api): 修掉 API 參考的 17 個連不到的 `{@link}`，之後連不到的連結讓 `docs:build` 失敗；`@cinderous/client/sync/vault` 多匯出 `BACKFILL_PAGE_TIMEOUT_MS`（ADR 0115 補充）

## v0.77.7 — 2026-10-28

- docs(site): API 參考——TypeDoc 從 `dist/*.d.ts` 產生，放在說明網站的 `/api/`（ADR 0115）
- docs(reference): 部署設定參考頁——從 `DEPLOY_OPTION_SPECS` 產生中英兩份，`docs/reference/deploy-options.md`（ADR 0116）

## v0.77.6 — 2026-10-28

- test(relay): node-capacity 的六則留言共用同一個基準時間（跨秒時兩則同 id、被當重複，CI 偶發失敗；ADR 0114 補充）

## v0.77.5 — 2026-10-28

- test(star): 灌量者被請離開後就停止送（GitHub runner 較快時的測試競態）

## v0.77.4 — 2026-10-28

- fix(relay): `startDevRelay` 也回傳 `ready`；所有開中繼的測試改由系統分配埠（`tests/node-relay-harness.ts`）——v0.77.3 的公開 CI 出現 `EADDRINUSE`，證實隨機埠會撞（SDK ADR 0114）

## v0.77.3 — 2026-10-28

- feat(relay): `startNodeRelay` 回傳 `ready`——開始監聽後給出實際的埠（`PORT=0` 由系統分配），監聽失敗就 reject；`node-capacity` 測試改由系統分配埠（SDK ADR 0114）

## v0.77.2 — 2026-10-28

- docs: 說明網站 https://vaalrl.github.io/cinderous-sdk/ ——VitePress，直接用 repo 裡的 README、指南、ADR、CHANGELOG（SDK ADR 0113）；不公開路徑清單改放 `scripts/public-exclude.json`，匯出腳本與網站共用

## v0.77.1 — 2026-10-28

- feat(deploy): JSON Schema 的 `$id` 改成公開 repo 裡這份檔案的網址（`https://raw.githubusercontent.com/VaalRL/cinderous-sdk/main/schema/cinderous.config.schema.json`，SDK ADR 0112）
- docs: 新增 `CONTRIBUTING.md`（DCO 簽署）與 `CHANGELOG.md`；Docker 映像的預定名稱改為 `ghcr.io/vaalrl/cinderous-relay-lite`（尚未發布，SDK ADR 0112）

## v0.77.0 — 2026-10-27

- feat(relay): 主平面的反覆重連限速與沒認證就斷線的診斷（移植 Cinderous ADR-0391、0392；SDK ADR 0111）
- docs: 公開後的文件同步——VPS 指南改成 clone 公開 repo、PRD 署名改為維護者 VaalRL、ADR 0110 記錄公開（0180d6a、v0.76.1）

## v0.76.1 — 2026-10-27

- chore: 公開準備——公開 repo 改為 VaalRL/cinderous-sdk、不上 npm；VPS 自架指南（ADR 0109、0110）

## v0.76.0 — 2026-10-22

- fix(relay-pool): 中繼以 1013 關閉＝這座暫時不能用——分類、整座退避 5 分鐘、配對逾時說是中繼的問題（ADR 0108）
- ci: setup-node 加 check-latest（2026-10 Node 安全更新） (#1)

## v0.75.0 — 2026-10-22

- fix(sync/vault): 新加入的收件人不算加入前的廣播用量（ADR 0107）

## v0.74.0 — 2026-10-22

- fix(sync/vault): 中繼弄丟的版本——對方簽收了更後面的序號、這一則一直沒簽收就重送（ADR 0106）

## v0.73.0 — 2026-10-22

- fix(pairing): 撤銷通知——撤銷的那台另外送被撤銷的裝置一份精簡名單，讓它知道自己出局（ADR 0105）

## v0.72.0 — 2026-10-22

- fix(sync): 索取合併成幾則再送、只問答得出來的裝置——新裝置加入時不再吃光事件預算（ADR 0104）

## v0.71.2 — 2026-10-20

- fix(relay): 保底用量照實扣、單一值的查詢順著索引分頁（ADR 0103）

## v0.71.1 — 2026-10-20

- fix(relay): 檔案車道塞滿後淘汰時只讀要刪的那幾列——每寫一顆平均讀 172→42 列（ADR 0102）

## v0.71.0 — 2026-10-19

- feat(relay): Node 版中繼的每月流量預算——MONTHLY_TRAFFIC_GIB、重置日、進出合計或只算出去、用量存 SQLite（ADR 0101）

## v0.70.0 — 2026-10-19

- feat(relay): Node 版中繼的同時連線數上限——MAX_CONNECTIONS／MAX_CONNECTIONS_PER_IP，沒設就不限（ADR 0100）

## v0.69.0 — 2026-10-19

- feat(relay): Node 版中繼的空間上限——沿用 DO_CEILINGS_MIB（只認 strict、上限 1 TiB）、CEILING_MODE 選拒收或淘汰（ADR 0099）

## v0.68.3 — 2026-10-19

- perf(relay): 拿掉 idx_offline_kind——每則離線留言寫入與刪除各少一列（ADR 0098）

## v0.68.2 — 2026-10-19

- fix(relay): DO 起不來時說明原因——額度用完（over quota）與暫時無法使用，NOTICE＋1013 關閉（ADR 0097）

## v0.68.1 — 2026-10-19

- fix(sync): 小檔合併照這次實際的去向分組——拆過收件人、有欠款的也合（ADR 0096）

## v0.68.0 — 2026-10-19

- feat(sync): 小檔合併——好幾個小版本連同內容合成一則 bundle（一則不超過一個訊框）、能力宣告 BUNDLE_CAPABILITY、限速一包算一則（ADR 0095）

## v0.67.0 — 2026-10-19

- feat(deploy): 部署時才下載中繼 Worker——relayWorkerSha256、deployCloudflareRelayWithWorker（不帶 Worker 本體）、fetchRelayWorker（比對雜湊）（ADR 0094）

## v0.66.1 — 2026-10-16

- fix(relay-pool,sync): 改用備援時 queryResult 不等主要中繼（waitForPrimary: false），補拉不再整輪算成沒回完（ADR 0093 補）

## v0.66.0 — 2026-10-16

- feat(sync): whenSent 回報 throttled（ADR 0092）；傳輸層可在主要中繼連不上時改用備援 setStandbyFallback（ADR 0093）

## v0.65.0 — 2026-10-15

- feat(sync): 批次限速按收件人，只限速要給積壓那幾台的，其他裝置的新修改照常即時送；大檔直送交出版本時也標成已交出（ADR 0091）

## v0.64.0 — 2026-10-15

- feat(sync): 收到某台的任何同步訊息就排直連（有要直送給它的時候），同一台 60 秒最多一次（ADR 0090）

## v0.63.0 — 2026-10-15

- feat(transfer,sync): 暫存是單一本機檔案時回報路徑，收完的大檔可以直接改名進 Vault（ADR 0089）

## v0.62.0 — 2026-10-15

- fix(sync): 補送給不認得這個檔案的裝置時連祖先一起送、同內容收斂不再讓剛加入的裝置暫時少檔（ADR 0088）

## v0.61.0 — 2026-10-15

- fix(sync): 待直送的大檔內容不在了就馬上剔除（ADR 0086）；衝突 callout 後空一行、名單全員支援才啟用（ADR 0087）

## v0.60.0 — 2026-10-14

- fix(sync,relay): 收不齊的檔案塊不再堆積——每次啟動先從頭補拉（ADR 0084）、中繼整批淘汰（ADR 0085）

## v0.59.0 — 2026-10-14

- feat(iot,relay): IoT 即時通道的 relay 端（ADR 0049 C′ R1）

## v0.58.1 — 2026-10-14

- fix(relay): 空 content 當清除只限快照——標準的 10050／10002／kind 3 不再被默默刪掉（ADR 0083）

## v0.58.0 — 2026-10-14

- fix(sync/vault): 完整補拉後還收不齊的訊框也送收件確認（ADR 0081）；名單同步共用傳輸層的 1060 訂閱——onOtherEvent＋NostrRosterSync subscribe:false（ADR 0082）

## v0.57.1 — 2026-10-13

- fix(relay-pool/sync): 一次性查詢等某座回完時，該座任何訊息都重新起算閒置；start() 沒連上不補拉（ADR 0080）；歷史版本 absorbed（ADR 0079）

## v0.57.0 — 2026-10-13

- fix(relay-pool/sync): 認證前的 restricted 當成等認證（ADR 0076）；查詢逾時以沒有新資料計、補拉每頁 30 秒（ADR 0077）；耐久度 standbyWhenDisconnected（ADR 0078）

## v0.56.0 — 2026-10-12

- fix(sync/vault): 過時的摘要不觸發重送（ADR 0074）；傳輸層先留著註冊前收到的訊息（ADR 0075）

## v0.55.1 — 2026-10-12

- fix(sync/vault): 大小寫索引、G10 只收斂內容來源、中繼帳獨立保存、隊頭阻塞、規模測試比寫入量（ADR 0073）

## v0.55.0 — 2026-10-12

- feat(sync/vault): 自動檢查點可以由應用決定時機（ADR 0072）

## v0.54.0 — 2026-10-12

- feat(sync/vault): 中繼預算按收件人記帳、加密簽收單扣帳（ADR 0068）

## v0.53.0 — 2026-10-12

- feat(sync/vault): 搬進排除範圍不是刪除（ADR 0071）；整庫還原預覽列出會留著的檔案（ADR 0070）

## v0.52.0 — 2026-10-12

- feat(pairing,sync): 裝置改名——名單上帶時間重新簽名稱；協調器 setDeviceLabel（ADR 0069）
- test(bench): 收件確認的效益改成可重跑的基準測試（ADR 0067 實作計畫第 4 項）

## v0.51.0 — 2026-10-11

- chore(release): v0.51.0——收件確認後提早過期（ADR 0067）；README、PRD、dist
- feat(relay,sync): 收件確認後提早過期（SDK ADR 0067）
- docs(adr): 0067 收件確認後提早過期、0068 送出端預算按收件人記帳
- docs(adr): 0066 已知限制——中繼推得出同步群組有哪些裝置、誰還沒上線過
- docs: 對外定位改為「以 Nostr 為傳輸的私有、本機優先同步」，照實寫中繼看得到與保存什麼（ADR 0065）
- docs(adr): ADR 0064——中繼站主不可信任；bundle 不含秘密、日誌不帶使用者資料的守門測試

## v0.50.0 — 2026-10-08

- chore(release)!: v0.50.0——版本歷史用到時才載入（history／vaultAt／planRestoreVault 改非同步）、可選擇刪除 T 之後建立的二進位檔、還原前的檢查點跟著保留天數（ADR 0063）；README、PRD、dist
- docs(adr): ADR 0063 實作（v0.50）——API 變更、二進位檔逐檔備份的回呼、還原前檢查點過期的紀錄、摘要分片與內容參照者的儲存格式、遷移、實測與差異
- feat(sync/vault)!: 版本歷史用到時才載入、可選擇刪除 T 之後建立的二進位檔、還原前的檢查點跟著保留天數（ADR 0063〈待決〉三題）
- docs(adr): ADR 0063 待決三題裁示——二進位檔另開勾選才刪（不可復原、應用先備份）、還原前檢查點跟保留天數且過期後紀錄保留但不可復原、歸檔版本資訊改為用到時才載入

## v0.49.0 — 2026-10-08

- test(transfer): stream-queue 的打洞逾時由 300 ms 放寬到 10 秒，修掉整套測試負載下「續傳」測試偶爾什麼都沒送
- test(relay): PoW 達標的測試改用 minePow 挖礦（只算雜湊、中獎才簽章），修掉整套測試負載下的 5 秒逾時
- chore(release): v0.49.0——版本歷史只在 client 端：本機歸檔、還原、整個 Vault 回到時間點、檢查點與操作紀錄（ADR 0063）；README、PRD、dist
- docs(adr): ADR 0063 實作（v0.49.0）——補充裁示（參考 git：檢查點、操作紀錄、命名檢查點、時間點優先從檢查點推算）、API、儲存格式、日界、差異與待決
- feat(sync/vault): 版本歷史只在 client 端——本機歸檔、還原、整個 Vault 回到時間點、檢查點與操作紀錄（ADR 0063）
- fix(sync/vault): 只走直連的大檔內容會再要一次；被擋下的路徑由同步中的檔案佔用後不再列在 blockedLocal
- docs(adr): ADR 0063 已接受——使用者 2026-10-08 裁示六題（二進位只留版本資訊、v1 做整庫回到時間點）
- docs(adr): ADR 0063（提議中）——版本歷史只在 client 端：本機歸檔、列出／讀取／還原，中繼不變（使用者 2026-10-08 裁示原則，細節待決）
- docs(adr): ADR 0049 更正容量試算——命令每次 2 個 DO 請求（含 ack），1,300／3,800 台改為 1,200／2,800 台
- docs(adr): ADR 0049 R0 實測結果（四）——耗盡額度：家庭預算照設計預警並以 4429 關閉；免費方案 Workers／DO 到約 111% 都沒被擋、無錯誤；灌完後長連線 WS 退化約 6 小時（成因無法判定），設計以自家預算為第一道防線
- docs(adr): ADR 0061 實測——v0.48.0 複測：production 日誌確認 BadEnvironmentKeyInToken（金鑰限定 Sandbox），sandbox 2／2 通過

## v0.48.0 — 2026-10-06

- chore(release)!: v0.48.0——推播閘道 iOS 預設直連 APNs（breaking）、iOS 經 FCM 兩版棄用、APNs reason 進日誌（ADR 0062）；README、PRD、dist
- docs(adr): 記錄 v0.47.0 Workers 版推播閘道的邊緣實測（sandbox 2／2 通過；production 以限定 Sandbox 的金鑰如預期失敗）
- docs(adr): ADR 0062 §6——APNs 的 reason 進日誌（白名單、不進回應）、BadEnvironmentKeyInToken 單獨分類
- feat(iot/push-gateway): APNs 的 reason 以白名單進結構化日誌；403 BadEnvironmentKeyInToken 單獨分類（SDK ADR 0062 §6）
- docs(adr): ADR 0062——推播閘道 iOS 預設改為直連 APNs（兩版，breaking）、iOS 經 FCM 兩版都棄用、從 FCM 改過來不設過渡期
- feat(deploy/config)!: pushGateway.ios 預設改為 "apns"；ios: "fcm" 兩版都給棄用警告（SDK ADR 0062）
- feat(iot/push-gateway)!: PUSH_IOS 沒寫時改為 apns（兩版）；iOS 經 FCM 在 Node 版也棄用（SDK ADR 0062）

## v0.47.0 — 2026-10-06

- chore(release): v0.47.0——Workers 版推播閘道 iOS 直連 APNs（ADR 0061）；README、PRD、dist
- test(relay): DocHost 形狀兩個 64 桶測試給 30 秒（整套平行跑時超過預設 5 秒）
- docs(adr): ADR 0061——Workers 版推播閘道 iOS 也直連 APNs（fetch()＋ES256，與 Node 版共用請求與回應對照；iOS 經 FCM 相容並棄用）
- feat(deploy/config): 部署設定器的推播閘道 Workers 版可直連 APNs（pushGateway.ios: "apns"；SDK ADR 0061）
- feat(iot/push-gateway): Workers 版推播閘道 iOS 直連 APNs（fetch()＋ES256 provider token；SDK ADR 0061）
- docs(adr): ADR 0049 §11——Workers 直接以 HTTP/2 送 APNs 實測可行（fetch 與 connect 皆 400 BadDeviceToken、JWT 通過），Workers 版推播閘道 iOS 改直連、不經 FCM
- docs(adr): ADR 0049 R0 實測結果（三）——命令往返冷 p99 483 ms、暖 p99 453 ms、0 次結果未知，DO 休眠喚醒代價約 10 ms
- docs(adr): ADR 0049 R0 實測結果（二）——72 小時平台斷線（每台每日 8.5 次、靜默掛著 0.4 次）、15 分鐘內沒有閒置切斷、新預設心跳 72 小時零計費、容量重估約 1,300／3,800 台

## v0.46.1 — 2026-10-05

- test: 其餘子路徑「以套件名稱引用 dist」的測試也給 30 秒（同一原因）
- test: dist 子路徑載入與星狀中繼退路兩個慢測試給 30 秒（整套平行跑時超過預設 5 秒）
- chore(release): v0.46.1——清掉本機副本時 remove 帶 evict（ADR 0060，CinderSync G23）；README、PRD、dist
- feat(sync/vault): 清掉本機副本時告訴應用原因——remove 帶 evict（CinderSync G23，ADR 0060）

## v0.46.0 — 2026-10-05

- test(iot): 參考推播閘道的送出改用 vi.waitFor 等到結果，不寫死 50 ms（機器忙時偶發失敗）
- test(sync/vault): fetch 逾時的測試先接上 catch，不留未處理的 rejection（npm run check 會把它算成錯誤）（ADR 0058）
- chore(release): v0.46.0——輕量成員（ADR 0058）、Markdown 合併規則（ADR 0059）；README、PRD、dist
- docs(adr): ADR 0058 輕量成員、ADR 0059 Markdown 合併規則（使用者 2026-10-05 裁示逐條）；索引同步；0025、0046、0047 加註
- feat(pairing): 輕量成員宣告——declareSparse／scopeOf／sparseMembers／fullMembers、能力宣告的 allDeclare；配對歡迎訊息只帶邀請方自己的宣告（ADR 0058；ADR 0059 的開關）
- feat(sync/vault): 輕量成員（scope／fetch／pin／evict／remoteIndex、送出端依收件人裁剪、nodes 訊息、VaultWantResponder）與 Markdown 合併規則（同路徑新建收成一個、勾選框自動合併）（ADR 0058、0059）
- feat(sync): merge3 的衝突區塊解決規則——任務勾選框自動合併（resolveTaskCheckboxConflict，已勾的贏）、沒有共同祖先時的空檔祖先（commonLinesBase，精簡成兩邊共同的行）（ADR 0059；使用者裁示 5、7）

## v0.45.0 — 2026-10-05

- chore(release): v0.45.0——CinderSync 缺口 G11 第 1 部分（ADR 0056「甲」）；G17(b) 裁示 B0；README、PRD、dist
- docs(adr): ADR 0056 改為已接受——使用者裁示「甲」與各待決題的定案、實作節；ADR 0053 §G17(b) 使用者裁示 B0（不做）；索引同步
- feat(pairing): 備援中繼清單經名單共享——declareStandby／declaredStandbys、StandbySuggestions／planStandbyAdoption（只建議新增、公開 wss://、測得通、使用者確認），配對歡迎訊息帶邀請方的備援（ADR 0056「甲」；CinderSync G11 第 1 部分）

## v0.44.0 — 2026-10-04

- fix(sync/vault): retryPeers(device) 也開（或沿用）到那台的通道並掛上收方，只等著收大檔的那台探測後收得到（ADR 0057 §同版的修正；ADR 0053 §G15）
- fix(relay-pool): readUrls 的中繼開始補發（進入寫入集合）時也發健康狀態通知，watchRelayFileLimits 跟著重算（ADR 0057 §同版的修正；ADR 0054）
- fix(sync): parseConflictCopyName 拆得回「原檔沒有副檔名＋裝置名稱含點」的副本（README (衝突-Joe.Mac-…)）（ADR 0057 §同版的修正；ADR 0053 §G18）
- chore(release): v0.44.0——CinderSync 缺口 G22（ADR 0057）；README、PRD、dist
- docs(adr): ADR 0057——writeStream 的來源帶內容的 SHA-256（CinderSync G22）
- feat(sync/vault): writeStream 的來源帶內容的 SHA-256——VaultContentSource.sha256＝收完時已校驗過的 node.hash（ADR 0057；CinderSync G22）

## v0.43.0 — 2026-10-04

- chore(release): v0.43.0——CinderSync 缺口 G11（第 2 部分）、G13–G18、G20（ADR 0053–0055；0056 提議中）；README、PRD、dist
- docs(adr): ADR 0053–0056——CinderSync 缺口 G11、G13–G18、G20 的決策；G17(b) 與名單共享中繼清單（G11 第 1 部分）提議中、待裁示
- feat(deploy): REST 部署進度的子步驟 id 與雙語訊息、名稱檢查的雙語問題——checkRelayName、collectCloudflareApiDeployIssues（ADR 0055；CinderSync G20）
- feat(relay-pool): 只訂閱、不寫入的中繼 readUrls——常駐訂閱、退避重連，只在 durability.standby 需要時補發（ADR 0054；CinderSync G11 第 2 部分）
- feat(sync/vault,pairing): 公開各裝置已知的版本頭與接收狀態——peerStatus、peerStatuses、knownHeads、notePeerActivity；名單同步 onMemberActivity（ADR 0053 §G17(a)；CinderSync G17）
- feat(transfer,sync/vault): 直連傳輸進度——收方 onProgress／onSessionEnd、協調器 transfers()、on('progress')、status().p2pBytes（ADR 0053 §G14；CinderSync G14）
- feat(sync/vault): blocked 在佇列清空後重新驗證、retryPeers、setRelayBulkPerHour（ADR 0053 §G13、§G15、§G16；CinderSync G13、G15、G16）
- feat(sync): 匯出 parseConflictCopyName 與 freePathCandidate——衝突副本檔名與編號同一處維護（ADR 0053 §G18；CinderSync G18）

## v0.42.0 — 2026-10-04

- chore(release): v0.42.0——換私人路徑之後的唯讀寬限期與中繼搬家通知（ADR 0052）；README、PRD、dist
- feat(relay,deploy,pairing): 換私人路徑之後的唯讀寬限期與中繼搬家通知——READONLY_LANES、retireLane、announceRelayMove（ADR 0052；CinderSync G21）

## v0.41.0 — 2026-10-04

- chore(release): v0.41.0——個人專屬中繼的私人路徑模式（ADR 0051）；README、PRD、dist
- feat(relay,deploy): 個人專屬中繼的私人路徑模式——LANES_ONLY 與 privateLane（開放寫入＋不可猜的隨機路徑；ADR 0051）

## v0.40.0 — 2026-10-03

- chore(release): v0.40.0——IoT 推播的 SDK 側（ADR 0049 §11.1）；README、ADR、PRD、dist
- docs(iot): 設備端推播送出的規格與 Node 參考實作（examples/iot-device，MIT-0；ADR 0049 §11.1 裁示 3、7）
- feat(deploy): 部署設定器加入推播閘道（service: push-gateway；ADR 0049 §11.1 裁示 5、7，ADR 0050）
- feat(iot): 參考推播閘道——Workers 版（FCM）與 Node 版（FCM＋直連 APNs）（ADR 0049 §11.1 裁示 3、5、7）
- feat(iot): 推播的 SDK 側協定、送出端排程器與閘道送出（ADR 0049 §11.1）
- docs(adr-0049): §11 IoT 推播七項裁示——client 自帶端點、憑證只在推播閘道、誰知道端點誰就送、client 選標準／即時、Workers／Node 兩版推播閘道、UnifiedPush 與 FCM 同等、上限可調
- docs(adr-0049): 新增 §11 IoT 推播草案（沿用 Cinderous ADR-0272 無內容喚醒與 SDK ADR 0011 §6；7 項待決）
- docs(adr-0049): 預設心跳改為應用層＋setWebSocketAutoResponse（R0 實測不計費、可讀最後心跳時間；使用者裁示）
- docs(adr-0049): R0 實測（一）——協定 ping 與自動回覆都不計請求；無自動回覆的應用層心跳每則計 1 個 DO 請求；平台斷線每台每日 8–24 次；容量保守重估

## v0.39.0 — 2026-10-02

- chore(release): v0.39.0——IoT P0（路線 A：./iot、./iot/bridge、cinderous iot；ADR 0049）；README、ADR、dist
- feat(cli,deploy): cinderous iot bridge／iot acl／iot keygen／iot build（橋接器 Docker 建置內容；ADR 0049 P0）
- feat(iot/bridge): 家中橋接器 ./iot/bridge（mqtt.js 選用 peer 相依）＋端到端測試與守門（ADR 0049 P0）
- feat(iot): ./iot 協定、IotClient 與閘道核心 IotGateway（ADR 0049 P0）
- docs(adr-0049): 其餘 14 項待決事項逐項裁示，改為已接受——低頻控制定位、錨點 A 專屬 iot 車道、盲化不做 Gift Wrap、順序 A→PoC→C′＋C→B、QR 配對與 owner 名單、不代發遺囑、設備端 MIT-0、Workers 可放家庭秘密（明示風險）、私有網段與 Tunnel 分埠、MQTT 選用 peer 相依、/mqtt 限區網、不做逐成員可見、不加 ChaCha20、Shelly 不自組加密
- docs(adr): 0049 加入路線 C′ 即時通道與免費額度用完的處理（使用者裁示）

## v0.38.0 — 2026-10-02

- chore(release): v0.38.0——部署設定器 P0（ADR 0050）；README 更正 OAuth 說法、dist
- feat(cli,deploy): relay build／relay deploy --config／config validate|schema；home-tunnel 部署（ADR 0050 P0）
- feat(deploy/config): 部署設定檔 cinderous.config.json——描述表、JSON Schema、收集式驗證、可攜部署包、中英部署說明（ADR 0050 P0）
- refactor(deploy): 設定檔產生器搬到不碰 Node 的 render.ts（ADR 0050 P0）
- refactor(deploy): relaySiteVars 抽出收集式驗證 collectRelaySiteIssues；NIP-11 software 可設定（RELAY_SOFTWARE_URL）（ADR 0050 P0）
- docs(adr-0050): 使用者裁示——只做中繼部署、設定檔＋CLI 精靈、JSON、MIT-0 產生物、home-tunnel 正式目標、NIP-11 software 可設定；改為已接受
- docs(adr-0050): 部署設定器（提議中）——設定檔驅動、延伸既有 CLI、可攜部署包與自動部署說明
- docs(adr-0049): IoT kind 改為 25170–25173（避開禮物包信令段 21000–21999，使用者決定）
- docs(adr-0049): 輪詢模式的端到端加密改為可設定選項、新增查詢 kind 21173、閘道端角色權限與中繼端保險（仍為提議中）
- docs(adr-0049): IoT 的三條路線與部署時選用的 relay 模式（提議中）

## v0.37.1 — 2026-10-02

- fix(sync): 衝突副本來回震盪——自己套用的改名的回音被誤認成使用者改名；空檔不產生衝突副本（v0.37.1，ADR 0048）
- docs(adr-0047): 記錄使用者確認——移進自己排除的資料夾＝其他裝置刪除（選項 A）

## v0.37.0 — 2026-10-01

- feat(sync): 使用者自訂的同步排除範圍——gitignore 風格兩層規則、排除不等於刪除、執行中更新（v0.37.0，ADR 0047）

## v0.36.0 — 2026-10-01

- feat(sync,client,pairing): 沒有中繼回完的查詢不推進游標與排程同步接口（G12）、Markdown 衝突就地 callout（v0.36.0，ADR 0045、0046）

## v0.35.1 — 2026-10-01

- fix(client,sync): 重新讀到 NIP-11 後重新驗證「不適用」標記、watchRelayFileLimits 定期重讀（v0.35.1，ADR 0044）

## v0.35.0 — 2026-10-01

- feat(pairing,peer,sync): 名單同步可選 NIP-59 禮物包外層、同一身分共用的中繼事件預算（v0.35.0，ADR 0043）

## v0.34.0 — 2026-10-01

- feat(relay): 每顆 DO 的天花板設定、保底份額、溢位帶、粗分級預警與丟棄計數（v0.34.0，ADR 0042；ADR 0038 P2、ADR 0039 B1、Cinderous ADR-0377 移植）

## v0.33.0 — 2026-09-30

- feat(client): 每座中繼的健康狀態、耐久度要求與延遲連線的備援、queryEach、讀回稽核與 NIP-65／17 中繼清單（v0.33.0，ADR 0038 P1、ADR 0041）

## v0.32.0 — 2026-09-30

- feat(relay,client): 拒收訊息帶英文詞元、可尋址拒收依原因拆開、duplicate 改回 OK true；客戶端分類拒收、讀關閉碼、回報部分拒收（v0.32.0，ADR 0038 P0-R2／P0-C、ADR 0040）
- docs(adr-0039): 中繼暫時容量緩衝研究（提議中）——同 DO 溢位帶、調大熱門車道天花板、帳號總量閘

## v0.31.1 — 2026-09-30

- fix(relay): 離線留言存不下時回 OK false「blocked: ceiling:」、不扇出；已過期回「invalid: expired:」；被拒的事件不記進重放快取（v0.31.1，ADR 0038 P0-R1）
- docs(adr): 0038 中繼資料上限造成的靜默故障——分類、回報與自動改用其他中繼（研究，提議中）

## v0.31.0 — 2026-09-30

- feat(deploy): 一鍵部署可設定已知租戶車道（appLanes）與站台參數，四條部署路徑共用 RelaySiteOptions；REST 重新部署改名單要 allowLaneChange；NIP-11 宣告可尋址配額與每 IP 上限（v0.31.0，ADR 0036、0037）

## v0.30.0 — 2026-09-30

- fix(relay-pool): 補訂閱對禮物包／收件匣 filter 退讓 NIP-59 兩天，重連後不再漏收；名單能力宣告與 minCapability；內容相同的路徑相撞直接收斂（v0.30.0，ADR 0035）
- docs(readme): overrides 補充——相依樹還有 @noble 1.x 時改用只對 nostr-tools 的巢狀寫法；npm lockfile 需刪三筆重裝

## v0.29.0 — 2026-09-29

- chore(deps): @noble 升到 2.4.0（常數時間保證、Trail of Bits 審查修正），SDK 開發樹以 overrides 讓 nostr-tools 共用同一份（v0.29.0，ADR 0034）

## v0.28.0 — 2026-09-29

- feat(crypto): 雙棘輪後量子線路格式 v2——ML-KEM 輪次與 DH 步進脫鉤、延後混入，每則 header 2,314 → 50 B（v0.28.0，ADR 0033）

## v0.27.0 — 2026-09-29

- fix(relay): 移植 Cinderous 兩個正式環境修正——DO SQLite 綁定參數上限改用 json_each(?)、大訂閱溢位到 ws_subs 不再撞 attachment 16KB（v0.27.0，ADR 0032；Cinderous ADR-0372／0373）
- docs(adr): 0031 跨外掛共用中繼連線（Cinder Coffice G8）評估——建議不做

## v0.26.0 — 2026-09-29

- test(sync): 協調器 × PeerNode 的打洞逾時放寬到 2 秒——整套測試滿載時 200 ms 會在假 WebRTC 連上前改走中繼
- feat(star): 多人星狀會話 ./star——Host 解密再以成對雙棘輪轉送、邀請／踢出、Host 序號全序、每成員背壓、中繼軌事件預算（v0.26.0，ADR 0030）

## v0.25.0 — 2026-09-29

- feat: 對齊中繼的檔案車道——單檔 30MB、依 NIP-11 決定上限與補送塊數預算、以 until 分頁取回；中繼移植 FILE_LANES（v0.25.0，ADR 0029；Cinderous ADR-0371）

## v0.24.0 — 2026-09-29

- feat(pairing): QR 裝置配對與 Vault 名單 ./pairing；白名單站放行已認證成員的禮物包（v0.24.0，ADR 0028）

## v0.23.0 — 2026-09-29

- feat: P2P 批次串流、大檔串流寫入與可持久化佇列；協調器改走 P2P 批次；中繼檔案事件（v0.23.0，ADR 0026、0027）

## v0.22.0 — 2026-09-29

- feat(sync): 檔案樹同步協調器 ./sync/vault（v0.22.0，ADR 0025）

## v0.21.0 — 2026-09-29

- feat: ./transfer 子路徑、同步與協定 API 接受 Identity、非同步 ChatStorage（v0.21.0，ADR 0023、0024）

## v0.20.0 — 2026-09-29

- feat(deploy): 建立 Cloudflare Token 的步驟說明改由 SDK 以資料匯出（v0.20.0，ADR 0022）
- docs(adr-0021): 記錄 REST 部署真實帳號實測結果

## v0.19.0 — 2026-09-29

- feat: 不依賴 Node 的 Cloudflare 一鍵部署——REST API、注入式 HTTP、預先打包的 Worker（v0.19.0，ADR 0021）
- chore(license): LICENSE 換成 gnu.org 官方 AGPL-3.0 原文

## v0.18.0 — 2026-09-29

- perf: 遊戲打包縮小一半——@noble 升 2.x 並與 nostr-tools 釘同一版、nip44 走子路徑（v0.18.0，ADR 0020）

## v0.17.0 — 2026-09-28

- feat!: 中繼預設值改為中立（v0.17.0，ADR 0019）

## v0.16.0 — 2026-09-27

- feat: relay deploy --provider=docker|fly（v0.16.0，ADR 0018）

## v0.15.1 — 2026-09-27

- docs: turn-fetch 的註解被全域取代誤改，改回「與 DOM 的 RTCIceServer 相容」（v0.15.1）

## v0.15.0 — 2026-09-27

- feat: TURN 憑證便利函式 TurnProvider（v0.15.0，ADR 0017）

## v0.14.0 — 2026-09-27

- feat: 音訊／視訊通話 CallManager（v0.14.0，ADR 0016）

## v0.13.0 — 2026-09-27

- feat: 檔案傳輸與續傳、等 P2P 才送的大檔佇列（v0.13.0，ADR 0015）
- docs: 外掛規格移除「軍規／Military-Grade」用詞，改為如實的「實驗性」描述

## v0.12.0 — 2026-09-27

- feat: 加密引擎的場景預設與自動協商（v0.12.0，ADR 0014；PRD 3.5.3）

## v0.11.0 — 2026-09-27

- feat: 中繼存取控制（v0.11.0，ADR 0013；PRD 3.3）

## v0.10.1 — 2026-09-27

- refactor: 私訊改走 protocol/nip59，SDK 只留一份禮物包實作（v0.10.1，ADR 0012）

## v0.10.0 — 2026-09-27

- test: 整套平行跑時的時序放寬（P2P 假網路連線逾時、SQLite 大量寫入的測試逾時）
- feat: 多裝置同步 @cinderous/client/sync（v0.10.0，ADR 0011）

## v0.9.0 — 2026-09-27

- feat: 雙棘輪與 secureChannel，經獨立安全審查修正（v0.9.0，ADR 0010 第二部分）

## v0.8.0 — 2026-09-27

- feat: Cinder EK 金鑰環與 EK 協定（v0.8.0，ADR 0010 第一部分）

## v0.7.0 — 2026-09-27

- feat: 點對點連線 connectPeer，打不通自動改走中繼（v0.7.0，ADR 0009）

## v0.6.0 — 2026-09-27

- feat: 中繼白名單、純記憶體模式、cinderous 命令列與一鍵部署、CI（v0.6.0，ADR 0008）

## v0.5.0 — 2026-09-27

- feat: 中繼與共用協定搬進 SDK（v0.5.0，ADR 0007）
- docs(adr): ADR 0006 補記協同邀請改用 kind 21005
- docs: PRD 五處矛盾拍板（ADR 0006）

## v0.4.1 — 2026-09-27

- fix(query): 被 auth-required 擋下的一次性查詢在認證後重送（v0.4.1）

## v0.4.0 — 2026-09-27

- feat(relay-pool): 一次性查詢 query——等每一座都回 EOSE（v0.4.0，ADR 0005）

## v0.3.1 — 2026-09-27

- feat(relay-pool): connectTimeoutMs——卡在連線中的 socket 逾時當作斷線（v0.3.1）

## v0.3.0 — 2026-09-27

- feat(relay-pool): 訊框上限、補訂閱游標、reconnectNow、lastActivityAt（v0.3.0，ADR 0004）

## v0.2.0 — 2026-09-27

- feat(relay-pool): 逐座探針 ping 與 isAuthenticated（v0.2.0，ADR 0003）

## v0.1.1 — 2026-09-27

- feat(relay-pool): setAuthIdentity——先開池、後給身分，已收到的 AUTH 挑戰立刻補回覆（v0.1.1）

## v0.1.0 — 2026-09-27

- feat: @cinderous/client v0.1——多中繼連線池、NIP-44／NIP-17 私訊、封鎖名單、身分與試算器
- Initial commit
