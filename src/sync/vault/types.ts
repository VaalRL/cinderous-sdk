// 檔案樹同步協調器的公開型別（SDK ADR 0025）。
//
// 協調器平台無關：檔案系統、狀態儲存、時間、網路一律由應用注入，這裡只定義最小介面。
import type { ByteChannel } from '../../transfer/file-transfer.js';

/** 一個檔案的中繼資料。路徑一律是 Vault 內的相對路徑、以 `/` 分隔（例如 `notes/a.md`）。 */
export interface VaultFileStat {
  path: string;
  size: number;
  /** 修改時間（毫秒）。只拿來判斷「可能改過」，真正的判斷是內容雜湊。 */
  mtime: number;
}

/**
 * 前置條件：給檔案**目前**的內容（不存在時是 `null`），回傳是否可以繼續。
 *
 * 能做到「檢查＋寫入」不可分割的轉接器（例如 Obsidian 的 `vault.process`）應該在同一個原子操作裡檢查；
 * 不符合時什麼都不做並回 `false`。做不到的轉接器可以忽略它（照做並回 `true`），
 * 代價是「讀到寫之間使用者剛好又改了檔案」這段很短的競態（ADR 0025 §已知限制）。
 */
export type VaultPrecondition = (current: Uint8Array | null) => boolean;

/** 檔案系統轉接器。Obsidian 外掛用 `app.vault`／`app.vault.adapter` 實作。 */
export interface VaultAdapter {
  /** 列出所有檔案（不含資料夾）。 */
  list(): Promise<VaultFileStat[]>;
  read(path: string): Promise<Uint8Array>;
  /** 建立或覆寫；必要時建立上層資料夾。回傳 `false` 表示前置條件不符、沒有寫入。 */
  write(path: string, bytes: Uint8Array, expect?: VaultPrecondition): Promise<boolean | void>;
  /**
   * 刪除；`expect` 檢查的是被刪檔案的內容。
   * `options.evict`（SDK ADR 0060）：這不是刪除，而是輕量成員**清掉本機副本**（其他裝置照常保留，沒有產生刪除版本）——
   * 轉接器可以據此不備份、不移到垃圾桶。真正的刪除照舊只帶兩個參數。
   */
  remove(path: string, expect?: VaultPrecondition, options?: VaultRemoveOptions): Promise<boolean | void>;
  /** 改名；`to` 已存在時必須失敗（回 `false`）。`expect` 檢查的是 `from` 的內容。 */
  rename(from: string, to: string, expect?: VaultPrecondition): Promise<boolean | void>;
  /** 不存在回 `null`。 */
  stat(path: string): Promise<VaultFileStat | null>;
  /**
   * 選配（SDK ADR 0026）：讀一段。有的話，大檔（超過檔案塊層）的雜湊與 P2P 送出都分段讀，不必整檔進記憶體。
   */
  readRange?(path: string, offset: number, length: number): Promise<Uint8Array>;
  /**
   * 選配（SDK ADR 0026）：以串流寫入大檔。實作應先寫到暫存檔、全部寫完再原子地取代目的地，
   * 而且取代前確認目的地目前內容的 SHA-256 等於 `expectHash`（`null`＝目的地必須不存在）；不符就不寫、回 `false`。
   * 沒有實作時，P2P 收到的大檔會整檔讀進記憶體再經 `write` 寫入。
   */
  writeStream?(path: string, source: VaultContentSource, expectHash: string | null): Promise<boolean | void>;
}

/** 分段讀取的內容來源（大檔串流寫入用） */
export interface VaultContentSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  /**
   * 內容的 SHA-256（64 字元小寫 hex，與 `VaultVersion.hash`、`StreamEntry.sha256` 同一個格式；SDK ADR 0057）。
   * 協調器交給 `writeStream` 的來源一定帶：值是版本的 `node.hash`，P2P 串流收完時已以它校驗過整個內容（送方宣告的
   * `sha256` 必須等於 `node.hash`，收方逐塊算的雜湊不符就不交付）。轉接器可以在寫入時增量計算、改名進目的地前比對，
   * 不符就不取代、回 `false`（協調器之後重新讀取）。選配是為了相容自己建立來源的程式。
   */
  sha256?: string;
  /**
   * 本機暫存的整份內容（單一檔案的路徑；SDK ADR 0089）：已以 `sha256` 校驗過。轉接器可以直接把它改名成目的地，不讀出再寫；
   * 改名之後暫存就不在了（`read` 不能再用）。只有 P2P 收到的大檔、而且暫存區回報了路徑時才有
   */
  stagedPath?: string;
}

/**
 * 同一個 Vault 其他裝置的直連通道（SDK ADR 0026）。`peerNodeLink` 用 `PeerNode` 實作；測試用記憶體的假網路。
 *
 * 通道必須**已經認證**是那台裝置（`PeerNode` 的通道：P2P 軌以 DTLS 指紋經 NIP-59 信令交換、中繼軌每框 NIP-59），
 * 協調器以此綁定：從這條通道收到的版本，寄件裝置必須就是 `deviceId`。
 */
