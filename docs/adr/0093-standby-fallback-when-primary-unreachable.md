# 0093. 傳輸層可以在主要中繼連不上時改用備援（`setStandbyFallback`）

- 狀態：**已接受（Accepted，2026-10-16）**——使用者 2026-10-16「要」
- 日期：2026-10-16
- 對應：ADR 0041（耐久度與備援）、0054（只讀中繼）、0078（`standbyWhenDisconnected`）；CinderSync ADR 0087

## Context
2026-10-16 錨點 1 的 Durable Objects 免費額度用光，主要中繼一連就 500。兩台桌機都設了同一組備援（錨點 2，正常），
卻整晚同步失敗：排程模式刻意設 `standbyWhenDisconnected: false`（ADR 0078：兩輪之間主要中繼只是沒連線，不該改送備援），
而且傳輸層的「在線」只看主要中繼、補拉的「回完」也只算主要中繼——主要中繼掛掉時協調器根本不送、補拉也算沒回完。

## Decision
`NostrVaultTransport.setStandbyFallback(on)`：打開時
- 「在線」也算開著的備援（只讀中繼，從 `relayHealth()` 看；`onRelayHealthChange` 時重算）；
- 帶耐久度的發布把 `standbyWhenDisconnected` 換成 true（主要中繼沒連線也補發到備援）；
- 補拉的 `answered` 也算備援回完的那幾座（起點照常前進）。
何時打開由應用決定（例如一輪同步發現主要中繼連不上、而且每台裝置都設了同一組備援），用完關掉。`VaultRelayPool` 多兩個選用方法 `relayHealth`、`onRelayHealthChange`（`RelayPool` 本來就有）。

## Alternatives Considered
- **`standbyWhenDisconnected` 收函式**：只解決發布，「在線」與補拉仍只看主要中繼，協調器照樣不送。
- **永遠改用備援**：回到 ADR 0078 之前的問題——沒設同一座備援的裝置收不到。

## Consequences
- ＋ 主要中繼掛掉時，設了同一組備援的裝置照常同步。
- － 名單同步（`NostrRosterSync`）沒有這個開關：主要中繼掛掉期間的名單變動照舊等主要中繼回來。
- **v0.66.1 補**：實機發現 `RelayPool.queryResult` 在主要中繼一座都沒開時會先把整段逾時花在等它，備援因此也被算成逾時、補拉永遠「沒回完」。
  `queryResult` 多一個選項 `waitForPrimary: false`（不等、直接查開著的備援），傳輸層在改用備援時帶上；平常照舊先等主要中繼。
- 驗證：`tests/sync/vault/nostr-transport.test.ts`〈主要中繼連不上時改用備援〉兩項、`tests/relay-pool-read-relays.test.ts`〈waitForPrimary: false〉；全套見 commit。
