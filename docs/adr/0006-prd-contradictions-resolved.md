# 0006. PRD 五處矛盾拍板：持久化、信令隱私、EK 規格、曲線、名稱與分塊

- Status: Accepted
- Date: 2026-09-27
- 相關：ADR 0001（「未決」一節列出這五項）；Cinderous ADR-0071（快照）、ADR-0238（輪替加密子鑰 EK）、
  ADR-0365（後量子 EK）；Cinderous `packages/core/src/{signaling,subkey,ek-envelope,hybrid-kem,file-relay}.ts`

## Context

PRD 有五處自相矛盾，或與 Cinderous 本體實際在跑的實作不一致。
relay-core／relay-lite、Cinder EK、`connectPeer` 都卡在這裡。原則是：**SDK 的實作從 Cinderous 抽出，
規格就跟著 Cinderous 走**，這樣才能與 Cinderous App 互通，也不會在同一條協定上長出第二個版本。

## Decision

### 1. relay-lite 的持久化：預設純記憶體，可選開 SQLite

- 預設零持久化：
  - 信令（ephemeral 事件）撮合完就丟。
  - 快照（30078）與檔案（1060）放在記憶體裡，依 TTL 過期，重啟就沒了。
- 加上 `--persist <路徑>` 就改用 SQLite，保存 30 天。存法直接沿用 Cinderous 的 `sql-message-store`。
- serverless 版（Durable Object）照 Cinderous，一律存 DO SQLite。

### 2. WebRTC 信令：NIP-59 整包，外層是 ephemeral kind 21000

- 照 Cinderous `signaling.ts`：rumor 是 kind 21000，封成 seal，外層 wrap 也是 kind 21000（ephemeral，中繼不存），
  用一次性金鑰簽，只帶收件人的 `p`。中繼看不到寄件人與內容。
- PRD 裡寫的 **kind 20078 一律改為 21000**。20078 已經是四款遊戲大廳廣播在用的 kind，而且它不包封。
- 後量子公鑰或密文放在 rumor 裡（包封之內），不放外層 tags，這樣外層不會洩漏「這是 PQ 握手」。
- kind 分配照 Cinderous 的 21000–21999 信令段：21000 檔案／SDP、21002 通話、21003 配對、21004 在線狀態。
  PRD 原本把 21000 也拿來當**協同邀請**，會與信令撞號，改用 **21005**（未被佔用；21001 在 Cinderous 刻意跳過，不碰）。
- 四款遊戲的信令（20078 加 NIP-44、`p` 明文）是遊戲自己的協定，不在 SDK 範圍；要不要換，由各遊戲自己決定。

### 3. Cinder EK 規格：照 Cinderous 現行（ADR-0238、ADR-0365）

- 每 **7 天**輪替一次，寬限期 7 天；PRD 的「24 小時」與「86,400 秒」改掉。
- kind 10040 發金鑰公告（`ek-v1`／`ek-pq-v1`）；kind 10042 做跨裝置信封，8 個槽位。
- 二進位格式以 Cinderous 的 `subkey.ts`、`ek-envelope.ts` 為準。SDK 抽出同一份實作，
  並以「和 Cinderous 雙向互通」的測試把關。

### 4. 後量子混合封裝的古典半邊：secp256k1

- 與 Nostr 金鑰同一條曲線，照 Cinderous `hybrid-kem.ts`：ML-KEM-768 加上 secp256k1 ECDH，再經 HKDF-SHA256 組合。
- PRD 裡 EK 與雙棘輪的 X25519 一律改為 secp256k1。雙棘輪還沒實作，到時候照這條。
- 代價：這不是標準的 X-Wing 組合，而且組合器沒有外部審計（Cinderous 原始碼自己也這樣寫）。

### 5. 名稱與分塊

- CLI 指令用 `cinderous relay deploy`（名詞在前、動作在後，之後擴充成 `relay status` 之類）；`cinderous estimate` 跟它並列。
- Durable Object 沿用 Cinderous 的 `RelayRoom`，binding 叫 `RELAY_ROOM`。SDK PRD 的 `CinderousSignalingDO`／`SIGNALING_ROOMS`
  與 CinderSync PRD 的 `RELAY_STORAGE` 都改掉。
- 分塊依場景各自固定：
  - WebRTC DataChannel：**16KB**，瀏覽器之間相容性最好的訊息大小。
  - 走中繼的檔案事件（1060）：**48,000 B 明文**，沿用 Cinderous `FILE_CHUNK_BYTES`，在 NIP-44 單則 64KB 上限內留餘裕。
  - PRD 的 64KB 改掉。

## Consequences

- ＋ SDK 與 Cinderous App 在信令、EK、後量子封裝上互通，同一條協定只有一個版本。
- ＋ relay-core／relay-lite、Cinder EK、`connectPeer` 都可以動工了。
- － 後量子封裝不是標準組合：若日後要改成 X25519／X-Wing，Cinderous 與 SDK 要一起遷移。
- － relay-lite 預設不落地：重啟後離線快照就沒了。需要保存的自架者要自己加 `--persist`。
- － 兩個 Obsidian 外掛的規格副本（`docs/companion-specs/`）裡的名稱與分塊數字還沒改。
  那是外掛 repo 的文件，**要在外掛 repo 改**，本 repo 的副本跟著同步。