export interface VaultPeerLink {
  /** 同一個 Vault 的其他裝置（協調器的 deviceId） */
  devices(): readonly string[];
  /**
   * 開一條到那台裝置的通道（P2P 優先；允許時退回中繼軌）；拿不到回 null 或丟例外。
   * `fresh`：上次在既有的通道上被對方拒絕（例如對方的協調器重開過、還沒在那條舊通道上掛處理器），請關掉舊通道重新連。
   */
  open(deviceId: string, opts?: { fresh?: boolean }): Promise<ByteChannel | null>;
  /** 那台裝置主動連上來 */
  onIncoming(listener: (deviceId: string, channel: ByteChannel) => void): () => void;
}

/**
 * 協調器清掉本機一份內容的原因（SDK ADR 0058、0060）：`scope`＝離開內容範圍（含滾動視窗前進）、`lru`＝快取超過上限、
 * `evict`＝應用呼叫 `evict()`（含清掉因排除而停止追蹤的副本）。
 */
export type VaultEvictReason = 'scope' | 'lru' | 'evict';

/** `VaultAdapter.remove` 的第三個參數（SDK ADR 0060） */
export interface VaultRemoveOptions {
  /** 有值＝清掉本機副本（**不是刪除**，沒有產生任何版本；其他裝置照常保留）；值是原因，與 `evicted` 事件相同 */
  evict?: VaultEvictReason;
}

/**
 * 協調器要套用到本機的一個變更。提供 `applyRemote` 時由應用自己執行（例如開啟中的檔案改走編輯器 API、
 * 寫入前先備份）；沒提供就直接經 `VaultAdapter` 執行。回傳 `false` 表示前置條件不符（協調器會重新讀取再試）。
 */
export type VaultRemoteChange =
  | { type: 'write'; path: string; bytes: Uint8Array; expect: VaultPrecondition; fileId: string }
  | {
      type: 'remove';
      path: string;
      expect: VaultPrecondition;
      fileId: string;
      /**
       * 有這個欄位＝清掉本機副本、**不是刪除**（SDK ADR 0060，CinderSync G23）：沒有產生任何版本，其他裝置照常保留，
       * 之後重新納入範圍或 `fetch` 會再抓回來——應用可以直接刪檔，不必備份或移到垃圾桶。真正的刪除沒有這個欄位（物件形狀與 v0.46.0 相同）。
       */
      evict?: VaultEvictReason;
    }
  | { type: 'rename'; from: string; to: string; expect: VaultPrecondition; fileId: string };

/**
 * 持久化的狀態儲存（鍵值、非同步）。IndexedDB、`app.vault.adapter` 底下的檔案、記憶體都可以。
 * 協調器保證同一個鍵的寫入依序完成、讀取會等排在前面的寫入（ADR 0024 的「每鍵序列化」），
 * 所以實作者不必自己處理交錯。
 */
export interface SyncStateStore {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** 列出以 `prefix` 開頭的所有鍵。 */
  keys(prefix: string): Promise<string[]>;
}

/**
 * 一個路徑範圍（SDK ADR 0058）：gitignore 語法的規則清單（陣列，或一行一條的整段文字；**符合＝在範圍內**，與排除清單相反）、
 * `{ includes(path) }`，或函式。
 */
export type VaultPathScope = readonly string[] | string | { includes(path: string): boolean } | ((path: string) => boolean);

/**
 * 輕量成員的內容範圍（SDK ADR 0058）。這台仍知道整個 Vault 的版本資訊（每個檔案的路徑、大小、雜湊、時間、是否刪除），
 * 但只有範圍內的檔案內容會保存、寫進磁碟。
 */
export interface VaultContentScope {
  /**
   * 內容範圍：這些路徑的內容保存在這台、寫進磁碟。另外 `pin()` 釘選的與 `fetch()` 抓下來的（快取）也算。
   * 範圍外的檔案：收版本資訊、併入版本圖，**不寫磁碟、不保存內容**；離開範圍的本機檔案清掉（不產生刪除版本）。
   */
  content: VaultPathScope;
  /** `fetch()` 抓下來的快取上限（位元組；預設 200 MiB）。超過時以 LRU 清掉最久沒用的（不產生刪除版本；釘選的不算） */
  cacheBytes?: number;
  /**
   * 允許在這台**新增**檔案的範圍（SDK ADR 0058 §裁示 3）；省略＝不限。範圍外新增的本機檔案不同步、不產生版本，
   * 發 `error` 事件（`sparse-create-outside`），`notifyLocalChange` 以 `VaultScopeError` reject。改名、修改既有檔案不受限。
   */
  create?: VaultPathScope;
}

/** 其他輕量成員的內容範圍：deviceId → 範圍（SDK ADR 0058） */
export type VaultPeerScopes = Readonly<Record<string, VaultPathScope>>;

/** `remoteIndex()`／`lookup()` 的一筆：這台所知的一個檔案（含只有版本資訊、內容不在這台的；SDK ADR 0058） */
export interface VaultRemoteEntry {
  fileId: string;
  /** 目前的版本（有好幾個版本頭時是最新的那一個） */
  versionId: string;
  path: string;
  size: number;
  /** 內容的 SHA-256（刪除時是空字串） */
  hash: string;
  deleted: boolean;
  /** 這個版本的時間（毫秒，混合邏輯時鐘；相當於最後修改時間） */
  modifiedAt: number;
  /** 內容在這台（磁碟上就是這個版本） */
  local: boolean;
  /** 在內容範圍內（規則、釘選或快取） */
  inScope: boolean;
  pinned: boolean;
  /** 是 `fetch()` 抓下來、受 LRU 管理的快取 */
  cached: boolean;
  /** 還有好幾個版本頭（並發修改，完整成員合併後就只剩一個） */
  conflicted: boolean;
}

