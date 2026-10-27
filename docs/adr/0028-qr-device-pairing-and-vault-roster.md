# 0028. QR 裝置配對與 Vault 名單：`./pairing` 子路徑、一次性秘密＋臨時 ECDH＋身分金鑰的握手、6 位數 SAS、可合併的名單與撤銷輪換

- Status: Accepted
- Date: 2026-09-29
- 加註（2026-10-01，ADR 0045）：名單送不出去時記成 `pending`、`retryPending()`、`retryOnReconnect`、`pendingStore`（預設只記不送）；協調器的摘要可以節流（`digestPolicy`）。
- 相關：
  - ADR 0021〈後續〉#3（CinderSync G5）
  - ADR 0009（`PeerNode`、NIP-59 信令 kind 21000）、0010（`secureChannel` 握手的手法）、0012（唯一一份 NIP-59）、0013（白名單）、0023（`NostrSigner`）、0025（協調器、kind 1060 外層）、0026（`peerNodeLink`）、0027（白名單站開檔案事件）
  - CinderSync ADR 0003（每台裝置各自一把身分金鑰、存 SecretStorage、不跨裝置複製私鑰）

## Context

CinderSync 要讓同一個 Vault 的新裝置加入：外掛只做 QR 的顯示與掃描，配對協定與金鑰交付由 SDK 提供（外掛 PRD、ARCHITECTURE §5 G5）。限制：

- **每台裝置各自一把身分金鑰，私鑰不離開裝置**（外掛 ADR 0003）。配對的產物不能是「複製一把私鑰」。
- 先查協調器實際需要什麼（ADR 0025 §5）：它對**每一台收件裝置各包一顆 NIP-59**，加密金鑰就是各裝置的身分金鑰；它需要的是「同一個 Vault 有哪些裝置」——`NostrVaultTransport` 的 `devices`／`trusted`、`peerNodeLink` 的 `deviceId → 公鑰`、`PeerNode` 的 `acceptFrom`。協調器**不需要**共享對稱金鑰。
- 外掛 ADR 0003 預留了「若 G5 採 Vault 共用對稱金鑰，也存 SecretStorage」；外掛的一鍵部署要把「所有自己裝置的公鑰」寫進中繼白名單（ADR 0027）。
- 行動版沒有 Node；手機相機要能在一般距離穩定掃到 QR；QR 可能被旁人拍到。

## Decision

### §1 新子路徑 `@cinderous/client/pairing`，零 Node

- 主入口、`./sync`、`./sync/vault`、`./transfer`、`./protocol` 都不帶配對（`tests/pairing/subpath.test.ts` 以 esbuild 實際打包守著）；模組圖沒有 Node 內建模組、沒有連線池執行期、部署、中繼、同步。
- QR 影像的產生與掃描**不在 SDK**：SDK 只產生與解析字串，外掛用自己的 QR 函式庫。

### §2 QR 內容：`cinderous-pair:1.<核心>.<中繼>[,<中繼>]`

| 欄位 | 大小 | 說明 |
|---|---|---|
| 協定版本 | `1` | 放在前綴後；未知版本回 `unsupported-version`（請更新） |
| 旗標 | 1 byte | bit0：`invite`（顯示方是成員）／`join`（顯示方是新裝置）；其他位元保留、必須是 0 |
| 顯示方身分公鑰 | 32 bytes | 掃描方只信這把公鑰簽的訊息 |
| 一次性配對秘密 `s` | 16 bytes（128 位元） | 只經 QR 光學通道，不上網路 |
| 到期時間 | u32 秒 | 預設 5 分鐘 |
| 中繼 | 1–2 座 | `wss://` 省略；其他協定照寫；含逗號、空白等字元的放不進 QR |

