/**
 * 中繼回的拒收原因是不是「檔案事件未啟用」：`blocked: files-disabled: …`（SDK ADR 0038 P0-R2 的詞元），
 * 或舊中繼的 `blocked:` 前綴並提到 `MAX_FILE_MB`（ADR 0027）。
 */
export declare function isFileEventsDisabledReason(reason: string): boolean;
/**
 * 所有中繼都拒收檔案塊：不是暫時的網路問題，重試也沒用，要站方開 `MAX_FILE_MB`
 * （一鍵部署給 `maxFileMb: VAULT_SYNC_MAX_FILE_MB`），或換一座收檔案的中繼。
 */
export declare class RelayRejectsFilesError extends Error {
    readonly relays: readonly string[];
    readonly name = "RelayRejectsFilesError";
    readonly code: "relay-rejects-files";
    constructor(relays: readonly string[]);
}
/**
 * 設了耐久度要求（`durability`，SDK ADR 0041），而中繼（含備援）都滿了（`ceiling`／`quota`、被略過、或只借用）：
 * 重試只會一直撞牆，協調器回報一次 `status().blocked = 'relays-full'`、以最長退避偶爾試一次，任何一座收下就恢復（ADR 0038 §4）。
 */
export declare class RelaysFullError extends Error {
    readonly relays: readonly string[];
    readonly name = "RelaysFullError";
    readonly code: "relays-full";
    constructor(relays: readonly string[]);
}
/** 自訂的傳輸層也可以丟 `{ code: 'relays-full' }` 的錯誤，協調器一樣認得 */
export declare function isRelaysFullError(error: unknown): boolean;
/** 自訂的傳輸層也可以丟 `{ code: 'relay-rejects-files' }` 的錯誤，協調器一樣認得 */
export declare function isRelayRejectsFilesError(error: unknown): boolean;
/** 只用到的 HTTP 能力；全域 `fetch` 相容，Obsidian 的 `requestUrl` 包一層也行 */
export type RelayInfoFetch = (url: string, init: {
    method: 'GET';
    headers: Record<string, string>;
}) => Promise<{
    status: number;
    text(): Promise<string>;
}>;
export interface RelayFileSupport {
    /** 原本的 `wss://` 網址 */
    url: string;
    /** 讀 NIP-11 用的 `https://` 網址（路徑保留，例如 `/app/<車道>`） */
    httpUrl: string;
    /**
     * `true`／`false`：中繼在 NIP-11 宣告了（`cinder_accepts_files`）；
     * `null`：沒有這個欄位（不是 Cinderous 中繼，或版本太舊）——只能實際送送看。
     */
    acceptsFiles: boolean | null;
    /** 這條路徑的單檔上限（MB＝MiB，`cinder_max_file_mb`；只有檔案車道宣告，SDK ADR 0029） */
    maxFileMb?: number;
    /** 每收件人檔案塊配額（塊，`cinder_file_chunks_per_recipient`；只有檔案車道宣告） */
    fileChunksPerRecipient?: number;
    /** 留言保存期（秒）：NIP-11 `retention` 裡適用於 kind 1060 的那一項 */
    retentionSeconds?: number;
    /** NIP-11 `limitation.max_message_length`（有宣告才有；`revalidateRelay` 用來判斷 `too-large` 是否仍成立，SDK ADR 0044） */
    maxMessageLength?: number;
    /** NIP-11 `limitation.restricted_writes`（有宣告才有；判斷白名單外 `not-allowed` 是否仍成立） */
    restrictedWrites?: boolean;
    /** `cinder_addressable_max_bytes`（有宣告才有；可尋址事件的單顆上限） */
    addressableMaxBytes?: number;
    /** `cinder_inbox_ack`（有宣告才有；SDK ADR 0067）：這座處理收件確認，確認後的包再留 `graceSeconds` 秒 */
    inboxAck?: {
        kind: number;
        graceSeconds: number;
    };
    name?: string;
    software?: string;
    version?: string;
}
/** 讀中繼 NIP-11 得到的檔案政策（與 {@link RelayFileSupport} 同一個形狀） */
export type RelayFilePolicy = RelayFileSupport;
/** `wss://host/path` → `https://host/path`（`ws://` → `http://`） */
export declare function relayHttpUrl(relayUrl: string): string;
/**
 * 讀中繼的 NIP-11（`GET` 同一個路徑、`Accept: application/nostr+json`），取出檔案政策（SDK ADR 0029）。
 *
 * 🔴 路徑會保留：Cinderous 錨點的車道是 `wss://<host>/app/<車道>`，NIP-11 依路徑回不同的文件
 * （只有檔案車道宣告收檔案與單檔上限）；讀根路徑拿到的是主訊息平面那份（不收檔案）。
 *
 * 讀不到（網路錯、HTTP 非 2xx、不是 JSON 物件）丟例外；呼叫端自己決定要不要當成「未知」
 * （{@link loadRelayFileLimits} 會當成未知、改用保守預設）。
 */