/** `evict()` 的結果（SDK ADR 0058） */
export interface VaultEvictResult {
  evicted: boolean;
  /**
   * 沒清掉的原因：`in-scope`（在內容範圍內、或這台是完整成員而且檔案在同步中——清掉會立刻再寫回來）、
   * `unsent`（有還沒送出的本機修改，送出後自動清掉）、`modified`（停止追蹤的本機副本被改過，清掉會遺失修改）、
   * `not-local`（本機沒有這個檔案）、`unknown`（不認得的路徑）
   */
  reason?: 'in-scope' | 'unsent' | 'modified' | 'not-local' | 'unknown';
}

/** 輕量成員的錯誤（SDK ADR 0058） */
export type VaultScopeErrorCode =
  /** 本機在一個內容不在這台的檔案路徑上建立了檔案：沒有基準內容，不產生版本（要先 `fetch`） */
  | 'base-missing'
  /** 在允許新增的範圍外新增了檔案 */
  | 'create-outside'
  /** `fetch` 的檔案已經刪除 */
  | 'deleted'
  /** `fetch` 的路徑被排除（`excludes`／`ignore`） */
  | 'excluded'
  /** 不認得的路徑或 fileId */
  | 'unknown'
  /** `fetch` 等到逾時（下載仍在背景進行） */
  | 'timeout'
  /** 協調器已停止 */
  | 'stopped';

/** 可注入的時間來源與計時器（測試用假的時鐘）。 */
export interface VaultSyncClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * 一個版本（版本圖的節點）。刪除、改名、內容變更、合併都是一個版本。
 *
 * - `id`：32 位 hex。本機編輯是隨機的；合併、衝突副本、路徑相撞的改名是由內容決定的雜湊，
 *   兩台裝置各自算出同一個合併時 id 相同、自然去重。
 * - `hash`：內容的 SHA-256（hex）；刪除時是空字串。
 */
export interface VaultVersion {
  id: string;
  parents: string[];
  path: string;
  /** 這個路徑是從什麼時候開始的（路徑相撞時，先佔用的留下） */
  pathAt: number;
  deleted: boolean;
  hash: string;
  size: number;
  /** 可以做行級三方合併的文字檔 */
  text: boolean;
  /** 混合邏輯時鐘（毫秒）；比較先後用 `(at, device, id)` */
  at: number;
  device: string;
  /** 人看得懂的裝置名稱，衝突副本檔名會用到 */
  label: string;
  /** 大到不走中繼（`classifyPayload` 回 `p2p`）：內容要等 P2P 傳輸（第 3 批） */
  p2p: boolean;
}

/** `bundle` 裡的一項（SDK ADR 0095）：跟一則 `node` 一樣，刪除與只走 P2P 的版本沒有內容 */
export interface VaultBundleItem {
  fileId: string;
  node: VaultVersion;
  content?: Uint8Array;
}

/** 協調器之間交換的訊息。線上格式見 `codec.ts`。 */
export type VaultSyncMessage = (
  | { type: 'node'; from: string; fileId: string; node: VaultVersion; content?: Uint8Array }
  | {
      type: 'digest';
      from: string;
      /** 同一次摘要的識別碼；摘要會分成多則送 */
      digestId: string;
      part: number;
      parts: number;
      /** `[fileId, 目前的版本頭]` */
      files: Array<[string, string[]]>;
      /**
       * 產生摘要時，已處理到各寄件人的最大寄件序號（`rs`；SDK ADR 0074）。寄件人在那之後才經中繼送來的版本還在路上，
       * 不因為摘要裡沒有就重送。舊版沒有、也略過這一欄。
       */
      seen?: Array<[string, number]>;
      /** 這份同步狀態的識別碼（SDK ADR 0074）：狀態重建過（例如清掉了儲存）就換一個，寄件人改回照舊重送 */
      sid?: string;
    }
  | {
      type: 'want';
      from: string;
      items: Array<[string, string]>;
      /** 要的是**內容**（SDK ADR 0058）：回應時不依收件人的內容範圍裁剪。沒有＝要版本（例如缺父版本）。舊版略過這一欄 */
      fetch?: boolean;
      /**
       * 連祖先一起要（SDK ADR 0088）：這台連那個檔案都不認得，回應時把那個版本在手上的所有祖先也送過來（父版本在前），
       * 不必一層一層索取。舊版略過這一欄（照舊只回那一個版本）
       */
      deep?: boolean;
    }
  | {
      /** 好幾個只有版本資訊（不帶內容）的版本（SDK ADR 0058）：只送給宣告為輕量的收件人（v0.46 起才認得） */
      type: 'nodes';
      from: string;
      items: Array<[string, VaultVersion]>;
    }
  | {
      /**
       * 好幾個小版本連同內容合成一則（SDK ADR 0095，v0.68 起才認得）：編碼後不超過一個訊框。
       * 只送給宣告看得懂的收件人（`BUNDLE_CAPABILITY`）；舊版丟掉不認得的類型。
       */
      type: 'bundle';
      from: string;
      items: VaultBundleItem[];
    }
  | {
      /**
       * 簽收單（SDK ADR 0068，v0.54 起才認得）：`from` 處理完、已保存了 `for` 寄來的哪些訊息（寄件序號 `rs` 的區間，
       * 遞增、不重疊、不相鄰）。只送給 `for`；舊版丟掉不認得的類型。本身不帶 `rs`（不再簽收簽收單）。
       */
      type: 'receipt';
      from: string;
      for: string;
      ranges: Array<[number, number]>;
    }
) & {
  /** 寄件序號（SDK ADR 0068）：每台寄件裝置自己遞增，收件人以它回簽收單。舊版略過 */
  rs?: number;
};

