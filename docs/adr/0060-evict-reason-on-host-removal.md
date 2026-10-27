# 0060. 清掉本機副本時告訴應用原因：`VaultRemoteChange` 的 `evict`、`VaultAdapter.remove` 的第三個參數

- 狀態：**已接受（Accepted，2026-10-05）**——使用者 2026-10-05 裁示「做」；實作於 v0.46.1
- 日期：2026-10-05
- 對應：CinderSync ARCHITECTURE §5 **G23**。相關：本 repo ADR **0058**（輕量成員、`evict`、`evicted` 事件）、0025（`applyRemote`、`VaultAdapter`）、0047（排除不等於刪除）

## Context

ADR 0058 讓輕量成員清掉本機的一份內容而**不產生刪除版本**（`evict()`、範圍改變與滾動視窗、LRU）。協調器經 `#apply` 交給應用的卻是一個普通的
`{ type: 'remove', path, expect, fileId }`（或 `adapter.remove(path, expect)`），與「別台刪了這個檔案」完全相同；`evicted` 事件在刪完**之後**才發。

CinderSync 的 `applyRemote` 對每一個遠端刪除都先備份到 `.trash/cindersync-backup`、再移到垃圾桶（保護使用者資料的既有設計）。分不出來的結果：
每一次清掉都多一份備份、一份垃圾桶裡的檔案——輕量模式「省空間」的目的整個被抵銷（G23）。在刪完之後才收到的 `evicted` 事件來不及改變處理方式。

## Decision

- 新型別 `VaultEvictReason = 'scope' | 'lru' | 'evict'`（與 `evicted` 事件的 `reason` 相同，事件改用這個別名，值不變）。
- `VaultRemoteChange` 的 `remove` 多一個**選用**欄位 `evict?: VaultEvictReason`：有值＝清掉本機副本、不是刪除。
  協調器在兩個清掉的地方帶上它：`#evictLocal`（`scope`／`lru`／`evict`）與清掉因排除而停止追蹤的副本（`evict`）。
- 沒有 `applyRemote` 時經 `VaultAdapter.remove(path, expect?, options?)`：第三個參數 `VaultRemoveOptions = { evict?: VaultEvictReason }`，
  只有清掉時才傳；**真正的刪除照舊只帶兩個參數**、`applyRemote` 收到的物件形狀與 v0.46.0 完全相同（測試釘住：沒有 `evict` 鍵、呼叫只有兩個參數）。
- 應用的建議處理：`evict` 有值時直接刪檔，不備份、不移到垃圾桶（其他裝置照常保留，之後重新納入範圍或 `fetch` 會再抓回來）；前置條件照樣要檢查
  （內容不是記的那一份＝使用者剛改了，回 `false`，協調器先收成本機版本，不會遺失）。

## Alternatives Considered

- **欄位叫 `reason: 'evict'`、另一個欄位放細分原因**：兩個欄位表達同一件事；單一欄位 `evict` 有值就是清掉，值直接是細分原因，與 `evicted` 事件一致。
- **`reason: 'delete' | 'evict'`，真正的刪除也帶 `reason: 'delete'`**：改變了既有刪除的物件形狀；裁示要求真正的刪除完全不變，省略＝刪除對舊應用最自然。
- **先發 `evicted` 事件、再刪**：應用要自己把事件與之後的 `remove` 對起來（同一個路徑可能接著有真正的刪除），容易出錯；直接放在要執行的那個變更上最可靠。
- **新的變更型別 `{ type: 'evict' }`**：舊的 `applyRemote` 實作若以 `else` 處理未知型別（例如當成改名）會做錯事；選用欄位對舊應用就是一個普通的刪除（照舊備份，只是浪費空間，不會出錯）。

## 相容

- 只增加選用的型別成員與參數；舊的 `applyRemote`、兩個參數的 `VaultAdapter.remove` 實作照常編譯、照常運作（清掉時照舊當成刪除處理）。
- 線上格式、狀態儲存、名單都不變；不需要各台同時升級。

## 測試（TDD）

`tests/sync/vault/sparse.test.ts`〈清掉本機副本時告訴應用原因〉（3）：同一個情境依序 `evict`、LRU、一次真正的刪除（別台刪的）、範圍改變——
`applyRemote` 收到的 `remove` 依序帶 `evict`／`lru`／（沒有）／`scope`，真正的刪除物件只有 `type`、`path`、`expect`、`fileId`；沒有 `applyRemote` 時
`adapter.remove` 的參數個數與第三個參數同樣對得上；清掉因排除而停止追蹤的副本（完整成員）也帶 `evict`。都沒有產生刪除版本。
