# 0014. 加密引擎的場景預設與自動協商

- Status: Accepted
- Date: 2026-09-27
- 相關：ADR 0010（兩個引擎）；PRD 3.5.2、3.5.3

## Context

PRD 3.5.3 要三種開箱即用的預設（`vault-sync`、`live-collaboration`、`auto-negotiate`），並以 Nostr 標籤 `crypto_engines` 宣告雙方支援哪些引擎。ADR 0010 做完了兩個引擎，但「什麼時候用哪一個」還得由 App 自己判斷。

## Decision

1. **能力宣告放在 kind 10040 EK 公告的 tags**：`["crypto_engines", "cinder-ek", "double-ratchet"]`。
   - 放 tags 不放 content：Cinderous 的 `readEkAnnounce` 只讀 content，今天的 App 讀到新公告完全不受影響。簽章本來就涵蓋 tags，中繼改不了。
   - 公告沒有這個標籤（今天的 Cinderous App）→ 視為只支援 Cinder EK。
   - 沒有公告 → 不知道（`undefined`）。
   - 不認得的引擎名稱略過，不讓整份宣告作廢。
2. **`chooseEngine({ preset, peerOnline, peerCapabilities, recipients })`**：

   | 預設 | 結果 |
   |---|---|
   | `vault-sync` | 一律 Cinder EK |
   | `live-collaboration` | 雙棘輪；對方不在線、或明確宣告不支援 → 丟 `UnsupportedEngineError`，不默默換引擎 |
   | `auto-negotiate` | 對方在線、雙方都支援、而且一對一（`recipients === 1`）才用雙棘輪，其餘一律 Cinder EK |

   `recipients` 多於一台就是扇出。雙棘輪每一對裝置都要一條會話，而且不跨自己的裝置（ADR 0010），所以扇出一律回 Cinder EK。
3. **`engineConfigFor(engine)`** 回傳 PRD 3.5.2 的 `CryptoEngineConfig` 預設值：後量子開啟、跳過金鑰上限 2,000、EK 7 天輪替。

## 沒有做的

- PRD 3.4 要在 kind 21000 信令的 rumor 裡放 `ml_kem_pubkey`、`kem_algo`、`challenge` 標籤。這條沒照做：
  - 信令沿用 Cinderous 的格式（ADR 0006、0009），後量子資訊在 EK 公告與 NIP-59 封裝裡；
  - 雙棘輪的 ML-KEM 公鑰在通道內的 hello 裡，已經被身分驗證過的通道保護。
  - 再加一套標籤會與 Cinderous 分岔。
- `ICryptoEngine.createSession` 的統一形狀仍不做，理由見 ADR 0010 §3。

## Consequences

- ＋ App 只要說「這是筆記同步」或「這是即時共編」，SDK 就決定用哪個引擎；對方不支援時明確報錯。
- － 能力宣告跟著 EK 公告走：對方沒發公告（沒開 FS）就只能用 Cinder EK 的身分金鑰退路，`auto-negotiate` 一律回 Cinder EK。