- 核心 53 bytes 以 base64url（無補位）編成 71 字元。**不放 Vault 名稱或任何 Vault 識別**：顯示方的公鑰就是會合點；Vault 識別（隨機 `vaultId`）在加密的歡迎訊息裡才交付。
- **容量**：大小寫有別，QR 用位元組模式；以錯誤修正等級 **M**，整串上限 **213 bytes＝QR 版本 10**（57×57 模組）。實測：一座 workers.dev 中繼 124 bytes＝版本 8；兩座一般長度的中繼約 150 bytes＝版本 8；兩座各 60 字元的中繼仍 ≤ 版本 10。`encodePairingUri` 依序放中繼、放不下就少放；`qrVersionFor(字串, 等級)` 給外掛估算。
- 為什麼 128 位元就夠：`s` 一次性、5 分鐘、只在光學通道；網路上的攻擊者看不到它，也沒有可以離線暴力破解的東西（見 §3）。

### §3 握手：一次性秘密（PSK）＋臨時 ECDH＋身分金鑰，NIP-59 over ephemeral kind 21003

**角色**：顯示方／掃描方 × 成員／新裝置。`invite`：成員顯示、新裝置掃（新手機掃桌機）；`join`：新裝置顯示、成員掃（新桌機沒有相機，由手機來掃）。兩種角色走同一套訊息。

**訊息**：全部是 NIP-59 禮物包（seal 由寄件人的身分金鑰簽章、外層一次性金鑰），ephemeral kind **21003**（新 kind，接在 21000 信令、21002 通話之後；中繼不保存），`["p", 對方身分公鑰]`，內容 JSON 帶 `v: 1`。沒有改任何既有格式。

```
掃描方 S                                                        顯示方 D
  （QR：D 的公鑰、s、到期、中繼）
  hello   {v,p,e_S,d,l}                         ──→  p＝HKDF(s,"pid") 對得上？沒過期？第一台？
                                                      （第二台拿同一個 QR 來 → contested，作廢，通知第一台）
                                                ←──  accept {v,p,e_D,d,l, m=HMAC(kc,"accept"‖th)}
  seal 簽章者＝QR 上的公鑰？MAC 對？
  confirm {v,p, m=HMAC(kc,"confirm"‖th)}        ──→  MAC 對？
  ─────── 兩台螢幕都顯示同一組 6 位數 SAS；使用者比對後各自按「確認」───────
  （新裝置那一側）ok {v,p, m=HMAC(kc,"ok"‖th)}  ──→  （成員那一側）本機確認＋收到 ok → 名單加入新裝置
                                                ←──  welcome {v,p, c=XChaCha20-Poly1305(kMJ, {roster, relays}, aad=th)}
  done {v,p, m=HMAC(kc,"done"‖th)}              ──→  完成
  任一方「不符／取消」→ abort {v,p,why}
```

（`join` 角色時，上圖的「新裝置那一側」是顯示方，箭頭方向相應對調；`ok` 永遠由新裝置送、`welcome` 永遠由成員送。）

**金鑰**：

```
pid = HKDF-SHA256(s, salt="cinderous/pair/v1", info="pid")[0..16]
th  = SHA-256(JSON[標籤, 角色, D 公鑰, S 公鑰, pid, e_S, e_D, S 的 deviceId/名稱, D 的 deviceId/名稱])
ikm = ECDH(e 自己, e 對方) ‖ NIP-44 對話金鑰(身分, 身分) ‖ s
okm = HKDF-SHA256(ikm, salt=th, info="cinderous/pair/v1/keys", 128)
    = kc（確認 MAC）‖ kMJ（成員→新裝置 AEAD）‖（保留）‖ ksas
SAS = (ksas 前 4 bytes, big-endian) mod 10^6，補零成 6 位數
```

**為什麼採 PSK＋ECDH，而不是 PAKE（SPAKE2／CPace）**：PAKE 解決的是**低熵**密碼（人記得住的數字）被離線暴力破解；我們的 `s` 是 128 位元隨機值、只經光學通道，網路攻擊者既看不到也猜不到，沒有可離線驗證的東西（`pid` 在禮物包裡，只有顯示方解得開）。PSK＋ECDH 用的全是 SDK 已有的原語（secp256k1、HKDF、HMAC、XChaCha20-Poly1305，皆 @noble），不增加依賴，也不必評估新的 PAKE 實作。

**各項性質從哪裡來**：

