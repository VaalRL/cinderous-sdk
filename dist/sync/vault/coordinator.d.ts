import { type StreamingFileStore, type StreamTransferOptions } from '../../transfer/stream.js';
import { type FileTombstone } from '../tombstones.js';
import { type PathFilter } from './path-filter.js';
import { type RelayFileLimits } from './relay-check.js';
import type { LocalChangeKind, SyncStateStore, VaultAdapter, VaultCheckpoint, VaultContentScope, VaultEvictResult, VaultDeletedFile, VaultHistoryEntry, VaultHistoryOptions, VaultOperation, VaultPathScope, VaultPeerLink, VaultPeerScopes, VaultRemoteEntry, VaultRemoteChange, VaultRestoreOptions, VaultRestorePlan, VaultRestoreReport, VaultRestoreResult, VaultSnapshot, VaultSentResult, VaultSyncClock, VaultSyncEventMap, VaultSyncStatus, VaultSyncTransport, VaultPeerStatus, VaultTransferProgress } from './types.js';
/** 預設可以做行級合併的副檔名 */
export declare const DEFAULT_TEXT_EXTENSIONS: readonly string[];
/** 每個檔案保留的版本數（超過就修剪最舊的；修剪後找不到共同祖先時退回衝突副本，不會遺失資料） */
export declare const DEFAULT_MAX_VERSIONS_PER_FILE = 64;
/** 文字檔保留內容、可當三方合併祖先的最近版本數 */
export declare const DEFAULT_BASE_VERSIONS_KEPT = 8;
/** 等不到父版本多久之後，就當作它已遺失、直接併入（毫秒；預設一天） */
export declare const DEFAULT_ORPHAN_AFTER_MS: number;
/** 同一個版本多久才重新索取一次（毫秒） */
export declare const DEFAULT_WANT_INTERVAL_MS: number;
/** 索取先收集這麼久再一起送（SDK ADR 0104）：新裝置加入時一個檔一則，會把同一身分的事件預算吃光 */
export declare const WANT_BATCH_MS = 100;
/** 送出失敗的退避（毫秒） */
export declare const DEFAULT_RETRY_INITIAL_MS = 1000;
export declare const DEFAULT_RETRY_MAX_MS: number;
/** 摘要每則最多幾個檔案 */
export declare const DEFAULT_DIGEST_CHUNK = 400;
/** 自己暫時搬開檔案用的名稱（改名成環時）；預設忽略 */
export declare const SWAP_SUFFIX: RegExp;
/** 待送出的版本達到這個數量就進入批次模式，改走 P2P 批次串流（SDK ADR 0026；PRD：N ≥ 10） */
export declare const DEFAULT_BULK_THRESHOLD = 10;
/**
 * 名單上的能力宣告：這台看得懂 `bundle`（SDK ADR 0095）。應用把宣告了的裝置交給 `bundleDevices`／`setBundleDevices`。
 */
export declare const BUNDLE_CAPABILITY = "vaultBundles";
/**
 * 批次模式下，走中繼（kind 1060，會存在中繼上 7 天）的補送**訊息數**上限：每小時幾則（平滑用）。
 *
 * ⚠ 它數的是「則」不是「塊」：一則帶內容的訊息可能有幾百塊。v0.25 起真正守住中繼配額的是
 * 塊數預算（`relayLimits`，SDK ADR 0029）：任何一段保存期內寄給同一位收件人的塊數 ≤ 配額 × 0.75。
 * 這個上限保留，讓小訊息的補送維持原本的節奏。
 */