export declare function fetchRelayFilePolicy(relayUrl: string, opts?: {
    fetch?: RelayInfoFetch;
}): Promise<RelayFilePolicy>;
/**
 * 哪幾座宣告了收件確認（SDK ADR 0067 §2；`cinder_inbox_ack.kind` 是 {@link INBOX_ACK_KIND}）。
 * 交給 `NostrVaultTransport.setInboxAckRelays`：確認只送給這幾座。讀不到的（`null`）不算。
 */
export declare function inboxAckRelays(policies: readonly (RelayFilePolicy | null | undefined)[]): string[];
/**
 * 連線前讀中繼的 NIP-11，看它收不收檔案塊（Vault 同步一定要收）。外掛可以在設定頁或連線時呼叫，
 * `acceptsFiles === false` 就提示使用者：「這座中繼沒開檔案事件，Vault 無法同步」。
 * 與 {@link fetchRelayFilePolicy} 相同（v0.25 起一併帶回單檔上限、配額與保存期）。
 *
 * 讀不到（網路錯、不是 JSON）丟例外；呼叫端自己決定要不要當成「未知」。
 */
export declare function checkRelayAcceptsFiles(relayUrl: string, opts?: {
    fetch?: RelayInfoFetch;
}): Promise<RelayFileSupport>;
/** 協調器在中繼上送檔案塊要守的限制 */
export interface RelayFileLimits {
    /** 經中繼送的單檔上限（位元組）；更大的只走 P2P */
    maxFileBytes: number;
    /** 每收件人檔案塊配額（塊）；中繼超過就從最舊的擠掉（FIFO） */
    chunksPerRecipient: number;
    /** 檔案塊在中繼上待多久（秒）：配額在這段時間內都被佔著 */
    retentionSeconds: number;
    /** 三個值都來自目標中繼的宣告（false＝至少有一項用了保守預設） */
    declared: boolean;
}
/**
 * 中繼沒宣告時的保守預設（SDK ADR 0029）：
 * - 單檔上限：{@link FILE_TIER_MAX_BYTES}（≈16.5 MB，v0.24 以前的固定值；舊版收端只收得下這麼大）。
 * - 配額：以中繼「檔案車道」的配額公式（兩個上限檔＋128 塊餘裕）套上這個預設單檔上限：2 × 360 ＋ 128 ＝ 848 塊。
 *   比任何已知的中繼設定都小（中繼的預設 4,000；Cinderous 檔案車道 1,440）。
 * - 保存期：7 天（客戶端自己的過期章）。
 */
export declare const DEFAULT_RELAY_FILE_LIMITS: Readonly<RelayFileLimits>;
/**
 * 安全係數：一台裝置在任何一段保存期內，寄給同一位收件人的檔案塊最多用掉配額的這個比例。
 * 剩下的留給同一位收件人的其他寄件裝置、摘要與索取、以及不限速的即時變更。
 */
export declare const RELAY_QUOTA_SAFETY = 0.75;
/**
 * 把各座目標中繼的政策合成一組限制（SDK ADR 0029）：**取最嚴的**——協調器一則訊息會同時送到每一座。
 *
 * - 明確不收檔案（`acceptsFiles === false`）的那座不存檔案塊，不參與。
 * - 讀不到（`null`／`undefined`）或沒宣告的欄位，用 {@link DEFAULT_RELAY_FILE_LIMITS} 的保守值。
 * - 保存期取各座中**最長**的（塊在中繼上待得越久，佔配額越久），但不超過客戶端自己的過期章 `ttlSeconds`。
 */
export declare function relayFileLimits(policies: readonly (RelayFilePolicy | null | undefined)[], opts?: {
    ttlSeconds?: number;
}): RelayFileLimits;
/**
 * 讀每一座中繼的 NIP-11 並合成限制。讀不到的那座當成未知（保守預設），不丟例外。
 * 外掛在連線時（或換中繼時）呼叫，再交給 `VaultSyncCoordinator.setRelayLimits`。
 *
 * 🔴 `relayUrls` 應該是**實際寫入的那組**（SDK ADR 0038 §6、ADR 0041）：用了耐久度要求與備援之後，
 * 被標成已滿／不適用的那座暫時不寫、連上的備援會寫——傳 `pool.writeSet(1060)`，或用 {@link watchRelayFileLimits} 自動重算。
 */
