# 0069. 裝置改名：每台在名單上自己帶時間重新簽名稱，較晚的蓋過

- 狀態：**已接受（Accepted，2026-10-12）**——使用者 2026-10-12 裁示：「讓裝置可以帶時間戳記重新簽自己的名稱」；實作於 v0.52.0
- 日期：2026-10-12
- 對應：CinderSync ADR 0010（裝置名稱只存在這台；「名單上的舊名稱不會自動更新；要更新得重新配對（或日後 SDK 支援改名）」）。
  相關：本 repo ADR 0028（名單、合併、撤銷）、0035 §G9（自簽能力宣告）、**0056**（自簽的延伸欄位 `standby`）、0058（`sparse`，同一個模式）。

## Context

名單上每台的名稱（`RosterDevice.label`）是配對時那台自己簽進去的（`claim` 簽 `(pubkey, deviceId, label)`），加入者再簽整筆（`sig`，含 `addedAt`）。
之後：

- `addDevice` 對已在名單上的裝置直接回 false；
- `merge` 的 `#absorb` 對同一把公鑰保留 `addedAt` 較早的那一筆（各台一致、與順序無關）。

所以裝置改了名，**沒有任何路徑能讓別台（連這台自己的名單）換成新名稱**。CinderSync 的使用者在設定裡改名後，其他裝置的清單仍是配對時的名稱。

## 決策

比照能力（`caps`）、備援（`standby`）、輕量成員（`sparse`）宣告，名單加一個**裝置自己簽**的欄位：

```ts
interface RosterLabel { pubkey: string; label: string; at: number; sig: string } // VaultRosterData.labels?
membership.declareLabel('Pixel 8'); // true：簽了新的、發 change（reason 'caps'）→ NostrRosterSync 自動送出
```

1. **簽章**：`signFields(本機身分, 'label', [vaultId, pubkey, label, at])`（與其他宣告同一個領域分隔，`type` 不同，不能互相挪用）。
   只有那台自己改得了自己的名稱；別的成員可以轉手（驗的是那一台的簽章），改不了、也冒名不了。
2. **合併**：同一台取 `at` 較晚的（同時間取簽章較大的，各台一致），與 `standby`／`sparse` 相同（`later`）。
   這台連續改兩次落在同一毫秒時，`at` 取 `max(現在, 上一次 + 1)`，後改的一定贏。
3. **清理**：名稱照配對時的 `sanitizeLabel`（去控制字元與 U+2028／2029、去頭尾空白、最多 40 字）。收到沒清理過的那一筆**只丟那一筆**，名單其他部分照收（較新的版本可能放寬規則，不能因此整份不收）。空字串是合法的名稱（與配對時相同）。
4. **讀取**：`devices()`、`selfDevice`，以及用到名稱的 `declaredStandbys()`、`sparseMembers()`，`label` 一律是**目前的名稱**（有宣告用宣告的）；
   配對時那一筆（`claim`、`sig`）**不動**，`roster()` 的 `devices` 照舊是原始資料，舊版驗得過。
5. **不重簽**：和目前的名稱一樣就回 false、不發 `change`（應用可以每次啟動都呼叫）；改回配對時的名稱也要宣告（才蓋得過較早的改名）。
6. **撤銷**：被撤銷的裝置的宣告跟著丟掉（`#trim`）；不是成員時呼叫丟錯（`#requireActive`）。
7. **配對**：歡迎訊息只帶邀請方自己的宣告（同 `standby`／`sparse`，大小不隨成員數成長）；其他成員的新名稱之後經名單同步補上——加入新裝置本身就會觸發名單廣播。
8. **協調器**：`VaultSyncCoordinator.setDeviceLabel(名稱)` 在執行中換掉 `deviceLabel`，之後產生的版本（`VaultVersion.label`）與衝突副本檔名用新名稱，已經產生的不回溯改；不必重啟同步。規則同建構時（最長 64 字；**沒給或空字串都用 deviceId**——原本空字串會留空，順手統一）。
9. **舊版相容**：舊版解析時略過 `labels`，照舊顯示配對時的名稱；舊版轉手的名單沒有這一欄，新版合併後照舊保留宣告（不震盪）。
   上限：32 台都改名、其他宣告塞滿，名單事件仍在中繼的單顆上限（256 KiB）內（測試涵蓋 kind 1060 與 1059）。

## Alternatives Considered

- **改 `RosterDevice.label` 本身、重簽 `claim`**：`sig` 是加入者簽的（含 `addedAt`），改名的人不一定是加入者，要另一台重簽；而且 `#absorb` 保留較早的那一筆，要改合併規則，舊版會把新名稱當成衝突的另一筆。否決。
- **不放進名單，經同步訊息另外送**：要新的訊息型別、還要另外保存；名單本來就會廣播、持久化、驗簽，延伸欄位是既有模式。否決。
- **任何成員都能替別台改名**：名稱只是顯示用，但沒有必要放寬信任模型（ADR 0056 的理由）。否決。

## Consequences

- ＋ 改名經名單同步傳到每一台，連這台自己的清單也換成新名稱；不需要中繼支援，名單格式只多一個選配欄位。
- ＋ 應用（CinderSync）只要在改名與啟動時呼叫 `membership.declareLabel(名稱)`，改名時再呼叫 `sync.setDeviceLabel(名稱)`。
- － 舊版裝置看不到新名稱，直到它升級。
- － 版本節點的 `label`（衝突副本、callout 上的裝置名稱）是產生那個版本時的名稱，不會回溯改。
- 驗證：`tests/sync/vault/device-label.test.ts`（改名後的版本本機與別台都帶新名稱、之前的不變、64 字上限、空的用 deviceId）；`tests/pairing/label.test.ts`（宣告、簽章、合併；不重簽；清理；較晚的贏且與順序無關、同一毫秒；竄改、冒名、沒清理過的那一筆丟掉、舊版名單不震盪；轉手；撤銷、持久化、`declaredStandbys`／`sparseMembers`；不是成員丟錯；上限；配對只帶邀請方自己的）。
