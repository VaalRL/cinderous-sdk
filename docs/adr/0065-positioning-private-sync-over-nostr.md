# 0065. 對外定位：以 Nostr 為傳輸的私有、本機優先同步；README 開頭照實寫中繼看得到與保存什麼

- 狀態：**已接受（Accepted，2026-10-10）**。使用者 2026-10-10 問「若我想要推廣 Cinderous SDK，可以如何闡述 Cinderous 與原本 Nostr 的差異」，看過建議後裁示：「好，改 README 開頭並寫 ADR」。
- 日期：2026-10-10
- 對應：
  - ADR **0064**（中繼站主不可信任，安全只靠端對端加密與簽章）。
  - ADR **0006**（Node 版 `--persist`）、**0042**（容量設定）、**0051／0052**（車道）、**0063**（client 端版本歷史）。
  - CinderSync ADR 0005（沒有預設中繼）。

## Context

README 開頭還是專案早期「純信令中繼」的定位，和現在的設計對不上：

1. **標題寫「Zero-Persistence, In-Memory Ephemeral Signaling Relay」**，「Why」段落說信令在記憶體撮合後即丟、零磁碟。
   - 實際上 Cloudflare 版把加密的離線訊息與檔案塊存在 Durable Object 的 SQLite（`src/relay/sql-message-store.ts`），保存到期限為止（`--max-ttl-days` 預設 7 天）。
   - 這正是 CinderSync 的主要用途（同步不需要兩台同時上線）。
2. **「階梯 0：預設用公共中繼池（nos.lol、damus）」**：SDK 沒有內建預設中繼；CinderSync 也決定沒有預設中繼。
3. **「Why」只講信令**，沒提到現在最大的賣點：每台裝置一把金鑰的配對名單、像 Git 的同步層、P2P、一鍵部署自己的中繼。
4. 中文版標題寫「零知識」。中繼看得到 IP、時間、大小、收件人 pubkey，「零知識」會讓人以為連中繼資料都藏住了。

要推廣 SDK，第一個被看到的段落必須說對「它和 Nostr 差在哪」，而且每一句都經得起檢查。

## Decision

1. **一句話定位**：以 Nostr 為傳輸、在自己的裝置與小團隊之間做私有、本機優先的同步與協作。**不是 Nostr 的分支**：事件是 NIP-01，客戶端用 NIP-17／42／44／59／98，中繼宣告 NIP-01／11／13／40／42／62（`SUPPORTED_NIPS`）。
2. **README 開頭（中英兩版）改寫**，取代原本的標題、「Why」與三層階梯：
   - 與一般 Nostr 的對照表：用途、中繼、身分、資料模型、傳輸、加密。
   - 〈中繼看得到、看不到什麼〉：看不到內容與檔名；看得到 IP、連線時間、大小、收件人 pubkey；會保存加密的離線訊息與檔案塊到保存期限。
   - 〈中繼可以放在哪裡〉：Cloudflare 邊緣、自架（Docker／Fly／家用通道）、任何公開 Nostr 中繼，照實列出差異；寫明 SDK 沒有預設中繼。
   - badge 與之後的段落（加密引擎、已實作功能）不動。
3. **用詞規則**（README、release note、推廣文案都適用）：
   - 不說「量子安全」或 "quantum-safe"：只有金鑰交換是後量子混合（ML-KEM-768），簽章仍是 secp256k1。
   - 前向保密依引擎分別說明：Cinder EK 是金鑰週期（每週輪替）的程度；逐則前向保密與入侵後復原只有 Double Ratchet。註明尚未經過外部審計。
   - 不說「零知識」「零保存」「純記憶體」（Node 版不加 `--persist` 時才是）。可以說「中繼看不到內容」。

## Consequences

- 好處：
  - 推廣時第一段就講對差異，而且說法和實作一致，不會被懂行的人一眼戳破。
  - 看得到中繼資料、會保存什麼都先講明，和 ADR 0064「中繼不可信任」一致。
- 代價：
  - 少了「零知識」「零保存」這類吸睛字眼。
- 同批一起修正（使用者 2026-10-10：「接著修」），讓 PRD、README、companion spec 說法一致（SSOT）：
  - `PRD.md`：定位行、生態系方塊圖、加密封裝規格列、第參章標題與 3.1 開頭（信令只在記憶體；1059／1060／30078 以密文存到保存期限）、3.2 開頭（刪掉「無法窺探連線 IP」，改寫中繼看得到的中繼資料）、STRIDE 的 Information Disclosure 列。
  - 兩份 README 的「與傳統 Nostr Relay 技術對照」表：儲存列改成照實描述；「永久免費」改成「在 Cloudflare 免費額度內」。
  - CinderSync companion spec（中英）：「零知識加密」改成「端對端加密」，加密算法照實寫 NIP-44／NIP-59（原本寫 ChaCha20-Poly1305 不準確：NIP-44 v2 是 ChaCha20＋HMAC-SHA256）；Cinder Coffice companion spec 的 "Zero-knowledge" 改成 "End-to-end encrypted"。
- 刻意不改：
  - `RESEARCH-JOURNEY.md`：是當時的研究紀錄，保留原樣。
  - 「Zero-Knowledge Push Guardrail」（PRD 第 303 行、README 的 zero-knowledge push guard）：是推播「不帶任何資料」的守門規則名稱，不是對中繼的宣稱。
- 後續：開源時 README 的 repo 網址與 NIP-11 `software` 一起換（ADR 0064）。