/** `VaultSyncTransport.send` 的選項（SDK ADR 0058）；做不到的傳輸層可以略過（照舊全部、完整地送） */
export interface VaultSendOptions {
  /** 只送給這些裝置（deviceId）；省略＝所有裝置 */
  to?: readonly string[];
  /** 送給這些裝置（deviceId）時拿掉內容、只帶版本資訊（宣告為輕量的收件人、版本在它的內容範圍外） */
  omitContentFor?: readonly string[];
}

/**
 * 網路。`createNostrVaultTransport` 用既有的 kind 1060 檔案塊外層實作；測試用記憶體的假中繼。
 * 訊息預設廣播給同一個 Vault 的所有其他裝置。
 */
export interface VaultSyncTransport {
  /**
   * 送不出去（離線、沒有任何中繼接受）就 reject；協調器會退避重試。
   * `options`（SDK ADR 0058）：指定收件人、對某些收件人拿掉內容；做不到就照舊全部完整地送（`targeted` 不是 true）。
   */
  send(message: VaultSyncMessage, options?: VaultSendOptions): Promise<void>;
  /**
   * 傳輸層真的依 `options.to`／`omitContentFor` 送（SDK ADR 0058）。`NostrVaultTransport` 給了 `deviceOf` 時是 true。
   * 協調器只在 true 時才把多個只有版本資訊的版本合成一則 `nodes` 訊息（舊版不認得，不能廣播出去）。
   */
  readonly targeted?: boolean;
  /**
   * 目前的收件裝置（deviceId；SDK ADR 0068）：協調器按收件人記中繼帳、帳滿只排除那一台。沒有＝不知道收件人，照舊一本帳。
   */
  recipients?(): string[] | undefined;
  /**
   * 監聽者可以回傳 Promise（SDK ADR 0067）：它完成＝這則訊息處理完、結果已經保存（協調器就是這樣），傳輸層之後才能
   * 請中繼提早清掉那幾顆包。沒回傳 Promise 的監聽者不表態；reject＝沒處理好。不支援確認的傳輸層照舊忽略回傳值。
   */
  onMessage(listener: (message: VaultSyncMessage) => unknown): () => void;
  onStatusChange(listener: (online: boolean) => void): () => void;
  isOnline(): boolean;
}

export type VaultConflictKind =
  /** 兩邊改了同一段文字、改得不一樣 */
  | 'text'
  /** 兩邊都改了無法合併的檔案（二進位、太大或找不到共同祖先） */
  | 'binary'
  /** 一邊刪、一邊改：保留修改後的檔案 */
  | 'delete-modify'
  /** 兩邊改成不同的名字：留一個名字，內容不受影響 */
  | 'rename-rename'
  /** 兩個不同的檔案要用同一個路徑：後來的改名成衝突副本名稱 */
  | 'path-collision';

export interface VaultConflict {
  kind: VaultConflictKind;
  fileId: string;
  /** 主檔案的路徑 */
  path: string;
  /** 另一方內容存成的衝突副本（`text`、`binary`），或被改名的檔案新路徑（`path-collision`） */
  copyPath?: string;
  /** `rename-rename` 時沒被採用的名字 */
  otherPath?: string;
  /**
   * `text`：衝突就地放進了檔案裡的這些 callout（SDK ADR 0046；Markdown、所有版本頭都支援時），沒有衝突副本。
   * 用 `parseConflictCallouts(檔案內容)` 找出來、`resolveConflictCallout` 解決。
   */
  callouts?: string[];
  at: number;
}

/** 內容還沒到的檔案（大檔等 P2P、或內容遺失正在跟別台要）。 */
export interface VaultPendingContent {
  fileId: string;
  versionId: string;
  path: string;
  hash: string;
  size: number;
  /** `p2p`：大檔，等第 3 批的 P2P 傳輸；`relay`：中繼上的內容還沒到或遺失，已向其他裝置索取 */
  via: 'p2p' | 'relay';
}

export type VaultSyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'paused';