export declare const DEFAULT_RELAY_BULK_PER_HOUR = 20;
/** P2P 連不上時的重試退避（毫秒）：從 30 秒起倍增到 30 分鐘；對方送摘要或主動連上來時立刻重試 */
export declare const DEFAULT_P2P_RETRY_INITIAL_MS = 30000;
export declare const DEFAULT_P2P_RETRY_MAX_MS: number;
/** 收到某台的訊息就排直連（SDK ADR 0090）：同一台多久最多觸發一次（中繼補送的舊訊息可能一次來很多則） */
export declare const P2P_POKE_INTERVAL_MS = 60000;
/** 沒給 `staging`（大檔暫存放記憶體）時，P2P 收大檔的單檔上限 */
export declare const DEFAULT_MEMORY_STAGING_MAX_BYTES: number;
export interface VaultSyncOptions {
    adapter: VaultAdapter;
    store: SyncStateStore;
    transport: VaultSyncTransport;
    /** 這台裝置的固定識別碼（英數與 `_.:-`，最長 64） */
    deviceId: string;
    /** 衝突副本檔名裡的裝置名稱（最長 64 字；沒給或空的用 deviceId）；執行中改名用 `setDeviceLabel` */
    deviceLabel?: string;
    clock?: VaultSyncClock;
    /** 32 位 hex 的隨機 id；預設用 CSPRNG */
    randomId?: () => string;
    /** 能不能做行級合併；預設看副檔名、大小（≤ 快照層上限）與是否為合法 UTF-8。結果記在版本裡，各裝置一致 */
    isText?: (path: string, bytes: Uint8Array) => boolean;
    /**
     * 不同步的路徑（例如 `.obsidian/`、`.trash/`）。v0.36 以前的做法，行為不變：已經追蹤的檔案之後變成被忽略時不會停止追蹤。
     * 新的應用請改用 `excludes`（排除不等於刪除、執行中可更新；SDK ADR 0047）。
     */
    ignore?: (path: string) => boolean;
    /**
     * 同步排除範圍（SDK ADR 0047），通常是 `compileSyncExcludes({ fixed, user })`。執行中用 `setExcludes` 更新。
     * - 被排除的已追蹤檔案**停止追蹤**：不產生刪除版本、其他裝置照常保留它們的副本；本機檔案不動。
     * - 收到其他裝置對被排除路徑的版本：記進版本圖（對帳不會反覆索取）但**不寫入**本機。
     * - 從排除移除：重新掃描，本機檔案重新納入（與期間別台的修改照常合併），或當作新檔加入。
     * - 排除規則是每台裝置自己的設定，各台可以不同。
     * 省略＝與 v0.36 相同。
     */
    excludes?: PathFilter | ((path: string) => boolean);
    /** 自己執行遠端變更；沒給就經 `adapter` */
    applyRemote?: (change: VaultRemoteChange) => Promise<boolean | void>;
    /** 判斷兩個路徑是不是「同一個位置」；預設 NFC＋小寫（大小寫不分的檔案系統也安全） */
    pathKey?: (path: string) => string;
    /** 啟動時全量掃描一次，找出離線期間的變更；預設 true */
    scanOnStart?: boolean;
    retryInitialMs?: number;
    retryMaxMs?: number;
    /** 背景維護（重新索取、併入孤兒、清墓碑）的間隔；0 關閉。預設 60 秒 */
    tickMs?: number;
    orphanAfterMs?: number;
    wantIntervalMs?: number;
    /** 離線超過這麼久算沉睡裝置，暫停合併等使用者確認；預設 30 天 */
    staleAfterMs?: number;
    maxVersionsPerFile?: number;
    digestChunk?: number;
    /**
     * 與其他裝置的直連通道（SDK ADR 0026）。有的話：大量變更（新裝置加入、批次搬移）改走 P2P 批次串流，
     * 大檔內容經 P2P 直送；沒有就維持 ADR 0025 的行為（全部走中繼）。
     */
    peers?: VaultPeerLink;
    /** 待送出的版本達到多少就進入批次模式；預設 10 */
    bulkThreshold?: number;
    /**
     * 收件端回簽收單（SDK ADR 0068）：處理完、保存了經傳輸層收到的訊息之後，把寄件序號的區間送回給那位寄件人，
     * 寄件端據此劃掉送給這台的帳（中繼預算按收件人記帳），也知道這台已經有那些版本。預設 true；false＝像舊版一樣不簽收。
     */
    receipts?: boolean;
    /** 批次模式下走中繼補送的訊息數上限（每小時幾則，平滑用）；預設 20。配額由 `relayLimits` 守 */
    relayBulkPerHour?: number;
    /**
     * 目標中繼的檔案限制（SDK ADR 0029），通常來自 `loadRelayFileLimits(relayUrls)`（讀 NIP-11）：
     * - `maxFileBytes`：多大以內的檔案內容經中繼送（更大的只走 P2P）。預設 `FILE_TIER_MAX_BYTES`（≈16.5 MB）。
     *   🔴 調大之前，同一個 Vault 的每一台裝置都要是 v0.25 以上——舊版收端只收得下 16.5 MB，更大的會被丟掉。
     * - `chunksPerRecipient`、`retentionSeconds`：批次模式下，任何一段保存期內寄給同一位收件人的檔案塊
     *   不超過 `chunksPerRecipient × 0.75`（不會把收件人還沒領的塊擠掉）。預設保守值 848 塊／7 天。
     * 執行中可用 `setRelayLimits` 更新。
     */
    relayLimits?: Partial<Pick<RelayFileLimits, 'maxFileBytes' | 'chunksPerRecipient' | 'retentionSeconds'>>;
    /**
     * 名單上所有成員都收得下的單檔上限（SDK ADR 0035 §G9），通常是 `membership.minCapability()`（`@cinderous/client/pairing`）。
     * 經中繼送的門檻＝min(中繼的 `maxFileBytes`, 這裡的 `maxRelayFileBytes`)。省略＝不設限（與 v0.29 相同，只看中繼）。
     * 執行中可用 `setMemberCapabilities` 更新（名單 `change` 時呼叫）。
     */
    memberCapabilities?: {
        maxRelayFileBytes: number;
    };
    /** P2P 收到的大檔先寫到哪裡（校驗通過才寫進 Vault）；預設記憶體。要跨重開續傳請給持久化的實作 */
    staging?: StreamingFileStore;
    p2pRetryInitialMs?: number;
    p2pRetryMaxMs?: number;
    /** 批次串流的參數（視窗、逾時等）；計時器預設用 `clock` */
    stream?: StreamTransferOptions;
    /**
     * 重新連上時要不要送摘要（SDK ADR 0045，G12c）。摘要讓其他裝置補送或索取缺的版本頭（SDK ADR 0028）。
     * - `'on-connect'`（預設，v0.35 的行為）：每次離線 → 在線都送一份。
     * - `'on-change'`：從上一份摘要之後，這台有新的版本要廣播（本機修改、合併）才送；從沒送過、或距離上一份超過
     *   `digestMaxIntervalMs` 也送。排程同步「沒有修改的一輪」因此一則事件都不發（收照樣收）。
     * - `'manual'`：從不自動送，只有 `resync()` 會送。
     * `resync()` 永遠照送。
     */
    digestPolicy?: 'on-connect' | 'on-change' | 'manual';
    /** 連上時的自動摘要至少間隔多久（毫秒；`'on-connect'` 與 `'on-change'` 都適用）；預設 0（不限） */
    digestMinIntervalMs?: number;
    /** `'on-change'`：沒有修改時，距離上一份摘要超過這麼久照樣送一份（定期對帳）；預設一天，0＝不定期送 */
    digestMaxIntervalMs?: number;
    /**
     * Markdown 同一行衝突改用就地 callout（SDK ADR 0046）：這台寫出的版本帶「支援 callout」的標記（記在版本 id 裡）。
     * 只有參與合併的**所有**版本頭都帶標記時，合併才用 callout（`> [!conflict]`，裡面放每一個版本、標示裝置名稱與 UTC 時間），
     * 否則照舊產生衝突副本——由版本資料決定，每台裝置算出同一個結果。預設 false（v0.35 的行為：這台的版本不帶標記）。
     * 解析與解決：`parseConflictCallouts`、`resolveConflictCallout`。
     */
    conflictCallouts?: boolean;
    /**
     * Markdown 合併規則（SDK ADR 0059）：這台寫出的版本帶「支援合併規則」的標記（記在版本 id 裡）。只有參與的**所有**版本都帶標記時：
     * - 兩台各自新建同一個路徑的文字檔（例如同一天的 daily note）：不再把較晚的改名成衝突副本，而是**以空檔為共同祖先三方合併**成一個檔案，
     *   合不了的地方照舊放 callout（Markdown＋`conflictCallouts`）或衝突副本；
     * - 衝突區塊兩邊只差在任務勾選狀態（`- [ ]`／`- [x]`，含 Tasks 的 `✅ YYYY-MM-DD`）：自動合併，已勾的贏。
     * 由版本資料決定，每台裝置算出同一個結果。**請在名單上所有成員都宣告支援之後才打開**（`membership.allDeclare(MERGE_RULES_CAPABILITY)`），
     * 執行中用 `setMergeRules` 切換。預設 false（v0.45 的行為）。
     */
    mergeRules?: boolean;
    /**
     * 看得懂 `bundle` 的裝置（deviceId；SDK ADR 0095）：通常是名單上宣告了 `BUNDLE_CAPABILITY` 的。佇列裡同一組收件人有兩個以上的
     * 小版本、而且收件人**全部**在這裡（都不是輕量成員）時，連同內容合成一則（不超過一個訊框）。執行中用 `setBundleDevices` 更新。
     * 預設空＝不合（v0.67 的行為）。
     */
    bundleDevices?: readonly string[];
    /**
     * 衝突 callout 後空一行（SDK ADR 0087）：這台寫出的版本帶「支援新格式」的標記（記在版本 id 裡）。只有參與合併的**所有**版本頭都帶標記時，
     * callout 的標題多一個 `%% cinder-break %%`、callout 後固定接一個空行（Obsidian 不再把下一行內文算進 callout）。
     * **請在名單上所有成員都宣告支援之後才打開**（`membership.allDeclare(CALLOUT_BREAK_CAPABILITY)`），執行中用 `setCalloutBreak` 切換。
     * 預設 false（v0.60 的格式）。
     */
    calloutBreak?: boolean;
    /**
     * 輕量成員（SDK ADR 0058）：這台知道整個 Vault 的版本資訊，但只保存、只寫入**內容範圍**內的檔案內容。
     * 省略＝完整成員（v0.45 的行為）。執行中用 `setScope` 更新。見 {@link VaultContentScope}。
     */
    scope?: VaultContentScope | null;
    /**
     * 名單上宣告為輕量成員的**其他**裝置與它們的內容範圍（deviceId → 規則／濾網）：送給它們的版本，範圍外的只帶版本資訊、不帶內容
     * （中繼、直連、初次補送都一樣；它們明確索取的照樣給）。通常來自名單：`sparsePeerScopes(membership)`。執行中用 `setPeerScopes` 更新。
     */
    peerScopes?: VaultPeerScopes;
    /** 直連進度事件（`on('progress')`）每次傳輸最多多久通知一次（毫秒）；預設 250，0＝每段資料都通知（SDK ADR 0053 §G14） */
    progressIntervalMs?: number;
    /**
     * 版本歷史（SDK ADR 0063）：本機歸檔每個檔案的版本（本機產生的與收到的都算），可以列出、讀取、還原、整個 Vault 回到時間點。
     * 只在這台、不同步，中繼不變。預設完整成員開（30 天、每檔 100 版、1 GiB），輕量成員關。執行中用 `setHistory` 更新。
     */
    history?: VaultHistoryOptions;
    /**
     * 自動檢查點由誰決定時機（SDK ADR 0072）：`'idle'`（預設）＝協調器在同步告一段落時建立，最多每小時一個；
     * `'app'`＝協調器自己不建，由應用在它認定的時間點呼叫 `checkpoint({ auto: true, minIntervalMs })`（例如每一輪同步成功之後，
     * 間隔照應用的同步頻率）。還原之前的檢查點與命名檢查點不受影響。
     */
    autoCheckpoint?: 'idle' | 'app';
}
/** `progressIntervalMs` 的預設 */
export declare const DEFAULT_PROGRESS_INTERVAL_MS = 250;
/** `digestMaxIntervalMs` 的預設：一天 */
export declare const DEFAULT_DIGEST_MAX_INTERVAL_MS: number;
type Listener<K extends keyof VaultSyncEventMap> = (payload: VaultSyncEventMap[K]) => void;
/** 預設的文字判斷：副檔名、大小、合法 UTF-8 */
export declare function defaultIsText(path: string, bytes: Uint8Array): boolean;
export declare function defaultPathKey(path: string): string;
/**
 * 檔案樹同步協調器。一個 Vault 一個實例。
 *
 * ```ts
 * const sync = new VaultSyncCoordinator({ adapter, store, transport, deviceId, deviceLabel: 'MacBook' });
 * sync.on('status', (s) => statusBar.setText(`${s.state} (${s.queue})`));
 * await sync.start();
 * vault.on('modify', (f) => sync.notifyLocalChange(f.path, 'modify'));
 * vault.on('rename', (f, old) => sync.notifyLocalChange(f.path, 'rename', old));
 * ```
 */
