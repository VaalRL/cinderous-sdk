# 0054. 只訂閱、不寫入的中繼：`RelayPool` 的 `readUrls`

- 狀態：**已接受（Accepted，2026-10-04）**——實作於 v0.43.0
- 日期：2026-10-04
- 對應：CinderSync ARCHITECTURE §5 **G11 第 2 部分**（外掛 ADR 0017 的只讀連線池 `standby-reads.ts`）。G11 第 1 部分（名單帶中繼清單）見 ADR 0056（提議中）。
  相關：本 repo ADR 0041（備援 `durability.standby`、延遲連線、`standbySubscribe`）、0044（重新驗證）、0045（`queryResult` 的 `answered`）、0035（補訂閱退讓）。

## Context

ADR 0041 的備援只在**寫入**時延遲連上、閒置斷線、斷線不重連；`standbySubscribe` 也只讓**用過**的備援收訂閱。補發到備援的訊息，別台要讀到就得一直訂閱那一座，
所以 CinderSync 另開一個只讀的 `RelayPool` 連備援，再把兩個連線池併成一個傳輸層（訂閱兩邊下、查詢兩邊查、`answered` 只算主中繼、「在線」只看主中繼）。

這不涉及信任模型：每台自己決定讀哪幾座，與 ADR 0041 的備援相同（本機設定）。

## Decision

`RelayPoolOptions.readUrls?: string[]`——「只訂閱、不寫入」的中繼：

- **連線**：與主要中繼一起 `connect()`；斷線照退避重連（與主要中繼同一組 `reconnectDelaysMs`、`reconnectStableMs`、關閉碼用最長退避）；`close()` 一起關。
- **訂閱**：收所有常駐訂閱（補訂閱沿用同一個游標與 ADR 0035 的退讓），事件以 id 去重、交給同一個 handler（`onEvent(event, url)` 的 `url` 是實際來源）。
  **EOSE 只看主要中繼**（「歷史送完了」不因備援先回而提早成立）。
- **寫入**：一般發布不寫給它、不在 `writeSet()` 裡。發布的 `durability.standby` 列了它、主要中繼不夠時，**沿用這條連線**補發（不另開第二條）；
  閒置 `standbyIdleMs` 之後離開寫入集合，但**不斷線**。
- **查詢**：`query`／`queryResult` 也查它（備援上的補發要讀得到）；`answered` **只算主要中繼**（備援平常只有少數補發，只有它回完不代表「翻完了」，
  與外掛現況相同）；`relays` 裡它帶 `read: true`。`queryEach` 不變（呼叫端自己列）。
- **狀態**：不經 `status()`／`onStatusChange`（應用的「在線」只看主要中繼，與 ADR 0041 的備援相同）；開關經健康狀態通知，`relayHealth()` 看得到（`standby: true`）。
  `lastActivityAt`、`reconnectNow` 也適用。
- 已經在 `urls` 裡的網址忽略；沒給＝與 v0.42 相同。

## 外掛（CinderSync）怎麼改用

`withStandbyReads(main, reader)` 與只讀連線池整個拿掉：

```ts
const pool = new RelayPool({ urls: primary, readUrls: standby, identity, ... });
// 傳輸層與名單同步照舊：durability: { minAccepted: 1, standby }（同一組網址）
```

## 測試

`tests/relay-pool-read-relays.test.ts`：連上與訂閱、EOSE 只看主要中繼、一般發布不寫、`durability.standby` 沿用同一條連線與閒置後離開寫入集合、
斷線退避重連與補訂閱、`queryResult` 的 `answered` 與 `read`、`close()`／`connect()`、`lastActivityAt`。

## Consequences

- ＋ 一個連線池就能「主中繼讀寫＋備援只讀、需要時補發」，外掛少一層組合與一組重複的 NIP-42 認證。
- － 備援常駐連線：每座多一條 WebSocket（與外掛現況相同）。