export interface VaultSyncStatus {
  state: VaultSyncState;
  /** 待送出的變更數 */
  queue: number;
  /** 收到但還在等前一個版本的遠端變更數 */
  waiting: number;
  conflicts: VaultConflict[];
  pending: VaultPendingContent[];
  /** 最後一次和其他裝置交換成功的時間（毫秒） */
  lastSyncAt?: number;
  /** `paused` 的原因 */
  pausedReason?: 'stale-device';
  /**
   * 批次模式（SDK ADR 0026）：待送出的版本多到超過門檻，改走 P2P 批次串流，走中繼（kind 1060）的只以限速補送。
   * 只有設定了 `peers` 才會出現。
   */
  bulk?: boolean;
  /** 等 P2P 送出的大檔內容數（SDK ADR 0026） */
  pushes?: number;
  /**
   * 保存期內已經經傳輸層送出、收件人還沒簽收的檔案塊與預算（SDK ADR 0029、0068）。
   * `devices`：每位收件人一列（最滿的在前；傳輸層提供 `recipients()` 時才有），`used` 是最滿的那一位。
   * 批次模式下某一台到了 `budget`，只暫停送給那一台的份，等它簽收或最舊的過了保存期。
   */
  relayQuota?: { used: number; budget: number; devices?: Array<{ device: string; used: number }> };
  /**
   * 送不出去的明確原因（SDK ADR 0027）。`relay-rejects-files`：中繼不接受 kind 1060（沒設 `MAX_FILE_MB`），
   * 重試也沒用，請提示使用者開啟或換中繼。有 `peers` 時，在線的裝置之間仍經 P2P 同步。
   * `relays-full`（v0.33，SDK ADR 0041）：傳輸層設了 `durability`，而中繼（含備援）都滿了；以最長退避偶爾再試，任何一座收下就恢復。
   */
  blocked?: 'relay-rejects-files' | 'relays-full';
  lastError?: string;
  /**
   * 這個協調器啟動以來經直連（P2P 批次串流）實際送出／收到的資料位元組（SDK ADR 0053 §G14），只會增加；
   * 判斷「批次有沒有在前進」用。只有設定了 `peers` 才會出現。不含通道本身的握手與控制訊息。
   */
  p2pBytes?: { sent: number; received: number };
  /**
   * 輕量成員（SDK ADR 0058）：本機有內容的檔案數與位元組（`local`）、其中 `fetch()` 快取的（`cached`，受 `limit` 管理）、
   * 這台所知的檔案總數（`known`，含只有版本資訊的）。只有設定了 `scope` 才會出現。
   */
  scope?: { local: { files: number; bytes: number }; cached: { files: number; bytes: number }; limit: number; known: number };
}

/**
 * 這台所知的另一台裝置的接收狀態（SDK ADR 0053 §G17，CinderSync G17）：`coordinator.peerStatus(device)`。
 * 全部來自**已經在收送的訊息**，不為它多送任何東西：它送來的版本（含經直連的）、它的摘要、直連批次的送達確認（ack）。
 * 經中繼送出的版本不知道對方收到沒有，所以不算——要等它的下一份摘要、或它以那個版本為父版本送來新版本。
 */
export interface VaultPeerStatus {
  device: string;
  /** 最後一次收到它任何同步訊息（中繼、直連）或應用以 `notePeerActivity` 通報的時間（毫秒，這台的時鐘）；沒有是 null */
  lastSeenAt: number | null;
  /** 最後一次收齊它的完整摘要的時間；沒有是 null（這時 `missing` 只根據它送來的版本與直連確認） */
  reportedAt: number | null;
  /** 這台目前的版本裡（含刪除），就這台所知它還沒有的檔案數 */
  missing: number;
  /** 這台目前追蹤中的檔案數（含墓碑保留期內的刪除） */
  files: number;
  /** 這台記得它版本頭的檔案數（0 且 `reportedAt` 是 null＝完全不知道它有什麼） */
  known: number;
  /**
   * 它宣告為輕量成員（SDK ADR 0058，`setPeerScopes`）：只有範圍內的內容。`missing` 照樣只算版本（輕量成員也有完整的版本資訊）；
   * 它**不是內容來源**——這台不會等它補送範圍外的內容。
   */
  sparse: boolean;
}

/**
 * 一次直連傳輸的進度（SDK ADR 0053 §G14，CinderSync G14）：`coordinator.transfers()` 與 `on('progress')`。
 * 送方的總數是開始時的預估（例如對方已經有的大檔內容會被略過、續傳只送剩下的）；收方的總數是送方宣告的提示。
 */
export interface VaultTransferProgress {
  /** 這次傳輸的 id（同一個協調器內唯一） */
  id: string;
  /** 對方裝置 */
  device: string;
  direction: 'send' | 'receive';
  /** 真的直連（WebRTC）或中繼軌（kind 20079，只送小檔） */
  mode: 'p2p-webrtc' | 'relayed-websocket';
  /** 已經有結果的檔案（版本）數與總數 */
  files: { done: number; total?: number };
  /** 這次實際傳了多少資料位元組（續傳不含之前已經有的）與總數 */
  bytes: { done: number; total?: number };
  /** 正在傳的檔案內容（只有帶內容的才有）；`done` 含續傳之前已經有的部分（收方） */
  current?: { fileId: string; path: string; size: number; done: number };
  startedAt: number;
  updatedAt: number;
  /** 傳輸結束（最後一次通知才有）：`finished`＝整批送完／收完；`failed`＝斷線、被拒或中止（已送達的照樣算數） */
  ended?: 'finished' | 'failed';
}

/** `whenSent()` 的結果（SDK ADR 0045，G12b） */
export interface VaultSentResult {
  /**
   * `sent`＝這一輪送完了（佇列清空、沒有在途的訊息）。其餘是無法前進的原因：`offline`、`paused`（沉睡裝置）、
   * `blocked`（中繼明確不收；佇列留到下一輪）、`stopped`、`timeout`（給了 `timeoutMs`、到了還在送或退避中）、
   * `throttled`（批次模式下剩下的都在等中繼補送的限速或配額、也沒有直連在試——要等到 `retryAt` 才會再送；SDK ADR 0092）。
   */
  state: 'sent' | 'offline' | 'paused' | 'blocked' | 'stopped' | 'timeout' | 'throttled';
  /** 回報當下待送的版本數 */
  queue: number;
  blocked?: 'relay-rejects-files' | 'relays-full';
  pausedReason?: 'stale-device';
  /** `throttled` 時下一次經中繼補送的時間（毫秒時間戳） */
  retryAt?: number;
}

