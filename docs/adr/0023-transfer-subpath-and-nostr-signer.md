# 0023. `./transfer` 子路徑；協定與同步 API 接受 `Identity`（`NostrSigner`），不必交出原始私鑰

- Status: Accepted
- Date: 2026-09-29
- 相關：ADR 0021〈後續〉#5、#8（外掛 CS G7、CC G7）、ADR 0010（`Identity.conversationKey`）、ADR 0015（檔案傳輸）、ADR 0017（`TurnSigner`）、ADR 0011（快照與檔案塊）

## Context

1. `FileTransfer`、`P2PFileQueue` 只能從主入口匯入。外掛只要檔案傳輸時，也得引用整個主入口（打包工具可以搖掉沒用到的部分，但型別與文件上分不清邊界）。
2. `Identity` 設計上不交出私鑰，但 `./sync` 的 `buildSnapshotEvent`、`wrapFileChunk` 等只收原始私鑰（`SecretKey`）。外掛要嘛自己保存一份私鑰（違反設計），要嘛重寫這些函式。ADR 0017 已經為 TURN 開過先例（`TurnSigner = SecretKey | { sign }`），但只涵蓋簽章。

## Decision

### §1 `./transfer` 子路徑

新增 `src/transfer/index.ts`（`export *` 自 `file-transfer.ts`、`p2p-queue.ts`），package.json `exports` 加上 `./transfer`。主入口照舊轉出同一批名稱，兩邊是**同一個模組**（同一個 class 參照，`instanceof` 不會失效）；測試以原始碼與「套件名稱自我引用 dist」兩層各驗一次。子路徑另外多轉出 `DEFAULT_MAX_CONCURRENT_FILES`、`DEFAULT_MAX_PENDING_BYTES`（原本就是 `export`，只是主入口沒列）。

### §2 `NostrSigner`：只要三樣能力

```ts
interface NostrSigner {
  readonly pubkey: PubkeyHex;
  sign(template: EventTemplate): NostrEvent;
  conversationKey(pubkey: PubkeyHex): Uint8Array; // NIP-44 對話金鑰
}
type SecretKeyOrSigner = SecretKey | NostrSigner;
function isNostrSigner(value: unknown): value is NostrSigner;
```

- **為什麼是 `conversationKey` 而不是 `nip44Encrypt／nip44Decrypt`**：NIP-59 的後量子混合封裝（ADR-0365）要把古典對話金鑰與 ML-KEM 共享秘密再過一次 HKDF，而且 seal 與 wrap 兩層各導一把。只給加解密做不到。`Identity.conversationKey` 在 ADR 0010 已經公開（雙棘輪握手要用），它能做的事與 NIP-44 加解密相同，不是私鑰。
- **`Identity` 不新增任何方法**，只加上 `implements NostrSigner`（型別層面的保證）。測試釘住 `Identity.prototype` 的方法清單不變。注意：既有的 `nsec()` 仍然存在（`loadOrCreateIdentity` 持久化要用），本 ADR 沒有、也不能拿掉它；新增的程式路徑都不呼叫它，測試用一個**只有三個成員、沒有 `nsec`** 的凍結物件跑過所有路徑。
- **`Identity` 的對話金鑰快取加上限（256 把，先進先出，丟掉時清零）**：以前只有 `encryptTo`／`decryptFrom` 用它，對象有限；現在 `openWrap(event, identity)` 會對每則禮物包的一次性金鑰各算一把，不設限會無限長大、也讓記憶體裡累積大量衍生金鑰。這是私有欄位，對外行為不變（`conversationKey()` 一向回傳副本）。
- 判斷用形狀（`pubkey` 是字串、`sign`／`conversationKey` 是函式、不是 `ArrayBuffer` view），不用 `instanceof`：外掛可能跨 realm。
- 內部工具 `protocol/key-ops.ts`（`pubkeyOf`、`signWith`、`conversationKeyOf`）不對外轉出。傳原始私鑰時呼叫的仍是 `finalizeEvent`／`nip44.getConversationKey`，與以前同一條路。

### 要求原始私鑰的公開 API：逐一處理