| 性質 | 來源 |
|---|---|
| 掃描方確定對方是 QR 上那台 | QR 裡的公鑰（光學通道）＋每則訊息 seal 的 Schnorr 簽章＋ikm 混入身分對話金鑰 |
| 顯示方確定對方看過 QR | `pid` 與 `kc` 都由 `s` 導出；`confirm` 的 MAC 證明掃描方有 `s` 與自己的臨時私鑰、身分私鑰 |
| 不被中繼竄改或冒名 | 禮物包（NIP-44 MAC＋seal 簽章）＋`th` 綁定雙方公鑰、臨時公鑰、裝置名稱 |
| 前向保密 | 交付內容由臨時 ECDH 保護；之後身分金鑰外洩，也解不開當時錄下的歡迎訊息 |
| 對只在網路上的攻擊者（含將來的量子電腦）| ikm 混入 `s`，而 `s` 從未上網路 ⇒ 光有網路流量算不出 kMJ（harvest-now-decrypt-later 也一樣；前提是 QR 沒被拍到） |
| 金鑰確認 | 雙方各自驗過對方一則 MAC 才顯示 SAS |

**QR 被旁人拍到**（攻擊者有 `s`，但沒有任何一台的私鑰）：

- 一次性：顯示方只接受**第一台**的 hello；在完成之前又有另一台（或同一台換了臨時金鑰）拿同一個 QR 來，**整次作廢**（`contested`），並通知**兩台**。完成後訂閱關閉、一次性秘密清零，之後的 hello 沒人聽。
- 短時效：預設 5 分鐘；掃描方另外拒絕明顯過期的 QR（容許 2 分鐘時鐘誤差）。
- 攻擊者搶在真的裝置之前完成握手：攻擊者只能和**顯示方**建立工作階段；真的裝置只接受 QR 上那把公鑰簽的回應，而顯示方的回應是加密給攻擊者的 ⇒ **真的裝置螢幕上不會出現任何 SAS**（或出現 `contested`）。使用者比對不到數字而按「不符」。
- 攻擊者同時控制中繼、把真的裝置的訊息全擋掉：同上，真的裝置沒有 SAS。
- SAS 被猜中：攻擊者要讓**兩台**螢幕出現同一組數字，得同時和兩台各建一個工作階段，而掃描方只信 QR 上的公鑰 ⇒ 做不到；而且 hello 先送（掃描方的臨時公鑰先承諾），顯示方最後才出臨時金鑰，攻擊者（永遠在掃描方的位置）沒辦法看了 SAS 再改。
- 雙方確認：成員只在「本機使用者按確認」＋「新裝置的使用者也按了確認（`ok`）」兩者都成立後，才把新裝置加進名單、交付名單與金鑰。

**重放與遺失**：`pid` 每次不同，上一次配對的任何訊息在新的一次裡都被忽略；同一則重複投遞是冪等的（同一個臨時公鑰的 hello 只會讓顯示方重送 accept）。訊息遺失靠重送（3 秒起、指數退避到 30 秒）。`done` 遺失時成員在確認時限到期後仍算完成（`acknowledged: false`），名單已經加入。

**時限**：QR 5 分鐘（`ttlMs`）；掃描方等回應 60 秒（`handshakeTimeoutMs`）；使用者比對確認 3 分鐘（`confirmTimeoutMs`）。

### §4 名單：`VaultMembership`（互相信任的裝置清單＋共享 Vault 金鑰）

- 內容：`vaultId`（隨機 16 bytes）、裝置（公鑰、`deviceId`、名稱、加入時間、誰加的）、撤銷（公鑰、時間、誰撤的）、金鑰（epoch、id＝SHA-256 前 8 bytes、32 bytes 金鑰、建立時的撤銷集合雜湊 `rv`）。
- **每一筆都有簽章**（安全審查 #1、#3 之後加上；以 `NostrSigner.sign` 簽一個不發布的領域分隔事件 kind 4362，只留簽章）：
  - 裝置：**裝置自己**簽 `(公鑰, deviceId, 名稱)`（`claimDevice`，配對時隨 `ok` 送來），加入者再簽整筆（含 `vaultId`、加入時間）⇒ 別的成員改不了某台裝置的 deviceId 或名稱，`addedBy`／`addedAt` 也不能冒名；
  - 撤銷：撤銷者簽 `(vaultId, 公鑰, 時間)`；
  - 金鑰：建立者簽 `(vaultId, epoch, id, 時間, rv)`，金鑰本身以 id 綁定。
  驗過的簽章有快取，同一份名單再收到不重驗。