/** 已套用到本機的遠端變更（給外掛顯示或記錄）。 */
export type VaultAppliedChange =
  | { type: 'write'; fileId: string; path: string; created: boolean }
  | { type: 'remove'; fileId: string; path: string }
  | { type: 'rename'; fileId: string; from: string; to: string };

export interface VaultSyncEventMap {
  status: VaultSyncStatus;
  conflict: VaultConflict;
  applied: VaultAppliedChange;
  pending: VaultPendingContent;
  error: { context: string; error: unknown };
  /** 直連傳輸的進度（SDK ADR 0053 §G14）；每次傳輸最多每 `progressIntervalMs` 一次，開始與結束一定通知 */
  progress: VaultTransferProgress;
  /**
   * 輕量成員清掉了本機的一份內容（SDK ADR 0058）：**不是刪除**，沒有產生任何版本，其他裝置照常保留。
   * `scope`＝離開內容範圍、`lru`＝快取超過上限、`evict`＝應用呼叫 `evict()`。
   */
  evicted: { fileId: string; path: string; reason: VaultEvictReason };
}

export type LocalChangeKind = 'create' | 'modify' | 'delete' | 'rename';

// ───────────────────────────── 版本歷史（SDK ADR 0063） ─────────────────────────────

/**
 * 版本歷史的保留規則（SDK ADR 0063）。歸檔只在這台的狀態儲存裡、**不同步**；和同步用的版本圖分開（版本圖照舊修剪）。
 * 二進位檔只記版本資訊（路徑、時間、裝置、雜湊、大小、是否刪除），**不存內容**（裁示 2）。
 */
export interface VaultHistoryOptions {
  /** 要不要歸檔；預設完整成員開、輕量成員（有 `scope`）關（裁示 4）。關掉時不新增，既有的照樣讀得到、照樣依保留規則清 */
  enabled?: boolean;
  /** 保留天數；預設 30。`Infinity`＝永久（例如家裡常開的歸檔電腦）。每個檔案目前的版本不受天數限制（刪除除外） */
  keepDays?: number;
  /** 每個檔案最多幾版（稀疏化之後）；預設 100 */
  maxVersionsPerFile?: number;
  /** 歸檔內容的總容量上限（位元組，以雜湊去重後計）；預設 1 GiB。超過時從最舊的清，每個檔案至少留一版 */
  maxBytes?: number;
  /**
   * 稀疏化「每天一版」的一天怎麼切（裁示 3）：`local`（預設）＝這台裝置的當地日期（含日光節約時間），`utc`＝UTC 日期。
   * 「每小時一版」的小時同理（只有非整點時差的時區會不同）。
   */
  dayBoundary?: 'local' | 'utc';
}

/** 歸檔裡的一個版本（`history()`、`deletedFiles()` 的 `lastVersion`） */
export interface VaultHistoryEntry {
  fileId: string;
  versionId: string;
  /** 這個版本的路徑（改名前的版本是舊路徑） */
  path: string;
  /** 版本的時間（毫秒，混合邏輯時鐘） */
  at: number;
  device: string;
  label: string;
  /** 內容的 SHA-256（刪除時是空字串） */
  hash: string;
  size: number;
  deleted: boolean;
  /** 文字檔（內容會歸檔）；二進位檔只有版本資訊 */
  text: boolean;
  /** 歸檔裡有這個版本的內容 */
  content: boolean;
  /** 現在可以還原：歸檔裡有內容，或內容和這個檔案現在的內容相同（二進位檔只有這種情形） */
  restorable: boolean;
  /**
   * 被收進另一個檔案的刪除版本（SDK ADR 0079）：路徑相撞、內容相同的收斂（G10），或同路徑新建的合併（ADR 0059）。
   * 不是使用者刪的，內容在留下的那個檔案裡；介面不要說成「已刪除」。只有這種版本才有這個欄位
   */
  absorbed?: true;
}

/** `deletedFiles()` 的一筆：最後一版是刪除的檔案 */
export interface VaultDeletedFile {
  fileId: string;
  /** 刪除時的路徑 */
  path: string;
  deletedAt: number;
  /** 刪掉它的裝置 */
  device: string;
  label: string;
  /** 刪除前最後一個歸檔的版本（`restore(path, lastVersion.versionId)` 用）；沒有是 null */
  lastVersion: VaultHistoryEntry | null;
}

/** `vaultAt(T)` 的一筆：時間 T 時存在的一個檔案 */
export interface VaultSnapshotEntry {
  fileId: string;
  /** T 時的路徑 */
  path: string;
  versionId: string;
  hash: string;
  size: number;
  text: boolean;
  /** 那個版本的時間（≤ T） */
  at: number;
  device: string;
  label: string;
  /** 歸檔裡有內容，或內容和這個檔案現在的內容相同（二進位檔只有這種情形） */
  restorable: boolean;
}