| API | 子路徑 | 處理 |
|---|---|---|
| `buildSnapshotEvent`、`buildSnapshotPurge`、`openSnapshotEvent` | `./sync` | 改收 `SecretKeyOrSigner` |
| `wrapFileChunk` | `./sync` | 改收 `SecretKeyOrSigner`（拆封走 `openWrap`，見下） |
| `sealAndWrap`（寄件人） | `./protocol` | 改收 `SecretKeyOrSigner`；一次性 wrap 金鑰仍是內部隨機產生 |
| `openWrap`（收件人） | `./protocol` | 改收 `RecipientKeyLike \| NostrSigner`。`RecipientKeyLike`、`toRecipientKey` **不變**（放寬它們會讓既有 `toRecipientKey(k: RecipientKeyLike)` 的呼叫端編譯失敗） |
| `openWrapWithEks` | `./protocol` | 候選改為 `(RecipientKeyLike \| NostrSigner)[]` |
| `encryptDM`、`decryptDM` | `./protocol` | 改收 `SecretKeyOrSigner` |
| `createSignal`、`readSignal`、`createCallSignal`、`readCallSignal` | `./protocol` | 改收 `SecretKeyOrSigner` |
| `buildAuthEvent`（NIP-42）、`buildHttpAuthEvent`（NIP-98）、`buildVanishRequest`（NIP-62） | `./protocol` | 改收 `SecretKeyOrSigner` |
| `minePow`（NIP-13） | `./protocol` | 改收 `SecretKeyOrSigner`；仍只在中獎那一輪簽一次。簽章者回報的 `pubkey` 與實際簽的不一致時 id 會變、難度不成立 ⇒ 拋錯，不送出不及格的事件 |
| `buildEkAnnounce`（kind 10040） | `./protocol` | 改收 `SecretKeyOrSigner`（`ekAnnounceContent` 仍保留） |
| `buildDeviceDirectory`、`readDeviceDirectory`（kind 10041） | `./protocol` | 改收 `SecretKeyOrSigner` |
| `buildEkEnvelope`（身分）、`openEkEnvelope`（裝置） | `./protocol` | 改收 `SecretKeyOrSigner`；誘餌槽仍用內部隨機金鑰 |
| `fetchTurnServers`、`fetchTurnWithFallback` | `./protocol` | 已是 `TurnSigner`（ADR 0017），`NostrSigner`／`Identity` 本來就相容，不動 |
| `finalizeEvent`、`conversationKey(sk, pk)`、`getPublicKey`、`nsecEncode` 等金鑰原語 | `./protocol` | **不改**：它們就是原始私鑰的操作本身；`NostrSigner` 的 `sign`／`conversationKey`／`pubkey` 就是對應的替代 |
| `generateEncryptionKey`（EK）、`RecipientKey.sk`（EK 私鑰）、`pqDecapsulate`／`RecipientKey.pqSk`（ML-KEM） | `./protocol` | **不改**：這些是**傳輸金鑰**（EK、ML-KEM），不是身分金鑰；應用本來就要自己保存它們（`CinderEkKeyring.exportState`）。`Identity` 沒有 ML-KEM 私鑰，所以收件人用 `Identity` 拆混合式封裝時照 ADR-0365 fail-closed 拋錯（有測試） |
| `generatePqSeed`、`pqKeyFromSeed`、`hybridConversationKey` | `./protocol` | 不涉及身分私鑰，不改 |
| `./transfer` | — | 沒有任何 API 收私鑰（跑在已加密的位元組通道上） |

### 相容性

- 所有改動都是**放寬參數型別**（`SecretKey` → `SecretKey | NostrSigner`）；回傳型別不變，既有呼叫端與把函式當值傳遞的程式都照舊編譯。
- 線上格式不變：只需要簽章的事件（AUTH、NIP-98、NIP-62、EK 公告、purge），用 `Identity` 與用原始私鑰產生的 id 完全相同，只有簽章不同（BIP-340 本來就帶隨機輔助值）；含 NIP-44 密文的事件本來每次的 nonce 就不同，形狀與標籤相同、對方用舊路徑解得開。測試兩個方向都驗（新寄舊收、舊寄新收）。
- `Identity.sign` 回傳 nostr-tools 的 `VerifiedEvent`，多一個 symbol 屬性；JSON 序列化時不存在，線上看不到。
- 中繼 Worker 的預先打包內容只有壓縮後的變數名稱改變，大小相同（62,777 bytes）。

## Consequences

- ＋ 外掛只要有 `Identity`，就能用快照、檔案塊、信令、裝置目錄、EK 分發等全部 API，不必自己保存私鑰。
- ＋ 未來的外部簽章者（例如硬體金鑰、系統金鑰圈）只要實作三個成員就能接上。
- － 介面是同步的：NIP-07／NIP-46 這類非同步簽章者還接不上（要全部改成 async，會動到與 Cinderous 共用的介面，這次不做）。
- － `conversationKey` 是逐對象的 ECDH 結果；外部簽章者若不願意交出它，就只能用簽章類的 API。
- － 主入口多了約 1KB（壓縮前；見 ADR 0024 的量測）。