- **可合併**（每台都能改，改完送給其他成員）：裝置以公鑰聯集；撤銷以公鑰聯集且**撤銷永遠贏**（2P-set）；金鑰以 id 聯集。只收**目前有效成員**送來、同一個 `vaultId`、逐欄與逐筆簽章驗證通過的名單。
- **目前的金鑰**＝**建立者仍是有效成員**的金鑰中 epoch 最大者（同 epoch 取 id 較小）。新金鑰的 epoch＝有效金鑰的最大 epoch＋1，上限 2^31。所以一台被入侵的成員在被撤銷前塞進來的金鑰（不論 epoch 多大、`rv` 填什麼），在它被撤銷後都不能當目前的金鑰，也不影響之後的輪換。
- **上限時部分保留、不整筆拒收**（審查 #4）：有效裝置超過 32 台時留 `(加入時間, 公鑰)` 較早的；撤銷超過 32 筆時先丟「撤銷者本身已被撤銷」的、再丟最舊的；金鑰超過 8 把時先丟建立者已被撤銷的、再丟 epoch 最小的。每一台由同一組資料算出同一個結果，所以兩個分區各自加到上限後照樣收斂；被入侵的成員先塞滿撤銷紀錄，之後照樣撤銷得了它。
- **deviceId**：協調器用的裝置識別碼。預設 `defaultDeviceId(公鑰)`（`d`＋公鑰前 16 位 hex），每台各自一把身分所以天然不重複；別的公鑰的預設 deviceId 不能拿來用。兩台同時各加一台同名的自訂 deviceId 時，所有裝置一致地只認 `(加入時間, 公鑰)` 較早的那台。
- **deviceId 綁定寄件人**（審查 #5）：`NostrVaultTransport` 新增選項 `deviceOf`（接 `membership.deviceIdOf`），協調器訊息的 `from` 必須是寄件公鑰自己的 deviceId，名單上的一台裝置不能冒用另一台。P2P 軌本來就以通道認證的公鑰綁定。
- **給協調器與白名單的查詢**：`deviceIdOf(公鑰)`、`peerPubkeys()`（`NostrVaultTransport` 的 `devices`、`PeerNode` 的 `acceptFrom`）、`peerDevices()`（`peerNodeLink` 的 `devices`）、`allowedPubkeys(extra?)`（ADR 0027 部署的白名單：所有有效成員含自己，加上例如正在配對的新裝置；被撤銷的公鑰一律不在裡面）、`currentKey()`／`key(id)`／`keys()`。
- **共享 Vault 金鑰**：協調器不用；給外掛自己的對稱加密需求（例如加密的匯出備份）。應用可以把金鑰 id 記在密文旁邊，解密時用 `key(id)` 找。
- **為什麼不用裝置目錄 kind 10041**：10041 是「同一把身分底下有哪幾把裝置子金鑰」、加密給自己、由身分金鑰簽的可取代事件（ADR-0322）；CinderSync 每台裝置是**不同的身分**，沒有共同的簽章者，也沒有人能「加密給自己」讓別台讀到。名單改由成員之間互送（§5）。
- **持久化**：`toJSON()`／`VaultMembership.restore(json, signer)`。內容含共享金鑰，要存在平台的機密儲存（Obsidian `app.secretStorage`），**不要**寫進會被同步出去的 `data.json`（與外掛 ADR 0003 一致）。
- 上限：32 台裝置、32 筆撤銷、8 把金鑰、名稱 40 字（清掉控制字元）。滿載的名單（連同 16 座 500 字元的中繼網址）仍塞得進一顆名單事件與一則歡迎訊息（NIP-44 明文上限 65,535，測試守著）；歡迎訊息的中繼清單送出與接收兩端都裁到 16 座、每座 ≤ 512 字元，密文以 base64。

### §5 名單同步：`NostrRosterSync`（kind 1060 外層、內層 rumor kind 4361）