/** 還原預覽（`planRestoreVault`）裡的一個檔案 */
export interface VaultRestoreItem {
  fileId: string;
  /** 執行後的路徑：改回、復原是 T 時的路徑；刪除是目前的路徑 */
  path: string;
  /** 目前的路徑（改回、刪除才有） */
  from?: string;
  /** 要還原成的版本（改回、復原）；刪除是目前的版本 */
  versionId: string;
  hash: string;
  size: number;
  text: boolean;
  /** 那個版本的時間 */
  at: number;
  /**
   * 刪了就救不回來（v0.50，SDK ADR 0063〈待決〉裁示 1）：`removeCreatedBinaries` 列入刪除的二進位檔——歸檔沒有內容，
   * 「復原這次還原」也拿不回來。應用要在刪除前自己備份（`restoreVault` 的 `beforeIrreversible`）。
   */
  irreversible?: true;
}

/**
 * 跳過、沒有還原的原因：
 * - `binary`：二進位檔的內容不在歸檔（裁示 2），而且和現在的不同；刪除 T 之後才建立的二進位檔也算（刪了就找不回來）
 * - `content-missing`：文字檔的內容不在歸檔（例如從沒收到、已超出保留範圍），或要覆寫／刪除的現有內容不在歸檔（覆寫了就找不回來）
 * - `out-of-range`：歸檔沒涵蓋這個檔案在 T 時的狀態（保留規則清掉了、或這台那時還沒有它）
 * - `excluded`：路徑在同步排除範圍（ADR 0047）
 * - `not-local`：這個檔案現在的內容不在這台（輕量成員範圍外、或內容還沒到）
 * - `occupied`：要寫的路徑被另一個檔案佔著
 * - `changed`：執行時檔案已經不是預覽時的樣子（例如在那之後被改了、或一直寫不進去）
 * - `scope`：輕量成員不能在那裡寫（`error` 是 `VaultScopeError`）
 * - `backup-failed`：不可復原的刪除（`irreversible`）在刪除前，應用的 `beforeIrreversible` 丟錯或回 false（沒備份就不刪；`error` 是丟出的錯誤）
 * - `error`：其他錯誤（`error`）
 */
export type VaultRestoreSkipReason =
  | 'binary'
  | 'content-missing'
  | 'out-of-range'
  | 'excluded'
  | 'not-local'
  | 'occupied'
  | 'changed'
  | 'scope'
  | 'backup-failed'
  | 'error';

export interface VaultRestoreSkipped {
  fileId: string;
  path: string;
  reason: VaultRestoreSkipReason;
  /** 想還原成的版本（有的話） */
  versionId?: string;
  error?: unknown;
}

/**
 * 時間點的來源（裁示補充 4）：`checkpoint`＝從 T 之前最近的檢查點開始（檢查點那一刻的狀態是確切的；之後到 T 之間有變動的檔案
 * 照各檔歸檔補上，這時 `mixed` 是 true）；`reconstructed`＝沒有檢查點，全部照各檔歸檔推算（`mixed` 一定是 true：
 * 可能組合出從沒同時存在過的版本）。
 */
export type VaultPointSource = 'checkpoint' | 'reconstructed';

/** 檢查點（裁示補充 1–3，參考 git 的 commit／tag）：某一刻整個 Vault 的清單（路徑 → 檔案、版本、內容雜湊），只在這台、不同步 */
export interface VaultCheckpoint {
  id: string;
  /** 建立的時間（混合邏輯時鐘，與版本的 `at` 可以比較） */
  at: number;
  /**
   * `auto`＝同步告一段落時自動建立（最多每小時一個，依稀疏化規則保留）；`restore`＝`restoreVault` 執行前自動建立（「還原之前」，
   * 保留天數內不稀疏化）；`named`＝使用者命名的（不稀疏化、不過期，內容一直保留，最多 50 個）。
   */
  kind: 'auto' | 'restore' | 'named';
  /** 命名檢查點的名稱 */
  name?: string;
  /** 清單裡的檔案數 */
  files: number;
}

/** `vaultAt()` 的結果 */
export interface VaultSnapshot {
  /** 時間 T（指定檢查點時是它的時間） */
  at: number;
  source: VaultPointSource;
  /** 起點的檢查點（`source` 是 `checkpoint` 時） */
  checkpoint?: VaultCheckpoint;
  /** 可能組合了從沒同時存在過的版本（各檔歸檔推算的部分） */
  mixed: boolean;
  files: VaultSnapshotEntry[];
}

/**
 * 一筆操作紀錄為什麼不能復原（v0.50，SDK ADR 0063〈待決〉裁示 2）：
 * - `before-expired`：「還原之前」的檢查點超過保留天數（`keepDays`）過期了
 * - `before-deleted`：那個檢查點被 `deleteCheckpoint` 刪掉了
 * - `before-evicted`：超過容量上限（`maxBytes`）時被清掉了
 * - `no-checkpoint`：這筆沒有「還原之前」的檢查點（單一檔案的 `restore`：從那個檔案的歷史還原就好）
 */
export type VaultUndoUnavailableReason = 'before-expired' | 'before-deleted' | 'before-evicted' | 'no-checkpoint';