export declare class VaultSyncCoordinator {
    #private;
    constructor(options: VaultSyncOptions);
    get deviceId(): string;
    /**
     * 更新目標中繼的檔案限制（SDK ADR 0029）；通常在連線後以 `loadRelayFileLimits(relayUrls)` 讀 NIP-11 取得。
     * 只影響之後建立的版本與之後的補送；已經建立的版本走哪一層不變。沒給的欄位維持原值。
     */
    setRelayLimits(limits: Partial<Pick<RelayFileLimits, 'maxFileBytes' | 'chunksPerRecipient' | 'retentionSeconds'>>): void;
    /**
     * 更新「所有成員都收得下」的單檔上限（SDK ADR 0035 §G9）：`membership.onChange(() => sync.setMemberCapabilities(membership.minCapability()))`。
     * 名單上還有舊版（沒有能力宣告）時 `minCapability()` 給 16.5 MB，中繼門檻再大也不會送更大的檔給它。
     */
    setMemberCapabilities(caps: {
        maxRelayFileBytes: number;
    }): void;
    /** 更新看得懂 `bundle` 的裝置（SDK ADR 0095）：名單 `change` 時，把宣告了 `BUNDLE_CAPABILITY` 的裝置交進來 */
    setBundleDevices(devices: readonly string[]): void;
    /**
     * 改這台的裝置名稱（SDK ADR 0069）：之後產生的版本與衝突副本檔名用新名稱，已經產生的不回溯改。
     * 規則同建構時的 `deviceLabel`（最長 64 字；空的用 deviceId）。名單上的名稱另外以 `membership.declareLabel` 宣告。
     */
    setDeviceLabel(label: string): void;
    /**
     * 打開或關掉 Markdown 合併規則（SDK ADR 0059）：只影響之後這台寫出的版本帶不帶標記；合併時一律看版本資料，每台一致。
     * 名單 `change` 時：`sync.setMergeRules(membership.allDeclare(MERGE_RULES_CAPABILITY))`——有任何一台（含舊版）沒宣告就關。
     */
    setMergeRules(on: boolean): void;
    /** 這台寫出的版本目前帶不帶「支援 Markdown 合併規則」的標記 */
    get mergeRules(): boolean;
    /**
     * 打開或關掉「衝突 callout 後空一行」（SDK ADR 0087）：只影響之後這台寫出的版本帶不帶標記；合併時一律看版本資料，每台一致。
     * 名單 `change` 時：`sync.setCalloutBreak(membership.allDeclare(CALLOUT_BREAK_CAPABILITY))`——有任何一台（含舊版）沒宣告就關。
     */
    setCalloutBreak(on: boolean): void;
    /** 這台寫出的版本目前帶不帶「支援 callout 後空一行」的標記 */
    get calloutBreak(): boolean;
    /**
     * 其他輕量成員的內容範圍（SDK ADR 0058）：`sync.setPeerScopes(sparsePeerScopes(membership))`，名單 `change` 時再呼叫。
     * 之後送給它們的版本，範圍外的只帶版本資訊；`null`／空物件＝大家都是完整成員。
     */
    setPeerScopes(scopes: VaultPeerScopes | null): void;
    /** 宣告為輕量成員的其他裝置（deviceId，排序） */
    sparsePeers(): string[];
    /**
     * 更新這台的內容範圍（SDK ADR 0058）；`null`＝改回完整成員（所有檔案的內容都會補抓回來）。
     * 離開範圍的本機檔案清掉（**不產生刪除版本**，有還沒送出的修改就等送出後再清）；進入範圍的檔案向其他裝置索取內容。
     * 回傳的 Promise 在重新套用完成後 resolve（不等內容下載完）。別忘了同步更新名單上的宣告（`membership.declareSparse`）。
     */
    setScope(scope: VaultContentScope | null): Promise<void>;
    /** 這台是不是輕量成員（有內容範圍） */
    get sparse(): boolean;
    /** 這個路徑能不能在這台新增（SDK ADR 0058 §裁示 3；完整成員、或沒設定 `scope.create` 時一律可以） */
    canCreate(path: string): boolean;
    /**
     * 這台所知的**每一個**檔案（SDK ADR 0058）：含內容不在這台、只有版本資訊的（輕量成員看得到整個 Vault 的架構）。
     * 刪除了、墓碑還在保留期內的也列（`deleted`）。依路徑排序。完整成員也能用（`local` 幾乎都是 true）。
     */
    remoteIndex(): VaultRemoteEntry[];
    /** 依路徑（比對方式同 `pathKey`，預設不分大小寫）找一個檔案；沒刪除的優先。不認得回 null（SDK ADR 0058） */
    lookup(path: string): VaultRemoteEntry | null;
    /**
     * 按需取得一個檔案的內容（SDK ADR 0058）：內容已經在這台就直接回傳；否則把它加進快取（LRU，上限 `scope.cacheBytes`）、
     * 向其他裝置索取（`want`，帶 `fetch`：完整成員回應時不裁剪），收到後寫進磁碟再回傳。大檔（只走直連）請完整成員直送。
     *
     * 失敗丟 `VaultScopeError`：`unknown`（不認得）、`deleted`、`excluded`（被 `excludes`／`ignore` 排除）、`timeout`（給了 `timeoutMs`、
     * 到了還沒到；下載仍在背景進行，之後可以再呼叫）、`stopped`。完整成員也能用（等還沒到的內容）。
     */
    fetch(target: string | {
        fileId: string;
    }, options?: {
        timeoutMs?: number;
    }): Promise<Uint8Array>;
    /**
     * 釘選（SDK ADR 0058）：這個檔案的內容一直留在這台（不受 LRU 與內容範圍影響），內容不在就向其他裝置索取。
     * 釘的是檔案（fileId），改名後仍然釘著。不認得的路徑丟 `VaultScopeError('unknown')`。
     */
    pin(path: string): Promise<void>;
    /** 取消釘選：檔案變成一般的快取（最近使用），之後依 LRU 與內容範圍決定要不要清掉 */
    unpin(path: string): Promise<void>;
    /** 釘選的檔案（路徑，排序） */
    pinned(): string[];
    /**
     * 安全地清掉本機的一份內容（SDK ADR 0058）：刪掉磁碟上的檔案與保存的內容，但**不產生刪除版本**——其他裝置照常保留，
     * 之後重新納入（內容範圍、釘選、`fetch`、`setExcludes` 移除排除）時當成要重新抓，不會被當成「使用者刪了它」。
     *
     * - 輕量成員：範圍外（快取、取消釘選的）檔案可以清；在內容範圍內的回 `in-scope`（清了會立刻再抓回來）。
     *   有還沒送出的本機修改時先收成版本、回 `unsent`，送出後自動清掉。釘選的會一併取消釘選。
     * - 完整成員與輕量成員都可以清**因排除而停止追蹤**的本機副本（`detached()`）：本機改過就不清（`modified`，否則修改會遺失）。
     *   這修掉 ADR 0047 的風險：應用自己刪掉被排除的檔案，重新納入時會被當成「使用者刪了」而產生刪除版本。
     */
    evict(path: string): Promise<VaultEvictResult>;
    /**
     * 被擋下、沒有同步的本機新增（SDK ADR 0058）：`base-missing`（在內容不在這台的檔案路徑上建立了檔案，要先 `fetch`）、
     * `create-outside`（不在允許新增的範圍）。檔案留在本機原處，協調器不碰。
     */
    blockedLocal(): Array<{
        path: string;
        code: 'base-missing' | 'create-outside';
    }>;
    /**
     * 批次模式下經中繼補送的速率（每小時幾則；SDK ADR 0053 §G16，CinderSync G16）。執行中改、立刻生效：
     * 例如有可用的直連時調成 0（**暫停**經中繼補送，只走 P2P），直連斷了再調回來。小數取整數；負數或 NaN 丟 `RangeError`。
     * 塊數預算（`relayLimits`）照樣守著。建構時的 `relayBulkPerHour` 行為不變（最小 1）。
     */
    setRelayBulkPerHour(perHour: number): void;
    /** 目前批次模式下經中繼補送的速率（每小時幾則；0＝暫停） */
    get relayBulkPerHour(): number;
    /**
     * 重設 P2P 的重試退避、立刻再試一次（SDK ADR 0053 §G15，CinderSync G15）。給應用「知道對方剛上線」或「網路剛恢復」時用，
     * 不必等退避（最長 30 分鐘）結束；省略 `device`＝名單上每一台。名單外的裝置、自己的 id 忽略。沒有 `peers` 時什麼都不做。
     * 指定 `device` 時也開（或沿用）到它的通道並掛上收方（v0.44.0）：應用自己開通道探測對方之後呼叫，對方經那條通道送來的收得到。
     */
    retryPeers(device?: string): void;
    /**
     * 這台所知的另一台裝置的接收狀態（SDK ADR 0053 §G17，CinderSync G17）：最後一次看到它、最後一次收齊它的摘要、
     * 這台目前的版本裡（含刪除）它還沒有的檔案數。只用已經在收送的訊息（它送來的版本與摘要、直連批次的送達確認），
     * 不為它多送任何東西；經中繼送出的版本要等它的下一份摘要或下一個版本才知道收到了。
     */
    peerStatus(device: string): VaultPeerStatus;
    /** 名單上每一台（`peers`）加上曾經看到過的裝置的接收狀態，依裝置 id 排序 */
    peerStatuses(): VaultPeerStatus[];
    /**
     * 這台記得的、那台裝置每個檔案已知的版本頭（SDK ADR 0053 §G17）；只列有記錄的檔案。唯讀的複本。
     * 每個檔案最多記 8 個（祖先被後代涵蓋時只留後代）。
     */
    knownHeads(device: string): Array<{
        fileId: string;
        heads: string[];
    }>;
    /**
     * 應用在協調器之外看到那台裝置有動靜（例如名單同步收到它的名單、直連握手成功）時通報，更新 `lastSeenAt`（SDK ADR 0053 §G17）。
     * `at` 省略＝現在；比已記錄的舊就不動。自己的 id 忽略。
     */
    notePeerActivity(device: string, at?: number): void;
    /**
     * 進行中的直連傳輸（SDK ADR 0053 §G14，CinderSync G14）：每一條批次串流（送或收）一筆，含對方裝置、通道種類、
     * 檔案數與位元組數、正在傳的檔案。結束的不列（最後一次 `progress` 事件帶 `ended`）。累計位元組見 `status().p2pBytes`。
     */
    transfers(): VaultTransferProgress[];
    /**
     * 更新同步排除範圍（SDK ADR 0047），例如使用者在設定頁改了排除清單：`sync.setExcludes(compileSyncExcludes({ fixed, user }))`。
     * `null`＝不排除（`ignore` 仍然有效）。**排除不等於刪除**：
     * - 變成被排除的已追蹤檔案停止追蹤：不產生刪除版本，其他裝置照常保留；本機檔案不動。
     * - 從排除移除：重新掃描；停止追蹤的檔案重新納入（期間本機與別台的修改照常合併；內容一樣就什麼都不做），
     *   沒有追蹤紀錄的本機檔案當作新檔加入（別台同路徑同內容會收斂，不同內容產生衝突副本），
     *   這台還沒有的遠端檔案寫入本機。
     * 回傳的 Promise 在重新掃描與套用完成後 resolve（不含網路送出）。
     */
    setExcludes(filter: PathFilter | ((path: string) => boolean) | null): Promise<void>;
    /** 這個路徑會不會被同步（`ignore`、`excludes`、協調器自己的暫存名稱）。監聽器可以先用它過濾（SDK ADR 0047） */
    isExcluded(path: string): boolean;
    /**
     * 因排除而停止追蹤、本機仍保留的檔案（SDK ADR 0047）。`excluded`：路徑在本機的排除範圍；
     * `moved-out`：其他裝置把它搬進了本機排除的範圍，本機在原路徑留著一份不再同步的副本（修改後會當作新檔加入）。
     */
    detached(): Array<{
        fileId: string;
        path: string;
        reason: 'excluded' | 'moved-out';
    }>;
    /** 目前經中繼送的單檔門檻（位元組）：min(中繼宣告, 所有成員都收得下)。更大的只走 P2P */
    get relayMaxFileBytes(): number;
    /** 讀回持久化狀態、（預設）全量掃描一次、開始收送。 */
    start(): Promise<void>;
    /** 停止收送、等排隊中的工作與寫入完成。狀態都已持久化，之後可以用新的實例 `start()` 接續。 */
    stop(): Promise<void>;
    /**
     * 外掛收到 Vault 事件時呼叫（建議先防抖）。改名請傳 `oldPath`：改名是**一個**操作，
     * 保留檔案身分，別台同時對舊路徑的修改會跟著套到新路徑上。
     */
    notifyLocalChange(path: string, kind?: LocalChangeKind, oldPath?: string): Promise<void>;
    /** 全量掃描：列出所有檔案，和索引比對（先比大小與修改時間，有差才讀內容）。O(n)。 */
    scan(): Promise<void>;
    /** 沉睡裝置（離線超過 30 天）回來時，使用者確認後呼叫，才開始合併與送出。 */
    confirmStaleResume(): Promise<void>;
    /** 第 3 批（P2P）送來大檔內容時呼叫；雜湊不符會丟例外。 */
    supplyContent(fileId: string, versionId: string, bytes: Uint8Array): Promise<void>;
    /** 讀某個版本的內容（第 3 批送大檔時用）；拿不到回 null。 */
    readVersionContent(fileId: string, versionId: string): Promise<Uint8Array | null>;
    /** 路徑 → 版本索引（目前磁碟上的每個同步中檔案）。 */
    index(): Array<{
        fileId: string;
        path: string;
        versionId: string;
        hash: string;
        size: number;
    }>;
    /** 已刪除、墓碑還在保留期內的檔案。 */
    tombstones(): FileTombstone[];
    /**
     * 更新版本歷史的保留規則（SDK ADR 0063）；沒給的欄位維持原值。調小立刻套用（稀疏化、清掉過期與超量的）；
     * 從關閉改成打開時，版本圖裡還留著的版本補進歸檔。
     */
    setHistory(options: VaultHistoryOptions): Promise<void>;
    /**
     * 版本歷史的概況：是否開啟、歸檔的檔案數與版本數、檢查點數、內容佔用（位元組）與上限。從每檔摘要算，不讀完整的歸檔。
     * `bytes`：各檔參照的內容（同一個檔案裡以雜湊去重；不同檔案剛好內容相同時各算一次，磁碟上只存一份）加上只有檢查點留著的內容。
     * `pinnedBytes`：命名檢查點留著的內容（不受保留天數與 `maxBytes` 限制，`bytes` 也含它；上限只管其餘的）。
     */
    historyStatus(): {
        enabled: boolean;
        files: number;
        versions: number;
        checkpoints: number;
        bytes: number;
        pinnedBytes: number;
        maxBytes: number;
    };
    /**
     * 一個檔案的歸檔版本，新到舊（SDK ADR 0063）。含已刪除的檔案；改名前的版本也在（同一個檔案身分）。
     * 字串先當 fileId，否則當路徑（比對方式同 `pathKey`）：現在（或最後）在這個路徑上的檔案，沒有就找曾經在這個路徑上的。
     * v0.50 起是非同步的：第一次用到某個檔案時才讀它完整的歸檔，之後放在快取裡（LRU，有上限）。
     */
    history(target: string | {
        fileId: string;
    }): Promise<VaultHistoryEntry[]>;
    /**
     * 讀一個歸檔版本的內容（SDK ADR 0063）：文字檔從歸檔讀；二進位檔（不歸檔內容）只有在內容和這個檔案現在的相同時讀得到。
     * 刪除版本、讀不到回 null。給 `{ fileId, versionId }`（例如 `history()` 回來的那一筆）最快；只給版本 id 時先找快取、
     * 摘要與版本圖，都沒有才逐檔找。
     */
    readHistory(version: string | {
        fileId: string;
        versionId: string;
    }): Promise<Uint8Array | null>;
    /**
     * 把一個歸檔版本的內容寫回 `path`（SDK ADR 0063）：當成**新的本機修改**——寫入走一般的寫入路徑（`applyRemote` 或轉接器，
     * 帶前置條件），再像 `notifyLocalChange` 一樣收成版本（父版本＝目前的版本頭），照常同步，**不改寫歷史**。
     * - `path` 上有同步中的檔案：寫成它的新版本（版本屬於另一個檔案也一樣）；內容本來就相同回 `unchanged`。
     *   寫入前先把磁碟上還沒通知的修改收成版本（歸檔），不會遺失；要覆寫的內容不在歸檔就不寫（`content-missing`）。
     * - `path` 上沒有：版本所屬的檔案已刪除（或內容不在這台）就讓它在 `path` 復活（同一個檔案身分）；否則新增一個檔案。
     * 記一筆操作紀錄（`operations()`）。`version` 可以是版本 id 或 `{ fileId, versionId }`（同 `readHistory`）。
     *
     * 失敗丟 `VaultHistoryError`（`unknown`、`deleted`、`binary`、`content-missing`、`stopped`）或 `VaultScopeError`
     * （`excluded`；輕量成員的 `base-missing`、`create-outside`）。
     */
    restore(path: string, version: string | {
        fileId: string;
        versionId: string;
    }): Promise<VaultRestoreResult>;
    /**
     * 最近刪除的檔案（最後一版是刪除），新到舊（SDK ADR 0063）。`since`：只列這個時間（毫秒）之後刪的。
     * 從每檔摘要算（同步、不讀完整的歸檔）。
     */
    deletedFiles(options?: {
        since?: number;
    }): VaultDeletedFile[];
    /**
     * 整個 Vault 在時間 T（或一個檢查點）的狀態（SDK ADR 0063 裁示 6、補充 4）。優先從 T 之前最近的檢查點開始（`source: 'checkpoint'`；
     * 那一刻的狀態是確切的，之後到 T 之間有變動的檔案照各檔歸檔補上，這時 `mixed` 是 true）；沒有檢查點才全部照各檔歸檔推算
     * （`source: 'reconstructed'`，`mixed` 一定是 true：每個檔案取 `at ≤ T` 的最後一版，可能組合出從沒同時存在過的版本）。
     * 路徑是 T 時的路徑。只涵蓋這台的歸檔（保留規則與稀疏化之內、這台加入之後、輕量成員只有內容範圍）。依路徑排序。
     * 逐檔讀（摘要夠用的檔案不讀完整的歸檔），不把整個歸檔留在記憶體。
     * 不認得的檢查點丟 `VaultHistoryError('checkpoint-unknown')`；跟著保留天數過期的「還原之前」檢查點丟 `checkpoint-expired`。
     */
    vaultAt(target: number | {
        checkpoint: string;
    }): Promise<VaultSnapshot>;
    /**
     * 整個 Vault 回到時間 T 或一個檢查點的**預覽**（SDK ADR 0063 裁示 6、補充 4）：要改回的、要復原的已刪除檔案、`removeCreatedAfter`
     * 打開時要刪掉的 T 之後才建立的檔案（預設不刪）、無法還原的。時間點的解法同 `vaultAt`（`source`、`checkpoint`、`mixed`）。
     * `paths`：只看這些路徑（排除清單的語法、`{ includes }` 或函式；T 時或現在的路徑符合就算），例如只還原一個資料夾。
     * `removeCreatedBinaries`（v0.50；只在 `removeCreatedAfter` 打開時有效）：T 之後建立的二進位檔也刪，標 `irreversible`
     * （歸檔沒有內容，刪了救不回來），總大小在 `irreversibleBytes`；應用要在 `restoreVault` 的 `beforeIrreversible` 裡先備份。
     * 不動任何東西；`restoreVault(plan)` 才執行。v0.50 起是非同步的（逐檔讀歸檔）。
     *
     * ```ts
     * await sync.planRestoreVault(Date.parse('2026-10-08T09:00'), { paths: ['Projects/'] });
     * await sync.planRestoreVault({ checkpoint: id, removeCreatedAfter: true });
     * ```
     */
    planRestoreVault(target: number | {
        at?: number;
        checkpoint?: string;
        paths?: VaultPathScope;
        removeCreatedAfter?: boolean;
        removeCreatedBinaries?: boolean;
    }, options?: {
        paths?: VaultPathScope;
        removeCreatedAfter?: boolean;
        removeCreatedBinaries?: boolean;
    }): Promise<VaultRestorePlan>;
    /**
     * 照預覽執行（SDK ADR 0063 裁示 6、補充 2）：先自動建立一個「還原之前」的檢查點（`kind: 'restore'`），再逐檔做成新的本機修改、
     * 改名或刪除（照常同步，**不改寫歷史**）：先刪（`remove`），再改回路徑（互換名字等成環的先改到空著的路徑）與內容，最後復原已刪除的檔案。
     * 無法還原的跳過並回報，不會中途丟出（輕量成員的範圍錯誤回報成 `scope`）。執行時檔案已經不是預覽時的樣子（例如要刪的檔案之後被改了）
     * 就跳過（`changed`）。記一筆操作紀錄（`operations()`，`before` 是那個檢查點）：要復原這次還原，就
     * `restoreVault(await planRestoreVault({ checkpoint: op.before, removeCreatedAfter: true }))`（檢查點跟著保留天數過期後不能復原，
     * `undoAvailable` 是 false）。
     *
     * 標 `irreversible` 的刪除（`removeCreatedBinaries`）：每一個正要刪之前呼叫 `options.beforeIrreversible(item)` 讓應用備份；
     * 丟錯或回 false 就不刪那個檔案（`backup-failed`）。SDK 不備份這些檔案。
     */
    restoreVault(plan: VaultRestorePlan, options?: VaultRestoreOptions): Promise<VaultRestoreReport>;
    /**
     * 建立一個檢查點（SDK ADR 0063 補充 1、3）：這一刻整個 Vault 的清單（路徑 → 檔案、版本、內容雜湊；內容沿用歸檔、以雜湊去重，
     * 文字檔的內容確定存進歸檔）。只在這台、不同步。
     * - `{ name }`：命名檢查點（像 git 的 tag）：不稀疏化、不過期，內容一直保留（不受保留天數與 `maxBytes` 限制）；最多 50 個，
     *   超過丟 `VaultHistoryError('checkpoint-limit')`（不會自動清掉任何一個）；同名或名稱不合格丟 `checkpoint-name`。
     * - `{ auto: true }`：自動檢查點（協調器在同步告一段落時自己會呼叫）：距離上一個自動檢查點不到一小時、或和最新的檢查點完全相同時不建立、回 null。
     * - 都沒給：立刻建立一個一般（`auto`，依稀疏化規則保留）的檢查點；和最新的檢查點完全相同時回那一個。
     * 輕量成員：內容不在這台的檔案也列，但標成不能從這個檢查點還原。
     */
    checkpoint(options?: {
        name?: string;
        auto?: boolean;
        minIntervalMs?: number;
    }): Promise<VaultCheckpoint | null>;
    /** 這台的檢查點（自動、還原之前、命名的），新到舊 */
    checkpoints(): VaultCheckpoint[];
    /**
     * 改檢查點的名稱。自動或「還原之前」的檢查點改了名就變成命名檢查點（不再稀疏化、內容一直保留；算進 50 個的上限）。
     * 丟 `VaultHistoryError`：`checkpoint-unknown`、`checkpoint-name`、`checkpoint-limit`。
     */
    renameCheckpoint(id: string, name: string): Promise<VaultCheckpoint>;
    /** 刪掉一個檢查點（任何一種）；它留著的內容沒有其他人用就一起清掉。不認得丟 `VaultHistoryError('checkpoint-unknown')` */
    deleteCheckpoint(id: string): Promise<void>;
    /**
     * 本機的操作紀錄（像 git 的 reflog），新到舊：每一次還原（整個 Vault、單一檔案）一筆，最多留 200 筆。
     * `undoAvailable`：「還原之前」的檢查點還在、可以復原；跟著保留天數過期（或被刪、被容量清掉）之後紀錄照留、標 false 並附原因。
     */
    operations(): VaultOperation[];
    /**
     * 清空版本歷史（SDK ADR 0063 §隱私）：狀態儲存裡的歸檔（`ha:`、`hs:`、`hc:`）、檢查點（`hk:`、`hq`）與操作紀錄（`ho`）全部刪掉，
     * 例如重設身分或移除裝置時。之後的修改照常歸檔；重開時不會從版本圖把清空之前的版本補回來。
     */
    clearHistory(): Promise<void>;
    status(): VaultSyncStatus;
    clearConflicts(): Promise<void>;
    on<K extends keyof VaultSyncEventMap>(event: K, listener: Listener<K>): () => void;
    /** 等目前排隊中的工作都做完（不含網路送出）。 */
    idle(): Promise<void>;
    /**
     * 等「這一輪送完了」（SDK ADR 0045，G12b）：送出佇列清空、沒有在途的訊息（版本、摘要、索取）、排隊中的工作也做完 → `sent`。
     * 無法前進時不空等，立刻回報原因：`offline`（傳輸層離線）、`paused`（沉睡裝置，`pausedReason`）、`blocked`（中繼明確不收，
     * `blocked` 是原因；佇列留著）、`stopped`。一般的送出失敗會照常退避重試、繼續等；給了 `timeoutMs` 時到了回報 `timeout`。
     * `queue` 是回報當下的待送版本數。P2P 的大檔內容（`pushes`）不在內：它們等對方在線，不屬於這一輪的中繼送出。
     *
     * 「收完」用 `transport.backfill()`（分頁補拉）＋ `idle()`（收到的都套用完）。
     */
    whenSent(options?: {
        timeoutMs?: number;
    }): Promise<VaultSentResult>;
    /**
     * 送一次摘要給所有裝置（SDK ADR 0028）：裝置名單加入新裝置後呼叫。對方收到後會把缺的版本頭補送或索取回來，
     * 新裝置在名單更新前送來、被傳輸層擋掉的摘要也由此補上。
     *
     * `lost`（預設 true；SDK ADR 0074）：這台可能真的漏收了（名單晚到、訊息被擋掉、中繼說有訊息在送到前被刪掉）——摘要不帶
     * 「已處理到的序號」，對方照舊把這台缺的全部重送。`false`：只是對帳（例如每次啟動一次），對方剛經中繼送出、還在路上的不重送。
     */
    resync(options?: {
        lost?: boolean;
    }): void;
    /** 立刻做一次背景維護（通常由計時器觸發）。 */
    tick(): Promise<void>;
    /**
     * 立刻送出累積的簽收單（SDK ADR 0068）。協調器自己會在處理完一批（或滿 500 則）後送；排程同步的應用在一輪結束、斷線之前
     * 呼叫它，簽收單不必等到下一輪。送不出去的留著（跨重開），下次連上再送。
     */
    flushReceipts(): Promise<void>;
}
export {};
//# sourceMappingURL=coordinator.d.ts.map