- 名單一有變動（加入、撤銷、輪換、合併出新內容），就把完整名單以 NIP-59 送給**目前有效的其他成員**。外層與協調器相同（kind 1060、`#p`、7 天過期章），所以中繼要開 `MAX_FILE_MB`（ADR 0027，Vault 同步本來就需要）。內層是新的 rumor kind 4361：Cinderous 的 `parseFileChunk`（只認 43）與協調器的傳輸層（只認 4360）都會略過。
- 收到：寄件人必須是本機名單上的有效成員，交給 `merge`；合併出新內容 → 再送一輪；沒有新內容就停，所以會收斂。`start()` 預設先把目前的名單送一次，讓離線超過 7 天保留期的成員補齊。
- **加註（2026-10-01，v0.35.0，ADR 0043）**：外層可選 `outerKind: 1059`（標準 NIP-59 禮物包，內層仍是 4361），給不收 1060 的中繼
  （官方錨點與預設自架站的非檔案車道回 `blocked: files-disabled:`）。預設仍是 1060；同一份名單的每一台要用同一個值，不同外層互相收不到。
  滿載名單包成 1059 實測 109,769 bytes，在單顆上限 262,144 bytes 內。送出時取同一身分共用的事件預算（ADR 0043 §2）。
- **動態名單**（這一批對既有 API 的**新增**，向下相容）：`NostrVaultTransport.setDevices(devices, trusted?)`；`peerNodeLink({ devices })` 的 `devices` 可以是函式（`() => membership.peerDevices()`）；協調器的 `resync()`（送一次摘要給所有裝置）。

### §6 撤銷語意

`membership.revoke(公鑰)`：

- 從名單、白名單查詢、收件人移除；**輪換共享金鑰**（epoch＋1，新金鑰只送給剩下的成員）。
- 被撤銷的裝置：收不到之後的名單與新金鑰；協調器不再送給它（`setDevices`）、也不再收它的訊息（信任名單）；外掛重新部署白名單後，連自己的中繼也連不上。
- **舊的內容與舊金鑰無法追回**：它已經同步到的檔案、已經拿到的金鑰（含歷史金鑰）都還在它手上。撤銷只保護**之後**的內容。
- 被撤銷的公鑰不能再加回來（撤銷永遠贏）；那台裝置要重新加入，得先重設身分（產生新的身分金鑰）再配對。
- 並發：A 撤銷 X、B 同時撤銷 Y，各自輪換——A 的新金鑰會送給 Y（A 還不知道 Y 被撤）。所以每把金鑰記下建立時的撤銷集合雜湊 `rv`；合併後目前的金鑰若沒有涵蓋全部撤銷，這台就**再輪換一次**（各台同時輪換也會以 id 收斂到同一把）。測試確認最後的金鑰 X、Y 都不知道。
- 不能撤銷自己（請由另一台撤銷）；被撤銷的裝置若收到名單，會發 `change`（`selfRevoked: true`），之後什麼都不送。

### §7 中繼白名單與禮物包（修正既有問題）

實作時發現：白名單站（`ALLOWED_PUBKEYS`）以**事件作者**判斷，而禮物包（1059、1060、信令 21000–21999）的外層作者是每則一把的一次性金鑰，永遠不在名單上 ⇒ **白名單站會拒收所有禮物包**，包括 ADR 0027 要求跑在白名單站上的 Vault 同步。修正：連線已經以名單上的身分通過 NIP-42 認證、**而且事件是禮物包類**（kind 1059、1060、ephemeral 20000–29999）時放行（名單外的人在 AUTH 時就被 4003 斷線；速率限制本來就以認證身分計數）。其他會被保存的一般／可取代事件照舊只收名單上的作者（審查 #6：成員不能把白名單站變成外人事件的儲存空間）。沒認證的連線維持原本的行為。`tests/relay/access-control.test.ts` 守著。

⚠ 已部署的中繼要重新部署才有這個修正。

使用者確認：2026-09-29 接受。

## 與外掛 ADR 0003 的一致性