export declare function loadRelayFileLimits(relayUrls: readonly string[], opts?: {
    fetch?: RelayInfoFetch;
    ttlSeconds?: number;
}): Promise<RelayFileLimits & {
    policies: (RelayFilePolicy | null)[];
}>;
/** 一台裝置在任何一段保存期內，寄給同一位收件人最多幾顆檔案塊：⌊配額 × {@link RELAY_QUOTA_SAFETY}⌋ */
export declare function relayChunkBudget(limits: Pick<RelayFileLimits, 'chunksPerRecipient'>): number;
/**
 * 對應的平均安全速率（塊／小時）：配額 × 安全係數 ÷ 保存期。1,440 塊／7 天 → 約 6.4 塊／小時。
 * 協調器實際以「任何一段保存期內的總量」執行（一顆 30 MB、656 塊的檔案可以一次送出，之後等配額回來），
 * 這個數字給狀態列或文件顯示用。
 */
export declare function safeRelayChunksPerHour(limits: Pick<RelayFileLimits, 'chunksPerRecipient' | 'retentionSeconds'>): number;
/** {@link watchRelayFileLimits} 需要的連線池能力（`RelayPool` 直接符合） */
export interface RelayWriteSetSource {
    writeSet(eventKind: number): string[];
    onRelayHealthChange(listener: (url: string) => void): () => void;
    /** 讀到 NIP-11 後重新驗證「不適用」標記（SDK ADR 0044；`RelayPool` 有）。沒有就只重算限制、不清標記 */
    revalidateRelay?(url: string, info: unknown, options?: {
        observedAt?: number;
    }): unknown;
    /** 列出有標記的中繼（`RelayPool` 有）：被標成不適用、不在寫入集合裡的那座也要重讀，才看得到它恢復 */
    relayHealth?(): ReadonlyMap<string, {
        readonly marks: readonly {
            readonly state: string;
        }[];
    }>;
}
/** {@link watchRelayFileLimits} 預設多久重讀一次 NIP-11（毫秒）：30 分鐘（SDK ADR 0044） */
export declare const DEFAULT_RELAY_INFO_REFRESH_MS: number;
/**
 * {@link watchRelayFileLimits} 的回傳值：可以直接呼叫（停止，與 v0.35 相同），另有 `refresh()`（SDK ADR 0045，G12e）。
 */
export interface RelayFileLimitsWatch {
    (): void;
    /** 停止（同直接呼叫） */
    stop(): void;
    /**
     * 現在就重讀一輪 NIP-11（寫入集合裡的每座＋被標成不適用的），重新驗證標記並重算限制；定期重讀從這時候重新起算。
     * 同時呼叫多次共用同一輪；停止之後什麼都不做。排程同步的應用在每一輪開始時呼叫，不必另開計時器。
     */
    refresh(): Promise<void>;
}
/**
 * 寫入集合一變（備援連上、某座被標成已滿或恢復）就對新的集合重算檔案限制（SDK ADR 0038 §6、ADR 0041），
 * 交給 `onLimits`（通常是 `coordinator.setRelayLimits`）。集合沒變不重算。立刻算一次。回傳停止函式。
 *
 * NIP-11 每座讀一次後快取；每 `refreshMs`（預設 {@link DEFAULT_RELAY_INFO_REFRESH_MS}，30 分鐘；0＝不重讀）重讀一輪
 * ——寫入集合裡的每座，加上被標成「不適用」的那幾座——並交給 `pool.revalidateRelay`（SDK ADR 0044）：
 * 站方打開檔案事件、提高上限之後，下一輪就清掉標記、寫入集合與限制跟著重算，不必等 24 小時。
 * 請求量：每座每輪一個 `GET`（3 座、30 分鐘＝每台裝置每天 144 個）。
 * 回傳 {@link RelayFileLimitsWatch}：直接呼叫＝停止；`refresh()`＝現在就重讀一輪（SDK ADR 0045）。
 */
export declare function watchRelayFileLimits(opts: {
    pool: RelayWriteSetSource;
    /** `policies` 與 `writeSet` 一一對應（讀不到的是 null）；可交給 {@link inboxAckRelays}（SDK ADR 0067） */
    onLimits: (limits: RelayFileLimits, writeSet: readonly string[], policies: readonly (RelayFilePolicy | null)[]) => void;
    fetch?: RelayInfoFetch;
    ttlSeconds?: number;
    /** 預設 1060（檔案塊與 Vault 訊息的外層） */
    eventKind?: number;
    /** 多久重讀一次 NIP-11（毫秒）；預設 30 分鐘，0 或負數＝不重讀（v0.35.0 的行為） */
    refreshMs?: number;
    onError?: (error: unknown) => void;
}): RelayFileLimitsWatch;
//# sourceMappingURL=relay-check.d.ts.map