[English](README.md) | **繁體中文**

# Cinderous（`@cinderous/client` ＋ `cinderous-relay`）

> **以 Nostr 為傳輸、在自己的裝置與小團隊之間做私有、本機優先的同步與協作。**  
> 線路格式就是 Nostr；上面加了：每台裝置一把金鑰、像 Git 的同步層、WebRTC P2P（連不上自動退回中繼），以及一鍵部署到你自己帳號的中繼。

---

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Nostr NIP-59 | NIP-42](https://img.shields.io/badge/Nostr-NIP--59%20%7C%20NIP--42-8B5CF6?style=flat-square)](https://github.com/nostr-protocol/nips)
[![WebRTC P2P](https://img.shields.io/badge/WebRTC-P2P%20DataChannel-339933?style=flat-square&logo=webrtc&logoColor=white)](https://webrtc.org/)
[![Cloudflare Workers & DO](https://img.shields.io/badge/Cloudflare-Workers%20%26%20DO-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-whoami885-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/whoami885)

---

## 💡 為什麼是 Cinderous？

Nostr 是為**公開廣播**設計的：貼文、追蹤、抗審查，中繼盡量什麼都存。本機優先的應用（例如 CinderSync 與 Cinder Coffice）需要的正好相反：**私有**的資料只在你自己的裝置之間流動，經過一座不需要信任的中繼。

Cinderous **不是 Nostr 的分支**。事件就是一般的 NIP-01；客戶端用 NIP-17／42／44／59／98，中繼宣告 NIP-01／11／13／40／42／62。改變的是用途，以及上面加的幾層（[ADR 0065](docs/adr/0065-positioning-private-sync-over-nostr.md)）：

| | 一般 Nostr | Cinderous |
| :--- | :--- | :--- |
| **用途** | 公開廣播 | 自己的多台裝置、小團隊之間的私有同步與協作 |
| **中繼** | 通用的公開倉庫 | 你自己的中繼（一鍵部署到自己的 Cloudflare 免費額度，或 Docker／Fly／家用通道）：私人路徑、白名單、應用車道、保存期限、容量配額，而且**預設當成不可信任**（[ADR 0064](docs/adr/0064-relay-operator-threat-model-and-bundle-hygiene.md)） |
| **身分** | 一把金鑰＝一個公開的人 | **每台裝置一把金鑰**，經配對（SAS 比對）加入同一份名單，可以單獨移除一台 |
| **資料模型** | 不可修改的事件流 | 像 Git 的同步：版本圖、三方合併、衝突標註、刪除紀錄、離線佇列、本機版本歷史與檢查點 |
| **傳輸** | 只經中繼 | 中繼＋WebRTC P2P（大檔、TURN、斷點續傳），連不上自動退回中繼 |
| **加密** | 每則事件 NIP-44／NIP-59 | 同樣的 NIP-44／NIP-59，另有兩個選用引擎：Cinder EK（金鑰每週輪替）與給即時通道的 Double Ratchet，都採 ML-KEM-768 混合金鑰交換 |

### 中繼看得到、看不到什麼

- **看不到：** 訊息與檔案內容、檔名（在裝置上就端對端加密）。
- **看得到：** IP、連線時間、訊息大小、收件人 pubkey。加密藏的是內容，不是中繼資料。
- **會保存：** 加密的離線訊息與檔案塊，到保存期限為止（`--max-ttl-days`，預設 7 天；檔案車道另有期限）。Cloudflare 上存在 Durable Object 的 SQLite；Node 版不加 `--persist` 時只放記憶體。收件裝置處理完、存好一則同步訊息後會告訴中繼（收件確認，NIP-11 的 `cinder_inbox_ack`），那幾份改為 2 小時後到期（[ADR 0067](docs/adr/0067-inbox-ack-early-expiry.md)）。

### 安全性的精確說法

- 是**後量子混合金鑰交換**，不是「量子安全」：簽章仍是 secp256k1（Schnorr），驗證身分的部分不是後量子。
- **前向保密看引擎：** Cinder EK 把外洩範圍限制在一個金鑰週期（每週輪替）；逐則的前向保密與入侵後復原只有 Double Ratchet 引擎才有。兩者都還沒經過外部審計。

---

## 🏛️ 中繼可以放在哪裡

| | Cloudflare 邊緣（Workers＋Durable Objects） | 自架（Docker／Fly／家用通道） | 任何公開 Nostr 中繼 |
| :--- | :--- | :--- | :--- |
| **設定** | 在應用裡一鍵部署（REST API，不需要 Node 或 wrangler），或 `cinderous relay deploy` | `cinderous relay deploy --provider docker`／`fly`，或 `relay build` 產生的部署包 | 貼上 `wss://` 網址 |
| **費用** | 免費額度內 $0 | 自備硬體 | $0 |
| **白名單、車道、配額** | 有 | 白名單與配額（沒有車道） | 沒有，存什麼由對方決定 |
| **保存的資料** | 加密，到保存期限為止 | 記憶體，或 `--persist` 時用 SQLite | 看對方 |

由應用決定用哪座；SDK 沒有內建預設中繼（CinderSync 會請你部署或貼上一座）。

## 🔐 雙密碼引擎取捨架構 (Dual Pluggable Crypto Engines)

Cinderous SDK 核心密碼層（`@cinderous/client`）揚棄單一加密協議綁定，透過 `ICryptoEngine` 提供雙引擎宣告式取捨與自適應協商：

```
                    ┌──────────────────────────────────────────────┐
                    │      ICryptoEngine 密碼引擎統一抽象介面       │
                    └──────────────────────┬───────────────────────┘
                                           │
             ┌─────────────────────────────┴─────────────────────────────┐
             ▼                                                           ▼
┌─────────────────────────────────────────┐ ┌─────────────────────────────────────────┐
│     【引擎 A】Cinder EK 暫態金鑰封裝     │ │       【引擎 B】後量子雙棘輪演算法      │
│            (`cinder-ek`)                │ │           (`double-ratchet`)            │
├─────────────────────────────────────────┤ ├─────────────────────────────────────────┤
│ • 適用場景：CinderSync 離線快照與盲信箱  │ │ • 適用場景：Cinder Coffice 即時多人共編 │
│ • 狀態模型：時代輪替 (Epoch-based) 無狀態 │ │ • 狀態模型：嚴格有狀態連續推進金鑰鏈    │
│ • 核心優勢：0 會話脫節、容忍任意亂序丟包 │ │ • 核心優勢：逐訊前向安全 (FS) ＋ 破局自癒│
│ • 多端分發：$O(1)$ 負載 ＋ $O(N)$ 槽位包裝 │ │ • 通訊模式：點對點 WebRTC DataChannel  │
│ • 密碼規格：NIP-44 ＋ ML-KEM-768 混合封裝│ │ • 密碼規格：X25519 ＋ ML-KEM 混合棘輪步進│
└─────────────────────────────────────────┘ └─────────────────────────────────────────┘
```

---

## ✅ 目前已實作（v0.55）

> ⚠️ **升級注意：v0.48.0 有 breaking 變更（推播閘道）**（[ADR 0062](docs/adr/0062-push-gateway-ios-default-apns.md)）
>
> - `pushGateway.ios`／`PUSH_IOS` **沒寫時改為 `"apns"`**（Workers 版與 Node 版都是；v0.47 以前沒寫＝`fcm`）。沒寫 `ios`、只設 FCM 的設定檔，`validateDeployConfig` 會回 `required` 錯誤、`relay build` 不產生部署包；已部署的推播閘道升級後重新部署，Workers 版回 503 `not-configured`、Node 版啟動失敗。三選一：
>   1. 補 `pushGateway.apnsTopic`、`apnsKeyId`、`apnsTeamId` 與 `secrets.apnsKey`（建議：iOS 直連 APNs、不經 Google）；
>   2. 只要 Android：設 `pushGateway.ios: "off"`（不需要任何 Apple 金鑰）；
>   3. 仍要經 FCM：明寫 `pushGateway.ios: "fcm"`——行為與 v0.47 相同，但**兩版都已棄用**（警告 `push-ios-fcm-deprecated`、啟動日誌 `ios-via-fcm-deprecated`）。
> - 從 `fcm` 改成 `apns`（包括因為預設值改變而改的）**沒有過渡期**：舊的（封 FCM token 的）iOS 登記回 501 `platform-disabled`，推播閘道不會改走 Google；App 下次開啟、從 `/v1/info` 看到 `ios: "apns"` 後重新登記才恢復。
> - APNs 回錯誤時，推播閘道的日誌多一個 `apnsReason`（Apple 文件列出的代碼，其他記 `other`；不進回應）；`403 BadEnvironmentKeyInToken` 的結果代碼從 `auth` 改為 `key-environment`（金鑰限定 Sandbox 或 Production：讓 `apnsEnvironment` 與金鑰一致，或建立兩個環境都能用的金鑰）。
> - 線上格式（token 封包、喚醒請求、`/v1/info` 欄位）不變；不需要各台同時升級。

- **客戶端**：多中繼連線池、NIP-17 私訊、封鎖名單、身分、試算器（[ADR 0001](docs/adr/0001-v0-1-client-scope-agpl-and-git-distribution.md)）。
- **中繼**：`@cinderous/client/relay`（核心）、`/relay/worker`（Cloudflare）、`/relay/node`（Node 主機）（[ADR 0007](docs/adr/0007-relay-and-shared-protocol-move-into-sdk.md)）。
- **白名單、純記憶體模式、`cinderous` 命令列、一鍵部署**（[ADR 0008](docs/adr/0008-allowlist-memory-mode-and-cli.md)）。

- **點對點連線 `connectPeer`**：NIP-59 信令、DataChannel、打不通自動改走中繼（[ADR 0009](docs/adr/0009-peer-connection-and-relay-fallback.md)）。

- **Cinder EK 金鑰環 `CinderEkKeyring`**：7 天輪替、寬限期後刪私鑰（前向保密）、kind 10040 公告、後量子混合封裝、防降級（[ADR 0010](docs/adr/0010-crypto-engines-cinder-ek-and-double-ratchet.md)）。實驗性，未經外部審計；後量子只保護加密、簽章仍是 secp256k1，**不是「量子安全」**。

```typescript
import { CinderEkKeyring } from '@cinderous/client';

const ring = CinderEkKeyring.create(identity);          // 或 CinderEkKeyring.fromState(identity, 已解密的狀態)
await pool.publish(ring.buildAnnounce());               // 發布 kind 10040
const wrap = ring.seal(rumor, bobPubkey, bobAnnounce, { kind: 1059, tags: [['p', bobPubkey]] });
const { sender, rumor: got, via } = ring.open(incoming); // via: 'ek'（前向保密）或 'identity'
if (ring.rotateIfDue()) await pool.publish(ring.buildAnnounce());
save(encrypt(ring.exportState()));                      // 狀態含 EK 私鑰，必須加密保存
```

- **雙棘輪 `secureChannel`**：在 `connectPeer` 拿到的通道上握手，之後每則訊息都有前向保密與外洩後自癒；預設後量子混合步進、雙方金鑰確認、對方不支援後量子就丟 `SecurityDowngradeError`（[ADR 0010](docs/adr/0010-crypto-engines-cinder-ek-and-double-ratchet.md)）。v0.28 起後量子線路格式 v2：ML-KEM 只在每一輪（預設每方每 50 則）附一次，每則 header 從 2,314 B 降到 50 B（[ADR 0033](docs/adr/0033-pq-ratchet-header-cost.md)）。只用在雙方都在線的即時通道，不跨裝置、不跨離線。**實驗性，新寫的密碼學程式，只做過一次內部獨立審查、未經外部審計。**

```typescript
import { secureChannel } from '@cinderous/client';

const channel = await node.connectPeer(bobPubkey);
const secure = await secureChannel(channel, identity); // 對方也要對同一條通道呼叫
secure.onMessage((bytes) => console.log(bytes));
await secure.send(new TextEncoder().encode('逐則前向保密'));
```

- **引擎預設與自動協商**（[ADR 0014](docs/adr/0014-engine-presets-and-negotiation.md)）：`chooseEngine({ preset: 'vault-sync' | 'live-collaboration' | 'auto-negotiate', … })`；雙方能力以 EK 公告上的 `crypto_engines` 標籤宣告。
- **音訊／視訊通話 `CallManager`**（[ADR 0016](docs/adr/0016-audio-video-calls.md)）：與 Cinderous App 同一套信令（kind 21002，NIP-59）；通話中切換語音／視訊不必重新協商；連線失敗分「打不通」與「斷線」。

```typescript
import { CallManager, TurnProvider } from '@cinderous/client';

const turn = new TurnProvider({ signer: identity, home: 'wss://你的中繼' }); // TURN 保底（ADR 0017）
await turn.start();
const calls = new CallManager({ identity, transport: pool, iceServers: turn.iceServers });
calls.onIncoming(({ peer, media }) => showRinging(peer, media)); // 之後 calls.accept() 或 calls.reject()
calls.onRemoteStream((stream) => (videoEl.srcObject = stream));
await calls.startCall(bobPubkey, 'video');
await calls.setLocalMedia('audio'); // 通話中關鏡頭
```
- **檔案傳輸 `FileTransfer`**（[ADR 0015](docs/adr/0015-file-transfer-and-resume.md)）：跑在 `connectPeer` 或 `secureChannel` 的通道上；斷線可續傳、整檔 SHA-256 校驗、走中繼超過 20 MB 預設不送；`P2PFileQueue` 把大檔排著、等 P2P 打通才直傳。

```typescript
// 也可以從子路徑 '@cinderous/client/transfer' 匯入（v0.21，ADR 0023），與主入口是同一個實作
import { FileTransfer, bytesSource, blobSource, P2PFileQueue } from '@cinderous/client/transfer';

FileTransfer.for(channel).onFile(async (file) => save(file.name, await file.read()));
await FileTransfer.for(channel).sendFile(blobSource(f.name, f.type, f), { id: 固定id, onProgress: (p) => bar(p.done / p.total) });

const queue = new P2PFileQueue({ node });       // 大檔：等 P2P
queue.enqueue(bobPubkey, blobSource(v.name, v.type, v));
queue.flush(bobPubkey);                        // 看到對方上線時
```
- **多裝置同步 `@cinderous/client/sync`**（[ADR 0011](docs/adr/0011-multi-device-sync.md)）：
  - 加密雲端快照（kind 30078）、檔案塊（kind 1060）、`DeviceSyncState`、OR-Set（與 Cinderous 同格式）；
  - `classifyPayload`：依大小決定走快照（≤160 KB）、檔案塊（≤16.5 MB）或等 P2P；
  - `merge3`：行級三方合併，改到不同段落自動合併，同段相悖才回報衝突；附衝突標記與衝突副本命名；
  - 檔案墓碑（LWW、30 天清理）與沉睡裝置隔離；
  - `FastHydrator`：回到前景立刻拉增量（自動退讓 NIP-59 倒填窗，不漏訊）、背景 15 秒斷線省電；
  - 推播介面預設關閉，`assertZeroKnowledgePush` 擋下任何帶內容的推播。

```typescript
import { classifyPayload, FastHydrator, merge3 } from '@cinderous/client/sync';

classifyPayload(bytes.length); // 'snapshot' | 'file' | 'p2p'
const { clean, merged, conflicts } = merge3(base, local, remote);
new FastHydrator({ pool, filters, onEvents, lastSyncAt, setLastSyncAt }).start();
```

- **不交出私鑰的同步與協定 API**（v0.21，[ADR 0023](docs/adr/0023-transfer-subpath-and-nostr-signer.md)）：`buildSnapshotEvent`、`openSnapshotEvent`、`wrapFileChunk`、`sealAndWrap`／`openWrap`、信令、裝置目錄、EK 分發等，原本收原始私鑰的參數現在也收 `Identity`（或任何實作 `NostrSigner` 的物件：`pubkey`、`sign`、`conversationKey`）。舊的呼叫方式不變，兩條路徑產生的事件互通。

```typescript
import { buildSnapshotEvent, openSnapshotEvent, wrapFileChunk } from '@cinderous/client/sync';

const snapshot = buildSnapshotEvent(JSON.stringify(state), identity, deviceId); // 不必拿出私鑰
const restored = openSnapshotEvent(event, identity);
const chunk = wrapFileChunk({ tid, seq: 0, total: 1, name, mime, data }, identity, peerPubkey);
```

```typescript
import { Identity, RelayPool, DirectMessages, Blocklist } from '@cinderous/client';
import { estimateResourceConsumption } from '@cinderous/client/estimator';

const identity = Identity.generate();
const pool = new RelayPool({
  urls: ['wss://relay.example.com/app/<你的車道>'],
  identity, // 回應 NIP-42 AUTH
});
pool.connect();
const blocklist = new Blocklist(localStorage);
const dms = new DirectMessages({ transport: pool, identity, storage: localStorage, isBlocked: (pk) => blocklist.has(pk) });
dms.watch((threads) => console.log(threads));
await dms.send(peerPubkey, '哈囉');
```

- **非同步聊天儲存**（v0.21，[ADR 0024](docs/adr/0024-async-chat-storage.md)）：`DirectMessages` 與 `Blocklist` 除了同步的 `ChatStorage`（`localStorage`），也收 `AsyncChatStorage`（`getItem`／`setItem` 回傳 Promise，例如 IndexedDB）。讀取在背景進行、寫入排隊一次一個且只寫最新狀態；讀取失敗就只留在記憶體，不會蓋掉舊紀錄。同步儲存的行為完全不變。

```typescript
import { Blocklist, DirectMessages, MemoryAsyncChatStorage, type AsyncChatStorage } from '@cinderous/client';

const storage: AsyncChatStorage = myIndexedDbStore; // 測試可用 new MemoryAsyncChatStorage()
const blocklist = new Blocklist(storage);
await blocklist.ready(); // 先讀回封鎖名單，再開收件匣
const dms = new DirectMessages({ transport: pool, identity, storage, isBlocked: (pk) => blocklist.has(pk) });
await dms.ready();       // 舊對話讀回來了
dms.watch(render);
await dms.flush();       // 需要時：等排著的寫入完成（例如關閉外掛前）
```

- **檔案樹同步協調器 `@cinderous/client/sync/vault`**（v0.22，[ADR 0025](docs/adr/0025-vault-sync-coordinator.md)）：CinderSync 與 Cinder Coffice 共用的資料夾層級同步。零 Node 內建模組；檔案系統（`VaultAdapter`）、狀態儲存（`SyncStateStore`）、時間、網路一律注入，身分用任何 `NostrSigner`（例如 `Identity`）。
  - 路徑 → 版本索引、每個檔案一張版本圖，保存 `merge3` 需要的共同祖先；
  - 送出佇列持久化：離線時累積（同一檔多次修改合成一筆）、重連或重啟後續傳、失敗以退避重試；
  - 套用遠端變更時帶前置條件：磁碟上的內容不是索引記的那一份（使用者剛好改了）就先收成本機版本再合併，**絕不無聲覆蓋**；
  - 回環抑制靠內容雜湊：自己寫進去的遠端內容，外掛再通知也不會被送出；
  - 改名是一個操作：另一台同時對舊路徑的修改會跟著套到新路徑上；兩邊改成不同名字取較晚的；
  - 一邊刪、一邊改內容時保留修改；兩邊都改而合不起來（同一段、二進位）時，另一方的完整內容存成衝突副本（`conflictCopyName`），發 `conflict` 事件；
  - 合併是確定性的：同一組版本，每台算出同一個結果，所有裝置收斂到同一棵檔案樹——由固定種子的隨機性質測試守著（多台裝置隨機編輯、改名、刪除、斷線、重啟，網路延遲、亂序、重送）；
  - 超過檔案塊層上限的大檔只同步中繼資料，標成「待 P2P」並發 `pending` 事件；給了 `peers` 就經 P2P 直送（v0.23，見下）；
  - 線上格式沿用 kind 1060 禮物包外層、內層新的 kind，舊客戶端直接略過；中繼不需要改。

```typescript
import { App, TFile, normalizePath } from 'obsidian';
import { createNostrVaultTransport, VaultSyncCoordinator, type VaultAdapter, type SyncStateStore } from '@cinderous/client/sync/vault';

// Obsidian 的 Vault → VaultAdapter（路徑是 Vault 內相對路徑、以 / 分隔）
function obsidianVault(app: App): VaultAdapter {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const get = (p: string) => {
    const f = app.vault.getAbstractFileByPath(normalizePath(p));
    return f instanceof TFile ? f : null;
  };
  const bytesOf = async (f: TFile | null) => (f ? new Uint8Array(await app.vault.readBinary(f)) : null);
  const ensureFolder = async (p: string) => {
    const dir = p.split('/').slice(0, -1).join('/');
    if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
  };
  return {
    list: async () => app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime })),
    read: async (p) => (await bytesOf(get(p))) ?? Promise.reject(new Error(`找不到 ${p}`)),
    stat: async (p) => {
      const f = get(p);
      return f ? { path: f.path, size: f.stat.size, mtime: f.stat.mtime } : null;
    },
    async write(p, bytes, expect) {
      const f = get(p);
      if (!f) {
        if (expect && !expect(null)) return false;
        await ensureFolder(p);
        await app.vault.createBinary(normalizePath(p), bytes.slice().buffer);
        return true;
      }
      if (f.extension === 'md') {
        // vault.process 是原子的「讀－檢查－寫」：中間打的字不會被蓋掉
        let ok = true;
        await app.vault.process(f, (data) => {
          if (expect && !expect(enc.encode(data))) {
            ok = false;
            return data;
          }
          return dec.decode(bytes);
        });
        return ok;
      }
      if (expect && !expect(await bytesOf(f))) return false;
      await app.vault.modifyBinary(f, bytes.slice().buffer);
      return true;
    },
    async remove(p, expect) {
      const f = get(p);
      if (!f) return true;
      if (expect && !expect(await bytesOf(f))) return false;
      await app.fileManager.trashFile(f); // 依使用者的垃圾桶設定
      return true;
    },
    async rename(from, to, expect) {
      const f = get(from);
      if (!f || get(to)) return false;
      if (expect && !expect(await bytesOf(f))) return false;
      await ensureFolder(to);
      await app.vault.rename(f, normalizePath(to)); // 不用 fileManager.renameFile：連結已經在另一台更新過了
      return true;
    },
  };
}

const identity = await loadOrCreateIdentity(secretStore);
const pool = new RelayPool({ urls: [relayUrl], identity });
pool.connect();
const transport = createNostrVaultTransport({ pool, signer: identity, devices: otherDevicePubkeys });
const sync = new VaultSyncCoordinator({
  adapter: obsidianVault(this.app),
  store: myIndexedDbStore satisfies SyncStateStore, // get/set/delete/keys(prefix)，值是 Uint8Array
  transport,
  deviceId: settings.deviceId,     // 每台裝置固定
  deviceLabel: settings.deviceName, // 衝突副本檔名裡的裝置名稱
  ignore: (p) => p.startsWith('.obsidian/') || p.startsWith('.trash/'),
});
sync.on('status', (s) => statusBar.setText(`CinderSync: ${s.state} (${s.queue})`)); // idle／syncing／offline／error／paused
sync.on('conflict', (c) => new Notice(`衝突：${c.path}${c.copyPath ? ` → ${c.copyPath}` : ''}`));
await sync.start(); // 讀回狀態、掃描離線期間的變更、開始收送
// 建議每個路徑防抖 500ms；協調器自己寫的檔案會以雜湊認出來、略過
this.registerEvent(this.app.vault.on('modify', (f) => sync.notifyLocalChange(f.path, 'modify')));
this.registerEvent(this.app.vault.on('create', (f) => sync.notifyLocalChange(f.path, 'create')));
this.registerEvent(this.app.vault.on('delete', (f) => sync.notifyLocalChange(f.path, 'delete')));
this.registerEvent(this.app.vault.on('rename', (f, old) => sync.notifyLocalChange(f.path, 'rename', old)));
// 行動版回到前景：new FastHydrator({ pool, filters: transport.filters(), onEvents: (e) => transport.ingestEvents(e), … })
```

- **P2P 批次串流與大檔串流寫入**（v0.23，[ADR 0026](docs/adr/0026-p2p-batch-stream-and-large-file-streaming.md)）：`StreamTransfer`（在 `@cinderous/client/transfer`，主入口不帶）在任何 `connectPeer`／`secureChannel` 通道上，把多個檔案合成**一條串流**：小檔併成少數幾則訊息、每檔 SHA-256 校驗、信用視窗背壓，記憶體占用與檔案大小無關（實測 16 MB 與 128 MB 的檔案，未確認的資料峰值都約 1 MB）。超過內嵌上限的檔案分塊寫進注入的 `StreamingFileStore`，從已收到的位元組續傳（App 重開也行），校驗通過才原子地提交（`commit`），不通過就丟棄。線路格式是新的（標記 `0xCB`＋版本位元組），舊的 `FileTransfer` 直接略過。`P2PStreamQueue` 是可持久化的「等 P2P 才送」佇列：重開後 `restore()`，用 `open()` 重新打開檔案。
  - 檔案樹同步協調器給了 `peers`（`peerNodeLink({ node, devices })`）就會用它：新裝置加入、大量變更（待送出 ≥ 10 個版本）改走一條 P2P 批次，不再每個檔案、每台裝置各一顆 kind 1060（會撞到中繼每位收件人 4,000 顆的配額）；超過檔案塊層的大檔經 P2P 直送，轉接器有 `writeStream` 就分段寫進 Vault。退路：WebRTC → 中繼軌（kind 20079，ephemeral，只送小檔）→ 限速的 kind 1060（預設每小時 20 則，在配額之內）。經 P2P 收到的一切與中繼一樣逐欄驗證（安全路徑、寄件裝置綁定已認證的通道、大小與雜湊）。
  ```typescript
  import { peerNodeLink, VaultSyncCoordinator } from '@cinderous/client/sync/vault';
  const node = new PeerNode({ identity, transport: pool, acceptFrom: (pk) => Object.values(devices).includes(pk) });
  const sync = new VaultSyncCoordinator({ adapter, store, transport, deviceId, peers: peerNodeLink({ node, devices }) });
  ```
- **Vault 同步需要中繼接受檔案事件**（v0.23，[ADR 0027](docs/adr/0027-relay-file-events-for-vault-sync.md)）：協調器的外層是 kind 1060，Cinderous 中繼沒設 `MAX_FILE_MB` 就整類拒收。所有部署路徑（REST 一鍵部署、wrangler、Docker、Fly、`cinderous relay deploy|start --max-file-mb`）都能給 `maxFileMb`——用 `VAULT_SYNC_MAX_FILE_MB`（17）；開放中繼（沒有白名單）另外要 `openFileRelay: true`。預設仍然不開。所有中繼都以這個原因拒收時，協調器回報 `status().blocked === 'relay-rejects-files'`（只發一次 `error` 事件、改成慢速探測，不會一直重試；有 `peers` 時在線裝置之間照樣經 P2P 同步）。`checkRelayAcceptsFiles(url)` 讀 NIP-11 的 `cinder_accepts_files`，外掛可以在連線前先提示。
- **QR 裝置配對與 Vault 名單 `@cinderous/client/pairing`**（v0.24，[ADR 0028](docs/adr/0028-qr-device-pairing-and-vault-roster.md)）：讓新裝置加入 Vault，**不複製任何私鑰**——每台裝置各自一把身分金鑰。SDK 只產生與解析 QR 字串（`cinderous-pair:1.…`，≤ 213 bytes＝錯誤修正 M 的 QR 版本 10，一般是版本 8），QR 影像的產生與掃描由應用自己做。哪一邊顯示都可以（`invite`：成員顯示、新手機掃；`join`：新裝置顯示、既有的手機掃）。握手混入 QR 裡 128 位元的一次性秘密、臨時 ECDH 與雙方身分金鑰，走新的 ephemeral kind 21003 的 NIP-59 禮物包，最後**兩台螢幕都顯示同一組 6 位數 SAS，兩邊使用者都要確認**。QR 一次性、5 分鐘內有效；有第二台拿同一個 QR 來配對，整次作廢（`contested`）。結果是 `VaultMembership`（第一台裝置以 `VaultMembership.create({ signer: identity })` 建立；名單每一筆都有簽章，裝置自己的 deviceId 與名稱由它自己簽，別台改不了）：互相信任的裝置清單＋共享 Vault 金鑰（協調器本身只需要清單；金鑰給應用自己的對稱加密需求）。它直接接上 `NostrVaultTransport`（`peerPubkeys()`、新的 `setDevices()` 與 `deviceOf`）、`peerNodeLink`（`peerDevices()`，`devices` 現在可以是函式）與自己中繼的白名單（`allowedPubkeys()`）。`revoke()` 移除裝置並輪換金鑰：被撤銷的裝置拿不到任何新東西，但**它已經同步到的內容無法追回**。`NostrRosterSync` 把名單變動送給其他成員（預設 kind 1060 外層，v0.35 起可選 `outerKind: 1059`；內層 4361）；協調器新增的 `resync()` 在有裝置加入時重送摘要。
  - 同一版的中繼修正：白名單站原本會拒收所有禮物包（外層作者是一次性金鑰），包括 Vault 同步。現在以名單上的公鑰通過 NIP-42 認證的連線可以發布。請重新部署中繼。
  ```typescript
  import { acceptPairingUri, createPairingOffer, NostrRosterSync, parsePairingUri } from '@cinderous/client/pairing';
  // 既有裝置（成員）顯示 QR
  const offer = createPairingOffer({ role: 'invite', signer: identity, pool, membership, relays: settings.relayUrls, device: { label: '桌機' } });
  showQr(offer.uri);
  const { sas } = await offer.ready;   // 顯示出來，請使用者和手機比對
  offer.confirm();
  // 新裝置掃描
  const scan = acceptPairingUri(scanned, { signer: identity, pool: new RelayPool({ urls: parsePairingUri(scanned).relays, identity }) });
  await scan.ready; scan.confirm();
  const { membership } = await scan.result; // membership.toJSON() 存進機密儲存，不要寫進 data.json
  ```
- **對齊中繼的檔案車道：單檔 30 MB、依 NIP-11 決定上限與補送預算、分頁取回**（v0.25，[ADR 0029](docs/adr/0029-file-lanes-alignment.md)；對應 Cinderous ADR-0371）
  - **客戶端**：`fetchRelayFilePolicy(url)`（`checkRelayAcceptsFiles` 同一份）讀**同一路徑**的 NIP-11（`wss://<host>/app/<車道>` → `GET https://<host>/app/<車道>`），帶回 `maxFileMb`（`cinder_max_file_mb`）、`fileChunksPerRecipient`（`cinder_file_chunks_per_recipient`）、`retentionSeconds`。`loadRelayFileLimits(urls)` 把每一座合成一組**最嚴的**限制（讀不到的當未知、用保守預設：16.5 MB／848 塊／7 天），交給協調器的 `relayLimits` 選項或 `setRelayLimits()`：經中繼的單檔上限跟著中繼走（錨點檔案車道 30 MB＝656 塊；收端絕對上限 64 MiB），批次補送改以**塊**計算——任何一段保存期內寄給同一位收件人的塊數 ≤ 配額 × 0.75（1,440 塊／7 天 → 1,080 塊，平均約 6.4 塊／小時），不會把收件人還沒領的塊擠掉；用量跨重開保留、`status().relayQuota` 看得到。🔴 單檔上限調到 16.5 MB 以上前，同一個 Vault 的每一台裝置都要先升到 v0.25（舊版收端只收得下 16.5 MB）。
  - **分頁**：中繼一次 REQ 有位元組預算（16 MB），超過的最舊那些不回、而且不說。`forEachPage`／`queryPaged`（`./sync`）以這一頁最舊的 `created_at` 當 `until` 往回翻到一頁沒有新事件為止；`FastHydrator` 預設分頁，`NostrVaultTransport` 在啟動與重新連上時自動分頁補拉（`backfill()`；需要連線池有 `query`）。
  - **中繼**（`./relay`）逐項移植 Cinderous main 的 ADR-0371：`FILE_LANES`（車道模式：只有同時在 `APP_LANES` 上的車道收 1060、`MAX_FILE_MB` 改當單檔上限；沒設就與過去相同）、`filePolicyFor`、車道 id 持久化、NIP-11 兩個新欄位、檔案車道配額（2 × 上限檔塊數 ＋ 128）與每顆 DO 1 GiB 天花板、儲存層 `bytes` 欄／覆蓋索引／用量快取／重複 `p` 去重／檔案桶無條件修剪、REQ 16 MB 位元組預算。DO SQLite 與 Cinderous main 的 schema 逐字相同（同一顆 DO 從 Cinderous 版切到 SDK 版有測試）。SDK 預設值不含任何錨點專屬數字。
  - **一鍵部署的 `maxFileMb`**：部署出來的是自架單人中繼（白名單、沒有車道），`MAX_FILE_MB` 是**全站開關**，數值不強制、NIP-11 也不宣告單檔上限；要車道模式請自行設 `FILE_LANES`（多租戶的 Cloudflare 站才需要）。
  ```typescript
  import { loadRelayFileLimits, VaultSyncCoordinator } from '@cinderous/client/sync/vault';
  const limits = await loadRelayFileLimits(['wss://relay.example/app/cindersync']);
  sync.setRelayLimits(limits); // 或 new VaultSyncCoordinator({ …, relayLimits: limits })
  ```
- **多人星狀會話 `@cinderous/client/star`**（v0.26，[ADR 0030](docs/adr/0030-star-session.md)；Cinder Coffice G4）：一個 Host、最多 64 位成員（預設 16），每位成員與 Host 各一條成對的 `secureChannel`（雙棘輪）。⚠ **這不是端到端群組加密**：Host 解密每位成員送來的訊息，再以其他成員各自的通道重新加密轉送——**Host 看得到、也改得了經過它的所有內容**，只讓信任的人當 Host。
  - **邀請**：`host.createInvite({ relays })` 產生 `cinderous-star:1.…`（Host 公鑰＋128 位元秘密＋到期＋中繼），預設 10 分鐘、一次性，可設可用次數、綁定某把公鑰、`revokeInvite(id)`；秘密只在握手完成後的加密通道裡送出，Host 只存雜湊。可選 `approveJoin` 讓使用者按「允許」。
  - **成員進出**：加入時拿到現有名單，其他人收到 `joined`；`leave()`、`kick(pubkey)`（預設封鎖；被踢的人通道關閉、之後什麼都收不到也送不進來；成對通道之下其他人不必重新協商）、同一身分重連取代舊連線（`replaced`）；Host 關閉會話時成員收到 `ended(host-closed)`，Host 斷線（通道關閉、心跳逾時、失步）收到 `host-lost`。**不自動換 Host**。
  - **順序**：每則轉送都帶 Host 序號與寄件人（Host 依**通道認證的身分**填，成員無法冒充）；Host 序號是全體一致的全序，也涵蓋名單事件，而且與因果一致（你看過的訊息，序號一定比你之後送的小）。可單播（`to`）、可 `echo`、`topic`（0–255）分類、`volatile`（游標之類，背壓時先丟）。
  - **背壓**：每位成員一條佇列（預設 8 MiB／4,096 筆），滿了先丟 volatile，還是放不下就請那位成員離開（`overflow`，重新加入再同步），慢成員拖不垮其他人；灌量的人（超過進站速率，或一個人佔滿別人佇列的一半以上）被請離開的是它自己（`rate-limit`），不是無辜的慢成員；成員端佇列滿了 `send` 丟 `backpressure`。
  - **傳輸**：P2P 優先、中繼軌（kind 20079）退路；中繼軌有確認與重送、亂序重排，並依每分鐘事件預算（預設 100；`starRelayEventsPerMinute(nip11)` 從 NIP-11 `cinder_max_events_per_minute` 算）拉開每條鏈路的間隔，Host 把預算平均分給走中繼的成員。`host.listen(node)` 會替每條連進來的通道做握手：同一個 `PeerNode` 另有用途（例如 Vault 同步）時一定要給 `accept`。SDK 不會自己連到邀請裡的中繼，App 的連線池要涵蓋它們。
  - **後量子開銷**（v0.28，[ADR 0033](docs/adr/0033-pq-ratchet-header-cost.md)）：一則 20 B 的更新實測成員→Host 131 B、Host→每位成員 170 B（v0.27 是 2,395／2,434 B；古典 122／161 B）；同一個批次視窗（P2P 16 ms、中繼 250 ms）內的多筆自動合成一則，50 筆合計 1,503 B。經中繼時一則 20 B 更新是 2,214 B 的事件、50 筆合併 5,970 B，與古典相同。每方大約每 50 則會有一則多帶 ML-KEM 密文或公鑰（1.1–1.2 KB）。
  - 大檔（蟲洞投影的附件）：`host.channelOf(pubkey)`／`member.channel` 是底層的成對通道，可直接給 `StreamTransfer.for(channel)`（標記不同、互不干擾；那是 Host 與該成員的直送，不經轉送）。
  ```typescript
  import { StarHost, StarMember } from '@cinderous/client/star';
  // Host
  const host = new StarHost({ identity, relayEventsPerMinute: 96 });
  host.listen(node);                                   // node = 這個身分的 PeerNode
  const { uri } = host.createInvite({ relays: settings.relayUrls }); // 以 QR／私訊交給對方
  host.onMessage((m) => Y.applyUpdate(ydoc, m.payload)); // m.from 是通道認證的寄件人、m.seq 是全體順序
  host.onEvent((e) => { if (e.type === 'joined') host.send(Y.encodeStateAsUpdate(ydoc), { to: [e.pubkey] }); });
  // 成員
  const me = await StarMember.join({ identity, node, invite: uri, label: '小明' });
  me.onMessage((m) => Y.applyUpdate(ydoc, m.payload));
  me.onEvent((e) => { if (e.type === 'host-lost' || e.type === 'ended') showSessionEnded(e); });
  me.send(update);                                     // 游標：me.send(cursor, { topic: 1, volatile: true })
  ```
- **中繼修正兩個 Cloudflare 上限**（v0.27，[ADR 0032](docs/adr/0032-do-sql-bindings-and-ws-attachment-limits.md)；對應 Cinderous ADR-0372／0373）：Durable Object 的 SQLite 每次查詢最多 **100 個綁定參數**，`authors`／`ids`／`kinds`／`#p`／標籤值有 99 個以上的 REQ 會回 NOTICE、沒有 EOSE——查詢改把整串值當成一個 `json_each(?)` 參數（結果、順序、`limit`、16 MB 預算都不變）。WebSocket attachment 最多 **16 KB**，同一條連線訂閱約 240 把以上的 `authors` 就完全沒有回應、休眠後訂閱消失——小訂閱照舊放 attachment，大的溢位到 `ws_subs` 表（只在內容變了才寫、每連線合計 512 KiB，存不住的一律回 `CLOSED`）。白名單、每把公鑰連線數、每 IP 速率與檔案車道在兩個修正下照常運作；DO schema 與套用兩個 PR 後的 Cinderous 相同。已部署的中繼要重新部署才有（REST 一鍵部署內嵌的 Worker 已包含）。
- **後量子雙棘輪線路格式 v2**（v0.28，[ADR 0033](docs/adr/0033-pq-ratchet-header-cost.md)）：ML-KEM 交換與 DH 步進脫鉤。每一方每送 `pqRekeyInterval` 則（預設 50，與 iMessage PQ3 相近）開一輪 KEM；密文每條傳送鏈只附一次，在對方**下一次** DH 步進時混入根金鑰——帶密文的那一則遺失，不會讓任何一則解不開，只會延後後量子的自癒。後量子 header 現在是 **50 B**（原本每則 2,314 B）：開始一輪時 1,142 B、公布新公鑰時 1,238 B，雙向輪流平均約 94 B。後量子保密仍涵蓋每一則（Alice 第一條鏈照舊綁定握手的 ML-KEM）、前向保密不變；後量子事後自癒從「下一步」變成「最壞約 2 × `pqRekeyInterval` 則加幾個來回」（要接近舊行為可設 `pqRekeyInterval: 1`）。攻擊者專丟帶 KEM 的訊息時，看門狗以 `SecurityDowngradeError` 關閉會話；已認證的對方違反協定（例如送來不合法的 ML-KEM 公鑰）則以 `RatchetProtocolError` 關閉。`secureChannel` 的 hello 以 `pqf` 協商格式：要後量子的 v0.27 對端會被 `UnsupportedRatchetVersionError` 明確拒絕（請雙方升級），不會靜默降級；古典模式逐位元不變、照常互通。v0.27 匯出的後量子會話狀態不能還原（請重新握手）。
- **@noble 升到 2.4，密碼學函式庫只留一份**（v0.29，[ADR 0034](docs/adr/0034-noble-2-4-and-consumer-overrides.md)）：`@noble/curves`、`@noble/hashes`、`@noble/ciphers`、`@scure/base` 從 2.0.x 升到 **2.4.0**——常數時間由「盡力」改為實際保證（純量以 CSPRNG 盲化、常數時間固定視窗乘法），並含 Trail of Bits 審查修正、ECDH／ECDSA 拒收無窮遠點、hashes 2.4.0 的安全與正確性修正。nostr-tools 仍釘 2.0.1，**請照下方加 overrides** 讓整棵樹只剩一份（不加也能運作，只是打包裡有兩份、且 nostr-tools 那份停在 2.0.1）。已用 NIP-44 官方測試向量，以及 v0.28（noble 2.0.1）產出的事件、簽章、NIP-44 密文、NIP-19 字串、NIP-59 禮物包驗證互通。`getPublicKey` 約慢 0.1 ms，驗章與 ECDH 變快；`precompute(8)` 的說明見下方。
- **一鍵部署可以設定已知租戶車道與站台參數**（v0.31，[ADR 0036](docs/adr/0036-deploy-app-lanes-and-dochost-on-self-hosted-relays.md)、[ADR 0037](docs/adr/0037-one-click-deploy-parameters.md)）：四條部署路徑（REST、wrangler、docker、fly）共用 `RelaySiteOptions`，驗證與環境變數的對應只在 `relaySiteVars` 一處。新增 `appLanes`（`APP_LANES`，沿用中繼的車道 id 格式、最多 32 條）、`fileLanes`（須在 `appLanes` 上並給 `maxFileMb`）、`maxTtlDays`（1–365）、`maxConnectionsPerPubkey`（1–100，預設 5）、`maxMessagesPerSecondPerIp`（1–1000，預設 20）、`appLanePow`（0–32）、`developerDocsUrl`（https）、`relayDescription`／`relayContact`／`relayPubkey`／`donations`；範圍外在部署前丟例外，沒有任何選項能關掉限速或無界保存。車道類參數只有 Cloudflare 版支援，給 docker／fly 會丟例外（Node 主機沒有車道）。
  - 🔴 **改名單＝換 DO**：名單上的車道各有一顆 Durable Object，改了名單那條車道的舊資料留在原處等到期、不會搬過去。REST 路徑重新部署時會讀線上的 `APP_LANES`，不同就丟 `lane-change`（不上傳），確定要改才帶 `allowLaneChange: true`；wrangler 路徑沒有這個檢查，重新部署請帶同一份名單。
  - NIP-11（車道路徑）多宣告 `cinder_addressable_per_author`（嚴格 5／已知租戶 64／公用車道 16）、`cinder_addressable_max_bytes`（256 KB／32 KB），以及有設才出現的 `cinder_max_messages_per_second_per_ip`。
  - 一鍵部署預設每 IP 每秒 20 則：一次推很多事件的客戶端要節流，或把 `maxMessagesPerSecondPerIp` 調高。
  ```typescript
  import { deployCloudflareRelayViaApi } from '@cinderous/client/deploy/cloudflare-api';
  const { relayEndpoint } = await deployCloudflareRelayViaApi({
    apiToken, fetch: obsidianFetch,
    workerName: 'my-dochost-relay',
    allowedPubkeys: [pk],          // 車道不要求 AUTH：白名單看的是事件簽章者
    appLanes: ['dochost'],         // /app/dochost 成為已知租戶：可尋址 64 個／30 天
    maxMessagesPerSecondPerIp: 100,
    relayName: 'My DocHost relay',
  });
  // 客戶端連 `${relayEndpoint}/app/dochost`
  ```
  ```bash
  npx cinderous relay deploy --name my-dochost-relay --allowed-pubkeys npub1... --app-lanes dochost --max-messages-per-second-per-ip 100
  ```
- **中繼不再對存不下的離線留言回 `OK true`**（v0.31.1，[ADR 0038](docs/adr/0038-relay-capacity-signals-and-client-fallback.md) P0-R1）：嚴格平面（不淘汰）每顆 DO 的離線天花板滿了，回 `OK false "blocked: ceiling: …"`，而且不扇出；事件自帶的 NIP-40 `expiration` 已經過了，回 `OK false "invalid: expired: …"`。被拒的事件不再記進重放快取，之後重送同一顆會收下，而不是回 `duplicate`。每收件人 FIFO 與車道淘汰（收下新的、刪掉舊的）照舊回 `OK true`。
- **中繼的拒收帶機器可讀的詞元，客戶端會分類**（v0.32，[ADR 0038](docs/adr/0038-relay-capacity-signals-and-client-fallback.md) P0-R2／P0-C，[ADR 0040](docs/adr/0040-relay-reject-tokens.md)）：SDK 中繼（與 Cinderous 錨點）的每一則 `OK false`、`CLOSED` 與關鍵 `NOTICE` 都改成「`<NIP-01 前綴>: <詞元>: <說明>`」——`blocked: quota: …`、`blocked: ceiling: …`、`blocked: stale: …`、`invalid: expired: …`、`rate-limited: events: …`、`restricted: scope: …`、`error: resubscribe: …`（完整表見 ADR 0040）。可尋址原本只有一句 `blocked: 取代事件遭拒（配額/大小/較舊）`，現在依原因拆開（較舊、太大、位址數、總量、已過期、DO 天花板），靠 `OfflineStore` 新增的選用方法 `putAddressableResult()`；只實作 boolean `putAddressable()` 的自訂 store 照舊可用、回舊句子。重放的事件改回 NIP-01 的 `OK true "duplicate: …"`；store 丟例外時那顆不再留在重放快取裡。車道升級被拒的三句 NOTICE（`unknown relay path`、`invalid app lane`、`rate-limited: too many new connections`）不改——Cinderous 開發者文件逐字列了它們。
  - 客戶端：`classifyRelayMessage(message)` → `{ prefix, token, kind, retryable, tryOtherRelays }`（第三方中繼退到前綴那一層；舊句子照樣認得）。`PublishResult.rejected[]` 多了 `kind`／`retryable`／`tryOtherRelays`／`token`，`duplicate`（新的 `OK true` 或舊中繼的 `OK false`）算收下。`SocketLike` 的 close 事件可以帶 `code`／`reason`：被 1008 `rate-limited` 踢掉時，進行中的發布以 `rate-limited` 結案、重連直接用最長退避；4003 是 `restricted`；沒有關閉碼照舊是網路斷線。
  - 部分拒收不再被丟掉：`onRelayReject(url, rejection)` 回報每一座的 `OK false`、`CLOSED`、帶前綴的 `NOTICE` 與帶關閉碼的斷線；`DirectMessages.send` 回傳給對方那一份的 `accepted`／`rejected`；私訊、Vault 傳輸層、名單同步、`PeerNode` 加 `onPublishRejected(report)`。成功判定不變（至少一座收下；`minAccepted` 在 P1）。
  - 常駐訂閱被 `CLOSED "error: resubscribe: …"`（中繼重啟後遺失）時，自動對那一座重訂，同一座 30 秒內最多一次；`restricted: scope:`、`invalid: too-large:` 之類不重訂（修改 ADR 0032）。
  - ⚠ `PublishResult.rejected` 的元素多了欄位——以 `toEqual({ url, reason })` 比對的測試要改。中繼要重新部署才會帶詞元；舊中繼客戶端照樣以前綴分類。
  ```typescript
  const pool = new RelayPool({
    urls, identity,
    onRelayReject: (url, r) => {
      if (r.kind === 'ceiling' || r.kind === 'quota') markFull(url);      // 之後改寫到別座
      else if (r.source === 'close' && r.kind === 'rate-limited') slowDown();
    },
  });
  const { accepted, rejected } = await pool.publish(event);
  for (const r of rejected) console.log(r.url, r.kind, r.retryable, r.token);
  ```
- **每座中繼的健康狀態、耐久度要求與備援中繼、讀回稽核、NIP-65／NIP-17 中繼清單**（v0.33，[ADR 0038](docs/adr/0038-relay-capacity-signals-and-client-fallback.md) P1，[ADR 0041](docs/adr/0041-relay-health-durability-and-read-back-audit.md)）。**不採用就沒有任何差別**：不帶選項的 `publish(event)` 行為與回傳都和 v0.32 相同。
  - 健康狀態：`RelayPool` 依拒收分類記住每一座——`ceiling`／`quota` 把那一類資料（離線留言、可尋址…）標成**已滿** 1 小時；政策、白名單外把那個 kind 標成**不適用**（24 小時，或 `resetRelayHealth()`；v0.35.1 起重讀 NIP-11 看得出原因已不成立時由 `revalidateRelay` 清掉）；`too-large` 標那個 kind、那麼大以上；`rate-limited` 整座退避到計數窗結束（60 秒，`ip` 1 秒）；關閉碼 1008／4003 分別退避／不適用；`invalid` 是自己的錯，不標記。`pool.relayHealth()` 查、`pool.onRelayHealthChange()` 訂閱（重複的拒收只延長標記、不再通知）。只放記憶體：冷卻很短、中繼會恢復，持久化過期的標記反而會略過一座早就好了的中繼。
  - 耐久度：`pool.publish(event, { durability: { minAccepted, standby } })`（`minAccepted` 預設 1）會略過這一則被標記的中繼，只計**耐久收下**——`OK true` 與 `duplicate`，**不含** `OK true "warning: borrowed: …"`（ADR 0039；客戶端先認得，`PublishResult.borrowed` 會列出）。不足時，**只有給了 `standby`** 才延遲連上下一座備援、**只補發這一則**；備援不收常駐訂閱（除非 `standbySubscribe: true`）、不出現在 `status()`、不自動重連、閒置 `standbyIdleMs`（60 秒）後斷線。`result.durability` 帶每一座的結果與 `relaysFull`；每一座都被標成已滿時，耐久發布一則都不送，呼叫端的重試迴圈不會變成對中繼的風暴。
  - `pool.queryEach(filters, { relays })`：每一座各自回的事件，以及它是回完了（`eose`）還是不知道（`timeout`、`closed`…）。
  - 新子路徑 `@cinderous/client/durability`（5.4 KB minified、零 Node 內建模組）：`auditOwnEvents()`／`OwnEventAuditor` 逐座查回自己的可尋址事件（`#d`）與自己的收件匣（`ids`＋`#p` 自己），回報哪一座弄丟了什麼（抽樣、最久沒更新優先、速率限制；弄丟東西的那座會被標成已滿，耐久發布就會避開它）。**寄給別人的禮物包寄件人查不到**，只能靠收件人回報。NIP-65（kind 10002）與 NIP-17（kind 10050）工具建立與解析中繼清單（read／write 標記、備援事先列上），並決定私訊寄往哪裡；要不要發布由應用決定。
  - 整合：`DirectMessages`、`NostrVaultTransport`、`NostrRosterSync` 加選用的 `durability`；Vault 協調器把 `RelaysFullError` 轉成 `status().blocked = 'relays-full'`，只回報一次、最長退避（與 `relay-rejects-files` 相同）。`loadRelayFileLimits` 請傳實際寫入的那組——`pool.writeSet(1060)`——或用 `watchRelayFileLimits({ pool, onLimits })`，備援連上或某座被標成已滿時自動重算。
  ```typescript
  const result = await pool.publish(event, { durability: { minAccepted: 2, standby: ['wss://my-backup.example'] } });
  if (!result.durability!.satisfied) showWarning(result.durability!.relaysFull ? '中繼都滿了' : '副本不夠');

  import { OwnEventAuditor, relayListWithStandby } from '@cinderous/client/durability';
  const auditor = new OwnEventAuditor({ pool, self: identity.pubkey, sample: 64 });
  const report = await auditor.run(buckets.map((b) => ({ type: 'addressable', kind: 31438, pubkey: identity.pubkey, d: b.d, updatedAt: b.at })));
  if ('missing' in report) for (const { target } of report.missing) await republish(target);
  await pool.publish(identity.sign(relayListWithStandby(urls, ['wss://my-backup.example'])));  // 要公開才發布
  ```
- **共用 DO 的容量政策：每顆 DO 的天花板、保底份額、溢位帶、粗分級預警、丟棄計數**（v0.34，[ADR 0042](docs/adr/0042-relay-capacity-guarantee-borrowing-and-ceiling-config.md)；ADR 0038 P2、ADR 0039 B1、Cinderous ADR-0377 移植）。**全部預設關閉**：沒設新的環境變數時，中繼的每一則結果與庫存都與 v0.33 相同（以 v0.33.0 原樣的 store 對照測試）。
  - 天花板可設定（`DO_CEILINGS_MIB`，與 Cinderous 錨點逐字相同）：`<對象>=<離線 MiB>/<可尋址 MiB>`，對象是類別（`strict`／`public`／`lane`／`file`）或單顆 DO 名（`shard-a`、`app:dochost`…）。DO 記住自己的名字（storage `cinder:do-name`）。`computeCeilingBudget(vars)` 算出所有可能 DO 的最壞儲存加總（含溢位帶），部署者放進自己的測試守 Cloudflare 免費方案的 5 GB。
  - 保底份額（`DO_GUARANTEE_KIB`，只在淘汰制的車道生效）：每位作者（可尋址）／收件人（離線；沒有收件人的列以作者計）保底內的資料不會被別人擠掉；天花板滿了先淘汰超出保底的部分，沒有可淘汰的就回 `OK false "blocked: ceiling: …"`。
  - 溢位帶（`DO_BORROW_PERCENT`）：天花板之上再收這麼多的「借用」，保存 2 小時、永遠最先被淘汰，回 `OK true "warning: borrowed: 7200: …"`（客戶端算即時送達、不算耐久收下）。超出保底的新寫入只能借用、不擠別人；帶子滿了新的借用也不擠舊的；嚴格平面的可尋址（雲端快照）不借用。
  - 粗分級預警（`DO_NEAR_FULL_PERCENT`）：寫入後達那一級或 95％ 以上時 `OK true "warning: near-full: 80: …"`；`relayHealth()` 的 `nearFull` 記一個軟標記，不影響發布。
  - 丟棄計數（`DO_DROP_NOTICES`）：因 FIFO、天花板淘汰、借用到期刪掉寄給某人、**還沒送到**的留言時累計；收件人讀自己的收件匣時在 EOSE 前收到 `NOTICE "warning: dropped: <則數>: <since>: <until>: …"`，連線池以 `onRelayDropped({ url, count, since, until })` 回報，送出即歸零。只有數量與寄件時間範圍。
  - NIP-11 宣告靜態值：`cinder_ceiling_policy`（`evict`／`reject`）、`cinder_ceiling_bytes`、`cinder_guarantee_bytes`、`cinder_borrow_ttl_sec`／`cinder_borrow_percent`／`cinder_borrow_planes`、`cinder_near_full_percent`、`cinder_drop_notices`。一鍵部署（`RelaySiteOptions`）以 `doCeilings`、`doGuaranteeKib`、`doBorrowPercent`（≤ 50）、`doNearFullPercent`、`doDropNotices`、`storageBudgetBytes` 開放，只有 Cloudflare 版。
  - DO SQLite 相容遷移：兩個 `ADD COLUMN borrowed`（預設 0）、兩個只收借用列的部分索引、`inbox_drops` 表。Cinderous main 的 DB 升上來不出錯、重跑冪等；回滾到 v0.33／Cinderous main 的程式照常讀寫。
  ```typescript
  import { computeCeilingBudget } from '@cinderous/client/deploy';
  const budget = computeCeilingBudget(vars);   // wrangler.toml 的 [vars]
  expect(budget.ignored).toEqual([]);
  expect(budget.withinBudget).toBe(true);
  const pool = new RelayPool({ urls, onRelayDropped: ({ url, count }) => toast(`${url} 上有 ${count} 則遺失`) });
  ```
- **名單同步可用 NIP-59 禮物包外層，同一身分共用一個中繼事件預算**（v0.35，[ADR 0043](docs/adr/0043-roster-gift-wrap-outer-kind-and-relay-event-budget.md)）：
  - `NostrRosterSync({ …, outerKind: 1059 })` 以標準禮物包送名單（內層 kind 4361 不變），不收 kind 1060 的中繼（`blocked: files-disabled:`）也能同步。預設仍是 **1060**（CinderSync 相容）。同一份名單的每一台要用同一個值——1059 與 1060 的兩端互相收不到。滿載名單（32 台）包成 1059 是 109,769 bytes，遠低於單顆上限 262,144 bytes。
  - SDK 中繼以**認證身分**計數事件（每分鐘 120 則，ephemeral 也算），同一身分的中繼框、信令、名單、Vault 同步共用這個桶。`PeerNode` 中繼軌預設改為**每分鐘 100 框**（原本 200，會被中繼在 120 則處拒收）。沒有指定速率時，`PeerNode`、`NostrVaultTransport`、`NostrRosterSync` 共用 `sharedRelayEventBudget(pubkey)`；給中繼的 NIP-11（`relayInfo` 或 `applyRelayInfo(docs)`）就取 100 與 `cinder_max_events_per_minute` × 0.8 的較小者（與星狀會話的 `starRelayEventsPerMinute` 同一個函式）。收到 `rate-limited:` 就整個預算退避到計數窗結束、重送那一顆。Vault 同步在要求認證的中繼上改為分批送出（30 MB 每台約 7 分鐘），不再送到第 120 塊就失敗。私訊與直接 `pool.publish` 不經過預算（這就是留 20 則的原因）。
  ```typescript
  import { NostrRosterSync } from '@cinderous/client/pairing';
  import { sharedRelayEventBudget } from '@cinderous/client';
  const roster = new NostrRosterSync({ pool, signer: identity, membership, outerKind: 1059 });
  sharedRelayEventBudget(identity.pubkey).applyRelayInfo(nip11Docs); // PeerNode、Vault、名單同步一起調
  ```
- **中繼的 NIP-11 一說恢復就恢復**（v0.35.1，[ADR 0044](docs/adr/0044-revalidate-relay-health-on-nip11.md)）：以前中繼回 `blocked: files-disabled:` 之後，那座會被標成**不適用** 24 小時，站方打開檔案事件也一樣，帶 `durability` 的發布一直略過它。`pool.revalidateRelay(url, nip11)`（原始 NIP-11 或 `fetchRelayFilePolicy` 的結果）只清文件看得出已不成立的標記——`files-disabled` 而現在 `cinder_accepts_files: true`、`too-large` 而每個宣告的上限都已容得下那顆（檔案塊除外）、`not-allowed` 而 `restricted_writes: false`——並經 `onRelayHealthChange` 通知一次。`kind-disabled`、已滿、限速不動；讀文件之後才出現的標記不清。`watchRelayFileLimits` 改為每 30 分鐘重讀 NIP-11（`refreshMs`，`0`＝不重讀；每座每輪一個 GET，被標記的那座也讀）並重新驗證。`resetRelayHealth(url, { scope, state })` 可以只清一部分。沒有重讀時 24 小時照舊是上限；預設行為不變。
  ```typescript
  pool.revalidateRelay(url, await fetchRelayFilePolicy(url)); // 或交給 watchRelayFileLimits
  pool.resetRelayHealth(url, { scope: 'kind:1060' });
  ```
- **🔴 沒有任何中繼回完的查詢不再算「補拉完了」；排程同步需要的接口**（v0.36，[ADR 0045](docs/adr/0045-scheduled-sync-gaps-g12.md)）：`RelayPool.query()` 在一座都沒連上（或每座都逾時、查到一半斷線）時回空陣列，`forEachPage` 當成「翻完了」——於是 `NostrVaultTransport.backfill()` 把補拉起點推到**現在**、`FastHydrator` 呼叫 `setLastSyncAt(現在)`，更早的訊息永遠補不回來。新增 `pool.queryResult(filters)` 回 `{ events, answered, relays }`（`answered`＝回了 EOSE 的座數；`query()` 不變）。有了它，一座都沒回完的那一頁停下並回 `{ complete: false, unanswered: true }`；`backfill()` 與 `FastHydrator.resume()` 不推進游標、以 `RelayQueryIncompleteError` reject；`queryPaged()` 丟錯而不是回 `[]`；讀回稽核多 `verified`，`OwnEventAuditor` 不把沒查到的往後排、一座都沒連上的那一輪不佔速率限制。只有 `query()` 的自訂池照舊（`NostrVaultTransport` 退而看 `status()`）。另外（都要自己打開）：
  - `coordinator.whenSent({ timeoutMs })`：佇列清空、沒有在途的訊息（版本、摘要、索取）時回 `sent`；無法前進時回原因 `offline`、`paused`、`blocked`（帶原因）、`stopped`、`timeout`。
  - `digestPolicy: 'on-connect' | 'on-change' | 'manual'`（預設 `'on-connect'`，與以前相同），加上 `digestMinIntervalMs`／`digestMaxIntervalMs`（一天）：`'on-change'` 時沒有本機修改的一輪**一則事件都不發**；`resync()` 永遠照送。
  - `NostrRosterSync`：送不出去的名單記成 `pending`（`pendingStore` 跨重開）、`retryPending()` 重送、`retryOnReconnect: true` 在連線池回報某座 `open` 時自動重送（預設只記不送）。
  - `watchRelayFileLimits(...)` 的回傳值照舊可以直接呼叫（停止），另有 `refresh()`（現在就重讀 NIP-11，定期重讀重新起算）。
  ```typescript
  const watch = watchRelayFileLimits({ pool, onLimits: (l) => sync.setRelayLimits(l), refreshMs: 0 });
  await watch.refresh();                        // 一輪開始
  await transport.backfill().catch(() => 0);    // RelayQueryIncompleteError：起點不動
  await roster.retryPending().catch(() => false);
  await sync.idle();
  const { state } = await sync.whenSent({ timeoutMs: 15 * 60_000 }); // 'sent' | 'blocked' | …
  ```
- **Markdown 衝突就地以 callout 呈現**（v0.36，[ADR 0046](docs/adr/0046-markdown-conflict-callouts.md)）：每台都開 `conflictCallouts: true` 時，`.md` 檔同一行被兩邊改得不一樣不再產生衝突副本。只有衝突的那幾行換成一個摺疊的 Obsidian callout，裡面放**所有**版本——每段標示寫入裝置的名稱與 UTC 時間、依時間排序——其他部分照常合併：
  ```
  > [!conflict]- 同步衝突（2 個版本） %% cinder-conflict:3fa1c2d4e5b6 %%
  > **MacBook · 2026-10-01 10:32 UTC** %% cinder-version:1790850725000:mac %%
  > 我這樣改
  >
  > **iPhone · 2026-10-01 10:45 UTC** %% cinder-version:1790851500000:phone %%
  > 我那樣改
  >
  ```
  每台裝置的結果位元組相同：沒有相對字眼（「你這邊」）、時間用 UTC、裝置名稱取自版本本身、模式由**版本資料**決定（每個版本 id 裡的能力標記；所有版本頭都帶標記才用 callout），不看名單。舊版裝置照舊產生衝突副本，兩種合併靠既有的涵蓋規則收斂。其他文字檔、二進位、以及會破壞 callout 的內容（程式碼圍欄或 front matter 裡、緊鄰引言、未成對的圍欄／`%%`／`<!--`、換行混用、超過 16 個版本或 2,000 行）退回衝突副本；CRLF 檔維持 CRLF。已經是 callout 的地方再衝突時攤開併成一個（不巢狀）。`parseConflictCallouts(text)` 回每個 callout 的 `id`、`versions`（`label`、`device`、`at`、`lines`）與位置；`resolveConflictCallout(text, id, choice)`（版本索引、`'both-by-time'` 或 `{ text }`）回傳要寫回的新內容（就是一般的本機修改）。手動刪掉 callout 也算解決。預設關閉（與 v0.35 位元組相同）。
- **使用者自訂的同步排除範圍**（v0.37，[ADR 0047](docs/adr/0047-user-defined-sync-excludes.md)）：CinderSync 與 Cinder Coffice 共用的 gitignore 風格規則，兩層——**固定排除**（應用提供，使用者的 `!` 也不能把它們納入）＋**使用者清單**（預設 `DEFAULT_USER_EXCLUDES`：`.DS_Store`、`._*`、`Thumbs.db`、`ehthumbs.db`、`desktop.ini`、`~$*`（Office 鎖定檔）、`.~lock.*#`、`*.tmp`、`*.swp`、`*.swo`、`*.crdownload`）。語法：`*`、`?`、`[a-z]`／`[!a]`、`**/x`、`x/**`、`a/**/b`、結尾 `/` 只比對資料夾、開頭或中間有 `/` 從 Vault 根目錄算起、`!` 反向（上層資料夾被排除時無法再納入，同 git）、`\` 跳脫；路徑 NFC、預設不分大小寫。`validatePattern(line)` 給設定頁即時驗證（錯誤碼＋繁中訊息、`*` 之類給警告），`explain(path)` 告訴你是哪一條規則（哪一層）排除的。純函式、零 Node，`path-filter` 單獨打包 < 8 KB。
  協調器的 `excludes`／`setExcludes(filter)`：🔴 **排除不等於刪除**——已追蹤的檔案變成被排除時只是**停止追蹤**（不產生刪除版本，其他裝置照常保留；本機檔案不動）；收到別台對被排除路徑的版本會記進版本圖、但**不寫入**（對帳不會反覆索取，也不會出現 `pending`）；別台把檔案搬進本機排除的資料夾時，本機原路徑那一份**留著不刪**（`detached()` 的 `moved-out`）。從排除移除時重新掃描：停止追蹤的那一份以當時的版本為祖先，與期間別台的修改照常合併（兩邊沒改就什麼都不送），沒有紀錄的本機檔案當作新檔（別台同路徑同內容會收斂成一個），還沒有的遠端檔案寫進來。排除規則是每台自己的設定，各台可以不同。沒有設定 `excludes` 時與 v0.36 相同；`ignore` 不變。
  ```typescript
  import { compileSyncExcludes, DEFAULT_USER_EXCLUDES, literalPathPattern, validatePattern } from '@cinderous/client/sync/vault';
  const FIXED = [literalPathPattern(app.vault.configDir), '/.trash', '/.git', '/node_modules', '.*'];
  const excludes = () => compileSyncExcludes({ fixed: FIXED, user: settings.syncExcludes ?? DEFAULT_USER_EXCLUDES });
  const sync = new VaultSyncCoordinator({ adapter, store, transport, deviceId, excludes: excludes() });

  validatePattern('folder\\sub');   // { ok: false, error: { code: 'backslash', message: '路徑請用 / 分隔…' } }
  const draft = compileSyncExcludes({ fixed: FIXED, user: textarea.value });          // 設定頁即時預覽
  const hidden = (await adapter.list()).filter((f) => draft.isExcluded(f.path)).length;
  await sync.setExcludes(excludes());  // 儲存後：不刪任何檔案；sync.detached() 列出停止追蹤的檔案
  ```
- **衝突副本不再來回覆寫、空檔不產生衝突副本**（v0.37.1，[ADR 0048](docs/adr/0048-echoed-rename-misread-and-empty-file-conflicts.md)）：兩台配對前就有同路徑、內容不同的檔案時，協調器把輸的改名成衝突副本、把留下的寫回原路徑。v0.37.0 會把外掛送來的這次改名的回音（舊路徑已被留下者佔用）誤認成使用者改名，兩台輪流覆寫副本（有時一方的內容從 Vault 消失）。**每一台**都要升級，外掛不必改程式。新規則：路徑相撞或合不起來的並行修改中，若一方是 0 位元組，直接採用有內容的一方——不產生衝突副本、不放 callout、不發 `conflict` 事件（確定性、不遺失）。
- **設定檔驅動的中繼部署：`cinderous.config.json`、可攜的部署包、依選擇產生的部署說明**（v0.38，[ADR 0050](docs/adr/0050-deploy-configurator.md) P0）：所有部署選擇放在一份有版號的 JSON，附 JSON Schema（`schema/cinderous.config.schema.json`，也以 `@cinderous/client/config.schema.json` 匯出）：目標（`cloudflare`、`cloudflare-api`、`docker`、`fly`、`home-tunnel`＝家中主機＋Cloudflare Tunnel）、`site`（原樣是 `RelaySiteOptions`）、宿主選項，以及**只寫引用**的秘密（`{ "$env": "NAME" }`；看起來像 Token 的字串會被拒絕或提醒）。`cinderous relay build` 產生可攜的部署包——不寫絕對路徑：Workers 是 `wrangler.toml`＋以套件名稱 import 的 `src/entry.mjs`（或 `--self-contained` 附預打包的中繼）；Docker／Fly／home-tunnel 是建置內容（home-tunnel 是 relay＋`cloudflared`，relay 不發布埠）；SDK 公開前內嵌在 `sdk/`（或 `--sdk-spec <相依>`）——另外有依選擇組合的 `README-DEPLOY.md`（繁中）與 `README-DEPLOY.en.md`（憑證步驟取自 Cloudflare Token 指南資料、秘密、部署、健康檢查、回滾、升級、成本、安全檢查清單、授權）、`.env.example`、`.gitignore`、`LICENSE`、`SOURCE.md` 與清單 `.cinderous-generated`（重新產生時，被手改過的產生檔案沒加 `--force` 不會被覆寫）。`relay deploy --config` 以同一份選擇部署；舊的旗標照常可用，內部也改走同一條設定路徑（有差異測試）。`config validate` 一次列出所有問題。新的中立子路徑 `@cinderous/client/deploy/config`（零 Node 內建模組，給外掛與之後的網頁設定器）：`DeployConfig`、`DEPLOY_OPTION_SPECS`、`validateDeployConfig`、`renderDeployPackage`、`renderDeployGuide`；`collectRelaySiteIssues(opts, host)` 是 `relaySiteVars` 的收集式版本（同一份規則、同樣的訊息；`relaySiteVars` 行為完全不變）。產生的設定檔與膠水程式以 MIT-0 授權，SDK 本體仍是 AGPL-3.0-only。NIP-11 `software` 可以設定（`relaySoftwareUrl`／`RELAY_SOFTWARE_URL`／`--relay-software-url`；預設不變），改過中繼程式的人可以藉此履行 AGPL §13。行為變更：Cloudflare 目標給 `--persist`／`--port` 改為用法錯誤（原本默默忽略）。
  ```bash
  npx cinderous config validate                                   # 一次列出所有問題
  npx cinderous relay build --config cinderous.config.json --out deploy/
  npx cinderous relay deploy --config deploy/cinderous.config.json  # 秘密從環境變數或 deploy/.env 讀
  ```
  ```json
  {
    "configVersion": 1,
    "target": "home-tunnel",
    "name": "home-relay",
    "site": { "allowedPubkeys": ["npub1alice..."], "maxFileMb": 17 },
    "node": { "persist": true },
    "tunnel": { "hostname": "relay.example.com" },
    "secrets": { "tunnelToken": { "$env": "TUNNEL_TOKEN" } }
  }
  ```
- **IoT 遠端控制：共用協定 `@cinderous/client/iot` 與家中橋接器 `@cinderous/client/iot/bridge`**（v0.39，[ADR 0049](docs/adr/0049-iot-relay-modes.md) P0＝路線 A）：定位是「遠端低頻控制＋最新狀態」。家中橋接器連本地 MQTT broker（Tasmota、Zigbee2MQTT、Home Assistant…）與**任一** relay，在家做端到端加密，中繼只看到密文與盲化標籤。家庭秘密（32 bytes）以 HKDF 衍生 `homeKey`／`homePub`（所有 IoT 內容的 NIP-44 收件者，一則只加密一次）、`topicKey`（topic 以 HMAC 盲化成 22 字元）與 `homeTag`；固定測試向量在 `tests/iot/keys.test.ts`。kind：25170 操作、25171 ack、25172 即時狀態、25173 查詢（要求設備立刻回報）、31170 retained（以設備打包）、31171 閘道心跳。`IotClient`：`command()`（QoS 1 逾時以指數退避重送、每次重新簽章、同一個 msgId；`confirmed` 給標了 `confirm` 的 topic）、`query()`（閘道節流或逾時時以 retained 回覆）、`subscribeState()`（MQTT 樣式 `+`／`#`）、`getRetained()`／`listDevices()`（不打擾設備）、`watchGateway()`（心跳過期＝離線）、`myRole()`／`getAcl()`／`updateAcl()`；**只採信閘道簽的狀態類事件**，事件預算預設與同一身分共用 `sharedRelayEventBudget`。`IotGateway`（三條路線共用的一份）：依**簽章者公鑰**授權——viewer 可查詢、operator 可操作、owner 另可經保留 topic `$sys/acl` 改名單；可依設備（`light-*`）與 topic（MQTT 樣式）細分，topic 規則可設 `minRole` 與 `confirm`；名單**只以閘道本地為準**（不放進 ADR 0028 可合併的名單），不能移除最後一位 owner。時間窗與 msgId 去重（命中重送同樣的 ack）、NIP-40 指令存活（預設 30 秒，最多 300 秒）、不做中繼代發遺囑（設備自己的 LWT 以對照表轉成狀態）。mqtt.js 是**選用 peer 相依**（`npm install mqtt`；沒裝時錯誤訊息會告訴你），`./iot` 與主入口都不帶任何 MQTT 程式（守門測試）。命令列：`cinderous iot bridge --config iot-bridge.json`、`cinderous iot acl list|add|remove`（owner 用）、`cinderous iot keygen`、`cinderous iot build`（橋接器的 Docker 建置內容：Dockerfile、compose.yaml、.env.example、sdk/）。⚠ 自架 Node 中繼的嚴格平面每個作者每個 kind 只能有 5 個可尋址位址：名單佔 1 顆 31170，所以單一閘道在自架站上最多 4 台設備的 retained（官方錨點車道 16／64；放寬給閘道公鑰在 P1）。Docker 映像本機尚未實際建置過。
  ```bash
  npm install mqtt
  npx cinderous iot keygen > .env          # IOT_HOME_SECRET、IOT_GATEWAY_KEY（只印一次）
  npx cinderous iot bridge --config iot-bridge.json
  npx cinderous iot acl add npub1保母... --role viewer --devices cam-door,thermo --config iot-client.json
  ```
  ```json
  {
    "mqtt": { "url": "mqtt://localhost:1883", "username": "bridge", "password": { "$env": "MQTT_PASSWORD" } },
    "relays": ["wss://relay.example.com"],
    "acl": { "entries": [{ "npub": "npub1媽媽...", "role": "owner" }], "rules": [{ "topic": "home/door/#", "minRole": "owner", "confirm": true }] },
    "topicMap": [
      { "mqtt": "stat/plug1/+", "topic": "home/plug1/+", "device": "plug1", "dir": "up" },
      { "mqtt": "tele/plug1/LWT", "topic": "home/plug1/online", "device": "plug1", "dir": "up", "lwt": true },
      { "topic": "home/plug1/set", "mqtt": "cmnd/plug1/POWER", "device": "plug1", "dir": "down" }
    ],
    "queryMap": [{ "device": "plug1", "mqtt": "cmnd/plug1/STATUS", "payload": "11" }]
  }
  ```
  ```ts
  import { deriveIotHome, IotClient } from '@cinderous/client/iot';
  const iot = new IotClient({ pool, signer: identity, home: deriveIotHome(homeSecret), gateway: 'npub1閘道...' });
  const r = await iot.command('home/plug1/set', 'ON');          // { status: 'ok' | 'not-allowed' | 'timeout' | 'relay-rejected' | … }
  const q = await iot.query('plug1');                            // { status, state: { topics, ts }, fromRetained }
  iot.subscribeState('home/+/POWER', (m) => console.log(m.topic, m.payload));
  ```
- **個人專屬中繼的私人路徑模式：開放寫入＋不可猜的隨機路徑**（v0.41，[ADR 0051](docs/adr/0051-private-path-relay.md)，使用者裁示方案丁）。一鍵部署的個人中繼若強制白名單，新裝置無法只靠它配對；開放又因預設網址猜得到而會被濫用額度。內容本來就端對端加密，所以改成「網址就是門票」：
  - 中繼：`LANES_ONLY=1` 只接受 `APP_LANES` 上的車道（Cloudflare 與 Node 主機同一個環境變數、同一個 `routeForPath`）。主路徑、分片、沒列的車道一律以一般的「認不得的路徑」拒絕（NOTICE＋1008，連 `bad-lane` 都不回），NIP-11 回 404，都不透露有哪些車道；帳號儲存預算只算名單上的 DO。
  - 部署：`privateLane`（`generatePrivateLaneId()`：WebCrypto 產生 26 字 base32、130 位元）→ `APP_LANES`＝`FILE_LANES`＝它、`LANES_ONLY=1`，白名單改為選用（不必 `openFileRelay`）；`relayEndpoint` 是完整的 `wss://<host>/app/<id>`；重新部署沿用同一個 id（`privateLaneFromUrl`），換新 id 要 `allowLaneChange`。錯誤訊息與進度不回顯 id。
  - 設定器：`site.privateLane` 只能寫 `{ "$env": "NAME" }`；部署包不含秘密（Workers 用 `wrangler secret put`、Fly 用 `fly secrets set`、compose 從 `.env` 代入）。
  - 🔴 網址等同密碼：外洩＝任何人可寫（讀不到內容），補救是換一個 id 重新部署。
  ```ts
  import { deployCloudflareRelayViaApi, generatePrivateLaneId, privateLaneFromUrl, VAULT_SYNC_MAX_FILE_MB } from '@cinderous/client/deploy/cloudflare-api';
  const privateLane = privateLaneFromUrl(existingUrl ?? '') ?? generatePrivateLaneId();
  const { relayEndpoint } = await deployCloudflareRelayViaApi({ apiToken, fetch: http, privateLane, maxFileMb: VAULT_SYNC_MAX_FILE_MB });
  // relayEndpoint === `wss://cinderous-relay.<子網域>.workers.dev/app/${privateLane}`
  ```
- **換私人路徑不再讓其他裝置斷線：舊路徑唯讀寬限期＋名單加密的中繼搬家通知**（v0.42，[ADR 0052](docs/adr/0052-relay-move-read-only-grace.md)，CinderSync 缺口 G21）。原本換了私人路徑舊網址立刻失效，排程同步每幾小時才連一次的裝置只能手動貼新網址：
  - 中繼：`READONLY_LANES=<舊 id>@<到期 unix 秒>`（兩座宿主）。到期前舊路徑仍落在它自己的 DO、讀得到（REQ、AUTH），但每一則 `EVENT` 都回 `OK false "restricted: read-only: …"`（不提新網址、不含車道 id；新詞元 `read-only`）；NIP-11 宣告 `restricted_writes` 與 `cinder_read_only_until`。到期由中繼自己判斷，之後舊路徑就是一般的認不得的路徑（還開著的連線下一則就關）。舊 DO 的資料保留到那時。
  - 部署：`RelaySiteOptions.readOnlyLanes`；REST 一鍵部署的 `retireLane: { id, graceDays }`（1–30，預設 7），每次重新部署保留線上還沒到期的。設定器：`site.readOnlyLanes` 只寫 `$env`。
  - `./pairing`：`announceRelayMove()` 把「舊網址 → 新網址」（內層 kind 4363，與名單同一個封裝與訂閱）送給**目前有效**的每一位成員——被移除的裝置拿不到新網址。`NostrRosterSync({ onRelayMove })` 只交出名單成員寄的；`planRelayMoves()` 只**替換**清單裡已經有的網址、取最新而且新網址真的連得上的（`probeRelayEndpoint`：NIP-11 回 200、不是唯讀路徑）——部署失敗就沒有任何裝置切換。`isUnknownRelayPathMessage()` 讓應用知道舊中繼已失效。
  ```ts
  // 換路徑的那台：先通知（舊路徑還能寫）、再部署、部署後也通知新路徑
  const sent = await announceRelayMove({ membership, signer, move: { from: oldUrl, to: newUrl }, relays: allRelays, connect });
  if (sent.accepted.length === 0) throw new Error('通知不到其他裝置');
  await deployCloudflareRelayViaApi({ apiToken, fetch: http, privateLane: newLane, allowLaneChange: true, retireLane: { id: oldLane, graceDays: 7 }, maxFileMb: VAULT_SYNC_MAX_FILE_MB });
  // 其他裝置：new NostrRosterSync({ ..., onRelayMove: (m) => moves.push(m) })，每一輪
  const plan = await planRelayMoves({ primary, standby, moves, probe: (url) => probeRelayEndpoint(url, http) });
  ```
- **CinderSync 的 SDK 缺口：進度、接收狀態、只讀中繼、副本檔名、部署雙語**（v0.43，[ADR 0053](docs/adr/0053-cindersync-coordinator-gaps-g13-g18.md)、[0054](docs/adr/0054-read-only-relays.md)、[0055](docs/adr/0055-deploy-progress-substeps-and-bilingual-checks.md)，CinderSync 缺口 G11、G13–G18、G20）。預設行為不變，除了佇列清空後 `blocked` 會消失：
  - 協調器：送出佇列清空（例如全部經直連送完）時清掉 `blocked`／送出失敗，下一則經中繼的照常驗證；`retryPeers(device?)` 重設 P2P 退避；`setRelayBulkPerHour(n)` 執行中改中繼補送速率（0＝暫停，只走直連）。
  - 直連進度：`transfers()`、`on('progress')`（每筆傳輸的檔案數、位元組、正在傳的檔案；預設最多每 250 ms 一次，開始與結束一定通知）、`status().p2pBytes`；串流層 `StreamHandler.onProgress`／`onSessionEnd`。
  - 各裝置的接收狀態：`peerStatus(device)`（`lastSeenAt`、`reportedAt`、`missing`、`known`）、`peerStatuses()`、`knownHeads(device)`、`notePeerActivity()`；直連批次的送達確認也記成對方已知的版本頭；`NostrRosterSync({ onMemberActivity })`。**不為回報多送任何訊息**；更即時的「已收到」回報使用者裁示 B0、不做（ADR 0053 §G17(b)）。
  - `parseConflictCopyName(path)`、`freePathCandidate(path, n)`（`./sync`）：衝突副本檔名與編號同一處維護。
  - `RelayPool({ readUrls })`：只訂閱、不寫入的中繼（常駐連線、退避重連；只有 `durability.standby` 需要時才補發、沿用同一條連線；`queryResult` 也查但 `answered` 只算主中繼）。名單共享備援清單（G11 第 1 部分）v0.45 以「使用者確認的建議」實作（[ADR 0056](docs/adr/0056-roster-shared-relay-list.md)，見下）。
  - REST 部署：進度帶 `substep` 與 `messages: { 'zh-TW', en }`；`checkRelayName`、`collectCloudflareApiDeployIssues` 一次列出雙語問題。
  ```ts
  const pool = new RelayPool({ urls: primary, readUrls: standby, identity });
  sync.on('progress', (p) => bar.set(p.device, p.bytes.done, p.bytes.total, p.current?.path));
  const { missing, lastSeenAt } = sync.peerStatus(deviceId);
  if (directChannelOpen) sync.setRelayBulkPerHour(0); else sync.setRelayBulkPerHour(120);
  ```
- **`writeStream` 的來源帶內容的 SHA-256**（v0.44，[ADR 0057](docs/adr/0057-write-stream-source-sha256.md)，CinderSync 缺口 G22）：協調器交給 `VaultAdapter.writeStream` 的 `VaultContentSource` 多了 `sha256`（64 字元小寫 hex，與 `VaultVersion.hash`、`StreamEntry.sha256` 同名同格式），值是版本的 `node.hash`，P2P 串流收完時已以它校驗過整個內容。轉接器可以寫暫存檔時邊寫邊算、取代目的地前比對；不符就回 `false`，協調器之後重新讀取。型別上是選配（相容自己建立的來源）；預設行為不變。另修正：`retryPeers(device)` 也開（或沿用）到那台的通道並掛上收方——只等著收大檔的這台探測打通後呼叫，對方送來的收得到；`readUrls` 的中繼開始補發（進入寫入集合）時也發健康狀態通知，`watchRelayFileLimits` 跟著重算；原檔沒有副檔名、裝置名稱含點的衝突副本（`README (衝突-Joe.Mac-…)`）`parseConflictCopyName` 拆不回來。
- **備援中繼清單經名單共享——只是建議**（v0.45，[ADR 0056](docs/adr/0056-roster-shared-relay-list.md)，使用者裁示「甲」，CinderSync 缺口 G11 第 1 部分）：每台在名單上自己簽一份備援清單（`membership.declareStandby(urls)`；與 `caps` 並列的 `standby` 欄位，舊版略過）。收方只得到**建議新增**：`StandbySuggestions`（或純函式 `planStandbyAdoption`）列出其他有效成員宣告、這台沒有的備援——不會建議移除、不碰主清單——只限公開的 `wss://`（不帶帳密，不是本機／私有／保留網段或區網網域，≤ 200 字，每台最多 4 座），新網址自動測試（`probe`，例如 `probeRelayEndpoint`），被忽略的記住。**要不要加入由應用在使用者確認後決定。** 配對的歡迎訊息也帶邀請方的備援清單作為建議（`PairingResult.standby`）。
  ```ts
  membership.declareStandby(settings.standbyRelayUrls);
  const suggestions = new StandbySuggestions({ probe: (url) => probeRelayEndpoint(url, fetch), ignored: loadIgnored() });
  membership.onChange(() => suggestions.update({ own: [...relays, ...standby], declared: membership.declaredStandbys(), isMember: (pk) => membership.isMember(pk) }));
  suggestions.onChange(() => render(suggestions.list())); // { url, sources, probe: 'pending' | 'reachable' | 'unreachable' }
  ```
- **輕量成員：知道整個 Vault、只保存部分內容**（v0.46，[ADR 0058](docs/adr/0058-sparse-vault-members.md)，使用者 2026-10-05 裁示）。裝置（例如手機 App）仍是 Vault 的完整成員（握有全部金鑰），但設定內容範圍：`new VaultSyncCoordinator({ ..., scope: { content: ['Daily/', 'Inbox/'], create: ['Daily/', 'Inbox/'], cacheBytes } })`（排除清單的語法、`{ includes }` 或函式；執行中 `setScope()`，`null`＝完整成員）。範圍外的**只收版本資訊**——不合併、不寫磁碟、**不保存內容**——所以 `remoteIndex()`／`lookup(path)` 列得出整棵樹（路徑、大小、雜湊、時間、是否刪除、是否在本機、釘選、快取），摘要與 `peerStatus` 照樣一致。按需取得：`fetch(path, { timeoutMs })`（`want` 帶 `fetch: true`、不裁剪，寫進磁碟並成為快取）、`pin`／`unpin`、LRU 快取（`cacheBytes`，預設 200 MiB），以及 `evict(path)`：清掉本機那一份、**不產生刪除版本**——也修掉 ADR 0047 滾動視窗的風險（應用刪掉被排除的副本，重新納入時變成刪除）。在內容不在這台的檔案路徑上新建檔案不產生版本（`VaultScopeError('base-missing')`），`scope.create`／`canCreate()` 限制可以新增的資料夾。成員在名單上宣告自己的範圍（`membership.declareSparse(patterns)`、`scopeOf`、`sparseMembers`、`fullMembers`；自簽的新欄位，舊版略過），完整成員據此**依收件人裁剪**（`sync.setPeerScopes(sparsePeerScopes(membership))`）：範圍外的版本經中繼（`VaultSendOptions` 的 `to`／`omitContentFor`，要有 `deviceOf`）、直連、初次補送都不帶內容，只有版本資訊的合成 `nodes` 訊息——輕量成員加入 5,000 檔的 Vault 收到 84 則／1.6 MB，而不是 5,000 則／8.0 MB。輕量成員不是內容來源；完整成員在排程模式兩輪之間可以只跑 `VaultWantResponder` 回應索取。這台寫的內容等完整成員確認收到才清；晚到的內容會收下；重開後重新要還在等的內容。**清掉本機副本時會告訴應用原因**（v0.46.1，[ADR 0060](docs/adr/0060-evict-reason-on-host-removal.md)，CinderSync G23）：交給 `applyRemote` 的 `remove` 帶 `evict: 'scope' | 'lru' | 'evict'`（與 `evicted` 事件的值相同），沒有 `applyRemote` 時轉接器收到 `remove(path, expect, { evict })`——應用可以直接刪檔，不必備份或移到垃圾桶。真正的刪除不變（沒有 `evict` 欄位、只有兩個參數）。
  ```ts
  membership.declareSparse(['Daily/', 'Inbox/']);
  const sync = new VaultSyncCoordinator({ adapter, store, transport, deviceId, scope: { content: ['Daily/', 'Inbox/'], create: ['Daily/', 'Inbox/'] } });
  const tree = sync.remoteIndex();                       // 整個 Vault（有沒有內容都列）
  const bytes = await sync.fetch('Projects/plan.md');   // 打開範圍外的筆記
  await sync.evict('Projects/plan.md');                  // 「從這台移除」——不是刪除
  // applyRemote：change.type === 'remove' && change.evict → 直接刪，不備份、不進垃圾桶（v0.46.1）
  // 完整成員（CinderSync）：sync.setPeerScopes(sparsePeerScopes(membership))；傳輸層要給 deviceOf
  ```
- **Markdown 合併規則：兩台各自新建的同路徑檔案合併成一個；任務勾選框自動合併**（v0.46，[ADR 0059](docs/adr/0059-markdown-merge-rules-same-path-creation-and-task-checkboxes.md)，使用者裁示 5、7）。兩台各自建立同一個路徑（今天的 daily note）不再產生衝突副本：較晚的檔案收進較早的，兩份**以空檔為共同祖先**三方合併（祖先精簡成兩邊共同的行：範本只出現一次，只有同一處各自新增的才衝突——放進 callout，沒開 callout 就是衝突副本）；磁碟上那一份直接交接，不先刪再寫。衝突區塊只差在任務勾選（`- [ ]`／`- [x]`，含 Tasks 的 `✅ YYYY-MM-DD`）時自動合併——**已勾的贏**（與順序無關、不需要逐行的時間）。兩者都會改變合併結果，所以只在**所有**版本頭的 id 都帶新的標記時才用（同 ADR 0046 的 callout）；名單上**所有**成員都宣告 `MERGE_RULES_CAPABILITY`（`membership.allDeclare(...)`）後再以 `mergeRules: true`／`setMergeRules()` 打開標記。預設關閉。`./sync` 的純函式：`merge3(base, a, b, { resolve })`、`resolveTaskCheckboxConflict`、`commonLinesBase`。
- **版本歷史只在 client 端：本機歸檔、還原、整個 Vault 回到時間點、檢查點**（v0.49，[ADR 0063](docs/adr/0063-client-side-version-history.md)，使用者 2026-10-08 裁示）。**中繼與線上格式不變**：歷史只在這台的狀態儲存裡、不同步、不離開裝置。協調器把每個版本（本機產生的與收到的）歸檔，和同步用的版本圖分開（版本圖照舊修剪，歸檔不受影響）：文字檔內容以雜湊去重（`hc:`），**二進位檔只記版本資訊、不存內容**（內容和現在相同才算可還原）；排除範圍不歸檔，清掉本機副本（evict）不算刪除。選項 `history: { enabled, keepDays: 30, maxVersionsPerFile: 100, maxBytes: 1 GiB, dayBoundary: 'local' }`，完整成員預設開、**輕量成員預設關**；稀疏化：1 小時內全留、1 天內每小時一版、之後每天（當地日期）一版。`history(path)`（含已刪除、跟著改名）、`readHistory(versionId)`、`restore(path, versionId)`（舊內容當成**新的本機修改**、以目前版本頭為父，照常同步，不改寫歷史；已刪除的檔案以同一個身分復活）、`deletedFiles({ since })`、`clearHistory()`。整個 Vault：`vaultAt(T)`、`planRestoreVault(T, { paths, removeCreatedAfter })`（只預覽：改回、復原、T 之後建立的、無法還原的）與 `restoreVault(plan)`（逐檔以新版本執行，跳過的回報、不中途丟出）。參考 git：**檢查點**（整個 Vault 的清單，差異鏈保存，同步告一段落時最多每小時自動一個）、`restoreVault` 先建「還原之前」的檢查點並記**操作紀錄**（`operations()`，復原＝還原到它）、**命名檢查點**（`checkpoint({ name })`，最多 50 個，內容不受保留天數與容量限制）；時間點優先從檢查點推算（`source: 'checkpoint' | 'reconstructed'`、`mixed`），也可以直接 `planRestoreVault({ checkpoint: id })`。要覆寫或刪掉的現有內容不在歸檔就不做（所以 T 之後建立的二進位檔不刪）。
  ```ts
  const versions = await sync.history('notes/a.md');           // 新到舊（v0.50 起非同步）
  await sync.restore('notes/a.md', versions[3]);                // 新的本機修改，照常同步；給整筆（或版本 id）
  const plan = await sync.planRestoreVault(yesterday9am, { paths: ['Projects/'] });
  await sync.restoreVault(plan);
  const [op] = sync.operations();                               // 復原這次還原（檢查點過期後 undoAvailable 是 false）
  if (op.undoAvailable) await sync.restoreVault(await sync.planRestoreVault({ checkpoint: op.before!, removeCreatedAfter: true }));
  await sync.checkpoint({ name: '交稿前' });
  ```
- **版本歷史 v0.50：用到時才載入、可選擇刪除 T 之後建立的二進位檔、還原前的檢查點跟著保留天數**（v0.50，[ADR 0063](docs/adr/0063-client-side-version-history.md)〈使用者裁示（2026-10-08，〈待決〉三題）〉與〈實作（v0.50）〉）。**狀態儲存的格式改了、啟動時自動遷移一次**；線上格式與中繼不變。
  - **用到時才載入**：啟動時只讀每個檔案的摘要（`hs:` 分成 256 個分片：版本數、最新／最舊時間、佔用、有沒有刪除、最新的一版與用過的路徑），`historyStatus()`、`deletedFiles()` 照樣同步可用；完整的版本紀錄（`ha:<fileId>`，格式不變）在 `history()`／`readHistory()` 第一次用到時才讀、放進 LRU 快取（最多 256 個檔案或 2 萬版）；整庫的 `vaultAt`／`planRestoreVault`、稀疏化、容量整理逐檔讀寫（摘要夠用的檔案不讀）。歸檔內容 `hc:<雜湊>` 改成「參照的檔案＋內容」，不再需要啟動時把所有版本讀進來算參照數。實測 2 萬個檔案 × 50 版：啟動從 4–10 秒、堆積 +392 MiB 降到 0.15–0.5 秒、+11 MiB（`scripts/bench-history.mjs`）。
  - **API 改為非同步（breaking）**：`history()`、`vaultAt()`、`planRestoreVault()` 回 Promise；`readHistory`／`restore` 也接受 `{ fileId, versionId }`（例如 `history()` 回來的那一筆，最快）。
  - **T 之後建立的二進位檔**：`planRestoreVault(T, { removeCreatedAfter: true, removeCreatedBinaries: true })` 把它們列入刪除、標 `irreversible: true`（歸檔沒有內容，復原這次還原也救不回來），`irreversibleBytes` 是總大小；`restoreVault(plan, { beforeIrreversible })` 在每個正要刪之前呼叫，讓應用備份，丟錯或回 false 就不刪（`backup-failed`）。
  - **還原前的檢查點跟著 `keepDays` 過期**：操作紀錄照留，`undoAvailable: false`、`undoUnavailable: 'before-expired'`（被刪是 `before-deleted`、被容量清掉是 `before-evicted`、單一檔案的還原是 `no-checkpoint`）；再拿它復原丟 `VaultHistoryError('checkpoint-expired')`。
- **收不齊的檔案塊不再堆積**（v0.60，[ADR 0084](docs/adr/0084-whole-inbox-backfill-on-start.md)、[ADR 0085](docs/adr/0085-batch-evict-file-chunks.md)）。客戶端：每個傳輸層（每次啟動）在至少一座中繼宣告收件確認時，先不帶 `since` 讀一次整個收件匣，讓一直從上次同步時間續讀的裝置也會確認永遠收不齊的訊框（ADR 0081）；之後照舊用 `since`。中繼：中繼自己淘汰檔案塊時（每收件人上限、天花板、保底份額外、借用列 2 小時到期）**整批一起刪**——同收件人、kind 1060、同一個 `expiration` 標籤——不再留下一則訊息剩下的部分；一起刪的也計入丟棄計數。不加任何元資料、不需要更新客戶端；SQLite 版新增可為 NULL 的 `batch` 欄與部分索引（舊版寫入的列是 NULL，照舊逐列淘汰）。已知取捨：同一秒送給同一人的另一則可能被一起刪。
- **收件確認後提早過期**（v0.51，[ADR 0067](docs/adr/0067-inbox-ack-early-expiry.md)）：收件裝置處理完、狀態存好一則同步訊息後，以瞬時 kind 25190 告訴中繼「這幾顆包我收好了」，中繼把**寄給它一人**的那幾列降為「現在＋2 小時」到期（比照未註冊應用的保存期），不存、不轉發確認本身。14 天模擬：中繼平均佔用 243.6 → 11.1 MB、重複下載 86% → 40%。
- **裝置改名**（v0.52，[ADR 0069](docs/adr/0069-roster-device-rename.md)）：裝置帶時間在名單上重新簽自己的名稱（`membership.declareLabel(name)`，與 `caps`／`standby`／`sparse` 並列、自己簽的 `labels` 欄位；較晚的蓋過，舊版略過、照舊顯示配對時的名稱）。`devices()`、`selfDevice`、`declaredStandbys()`、`sparseMembers()` 回目前的名稱；配對時簽的那一筆不動。配對的歡迎訊息只帶邀請方自己的改名，其他的隨下一次名單同步補上。`sync.setDeviceLabel(name)` 在執行中換掉協調器的名稱（之後的版本與衝突副本用新名稱，已經產生的不變）。
  ```ts
  membership.declareLabel(settings.deviceName); // 啟動與改名時呼叫；沒變回 false
  sync.setDeviceLabel(settings.deviceName);
  ```
  ```
- **把檔案搬進這台排除的範圍不是刪除**（v0.53，[ADR 0071](docs/adr/0071-move-into-excluded-is-not-delete.md)）：改名的新路徑被 `excludes`（不是 `ignore`）排除時，只停止追蹤、不刪除——其他裝置照常保留，它們之後的修改也不寫回這台的原路徑。移除規則、或把檔案搬回同步範圍時，以停止追蹤時的版本為父送出改名，與期間別台的修改合併。把垃圾桶資料夾放進 `excludes` 的應用，移到垃圾桶要通知**刪除**。只看即時的改名事件；應用關著時搬的照舊看起來是刪除。
- **整庫還原的預覽列出會留著的檔案**（v0.53，[ADR 0070](docs/adr/0070-restore-plan-keep-list.md)）：沒打開 `removeCreatedAfter` 時，`planRestoreVault` 回傳 `keep`——T 之後建立、這次留著的檔案（只給預覽顯示，`restoreVault` 不看）。
  ```ts
  const plan = await sync.planRestoreVault(T);
  render(plan.revert, plan.undelete, plan.keep ?? []); // keep：之後建立、留著的
  ```
- **中繼預算按收件人記帳、以加密簽收單扣帳**（v0.54，[ADR 0068](docs/adr/0068-per-recipient-relay-budget-with-encrypted-receipts.md)）：每則經中繼的同步訊息帶寄件人自己的序號（`rs`）；收件裝置處理完、存好之後回一份很小的加密簽收單（`receipt`，序號區間，只送給那位寄件人——中繼只看到又一顆包）。寄件端每位收件人一本帳（`relay-ledger.ts`）：收到簽收單就劃掉那一台的份，沒有簽收的照舊過了保存期才劃掉。批次模式下某一台的帳滿了只排除它（`to`），版本記成還欠它，其他台照送。簽收單也告訴寄件端那台已經有哪些版本，`peerStatus(device).missing` 不必等它的摘要。要有 `transport.recipients()`（`NostrVaultTransport` 給了 `deviceOf`）；沒有就照舊一本帳。舊版裝置不簽收，送給它的帳只會過期。`status.relayQuota.devices` 每位收件人一列（最滿的在前）。不需要中繼支援。
  ```ts
  await sync.flushReceipts(); // 排程同步：斷線前先送出累積的簽收單
  new VaultSyncCoordinator({ ..., receipts: false }); // 像舊版一樣不簽收
  ```
- **自動檢查點可以由應用決定時機**（v0.55，[ADR 0072](docs/adr/0072-app-driven-auto-checkpoints.md)）：`autoCheckpoint: 'app'` 時協調器不再在同步告一段落時自己建；應用在自己的同步點呼叫 `checkpoint({ auto: true, minIntervalMs })`——離上一個自動檢查點不滿 `minIntervalMs`、或沒有變動（不佔掉這一段）時回 `null`。預設（`'idle'`，告一段落、最多每小時）不變，只是沒建出來的那一次嘗試不再擋住接下來一整個小時。
  ```ts
  // CinderSync：每一輪同步完成後、每個同步頻率最多一個
  await sync.checkpoint({ auto: true, minIntervalMs: intervalMs - 5 * 60_000 });
  - 中繼：NIP-11 宣告 `cinder_inbox_ack: { kind, grace_sec }`；只在 AUTH 身分＝簽章者時處理、只提早不延後。唯讀寬限期的路徑、Node 版 `REQUIRE_AUTH=0` 不宣告也不處理。**要重新部署才生效**；沒升級的中繼照舊放滿保存期。
  - 客戶端：`createNostrVaultTransport` 預設開（`inboxAck: false` 關）、只送給 `inboxAckRelays`／`setInboxAckRelays` 列的中繼：在 `watchRelayFileLimits` 的 `onLimits`（第三個參數 `policies`）裡 `transport.setInboxAckRelays(inboxAckRelays(policies))`。寄件人不在信任名單、沒收齊、沒存好的不確認。
  - 其他：`onMessage` 監聽者可回傳 Promise（完成＝處理完而且已保存）；`RelayPool.publish(e, { relays })` 只送給指定的幾座。線上格式、名單不變；不需要各台同時升級。
- **IoT 即時通道的 relay 端（路線 C′ R1）**（v0.59，[ADR 0049](docs/adr/0049-iot-relay-modes.md) §9–§10）：設備常駐一條 `wss` 連到 relay，命令一來立刻推下去（門、車庫門）。**只給自架、沒設定就不開。** 這條路線上 relay 就是閘道：持有閘道簽章金鑰與設備權杖雜湊，**從不持有家庭秘密與設備金鑰**——指令與狀態裝在 AES-256-GCM 設備信封裡（§2.6，`./iot` 的 `sealIotEnvelope`／`openIotEnvelope`；AAD 綁方向、kid、計數器與時間；兩個方向的 nonce 空間不相交；測試向量以 Node crypto 交叉驗證）。手機送 `dev-cmd`（需 operator）／`dev-query`／`dev-link`，外層加密給閘道；relay 依簽章者在這台設備的角色授權（設備可設 `minRole`，例如門鎖要 owner；有 topic 限制的名單項目一律拒絕，因為 relay 看不到 topic）、檢查金鑰版本（含寬限期）與信封時間，然後推幀，或立刻回 `offline`／`stale`（即時等級不排隊）。設備的 ack 以 25171 回給正在等這台設備的成員；狀態走 25172，retained 31170 每台至少隔 5 分鐘寫一次。端點 `/iot/v1/home/<homeTag>`（手機，Nostr）與 `/iot/v1/dev/<homeTag>/<blindId>`（設備，`Authorization: Bearer cit1_…`；一台只留一條連線，新的以 4409 關掉舊的）；Workers 上心跳 `{"t":"hb"}` 由平台自動回覆（`setWebSocketAutoResponse`，不計費）。每個家庭的每日預算（§10.3）：80% 通知 owner（`$sys/quota`）、95% 丟遙測、100% 以 4429 `iot-quota:<重置時間>` 關掉所有連線，新升級回 `503`＋`Retry-After`＋`Cinder-Quota`；Durable Object 超量的錯誤也轉成同樣的結構化 503。Workers：DO 類別 `IotHomeRoom`、綁定 `IOT_HOME`；Node：同一份核心，升級前就驗。環境變數：`IOT_REALTIME`（JSON）、`IOT_GATEWAY_KEYS`（secret）、`IOT_HOME_DAILY_REQUESTS`、選配 `IOT_UPGRADE_LIMIT`。還沒做：手機端 API（`urgency`、`deviceLink()`、`unknown → query`）、`./iot/device`、NIP-11 與 CLI／設定器接線（R2）；尚未部署到 Cloudflare，也還沒接過真的 ESP32／Tasmota 設備。
- **IoT 推播：App 關著也收得到警報**（v0.40，[ADR 0049](docs/adr/0049-iot-relay-modes.md) §11.1，沿用 Cinderous ADR-0272 與 SDK ADR 0011 §6）。使用者裁示的模型：**client 自帶推播端點、FCM／APNs 憑證只在 App 開發者的推播閘道、誰知道端點誰就送**。喚醒請求**一律是空的**——不含設備、內容、類別；App 醒來後自己連中繼讀 retained，在本機判斷要不要通知。
  - `./iot`（中立）：兩種端點地位相同——`unifiedpush`（UnifiedPush／ntfy 網址；送出端直接 POST 一則沒有內容的推播，RFC 8030）與 `gateway`（推播閘道網址＋以 `sealIotPushToken` 封給推播閘道公鑰的 FCM／APNs token＋「每次登記獨有密鑰」；送出端看不到 token，每次喚醒以 HMAC 簽「嚴格遞增的時間戳」）。訂閱＝盲化設備 id＋每個訂閱的 `mode`：`standard`（預設；60 秒合併＋0–30 秒抖動）或 `instant`（不合併、0–2 秒抖動、每端點每分鐘最多 6 次——同意畫面要寫明 Google／Apple 看得到精確時間點）。額度預警是特殊項目，只有 owner 能訂閱。登記以加密指令送到保留 topic `$sys/push`（端點本身再以 NIP-44 加密給送出端，其他家人讀不到）。`IotClient.registerPush()`／`updatePush()`／`revokePush()`；排程器 `IotPushScheduler`（時鐘、亂數、計時器可注入）；上限 `IOT_PUSH_LIMITS`（每家 32 端點、標準 1／分、即時 6／分、TTL 30 天，都可設定）。
  - `IotGateway`（路線 A 由閘道送）：`push: { store, send, limits }`——收任何有效成員的 `$sys/push`、保存帶 TTL 的端點清單、設備狀態**有變化**時喚醒訂閱者（iOS 的 `ref`＝25172 事件 id）、`notifyPushSpecial('quota')`、owner 撤銷成員時一併清掉他的端點、回 404／410 的端點自動刪除。家中橋接器在 `iot-bridge.json` 加 `push` 段就開（`fileIotPushStore`、`--push-file`）。
  - **參考推播閘道** `@cinderous/client/iot/push-gateway`（中立核心）＋`./worker`（Workers 版：Android 走 FCM HTTP v1，服務帳號 RS256 JWT 以 WebCrypto 簽；防重放、撤銷、上限的狀態每個 token 一顆 Durable Object）＋`./node`（Node 版：FCM 相同）。**兩版的 iOS 都直連 APNs**（`PUSH_IOS=apns`，ES256 provider token，不經 Google）：APNs 的請求、provider token 與回應對照共用，只有傳輸不同——Workers 版用 `fetch()`（`fetchApnsTransport`；Cloudflare 邊緣代為與 APNs 講 HTTP/2，ADR 0049 §11 實測；本機 `wrangler dev` 連不上 APNs），Node 版用 `node:http2`。v0.47 起（[ADR 0061](docs/adr/0061-workers-push-gateway-direct-apns.md)）；**v0.48 起沒寫 `PUSH_IOS` 就是 `apns`**（[ADR 0062](docs/adr/0062-push-gateway-ios-default-apns.md)，breaking）。只要 Android 設 `PUSH_IOS=off`（不需要 Apple 金鑰）；明寫 `PUSH_IOS=fcm`（iOS 經 FCM，Google 也看得到 iOS 的喚醒時間點）仍可用，但**兩版都已棄用**；從 `fcm` 改成 `apns` 沒有過渡期（舊的 iOS FCM 登記回 501，要等 App 重新登記）。APNs 回錯誤時日誌帶白名單內的 `apnsReason`（例如 `BadEnvironmentKeyInToken`＝金鑰限定的環境與 `APNS_ENV` 不符），回應不帶。provider token 快取 50 分鐘（Apple 要求 20–60 分鐘）、同時送出只簽一次、`403 ExpiredProviderToken` 重簽一次；`Unregistered`／`BadDeviceToken`／`DeviceTokenNotForTopic` 讓送出端刪掉端點。解封 token、常數時間驗 HMAC、時間窗＋同一登記嚴格遞增、過期與撤銷拒絕、每 token 上限（預設 60／時、6／分）。Android＝FCM 高優先**空**資料訊息；iOS＝一般推播＋`mutable-content`，payload 只有在地化鍵與給 Notification Service Extension 的不透明事件 id（兩者都經 `assertContentlessPushPayload` 守門）。憑證只從環境變數／Worker secret 讀，不會出現在回應、錯誤或日誌（有測試）。
  - 部署設定器：`cinderous.config.json` 寫 `service: "push-gateway"`（Workers 目標＝Workers 版，docker／fly／home-tunnel＝Node 版；兩版都可設 `pushGateway.ios: "apns"`＋`apnsTopic`／`apnsKeyId`／`apnsTeamId`／`apnsEnvironment` 與 `secrets.apnsKey`——Workers 版的說明以 `wrangler secret put APNS_KEY < AuthKey_….p8` 直接導入 .p8；v0.48 起沒寫 `ios` 就是 `"apns"`、缺 APNs 欄位的錯誤寫明預設值與三種改法；`ios: "off"` 只送 Android；`ios: "fcm"` 兩版都給 `push-ios-fcm-deprecated` 警告）；上限是 `DEPLOY_OPTION_SPECS` 的項目（`pushGateway.tokenPerHour`、`tokenPerMinute`、`maxSkewSec`、`maxRegistrationDays`）；`relay build` 產出部署包與中英 `README-DEPLOY.md`（Firebase 服務帳號與 APNs 金鑰的設定步驟、隱私說明）。`cinderous iot push-keygen` 產生推播閘道私鑰。
  - 設備端：`examples/iot-device/` 的規格與零相依 Node 參考實作（MIT-0），與 SDK 逐位元組相容（附測試向量）。這一版不做：中繼（家庭 DO）當送出端（等 C′，介面已預留）、ESP32／Tasmota 韌體、App 自己的 FCM／APNs 註冊與 NSE。
  ```ts
  import { sealIotPushToken } from '@cinderous/client/iot';
  const info = await (await fetch('https://push.example.com/v1/info')).json();
  const { sealed, key } = sealIotPushToken(info.pubkey, { platform: 'android', token: fcmToken });
  await iot.registerPush({ type: 'gateway', url: 'https://push.example.com', sealed, key }, [{ device: 'front-door', mode: 'instant' }, { device: 'thermo' }]);
  await iot.registerPush({ type: 'unifiedpush', url: upEndpoint }, [{ device: 'front-door' }]);   // UnifiedPush：不需要推播閘道
  ```
- **重新連上之後不再漏收禮物包**（v0.30，[ADR 0035](docs/adr/0035-backdated-resubscribe-capabilities-and-identical-collisions.md)）：以前連線恢復時，`RelayPool` 以「看過最新的 `created_at`」當 `since` 補訂閱；但 NIP-59 會把每一顆禮物包的外層時間隨機往前推最多兩天，而中繼對**即時**轉發也套用 `since`——所以第一次重連之後，別人寄來的 NIP-17 私訊（kind 1059）、Vault 同步／名單訊息（kind 1060）、通話／SDP 信令大多被靜默丟掉，直到下一次重連。現在可能帶著被回溯時間的 filter（kinds 含 1059 或 1060，或任何 `#p` 收件匣類）從游標**再往前退兩天**（`NIP59_MAX_BACKDATE_SEC`）補訂閱，其他 filter 照原游標；呼叫端也可以用 `pool.subscribe(filters, handlers, { backdateWindowSec })` 自己宣告（0＝關閉）。重拉回來的事件由訂閱內的 id 去重擋掉；每次重連多出來的流量受中繼每次 REQ 的位元組預算限制（Cinderous 中繼 16 MB；私訊通常只有幾 KB），被預算截掉的較舊事件照舊由 `NostrVaultTransport.backfill()`／`forEachPage` 分頁補齊。`FastHydrator` 與 `backfill()` 本來就退讓兩天，沒有改。沒有破壞性變更：只收兩個參數的自訂 `RelayTransport` 照樣通過型別檢查。
- **Vault 名單上的裝置能力宣告**（v0.30，ADR 0035）：`membership.declareCapabilities()` 在名單上加一筆裝置自己簽的 `{ sdk, maxRelayFileBytes }`（可再帶未來的旗標）；`membership.minCapability()` 回傳所有有效成員都支援的下限，沒有宣告的成員（≤ v0.29）一律當成舊版 16.5 MB。每次名單變動時呼叫 `coordinator.setMemberCapabilities(membership.minCapability())`——經中繼的單檔門檻變成 min(中繼上限, 成員)——之後才把 `setRelayLimits` 調過 16.5 MB。沒有 `caps` 的舊名單照收；舊版裝置略過並丟掉這一欄，不影響收斂。每台只能簽自己的能力；誇大的後果只是別台送它收不下的檔案。
- **內容相同的檔案不再產生衝突副本**（v0.30，ADR 0035）：兩個不同的檔案搶同一個路徑、而**內容雜湊相同**時（最常見的是新裝置帶著已經有的筆記加入），協調器把輸的那個收斂進留下的那個（確定性的刪除版本、磁碟那一份改記在留下的名下、不動磁碟），不再改名成衝突副本。內容不同仍照舊產生副本。與 ≤ v0.29 的裝置混用時也收斂到同一個檔案。

安裝：從公開的 GitHub repo 以 git 相依安裝，釘住 tag：`npm install github:VaalRL/cinderous-sdk#v0.76.1`（[ADR 0110](docs/adr/0110-public-github-repo-not-npm.md)）。

> ⚠ **沒有發布到 npm。** npm 上的 `@cinderous` 範圍是不相關的帳號，npm 上任何 `@cinderous/*` 套件都**不是我們發布的**。一律用 GitHub 網址加 tag，並保留 lockfile；不要寫成 `"@cinderous/client": "^0.76.1"` 這種版號範圍，npm 會去 registry 找。

### 相依 overrides（建議）：讓 @noble 只剩一份

SDK 相依的 nostr-tools 釘 `@noble/curves`／`@noble/hashes` 2.0.1、`@noble/ciphers` 2.1.1、`@scure/base` 2.0.0；SDK 為了安全修正改用 **2.4.0**（[ADR 0034](docs/adr/0034-noble-2-4-and-consumer-overrides.md)）。函式庫無法替使用方決定間接相依的版本，所以**請在你自己的專案**（遊戲、外掛、App）加 overrides。不加也能運作，只是打包裡有兩份（遊戲入口壓縮後 92 KB → 126 KB、gzip 34 KB → 47 KB），且 nostr-tools 那份停在 2.0.1。

**六個套件一起導**。特別是不要只導 `@scure/base`：`@scure/bip39` 2.0.1 會匯入 `@scure/base` 2.3 起已移除的內部 `utils`，`nostr-tools/nip06` 會在載入時丟 `SyntaxError: ... does not provide an export named 'utils'`。

npm（`package.json`）：
```json
{
  "overrides": {
    "@noble/curves": "2.4.0",
    "@noble/hashes": "2.4.0",
    "@noble/ciphers": "2.4.0",
    "@scure/base": "2.4.0",
    "@scure/bip32": "2.4.0",
    "@scure/bip39": "2.4.0"
  }
}
```

pnpm 10（repo 根目錄的 `pnpm-workspace.yaml`；實測 pnpm 10.33 會忽略 `package.json` 的 `pnpm.overrides` 並警告——pnpm 9 以前則把同一份對照寫在 `package.json` 的 `"pnpm": { "overrides": { ... } }`）：
```yaml
overrides:
  '@noble/curves': 2.4.0
  '@noble/hashes': 2.4.0
  '@noble/ciphers': 2.4.0
  '@scure/base': 2.4.0
  '@scure/bip32': 2.4.0
  '@scure/bip39': 2.4.0
```

Yarn：同一份對照寫在 `package.json` 的 `"resolutions"`。

**如果相依樹裡還有別的套件依賴 @noble 1.x**（例如開發伺服器帶進來的 `pkijs` 釘 `@noble/hashes` 1.8.0），最上層的 overrides 會把它強制改成 2.x，匯入時就壞掉。這時改成只對 nostr-tools 生效的巢狀寫法（npm）：
```json
"overrides": {
  "nostr-tools": {
    "@noble/curves": "2.4.0", "@noble/hashes": "2.4.0", "@noble/ciphers": "2.4.0",
    "@scure/base": "2.4.0", "@scure/bip32": "2.4.0", "@scure/bip39": "2.4.0"
  }
}
```
先用 `npm ls @noble/hashes --all` 確認：除了 nostr-tools 那份以外都已經是 2.x，就可以用上面的最上層寫法。

**npm lockfile 的陷阱**：已經有 `package-lock.json` 的專案加上 overrides 後，`@scure/bip32`／`@scure/bip39` 可能不會重新解析（`npm ls` 顯示 invalid）。把 `package-lock.json` 裡 `node_modules/nostr-tools`、`node_modules/@scure/bip32`、`node_modules/@scure/bip39` 三筆刪掉（或整個刪掉 lockfile），再 `npm install` 一次。

檢查（每個套件只能有一個版本，2.4.0）：
```bash
npm ls @noble/curves @noble/hashes @noble/ciphers @scure/base --all   # npm：每一行都是 deduped 或 overridden
pnpm why @noble/curves                                                  # pnpm：「Found 1 version of @noble/curves」
```

選用的 CI 檢查（npm；出現第二份就失敗）：
```js
// scripts/check-noble.mjs —— 執行：node scripts/check-noble.mjs
import { readFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
let failed = false;
for (const name of ['@noble/curves', '@noble/hashes', '@noble/ciphers', '@scure/base']) {
  const copies = Object.entries(lock.packages).filter(([p]) => p.endsWith(`node_modules/${name}`));
  const versions = [...new Set(copies.map(([, m]) => m.version))];
  if (versions.length !== 1) { console.error(`${name}: ${versions.join(', ')}`); failed = true; }
}
process.exit(failed ? 1 : 0);
```

**效能說明**：noble 2.3 起刻意讓 `getPublicKey`／`sign` 變慢（預算視窗縮小、常數時間強化），驗章與 ECDH 反而變快。SDK **不會**呼叫 `secp256k1.Point.BASE.precompute(8)`：它會修改共用的模組單例、多佔約 600 KB 記憶體、第一次金鑰運算多約 25 ms，只換到 `getPublicKey`／`sign` 約 20% 的速度。大量簽章的長時間程式（中繼、伺服器）可在啟動時自己加一行——整棵樹只有一份 noble 時，SDK 與 nostr-tools 都會一起生效：
```ts
import { secp256k1 } from '@noble/curves/secp256k1.js';
secp256k1.Point.BASE.precompute(8);
```

## 🚀 快速上手與使用指南

### 1. 預設模式（階梯 0：零設定直接使用）
```typescript
import { Identity, PeerNode, RelayPool } from '@cinderous/client';

// 信令走公共節點，並透過 NIP-59 雙重包裝：中繼看不出是誰在找誰
const identity = Identity.generate();
const pool = new RelayPool({ urls: ['wss://nos.lol', 'wss://relay.damus.io'], identity });
pool.connect();
const node = new PeerNode({ identity, transport: pool, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

// 先試 WebRTC P2P；8 秒打不通就自動改走中繼（kind 20079，每框 48,000 B、各包一次 NIP-59）
const channel = await node.connectPeer(targetPublicKey);
console.log(channel.mode); // 'p2p-webrtc' 或 'relayed-websocket'
channel.onMessage((bytes) => console.log('收到', bytes.length));
await channel.send(new TextEncoder().encode('哈囉'));

// 對方找上門
node.onPeer((incoming) => incoming.onMessage((bytes) => console.log(bytes)));
```
走中繼時約每秒 160 KB；`channel.needsLargePayloadWarning(size)` 為 true（走中繼且超過 20 MB）時，建議提示使用者連同一個 Wi-Fi。

### 2. 自託管模式（階梯 1：在自己的機器起一座中繼）
在個人的樹莓派、NAS 或平價 VPS 上執行（Node 22 以上）：
```bash
# 預設純記憶體，重啟即清空；只讓名單上的人寫入
npx cinderous relay start --port 8080 --allowed-pubkeys="npub1alice...,npub1bob..."

# 要保存離線留言就加 --persist（SQLite，預設 cinderous-relay.db）
npx cinderous relay start --persist --db-path /data/relay.db
```
白名單寫錯任何一筆，中繼會拒絕啟動，不會默默變成開放中繼。
白名單外的人認證後立刻以 4003 斷線；預設每把公鑰最多 5 條連線、每個 IP 每秒最多 20 則訊息（`MAX_CONNECTIONS_PER_PUBKEY`、`MAX_MESSAGES_PER_SECOND_PER_IP` 可調；反向代理後方請設 `TRUST_PROXY=1`）。
Docker 映像 `cinderous/relay-lite` 等 SDK 公開後發布。

**在 VPS 上對外提供 `wss://`**（網域、Caddy 自動 HTTPS、只聽本機、防火牆、systemd、日常維護）：照 **[docs/guides/self-host-vps.md](docs/guides/self-host-vps.md)**（[ADR 0109](docs/adr/0109-vps-self-host-guide.md)）。

### 3. 無伺服器邊緣模式（階梯 2：一鍵部署至 Cloudflare Workers）

雖然 Cinderous Relay 不強制綁定任何特定廠商，但 SDK 原生將 **Cloudflare Workers ＋ Durable Objects 作為第一梯隊的高效開箱即用方案（First-Class Turnkey Recipe）**，專為追求全球邊緣 $<30\text{ms}$ 極致延遲且不想維護伺服器的開發者提供一鍵部署。

#### 互動式引導部署（推薦個人/桌面端）：
```bash
# 登入 Cloudflare 用的是 wrangler 自己的登入流程（先執行 `npx wrangler@4 login`，或設定 CLOUDFLARE_API_TOKEN）；
# Cinderous CLI 本身不跑 OAuth、也不經手任何憑證。之後建立 Durable Objects、部署並印出中繼網址
npx cinderous relay deploy --provider=cloudflare
```

#### 自動化 / CI/CD 無頭模式部署（團隊/流水線）：
```bash
npx cinderous relay deploy \
  --provider=cloudflare \
  --name=my-vault-sync-relay \
  --allowed-pubkeys="npub1alice...,npub1bob..." \
  --api-token="$CLOUDFLARE_API_TOKEN" \
  --account-id="$CLOUDFLARE_ACCOUNT_ID" \
  --non-interactive
```

#### CLI 支援參數對照表：
| 參數 Flag | 縮寫 | 預設值 | 說明 |
| :--- | :--- | :--- | :--- |
| `--provider` | `-p` | `cloudflare` | `cloudflare`、`docker`（這台機器，docker compose）、`fly`（Fly.io）（[ADR 0018](docs/adr/0018-docker-and-fly-providers.md)）。 |
| `--name` | `-n` | `cinderous-relay` | Cloudflare Worker 實例與子域路由名稱。 |
| `--allowed-pubkeys`| `-k` | 無（開放前警示）| 逗號分隔之 NIP-42 白名單公鑰（支援 `npub` 或 hex）。 |
| `--api-token` | `-t` | 讀取環境變數 | 具備 Workers Script 編輯權限之 Cloudflare API Token。 |
| `--account-id` | `-a` | 讀取環境變數 | Cloudflare Account ID。有多個帳號時務必指定：wrangler 會沿用上次登入的帳號。 |
| `--non-interactive`| `-y` | `false` | 無頭模式，跳過所有確認提示全自動執行。 |
| `--output-env` | `-o` | `.env.cinderous` | 自動將部署成功之 `WSS` 端點寫入環境設定檔。 |
| `--compatibility-date` | | `2026-09-01` | Cloudflare 相容性日期。 |
| `--dry-run` | | `false` | 只產生設定，不部署（cloudflare 另外試打包）。 |
| `--region` | `-r` | `nrt` | fly：部署區域。 |
| `--port` | | `8080` | docker：對外的埠。 |
| `--persist` | | `false` | docker／fly：以 SQLite 保存離線留言（掛 volume）。 |
| `--app-lanes` | | 無 | cloudflare：已知租戶車道（逗號分隔，例如 `dochost`）；改名單＝換 DO（[ADR 0036](docs/adr/0036-deploy-app-lanes-and-dochost-on-self-hosted-relays.md)）。 |
| `--file-lanes` | | 無 | cloudflare：只在這些車道收檔案塊（須在 `--app-lanes` 上，並給 `--max-file-mb`）。 |
| `--relay-name`／`--relay-description`／`--relay-contact` | | 無 | NIP-11 站名／描述／聯絡方式。 |
| `--max-ttl-days` | | `7` | 離線留言保存上限，1–365。 |
| `--max-connections-per-pubkey` | | `5` | 同一把公鑰最多幾條連線，1–100。 |
| `--max-messages-per-second-per-ip` | | `20` | 同一個 IP 每秒最多幾則，1–1000。 |
| `--app-lane-pow` | | `0` | cloudflare：車道的 PoW 最低難度，0–32。 |
| `--developer-docs-url` | | 無 | cloudflare：連線被拒時附上的開發文件網址（https）。 |
| `--relay-software-url` | | SDK 的 repo | NIP-11 `software`（https）：改過中繼程式時指向修改後的原始碼（AGPL §13）。 |
| `--config` | `-c` | 無 | 改用 `cinderous.config.json` 部署（只能再加 `--output-env`、`--dry-run`）。 |

#### 設定檔（可重複的部署，[ADR 0050](docs/adr/0050-deploy-configurator.md)）：
把所有選擇放在 `cinderous.config.json`（以 `schema/cinderous.config.schema.json` 驗證），每次部署都帶同一份——不會因為少給一個旗標就讓重新部署把參數換回預設值。秘密只寫環境變數的名稱。
```bash
npx cinderous config validate cinderous.config.json
npx cinderous relay build --config cinderous.config.json --out deploy/   # 可攜的部署包＋README-DEPLOY.md／README-DEPLOY.en.md
npx cinderous relay deploy --config deploy/cinderous.config.json
```

#### 程式化 SDK 調用（例如於 Obsidian 設定頁面點擊按鈕直接開通，桌面與行動版皆可）：

請用 `@cinderous/client/deploy/cloudflare-api`（[ADR 0021](docs/adr/0021-cloudflare-rest-api-deploy.md)）：直接呼叫 Cloudflare REST API，不需要 Node 與 wrangler，中繼 Worker 已預先打包。上面的 `@cinderous/client/deploy` 是 Node／CLI 用的路徑（引用 `node:fs`、`node:child_process` 並執行 `npx wrangler`），**外掛不要匯入它**。

授權的預設做法（不需要任何註冊）：開瀏覽器到預填權限的 API Token 建立頁，使用者在自己的儀表板按「Create Token」，再把 Token 貼回來。Token 由應用自己保存（例如交給 `SecretStore`），SDK 不碰儲存。

給終端使用者的完整步驟（中英兩版，含依錯誤分類的常見問題）在 **[docs/guides/cloudflare-api-token.md](docs/guides/cloudflare-api-token.md)**。UI 請直接渲染 `CLOUDFLARE_TOKEN_SETUP_GUIDE`（`'zh-TW'`／`'en'`：`prerequisites`、`steps`、`troubleshooting[error.kind]`），不要自己抄一份（[ADR 0022](docs/adr/0022-token-setup-guide-as-sdk-data.md)）。

另一種做法：應用自己在 Cloudflare 註冊 **public OAuth client**（2026-06 起開放，須驗證網域），改用 PKCE 輔助函式 `createPkcePair`／`buildOAuthAuthorizationUrl`／`exchangeOAuthCode`／`refreshOAuthToken`，部署時帶 `credential: 'oauth'`。SDK 本身不附 client id。

Cloudflare API 不回 CORS 標頭，瀏覽器類的執行環境必須注入 HTTP 函式。Obsidian 用 `requestUrl` 轉接：

```typescript
import { requestUrl } from 'obsidian';
import {
  buildTokenCreationUrl,
  CLOUDFLARE_TOKEN_SETUP_GUIDE,
  CloudflareApiError,
  deployCloudflareRelayViaApi,
  verifyToken,
  type HttpFetch,
} from '@cinderous/client/deploy/cloudflare-api';

// requestUrl 不受 CORS 限制；SDK 只需要 { status, text() }
const obsidianFetch: HttpFetch = async (url, init) => {
  const body = init.body instanceof Uint8Array ? init.body.slice().buffer : init.body;
  const res = await requestUrl({ url, method: init.method, headers: init.headers, body, throw: false });
  return { status: res.status, text: async () => res.text };
};

// 1. 開瀏覽器到預填最小權限的 Token 建立頁（Workers Scripts: Edit、Account Settings: Read）
window.open(buildTokenCreationUrl()); // Token 名稱為 DEFAULT_TOKEN_NAME，與 CLOUDFLARE_TOKEN_SETUP_GUIDE 一致

// 2. 使用者貼回 Token 後
await verifyToken({ apiToken: token, fetch: obsidianFetch });

// 3. 部署（重跑是安全的：已套用的 Durable Object 遷移不會重送）
try {
  const { relayEndpoint } = await deployCloudflareRelayViaApi({
    apiToken: token,
    fetch: obsidianFetch,
    workerName: 'my-vault-relay',
    allowedPubkeys: [userPubkey],
    onProgress: (s) => console.log(s.step, s.message),
  });
  console.log('專屬中繼站開通完畢：', relayEndpoint); // wss://my-vault-relay.<subdomain>.workers.dev
} catch (e) {
  if (e instanceof CloudflareApiError) {
    const help = CLOUDFLARE_TOKEN_SETUP_GUIDE['zh-TW'].troubleshooting[e.kind]; // { symptom, cause, fix }
    // e.kind：'token-invalid' | 'permission' | 'account-ambiguous'（可選帳號在 e.accounts）| 'subdomain-missing'
    //       | 'name-conflict' | 'quota' | 'network' | 'lane-change'（重新部署改了 appLanes）| 'health' | 'api'
  }
  throw e;
}
```

Token 能用多個帳號時請帶 `accountId`（錯誤物件附有可選的 `accounts`）；帳號還沒有 `workers.dev` 子網域時，帶 `workersDevSubdomain` 註冊一個。站名、已知租戶車道（`appLanes`）、保存期、限速等站台參數見 `RelaySiteOptions`（[ADR 0037](docs/adr/0037-one-click-deploy-parameters.md)）；REST 重新部署會整份替換設定，請每次帶同一份。

### 4. 資源消耗與營運成本試算（CLI Estimator）
在決定密碼模式（Cinder EK vs 雙棘輪）或上雲部署前，可透過內建試算引擎精算每日事件數、頻寬與 Cloudflare 免費額度佔用比：
```bash
# 試算 15 人協同在雙棘輪與後量子模式下的扇出與額度消耗
npx cinderous estimate --mode=double-ratchet --pq --devices=5 --collaborators=15 --daily-actions=500 --payload-kb=20

# 要給程式讀就加 --json
```

---

## 📊 與傳統 Nostr Relay 技術對照

| 比較維度 | `strfry` | `nostr-rs-relay` | `khatru` | **`cinderous-relay`** |
| :--- | :--- | :--- | :--- | :--- |
| **底層架構** | Linux 常駐守護進程 | Linux 常駐守護進程 | Go 服務框架 | **邊緣無伺服器 ＋ 輕量本機雙模** |
| **儲存機制** | LMDB 重度磁碟寫入 | SQLite / PostgreSQL | 可自訂儲存 | **信令只在記憶體；加密的離線訊息與檔案塊存到保存期限** |
| **閒置記憶體** | ~100 MB | ~50 MB | ~30 MB | **< 15 MB (Docker) / 0 MB (Edge)** |
| **P2P 打洞支援**| 無特殊最佳化 | 無特殊最佳化 | 無特殊最佳化 | **原生瞬時撮合（Ephemeral Signaling）** |
| **存取門禁** | 開放 / 付費 / PoW | 開放 / 白名單 | 自行寫 Go 代碼擴充 | **NIP-42 雙向簽名白名單硬性隔離** |
| **主機月費** | $5 ~ $20/月 (VPS) | $5 ~ $20/月 (VPS) | $5 ~ $20/月 (VPS) | **$0（在 Cloudflare 免費額度內）** |

---

## 📖 規格與研究文件導覽

- [生產級產品需求與架構規格書 (PRD.md)](PRD.md)
- CinderSync（Obsidian 筆記庫同步）與 Cinder Coffice（Obsidian 即時協同）以這個 SDK 開發，規格書在它們自己的 repo，目前還沒公開。

---

## ☕ 贊助與支持 (Sponsor)

若這套開源架構與研究成果對您的去中心化應用開發有所啟發，歡迎為本專案點亮 Star，或請我們喝杯咖啡：

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-whoami885-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/whoami885)

---

## 📄 開源授權

本專案以 [GNU AGPL-3.0](LICENSE) 授權（2026-09-27 由 MIT 改為 AGPL，見 [ADR 0001](docs/adr/0001-v0-1-client-scope-agpl-and-git-distribution.md)）。使用本 SDK 的應用在散布或以網路提供服務時，須依 AGPL 提供對應原始碼。