- 每台裝置各自產生身分金鑰（`loadOrCreateIdentity` 存 `app.secretStorage`），配對過程沒有任何一則訊息帶私鑰（測試逐則檢查 nsec 不在線上）；交付的是名單與共享 Vault 金鑰。
- 共享 Vault 金鑰與名單存在 SecretStorage 的另一個 id（外掛 ADR 0003 預留的位置），不寫 `data.json`。
- 單獨撤銷某一台（外掛 ADR 0003 否決「同一把私鑰」的理由之一）在這個設計下成立。

## 外掛怎麼接

```ts
// 桌機（成員）：顯示 QR
const offer = createPairingOffer({ role: 'invite', signer: identity, pool, membership, relays: settings.relayUrls, device: { label: '桌機' } });
showQr(offer.uri);                        // 外掛自己的 QR 函式庫
const { sas, peer } = await offer.ready;  // 顯示 SAS 與對方名稱，請使用者比對
confirmButton.onclick = () => offer.confirm();
await offer.result;                       // 名單已加入新裝置；NostrRosterSync 會送給其他裝置

// 手機（新裝置）：掃描
const invite = parsePairingUri(scanned);
const pool = new RelayPool({ urls: invite.relays, identity });
const scan = acceptPairingUri(scanned, { signer: identity, pool, device: { label: 'iPhone' } });
const { sas } = await scan.ready;         // 同一組 6 位數
scan.confirm();
const { membership, relays } = await scan.result;
secretStorage.setSecret('cindersync-vault', membership.toJSON());

// 接到協調器
const transport = createNostrVaultTransport({ pool, signer: identity, devices: membership.peerPubkeys(), deviceOf: (pk) => membership.deviceIdOf(pk) });
const peers = peerNodeLink({ node, devices: () => membership.peerDevices() });
const sync = new VaultSyncCoordinator({ ..., transport, deviceId: membership.selfDevice!.deviceId, peers });
new NostrRosterSync({ pool, signer: identity, membership }).start();
membership.onChange((ch) => {
  transport.setDevices(membership.peerPubkeys());
  if (ch.added.length > 0) sync.resync();
  if (ch.selfRevoked) { /* 停止同步、提示使用者 */ }
  secretStorage.setSecret('cindersync-vault', membership.toJSON());
  // 自己的中繼：以 membership.allowedPubkeys() 重新部署白名單（ADR 0027）
});
```

## 測試

- `tests/pairing/uri.test.ts`（7）：來回、中繼壓縮、**容量（≤ QR 版本 10／M）**、中繼放不下時少放、解析與編碼的各種拒絕、QR 容量表。
- `tests/pairing/session.test.ts`（19）：正常配對（`invite`、`join`、確認順序顛倒）、每種訊息第一則都遺失靠重送完成、**過期**（顯示方作廢、掃描方拒絕、過期後才到的 hello 不理）、使用者不確認逾時、**重放**（上一次的訊息在新的一次被忽略、同一則重複投遞冪等）、**錯誤秘密**（顯示方完全不回應）、**中間人**（中繼竄改內容、沒有秘密的攻擊者冒充顯示方、就算知道 pid 也不行）、**QR 被搶先使用**（contested，兩個工作階段都作廢）、**QR 外洩＋中繼被控制**（真的裝置沒有 SAS、使用者拒絕、名單不變；`invite` 與 `join` 兩種角色）、SAS 每次不同、拒絕、被撤銷的裝置不能再配對、deviceId 相撞、角色不對、`done` 遺失。
- `tests/pairing/roster.test.ts`（17）：查詢、加入要裝置自簽、預設 deviceId 不能冒用、**撤銷後輪換**、被撤銷者的更新不收、selfRevoked、非成員／壞資料／簽章不符不收、並發撤銷＋加入、**並發撤銷兩台各自輪換後收斂到兩台都不知道的金鑰**、**審查 #1–#4 的攻擊情境**（被撤銷者事先塞的金鑰不能當目前金鑰、偽造撤銷者、epoch 超過上限、改別台的 deviceId、塞滿撤銷後仍撤銷得了、分區超過上限仍收斂）、deviceId 相撞一致、上限塞得進 NIP-44、持久化、名稱清理、`NostrRosterSync`（加入傳播、撤銷後沒有任何事件寄給被撤銷者、啟動補送、陌生人的名單不理）。
- `tests/pairing/coordinator-integration.test.ts`（1）：C 經 A 配對、B 晚收到名單——名單到之前 C 的變更被 B 擋掉，名單到了 `resync()` 補齊（拿掉 `resync` 這個測試會失敗）；撤銷 C 之後 B 不再收它的變更。
- `tests/sync/vault/property-pairing.test.ts`：隨機性質測試加一個配對情境（10 個種子 × 150 個操作）：跑到一半新裝置以真的配對加入、其他裝置的名單同步晚一段時間才接上、假中繼只投遞名單上的寄件裝置；最終一致、不遺失資料、沒有卡住的版本、各台名單一致。
- `tests/pairing/subpath.test.ts`（8）、`tests/relay/access-control.test.ts`（+4，§7）、`nostr-transport.test.ts`（+2，`setDevices`、`deviceOf`）、`p2p-peernode.integration.test.ts`（+1，動態 `devices`）。
- 合計新增 60 個測試；全套 91 個檔案、1,219 個測試通過。配對情境的性質測試另外跑過種子 11–50，全部通過。

