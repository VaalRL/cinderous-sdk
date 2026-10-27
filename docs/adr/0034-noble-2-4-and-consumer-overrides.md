# 0034. @noble 升到 2.4：SDK 不再跟 nostr-tools 釘同一版，改以 overrides 讓整棵樹只剩一份

- Status: Accepted
- Date: 2026-09-29
- 相關：ADR 0020（本 ADR 部分取代其 Decision 2 與守門測試）、ADR 0010／0012（使用 secp256k1、NIP-44、NIP-59 的路徑）

## Context

### 安全理由

SDK v0.28 為了與 nostr-tools 共用同一份密碼學函式庫（ADR 0020），把 `@noble/curves`、`@noble/hashes` 釘在 **2.0.1**、`@scure/base` 釘在 **2.0.0**。之後 noble 的幾個版本都含安全修正：

| 套件 | 版本 | 與我們有關的內容 | 來源 |
|---|---|---|---|
| @noble/curves | 2.2.0 | 自我稽核；schnorr 的亂數改為 mod N、sqrt 強化、多數物件 `Object.freeze` | [release 2.2.0](https://github.com/paulmillr/noble-curves/releases/tag/2.2.0) |
| @noble/curves | **2.3.0** | 常數時間由「盡力」改為**實際保證**（20 萬樣本無可量測時序差）：純量乘法以 CSPRNG 盲化、未預算的點改用常數時間固定視窗乘法、模運算強化；Trail of Bits 審查修正；X25519 遠端時序攻擊修正（我們用 secp256k1，未用 X25519）。代價：getPublicKey／sign 變慢（視窗 W=8→6），可用 `secp256k1.Point.BASE.precompute(8)` 取回 | [release 2.3.0](https://github.com/paulmillr/noble-curves/releases/tag/2.3.0) |
| @noble/curves | 2.4.0 | Weierstrass：ECDH 與 ECDSA 拒收無窮遠點；DER 解析先限制長度再轉 bigint；安全相關參數先快照，避免呼叫端事後竄改 | [release 2.4.0](https://github.com/paulmillr/noble-curves/releases/tag/2.4.0) |
| @noble/hashes | **2.4.0** | Security and correctness：選項防竄改／防汙染、zeroization 改善、webcrypto 拒收會讓引擎崩潰的輸出長度 | [release 2.4.0](https://github.com/paulmillr/noble-hashes/releases/tag/2.4.0) |
| @noble/ciphers | 2.3.0／2.4.0 | AEAD 對不支援 AAD 的密碼傳入 AAD 改為拋錯；CBC／ECB 補位錯誤統一訊息（減少 padding oracle 訊號）；ChaCha／Salsa 拒收與未讀輸入部分重疊的輸出緩衝區；webcrypto 快照金鑰與參數 | [2.3.0](https://github.com/paulmillr/noble-ciphers/releases/tag/2.3.0)、[2.4.0](https://github.com/paulmillr/noble-ciphers/releases/tag/2.4.0) |
| @scure/base | 2.4.0 | bech32 的 encode／decode 拒收非可列印 ASCII（避免大小寫折疊把非 ASCII 變成合法字串）；base58 長度上限（二次方複雜度）；`bech32.decodeToBytes` 預設 90 字元上限 | [release 2.4.0](https://github.com/paulmillr/scure-base/releases/tag/2.4.0) |

npm 上 2.x 最新都是 **2.4.0**（curves／hashes／ciphers／base；@scure/bip32、bip39 也是 2.4.0）。`@noble/post-quantum` 0.7.1 釘 curves／hashes／ciphers **2.4.0**。

### 卡住的地方

nostr-tools 最新 2.25.2 仍**精確釘住** curves 2.0.1、hashes 2.0.1、ciphers 2.1.1、`@scure/base` 2.0.0（連帶 `@scure/bip32`／`bip39` 2.0.1 也釘舊版）。套件管理器沒辦法讓兩個互不相容的確切版本共用一份，所以只要 SDK 升級，使用方樹裡就一定有兩份——除非使用方自己用 overrides 蓋掉 nostr-tools 的相依。SDK 是函式庫，**它的 `overrides` 只對 SDK 自己的開發安裝生效**，不會傳到使用方。

## 方案

| | 內容 | 安全 | 打包 | 使用方負擔 |
|---|---|---|---|---|
| A | 維持 2.0.1，等 nostr-tools 升級 | ✗ SDK 自己的簽章、ECDH、NIP-44 都停在沒有常數時間保證的版本，時間不確定 | 一份（後量子那份 2.4 仍另外一份，ADR 0020 的殘留） | 無 |
| B | SDK 升 2.4，不管 nostr-tools | SDK 自己的路徑升級；nostr-tools 路徑（NIP-44、NIP-59、驗章）仍 2.0.1 | 使用方一定兩份 | 無，但打包變大 |
| **C** | SDK 升 2.4；SDK 開發樹用 `overrides` 讓 nostr-tools 也用 2.4；文件請使用方加同樣的 overrides | 加了 overrides 的使用方整棵樹都是 2.4 | 加 overrides：**一份**（連 ADR 0020 的後量子殘留也消失）；不加：兩份 | 在自己的 package.json（或 pnpm-workspace.yaml）加幾行 |

**使用者選 C。**

## Decision

1. **SDK 相依**：`@noble/curves`、`@noble/hashes`、`@noble/ciphers`、`@scure/base` 全部釘 **2.4.0**（確切版本，與 `@noble/post-quantum` 0.7.1 的釘版相同，使用方不加 overrides 時 SDK 與後量子至少是同一份）。
2. **SDK 開發樹的 `overrides`**：
   ```json
   "overrides": {
     "@noble/ciphers": "$@noble/ciphers",
     "@noble/curves": "$@noble/curves",
     "@noble/hashes": "$@noble/hashes",
     "@scure/base": "$@scure/base",
     "@scure/bip32": "2.4.0",
     "@scure/bip39": "2.4.0"
   }
   ```
   `npm ls @noble/curves @noble/hashes @noble/ciphers @scure/base --all` 每個套件只剩一份 2.4.0（nostr-tools、@scure/bip32、@noble/post-quantum 底下都是 `deduped`）。
   - **`@scure/bip32`／`bip39` 必須一起導**：`@scure/base` 2.3.0 移除了內部的 `utils`，而 nostr-tools 釘的 `@scure/bip39` 2.0.1 會 `import { utils } from '@scure/base'`。只導 `@scure/base` 時，`nostr-tools/nip06`（以及任何載入 bip39 的模組）在**載入時**就丟 `SyntaxError: The requested module '@scure/base' does not provide an export named 'utils'`（實測，SDK 開發樹與使用方樹都重現）。bip39 2.3.0 起已不再依賴 `@scure/base`；bip32 2.4.0 的 API 只有「回傳複本」「更嚴格的驗證」等強化，nostr-tools 用到的 `HDKey.fromMasterSeed().derive().privateKey` 行為不變。
3. **不在 SDK 初始化時 `secp256k1.Point.BASE.precompute(8)`**，也不提供選項；README 說明使用方可自行加一行（見〈效能〉）。
4. **守門測試改寫**（`tests/dependency-pins.test.ts`）：不再要求 SDK 釘版等於 nostr-tools 釘版，改為：
   - 安全下限：package.json 宣告的版本與 package-lock 裡每一份安裝都 ≥ 下限（curves／hashes／ciphers／base 皆 ≥ 2.4.0；接受確切版本或 `^`／`~`／`>=` 的下限，其他寫法視為不合格）。
   - 只有一份：package-lock.json 中每個套件只出現一次，且 overrides 指回 SDK 自己的相依（`$name`）。
   - bip32／bip39 有 overrides 且安裝的版本 ≥ 2.4.0（理由見 2.）。
   有人把版本降到下限以下、拿掉 overrides、或改用會裝出第二份的寫法，這支測試會變紅。nostr-tools／`@noble/post-quantum` 換釘版時，開發樹會被 overrides 壓回 SDK 的版本，所以測試**不會**因此變紅——升級它們時要看 `npm ls` 與 release notes，決定 SDK 是否跟著升。
5. **相容性測試**（`tests/noble-compat.test.ts`，見下節）與 v0.28 產物（`tests/fixtures/noble-2.0.1-artifacts.json`，由同目錄的 `gen-noble-2.0.1-artifacts.mjs` 在 v0.28.0 樹上產生）進版控。

## 相容性驗證

**2.0 → 2.4 的破壞性變更盤點**（對照 nostr-tools 2.25.2 與 SDK 實際 import 的符號）：

- nostr-tools 只用公開 API：`schnorr`、`secp256k1`、`sha256`、`hmac`、`hkdf` extract／expand、`scrypt`、`bytesToHex`／`hexToBytes`／`concatBytes`／`randomBytes`、`chacha20`、`xchacha20poly1305`、`cbc`、`equalBytes`、`base64`、`bech32`——2.4 全部保留、簽名不變。
- `@scure/base` 2.3.0 移除內部 `utils`：**影響 `@scure/bip39` 2.0.1**，以 overrides 升 bip39 處理（Decision 2）。nostr-tools 本身沒用。
- `@scure/base` 2.4.0 的 bech32 90 字元上限只套用在 `decodeToBytes`；nostr-tools 的 nip19 用 `bech32.decode(code, 5000)`、SDK 用 `bech32.decode(value, 1000)`，不受影響（測試含超過 90 字元的 nprofile／nevent／naddr）。
- `@noble/ciphers` 2.3.0 的 AAD 嚴格化：NIP-44 用 `chacha20`（無 AAD）、NIP-49 用 `xchacha20poly1305`（本來就支援 AAD），不受影響。
- `@noble/hashes` 2.2.0 `digestInto` 不再回傳值：nostr-tools 與 SDK 都沒用。
- `@noble/curves` 2.2.0「schnorr：亂數以 mod N 取代拋錯」：只影響極低機率的亂數邊界；BIP-340 固定 auxRand 的簽章逐位元組相同（測試）。

**測試**（全部在 overrides 後、nostr-tools 實際載入 2.4.0 的樹上跑）：

1. **NIP-44 官方測試向量**（[paulmillr/nip44](https://github.com/paulmillr/nip44) 的 `nip44.vectors.json`，SHA-256 `269ed0f6…25040` 與 NIP-44 規格公布的一致，測試會先驗雜湊）：get_conversation_key 35 組（nostr-tools 與 SDK 兩條路徑）、get_message_keys 32 組（HKDF-expand）、calc_padded_len 24 組、encrypt_decrypt 10 組（固定 nonce 逐位元組相等＋雙向解密）、長訊息 3 組（雜湊）、不合法的對話金鑰 8 組與解密 12 組（兩條路徑都拒絕）、空明文拒絕。
   - 附記：官方向量把 ≥ 65536 位元組列為不合法，但 nostr-tools 2.25 已實作 4 位元組擴充長度前綴，這些長度可以來回。這是 nostr-tools 本身的行為、早於本次升級（在 2.0.1 上同樣如此），測試明寫以免誤判。
2. **與 v0.28（noble 2.0.1）產物互通**：公鑰（nostr-tools、SDK）；BIP-340 固定 auxRand 簽章逐位元組相等；舊事件兩邊都驗得過、竄改後都驗不過；新簽事件 id 相同且互驗；ECDH 共享秘密相等；NIP-44 對話金鑰與固定 nonce 密文逐位元組相等；npub／nsec／nprofile／nevent／naddr 編碼相等、解碼再編碼相同；NIP-59：v0.28 的 nostr-tools 禮物包與 SDK `sealAndWrap` 禮物包，用新版的 `nip59.unwrapEvent` 與 SDK `openWrap` 都解得開，新版產出的禮物包也互解；NIP-49 舊 `ncryptsec` 解回原私鑰（scrypt＋XChaCha20-Poly1305）；NIP-06 助記詞導出同一把私鑰（驗證 bip32／bip39 經 overrides 升級後行為不變）。
3. SDK 全部既有測試（雙棘輪含後量子、Cinder EK、配對、同步、星狀、中繼等）：104 檔 1,471 則全過。

## 效能

同一台機器（Windows、Node 26、背景有其他工作），各跑 3 次交錯取中位，單位 µs／次：

| | 2.0.1 | 2.4.0 | 2.4.0＋`precompute(8)` |
|---|---|---|---|
| `schnorr.getPublicKey` | 187 | 292（+56%） | 230（+23%） |
| `schnorr.sign`（noble 簽完會自驗） | 1,663 | 1,607（−3%） | 1,486（−11%） |
| `schnorr.verify` | 1,209 | 1,000（−17%） | 1,009 |
| `secp256k1.getSharedSecret`（ECDH） | 1,967 | 1,807（−8%） | 1,745 |
| 第一次 getPublicKey（含建表） | 17.6 ms | 19–28 ms | 45.6 ms |
| 建表後 heap 增量 | 513 KB | 433 KB | 1,057 KB |

- 與 release notes 一致：只有「固定基點」的 getPublicKey 變慢（W=8→6 與常數時間強化）；驗章與 ECDH 反而變快，簽章持平（簽章含自驗，驗章變快抵掉了）。
- 實際影響：一次 NIP-17 私訊（seal 簽一次、wrap 產生一次性金鑰並簽一次、兩次 ECDH）多約 0.2 ms；遊戲與外掛每秒最多幾則，感受不到。

**`precompute(8)` 的決定：預設不做，不提供選項，只在 README 說明。**

- 它修改的是 `@noble/curves` 的**模組單例**（`secp256k1.Point.BASE`），在同一個打包裡對 nostr-tools、後量子、使用方自己的程式全部生效——SDK 宣告 `sideEffects: false`，匯入時偷偷改共用單例與此矛盾。
- 代價：heap 多約 620 KB、第一次簽章或取公鑰多約 25 ms（建 W=8 的表）；手機與 Obsidian 外掛的啟動時間比每次省 60 µs 重要。
- 收益只有 getPublicKey／sign 約 20%；驗章與 ECDH 不受影響。
- 需要的長時間執行程式（例如大量簽章的中繼或伺服器）可自己在啟動時加一行 `secp256k1.Point.BASE.precompute(8)`（從 `@noble/curves/secp256k1.js` 匯入），因為整棵樹只有一份，這一行對 SDK 與 nostr-tools 都生效。官方說明這是回到 2.2 的速度；未提及會影響常數時間保證。

## 打包大小

esbuild 0.28.2 壓縮打包（`--minify`，ESM），以套件名稱引用 `npm pack` 出來的 tarball 模擬使用方安裝；「份數」是輸出裡實際出現程式碼的 `@noble/curves`／`@noble/hashes` 份數。

| 入口 | v0.28.0 | v0.29.0 不加 overrides | v0.29.0 加 overrides |
|---|---|---|---|
| 遊戲入口（ADR 0020：`Identity`／`RelayPool`／`DirectMessages`／`Blocklist`） | 90.6 KB／gzip 34.3（2 份） | 125.5／47.2（2 份） | **92.3／34.1（1 份）** |
| `.`（`export *`） | 159.2／58.1（2） | 203.4／74.3（2） | **156.0／55.4（1）** |
| `/protocol` | 95.0／35.7（2） | 129.1／48.3（2） | 96.7／35.7（1） |
| `/sync` | 81.6／31.7（2） | 114.7／44.1（2） | 82.3／31.5（1） |
| `/sync/vault` | 144.5／52.9（2） | 177.6／65.1（2） | 145.2／52.7（1） |
| `/pairing` | 112.8／38.9（2） | 155.2／57.1（2） | 108.6／39.4（1） |
| `/star` | 117.8／42.5（2） | 124.1／44.7（1） | 124.1／44.7（1） |
| `/relay` | 63.5／23.4（1） | 71.6／26.1（1） | 71.6／26.1（1） |
| `/relay/worker` | 68.0／24.9（1） | 76.1／27.5（1） | 76.1／27.5（1） |
| `/relay/node` | 63.7／23.3（1） | 71.9／26.0（1） | 71.9／26.0（1） |
| `/deploy/cloudflare-api` | 104.7／37.8 | 114.0／40.9 | 114.0／40.9 |
| `/deploy` | 20.0／8.0 | 21.1／8.4 | 21.1／8.4 |
| `/transfer` | 35.1／12.7 | 36.1／13.0 | 36.1／13.0 |
| `/estimator` | 4.5／2.1 | 4.5／2.1 | 4.5／2.1 |

- **ADR 0020 的殘留重複已消除**：v0.28 的遊戲入口有兩份 curves／hashes（SDK＋nostr-tools 共用的 2.0.1，加上後量子的 2.4.0）；v0.29 加 overrides 後只剩一份。
- 不加 overrides：遊戲入口 +35 KB（gzip +13 KB），因為 nostr-tools 帶進一份 2.0.1——仍能運作，只是變大、且 nostr-tools 那份沒有新的安全修正。
- 不經過 nostr-tools 的入口（`/relay*`、`/deploy*`、`/star`）加不加都一樣，比 v0.28 大 1–8 KB，是 noble 2.4 常數時間強化本身的程式碼。中繼的 Worker 預先打包（`relay-worker-bundle.ts`）同樣隨之更新。

## 給使用方的指引

SDK 無法替使用方決定 nostr-tools 的相依；遊戲、外掛、Cinderous 要在**自己的**專案根目錄加 overrides（npm：`overrides`；pnpm 10：`pnpm-workspace.yaml` 的 `overrides`——實測 pnpm 10.33 已忽略 package.json 的 `pnpm.overrides` 並警告；pnpm 9 以前：package.json 的 `pnpm.overrides`；yarn：`resolutions`）。建議的完整組合是六個套件，全部導向 SDK 釘的 2.4.0：`@noble/curves`、`@noble/hashes`、`@noble/ciphers`、`@scure/base`、`@scure/bip32`、`@scure/bip39`。**不要只導 `@scure/base`**：會讓 `nostr-tools/nip06` 載入失敗（Decision 2）。範例、檢查指令（`npm ls`／`pnpm why`）與 CI 檢查腳本寫在 README〈Dependency overrides〉一節。

不加 overrides 也能運作：功能與互通完全相同，只是打包裡有兩份，且 nostr-tools 那份是舊版。

## Consequences

- ＋ SDK 自己的簽章、ECDH、NIP-44／NIP-59、雙棘輪、Cinder EK、配對全部改用有常數時間保證、經 Trail of Bits 審查修正的版本。
- ＋ 加了 overrides 的使用方：整棵樹一份 noble，比 v0.28 還少一份（後量子的殘留也消失），主入口打包持平或略小。
- ＋ 守門測試改看「安全下限＋只有一份」，nostr-tools 何時跟進都不會卡住 SDK 的安全更新。
- － 使用方要自己加 overrides；沒加的會多約 35 KB（gzip 13 KB），而且 nostr-tools 路徑仍是 2.0.1。
- － overrides 讓 nostr-tools 跑在它沒宣告支援的相依版本上；靠 `noble-compat.test.ts`（官方向量＋v0.28 產物）把關，nostr-tools 升級時要重跑。
- － `@noble/post-quantum` 是 `^0.7.1`：若之後的 0.7.x 改釘 noble 2.5，SDK 開發樹會被 overrides 壓回 2.4（測試照過），但**沒加 overrides 的使用方**會多出一份；屆時應一起升 SDK 的釘版。
