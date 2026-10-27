# 0020. 縮小遊戲的打包大小：@noble 升到 2.x 並與 nostr-tools 釘同一版、nip44 改走子路徑

- Status: Accepted（Decision 2、3 與守門測試已被 [ADR 0034](0034-noble-2-4-and-consumer-overrides.md) 取代）
- Date: 2026-09-29
- 相關：ADR 0007、0009（從 Cinderous 搬來的協定檔）、ADR 0012（私訊改走共用的 NIP-59）

> **2026-09-29 加註**：v0.29 起 SDK 改釘 @noble 2.4.0（安全修正），不再與 nostr-tools 的 2.0.1 釘同一版；SDK 開發樹與使用方改用 `overrides` 讓整棵樹只剩一份，守門測試改為「安全下限＋只有一份」。本 ADR 的 nip44 子路徑（Decision 1）仍有效；後量子的殘留重複（Consequences 最後一點）在加了 overrides 的使用方已消除。詳見 [ADR 0034](0034-noble-2-4-and-consumer-overrides.md)。

## Context

四款遊戲從 v0.1～v0.4 升到 v0.17.0 後，正式打包都多了約 110KB（壓縮後約 40KB）。

遊戲沒用到的模組（點對點連線、雙棘輪、同步、檔案傳輸、通話、TURN）都確實被打包工具移除了，`sideEffects: false` 有發揮作用。多出來的都是遊戲本來就會走到的路徑帶進來的，用一個只用 `Identity`／`RelayPool`／`DirectMessages`／`Blocklist` 的入口，以 esbuild 壓縮打包後量到三個原因：

1. **同樣的密碼學函式庫有兩到三份**：SDK 的協定檔用 `@noble/curves`／`@noble/hashes`／`@scure/base` 1.x；nostr-tools 釘 2.0.1；`@noble/post-quantum` 釘 2.4.0。
2. **`protocol/nip44.ts` 引用 nostr-tools 的根入口**：`import { nip44 } from "nostr-tools"`。根入口是一整包（含 NIP-04 等），打包時整包帶進來。
3. **私訊路徑引用後量子**：`nip59` 靜態引用 `hybrid-kem`。要不要走後量子是執行時才決定的，打包工具只能保留。

## Decision

1. **`nip44` 改成引用子路徑** `nostr-tools/nip44`。
2. **`@noble/curves`、`@noble/hashes`、`@scure/base` 升到 2.x，而且釘成與 nostr-tools 相同的確切版本**（目前是 2.0.1／2.0.1／2.0.0），套件管理器才會共用同一份。
   - 程式碼改動：import 路徑加 `.js`；`sha256` 改從 `sha2.js` 取；`randomPrivateKey` 改名 `randomSecretKey`；簽章與驗章改傳位元組（2.x 不再接受十六進位字串）。
   - 用範圍版本（`^2.0.1`）時，套件管理器會挑 2.4.0，和 nostr-tools 的 2.0.1 還是兩份。所以要釘確切版本。
   - **守門測試** `tests/dependency-pins.test.ts`：SDK 釘的版本必須等於 nostr-tools 釘的版本。nostr-tools 升級換了版本時，這個測試會變紅，提醒兩邊一起升。
3. `@noble/ciphers` 改為 `^2.1.1`，與 nostr-tools 相容。

**後量子改為需要時才載入，這次不做**：封裝 API 是同步的，要延後載入就得改成非同步，會動到與 Cinderous 共用的介面。以下的實測顯示，它現在只佔約 9KB。

## 實測（同一個入口，esbuild 壓縮）

| | 修正前（v0.17.0） | 只改 nip44 與範圍版本 | 修正後（釘確切版本） |
|---|---|---|---|
| 總大小 | 182.5KB | 127.5KB | **91.3KB（−50%）** |
| 壓縮後 | 66.5KB | 47.2KB | **34.0KB（−49%）** |

## Consequences

- ＋ 遊戲的打包大約縮回升級前的水準，甚至更小：舊版本來就有 nostr-tools 根入口的問題。
- ＋ 從 Cinderous 搬來的協定檔改用 2.x。Cinderous 的 core 是從 SDK 轉出，所以會一起升級，不會分岔。
- － 密碼學函式庫釘確切版本，安全更新要等 nostr-tools 跟進，或由 SDK 自己升（守門測試會提醒兩邊一致）。
- － `@noble/post-quantum` 自己釘的 2.4.0 仍會多出一小份（實測約 9KB 的 ML-KEM 加上少量雜湊）。