/** 本機的操作紀錄（裁示補充 2，參考 git 的 reflog）：每一次還原一筆，新到舊 */
export interface VaultOperation {
  id: string;
  at: number;
  /** `restore-vault`＝`restoreVault`；`restore-file`＝`restore` */
  kind: 'restore-vault' | 'restore-file';
  /** 還原的目標：時間點、檢查點，或單一版本 */
  target: { at?: number; checkpoint?: string; versionId?: string; path?: string };
  /** 還原前自動建立的檢查點（`restore-vault`）：要復原這次還原，就還原到它 */
  before?: string;
  /** 改回、復原了的路徑（最多記 1,000 個；`counts` 是總數） */
  restored: string[];
  /** 刪掉了的路徑（最多 1,000 個） */
  removed: string[];
  /** 跳過的（最多 1,000 個） */
  skipped: Array<{ path: string; reason: VaultRestoreSkipReason }>;
  counts: { restored: number; removed: number; skipped: number };
  /**
   * 現在還能復原（`before` 的檢查點還在）。檢查點跟著歷史的保留天數過期（v0.50 裁示 2 甲），過期後紀錄照留、這裡是 false，
   * 原因在 `undoUnavailable`；應用把「復原」按鈕停用並說明。
   */
  undoAvailable: boolean;
  undoUnavailable?: VaultUndoUnavailableReason;
}

/** 整個 Vault 回到時間 T（或一個檢查點）的預覽（`planRestoreVault`）。只是預覽：`restoreVault(plan)` 才執行 */
export interface VaultRestorePlan {
  /** 時間 T（指定檢查點時是它的時間） */
  at: number;
  /** 從檢查點還是各檔歸檔推算（見 `VaultPointSource`） */
  source?: VaultPointSource;
  /** 起點的檢查點 */
  checkpoint?: VaultCheckpoint;
  /** 可能組合了從沒同時存在過的版本 */
  mixed?: boolean;
  /** 預覽產生的時間 */
  createdAt: number;
  /** 要改回的檔案（內容或路徑和 T 時不同） */
  revert: VaultRestoreItem[];
  /** 要復原的已刪除檔案 */
  undelete: VaultRestoreItem[];
  /** 要刪掉的 T 之後才建立的檔案（`removeCreatedAfter` 打開才有） */
  remove: VaultRestoreItem[];
  /**
   * T 之後才建立、這次**留著**的檔案（`removeCreatedAfter` 沒打開時；v0.53，SDK ADR 0070）：只給預覽顯示，執行時不動。
   * 打開時這些改列 `remove`（或無法還原），這裡是空的。選配：舊版或應用自己組的預覽沒有這一欄。
   */
  keep?: VaultRestoreItem[];
  /** 無法還原的檔案 */
  unrestorable: VaultRestoreSkipped[];
  /** `remove` 裡標 `irreversible` 的檔案（刪了救不回來）的總大小（位元組）；沒有是 0 */
  irreversibleBytes: number;
}

/** `restoreVault(plan, options)` 的選項 */
export interface VaultRestoreOptions {
  /**
   * 每個不可復原的刪除（`irreversible`）**正要刪之前**呼叫一次：應用在這裡備份那個檔案（例如 CinderSync 複製到
   * `.trash/cindersync-backup`）。這時磁碟上的內容已確認和預覽時相同；刪除帶前置條件，備份之後檔案又被改了就不刪（`changed`）。
   * 丟錯或回 `false` ＝ 沒備份，不刪這個檔案（`backup-failed`），其他照常。沒給就直接刪（應用在預覽時已經明確選了
   * `removeCreatedBinaries`）。在協調器的工作佇列裡執行：不要在裡面呼叫這個協調器的其他方法（會互等）。
   */
  beforeIrreversible?: (item: VaultRestoreItem) => boolean | void | Promise<boolean | void>;
}

/** `restoreVault(plan)` 的結果 */
export interface VaultRestoreReport {
  /** 改回、復原了的 */
  restored: VaultRestoreItem[];
  /** 刪掉了的 */
  removed: VaultRestoreItem[];
  /** 預覽裡無法還原的，加上執行時跳過的 */
  skipped: VaultRestoreSkipped[];
}

/** `restore(path, versionId)` 的結果 */
export interface VaultRestoreResult {
  fileId: string;
  path: string;
  /** 還原後這個檔案的版本（`unchanged` 時是現在的版本） */
  versionId: string;
  /** `restored`＝寫入了一個新版本；`unchanged`＝內容本來就相同 */
  outcome: 'restored' | 'unchanged';
}

/** `restore()`、`readHistory()` 的錯誤碼（SDK ADR 0063） */
export type VaultHistoryErrorCode =
  /** 歸檔裡沒有這個版本 */
  | 'unknown'
  /** 這個版本是刪除（要刪檔請直接刪，或用 `restoreVault`） */
  | 'deleted'
  /** 二進位檔的內容不在歸檔，和現在的也不同 */
  | 'binary'
  /** 文字檔的內容不在歸檔；或要覆寫的現有內容不在歸檔（覆寫了就找不回來） */
  | 'content-missing'
  /** 協調器已停止 */
  | 'stopped'
  /** 命名檢查點已經 50 個（不會自動清掉任何一個；請先刪掉不要的） */
  | 'checkpoint-limit'
  /** 沒有這個檢查點 */
  | 'checkpoint-unknown'
  /** 這個「還原之前」的檢查點已經跟著保留天數過期（操作紀錄的 `undoUnavailable: 'before-expired'`），不能再復原那次還原 */
  | 'checkpoint-expired'
  /** 名稱不合格（空的、超過 100 字）或已經有同名的檢查點 */
  | 'checkpoint-name';