## 實測

- 打包（esbuild 壓縮）：主入口 152.7KB（gzip 55.8KB）——**不變**；`./sync/vault` 139.8KB（+0.2KB，`setDevices`／`deviceOf`／`resync`）；`./pairing` 112.9KB（gzip 38.9KB；大半是 @noble/curves、NIP-59 帶進來的 ML-KEM 與 ciphers，和其他子路徑共用）。

## 已知限制

- **白名單站上的新裝置**：新裝置的公鑰還沒進白名單，連不上成員自己的白名單中繼。`invite` QR 裡至少要有一座新裝置連得上的中繼（例如開放中繼）；或用 `join` 角色（新裝置顯示 QR，成員先從 QR 知道新裝置的公鑰，可先以 `allowedPubkeys([新公鑰])` 重新部署白名單再掃）。白名單是部署時的環境變數，改名單要重新部署（REST 一鍵部署幾秒鐘）。
- **任何成員都是完全信任的**：名單可以被任何一台有效成員修改（加入、撤銷、輪換）。一台被入侵但還沒被撤銷的裝置可以把攻擊者的裝置加進來、撤銷別台、或連續輪換把舊金鑰擠出保留上限；撤銷它之後，請用 `devicesAddedBy(公鑰)`（有簽章，不能冒名）檢查它加進來的裝置一併撤銷（加入時間由加入者自己簽，可以往前填到它自己加入的時間，所以 SDK 不自動連坐）。兩台互相撤銷時兩台都會出局。
- 撤銷紀錄超過 32 筆時會丟掉最舊的；被丟掉撤銷的公鑰若之後又出現在某份舊名單上（同時也不在任何人的撤銷裡），會被重新加回。正常使用不會撤銷到 32 台。
- QR 裡的中繼允許 `ws://`（本機與區網測試用）；在 QR 可信的前提下可以接受（審查 #11）。
- `uri` 字串（含一次性秘密）留在 `PairingSession` 物件上直到被回收；秘密的位元組在結束時清零。
- 名單事件只在中繼保留 7 天；更久沒上線的成員靠其他成員啟動時的補送（`start()` 預設）。
- 撤銷救不回已經同步出去的內容與舊金鑰（§6）。
- 配對訊息的中繼看得到「有人對這把公鑰送了 kind 21003」（一次配對的時間點）；內容與寄件人看不到。
- 使用者介面必須在**兩台**都顯示 SAS 並要求比對；只在一台顯示、或使用者不看另一台就按確認，QR 外洩時的防護就只剩 `contested` 偵測。
- 後量子：握手的 ECDH 與簽章是 secp256k1。只看網路流量的量子攻擊者算不出金鑰（混入了 `s`），但若他同時拍到了 QR，就不再有這層保護。

## 安全審查

實作完成後另派一位唯讀審查者（security-auditor 子代理人）檢查協定與實作。**握手本身沒有找到可利用的漏洞**（身分綁定、反射、SAS 預先承諾、雙方確認、狀態機、前向保密、nonce、輸入驗證都確認正確）；問題集中在名單合併。發現與處理：

