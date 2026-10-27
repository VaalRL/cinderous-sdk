# 0017. TURN 憑證便利函式：turn-fetch 照搬 Cinderous，加上 TurnProvider

- Status: Accepted
- Date: 2026-09-27
- 相關：
  - SDK：ADR 0009（`PeerNode`）、ADR 0016（`CallManager`）
  - Cinderous：ADR-0243（公共 TURN 保底）、ADR-0342（`/turn` 要 NIP-98、回傳 ttl、以 IP 限速）、ADR-0356 §6（自架站沒 TURN 時後備到錨點）

## Context

`CallManager` 回報 `unreachable`（從未打通），多半是對稱型 NAT 或嚴格防火牆，只有 TURN 能救。SDK 的中繼早就有 `/turn` 端點：它以站方 secret 向 Cloudflare 換發短期憑證，並要求 NIP-98 授權。客戶端這邊還沒有對應的函式。

Cinderous engine 的 `turn-fetch.ts` 已經把細節做對了：

- 依 TTL 刷新；
- 404／204／401 一律退回純 STUN、不報錯；
- 過濾非 ICE scheme 的 URL；
- 自架站沒 TURN 時依序問錨點；
- 企業身分不問公共錨點。

## Decision

1. **`turn-fetch` 原樣搬進 `@cinderous/client/protocol`**，測試一起搬。只有兩處調整：
   - 簽章者從「私鑰」放寬為「私鑰，或任何會簽章的物件」（`TurnSigner`）。SDK 的 `Identity` 不交出私鑰；Cinderous 原本傳私鑰的呼叫方式照樣可用。
   - `RTCIceServer` 改成自己的 `IceServer` 型別。這個檔也會被 Worker 與 Node 的型別檢查讀到，那兩個環境沒有 DOM；兩者在結構上相容。
2. **`http-auth` 抽出 `httpAuthTemplate`**（未簽章的授權範本），`buildHttpAuthEvent` 改用它，行為不變。比照 ADR 0010 抽出 `ekAnnounceContent` 的做法。
3. **`TurnProvider`**：
   - `start()` 立刻抓一次，之後在半個 TTL 時刷新（夾在 1 分鐘～6 小時；沒有 ttl 以 1 小時估）；拿不到也照樣排下一次。
   - `iceServers()` 回傳 STUN 加上目前的 TURN。預設 STUN 與 Cinderous 相同（`stun:stun.cloudflare.com:3478`）。
   - 其他：`onChange` 在憑證換新時通知；`refresh()` 供 App 在通話回報 `unreachable` 時手動重抓。
4. **`PeerNode` 的 `iceServers` 也接受函式**，與 `CallManager` 一致，每條新連線取當下的值。把 `turn.iceServers` 傳進去，憑證換新後的連線自動用新的。
5. **契約測試**：`TurnProvider` 簽的請求直接交給 SDK 中繼真的 `mintTurnResponse`，確認授權、ttl、未配置時回 204 三件事兩端一致。

## Consequences

- ＋ `new TurnProvider({ signer: identity, home })` 加上 `iceServers: turn.iceServers`，通話與 P2P 就有 TURN 保底。
- ＋ 與 Cinderous 同一份抓取邏輯（Cinderous 改從 SDK 轉出）。
- － TURN 流量由提供 `/turn` 的站方付費（Cloudflare 按流量計）。自架站要自己配 `TURN_KEY_ID`／`TURN_API_TOKEN`，否則只能後備到願意提供的錨點。