| # | 嚴重度 | 發現 | 處理 |
|---|---|---|---|
| 1 | 高 | 金鑰的 `rv`／`by`、撤銷的 `by` 沒有簽章：被入侵的成員可以偽造「A 撤銷了我」＋一把自己握有、`rv` 剛好對得上的超大 epoch 金鑰，撤銷後仍握有目前的金鑰 | 每一筆都簽章（§4）；**建立者已被撤銷的金鑰不能當目前的金鑰**；合併後目前金鑰無效或沒涵蓋全部撤銷就再輪換。測試：審查 #1 |
| 2 | 高 | epoch 沒有上限：塞 `MAX_SAFE_INTEGER` 讓之後的輪換溢位、名單再也傳不出去；塞 16 把高 epoch 金鑰擠掉正牌金鑰 | epoch ≤ 2^31；新 epoch＝**有效**金鑰最大值＋1；淘汰金鑰先丟建立者已被撤銷的。測試：審查 #2、#1 |
| 3 | 中 | 同一把公鑰的兩筆裝置紀錄以 JSON 字串比較，任何成員都能改某台的 deviceId、`addedAt`、`addedBy` | 裝置紀錄要那台裝置自己簽的 claim＋加入者簽章；別的公鑰的預設 deviceId 不能用。測試：審查 #3、加入要裝置自簽 |
| 4 | 中 | 上限變成永久鎖死（塞滿 64 筆撤銷後誰都撤銷不了它）；分區合計超過上限整筆拒收、永不收斂 | 上限時依固定規則部分保留（§4）。測試：審查 #4 |
| 5 | 中 | 協調器不檢查訊息的 `from` 是不是寄件人自己的 deviceId | `NostrVaultTransport` 新增 `deviceOf`。測試：`deviceOf` |
| 6 | 中低 | §7 的例外範圍太寬：成員可以替外人發布會被保存的一般事件 | 例外只給禮物包類 kind（1059、1060、20000–29999）。測試：例外只給禮物包類 |
| 7 | 低 | contested 的 abort 只送給第一台，真的裝置只會逾時；成員這一側的人工確認是最後防線 | 兩台都通知；〈已知限制〉與外掛介面說明寫明「兩台都要看到同一組數字才按確認」。測試：QR 被搶先使用 |
| 8 | 低 | ikm／okm、一次性秘密沒有清除 | 導出後清除 ikm、okm、ECDH 結果；結束時清零一次性秘密（身分對話金鑰不清：`NostrSigner` 可能回傳快取本身）。測試：秘密用完即焚 |
| 9 | 低 | 沒有秘密的人也能讓顯示方白做 `openWrap`；已見集合沒有上限 | 已見集合上限 1,024；解封成本受中繼速率限制與 5 分鐘有效期限制（〈已知限制〉） |
| 10 | 低 | 歡迎訊息太大時新裝置默默丟掉：送出端的中繼清單沒有上限 | 送出與接收兩端都裁到 16 座、每座 ≤ 512 字元；密文改 base64；接收上限改為 NIP-44 上限；測試以滿載名單＋16 座長網址守著 |
| 11 | 資訊 | QR 允許 `ws://` 與任意主機 | 保留（本機與區網測試需要），記在〈已知限制〉 |

## Consequences

- ＋ 外掛只要做 QR 顯示／掃描與兩個按鈕，就有相互認證的配對、名單交付、撤銷與輪換。
- ＋ 私鑰不離開裝置；每台可單獨撤銷。
- ＋ 不改任何既有事件格式；新訊息（kind 21003、內層 4361）都帶版本欄位，舊客戶端略過。
- ＋ 修掉白名單站拒收禮物包的既有問題（§7）。
- － 兩個新的線上格式（21003、4361），日後要改必須升版本並處理新舊並存。
- － 中繼行為改變（§7）：以名單上的身分認證過的連線，可以發布作者不在名單上的禮物包類事件。
- － 名單每一筆都有簽章：滿載的名單第一次合併要驗約 70 個 Schnorr 簽章（桌機約 0.5 秒，之後有快取）。
