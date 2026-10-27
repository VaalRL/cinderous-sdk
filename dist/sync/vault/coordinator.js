// 檔案樹（Vault）同步協調器（SDK ADR 0025）。
//
// 負責編排，不重寫零件：分流門檻用 `classifyPayload`、合併用 `merge3`（經 `graph.ts`）、
// 衝突副本檔名用 `conflictCopyName`、墓碑清理與沉睡裝置用 `tombstones.ts`。
//
// 不變式（每一條都有測試守著）：
// 1. **不無聲覆蓋**：任何寫入、刪除、改名前都以前置條件確認磁碟上的內容就是索引裡記的那一份；
//    不是的話先把磁碟上的內容收成本機版本，再重新合併。
// 2. **不無聲遺失**：兩邊都改而合不起來時，另一方的完整內容存成衝突副本；一刪一改時保留修改。
// 3. **回環抑制**：自己套用的遠端寫入會更新索引裡的雜湊；外掛隨後通知的變更內容相同就什麼都不做。
//    改名的回音若舊路徑已被另一個檔案佔用（路徑相撞、互換名字），不當成使用者改名，兩個路徑各自比對（SDK ADR 0048）。
// 4. **確定性合併**：同一組版本頭在每台裝置算出同一個版本（同一個 id），收斂不靠「誰先誰後」。
// 5. 所有狀態變更在同一條佇列上一次一個執行；送出在佇列外進行（網路慢不會卡住本機變更）。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { MemoryStreamingStore, StreamRejectedError, StreamTransfer, } from '../../transfer/stream.js';
import { FILE_CHUNK_BYTES, RELAY_FILE_MAX_BYTES_CAP } from '../file-relay.js';
import { classifyPayload, SNAPSHOT_TIER_MAX_BYTES } from '../ingest.js';
import { conflictCopyName, freePathCandidate } from '../merge3.js';
import { gcTombstones, isStaleDevice, STALE_DEVICE_MS } from '../tombstones.js';
import { encodedVaultMessageLength, isSafeVaultPath, isValidDeviceId, MAX_BUNDLE_ITEMS, MAX_SEEN, VAULT_WIRE_VERSION, validateVaultMessage, vaultFrameCount, } from './codec.js';
import { ancestryOf, compareVersions, computeHeads, deterministicId, isAncestor, isMergeVersion, markCalloutBreakId, markCalloutCapableId, markMergeRulesId, mergeInputs, MissingContentError, planMerge, sha256Hex, supportsCalloutBreak, supportsConflictCallouts, supportsMergeRules, } from './graph.js';
import { AUTO_CHECKPOINT_INTERVAL_MS, compareHistory, decodeManifest, DEFAULT_HISTORY_KEEP_DAYS, DEFAULT_HISTORY_MAX_BYTES, DEFAULT_HISTORY_MAX_VERSIONS, diffManifest, encodeManifest, fileStateAt, isEmptyDiff, MAX_NAMED_CHECKPOINTS, thinHistory, VaultHistoryError, addToRestorePlan, emptyRestorePlan, finishRestorePlan, } from './history.js';
import { EMPTY_SHA256, parseVaultEntryMeta, VAULT_STREAM_PURPOSE } from './p2p.js';
import { asPathFilter } from './path-filter.js';
import { compilePathScope, compilePeerScopes, DEFAULT_SPARSE_CACHE_BYTES, VaultScopeError } from './scope.js';
import { DEFAULT_RELAY_FILE_LIMITS, isRelayRejectsFilesError, isRelaysFullError, relayChunkBudget } from './relay-check.js';
import { addRange, coversRange, MAX_RECEIPT_RANGES, RelayLedger } from './relay-ledger.js';
import { decodeJson, encodeJson, SerializedStore } from './state-store.js';
/** 預設可以做行級合併的副檔名 */
export const DEFAULT_TEXT_EXTENSIONS = [
    'md', 'markdown', 'txt', 'canvas', 'base', 'json', 'css', 'js', 'mjs', 'ts', 'csv', 'tsv', 'yaml', 'yml', 'html', 'htm', 'xml', 'svg', 'tex', 'bib', 'org', 'rst',
];
/** 每個檔案保留的版本數（超過就修剪最舊的；修剪後找不到共同祖先時退回衝突副本，不會遺失資料） */
export const DEFAULT_MAX_VERSIONS_PER_FILE = 64;
/** 文字檔保留內容、可當三方合併祖先的最近版本數 */
export const DEFAULT_BASE_VERSIONS_KEPT = 8;
/** 等不到父版本多久之後，就當作它已遺失、直接併入（毫秒；預設一天） */
export const DEFAULT_ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;
/** 同一個版本多久才重新索取一次（毫秒） */
export const DEFAULT_WANT_INTERVAL_MS = 5 * 60 * 1000;
/** 索取先收集這麼久再一起送（SDK ADR 0104）：新裝置加入時一個檔一則，會把同一身分的事件預算吃光 */
export const WANT_BATCH_MS = 100;
/** 送出失敗的退避（毫秒） */
export const DEFAULT_RETRY_INITIAL_MS = 1000;
export const DEFAULT_RETRY_MAX_MS = 5 * 60 * 1000;
/** 摘要每則最多幾個檔案 */
export const DEFAULT_DIGEST_CHUNK = 400;
/** 自己暫時搬開檔案用的名稱（改名成環時）；預設忽略 */
export const SWAP_SUFFIX = /\.cinder-swap-[0-9a-f]{8}$/;
/** 待送出的版本達到這個數量就進入批次模式，改走 P2P 批次串流（SDK ADR 0026；PRD：N ≥ 10） */
export const DEFAULT_BULK_THRESHOLD = 10;
/**
 * 名單上的能力宣告：這台看得懂 `bundle`（SDK ADR 0095）。應用把宣告了的裝置交給 `bundleDevices`／`setBundleDevices`。
 */
export const BUNDLE_CAPABILITY = 'vaultBundles';
/** 一則 `bundle` 編碼後的上限：一個訊框，扣掉之後加上的寄件序號等的餘裕 */
const BUNDLE_MAX_BYTES = FILE_CHUNK_BYTES - 512;
/**
 * 批次模式下，走中繼（kind 1060，會存在中繼上 7 天）的補送**訊息數**上限：每小時幾則（平滑用）。
 *
 * ⚠ 它數的是「則」不是「塊」：一則帶內容的訊息可能有幾百塊。v0.25 起真正守住中繼配額的是
 * 塊數預算（`relayLimits`，SDK ADR 0029）：任何一段保存期內寄給同一位收件人的塊數 ≤ 配額 × 0.75。
 * 這個上限保留，讓小訊息的補送維持原本的節奏。
 */
export const DEFAULT_RELAY_BULK_PER_HOUR = 20;
/** P2P 連不上時的重試退避（毫秒）：從 30 秒起倍增到 30 分鐘；對方送摘要或主動連上來時立刻重試 */
export const DEFAULT_P2P_RETRY_INITIAL_MS = 30_000;
export const DEFAULT_P2P_RETRY_MAX_MS = 30 * 60_000;
/** 收到某台的訊息就排直連（SDK ADR 0090）：同一台多久最多觸發一次（中繼補送的舊訊息可能一次來很多則） */
export const P2P_POKE_INTERVAL_MS = 60_000;
/** 沒給 `staging`（大檔暫存放記憶體）時，P2P 收大檔的單檔上限 */
export const DEFAULT_MEMORY_STAGING_MAX_BYTES = 512 * 1024 * 1024;
/** 等 P2P 送出的大檔內容最多排幾筆 */
const MAX_PUSHES = 5_000;
/** 大檔分段讀的大小 */
const RANGE_BYTES = 1024 * 1024;
/** `progressIntervalMs` 的預設 */
export const DEFAULT_PROGRESS_INTERVAL_MS = 250;
/** `digestMaxIntervalMs` 的預設：一天 */
export const DEFAULT_DIGEST_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * 差異鏈最長多少（到了就存完整的清單）。差異很小、解得快，所以鏈可以很長：平常整個歸檔只有最舊的那一個檢查點是完整的清單
 * （刪掉它時下一個改成完整的），其餘都是差異。
 */
const MAX_CHECKPOINT_CHAIN = 1000;
/** 操作紀錄最多幾筆 */
const MAX_OPERATIONS = 200;
/** 一筆操作紀錄的路徑清單最多幾個 */
const MAX_OPERATION_PATHS = 1000;
/** `HistFile.dropped` 最多記幾個（版本圖每檔最多 96 版） */
const MAX_HIST_DROPPED = 256;
/** 歸檔的儲存格式版本（`Meta.hv`） */
const HIST_LAYOUT = 2;
const HIST_SHARD_PREFIX = 'hs:';
/** 完整歸檔的快取上限（檔案數、版本數；先到先算）：約 2,000 版 × 每版 200 多 B ≈ 數 MB */
const HIST_CACHE_MAX_FILES = 256;
const HIST_CACHE_MAX_ENTRIES = 20_000;
/** 整庫的整理（升級、重新打開歷史、背景維護、容量）每處理幾個檔案寫出一次、清一次快取 */
const HIST_SPILL_EVERY = 128;
const MAX_SUMMARY_PATHS = 16;
/** `hc:` 的值：魔術字＋參照者（fileId 清單，JSON）＋內容。v0.49 的值只有內容（遷移時改寫） */
const HC_MAGIC = [0x00, 0x63, 0x68, 0x32];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
function encodeHc(owners, content) {
    const head = textEncoder.encode(JSON.stringify(owners));
    const out = new Uint8Array(8 + head.length + content.length);
    out.set(HC_MAGIC, 0);
    new DataView(out.buffer).setUint32(4, head.length);
    out.set(head, 8);
    out.set(content, 8 + head.length);
    return out;
}
function decodeHc(value) {
    if (value.length >= 8 && HC_MAGIC.every((b, i) => value[i] === b)) {
        const len = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(4);
        if (8 + len <= value.length) {
            try {
                const owners = JSON.parse(textDecoder.decode(value.subarray(8, 8 + len)));
                if (Array.isArray(owners))
                    return { owners: owners.filter((o) => typeof o === 'string'), content: value.subarray(8 + len) };
            }
            catch {
                // 不是這個格式：當成 v0.49 的值（只有內容）
            }
        }
    }
    return { owners: [], content: value };
}
/** fileId → 摘要的分片（FNV-1a 低 8 位） */
function histShard(fileId) {
    let h = 0x811c9dc5;
    for (let i = 0; i < fileId.length; i += 1) {
        h ^= fileId.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 0) & 0xff).toString(16).padStart(2, '0');
}
/** 讀回的歸檔：欄位檢查、依 `(at, n)` 排序；讀不到（或壞了）回空的 */
function normalizeHistFile(raw, fileId) {
    if (!raw || !Array.isArray(raw.entries))
        return { fileId, entries: [] };
    raw.fileId = fileId;
    raw.entries = raw.entries.filter((e) => e && typeof e.versionId === 'string' && typeof e.at === 'number' && typeof e.n === 'number').sort(compareHistory);
    return raw;
}
function validSummary(s) {
    const x = s;
    return !!x && typeof x === 'object' && typeof x.c === 'number' && typeof x.b === 'number' && (x.l === null || (typeof x.l === 'object' && typeof x.l.versionId === 'string'));
}
/** 從完整的歸檔算摘要；`now`、`keepMs` 決定下一次稀疏化可能有變化的時間 */
function summarizeHist(hf, prev, now, keepMs) {
    const entries = hf.entries;
    const last = entries[entries.length - 1];
    const sizes = new Map();
    const want = new Set();
    const paths = [];
    let nx = prev?.nx ?? 0;
    let top = prev?.top ?? 0;
    let deleted = false;
    let lv;
    let next = Infinity;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i];
        if (e.content)
            sizes.set(e.hash, e.size);
        else if (e.text && !e.deleted)
            want.add(e.hash);
        if (e.deleted)
            deleted = true;
        else if (!lv && last?.deleted)
            lv = e;
        if (e.n > nx)
            nx = e.n;
        if (e.at > top)
            top = e.at;
        if (e.path !== last.path && paths.length < MAX_SUMMARY_PATHS && !paths.includes(e.path))
            paths.push(e.path);
        // 稀疏化的結果只在版本跨過 1 小時、1 天、保留天數時改變
        for (const th of [e.at + HOUR_MS, e.at + 24 * HOUR_MS, e.at + keepMs])
            if (th > now && th < next)
                next = th;
    }
    let b = 0;
    for (const size of sizes.values())
        b += size;
    const out = { c: entries.length, o: entries[0]?.at ?? 0, nx, top, b, l: last ?? null };
    if (deleted)
        out.d = 1;
    if (lv)
        out.lv = lv;
    if (paths.length > 0)
        out.ps = paths;
    if (hf.born !== undefined)
        out.born = hf.born;
    if (hf.cut !== undefined)
        out.cut = hf.cut;
    if (want.size > 0)
        out.w = [...want];
    if (Number.isFinite(next))
        out.t = next;
    return out;
}
/** 還原時一個檔案最多重試幾次（每次寫入前置條件不符＝使用者剛改了，先收成版本再試） */
const MAX_RESTORE_ATTEMPTS = 4;
const MAX_CONFLICTS = 200;
const MAX_PRUNED = 512;
const MAX_WAITING = 20_000;
const MAX_CONVERGE_ROUNDS = 8;
/** 一則 `nodes` 訊息最多幾個版本（SDK ADR 0058；另外以一個訊框為限） */
const MAX_NODES_PER_MESSAGE = 200;
const HOUR_MS = 3_600_000;
/** 自動檢查點沒建出來的那一次嘗試之後，多久可以再試（SDK ADR 0072）；真正的間隔由「離上一個建立的」決定 */
const AUTO_CHECKPOINT_RETRY_MS = 5 * 60_000;
/** 簽收單（SDK ADR 0068）：處理完之後等這麼久（期間再處理的併進同一份）才送；處理滿 `RECEIPT_BATCH` 則就先送 */
const RECEIPT_DELAY_MS = 20_000;
const RECEIPT_BATCH = 500;
/** 寄件序號：重開時跳過一段（上次遞增後還沒存下就關了也不會重複使用） */
const RS_RESTART_GAP = 1000;
/** 中繼帳最多幾筆；超過時最舊的併成沒有序號的廣播帳（只會多算） */
const LEDGER_MAX_ENTRIES = 20_000;
/** 中繼帳的節流保存：累積這麼多筆變動才轉成 JSON 寫進狀態（停止時一定寫） */
const LEDGER_SAVE_EVERY = 500;
/** 「經中繼送給誰的哪個版本」最多記幾筆（SDK ADR 0074；只在記憶體，一筆約 100 位元組） */
const RELAY_SENT_MAX = 200_000;
/**
 * 經中繼送出的版本，對方簽收了更後面的序號、這一則送出超過這麼久卻還沒簽收：當作中繼弄丟了（SDK ADR 0106）。
 * 收件端處理完 20 秒內就簽收（`RECEIPT_DELAY_MS`），中繼的投遞順序也只差幾秒；留寬一點，誤判的代價只是多送一次。
 */
const RELAY_LOST_AFTER_MS = 10 * 60_000;
/** 一則版本訊息的標頭多估一點（`contentLength` 欄位等） */
const HEADER_SLACK = 64;
const strict = new TextDecoder('utf-8', { fatal: true });
const b64 = {
    encode(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
    },
    decode(s) {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1)
            out[i] = bin.charCodeAt(i);
        return out;
    },
};
const defaultClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
};
/** 預設的文字判斷：副檔名、大小、合法 UTF-8 */
export function defaultIsText(path, bytes) {
    const dot = path.lastIndexOf('.');
    const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
    if (!DEFAULT_TEXT_EXTENSIONS.includes(ext) || bytes.length > SNAPSHOT_TIER_MAX_BYTES)
        return false;
    try {
        strict.decode(bytes);
        return true;
    }
    catch {
        return false;
    }
}
export function defaultPathKey(path) {
    return path.normalize('NFC').toLowerCase();
}
/** 交出去的進度是複本：應用改了它也不影響協調器 */
function cloneProgress(p) {
    return { ...p, files: { ...p.files }, bytes: { ...p.bytes }, ...(p.current ? { current: { ...p.current } } : {}) };
}
const FOLD_ID_TAG = 'cinder-fold-v1';
/** 同路徑新建的合併裡，輸的那個檔案的刪除版本（SDK ADR 0059）：最後 8 位是前 24 位的雜湊（與 callout 的標記同一個位置、不同的標籤） */
/** 協調器的裝置名稱：最長 64 字；沒給或空的用 deviceId */
function labelOrId(label, deviceId) {
    return (label || deviceId).slice(0, 64);
}
function markFoldId(id) {
    const head = id.slice(0, 24);
    return head + deterministicId(FOLD_ID_TAG, head).slice(0, 8);
}
/** 同路徑新建的合併裡，收進留下的檔案的版本 A 的 id（由輸的檔案、它的版本頭、留下的檔案、路徑決定；SDK ADR 0059） */
function foldAdoptId(loserId, loserHeads, winnerId, path, callout) {
    const id = markMergeRulesId(deterministicId('fold', loserId, ...[...loserHeads].sort(), winnerId, path));
    return callout ? markCalloutCapableId(id) : id;
}
function isFoldId(id) {
    return id.length === 32 && id.slice(24) === deterministicId(FOLD_ID_TAG, id.slice(0, 24)).slice(0, 8);
}
/** 內容範圍編成判斷函式（SDK ADR 0058） */
function compileContentScope(scope) {
    const bytes = scope.cacheBytes;
    return {
        content: compilePathScope(scope.content),
        create: scope.create !== undefined ? compilePathScope(scope.create) : null,
        cacheBytes: typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : DEFAULT_SPARSE_CACHE_BYTES,
    };
}
/** 歷史選項補上預設值；`base` 是目前的設定（`setHistory` 只改給了的欄位） */
function normalizeHistoryOptions(options, base) {
    const positive = (x, fallback) => (typeof x === 'number' && !Number.isNaN(x) && x > 0 ? x : fallback);
    return {
        enabled: typeof options.enabled === 'boolean' ? options.enabled : base?.enabled,
        keepDays: positive(options.keepDays, base?.keepDays ?? DEFAULT_HISTORY_KEEP_DAYS),
        maxVersionsPerFile: Math.max(1, Math.floor(positive(options.maxVersionsPerFile, base?.maxVersionsPerFile ?? DEFAULT_HISTORY_MAX_VERSIONS))),
        maxBytes: positive(options.maxBytes, base?.maxBytes ?? DEFAULT_HISTORY_MAX_BYTES),
        dayBoundary: options.dayBoundary === 'utc' || options.dayBoundary === 'local' ? options.dayBoundary : (base?.dayBoundary ?? 'local'),
    };
}
const localOffset = (at) => -new Date(at).getTimezoneOffset() * 60_000;
const sameHash = (hash) => (current) => current !== null && sha256Hex(current) === hash;
const absent = (current) => current === null;
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
export class VaultSyncCoordinator {
    #adapter;
    #store;
    #transport;
    #deviceId;
    #label;
    #clock;
    #randomId;
    #isText;
    #ignore;
    /** 同步排除範圍（SDK ADR 0047）；null＝沒設定（v0.36 的行為） */
    #excl;
    #applyRemote;
    #key;
    #opts;
    #files = new Map();
    /** 磁碟上的確切路徑 → fileId */
    #byDisk = new Map();
    /** 停止追蹤的本機檔案：路徑鍵 → fileId（SDK ADR 0047） */
    /**
     * 停止追蹤的本機副本，依路徑的比對 key（不分大小寫）索引。同一個 key 可能有好幾筆——只差大小寫的兩個路徑（`Note.md`／`note.md`）
     * 在大小寫有別的檔案系統上是兩個檔案，各自停止追蹤；只放一筆時另一筆會被蓋掉，之後被當成新檔或使用者刪除。
     */
    #byDet = new Map();
    /** 路徑鍵（預設不分大小寫）→ 磁碟上用這個鍵的檔案；判斷「寫下去會不會蓋到別人」用 */
    #diskKeys = new Map();
    #byTarget = new Map();
    #targetKey = new Map();
    #outbox = new Map();
    #outboxByNode = new Map();
    #inflight = new Set();
    #waiting = new Map();
    /** fileId → 等著的版本 id */
    #waitingByFile = new Map();
    #wantedAt = new Map();
    /** 收集中、還沒送出的索取（SDK ADR 0104）：依「要不要內容／要不要祖先／收件人」分組 */
    #wantBatch = new Map();
    #wantTimer = undefined;
    #pending = new Map();
    #digests = new Map();
    /**
     * 經中繼送給哪一台的哪個版本、用哪個寄件序號、什麼時候（`收件人\n版本` → ；SDK ADR 0074）：對方的摘要說它沒有、
     * 但這是在它處理到的序號之後才送的（還在路上），就不重送。只記在記憶體（重開後照舊重送），收件人以送出當下明確知道的為準。
     */
    #relaySent = new Map();
    /** 每台最近一份摘要的狀態識別碼（SDK ADR 0074）：換了＝它的狀態重建過，`seen` 不能拿來比對送出前的序號 */
    #peerSid = new Map();
    #dirty = new Set();
    #removedRecords = new Set();
    #toMaterialize = new Set();
    /** 套用時出錯（例如磁碟 I/O）的檔案：背景維護時重試 */
    #failed = new Set();
    #taskCache = new Map();
    #listeners = {
        status: new Set(),
        conflict: new Set(),
        applied: new Set(),
        pending: new Set(),
        error: new Set(),
        progress: new Set(),
        evicted: new Set(),
    };
    // ── 直連進度（SDK ADR 0053 §G14） ──
    #transfers = new Map();
    #transferSeq = 0;
    #p2pBytes = { sent: 0, received: 0 };
    #progressIntervalMs;
    #held = [];
    // ── P2P 批次（SDK ADR 0026） ──
    #peers;
    #staging;
    /** 收大檔的單檔上限：預設記憶體暫存時 512 MiB；自己給 staging 時用串流的預設（64 GiB） */
    #stagingMax;
    #streamOpts;
    #bulkThreshold;
    /** 批次模式下經中繼補送的每小時則數；0＝暫停（`setRelayBulkPerHour`，SDK ADR 0053 §G16） */
    #relayBulkPerHour;
    /** 經中繼送內容的單檔上限（SDK ADR 0029） */
    #relayMaxBytes = DEFAULT_RELAY_FILE_LIMITS.maxFileBytes;
    /** 名單上所有成員都收得下的單檔上限（SDK ADR 0035 §G9）；Infinity＝不設限 */
    #memberMaxBytes = Infinity;
    /** 任何一段保存期內寄給同一位收件人的塊數上限 */
    #relayBudget = relayChunkBudget(DEFAULT_RELAY_FILE_LIMITS);
    /** 送出端的中繼帳，按收件人（SDK ADR 0068） */
    #ledger = new RelayLedger({ now: () => this.#clock.now(), windowMs: () => this.#relayWindowMs });
    #receiptsOn;
    #receiptTimer;
    /** 上次送出簽收單之後處理完的訊息數 */
    #receiptPending = 0;
    #receiptSending = false;
    #ledgerDirty = false;
    #ledgerUnsaved = 0;
    /** 保存期（毫秒） */
    #relayWindowMs = DEFAULT_RELAY_FILE_LIMITS.retentionSeconds * 1000;
    #p2pRetry;
    /** 收到訊息而排直連的時間（每台；SDK ADR 0090） */
    #p2pPokedAt = new Map();
    /** `${device}\n${nodeId}` → 等 P2P 送出的大檔內容 */
    #pushes = new Map();
    #p2pState = new Map();
    /** 這次工作可用的串流暫存內容（內容雜湊 → 來源），套用大檔時用 */
    #staged = new Map();
    #attached = new WeakSet();
    #unhandle = [];
    /** 批次模式下走中繼送出的時間（滑動一小時的限速） */
    #relayBulkSent = [];
    #p2pRunning = false;
    #p2pAgain = false;
    /**
     * 上一次排下一則時，剩下的都在等中繼補送的限速或配額（批次模式，SDK ADR 0026／0029）：這個時間之後才會再送。
     * `whenSent` 據此回報 `throttled`，不讓呼叫端空等（SDK ADR 0092）。送出任何一則或重新排時清掉。
     */
    #throttledUntil = null;
    #offIncoming;
    #meta = { hlc: 0, seq: 0, conflicts: [] };
    #metaDirty = false;
    /** 佇列在 `start()` 讀回狀態之前是關著的：之前排進來的通知等讀回後才執行（否則會在空索引上重複建檔） */
    #openGate;
    #queue = new Promise((resolve) => (this.#openGate = resolve));
    #queued = 0;
    /** 寫回狀態失敗的次數（SDK ADR 0067：一則訊息處理期間有沒有失敗，決定能不能送收件確認） */
    #persistFailures = 0;
    /** 還沒落地的背景寫入（`#bg`） */
    #background = new Set();
    #backgroundFailed = false;
    #started = false;
    #stopped = false;
    #paused = null;
    #online = false;
    #pumping = false;
    #digestDue = false;
    /** 下一份摘要不帶 `seen`：對方照舊重送這台缺的全部（`resync()` 預設；SDK ADR 0074） */
    #digestFull = false;
    #retryDelay = 0;
    #retryTimer;
    #tickTimer;
    #sendFailing = false;
    /** 送不出去的明確原因（中繼拒收檔案塊） */
    #blocked;
    #lastError;
    #lastStatus = '';
    #offMessage;
    #offStatus;
    /** 等「送完」的人（SDK ADR 0045，G12b） */
    #sentWaiters = new Set();
    /** 佇列外送出中的索取（want）數 */
    #auxSending = 0;
    #digestPolicy;
    #digestMinIntervalMs;
    #digestMaxIntervalMs;
    /** 每次標記「有新的版本要廣播」加一：摘要送完時沒變才清掉標記 */
    #changeGen = 0;
    #conflictCallouts;
    /** 這台寫出的版本帶「支援 Markdown 合併規則」的標記（SDK ADR 0059；`setMergeRules`） */
    #mergeRules;
    /** 這台寫出的版本帶「支援 callout 後空一行」的標記（SDK ADR 0087；`setCalloutBreak`） */
    #calloutBreak;
    // ── 輕量成員（SDK ADR 0058） ──
    /** 這台的內容範圍；null＝完整成員 */
    #scope = null;
    /** 其他輕量成員的內容範圍（deviceId → 判斷函式） */
    #peerScopes = new Map();
    /** 看得懂 `bundle` 的裝置（SDK ADR 0095） */
    #bundleDevices = new Set();
    #pins = new Set();
    /** `fetch()` 抓下來的快取：fileId → 最後使用時間 */
    #lru = new Map();
    /** 正在 `fetch` 的檔案：LRU 不清 */
    #fetching = new Map();
    #fetchWaiters = new Set();
    /** 被擋下的本機新增（路徑 → 原因與當時的大小／時間；同一個檔案沒變就不再回報） */
    #blockedLocal = new Map();
    /** 這一次工作裡被擋下的路徑（`notifyLocalChange` 據此 reject） */
    #blockedNow = null;
    #lruDirty = false;
    /** `status().scope` 的快取：磁碟、版本、快取、釘選有變就加一 */
    #diskGen = 0;
    #usageGen = -1;
    #usage;
    /** 要清掉的原因（LRU 清的標 `lru`，其他是 `scope`） */
    #evictReason = new Map();
    // ── 版本歷史（SDK ADR 0063；v0.50 起版本資訊用到時才載入） ──
    #histOpts;
    /** 每個檔案的摘要（啟動時只載入這個） */
    #histSum = new Map();
    /** 分片 → 裡面的檔案 */
    #histShards = new Map();
    #histShardDirty = new Set();
    /** 讀過的完整歸檔（LRU：Map 的順序就是使用的先後）；改過還沒寫回的（`#histDirty`）不清 */
    #histCache = new Map();
    #histLoading = new Map();
    /** `clearHistory` 之後，之前開始的讀取作廢 */
    #histGen = 0;
    /** 歸檔內容的佔用：各檔摘要的 `b`＋只有檢查點留著的內容（`#cpOwn`） */
    #histBytes = 0;
    /** 要看要不要歸檔的版本（fileId → 版本 id，加入的順序就是因果順序）：每次工作結束時處理 */
    #histNew = new Map();
    /** 歸檔了、內容還沒到的文字版本：雜湊 → fileId（從摘要的 `w` 建立） */
    #histWant = new Map();
    /** 要寫回（或刪掉）`ha:` 的檔案 */
    #histDirty = new Set();
    /** 下一次處理完歸檔時記下「歸檔和版本圖之間沒有缺口」 */
    #histSeedPending = false;
    /** 這次啟動做了 v0.49 → v0.50 的遷移（遷移時已經逐檔補過版本圖的版本） */
    #histMigrated = false;
    /** 檢查點，舊到新（SDK ADR 0063 補充） */
    #cps = [];
    #cpCache = null;
    /** 檢查點留著的內容：雜湊 → 幾個檢查點（任何一種）、大小 */
    #cpRefs = new Map();
    /** 命名檢查點釘住的內容：雜湊 → 幾個 */
    #cpNamed = new Map();
    /** 只有檢查點留著、沒有任何檔案的歸檔參照的內容：雜湊 → 大小（`hq`） */
    #cpOwn = new Map();
    #cpOwnDirty = false;
    #cpDirty = new Set();
    /** 上次試著建立自動檢查點的時間 */
    #cpTriedAt;
    #autoCheckpoint;
    /** 操作紀錄，舊到新 */
    #ops = [];
    #opsDirty = false;
    constructor(options) {
        if (!isValidDeviceId(options.deviceId))
            throw new Error('VaultSyncCoordinator：deviceId 只能用英數與 _.:-，最長 64');
        this.#adapter = options.adapter;
        this.#store = new SerializedStore(options.store);
        this.#transport = options.transport;
        this.#deviceId = options.deviceId;
        this.#label = labelOrId(options.deviceLabel, options.deviceId);
        this.#clock = options.clock ?? defaultClock;
        this.#randomId = options.randomId ?? (() => bytesToHex(randomBytes(16)));
        this.#isText = options.isText ?? defaultIsText;
        const ignore = options.ignore ?? (() => false);
        this.#ignore = (path) => SWAP_SUFFIX.test(path) || ignore(path);
        this.#excl = options.excludes ? asPathFilter(options.excludes) : null;
        this.#applyRemote = options.applyRemote;
        this.#key = options.pathKey ?? defaultPathKey;
        this.#opts = {
            scanOnStart: options.scanOnStart ?? true,
            retryInitialMs: options.retryInitialMs ?? DEFAULT_RETRY_INITIAL_MS,
            retryMaxMs: options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
            tickMs: options.tickMs ?? 60_000,
            orphanAfterMs: options.orphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS,
            wantIntervalMs: options.wantIntervalMs ?? DEFAULT_WANT_INTERVAL_MS,
            staleAfterMs: options.staleAfterMs ?? STALE_DEVICE_MS,
            maxVersionsPerFile: Math.max(8, options.maxVersionsPerFile ?? DEFAULT_MAX_VERSIONS_PER_FILE),
            digestChunk: Math.max(1, options.digestChunk ?? DEFAULT_DIGEST_CHUNK),
        };
        this.#peers = options.peers;
        // 協調器自己把暫存的內容寫進 Vault（經前置條件），寫完就刪；不用暫存的 commit（那是給一般檔案佇列的）
        const staging = options.staging ?? new MemoryStreamingStore();
        this.#stagingMax = options.staging ? undefined : DEFAULT_MEMORY_STAGING_MAX_BYTES;
        this.#staging = {
            size: (id) => staging.size(id),
            append: (id, bytes) => staging.append(id, bytes),
            read: (id) => staging.read(id),
            readRange: (id, offset, length) => staging.readRange(id, offset, length),
            delete: (id) => staging.delete(id),
            // 暫存是單一檔案時的本機路徑：轉接器可以直接改名取用（SDK ADR 0089）
            ...(staging.localPath ? { localPath: (id) => staging.localPath(id) } : {}),
        };
        this.#streamOpts = { timers: this.#clock, ...options.stream };
        this.#bulkThreshold = Math.max(1, options.bulkThreshold ?? DEFAULT_BULK_THRESHOLD);
        this.#receiptsOn = options.receipts !== false;
        this.#autoCheckpoint = options.autoCheckpoint === 'app' ? 'app' : 'idle';
        this.#relayBulkPerHour = Math.max(1, options.relayBulkPerHour ?? DEFAULT_RELAY_BULK_PER_HOUR);
        if (options.relayLimits)
            this.#applyRelayLimits(options.relayLimits);
        if (options.memberCapabilities)
            this.#applyMemberCapabilities(options.memberCapabilities);
        this.#p2pRetry = { initial: options.p2pRetryInitialMs ?? DEFAULT_P2P_RETRY_INITIAL_MS, max: options.p2pRetryMaxMs ?? DEFAULT_P2P_RETRY_MAX_MS };
        const policy = options.digestPolicy ?? 'on-connect';
        if (policy !== 'on-connect' && policy !== 'on-change' && policy !== 'manual')
            throw new RangeError(`VaultSyncCoordinator：未知的 digestPolicy ${String(policy)}`);
        this.#digestPolicy = policy;
        this.#digestMinIntervalMs = Math.max(0, options.digestMinIntervalMs ?? 0);
        this.#digestMaxIntervalMs = Math.max(0, options.digestMaxIntervalMs ?? DEFAULT_DIGEST_MAX_INTERVAL_MS);
        this.#conflictCallouts = options.conflictCallouts === true;
        this.#mergeRules = options.mergeRules === true;
        this.#bundleDevices = new Set(options.bundleDevices ?? []);
        this.#calloutBreak = options.calloutBreak === true;
        this.#progressIntervalMs = Math.max(0, options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
        if (options.scope)
            this.#scope = compileContentScope(options.scope);
        this.#peerScopes = compilePeerScopes(options.peerScopes);
        this.#histOpts = normalizeHistoryOptions(options.history ?? {}, undefined);
    }
    /**
     * 本機版本的 id：開了 `mergeRules` 就帶「支援 Markdown 合併規則」的標記（SDK ADR 0059），開了 `conflictCallouts` 就帶
     * 「支援 callout」的標記（SDK ADR 0046）。兩個標記在 id 的不同位置，先標合併規則（callout 的標記涵蓋前 24 位）。
     * 開了 `calloutBreak` 再加「callout 後空一行」的標記（SDK ADR 0087；第 9–16 位，最先標）。
     */
    #versionId() {
        let id = this.#randomId();
        if (this.#calloutBreak)
            id = markCalloutBreakId(id);
        if (this.#mergeRules)
            id = markMergeRulesId(id);
        return this.#conflictCallouts ? markCalloutCapableId(id) : id;
    }
    /** 這個版本能不能參與「Markdown 合併規則」模式的合併（快取在紀錄裡；SDK ADR 0059） */
    #rulesCapable(rec, id) {
        rec.mr ??= {};
        const known = rec.mr[id];
        if (known !== undefined)
            return known;
        const result = supportsMergeRules(rec.nodes, id, rec.mr);
        this.#markDirty(rec);
        return result;
    }
    /** 這個版本能不能參與「callout 後空一行」格式的合併（快取在紀錄裡；SDK ADR 0087） */
    #breakCapable(rec, id) {
        rec.cb ??= {};
        const known = rec.cb[id];
        if (known !== undefined)
            return known;
        const result = supportsCalloutBreak(rec.nodes, id, rec.cb);
        this.#markDirty(rec);
        return result;
    }
    /** 這個版本能不能參與 callout 模式的合併（快取在紀錄裡；SDK ADR 0046） */
    #calloutCapable(rec, id) {
        rec.cm ??= {};
        const known = rec.cm[id];
        if (known !== undefined)
            return known;
        const result = supportsConflictCallouts(rec.nodes, id, rec.cm);
        this.#markDirty(rec);
        return result;
    }
    // ───────────────────────────── 公開 API ─────────────────────────────
    get deviceId() {
        return this.#deviceId;
    }
    /**
     * 更新目標中繼的檔案限制（SDK ADR 0029）；通常在連線後以 `loadRelayFileLimits(relayUrls)` 讀 NIP-11 取得。
     * 只影響之後建立的版本與之後的補送；已經建立的版本走哪一層不變。沒給的欄位維持原值。
     */
    setRelayLimits(limits) {
        this.#applyRelayLimits(limits);
        this.#pump();
    }
    /**
     * 更新「所有成員都收得下」的單檔上限（SDK ADR 0035 §G9）：`membership.onChange(() => sync.setMemberCapabilities(membership.minCapability()))`。
     * 名單上還有舊版（沒有能力宣告）時 `minCapability()` 給 16.5 MB，中繼門檻再大也不會送更大的檔給它。
     */
    setMemberCapabilities(caps) {
        this.#applyMemberCapabilities(caps);
        this.#pump();
    }
    /** 更新看得懂 `bundle` 的裝置（SDK ADR 0095）：名單 `change` 時，把宣告了 `BUNDLE_CAPABILITY` 的裝置交進來 */
    setBundleDevices(devices) {
        this.#bundleDevices = new Set(devices);
        this.#pump();
    }
    /**
     * 改這台的裝置名稱（SDK ADR 0069）：之後產生的版本與衝突副本檔名用新名稱，已經產生的不回溯改。
     * 規則同建構時的 `deviceLabel`（最長 64 字；空的用 deviceId）。名單上的名稱另外以 `membership.declareLabel` 宣告。
     */
    setDeviceLabel(label) {
        this.#label = labelOrId(label, this.#deviceId);
    }
    /**
     * 打開或關掉 Markdown 合併規則（SDK ADR 0059）：只影響之後這台寫出的版本帶不帶標記；合併時一律看版本資料，每台一致。
     * 名單 `change` 時：`sync.setMergeRules(membership.allDeclare(MERGE_RULES_CAPABILITY))`——有任何一台（含舊版）沒宣告就關。
     */
    setMergeRules(on) {
        this.#mergeRules = on === true;
    }
    /** 這台寫出的版本目前帶不帶「支援 Markdown 合併規則」的標記 */
    get mergeRules() {
        return this.#mergeRules;
    }
    /**
     * 打開或關掉「衝突 callout 後空一行」（SDK ADR 0087）：只影響之後這台寫出的版本帶不帶標記；合併時一律看版本資料，每台一致。
     * 名單 `change` 時：`sync.setCalloutBreak(membership.allDeclare(CALLOUT_BREAK_CAPABILITY))`——有任何一台（含舊版）沒宣告就關。
     */
    setCalloutBreak(on) {
        this.#calloutBreak = on === true;
    }
    /** 這台寫出的版本目前帶不帶「支援 callout 後空一行」的標記 */
    get calloutBreak() {
        return this.#calloutBreak;
    }
    /**
     * 其他輕量成員的內容範圍（SDK ADR 0058）：`sync.setPeerScopes(sparsePeerScopes(membership))`，名單 `change` 時再呼叫。
     * 之後送給它們的版本，範圍外的只帶版本資訊；`null`／空物件＝大家都是完整成員。
     */
    setPeerScopes(scopes) {
        this.#peerScopes = compilePeerScopes(scopes);
    }
    /** 宣告為輕量成員的其他裝置（deviceId，排序） */
    sparsePeers() {
        return [...this.#peerScopes.keys()].sort();
    }
    /**
     * 更新這台的內容範圍（SDK ADR 0058）；`null`＝改回完整成員（所有檔案的內容都會補抓回來）。
     * 離開範圍的本機檔案清掉（**不產生刪除版本**，有還沒送出的修改就等送出後再清）；進入範圍的檔案向其他裝置索取內容。
     * 回傳的 Promise 在重新套用完成後 resolve（不等內容下載完）。別忘了同步更新名單上的宣告（`membership.declareSparse`）。
     */
    setScope(scope) {
        this.#scope = scope ? compileContentScope(scope) : null;
        this.#diskGen += 1;
        if (!this.#started || this.#stopped)
            return Promise.resolve();
        return this.#run(async () => {
            this.#queueScope();
            await this.#drain();
        }).then(() => this.#pump());
    }
    /** 這台是不是輕量成員（有內容範圍） */
    get sparse() {
        return this.#scope !== null;
    }
    /** 這個路徑能不能在這台新增（SDK ADR 0058 §裁示 3；完整成員、或沒設定 `scope.create` 時一律可以） */
    canCreate(path) {
        return !this.#scope?.create || this.#scope.create(path);
    }
    /**
     * 這台所知的**每一個**檔案（SDK ADR 0058）：含內容不在這台、只有版本資訊的（輕量成員看得到整個 Vault 的架構）。
     * 刪除了、墓碑還在保留期內的也列（`deleted`）。依路徑排序。完整成員也能用（`local` 幾乎都是 true）。
     */
    remoteIndex() {
        const out = [];
        for (const rec of this.#files.values()) {
            const entry = this.#remoteEntry(rec);
            if (entry)
                out.push(entry);
        }
        return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.fileId < b.fileId ? -1 : 1));
    }
    /** 依路徑（比對方式同 `pathKey`，預設不分大小寫）找一個檔案；沒刪除的優先。不認得回 null（SDK ADR 0058） */
    lookup(path) {
        return this.#lookupRecord(path).entry;
    }
    /**
     * 按需取得一個檔案的內容（SDK ADR 0058）：內容已經在這台就直接回傳；否則把它加進快取（LRU，上限 `scope.cacheBytes`）、
     * 向其他裝置索取（`want`，帶 `fetch`：完整成員回應時不裁剪），收到後寫進磁碟再回傳。大檔（只走直連）請完整成員直送。
     *
     * 失敗丟 `VaultScopeError`：`unknown`（不認得）、`deleted`、`excluded`（被 `excludes`／`ignore` 排除）、`timeout`（給了 `timeoutMs`、
     * 到了還沒到；下載仍在背景進行，之後可以再呼叫）、`stopped`。完整成員也能用（等還沒到的內容）。
     */
    fetch(target, options = {}) {
        const label = typeof target === 'string' ? target : target.fileId;
        if (this.#stopped || !this.#started)
            return Promise.reject(new VaultScopeError('stopped', label));
        // 逾時從呼叫的時候算起（排在前面的工作也算在內）
        const deadline = options.timeoutMs !== undefined ? this.#clock.now() + Math.max(0, options.timeoutMs) : undefined;
        return this.#run(async () => {
            const rec = typeof target === 'string' ? this.#lookupRecord(target).rec : this.#files.get(target.fileId);
            const head = rec ? this.#latestHead(rec) : null;
            if (!rec || !head)
                return new VaultScopeError('unknown', label);
            if (head.deleted)
                return new VaultScopeError('deleted', head.path);
            if (this.#skip(head.path))
                return new VaultScopeError('excluded', head.path);
            const ready = await this.#fetchedContent(rec);
            if (ready) {
                if (this.#scope && !this.#inPatternScope(rec) && !this.#pins.has(rec.id))
                    this.#touchLru(rec.id);
                return { rec, bytes: ready };
            }
            if (this.#scope && !this.#wantsContent(rec))
                this.#touchLru(rec.id);
            this.#fetching.set(rec.id, (this.#fetching.get(rec.id) ?? 0) + 1);
            // 這是使用者等著的：不受索取節流
            for (const h of rec.heads)
                this.#wantedAt.delete(h);
            this.#toMaterialize.add(rec.id);
            await this.#drain();
            const now = await this.#fetchedContent(rec);
            if (now) {
                this.#unfetch(rec.id);
                return { rec, bytes: now };
            }
            // 之前就在等的內容：`#markPending` 不會再要一次，這裡明確再要（不受節流）
            const waiting = rec.heads.filter((h) => this.#pending.has(h)).map((h) => [rec.id, h]);
            if (waiting.length > 0)
                this.#want(waiting, true);
            return { rec, bytes: null };
        }).then((result) => {
            this.#pump();
            if (result instanceof VaultScopeError)
                throw result;
            const { rec, bytes } = result;
            if (bytes)
                return bytes;
            return new Promise((resolve, reject) => {
                const waiter = { fileId: rec.id, resolve, reject, timer: undefined, path: this.#latestHead(rec)?.path ?? label };
                if (deadline !== undefined) {
                    waiter.timer = this.#clock.setTimeout(() => {
                        if (!this.#fetchWaiters.delete(waiter))
                            return;
                        this.#unfetch(rec.id);
                        reject(new VaultScopeError('timeout', waiter.path));
                    }, Math.max(0, deadline - this.#clock.now()));
                }
                this.#fetchWaiters.add(waiter);
            });
        });
    }
    /**
     * 釘選（SDK ADR 0058）：這個檔案的內容一直留在這台（不受 LRU 與內容範圍影響），內容不在就向其他裝置索取。
     * 釘的是檔案（fileId），改名後仍然釘著。不認得的路徑丟 `VaultScopeError('unknown')`。
     */
    pin(path) {
        return this.#run(async () => {
            const rec = this.#lookupRecord(path).rec;
            if (!rec)
                return false;
            if (!this.#pins.has(rec.id)) {
                this.#pins.add(rec.id);
                this.#lru.delete(rec.id);
                this.#saveSparseMeta();
            }
            this.#toMaterialize.add(rec.id);
            await this.#drain();
            return true;
        }).then((known) => {
            this.#pump();
            if (!known)
                throw new VaultScopeError('unknown', path);
        });
    }
    /** 取消釘選：檔案變成一般的快取（最近使用），之後依 LRU 與內容範圍決定要不要清掉 */
    unpin(path) {
        return this.#run(async () => {
            const rec = this.#lookupRecord(path).rec;
            if (!rec || !this.#pins.delete(rec.id))
                return;
            if (rec.disk && this.#scope)
                this.#touchLru(rec.id);
            this.#saveSparseMeta();
            this.#toMaterialize.add(rec.id);
            await this.#drain();
        }).then(() => this.#pump());
    }
    /** 釘選的檔案（路徑，排序） */
    pinned() {
        const out = [];
        for (const id of this.#pins) {
            const rec = this.#files.get(id);
            const head = rec ? this.#latestHead(rec) : null;
            if (head)
                out.push(head.path);
        }
        return out.sort();
    }
    /**
     * 安全地清掉本機的一份內容（SDK ADR 0058）：刪掉磁碟上的檔案與保存的內容，但**不產生刪除版本**——其他裝置照常保留，
     * 之後重新納入（內容範圍、釘選、`fetch`、`setExcludes` 移除排除）時當成要重新抓，不會被當成「使用者刪了它」。
     *
     * - 輕量成員：範圍外（快取、取消釘選的）檔案可以清；在內容範圍內的回 `in-scope`（清了會立刻再抓回來）。
     *   有還沒送出的本機修改時先收成版本、回 `unsent`，送出後自動清掉。釘選的會一併取消釘選。
     * - 完整成員與輕量成員都可以清**因排除而停止追蹤**的本機副本（`detached()`）：本機改過就不清（`modified`，否則修改會遺失）。
     *   這修掉 ADR 0047 的風險：應用自己刪掉被排除的檔案，重新納入時會被當成「使用者刪了」而產生刪除版本。
     */
    evict(path) {
        return this.#run(async () => {
            const det = this.#detAt(path);
            if (det)
                return this.#evictDetached(det);
            const id = this.#byDisk.get(path) ?? this.#diskOccupant(path, '');
            const rec = id !== undefined ? this.#files.get(id) : this.#lookupRecord(path).rec;
            if (!rec)
                return { evicted: false, reason: 'unknown' };
            if (!rec.disk)
                return { evicted: false, reason: 'not-local' };
            if (!this.#scope)
                return { evicted: false, reason: 'in-scope' };
            const pinnedBefore = this.#pins.delete(rec.id);
            this.#lru.delete(rec.id);
            if (pinnedBefore)
                this.#saveSparseMeta();
            this.#lruDirty = true;
            if (this.#inPatternScope(rec))
                return { evicted: false, reason: 'in-scope' };
            // 先把本機還沒收進來的修改收成版本（不遺失），再清
            const st = await this.#adapter.stat(rec.disk.path);
            if (st && (st.size !== rec.disk.size || st.mtime !== rec.disk.mtime))
                await this.#ingestExisting(rec, st);
            const result = await this.#evictLocal(rec, 'evict');
            await this.#drain();
            return result === 'ok' ? { evicted: true } : { evicted: false, reason: rec.disk ? 'unsent' : 'not-local' };
        }).then((result) => {
            this.#pump();
            return result;
        });
    }
    /**
     * 被擋下、沒有同步的本機新增（SDK ADR 0058）：`base-missing`（在內容不在這台的檔案路徑上建立了檔案，要先 `fetch`）、
     * `create-outside`（不在允許新增的範圍）。檔案留在本機原處，協調器不碰。
     */
    blockedLocal() {
        return [...this.#blockedLocal].map(([path, b]) => ({ path, code: b.code })).sort((a, b) => (a.path < b.path ? -1 : 1));
    }
    /**
     * 批次模式下經中繼補送的速率（每小時幾則；SDK ADR 0053 §G16，CinderSync G16）。執行中改、立刻生效：
     * 例如有可用的直連時調成 0（**暫停**經中繼補送，只走 P2P），直連斷了再調回來。小數取整數；負數或 NaN 丟 `RangeError`。
     * 塊數預算（`relayLimits`）照樣守著。建構時的 `relayBulkPerHour` 行為不變（最小 1）。
     */
    setRelayBulkPerHour(perHour) {
        if (typeof perHour !== 'number' || Number.isNaN(perHour) || perHour < 0)
            throw new RangeError('setRelayBulkPerHour：要 ≥ 0 的數字');
        this.#relayBulkPerHour = Math.floor(perHour);
        this.#clock.clearTimeout(this.#retryTimer);
        this.#pump();
    }
    /** 目前批次模式下經中繼補送的速率（每小時幾則；0＝暫停） */
    get relayBulkPerHour() {
        return this.#relayBulkPerHour;
    }
    /**
     * 重設 P2P 的重試退避、立刻再試一次（SDK ADR 0053 §G15，CinderSync G15）。給應用「知道對方剛上線」或「網路剛恢復」時用，
     * 不必等退避（最長 30 分鐘）結束；省略 `device`＝名單上每一台。名單外的裝置、自己的 id 忽略。沒有 `peers` 時什麼都不做。
     * 指定 `device` 時也開（或沿用）到它的通道並掛上收方（v0.44.0）：應用自己開通道探測對方之後呼叫，對方經那條通道送來的收得到。
     */
    retryPeers(device) {
        if (!this.#peers || !this.#started || this.#stopped)
            return;
        const targets = this.#peerDevices();
        if (device !== undefined) {
            if (!targets.includes(device))
                return;
            // 指定了裝置＝應用知道它此刻連得上（例如自己開通道探測過）：也在那條通道上掛收方，它經這條通道送來的收得到——
            // 這台沒有要送給它的東西時，協調器自己不會開通道（v0.44.0 修正，SDK ADR 0057）
            void this.#listenTo(device);
            this.#scheduleP2P(device, true);
            return;
        }
        this.#p2pState.clear();
        this.#scheduleP2P();
    }
    /**
     * 這台所知的另一台裝置的接收狀態（SDK ADR 0053 §G17，CinderSync G17）：最後一次看到它、最後一次收齊它的摘要、
     * 這台目前的版本裡（含刪除）它還沒有的檔案數。只用已經在收送的訊息（它送來的版本與摘要、直連批次的送達確認），
     * 不為它多送任何東西；經中繼送出的版本要等它的下一份摘要或下一個版本才知道收到了。
     */
    peerStatus(device) {
        const seen = this.#meta.ps?.[device];
        let files = 0;
        let known = 0;
        let missing = 0;
        for (const rec of this.#files.values()) {
            if (rec.heads.length === 0)
                continue;
            files += 1;
            const theirs = rec.peers[device];
            if (theirs && theirs.length > 0)
                known += 1;
            if (!rec.heads.every((h) => this.#peerHas(rec, theirs, h)))
                missing += 1;
        }
        return { device, lastSeenAt: seen?.s ?? null, reportedAt: seen?.r ?? null, missing, files, known, sparse: this.#peerScopes.has(device) };
    }
    /** 名單上每一台（`peers`）加上曾經看到過的裝置的接收狀態，依裝置 id 排序 */
    peerStatuses() {
        const devices = new Set([...this.#peerDevices(), ...Object.keys(this.#meta.ps ?? {})]);
        devices.delete(this.#deviceId);
        return [...devices].sort().map((d) => this.peerStatus(d));
    }
    /**
     * 這台記得的、那台裝置每個檔案已知的版本頭（SDK ADR 0053 §G17）；只列有記錄的檔案。唯讀的複本。
     * 每個檔案最多記 8 個（祖先被後代涵蓋時只留後代）。
     */
    knownHeads(device) {
        const out = [];
        for (const rec of this.#files.values()) {
            const theirs = rec.peers[device];
            if (theirs && theirs.length > 0)
                out.push({ fileId: rec.id, heads: [...theirs] });
        }
        return out.sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
    }
    /**
     * 應用在協調器之外看到那台裝置有動靜（例如名單同步收到它的名單、直連握手成功）時通報，更新 `lastSeenAt`（SDK ADR 0053 §G17）。
     * `at` 省略＝現在；比已記錄的舊就不動。自己的 id 忽略。
     */
    notePeerActivity(device, at) {
        if (device === this.#deviceId || !isValidDeviceId(device) || this.#stopped)
            return;
        const when = at ?? this.#clock.now();
        void this.#run(async () => this.#noteSeen(device, when)).catch(() => { });
    }
    #noteSeen(device, at, reported = false) {
        const ps = (this.#meta.ps ??= {});
        const entry = (ps[device] ??= {});
        if (entry.s === undefined || at > entry.s)
            entry.s = at;
        if (reported && (entry.r === undefined || at > entry.r))
            entry.r = at;
        this.#metaDirty = true;
    }
    /** 那台裝置已知的版本頭裡，有沒有涵蓋 `head` 的（相同或是它的後代） */
    #peerHas(rec, theirs, head) {
        if (!theirs)
            return false;
        return theirs.some((k) => k === head || (rec.nodes[k] !== undefined && rec.nodes[head] !== undefined && isAncestor(rec.nodes, head, k)));
    }
    /**
     * 進行中的直連傳輸（SDK ADR 0053 §G14，CinderSync G14）：每一條批次串流（送或收）一筆，含對方裝置、通道種類、
     * 檔案數與位元組數、正在傳的檔案。結束的不列（最後一次 `progress` 事件帶 `ended`）。累計位元組見 `status().p2pBytes`。
     */
    transfers() {
        return [...this.#transfers.values()].map(({ progress }) => cloneProgress(progress));
    }
    #beginTransfer(device, direction, mode, totals) {
        this.#transferSeq += 1;
        const id = `${direction === 'send' ? 's' : 'r'}${this.#transferSeq}`;
        const now = this.#clock.now();
        const progress = {
            id,
            device,
            direction,
            mode,
            files: { done: 0, ...(totals.files !== undefined ? { total: totals.files } : {}) },
            bytes: { done: 0, ...(totals.bytes !== undefined ? { total: totals.bytes } : {}) },
            startedAt: now,
            updatedAt: now,
        };
        this.#transfers.set(id, { progress, emittedAt: now });
        this.#emit('progress', cloneProgress(progress));
        return id;
    }
    /** 更新一筆傳輸；位元組的增量同時記進累計（`status().p2pBytes`）。節流通知 */
    #updateTransfer(id, update) {
        const entry = this.#transfers.get(id);
        if (!entry)
            return;
        const { progress } = entry;
        if (update.bytes !== undefined && update.bytes > progress.bytes.done) {
            const delta = update.bytes - progress.bytes.done;
            if (progress.direction === 'send')
                this.#p2pBytes.sent += delta;
            else
                this.#p2pBytes.received += delta;
            progress.bytes.done = update.bytes;
        }
        if (update.files !== undefined)
            progress.files.done = update.files;
        if (update.current === null)
            delete progress.current;
        else if (update.current !== undefined)
            progress.current = update.current;
        const now = this.#clock.now();
        progress.updatedAt = now;
        if (now - entry.emittedAt < this.#progressIntervalMs)
            return;
        entry.emittedAt = now;
        this.#emit('progress', cloneProgress(progress));
    }
    #endTransfer(id, ended) {
        const entry = this.#transfers.get(id);
        if (!entry)
            return;
        this.#transfers.delete(id);
        entry.progress.updatedAt = this.#clock.now();
        entry.progress.ended = ended;
        delete entry.progress.current;
        this.#emit('progress', cloneProgress(entry.progress));
    }
    /**
     * 更新同步排除範圍（SDK ADR 0047），例如使用者在設定頁改了排除清單：`sync.setExcludes(compileSyncExcludes({ fixed, user }))`。
     * `null`＝不排除（`ignore` 仍然有效）。**排除不等於刪除**：
     * - 變成被排除的已追蹤檔案停止追蹤：不產生刪除版本，其他裝置照常保留；本機檔案不動。
     * - 從排除移除：重新掃描；停止追蹤的檔案重新納入（期間本機與別台的修改照常合併；內容一樣就什麼都不做），
     *   沒有追蹤紀錄的本機檔案當作新檔加入（別台同路徑同內容會收斂，不同內容產生衝突副本），
     *   這台還沒有的遠端檔案寫入本機。
     * 回傳的 Promise 在重新掃描與套用完成後 resolve（不含網路送出）。
     */
    setExcludes(filter) {
        const before = this.#excl;
        this.#excl = filter ? asPathFilter(filter) : null;
        if (!this.#started || this.#stopped)
            return Promise.resolve();
        return this.#run(async () => {
            this.#noteExcl();
            this.#detachExcluded();
            await this.#scanAll();
            const again = this.#queueIncluded(before);
            await this.#drain();
            // 重新納入的檔案內容可能要別台補送（大檔經 P2P、由對方收到摘要後直送）
            if (again && this.#digestPolicy !== 'manual')
                this.#digestDue = true;
        }).then(() => this.#pump());
    }
    /** 這個路徑會不會被同步（`ignore`、`excludes`、協調器自己的暫存名稱）。監聽器可以先用它過濾（SDK ADR 0047） */
    isExcluded(path) {
        return this.#skip(path);
    }
    /**
     * 因排除而停止追蹤、本機仍保留的檔案（SDK ADR 0047）。`excluded`：路徑在本機的排除範圍；
     * `moved-out`：其他裝置把它搬進了本機排除的範圍，本機在原路徑留著一份不再同步的副本（修改後會當作新檔加入）。
     */
    detached() {
        const out = [];
        for (const rec of this.#files.values()) {
            if (rec.det)
                out.push({ fileId: rec.id, path: rec.det.path, reason: this.#skip(rec.det.path) ? 'excluded' : 'moved-out' });
        }
        return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    /** 目前經中繼送的單檔門檻（位元組）：min(中繼宣告, 所有成員都收得下)。更大的只走 P2P */
    get relayMaxFileBytes() {
        return this.#effectiveRelayMax();
    }
    #applyMemberCapabilities(caps) {
        const x = caps.maxRelayFileBytes;
        if (typeof x === 'number' && Number.isFinite(x) && x > 0)
            this.#memberMaxBytes = Math.max(SNAPSHOT_TIER_MAX_BYTES, Math.floor(x));
    }
    #effectiveRelayMax() {
        return Math.min(this.#relayMaxBytes, this.#memberMaxBytes);
    }
    #applyRelayLimits(limits) {
        const pos = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
        if (pos(limits.maxFileBytes))
            this.#relayMaxBytes = Math.min(RELAY_FILE_MAX_BYTES_CAP, Math.max(SNAPSHOT_TIER_MAX_BYTES, Math.floor(limits.maxFileBytes)));
        if (pos(limits.chunksPerRecipient))
            this.#relayBudget = relayChunkBudget({ chunksPerRecipient: limits.chunksPerRecipient });
        if (pos(limits.retentionSeconds))
            this.#relayWindowMs = Math.max(HOUR_MS, limits.retentionSeconds * 1000);
    }
    /** 讀回持久化狀態、（預設）全量掃描一次、開始收送。 */
    async start() {
        if (this.#started)
            return;
        this.#started = true;
        try {
            await this.#load();
            // 狀態識別碼（SDK ADR 0074）：新的狀態（或升級前的）第一次啟動時產生
            if (this.#meta.sid === undefined) {
                this.#meta.sid = this.#randomId();
                this.#metaDirty = true;
            }
            // 啟動前就停止追蹤被排除的檔案：之後排進來的遠端刪除不會碰到它們（SDK ADR 0047）
            this.#detachExcluded();
            // 版本歷史：版本圖裡還沒歸檔的版本（升級前的狀態儲存、歷史關閉期間的）補進來，第一個工作結束時處理（SDK ADR 0063）。
            // 歷史一直開著時只補比歸檔最新時間還新的（不必逐檔讀歸檔比對）；這次啟動剛遷移過的，遷移時已經逐檔補過
            if (!this.#histEnabled()) {
                if (this.#meta.hl) {
                    delete this.#meta.hl;
                    this.#metaDirty = true;
                }
            }
            else if (!this.#histMigrated)
                this.#histSeed(this.#meta.hl !== true);
            if (isStaleDevice(this.#meta.lastSyncAt, this.#clock.now(), this.#opts.staleAfterMs))
                this.#paused = 'stale-device';
        }
        finally {
            this.#openGate();
        }
        this.#offMessage = this.#transport.onMessage((message) => this.#onMessage(message));
        this.#offStatus = this.#transport.onStatusChange((online) => this.#onStatus(online));
        this.#offIncoming = this.#peers?.onIncoming((device, channel) => {
            if (this.#stopped || device === this.#deviceId || !this.#peers?.devices().includes(device))
                return;
            this.#attach(device, channel);
            this.#scheduleP2P(device, true);
        });
        if (this.#opts.scanOnStart)
            await this.scan();
        if (this.#excl !== null || this.#byDet.size > 0 || this.#meta.ex === true) {
            // 規則可能和上次不同：這台還沒寫入、現在納入的遠端檔案寫進來；被排除的內容不再等（SDK ADR 0047）
            await this.#run(async () => {
                this.#noteExcl();
                this.#dropExcludedPending();
                this.#queueIncluded('all');
                await this.#drain();
            }).then(() => this.#pump());
        }
        await this.#run(async () => {
            // 輕量成員：範圍可能和上次不同（或從輕量改回完整）——該清的清、該抓的抓（SDK ADR 0058）。
            // 也包括上次還在等內容的檔案（「在等」不持久化）：重新排進來，再要一次
            this.#queueScope();
            await this.#drain();
        }).then(() => this.#pump());
        this.#scheduleTick();
        this.#onStatus(this.#transport.isOnline());
        this.#scheduleP2P();
    }
    /** 停止收送、等排隊中的工作與寫入完成。狀態都已持久化，之後可以用新的實例 `start()` 接續。 */
    async stop() {
        this.#stopped = true;
        if (!this.#started)
            return;
        this.#offMessage?.();
        this.#offStatus?.();
        this.#offIncoming?.();
        for (const off of this.#unhandle.splice(0))
            off();
        this.#clock.clearTimeout(this.#retryTimer);
        this.#clock.clearTimeout(this.#tickTimer);
        if (this.#receiptTimer !== undefined)
            this.#clock.clearTimeout(this.#receiptTimer);
        this.#receiptTimer = undefined;
        this.#dropWantBatch();
        this.#checkSent();
        for (const waiter of this.#fetchWaiters) {
            if (waiter.timer !== undefined)
                this.#clock.clearTimeout(waiter.timer);
            waiter.reject(new VaultScopeError('stopped', waiter.path));
        }
        this.#fetchWaiters.clear();
        await this.#queue;
        // 節流中還沒寫的中繼帳（SDK ADR 0068）：停止時一定寫
        const writes = [];
        this.#ledgerWrites(writes, true);
        await Promise.all(writes).catch(() => undefined);
        await this.#store.flush();
    }
    /**
     * 外掛收到 Vault 事件時呼叫（建議先防抖）。改名請傳 `oldPath`：改名是**一個**操作，
     * 保留檔案身分，別台同時對舊路徑的修改會跟著套到新路徑上。
     */
    notifyLocalChange(path, kind = 'modify', oldPath) {
        return this.#run(async () => {
            this.#blockedNow = new Map();
            try {
                if (kind === 'rename' && oldPath !== undefined)
                    await this.#ingestRename(oldPath, path);
                else
                    await this.#ingestPath(path);
                await this.#drain();
                return this.#blockedNow.get(path) ?? null;
            }
            finally {
                this.#blockedNow = null;
            }
        }).then((blocked) => {
            this.#pump();
            // 輕量成員：這個檔案被擋下了（沒有基準內容、或不在允許新增的範圍；SDK ADR 0058）
            if (blocked)
                throw blocked;
        });
    }
    /** 全量掃描：列出所有檔案，和索引比對（先比大小與修改時間，有差才讀內容）。O(n)。 */
    scan() {
        return this.#run(async () => {
            await this.#scanAll();
            await this.#drain();
        }).then(() => this.#pump());
    }
    /** 沉睡裝置（離線超過 30 天）回來時，使用者確認後呼叫，才開始合併與送出。 */
    confirmStaleResume() {
        if (!this.#paused)
            return Promise.resolve();
        this.#paused = null;
        const held = this.#held.splice(0);
        for (const message of held)
            void this.#onMessage(message)?.catch(() => { });
        this.#onStatus(this.#transport.isOnline());
        return this.#run(async () => { });
    }
    /** 第 3 批（P2P）送來大檔內容時呼叫；雜湊不符會丟例外。 */
    supplyContent(fileId, versionId, bytes) {
        return this.#run(async () => {
            const rec = this.#files.get(fileId);
            const node = rec?.nodes[versionId];
            if (!rec || !node || node.deleted)
                throw new Error('supplyContent：未知的版本');
            if (bytes.length !== node.size || sha256Hex(bytes) !== node.hash)
                throw new Error('supplyContent：內容與版本的雜湊不符');
            this.#taskCache.set(node.hash, bytes);
            await this.#putBlob(rec, node.hash, bytes);
            this.#pending.delete(versionId);
            await this.#converge(rec);
            await this.#drain();
        }).then(() => this.#pump());
    }
    /** 讀某個版本的內容（第 3 批送大檔時用）；拿不到回 null。 */
    readVersionContent(fileId, versionId) {
        return this.#run(async () => {
            const rec = this.#files.get(fileId);
            const node = rec?.nodes[versionId];
            if (!rec || !node || node.deleted)
                return null;
            return (await this.#getContent(rec, node.hash)) ?? null;
        });
    }
    /** 路徑 → 版本索引（目前磁碟上的每個同步中檔案）。 */
    index() {
        const out = [];
        for (const rec of this.#files.values()) {
            if (rec.disk)
                out.push({ fileId: rec.id, path: rec.disk.path, versionId: rec.disk.base, hash: rec.disk.hash, size: rec.disk.size });
        }
        return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    /** 已刪除、墓碑還在保留期內的檔案。 */
    tombstones() {
        const out = [];
        for (const rec of this.#files.values()) {
            const head = rec.heads.length === 1 ? rec.nodes[rec.heads[0]] : undefined;
            if (head?.deleted)
                out.push({ path: head.path, deletedAt: head.at });
        }
        return out;
    }
    // ───────────────────────────── 版本歷史（SDK ADR 0063） ─────────────────────────────
    /**
     * 更新版本歷史的保留規則（SDK ADR 0063）；沒給的欄位維持原值。調小立刻套用（稀疏化、清掉過期與超量的）；
     * 從關閉改成打開時，版本圖裡還留著的版本補進歸檔。
     */
    setHistory(options) {
        const was = this.#histEnabled();
        this.#histOpts = normalizeHistoryOptions(options, this.#histOpts);
        if (!this.#started || this.#stopped)
            return Promise.resolve();
        return this.#run(async () => {
            const now = this.#histEnabled();
            if (!was && now)
                this.#histSeed(true);
            if (was && !now && this.#meta.hl) {
                delete this.#meta.hl;
                this.#metaDirty = true;
            }
            await this.#histFlush();
            await this.#histRetainAll(this.#clock.now(), true);
        });
    }
    /**
     * 版本歷史的概況：是否開啟、歸檔的檔案數與版本數、檢查點數、內容佔用（位元組）與上限。從每檔摘要算，不讀完整的歸檔。
     * `bytes`：各檔參照的內容（同一個檔案裡以雜湊去重；不同檔案剛好內容相同時各算一次，磁碟上只存一份）加上只有檢查點留著的內容。
     * `pinnedBytes`：命名檢查點留著的內容（不受保留天數與 `maxBytes` 限制，`bytes` 也含它；上限只管其餘的）。
     */
    historyStatus() {
        let files = 0;
        let versions = 0;
        for (const s of this.#histSum.values()) {
            if (s.c === 0)
                continue;
            files += 1;
            versions += s.c;
        }
        return {
            enabled: this.#histEnabled(),
            files,
            versions,
            checkpoints: this.#cps.length,
            bytes: this.#histBytes,
            pinnedBytes: this.#cpPinnedBytes(),
            maxBytes: this.#histOpts.maxBytes,
        };
    }
    /**
     * 一個檔案的歸檔版本，新到舊（SDK ADR 0063）。含已刪除的檔案；改名前的版本也在（同一個檔案身分）。
     * 字串先當 fileId，否則當路徑（比對方式同 `pathKey`）：現在（或最後）在這個路徑上的檔案，沒有就找曾經在這個路徑上的。
     * v0.50 起是非同步的：第一次用到某個檔案時才讀它完整的歸檔，之後放在快取裡（LRU，有上限）。
     */
    async history(target) {
        const items = [];
        for (const fileId of this.#histResolve(target)) {
            const hf = await this.#histGet(fileId);
            for (const e of hf?.entries ?? [])
                items.push([e, this.#histPublic(fileId, e)]);
        }
        return items.sort((a, b) => compareHistory(b[0], a[0])).map(([, entry]) => entry);
    }
    /**
     * 讀一個歸檔版本的內容（SDK ADR 0063）：文字檔從歸檔讀；二進位檔（不歸檔內容）只有在內容和這個檔案現在的相同時讀得到。
     * 刪除版本、讀不到回 null。給 `{ fileId, versionId }`（例如 `history()` 回來的那一筆）最快；只給版本 id 時先找快取、
     * 摘要與版本圖，都沒有才逐檔找。
     */
    readHistory(version) {
        return this.#run(async () => {
            const found = await this.#histLocate(version);
            if (!found || found.entry.deleted)
                return null;
            return (await this.#contentOf(found.fileId, found.entry.hash)) ?? null;
        });
    }
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
    restore(path, version) {
        const versionId = typeof version === 'string' ? version : version.versionId;
        if (this.#stopped || !this.#started)
            return Promise.reject(new VaultHistoryError('stopped', versionId));
        return this.#run(async () => {
            const found = await this.#histLocate(version);
            if (!found)
                return new VaultHistoryError('unknown', versionId);
            const { fileId, entry: e } = found;
            if (e.deleted)
                return new VaultHistoryError('deleted', versionId);
            const bytes = await this.#contentOf(fileId, e.hash);
            if (!bytes)
                return new VaultHistoryError(e.text ? 'content-missing' : 'binary', versionId);
            const result = await this.#restoreWrite(path, bytes, e.hash, this.#files.get(fileId), versionId);
            await this.#drain();
            if (result === 'changed')
                return new Error(`還原 ${path} 時檔案一直在變動，稍後再試`);
            if (result instanceof Error)
                return result;
            if (result.outcome === 'restored')
                this.#logOperation({ kind: 'restore-file', target: { versionId, path }, restored: [path], removed: [], skipped: [] });
            return result;
        }).then((result) => {
            this.#pump();
            if (result instanceof Error)
                throw result;
            return result;
        });
    }
    /**
     * 最近刪除的檔案（最後一版是刪除），新到舊（SDK ADR 0063）。`since`：只列這個時間（毫秒）之後刪的。
     * 從每檔摘要算（同步、不讀完整的歸檔）。
     */
    deletedFiles(options = {}) {
        const out = [];
        for (const [fileId, s] of this.#histSum) {
            const last = s.l;
            if (!last?.deleted || last.absorbed)
                continue;
            if (options.since !== undefined && last.at < options.since)
                continue;
            // 版本圖裡它還活著（例如別台的修改讓它回來、輕量成員範圍外沒歸檔的後續版本）
            const rec = this.#files.get(fileId);
            if (rec && (rec.disk || rec.heads.some((h) => rec.nodes[h] !== undefined && !rec.nodes[h].deleted)))
                continue;
            out.push({
                fileId,
                path: last.path,
                deletedAt: last.at,
                device: last.device,
                label: last.label,
                lastVersion: s.lv ? this.#histPublic(fileId, s.lv) : null,
            });
        }
        return out.sort((a, b) => b.deletedAt - a.deletedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    /**
     * 整個 Vault 在時間 T（或一個檢查點）的狀態（SDK ADR 0063 裁示 6、補充 4）。優先從 T 之前最近的檢查點開始（`source: 'checkpoint'`；
     * 那一刻的狀態是確切的，之後到 T 之間有變動的檔案照各檔歸檔補上，這時 `mixed` 是 true）；沒有檢查點才全部照各檔歸檔推算
     * （`source: 'reconstructed'`，`mixed` 一定是 true：每個檔案取 `at ≤ T` 的最後一版，可能組合出從沒同時存在過的版本）。
     * 路徑是 T 時的路徑。只涵蓋這台的歸檔（保留規則與稀疏化之內、這台加入之後、輕量成員只有內容範圍）。依路徑排序。
     * 逐檔讀（摘要夠用的檔案不讀完整的歸檔），不把整個歸檔留在記憶體。
     * 不認得的檢查點丟 `VaultHistoryError('checkpoint-unknown')`；跟著保留天數過期的「還原之前」檢查點丟 `checkpoint-expired`。
     */
    vaultAt(target) {
        return this.#runRead(async () => {
            const point = this.#pointSpec(target);
            if (point instanceof VaultHistoryError)
                return point;
            const out = [];
            for (const fileId of this.#pointFiles(point)) {
                const state = await this.#pointState(point, fileId);
                if (!state.known || !state.entry)
                    continue;
                const e = state.entry;
                const restorable = e.unavailable === undefined && (e.content || this.#files.get(fileId)?.disk?.hash === e.hash);
                out.push({ fileId, path: e.path, versionId: e.versionId, hash: e.hash, size: e.size, text: e.text, at: e.at, device: e.device, label: e.label, restorable });
            }
            out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.fileId < b.fileId ? -1 : 1));
            return { at: point.at, source: point.cp ? 'checkpoint' : 'reconstructed', ...(point.cp ? { checkpoint: this.#cpPublic(point.cp) } : {}), mixed: point.mixed, files: out };
        }).then((result) => {
            if (result instanceof VaultHistoryError)
                throw result;
            return result;
        });
    }
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
    planRestoreVault(target, options = {}) {
        const opts = typeof target === 'number' ? options : { ...options, ...target };
        return this.#runRead(async () => {
            const point = this.#pointSpec(typeof target === 'number' ? target : target.checkpoint !== undefined ? { checkpoint: target.checkpoint } : (target.at ?? this.#clock.now()));
            if (point instanceof VaultHistoryError)
                return point;
            const include = opts.paths !== undefined ? compilePathScope(opts.paths) : undefined;
            const removeCreatedAfter = opts.removeCreatedAfter === true;
            const plan = emptyRestorePlan(point.at, this.#clock.now());
            for (const fileId of this.#pointFiles(point)) {
                const state = await this.#pointState(point, fileId);
                const cur = this.#histCurrent(fileId);
                const e = state.known ? state.entry : null;
                // 現在的內容在不在歸檔：只有要覆寫（內容不同）或要刪（T 時不存在）時才需要知道
                const needCur = cur.state === 'live' && (e ? e.hash !== cur.hash && e.content : state.known && removeCreatedAfter);
                addToRestorePlan(plan, fileId, state, cur, {
                    removeCreatedAfter,
                    removeCreatedBinaries: opts.removeCreatedBinaries === true,
                    ...(include ? { include } : {}),
                    excluded: (path) => this.#skip(path),
                    curArchived: needCur && cur.state === 'live' ? await this.#histHas(fileId, cur.hash) : false,
                    thenArchived: e !== null && e.content,
                });
            }
            finishRestorePlan(plan);
            plan.source = point.cp ? 'checkpoint' : 'reconstructed';
            if (point.cp)
                plan.checkpoint = this.#cpPublic(point.cp);
            plan.mixed = point.mixed;
            return plan;
        }).then((result) => {
            if (result instanceof VaultHistoryError)
                throw result;
            return result;
        });
    }
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
    restoreVault(plan, options = {}) {
        if (this.#stopped || !this.#started) {
            const all = [...plan.revert, ...plan.undelete, ...plan.remove].map((i) => ({ fileId: i.fileId, path: i.path, reason: 'error', versionId: i.versionId, error: new VaultHistoryError('stopped', i.versionId) }));
            return Promise.resolve({ restored: [], removed: [], skipped: [...plan.unrestorable, ...all] });
        }
        return this.#run(async () => {
            const before = await this.#cpCreate('restore');
            const report = await this.#restoreVault(plan, options);
            await this.#drain();
            this.#logOperation({
                kind: 'restore-vault',
                target: plan.checkpoint ? { checkpoint: plan.checkpoint.id, at: plan.at } : { at: plan.at },
                before: before.id,
                restored: report.restored.map((i) => i.path),
                removed: report.removed.map((i) => i.path),
                skipped: report.skipped.map((i) => ({ path: i.path, reason: i.reason })),
            });
            return report;
        }).then((report) => {
            this.#pump();
            return report;
        });
    }
    /**
     * 建立一個檢查點（SDK ADR 0063 補充 1、3）：這一刻整個 Vault 的清單（路徑 → 檔案、版本、內容雜湊；內容沿用歸檔、以雜湊去重，
     * 文字檔的內容確定存進歸檔）。只在這台、不同步。
     * - `{ name }`：命名檢查點（像 git 的 tag）：不稀疏化、不過期，內容一直保留（不受保留天數與 `maxBytes` 限制）；最多 50 個，
     *   超過丟 `VaultHistoryError('checkpoint-limit')`（不會自動清掉任何一個）；同名或名稱不合格丟 `checkpoint-name`。
     * - `{ auto: true }`：自動檢查點（協調器在同步告一段落時自己會呼叫）：距離上一個自動檢查點不到一小時、或和最新的檢查點完全相同時不建立、回 null。
     * - 都沒給：立刻建立一個一般（`auto`，依稀疏化規則保留）的檢查點；和最新的檢查點完全相同時回那一個。
     * 輕量成員：內容不在這台的檔案也列，但標成不能從這個檢查點還原。
     */
    checkpoint(options = {}) {
        if (this.#stopped || !this.#started)
            return Promise.reject(new VaultHistoryError('stopped', ''));
        return this.#run(async () => {
            if (options.name !== undefined) {
                const name = this.#cpName(options.name, undefined);
                if (name instanceof VaultHistoryError)
                    return name;
                if (this.#cps.filter((c) => c.kind === 'named').length >= MAX_NAMED_CHECKPOINTS)
                    return new VaultHistoryError('checkpoint-limit', '');
                return this.#cpPublic(await this.#cpCreate('named', name));
            }
            const latest = this.#cps[this.#cps.length - 1];
            if (options.auto) {
                if (!this.#histEnabled())
                    return null;
                const lastAuto = [...this.#cps].reverse().find((c) => c.kind === 'auto');
                // 從上一個建立的自動檢查點算起（SDK ADR 0072：沒有變動的嘗試不算）；`minIntervalMs` 由應用給（例如它的同步頻率）
                const min = options.minIntervalMs !== undefined && Number.isFinite(options.minIntervalMs) ? Math.max(0, options.minIntervalMs) : AUTO_CHECKPOINT_INTERVAL_MS;
                if (lastAuto && this.#clock.now() - lastAuto.at < min)
                    return null;
            }
            if (latest && isEmptyDiff(diffManifest(this.#cpMaterialize(latest), this.#cpCurrent())))
                return options.auto ? null : this.#cpPublic(latest);
            const created = await this.#cpCreate('auto');
            this.#cpRetain(this.#clock.now());
            return this.#cpPublic(created);
        }).then((result) => {
            if (result instanceof VaultHistoryError)
                throw result;
            return result;
        });
    }
    /** 這台的檢查點（自動、還原之前、命名的），新到舊 */
    checkpoints() {
        return [...this.#cps].reverse().map((c) => this.#cpPublic(c));
    }
    /**
     * 改檢查點的名稱。自動或「還原之前」的檢查點改了名就變成命名檢查點（不再稀疏化、內容一直保留；算進 50 個的上限）。
     * 丟 `VaultHistoryError`：`checkpoint-unknown`、`checkpoint-name`、`checkpoint-limit`。
     */
    renameCheckpoint(id, name) {
        return this.#run(async () => {
            const cp = this.#cpById(id);
            if (!cp)
                return new VaultHistoryError('checkpoint-unknown', id);
            const valid = this.#cpName(name, cp.id);
            if (valid instanceof VaultHistoryError)
                return valid;
            if (cp.kind !== 'named') {
                if (this.#cps.filter((c) => c.kind === 'named').length >= MAX_NAMED_CHECKPOINTS)
                    return new VaultHistoryError('checkpoint-limit', id);
                this.#cpPin(this.#cpMaterialize(cp), 1);
                cp.kind = 'named';
            }
            cp.name = valid;
            this.#cpDirty.add(cp.id);
            return this.#cpPublic(cp);
        }).then((result) => {
            if (result instanceof VaultHistoryError)
                throw result;
            return result;
        });
    }
    /** 刪掉一個檢查點（任何一種）；它留著的內容沒有其他人用就一起清掉。不認得丟 `VaultHistoryError('checkpoint-unknown')` */
    deleteCheckpoint(id) {
        return this.#run(async () => {
            const cp = this.#cpById(id);
            if (!cp)
                return new VaultHistoryError('checkpoint-unknown', id);
            this.#cpDelete(cp, 'deleted');
            return null;
        }).then((error) => {
            if (error)
                throw error;
        });
    }
    /**
     * 本機的操作紀錄（像 git 的 reflog），新到舊：每一次還原（整個 Vault、單一檔案）一筆，最多留 200 筆。
     * `undoAvailable`：「還原之前」的檢查點還在、可以復原；跟著保留天數過期（或被刪、被容量清掉）之後紀錄照留、標 false 並附原因。
     */
    operations() {
        return [...this.#ops].reverse().map((op) => {
            const { ux, ...rest } = op;
            const available = op.kind === 'restore-vault' && op.before !== undefined && this.#cpById(op.before) !== undefined;
            const reason = available ? undefined : op.before === undefined ? 'no-checkpoint' : `before-${ux ?? 'deleted'}`;
            return {
                ...rest,
                target: { ...op.target },
                restored: [...op.restored],
                removed: [...op.removed],
                skipped: op.skipped.map((s) => ({ ...s })),
                counts: { ...op.counts },
                undoAvailable: available,
                ...(reason !== undefined ? { undoUnavailable: reason } : {}),
            };
        });
    }
    /**
     * 清空版本歷史（SDK ADR 0063 §隱私）：狀態儲存裡的歸檔（`ha:`、`hs:`、`hc:`）、檢查點（`hk:`、`hq`）與操作紀錄（`ho`）全部刪掉，
     * 例如重設身分或移除裝置時。之後的修改照常歸檔；重開時不會從版本圖把清空之前的版本補回來。
     */
    clearHistory() {
        return this.#run(async () => {
            this.#histGen += 1;
            this.#histNew.clear();
            this.#histWant.clear();
            this.#histDirty.clear();
            this.#histSum.clear();
            this.#histShards.clear();
            this.#histShardDirty.clear();
            this.#histCache.clear();
            this.#histLoading.clear();
            this.#histBytes = 0;
            this.#histSeedPending = false;
            this.#cps.length = 0;
            this.#cpCache = null;
            this.#cpRefs.clear();
            this.#cpNamed.clear();
            this.#cpOwn.clear();
            this.#cpOwnDirty = false;
            this.#cpDirty.clear();
            this.#ops.length = 0;
            this.#opsDirty = false;
            this.#meta.hx = Math.max(this.#clock.now(), this.#meta.hlc);
            this.#metaDirty = true;
            await this.#store.flush();
            const keys = [
                ...(await this.#store.keys('ha:')),
                ...(await this.#store.keys(HIST_SHARD_PREFIX)),
                ...(await this.#store.keys('hc:')),
                ...(await this.#store.keys('hk:')),
                'ho',
                'hq',
            ];
            for (const key of keys)
                await this.#store.delete(key);
        });
    }
    status() {
        const status = {
            state: this.#paused
                ? 'paused'
                : !this.#online
                    ? 'offline'
                    : this.#sendFailing
                        ? 'error'
                        : this.#outbox.size > 0 || this.#queued > 0
                            ? 'syncing'
                            : 'idle',
            queue: this.#outbox.size,
            waiting: this.#waiting.size,
            conflicts: [...this.#meta.conflicts],
            pending: [...this.#pending.values()],
        };
        if (this.#meta.lastSyncAt !== undefined)
            status.lastSyncAt = this.#meta.lastSyncAt;
        if (this.#peers) {
            status.bulk = this.#bulkMode();
            this.#prunePushes();
            status.pushes = this.#pushes.size;
            status.p2pBytes = { ...this.#p2pBytes };
        }
        // 每位收件人一列（SDK ADR 0068）；`used` 是最滿的那一位。不知道收件人時是舊的一本帳
        const recipients = this.#recipients();
        if (recipients === null)
            status.relayQuota = { used: this.#ledger.used(null), budget: this.#relayBudget };
        else {
            const devices = this.#ledger.usage(recipients);
            status.relayQuota = { used: devices[0]?.used ?? 0, budget: this.#relayBudget, devices };
        }
        if (this.#scope)
            status.scope = this.#scopeUsage();
        if (this.#blocked)
            status.blocked = this.#blocked;
        if (this.#paused)
            status.pausedReason = this.#paused;
        if (this.#lastError !== undefined && this.#sendFailing)
            status.lastError = this.#lastError;
        return status;
    }
    clearConflicts() {
        return this.#run(async () => {
            this.#meta.conflicts = [];
            this.#metaDirty = true;
        });
    }
    on(event, listener) {
        const set = this.#listeners[event];
        set.add(listener);
        return () => set.delete(listener);
    }
    /** 等目前排隊中的工作都做完（不含網路送出）。 */
    async idle() {
        let last;
        do {
            last = this.#queue;
            await last;
        } while (last !== this.#queue);
        await this.#store.flush();
    }
    /**
     * 等「這一輪送完了」（SDK ADR 0045，G12b）：送出佇列清空、沒有在途的訊息（版本、摘要、索取）、排隊中的工作也做完 → `sent`。
     * 無法前進時不空等，立刻回報原因：`offline`（傳輸層離線）、`paused`（沉睡裝置，`pausedReason`）、`blocked`（中繼明確不收，
     * `blocked` 是原因；佇列留著）、`stopped`。一般的送出失敗會照常退避重試、繼續等；給了 `timeoutMs` 時到了回報 `timeout`。
     * `queue` 是回報當下的待送版本數。P2P 的大檔內容（`pushes`）不在內：它們等對方在線，不屬於這一輪的中繼送出。
     *
     * 「收完」用 `transport.backfill()`（分頁補拉）＋ `idle()`（收到的都套用完）。
     */
    whenSent(options = {}) {
        return new Promise((resolve) => {
            const waiter = { resolve, timer: undefined };
            if (options.timeoutMs !== undefined) {
                waiter.timer = this.#clock.setTimeout(() => this.#settleSent(waiter, { state: 'timeout', queue: this.#outbox.size }), Math.max(0, options.timeoutMs));
            }
            this.#sentWaiters.add(waiter);
            this.#checkSent();
        });
    }
    #settleSent(waiter, result) {
        if (!this.#sentWaiters.delete(waiter))
            return;
        if (waiter.timer !== undefined)
            this.#clock.clearTimeout(waiter.timer);
        waiter.resolve(result);
    }
    /** 現在能不能回報給 `whenSent` 的人；還在前進中回 null */
    #sendOutcome() {
        const queue = this.#outbox.size;
        if (this.#stopped)
            return { state: 'stopped', queue };
        if (!this.#started)
            return null;
        if (this.#paused)
            return { state: 'paused', queue, pausedReason: this.#paused };
        if (!this.#online)
            return { state: 'offline', queue };
        const busy = this.#queued > 0 || this.#pumping || this.#digestDue || this.#auxSending > 0 || this.#inflight.size > 0;
        if (!busy && queue === 0)
            return { state: 'sent', queue };
        if (this.#blocked !== undefined && !this.#pumping && this.#inflight.size === 0)
            return { state: 'blocked', queue, blocked: this.#blocked };
        // 剩下的都在等限速／配額，而且沒有直連正在試：這一輪能送的都送了（SDK ADR 0092）
        if (this.#throttledUntil !== null && !busy && !this.#p2pRunning)
            return { state: 'throttled', queue, retryAt: this.#throttledUntil };
        return null;
    }
    #checkSent() {
        if (this.#sentWaiters.size === 0)
            return;
        const outcome = this.#sendOutcome();
        if (!outcome)
            return;
        for (const waiter of [...this.#sentWaiters])
            this.#settleSent(waiter, outcome);
    }
    /**
     * 送一次摘要給所有裝置（SDK ADR 0028）：裝置名單加入新裝置後呼叫。對方收到後會把缺的版本頭補送或索取回來，
     * 新裝置在名單更新前送來、被傳輸層擋掉的摘要也由此補上。
     *
     * `lost`（預設 true；SDK ADR 0074）：這台可能真的漏收了（名單晚到、訊息被擋掉、中繼說有訊息在送到前被刪掉）——摘要不帶
     * 「已處理到的序號」，對方照舊把這台缺的全部重送。`false`：只是對帳（例如每次啟動一次），對方剛經中繼送出、還在路上的不重送。
     */
    resync(options = {}) {
        if (options.lost !== false)
            this.#digestFull = true;
        this.#digestDue = true;
        this.#pump();
    }
    /** 立刻做一次背景維護（通常由計時器觸發）。 */
    tick() {
        return this.#run(async () => {
            await this.#maintenance();
            await this.#drain();
        }).then(() => {
            this.#pump();
            this.#scheduleP2P();
        });
    }
    // ───────────────────────────── 佇列與事件 ─────────────────────────────
    #run(fn) {
        this.#queued += 1;
        const task = this.#queue.then(async () => {
            try {
                return await fn();
            }
            finally {
                if (this.#fetchWaiters.size > 0)
                    await this.#checkFetches().catch(() => { });
                // 版本歷史：這次工作加入的版本歸檔（內容還在這次工作的快取裡）；歸檔出錯不影響同步（SDK ADR 0063）
                if (this.#histNew.size > 0 || this.#histWant.size > 0)
                    await this.#histFlush().catch((error) => this.#emit('error', { context: 'history', error }));
                this.#taskCache.clear();
                await this.#persist().catch((error) => {
                    this.#persistFailures += 1;
                    this.#emit('error', { context: 'persist', error });
                });
            }
        });
        this.#queue = task.catch((error) => {
            this.#lastError = error instanceof Error ? error.message : String(error);
            this.#emit('error', { context: 'task', error });
        });
        void this.#queue.then(() => {
            this.#queued -= 1;
            this.#emitStatus();
            this.#maybeAutoCheckpoint();
        });
        return task;
    }
    /**
     * 只讀的工作（`vaultAt`、`planRestoreVault`）：排在佇列裡（看到的是一致的狀態），但不算進「同步中」、結束時不歸檔、不寫回、
     * 不觸發自動檢查點。錯誤原樣回給呼叫端，不當成同步錯誤。
     */
    #runRead(fn) {
        const task = this.#queue.then(fn);
        this.#queue = task.then(() => { }, () => { });
        return task;
    }
    #emit(event, payload) {
        for (const listener of this.#listeners[event]) {
            try {
                listener(payload);
            }
            catch {
                // 外掛的監聽器丟例外不影響同步
            }
        }
    }
    #emitStatus() {
        this.#checkSent();
        const status = this.status();
        const sig = JSON.stringify([status.state, status.queue, status.waiting, status.conflicts.length, status.pending.length, status.lastError, status.bulk, status.pushes, status.blocked]);
        if (sig === this.#lastStatus)
            return;
        this.#lastStatus = sig;
        this.#emit('status', status);
    }
    #conflict(conflict) {
        this.#meta.conflicts.push(conflict);
        if (this.#meta.conflicts.length > MAX_CONFLICTS)
            this.#meta.conflicts.splice(0, this.#meta.conflicts.length - MAX_CONFLICTS);
        this.#metaDirty = true;
        this.#emit('conflict', conflict);
    }
    // ───────────────────────────── 持久化 ─────────────────────────────
    async #load() {
        const meta = decodeJson(await this.#store.get('m'));
        if (meta) {
            this.#meta = { hlc: meta.hlc ?? 0, seq: meta.seq ?? 0, conflicts: meta.conflicts ?? [], ...(meta.lastSyncAt !== undefined ? { lastSyncAt: meta.lastSyncAt } : {}) };
            if (typeof meta.digestAt === 'number' && Number.isFinite(meta.digestAt))
                this.#meta.digestAt = meta.digestAt;
            if (meta.digestDirty === true)
                this.#meta.digestDirty = true;
            if (meta.ex === true)
                this.#meta.ex = true;
            if (typeof meta.hs === 'number' && Number.isFinite(meta.hs))
                this.#meta.hs = meta.hs;
            if (typeof meta.hx === 'number' && Number.isFinite(meta.hx))
                this.#meta.hx = meta.hx;
            if (typeof meta.cs === 'number' && Number.isFinite(meta.cs))
                this.#meta.cs = meta.cs;
            if (typeof meta.os === 'number' && Number.isFinite(meta.os))
                this.#meta.os = meta.os;
            if (typeof meta.hv === 'number')
                this.#meta.hv = meta.hv;
            if (meta.hl === true)
                this.#meta.hl = true;
            if (typeof meta.sid === 'string' && /^[0-9a-f]{32}$/.test(meta.sid))
                this.#meta.sid = meta.sid;
            if (meta.rh && typeof meta.rh === 'object') {
                const rh = {};
                for (const [device, rs] of Object.entries(meta.rh))
                    if (isValidDeviceId(device) && Number.isSafeInteger(rs) && rs > 0)
                        rh[device] = rs;
                if (Object.keys(rh).length > 0)
                    this.#meta.rh = rh;
            }
            if (Array.isArray(meta.pin))
                for (const id of meta.pin)
                    if (typeof id === 'string')
                        this.#pins.add(id);
            if (meta.lru && typeof meta.lru === 'object') {
                for (const [id, at] of Object.entries(meta.lru))
                    if (typeof at === 'number' && Number.isFinite(at))
                        this.#lru.set(id, at);
            }
            if (this.#pins.size > 0 || this.#lru.size > 0)
                this.#saveSparseMeta();
            // 中繼帳（SDK ADR 0068）：舊版的 `relayUse`（一本帳）轉成沒有序號的廣播帳，只會過期
            const use = Array.isArray(meta.relayUse) ? meta.relayUse.filter((e) => Array.isArray(e) && Number.isSafeInteger(e[0]) && Number.isSafeInteger(e[1]) && e[1] > 0) : [];
            // 帳存在自己的鍵（`rb`）；v0.54–v0.55 放在 meta 裡的搬過去（meta 每次寫狀態都整份轉 JSON，帳放在裡面是平方級）
            const stored = decodeJson(await this.#store.get('rb')) ?? meta.rb;
            this.#ledger = RelayLedger.parse(stored, { now: () => this.#clock.now(), windowMs: () => this.#relayWindowMs }, use);
            if (use.length > 0 || meta.rb !== undefined) {
                this.#metaDirty = true;
                this.#ledgerDirty = true;
                this.#ledgerUnsaved = LEDGER_SAVE_EVERY;
            }
            // 寄件序號：跳過一段，萬一上次遞增後還沒存下就關了也不會重複使用
            if (typeof meta.rs === 'number' && Number.isSafeInteger(meta.rs) && meta.rs > 0)
                this.#meta.rs = meta.rs + RS_RESTART_GAP;
            if (meta.rp && typeof meta.rp === 'object') {
                const rp = {};
                for (const [device, ranges] of Object.entries(meta.rp)) {
                    if (!isValidDeviceId(device) || !Array.isArray(ranges))
                        continue;
                    let out = [];
                    for (const r of ranges) {
                        if (Array.isArray(r) && Number.isSafeInteger(r[0]) && Number.isSafeInteger(r[1]) && r[0] >= 1 && r[0] <= r[1])
                            out = addRange(out, r[0], r[1]);
                    }
                    if (out.length > 0)
                        rp[device] = out;
                }
                if (Object.keys(rp).length > 0)
                    this.#meta.rp = rp;
            }
            if (meta.ps && typeof meta.ps === 'object') {
                const ps = {};
                const time = (x) => typeof x === 'number' && Number.isFinite(x);
                for (const [device, v] of Object.entries(meta.ps)) {
                    if (!isValidDeviceId(device) || !v || typeof v !== 'object')
                        continue;
                    ps[device] = { ...(time(v.s) ? { s: v.s } : {}), ...(time(v.r) ? { r: v.r } : {}) };
                }
                this.#meta.ps = ps;
            }
        }
        for (const key of await this.#store.keys('f:')) {
            const rec = decodeJson(await this.#store.get(key));
            if (!rec || typeof rec.id !== 'string')
                continue;
            this.#files.set(rec.id, rec);
            if (rec.disk)
                this.#indexDisk(rec.id, rec.disk.path);
            if (rec.det)
                this.#detIndexAdd(rec.det.path, rec.id);
            this.#updateTarget(rec);
        }
        const queued = [];
        for (const key of await this.#store.keys('q:')) {
            const entry = decodeJson(await this.#store.get(key));
            if (entry)
                queued.push(entry);
        }
        queued.sort((a, b) => a.seq - b.seq);
        for (const entry of queued) {
            this.#outbox.set(entry.seq, entry);
            this.#outboxByNode.set(entry.nodeId, entry.seq);
        }
        for (const key of await this.#store.keys('w:')) {
            const entry = decodeJson(await this.#store.get(key));
            if (entry)
                this.#addWaiting(entry);
        }
        for (const key of await this.#store.keys('x:')) {
            const entry = decodeJson(await this.#store.get(key));
            if (entry && typeof entry.device === 'string')
                this.#pushes.set(`${entry.device}\n${entry.nodeId}`, entry);
        }
        // 檢查點先：遷移舊格式時要知道哪些內容是檢查點留著的
        await this.#cpLoad();
        await this.#histLoad();
    }
    async #persist() {
        const writes = [];
        for (const id of this.#dirty) {
            const rec = this.#files.get(id);
            if (rec)
                writes.push(this.#store.set(`f:${id}`, encodeJson(rec)));
        }
        for (const id of this.#removedRecords)
            if (!this.#files.has(id))
                writes.push(this.#store.delete(`f:${id}`));
        this.#dirty.clear();
        this.#removedRecords.clear();
        this.#histWrites(writes);
        for (const id of this.#cpDirty) {
            const cp = this.#cpById(id);
            writes.push(cp ? this.#store.set(`hk:${id}`, encodeJson(cp)) : this.#store.delete(`hk:${id}`));
        }
        this.#cpDirty.clear();
        if (this.#opsDirty) {
            this.#opsDirty = false;
            writes.push(this.#store.set('ho', encodeJson(this.#ops)));
        }
        this.#ledgerWrites(writes);
        if (this.#metaDirty) {
            this.#metaDirty = false;
            writes.push(this.#store.set('m', encodeJson(this.#meta)));
        }
        await Promise.all(writes);
        // 背景寫入（等父版本的、待推送清單…）也要落地，「已保存」才成立（SDK ADR 0067：收件確認以此為準）
        if (this.#background.size > 0)
            await Promise.allSettled([...this.#background]);
        if (this.#backgroundFailed) {
            this.#backgroundFailed = false;
            throw new Error('有背景寫入失敗');
        }
        this.#histTrim();
    }
    /** 不必等的狀態寫入：照舊不擋流程，但 `#persist` 會等它們落地、失敗就算這一輪沒保存好 */
    #bg(write) {
        this.#background.add(write);
        void write.then(() => this.#background.delete(write), () => {
            this.#background.delete(write);
            this.#backgroundFailed = true;
        });
    }
    #markDirty(rec) {
        this.#dirty.add(rec.id);
    }
    #newRecord(id) {
        const rec = { id, nodes: {}, heads: [], disk: null, unsent: {}, peers: {}, blobs: [], pruned: [] };
        this.#files.set(id, rec);
        this.#markDirty(rec);
        return rec;
    }
    async #putBlob(rec, hash, bytes) {
        if (rec.blobs.includes(hash))
            return;
        await this.#store.set(`b:${rec.id}:${hash}`, bytes);
        rec.blobs.push(hash);
        this.#markDirty(rec);
    }
    /** 內容：這次工作的快取 → 狀態儲存 → 磁碟（雜湊相符才算）。 */
    async #getContent(rec, hash) {
        const cached = this.#taskCache.get(hash);
        if (cached)
            return cached;
        if (rec.blobs.includes(hash)) {
            const bytes = await this.#store.get(`b:${rec.id}:${hash}`);
            if (bytes && sha256Hex(bytes) === hash) {
                this.#taskCache.set(hash, bytes);
                return bytes;
            }
        }
        // 磁碟上的那一份；停止追蹤的本機副本也算（已經發布過的版本內容照樣能提供給要的裝置，雜湊相符才算；SDK ADR 0047）
        const local = rec.disk ?? rec.det;
        if (local && local.hash === hash) {
            try {
                const bytes = await this.#adapter.read(local.path);
                if (sha256Hex(bytes) === hash) {
                    this.#taskCache.set(hash, bytes);
                    return bytes;
                }
            }
            catch {
                // 讀不到就當作沒有
            }
        }
        // P2P 串流剛收到、還在暫存裡的內容（大檔要整檔讀進記憶體：只有合併或沒有 writeStream 時才走到這裡）
        const staged = this.#staged.get(hash);
        if (staged) {
            const bytes = await staged.read(0, staged.size);
            if (sha256Hex(bytes) === hash) {
                this.#taskCache.set(hash, bytes);
                return bytes;
            }
        }
        return undefined;
    }
    // ───────────────────────────── 版本圖 ─────────────────────────────
    #stamp() {
        const t = Math.max(this.#clock.now(), this.#meta.hlc + 1);
        this.#meta.hlc = t;
        this.#metaDirty = true;
        return t;
    }
    #addNode(rec, node) {
        rec.nodes[node.id] = node;
        // 加入時就算好「能不能參與 callout 合併」（合併版本＝父版本都能），之後修剪祖先也不改變（SDK ADR 0046）
        rec.cm ??= {};
        if (rec.cm[node.id] === undefined) {
            rec.cm[node.id] = isMergeVersion(node) ? node.parents.every((p) => this.#calloutCapable(rec, p)) : supportsConflictCallouts(rec.nodes, node.id, rec.cm);
        }
        // 同理：能不能參與「Markdown 合併規則」（SDK ADR 0059）
        rec.mr ??= {};
        if (rec.mr[node.id] === undefined) {
            rec.mr[node.id] = isMergeVersion(node) ? node.parents.every((p) => this.#rulesCapable(rec, p)) : supportsMergeRules(rec.nodes, node.id, rec.mr);
        }
        // 同理：能不能參與「callout 後空一行」（SDK ADR 0087）
        rec.cb ??= {};
        if (rec.cb[node.id] === undefined) {
            rec.cb[node.id] = isMergeVersion(node) ? node.parents.every((p) => this.#breakCapable(rec, p)) : supportsCalloutBreak(rec.nodes, node.id, rec.cb);
        }
        rec.heads = computeHeads(rec.nodes);
        this.#diskGen += 1;
        this.#histNote(rec.id, node.id);
        if (node.at > this.#meta.hlc) {
            this.#meta.hlc = node.at;
            this.#metaDirty = true;
        }
        this.#markDirty(rec);
    }
    #hasChildren(rec, id) {
        return Object.values(rec.nodes).some((n) => n.parents.includes(id));
    }
    /** 目前要呈現的版本（只有一個版本頭時）；多個版本頭表示還沒合併 */
    #target(rec) {
        return rec.heads.length === 1 ? rec.nodes[rec.heads[0]] : null;
    }
    #updateTarget(rec) {
        const old = this.#targetKey.get(rec.id);
        if (old !== undefined) {
            this.#byTarget.get(old)?.delete(rec.id);
            if (this.#byTarget.get(old)?.size === 0)
                this.#byTarget.delete(old);
            this.#targetKey.delete(rec.id);
        }
        const target = this.#target(rec);
        if (!target || target.deleted)
            return;
        const key = this.#key(target.path);
        let set = this.#byTarget.get(key);
        if (!set)
            this.#byTarget.set(key, (set = new Set()));
        set.add(rec.id);
        this.#targetKey.set(rec.id, key);
    }
    #setDisk(rec, disk) {
        this.#diskGen += 1;
        if (this.#lru.has(rec.id))
            this.#lruDirty = true;
        if (rec.disk)
            this.#unindexDisk(rec.id, rec.disk.path);
        rec.disk = disk;
        if (disk)
            this.#indexDisk(rec.id, disk.path);
        // 這個路徑上的檔案現在是同步中的了：不再是「被擋下的本機新增」（SDK ADR 0058；v0.49 修正：之前會一直列在 `blockedLocal()`）
        if (disk && this.#blockedLocal.size > 0)
            this.#blockedLocal.delete(disk.path);
        // 內容落地了（例如輕量成員 fetch 下來的、範圍外的版本加入時沒歸檔）：再看一次要不要歸檔（SDK ADR 0063）
        if (disk)
            this.#histNote(rec.id, disk.base);
        if (disk && rec.det)
            this.#setDet(rec, null);
        this.#markDirty(rec);
    }
    // ───────────────────────────── 排除（SDK ADR 0047） ─────────────────────────────
    // ───────────────────────────── 輕量成員（SDK ADR 0058） ─────────────────────────────
    /** 最新的版本頭（`computeHeads` 依 `(at, device, id)` 排序，最後一個最新） */
    #latestHead(rec) {
        const id = rec.heads[rec.heads.length - 1];
        return id !== undefined ? (rec.nodes[id] ?? null) : null;
    }
    /** 有沒有一個沒刪除的版本頭的路徑在內容範圍的**規則**裡（不含釘選與快取） */
    #inPatternScope(rec) {
        const scope = this.#scope;
        if (!scope)
            return true;
        return rec.heads.some((h) => {
            const node = rec.nodes[h];
            return node !== undefined && !node.deleted && scope.content(node.path);
        });
    }
    /** 這台要不要保存、寫入這個檔案的內容：完整成員一律要；輕量成員看規則、釘選、快取、正在 fetch */
    #wantsContent(rec) {
        if (!this.#scope)
            return true;
        if (this.#pins.has(rec.id) || this.#lru.has(rec.id) || this.#fetching.has(rec.id))
            return true;
        return this.#inPatternScope(rec);
    }
    /** 輕量成員、有沒刪除的版本頭、而且不在內容範圍：只有版本資訊（不合併、不寫入、不保存內容、不等內容） */
    #sparseOut(rec) {
        if (!this.#scope || rec.heads.length === 0 || this.#wantsContent(rec))
            return false;
        return rec.heads.some((h) => rec.nodes[h] !== undefined && !rec.nodes[h].deleted);
    }
    /** 內容在這台（磁碟上就是目前唯一的版本頭）：讀出來（雜湊相符才算） */
    async #fetchedContent(rec) {
        const head = rec.heads.length === 1 ? rec.nodes[rec.heads[0]] : undefined;
        if (!head || head.deleted || !rec.disk || rec.disk.base !== head.id || rec.disk.hash !== head.hash)
            return null;
        try {
            const bytes = await this.#adapter.read(rec.disk.path);
            return sha256Hex(bytes) === head.hash ? bytes : null;
        }
        catch {
            return null;
        }
    }
    #unfetch(id) {
        const n = (this.#fetching.get(id) ?? 1) - 1;
        if (n > 0)
            this.#fetching.set(id, n);
        else
            this.#fetching.delete(id);
        this.#lruDirty = true;
    }
    /** 每次工作結束時看等著 `fetch` 的人：內容到了就交出去 */
    async #checkFetches() {
        for (const waiter of [...this.#fetchWaiters]) {
            const rec = this.#files.get(waiter.fileId);
            const head = rec ? this.#latestHead(rec) : null;
            let outcome = null;
            if (!rec || !head)
                outcome = new VaultScopeError('unknown', waiter.path);
            else if (head.deleted && rec.heads.length === 1)
                outcome = new VaultScopeError('deleted', head.path);
            else
                outcome = await this.#fetchedContent(rec);
            if (!outcome || !this.#fetchWaiters.delete(waiter))
                continue;
            if (waiter.timer !== undefined)
                this.#clock.clearTimeout(waiter.timer);
            this.#unfetch(waiter.fileId);
            if (outcome instanceof VaultScopeError)
                waiter.reject(outcome);
            else
                waiter.resolve(outcome);
        }
    }
    #touchLru(id) {
        this.#lru.set(id, this.#clock.now());
        this.#lruDirty = true;
        this.#saveSparseMeta();
    }
    #saveSparseMeta() {
        this.#diskGen += 1;
        if (this.#pins.size > 0)
            this.#meta.pin = [...this.#pins].sort();
        else
            delete this.#meta.pin;
        if (this.#lru.size > 0)
            this.#meta.lru = Object.fromEntries(this.#lru);
        else
            delete this.#meta.lru;
        this.#metaDirty = true;
    }
    /** 依路徑找檔案：先找目前就在這個路徑上（沒刪除）的，再找最新版本頭在這個路徑上的（含刪除、還沒合併的） */
    #lookupRecord(path) {
        const key = this.#key(path);
        const ids = [...(this.#byTarget.get(key) ?? [])];
        let rec = ids.length > 0 ? (ids.map((id) => this.#files.get(id)).find((r) => r?.disk?.path === path) ?? this.#files.get(ids[0])) : undefined;
        if (!rec) {
            let best;
            for (const r of this.#files.values()) {
                const head = this.#latestHead(r);
                if (!head || this.#key(head.path) !== key)
                    continue;
                // 沒刪除的優先，再取較新的
                if (!best || (best.head.deleted && !head.deleted) || (best.head.deleted === head.deleted && compareVersions(head, best.head) > 0))
                    best = { rec: r, head };
            }
            rec = best?.rec;
        }
        return { rec, entry: rec ? this.#remoteEntry(rec) : null };
    }
    #remoteEntry(rec) {
        const head = this.#latestHead(rec);
        if (!head)
            return null;
        return {
            fileId: rec.id,
            versionId: head.id,
            path: head.path,
            size: head.size,
            hash: head.hash,
            deleted: head.deleted,
            modifiedAt: head.at,
            local: !head.deleted && rec.disk !== null && rec.disk.hash === head.hash,
            inScope: this.#wantsContent(rec),
            pinned: this.#pins.has(rec.id),
            cached: this.#lru.has(rec.id),
            conflicted: rec.heads.length > 1,
        };
    }
    /** 停止追蹤的本機副本剛好在這個路徑上 */
    #detAt(path) {
        return this.#detsAt(path).find((rec) => rec.det.path === path);
    }
    /** 這個比對 key 上的停止追蹤副本（路徑完全相同的在前） */
    #detsAt(path) {
        const ids = this.#byDet.get(this.#key(path));
        if (!ids)
            return [];
        const out = [];
        for (const id of ids) {
            const rec = this.#files.get(id);
            if (rec?.det)
                out.push(rec);
        }
        return out.sort((a, b) => Number(b.det.path === path) - Number(a.det.path === path));
    }
    /**
     * 這個路徑上的停止追蹤副本：路徑完全相同的那一筆；沒有的話，只差大小寫的只有一筆才算（大小寫不分的檔案系統上就是同一個檔案）。
     * 有好幾筆只差大小寫的、又沒有完全相同的：不猜。
     */
    #detFor(path) {
        const recs = this.#detsAt(path);
        if (recs[0]?.det.path === path)
            return recs[0];
        return recs.length === 1 ? recs[0] : undefined;
    }
    #detIndexAdd(path, id) {
        const key = this.#key(path);
        let ids = this.#byDet.get(key);
        if (!ids)
            this.#byDet.set(key, (ids = new Set()));
        ids.add(id);
    }
    #detIndexRemove(path, id) {
        const key = this.#key(path);
        const ids = this.#byDet.get(key);
        ids?.delete(id);
        if (ids?.size === 0)
            this.#byDet.delete(key);
    }
    /** 清掉停止追蹤的本機副本（不產生版本）：改過就不清 */
    async #evictDetached(rec) {
        const det = rec.det;
        const st = await this.#adapter.stat(det.path);
        if (st && !(await this.#apply({ type: 'remove', path: det.path, expect: sameHash(det.hash), fileId: rec.id, evict: 'evict' }))) {
            return { evicted: false, reason: 'modified' };
        }
        // 本機副本已經不在（應用自己先刪了）也一樣：記成「清掉」，重新納入時重新抓，不當成使用者刪除
        this.#setDet(rec, null);
        if (st)
            this.#emit('evicted', { fileId: rec.id, path: det.path, reason: 'evict' });
        return { evicted: true };
    }
    /** `status().scope`：本機有內容的、快取的、這台所知的 */
    #scopeUsage() {
        // 每次狀態通知都會問：只在磁碟、快取、釘選有變時重算（O(n)）
        if (this.#usage && this.#usageGen === this.#diskGen)
            return { ...this.#usage, local: { ...this.#usage.local }, cached: { ...this.#usage.cached } };
        const local = { files: 0, bytes: 0 };
        const cached = { files: 0, bytes: 0 };
        let known = 0;
        for (const rec of this.#files.values()) {
            const head = this.#latestHead(rec);
            if (head && !head.deleted)
                known += 1;
            if (!rec.disk)
                continue;
            local.files += 1;
            local.bytes += rec.disk.size;
            if (this.#lru.has(rec.id) && !this.#pins.has(rec.id) && !this.#inPatternScope(rec)) {
                cached.files += 1;
                cached.bytes += rec.disk.size;
            }
        }
        this.#usage = { local, cached, limit: this.#scope?.cacheBytes ?? 0, known };
        this.#usageGen = this.#diskGen;
        return { local: { ...local }, cached: { ...cached }, limit: this.#usage.limit, known };
    }
    /** 這個檔案有等著直連送出的大檔內容（內容只在磁碟上，清掉就送不出去） */
    #hasPushOf(fileId) {
        for (const push of this.#pushes.values())
            if (push.fileId === fileId)
                return true;
        return false;
    }
    /**
     * 清掉本機的一份內容（**不是刪除**：不產生版本）。有還沒送出的本機版本、或等著直連送出的大檔時先留著（送出後再清）。
     * 磁碟上的內容不是索引記的那一份（使用者剛改了還沒通知）：先收成本機版本（`changed`）。
     */
    async #evictLocal(rec, reason) {
        const disk = rec.disk;
        if (!disk)
            return 'ok';
        if (Object.keys(rec.unsent).length > 0 || this.#hasPushOf(rec.id) || this.#hasQueued(rec.id))
            return 'kept';
        // 內容是這台寫的、還沒有任何完整成員確認收到（它的摘要、直連確認、或以它為父版本的新版本）：先留著，
        // 不然對方若還沒收到（離線超過中繼保存期、或收到前重開），這份內容就沒有任何地方有了
        const head = this.#target(rec);
        if (head && head.device === this.#deviceId && !this.#confirmedByFullPeer(rec, head.id))
            return 'kept';
        // 告訴應用這是清掉、不是刪除（SDK ADR 0060）：它可以不備份、不移到垃圾桶
        if (!(await this.#apply({ type: 'remove', path: disk.path, expect: sameHash(disk.hash), fileId: rec.id, evict: reason }))) {
            await this.#reingest(rec, disk.path);
            return 'changed';
        }
        this.#setDisk(rec, null);
        if (this.#lru.delete(rec.id))
            this.#saveSparseMeta();
        // 保存的內容也清掉（範圍外不保存；SDK ADR 0058）
        this.#gcFile(rec);
        this.#emit('evicted', { fileId: rec.id, path: disk.path, reason });
        return 'ok';
    }
    /** 有沒有任何完整成員（不是宣告為輕量的）已知有這個版本（或它的後代） */
    #confirmedByFullPeer(rec, id) {
        for (const [device, heads] of Object.entries(rec.peers)) {
            if (device === this.#deviceId || this.#peerScopes.has(device))
                continue;
            if (this.#peerHas(rec, heads, id))
                return true;
        }
        return false;
    }
    /** 範圍改變（`setScope`、啟動）：該清的清、該抓的排進來 */
    #queueScope() {
        for (const rec of this.#files.values()) {
            if (rec.disk ? this.#sparseOut(rec) : !rec.det && rec.heads.some((h) => rec.nodes[h] && !rec.nodes[h].deleted && !this.#skip(rec.nodes[h].path)) && !this.#sparseOut(rec)) {
                this.#toMaterialize.add(rec.id);
            }
        }
        this.#lruDirty = true;
    }
    /** 快取超過上限：清掉最久沒用的（最近用的那一個、正在 fetch 的、釘選的、在規則範圍內的不清） */
    #enforceLru() {
        if (!this.#scope || !this.#lruDirty)
            return;
        this.#lruDirty = false;
        const entries = [];
        let total = 0;
        for (const [id, at] of this.#lru) {
            const rec = this.#files.get(id);
            if (!rec) {
                this.#lru.delete(id);
                continue;
            }
            if (!rec.disk || this.#pins.has(id) || this.#inPatternScope(rec))
                continue;
            entries.push({ id, at, size: rec.disk.size });
            total += rec.disk.size;
        }
        if (total <= this.#scope.cacheBytes)
            return;
        entries.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
        for (const e of entries.slice(0, -1)) {
            if (total <= this.#scope.cacheBytes)
                break;
            if (this.#fetching.has(e.id))
                continue;
            this.#lru.delete(e.id);
            this.#evictReason.set(e.id, 'lru');
            this.#toMaterialize.add(e.id);
            total -= e.size;
        }
        this.#saveSparseMeta();
    }
    /**
     * 本機新增的檔案被擋下（輕量成員）：在內容不在這台的檔案路徑上（沒有基準內容，要先 fetch）、或不在允許新增的範圍。
     * 回 null＝可以收進來。
     */
    #sparseBlock(path) {
        if (!this.#scope)
            return null;
        for (const id of this.#byTarget.get(this.#key(path)) ?? []) {
            const rec = this.#files.get(id);
            if (rec && !rec.disk && this.#sparseOut(rec))
                return 'base-missing';
        }
        if (this.#scope.create && !this.#scope.create(path))
            return 'create-outside';
        return null;
    }
    /** 記下被擋下的本機新增；同一個檔案沒變就不再回報 */
    #noteBlocked(st, code) {
        const prev = this.#blockedLocal.get(st.path);
        const error = new VaultScopeError(code, st.path);
        this.#blockedNow?.set(st.path, error);
        if (prev && prev.code === code && prev.size === st.size && prev.mtime === st.mtime)
            return;
        this.#blockedLocal.set(st.path, { code, size: st.size, mtime: st.mtime });
        this.#emit('error', { context: `sparse-${code}`, error });
    }
    /** 送給那台裝置時，這個版本只帶版本資訊：它宣告為輕量成員、版本在它的範圍外、而且它沒有明確要內容 */
    #metaOnlyFor(device, node, entry) {
        const scope = this.#peerScopes.get(device);
        if (scope === undefined)
            return false;
        if (node.deleted || node.p2p)
            return true; // 本來就不帶內容
        return !scope(node.path) && !(entry?.full?.includes(device) ?? false);
    }
    /** 被 `excludes` 排除（不含 `ignore`） */
    #excluded(path) {
        return this.#excl !== null && this.#excl.isExcluded(path);
    }
    /** 不同步：`ignore`（含暫存名稱）或 `excludes` */
    #skip(path) {
        return this.#ignore(path) || this.#excluded(path);
    }
    #setDet(rec, det) {
        if (rec.det)
            this.#detIndexRemove(rec.det.path, rec.id);
        if (det) {
            rec.det = det;
            this.#detIndexAdd(det.path, rec.id);
        }
        else
            delete rec.det;
        this.#markDirty(rec);
    }
    /** 這個路徑上的本機檔案要變成別的檔案了（新檔、或被其他檔案收進來）：不再當作停止追蹤的副本（只差大小寫的另一個檔案不動） */
    #clearDetAt(path) {
        if (this.#byDet.size === 0)
            return;
        const rec = this.#detFor(path);
        if (rec)
            this.#setDet(rec, null);
    }
    /**
     * 停止追蹤（**不是**刪除）：不產生任何版本，本機檔案原地保留；記下當時的狀態，重新納入時以它為父版本。
     * 這個檔案在這台還沒到的內容不再等。
     */
    #detach(rec) {
        const disk = rec.disk;
        if (!disk)
            return;
        this.#setDisk(rec, null);
        this.#setDet(rec, { ...disk, why: this.#excluded(disk.path) ? 'x' : 'm' });
        this.#dropPendingOf(rec);
    }
    /** 追蹤中、但路徑被排除的檔案一律停止追蹤 */
    #detachExcluded() {
        if (this.#excl === null)
            return;
        for (const rec of this.#files.values())
            if (rec.disk && this.#excluded(rec.disk.path))
                this.#detach(rec);
    }
    /** 本機沒有追蹤、所有版本頭都在本機排除的範圍：這台不合併、不寫入、不等內容（留給納入它的裝置） */
    #excludedRecord(rec) {
        if (this.#excl === null || rec.disk || rec.heads.length === 0)
            return false;
        return rec.heads.every((h) => {
            const node = rec.nodes[h];
            return node !== undefined && this.#excluded(node.path);
        });
    }
    /** 記下「用過排除」：之後沒有規則的啟動也會補寫當時略過的檔案 */
    #noteExcl() {
        const ex = this.#excl !== null;
        if ((this.#meta.ex === true) === ex)
            return;
        if (ex)
            this.#meta.ex = true;
        else
            delete this.#meta.ex;
        this.#metaDirty = true;
    }
    #dropPendingOf(rec) {
        for (const [id, p] of this.#pending)
            if (p.fileId === rec.id)
                this.#pending.delete(id);
    }
    #dropExcludedPending() {
        for (const [id, p] of this.#pending) {
            const rec = this.#files.get(p.fileId);
            if (rec && this.#excludedRecord(rec))
                this.#pending.delete(id);
        }
    }
    /**
     * 排出要重新套用的檔案：本機沒有追蹤、有一個沒刪除的版本頭現在在同步範圍內，而且之前被排除（`before`）
     * 或有停止追蹤的本機副本。`'all'`（啟動時，不知道上次的規則）＝不看之前。回傳有沒有排任何檔案。
     */
    #queueIncluded(before) {
        let any = false;
        for (const rec of this.#files.values()) {
            if (rec.disk)
                continue;
            const live = rec.heads.map((h) => rec.nodes[h]).filter((n) => n !== undefined && !n.deleted);
            if (!live.some((n) => !this.#skip(n.path)))
                continue;
            if (before !== 'all' && !rec.det && !live.some((n) => before !== null && before.isExcluded(n.path)))
                continue;
            this.#toMaterialize.add(rec.id);
            any = true;
        }
        return any;
    }
    /**
     * 沒有追蹤的本機檔案剛好是停止追蹤的那一份（SDK ADR 0047）：
     * - 有一個沒刪除的版本頭在同步範圍內 → **重新納入**：以停止追蹤時的版本為父版本，本機期間的修改成為一個本機版本，
     *   與別台的修改照常合併（內容一樣就什麼都不做）。回傳那個檔案。
     * - 檔案還在、但整個在本機排除的範圍（例如被別台搬了進去），本機副本沒改過 → 留著不動，回 `'stranded'`（不刪、也不當新檔送回去）。
     * - 其他（版本都刪了、或本機改過了）→ 不再當作那個檔案，回 null（呼叫端當作新檔：內容不會因此消失，排除全部移除後一定收斂）。
     */
    async #adopt(st, read) {
        if (this.#byDet.size === 0)
            return null;
        const rec = this.#detFor(st.path);
        if (!rec?.det || rec.disk || this.#diskOccupant(st.path, rec.id) !== undefined)
            return null;
        const det = rec.det;
        const live = rec.heads.map((h) => rec.nodes[h]).filter((n) => n !== undefined && !n.deleted);
        // 只在檔案還活著、而且整個在本機排除的範圍時留著不動；檔案被刪了就是一個普通的本機檔案（當作新檔）
        const strandable = live.length > 0;
        if (!live.some((n) => !this.#skip(n.path))) {
            // 大小與時間都沒變：不必讀內容
            if (strandable && st.size === det.size && st.mtime === det.mtime) {
                if (det.why !== 'm')
                    this.#setDet(rec, { ...det, why: 'm' });
                return 'stranded';
            }
            const local = await read();
            if (strandable && local.hash === det.hash) {
                if (det.why !== 'm' || det.path !== st.path)
                    this.#setDet(rec, { ...det, path: st.path, size: st.size, mtime: st.mtime, why: 'm' });
                return 'stranded';
            }
            this.#setDet(rec, null);
            return null;
        }
        const local = await read();
        this.#setDisk(rec, { path: st.path, hash: det.hash, size: det.size, mtime: det.mtime, base: det.base });
        // 停止追蹤之後被這台搬了地方（搬進排除範圍，SDK ADR 0071）：內容沒變也要送一個改名版本，否則會被改回原路徑
        if (local.hash === det.hash && (det.why !== 'v' || rec.nodes[det.base]?.path === st.path))
            this.#setDisk(rec, { ...rec.disk, size: st.size, mtime: st.mtime });
        else
            await this.#localVersion(rec, { path: st.path, deleted: false, bytes: local.bytes, hash: local.hash, stat: st });
        return rec;
    }
    #indexDisk(id, path) {
        this.#byDisk.set(path, id);
        const key = this.#key(path);
        let set = this.#diskKeys.get(key);
        if (!set)
            this.#diskKeys.set(key, (set = new Set()));
        set.add(id);
    }
    #unindexDisk(id, path) {
        if (this.#byDisk.get(path) === id)
            this.#byDisk.delete(path);
        const key = this.#key(path);
        const set = this.#diskKeys.get(key);
        set?.delete(id);
        if (set?.size === 0)
            this.#diskKeys.delete(key);
    }
    /** 磁碟上用同一個路徑鍵、但不是 `except` 的檔案 */
    #diskOccupant(path, except) {
        for (const id of this.#diskKeys.get(this.#key(path)) ?? [])
            if (id !== except)
                return id;
        return undefined;
    }
    /** 排進送出佇列；`forDevice`＝只有這台需要（補送）。已經排著就合併收件對象。 */
    #enqueueSend(fileId, nodeId, forDevice, content = false) {
        const existing = this.#outboxByNode.get(nodeId);
        if (existing !== undefined) {
            const entry = this.#outbox.get(existing);
            if (!entry)
                return;
            let changed = false;
            if (content && forDevice !== undefined && !entry.full?.includes(forDevice)) {
                entry.full = [...(entry.full ?? []), forDevice];
                changed = true;
            }
            if (forDevice === undefined && entry.to) {
                delete entry.to;
                changed = true;
            }
            else if (forDevice !== undefined && entry.to && !entry.to.includes(forDevice)) {
                entry.to.push(forDevice);
                changed = true;
            }
            // 還欠著幾台（SDK ADR 0068 §3）：又要廣播＝每台都要；又有一台要＝加進欠的
            if (entry.owed && forDevice === undefined) {
                delete entry.owed;
                changed = true;
            }
            else if (entry.owed && forDevice !== undefined && !entry.owed.includes(forDevice)) {
                entry.owed.push(forDevice);
                changed = true;
            }
            if (forDevice !== undefined && entry.got?.includes(forDevice)) {
                // 對方又說沒有（例如重開後遺失）：再送一次
                entry.got = entry.got.filter((d) => d !== forDevice);
                changed = true;
            }
            // 送出中被改了收件對象（傳輸層照收件人送：新加的那台這一次收不到）：送完後留著再送一次（SDK ADR 0058）
            if (changed && this.#inflight.has(existing))
                entry.again = true;
            if (changed)
                this.#saveOutbox(entry);
            return;
        }
        this.#meta.seq += 1;
        this.#metaDirty = true;
        if (forDevice === undefined) {
            // 有新的版本要廣播：'on-change' 的下一次連線要送摘要（SDK ADR 0045）
            this.#meta.digestDirty = true;
            this.#changeGen += 1;
        }
        const entry = { seq: this.#meta.seq, fileId, nodeId };
        if (forDevice !== undefined)
            entry.to = [forDevice];
        if (content && forDevice !== undefined)
            entry.full = [forDevice];
        this.#outbox.set(entry.seq, entry);
        this.#outboxByNode.set(nodeId, entry.seq);
        this.#saveOutbox(entry);
    }
    #saveOutbox(entry) {
        this.#bg(this.#store.set(`q:${String(entry.seq).padStart(12, '0')}`, encodeJson(entry)));
    }
    #dropOutbox(seq) {
        const entry = this.#outbox.get(seq);
        if (!entry)
            return;
        this.#outbox.delete(seq);
        if (this.#outboxByNode.get(entry.nodeId) === seq)
            this.#outboxByNode.delete(entry.nodeId);
        this.#bg(this.#store.delete(`q:${String(seq).padStart(12, '0')}`));
        if (this.#outbox.size === 0)
            this.#clearSendTrouble();
    }
    /**
     * 佇列清空了（例如全部經直連送完；SDK ADR 0053 §G13）：沒有東西卡在中繼上，`blocked`／送出失敗的狀態不再成立。
     * 下一則要經中繼送的版本照常驗證——中繼還是不收就再標記一次、再回報一次。
     */
    #clearSendTrouble() {
        if (this.#blocked === undefined && !this.#sendFailing)
            return;
        this.#blocked = undefined;
        this.#sendFailing = false;
        this.#retryDelay = 0;
    }
    // ───────────────────────────── 本機變更 ─────────────────────────────
    async #scanAll() {
        this.#detachExcluded();
        const listed = (await this.#adapter.list()).filter((s) => isSafeVaultPath(s.path) && !this.#skip(s.path));
        if (this.#byDet.size > 0) {
            // 留在原路徑的副本被使用者刪了或搬走了：不必再記著（SDK ADR 0047）
            const present = new Set(listed.map((s) => s.path));
            for (const rec of this.#files.values()) {
                if (rec.det?.why === 'm' && !present.has(rec.det.path) && !this.#skip(rec.det.path))
                    this.#setDet(rec, null);
            }
        }
        const seen = new Set();
        const untracked = [];
        for (const st of listed) {
            const id = this.#byDisk.get(st.path);
            const rec = id ? this.#files.get(id) : undefined;
            if (!rec?.disk) {
                untracked.push(st);
                continue;
            }
            seen.add(rec.id);
            if (rec.disk.path === st.path && rec.disk.size === st.size && rec.disk.mtime === st.mtime)
                continue;
            await this.#ingestExisting(rec, st);
            this.#toMaterialize.add(rec.id);
        }
        // 不見的檔案：先拿來比對新出現的檔案（同內容＝改名），剩下的才是刪除
        const missingByHash = new Map();
        for (const rec of this.#files.values()) {
            if (!rec.disk || seen.has(rec.id) || this.#skip(rec.disk.path))
                continue;
            const list = missingByHash.get(rec.disk.hash) ?? [];
            list.push(rec);
            missingByHash.set(rec.disk.hash, list);
        }
        for (const st of untracked) {
            let local;
            const read = async () => (local ??= await this.#readLocal(st.path, st.size));
            try {
                // 停止追蹤的那一份：重新納入或留著不動（SDK ADR 0047）
                const adopted = await this.#adopt(st, read);
                if (adopted === 'stranded')
                    continue;
                if (adopted) {
                    this.#toMaterialize.add(adopted.id);
                    continue;
                }
                await read();
            }
            catch {
                continue;
            }
            const { bytes, hash } = local;
            const moved = missingByHash.get(hash)?.shift();
            if (!moved && this.#scope) {
                // 輕量成員：沒有基準內容、或不在允許新增的範圍的新檔不收（SDK ADR 0058）
                const blocked = this.#sparseBlock(st.path);
                if (blocked) {
                    this.#noteBlocked(st, blocked);
                    continue;
                }
                this.#blockedLocal.delete(st.path);
            }
            const rec = moved ?? (await this.#localCreate(st.path, bytes, hash, st));
            if (moved)
                await this.#localVersion(moved, { path: st.path, deleted: false, bytes, hash, stat: st });
            this.#toMaterialize.add(rec.id);
        }
        for (const list of missingByHash.values()) {
            for (const rec of list) {
                if (rec.disk && !(await this.#adapter.stat(rec.disk.path))) {
                    await this.#localVersion(rec, { path: rec.disk.path, deleted: true });
                    this.#toMaterialize.add(rec.id);
                }
            }
        }
    }
    async #ingestPath(path) {
        if (!isSafeVaultPath(path) || this.#skip(path))
            return;
        const st = await this.#adapter.stat(path);
        const id = this.#byDisk.get(path);
        const rec = id ? this.#files.get(id) : undefined;
        if (!st) {
            this.#blockedLocal.delete(path);
            if (rec?.disk) {
                await this.#localVersion(rec, { path: rec.disk.path, deleted: true });
                await this.#converge(rec);
            }
            else if (this.#byDet.size > 0) {
                // 留在原路徑的副本被使用者刪了：不必再記著，也不是刪除（它本來就不在同步中；SDK ADR 0047）
                const detRec = this.#detAt(path);
                if (detRec)
                    this.#setDet(detRec, null);
            }
            return;
        }
        if (rec?.disk) {
            await this.#ingestExisting(rec, st);
            await this.#converge(rec);
            return;
        }
        let local;
        try {
            local = await this.#readLocal(path, st.size);
        }
        catch {
            return;
        }
        // 停止追蹤的那一份：重新納入或留著不動（SDK ADR 0047）
        const adopted = await this.#adopt(st, async () => local);
        if (adopted === 'stranded')
            return;
        if (adopted) {
            await this.#converge(adopted);
            return;
        }
        const { bytes, hash } = local;
        // 只差大小寫、內容相同：大小寫不分的檔案系統上的改名（沒收到改名事件時）
        const sameKey = this.#diskOccupant(path, '');
        const renamed = sameKey ? this.#files.get(sameKey) : undefined;
        if (renamed?.disk && renamed.disk.hash === hash && renamed.disk.path !== path) {
            await this.#localVersion(renamed, { path: st.path, deleted: false, bytes, hash, stat: st });
            await this.#converge(renamed);
            return;
        }
        if (this.#scope) {
            // 輕量成員：沒有基準內容、或不在允許新增的範圍的新檔不收（SDK ADR 0058）
            const blocked = this.#sparseBlock(st.path);
            if (blocked) {
                this.#noteBlocked(st, blocked);
                return;
            }
            this.#blockedLocal.delete(st.path);
        }
        const created = await this.#localCreate(st.path, bytes, hash, st);
        await this.#converge(created);
    }
    async #ingestExisting(rec, st) {
        let local;
        try {
            local = await this.#readLocal(st.path, st.size);
        }
        catch {
            return;
        }
        const { bytes, hash } = local;
        if (hash === rec.disk.hash && st.path === rec.disk.path) {
            // 內容沒變（包括自己剛套用的遠端寫入）：只更新大小與時間
            this.#setDisk(rec, { ...rec.disk, size: st.size, mtime: st.mtime });
            return;
        }
        await this.#localVersion(rec, { path: st.path, deleted: false, bytes, hash, stat: st });
    }
    async #ingestRename(from, to) {
        if (await this.#moveDetached(from, to))
            return;
        const id = this.#byDisk.get(from);
        const rec = id ? this.#files.get(id) : undefined;
        if (rec?.disk && rec.disk.path === from && isSafeVaultPath(to) && !this.#ignore(to) && this.#excluded(to) && !this.#excluded(from)) {
            // 使用者把追蹤中的檔案搬進這台排除的範圍（SDK ADR 0071）：停止追蹤，**不是刪除**——其他裝置照常保留。
            // 記在新路徑（`why: 'v'`）；移除排除時以停止追蹤時的版本為父重新納入，等於一次改名＋修改，與別台照常合併
            if (await this.#adapter.stat(to)) {
                const disk = rec.disk;
                this.#setDisk(rec, null);
                this.#clearDetAt(to);
                this.#setDet(rec, { ...disk, path: to, why: 'v' });
                this.#dropPendingOf(rec);
                return;
            }
        }
        if (!rec?.disk || rec.disk.path !== from || !isSafeVaultPath(to) || this.#skip(to)) {
            // 不認得舊路徑（例如這是自己剛套用的改名）：各自重新比對即可
            await this.#ingestPath(from);
            await this.#ingestPath(to);
            return;
        }
        const st = await this.#adapter.stat(to);
        if (!st) {
            await this.#ingestPath(from);
            return;
        }
        const otherId = this.#byDisk.get(to);
        const other = otherId && otherId !== rec.id ? this.#files.get(otherId) : undefined;
        let local;
        try {
            local = await this.#readLocal(to, st.size);
        }
        catch {
            return;
        }
        const { bytes, hash } = local;
        if (other?.disk && other.disk.path === to && (other.disk.hash === hash || (await this.#stillOnDisk(rec)))) {
            // 新路徑上是索引裡記著的另一個檔案，而且它內容沒變、或舊路徑上的檔案根本還在：這是自己套用的改名的回音，
            // 舊路徑隨即被另一個檔案佔用（路徑相撞：輸的改名成副本、留下的寫進原路徑；互換名字）。
            // 不是使用者的改名——當成「改名蓋掉另一個檔案」會刪掉那個檔案、把它的內容記到這個檔案名下，兩台互相回音就來回震盪。
            // 各自重新比對即可（SDK ADR 0048）
            await this.#ingestPath(from);
            await this.#ingestPath(to);
            return;
        }
        if (other?.disk) {
            // 改名蓋掉了另一個檔案：那個檔案在本機被刪了
            await this.#localVersion(other, { path: other.disk.path, deleted: true });
            await this.#converge(other);
        }
        if (to === from && hash === rec.disk.hash) {
            this.#setDisk(rec, { ...rec.disk, size: st.size, mtime: st.mtime });
            return;
        }
        await this.#localVersion(rec, { path: to, deleted: false, bytes, hash, stat: st });
        await this.#converge(rec);
        if (from !== to && this.#key(from) !== this.#key(to))
            await this.#ingestPath(from);
    }
    /** 這個檔案在索引記著的路徑上、內容仍是索引裡的那一份（大小、修改時間相同，或重新算雜湊相同） */
    async #stillOnDisk(rec) {
        const disk = rec.disk;
        if (!disk)
            return false;
        const st = await this.#adapter.stat(disk.path);
        if (!st)
            return false;
        if (st.size === disk.size && st.mtime === disk.mtime)
            return true;
        try {
            return (await this.#readLocal(disk.path, st.size)).hash === disk.hash;
        }
        catch {
            return false;
        }
    }
    /**
     * 讀本機檔案算雜湊。超過檔案塊層（大檔，只走 P2P）而且轉接器有 `readRange` 時分段讀、不留內容（SDK ADR 0026）：
     * 記憶體只佔一段；要送出時再分段讀。
     */
    /**
     * 這台搬進排除範圍、停止追蹤的檔案（`why: 'v'`，SDK ADR 0071）又被搬走：
     * - 搬回同步範圍 → 重新納入：以停止追蹤時的版本為父，送出「改名到新路徑＋現在的內容」；
     * - 還在排除範圍 → 只更新記著的路徑。
     * 回 true＝處理掉了。
     */
    async #moveDetached(from, to) {
        if (this.#byDet.size === 0 || from === to || !isSafeVaultPath(to))
            return false;
        const rec = this.#detAt(from);
        const det = rec?.det;
        if (!rec || !det || det.why !== 'v' || rec.disk || det.path !== from || this.#ignore(to))
            return false;
        const st = await this.#adapter.stat(to);
        if (!st || this.#diskOccupant(to, rec.id) !== undefined)
            return false;
        if (this.#excluded(to)) {
            this.#clearDetAt(to);
            this.#setDet(rec, { ...det, path: to, size: st.size, mtime: st.mtime });
            return true;
        }
        let local;
        try {
            local = await this.#readLocal(to, st.size);
        }
        catch {
            return false;
        }
        this.#clearDetAt(to);
        this.#setDet(rec, null);
        this.#setDisk(rec, { path: to, hash: det.hash, size: det.size, mtime: det.mtime, base: det.base });
        await this.#localVersion(rec, { path: to, deleted: false, bytes: local.bytes, hash: local.hash, stat: st });
        await this.#converge(rec);
        return true;
    }
    async #readLocal(path, size) {
        if (size > this.#effectiveRelayMax() && this.#adapter.readRange) {
            const read = this.#adapter.readRange.bind(this.#adapter);
            const hasher = sha256.create();
            let total = 0;
            for (let offset = 0;; offset += RANGE_BYTES) {
                const piece = await read(path, offset, RANGE_BYTES);
                hasher.update(piece);
                total += piece.length;
                if (piece.length < RANGE_BYTES)
                    break;
            }
            // 版本的大小（stat）與雜湊（實際讀到的）必須一致，否則收方永遠校驗不過
            if (total !== size)
                throw new Error(`${path} 在讀取途中被改了`);
            return { hash: bytesToHex(hasher.digest()), size: total };
        }
        const bytes = await this.#adapter.read(path);
        return { bytes, hash: sha256Hex(bytes), size: bytes.length };
    }
    async #localCreate(path, bytes, hash, stat) {
        this.#clearDetAt(path);
        const rec = this.#newRecord(this.#randomId());
        await this.#localVersion(rec, { path, deleted: false, bytes, hash, stat });
        return rec;
    }
    /** 記下一個本機版本（父版本＝磁碟上的版本）。還沒送出的上一個本機版本會被合併掉。 */
    async #localVersion(rec, change) {
        const baseId = rec.disk?.base ?? null;
        const base = baseId ? rec.nodes[baseId] : undefined;
        let parents = baseId ? [baseId] : [...rec.heads];
        if (base && rec.unsent[base.id] === true && !this.#hasChildren(rec, base.id) && !this.#isInflight(base.id)) {
            // 離線累積：上一個本機版本還沒送出，直接取代它（別台從沒看過它）
            parents = [...base.parents];
            delete rec.nodes[base.id];
            delete rec.unsent[base.id];
            if (rec.cm)
                delete rec.cm[base.id];
            if (rec.mr)
                delete rec.mr[base.id];
            if (rec.cb)
                delete rec.cb[base.id];
            rec.heads = computeHeads(rec.nodes);
            const seq = this.#outboxByNode.get(base.id);
            if (seq !== undefined)
                this.#dropOutbox(seq);
        }
        const at = this.#stamp();
        const node = change.deleted
            ? {
                id: this.#versionId(),
                parents,
                path: change.path,
                pathAt: base && base.path === change.path ? base.pathAt : at,
                deleted: true,
                hash: '',
                size: 0,
                text: false,
                at,
                device: this.#deviceId,
                label: this.#label,
                p2p: false,
            }
            : {
                id: this.#versionId(),
                parents,
                path: change.path,
                pathAt: base && base.path === change.path ? base.pathAt : at,
                deleted: false,
                hash: change.hash,
                size: change.bytes?.length ?? change.stat.size,
                text: change.bytes ? this.#isText(change.path, change.bytes) : false,
                at,
                device: this.#deviceId,
                label: this.#label,
                p2p: classifyPayload(change.bytes?.length ?? change.stat.size, this.#effectiveRelayMax()) === 'p2p',
            };
        this.#addNode(rec, node);
        rec.unsent[node.id] = true;
        if (this.#lru.has(rec.id))
            this.#touchLru(rec.id);
        if (!change.deleted) {
            if (change.bytes)
                this.#taskCache.set(change.hash, change.bytes);
            if (!node.p2p && change.bytes)
                await this.#putBlob(rec, change.hash, change.bytes);
            this.#setDisk(rec, { path: change.path, hash: change.hash, size: change.stat.size, mtime: change.stat.mtime, base: node.id });
        }
        else {
            this.#setDisk(rec, null);
        }
        this.#enqueueSend(rec.id, node.id);
        this.#updateTarget(rec);
        // 大檔：內容等 P2P 直送給每一台裝置（SDK ADR 0026）
        // 輕量成員範圍外的不直送（SDK ADR 0058）
        if (node.p2p && !node.deleted)
            for (const device of this.#peerDevices())
                if (!this.#metaOnlyFor(device, node))
                    this.#addPush(device, rec.id, node.id);
    }
    #isInflight(nodeId) {
        const seq = this.#outboxByNode.get(nodeId);
        return seq !== undefined && this.#inflight.has(seq);
    }
    // ───────────────────────────── 合併與套用 ─────────────────────────────
    /** 合併（有多個版本頭時）並套用到磁碟，直到穩定。 */
    async #converge(rec) {
        for (let round = 0; round < MAX_CONVERGE_ROUNDS; round += 1) {
            if (!this.#files.has(rec.id))
                return;
            await this.#releaseWaiting(rec);
            if (this.#scope && this.#sparseOut(rec)) {
                // 輕量成員、範圍外：不合併（留給完整成員）、不寫入、不保存內容；本機那一份清掉（不產生版本；SDK ADR 0058）
                const evicted = await this.#evictLocal(rec, this.#evictReason.get(rec.id) ?? 'scope');
                if (evicted === 'changed')
                    continue;
                this.#evictReason.delete(rec.id);
                this.#dropPendingOf(rec);
                this.#gcFile(rec);
                return;
            }
            if (rec.heads.length > 1) {
                if (this.#excludedRecord(rec)) {
                    // 全部在本機排除的範圍：不合併（不必等內容），留給納入它的裝置；它的合併版本到了自然收斂（SDK ADR 0047）
                    this.#dropPendingOf(rec);
                    this.#gcFile(rec);
                    return;
                }
                const merged = await this.#merge(rec);
                if (!merged)
                    return;
            }
            let result;
            try {
                result = await this.#materialize(rec);
            }
            catch (error) {
                this.#failed.add(rec.id);
                this.#emit('error', { context: 'apply', error });
                return;
            }
            this.#failed.delete(rec.id);
            if (result !== 'changed') {
                // 剛算出的合併版本可能正是某個遠端版本在等的父版本
                if (await this.#releaseWaiting(rec))
                    continue;
                // 已經被新版本取代的「內容還沒到」不必再等
                for (const [id, p] of this.#pending)
                    if (p.fileId === rec.id && !rec.heads.includes(id))
                        this.#pending.delete(id);
                if (this.#excludedRecord(rec))
                    this.#dropPendingOf(rec);
                this.#gcFile(rec);
                return;
            }
        }
        // 一直穩定不下來（例如轉接器一直拒絕寫入）：等下一次背景維護再試，不在這裡空轉
        this.#emit('error', { context: 'converge', error: new Error(`檔案 ${rec.id} 一直在變動，稍後再試`) });
        this.#failed.add(rec.id);
    }
    async #drain() {
        this.#enforceLru();
        for (let guard = 0; this.#toMaterialize.size > 0 && guard < 10_000; guard += 1) {
            const [id] = this.#toMaterialize;
            this.#toMaterialize.delete(id);
            const rec = this.#files.get(id);
            if (rec)
                await this.#converge(rec);
        }
    }
    async #merge(rec) {
        const heads = [...rec.heads];
        const contents = new Map();
        for (const h of heads) {
            const node = rec.nodes[h];
            if (node.deleted || contents.has(node.hash))
                continue;
            const bytes = await this.#getContent(rec, node.hash);
            if (bytes)
                contents.set(node.hash, bytes);
        }
        for (const b of mergeInputs(rec.nodes, heads).bases) {
            const base = b ? rec.nodes[b] : undefined;
            if (!base || base.deleted || !base.text || contents.has(base.hash))
                continue;
            const bytes = await this.#getContent(rec, base.hash);
            if (bytes)
                contents.set(base.hash, bytes);
        }
        let plan;
        // callout 模式只看版本資料：所有版本頭都支援才打開（SDK ADR 0046），每台裝置一致
        const callouts = heads.every((h) => this.#calloutCapable(rec, h));
        // Markdown 合併規則同理：所有版本頭都支援才打開（SDK ADR 0059）
        const mergeRules = heads.every((h) => this.#rulesCapable(rec, h));
        // callout 後空一行同理（SDK ADR 0087）
        const calloutBreak = callouts && heads.every((h) => this.#breakCapable(rec, h));
        try {
            plan = planMerge(rec.nodes, heads, (hash) => contents.get(hash), { callouts, mergeRules, calloutBreak });
        }
        catch (error) {
            if (!(error instanceof MissingContentError))
                throw error;
            // 真的需要這一方的內容（要合併文字或存成副本）：等它到
            for (const h of heads)
                if (rec.nodes[h].hash === error.hash)
                    this.#markPending(rec, rec.nodes[h]);
            return false;
        }
        const node = plan.version;
        this.#addNode(rec, node);
        rec.unsent[node.id] = false;
        for (const h of heads)
            this.#pending.delete(h);
        if (plan.bytes) {
            this.#taskCache.set(node.hash, plan.bytes);
            if (!node.p2p)
                await this.#putBlob(rec, node.hash, plan.bytes);
        }
        this.#enqueueSend(rec.id, node.id);
        this.#updateTarget(rec);
        const copyPaths = [];
        for (let i = 0; i < plan.copies.length; i += 1) {
            const copy = plan.copies[i];
            // 同一方的內容在不同的合併裡只產生一份副本
            const copyId = deterministicId('copy', rec.id, copy.source, copy.hash);
            // 路徑只由版本內容決定（不看本機狀態），各裝置一致；真的撞名時交給路徑相撞處理
            const path = conflictCopyName(node.path, copy.label, copy.at);
            copyPaths.push(path);
            if (this.#files.has(copyId))
                continue;
            const crec = this.#newRecord(copyId);
            const cnode = {
                id: deterministicId('copy-v', copyId, path),
                parents: [],
                path,
                pathAt: copy.at,
                deleted: false,
                hash: copy.hash,
                size: copy.size,
                text: copy.text,
                at: copy.at,
                device: copy.device,
                label: copy.label,
                p2p: classifyPayload(copy.size, this.#effectiveRelayMax()) === 'p2p',
            };
            this.#addNode(crec, cnode);
            crec.unsent[cnode.id] = false;
            this.#taskCache.set(copy.hash, copy.bytes);
            if (!cnode.p2p)
                await this.#putBlob(crec, copy.hash, copy.bytes);
            this.#enqueueSend(copyId, cnode.id);
            this.#updateTarget(crec);
            this.#toMaterialize.add(copyId);
        }
        const now = this.#clock.now();
        for (const note of plan.notes) {
            const conflict = { kind: note.kind, fileId: rec.id, path: node.path, at: now };
            if (note.copyIndex !== undefined)
                conflict.copyPath = copyPaths[note.copyIndex];
            if (note.otherPath !== undefined)
                conflict.otherPath = note.otherPath;
            if (note.callouts !== undefined)
                conflict.callouts = [...note.callouts];
            this.#conflict(conflict);
        }
        return true;
    }
    /** 找一個沒有人用、也不在磁碟上的路徑（衝突副本、路徑相撞時用）。 */
    #freePath(path, forFile) {
        const taken = (p) => {
            const k = this.#key(p);
            const byTarget = this.#byTarget.get(k);
            return (byTarget !== undefined && [...byTarget].some((id) => id !== forFile)) || this.#diskOccupant(p, forFile) !== undefined;
        };
        if (!taken(path))
            return path;
        for (let n = 2;; n += 1) {
            const candidate = freePathCandidate(path, n);
            if (!taken(candidate))
                return candidate;
        }
    }
    #markPending(rec, node) {
        if (this.#pending.has(node.id))
            return;
        const pending = { fileId: rec.id, versionId: node.id, path: node.path, hash: node.hash, size: node.size, via: node.p2p ? 'p2p' : 'relay' };
        this.#pending.set(node.id, pending);
        this.#emit('pending', pending);
        // 只問知道這個版本的裝置（SDK ADR 0104）；一台都不知道才廣播
        const to = this.#knowers(rec, node.id);
        if (!node.p2p)
            this.#want([[rec.id, node.id]], true, false, to);
        // 輕量成員要的大檔：請完整成員直送（SDK ADR 0058）
        else if (this.#scope)
            this.#want([[rec.id, node.id]], true, false, to);
    }
    async #apply(change) {
        let result;
        if (this.#applyRemote)
            result = await this.#applyRemote(change);
        else if (change.type === 'write')
            result = await this.#adapter.write(change.path, change.bytes, change.expect);
        else if (change.type === 'remove') {
            // 真正的刪除照舊只帶兩個參數；清掉本機副本才帶第三個（SDK ADR 0060）
            result = change.evict
                ? await this.#adapter.remove(change.path, change.expect, { evict: change.evict })
                : await this.#adapter.remove(change.path, change.expect);
        }
        else
            result = await this.#adapter.rename(change.from, change.to, change.expect);
        return result !== false;
    }
    /** 前置條件不符：磁碟上有還沒收進來的本機變更。先收成本機版本，回 'changed' 讓外層重新合併。 */
    async #reingest(rec, path) {
        if (rec.disk) {
            const st = await this.#adapter.stat(rec.disk.path);
            if (!st)
                await this.#localVersion(rec, { path: rec.disk.path, deleted: true });
            else
                await this.#ingestExisting(rec, st);
        }
        if (path !== rec.disk?.path) {
            const occupantId = this.#diskOccupant(path, rec.id) ?? (this.#byDisk.get(path) === rec.id ? rec.id : undefined);
            if (!occupantId) {
                const st = await this.#adapter.stat(path);
                if (st && !this.#skip(path)) {
                    try {
                        const { bytes, hash } = await this.#readLocal(path, st.size);
                        const created = await this.#localCreate(st.path, bytes, hash, st);
                        this.#toMaterialize.add(created.id);
                    }
                    catch {
                        // 讀不到：下一輪再試
                    }
                }
            }
            else if (occupantId !== rec.id) {
                const occupant = this.#files.get(occupantId);
                if (occupant?.disk) {
                    const st = await this.#adapter.stat(occupant.disk.path);
                    if (!st)
                        await this.#localVersion(occupant, { path: occupant.disk.path, deleted: true });
                    else
                        await this.#ingestExisting(occupant, st);
                    this.#toMaterialize.add(occupant.id);
                }
            }
        }
        return 'changed';
    }
    /** 讓磁碟符合目前的版本。回傳 'changed' 表示發現本機變更或路徑相撞，要重新合併。 */
    async #materialize(rec, depth = 0) {
        const target = this.#target(rec);
        if (!target)
            return 'pending';
        // 這台搬進自己排除範圍的檔案（SDK ADR 0071）：還在排除範圍時，別台的修改不寫到原路徑（否則這台會多出一份）
        if (!rec.disk && rec.det?.why === 'v' && this.#skip(rec.det.path))
            return 'ok';
        if (!rec.disk && rec.det && !target.deleted && !this.#skip(target.path) && !this.#skip(rec.det.path)) {
            // 停止追蹤、留在同步範圍內的本機副本：版本回到同步範圍，恢復追蹤（接下來的改名／寫入以前置條件確認它沒被改過；SDK ADR 0047）
            const det = rec.det;
            const occupied = this.#diskOccupant(det.path, rec.id) !== undefined;
            const st = occupied ? null : await this.#adapter.stat(det.path);
            if (st && det.why === 'v') {
                // 這台搬進排除範圍的檔案重新納入（SDK ADR 0071）：以停止追蹤時的版本為父，送出「改名到這裡＋現在的內容」，
                // 與別台期間的修改照常合併（路徑取這台的改名、內容合併）
                let local;
                try {
                    local = await this.#readLocal(det.path, st.size);
                }
                catch {
                    return 'ok';
                }
                this.#setDisk(rec, { path: det.path, hash: det.hash, size: det.size, mtime: det.mtime, base: det.base });
                await this.#localVersion(rec, { path: det.path, deleted: false, bytes: local.bytes, hash: local.hash, stat: st });
                return 'changed';
            }
            if (st) {
                this.#setDisk(rec, { path: det.path, hash: det.hash, size: det.size, mtime: det.mtime, base: det.base });
            }
            else if (!occupied && det.why !== 'm') {
                // 排除期間使用者把它刪了：重新納入時當作一次本機刪除（父版本＝停止追蹤時的版本），與別台的修改照常合併
                // （別台改過就保留修改；與「排除期間的修改在重新納入時送出」對稱）
                this.#setDisk(rec, { path: det.path, hash: det.hash, size: det.size, mtime: det.mtime, base: det.base });
                await this.#localVersion(rec, { path: det.path, deleted: true });
                return 'changed';
            }
            else
                this.#setDet(rec, null);
        }
        if (target.deleted) {
            if (!rec.disk)
                return 'ok';
            if (this.#excluded(rec.disk.path)) {
                // 排除範圍內的本機檔案永遠不刪（SDK ADR 0047）
                this.#detach(rec);
                return 'ok';
            }
            const path = rec.disk.path;
            // 被收進同路徑另一個檔案的（同路徑新建的合併，SDK ADR 0059）：磁碟上那一份直接交給它，不先刪再寫
            if (this.#handOverFolded(rec))
                return 'ok';
            // 同內容收斂的刪除（G10）比留下的檔案先到、而留下的那份已經在等祖先（SDK ADR 0088）：先不刪，等它併進來直接交給它
            if (this.#awaitDedupeWinner(rec, target))
                return 'ok';
            // 收進去的那個檔案這台認得、但版本 A 還沒到（訊息亂序）：照同樣的輸入在這台做一次、交給它。
            // 這台還不認得它（或它還在合併中）：照常刪，它到了再寫（短暫消失；內容在版本 A 裡，不遺失）
            const winner = isFoldId(target.id) ? this.#foldWinner(rec, target) : undefined;
            if (winner && !winner.disk && (await this.#refold(winner, rec))) {
                this.#toMaterialize.add(winner.id);
                return 'ok';
            }
            if (!(await this.#apply({ type: 'remove', path, expect: sameHash(rec.disk.hash), fileId: rec.id })))
                return this.#reingest(rec, path);
            this.#setDisk(rec, null);
            this.#emit('applied', { type: 'remove', fileId: rec.id, path });
            return 'ok';
        }
        if (this.#excluded(target.path)) {
            // 版本在本機排除的範圍：不寫入。本機那一份（被排除，或別台把它搬進了排除範圍）停止追蹤、原地保留，不刪（SDK ADR 0047）
            if (rec.disk)
                this.#detach(rec);
            return 'ok';
        }
        if (this.#scope && this.#sparseOut(rec)) {
            // 輕量成員、範圍外：不寫入；本機那一份清掉（不產生版本；SDK ADR 0058）
            return (await this.#evictLocal(rec, this.#evictReason.get(rec.id) ?? 'scope')) === 'changed' ? 'changed' : 'ok';
        }
        if (rec.disk && rec.disk.base === target.id && rec.disk.path === target.path)
            return 'ok';
        if (this.#ignore(target.path))
            return 'ok';
        // 路徑相撞：兩個不同的檔案要用同一個路徑
        const collision = await this.#resolveCollision(rec, target);
        if (collision !== 'none')
            return collision;
        const needsBytes = !rec.disk || rec.disk.hash !== target.hash;
        let bytes;
        let stream;
        if (needsBytes) {
            // P2P 收到的大檔：轉接器能串流寫入就直接從暫存寫過去，不整檔進記憶體（SDK ADR 0026）
            const staged = this.#staged.get(target.hash);
            if (staged && this.#adapter.writeStream && !this.#taskCache.has(target.hash))
                stream = staged;
            else {
                bytes = await this.#getContent(rec, target.hash);
                if (!bytes) {
                    this.#markPending(rec, target);
                    return 'pending';
                }
            }
        }
        this.#pending.delete(target.id);
        const moving = !rec.disk || rec.disk.path !== target.path;
        // 只改大小寫的搬移：目的地的確切路徑上有另一個同步中的檔案（大小寫有分的檔案系統上兩個並存，例如同路徑新建的合併交接後；
        // SDK ADR 0059）時，也要先處理它
        const exact = this.#byDisk.get(target.path);
        if (moving && (!rec.disk || this.#key(rec.disk.path) !== this.#key(target.path) || (exact !== undefined && exact !== rec.id))) {
            const occupantId = this.#diskOccupant(target.path, rec.id);
            if (occupantId) {
                // 目的地被另一個同步中的檔案佔著（它正要搬走或刪掉）：先處理它；成環就先搬到暫存名
                const occupant = this.#files.get(occupantId);
                // 它是被收進這個檔案的（別台先做了同路徑新建的合併、這台先收到刪除版本；SDK ADR 0059）：照同樣的版本接手
                if (!rec.disk && (await this.#refold(rec, occupant)))
                    return 'changed';
                // 它是同內容收斂（G10）輸的那一份、在等這個檔案（SDK ADR 0088）：磁碟上那一份直接交給這個檔案，不先刪再寫
                if (!rec.disk && this.#claimDeduped(rec, occupant, target))
                    return 'changed';
                const hadDisk = rec.disk !== null;
                if (depth < 4)
                    await this.#materialize(occupant, depth + 1);
                // 佔著的那一份交給了這個檔案（同路徑新建的合併；SDK ADR 0059）：重新來過
                if (!hadDisk && rec.disk)
                    return 'changed';
                if (this.#diskOccupant(target.path, rec.id) === occupantId && occupant.disk) {
                    const swap = `${occupant.disk.path}.cinder-swap-${occupant.id.slice(0, 8)}`;
                    if (!(await this.#apply({ type: 'rename', from: occupant.disk.path, to: swap, expect: sameHash(occupant.disk.hash), fileId: occupant.id }))) {
                        return this.#reingest(occupant, occupant.disk.path);
                    }
                    this.#setDisk(occupant, { ...occupant.disk, path: swap });
                    this.#toMaterialize.add(occupant.id);
                }
            }
            else if (!occupantId && (await this.#adapter.stat(target.path))) {
                // 目的地有一個還沒收進來的本機檔案：先收進來（接著會走路徑相撞）
                return this.#reingest(rec, target.path);
            }
        }
        if (rec.disk && moving) {
            const from = rec.disk.path;
            if (!(await this.#apply({ type: 'rename', from, to: target.path, expect: sameHash(rec.disk.hash), fileId: rec.id })))
                return this.#reingest(rec, target.path);
            this.#setDisk(rec, { ...rec.disk, path: target.path });
            this.#emit('applied', { type: 'rename', fileId: rec.id, from, to: target.path });
        }
        if (bytes || stream) {
            const created = !rec.disk;
            const ok = stream
                ? (await this.#adapter.writeStream(target.path, stream, rec.disk ? rec.disk.hash : null)) !== false
                : await this.#apply({ type: 'write', path: target.path, bytes: bytes, expect: rec.disk ? sameHash(rec.disk.hash) : absent, fileId: rec.id });
            if (!ok)
                return this.#reingest(rec, target.path);
            const st = await this.#adapter.stat(target.path);
            this.#setDisk(rec, { path: target.path, hash: target.hash, size: stream ? stream.size : bytes.length, mtime: st?.mtime ?? 0, base: target.id });
            const applied = { type: 'write', fileId: rec.id, path: target.path, created };
            this.#emit('applied', applied);
        }
        else {
            this.#setDisk(rec, { ...rec.disk, base: target.id });
        }
        return 'ok';
    }
    /**
     * 路徑相撞：先佔用這個路徑的（`pathAt` 較早，平手比 fileId）留下，其他的改名成衝突副本名稱。
     * 改名本身是一個版本（id 由內容決定，兩台各自處理也會得到同一個）。回傳 `rec` 自己是否被改名（或被收斂掉）。
     *
     * 內容相同（雜湊一樣）的不產生副本（SDK ADR 0035 §G10；新裝置帶著既有的檔案加入時最常見）：輸掉的那個檔案
     * 加一個刪除版本（id 由內容決定），磁碟上那一份直接交給留下的檔案，不動磁碟。內容一樣，所以什麼都沒丟。
     */
    async #resolveCollision(rec, target) {
        const key = this.#key(target.path);
        const others = [...(this.#byTarget.get(key) ?? [])].filter((id) => id !== rec.id);
        if (others.length === 0)
            return 'none';
        const contenders = [rec.id, ...others]
            .map((id) => ({ id, t: this.#target(this.#files.get(id)) }))
            .filter((c) => c.t !== null && !c.t.deleted && this.#key(c.t.path) === key)
            .sort((a, b) => a.t.pathAt - b.t.pathAt || (a.id < b.id ? -1 : 1));
        let movedSelf = false;
        let wait = false;
        // 空檔（0 位元組）不和有內容的檔案搶路徑：有內容的留下，空檔直接收掉、不產生副本（SDK ADR 0048；空檔沒有內容會遺失）
        const winner = contenders.find((c) => c.t.size > 0) ?? contenders[0];
        for (const loser of contenders) {
            if (loser === winner)
                continue;
            const lrec = this.#files.get(loser.id);
            if (winner && this.#dedupeCollision(winner, loser)) {
                if (lrec.id === rec.id)
                    movedSelf = true;
                continue;
            }
            const fold = winner ? await this.#foldCollision(winner, loser) : 'no';
            if (fold === 'folded') {
                // 收進留下的檔案：兩個檔案都變了（留下的多了一個版本頭要合併、輸的刪除），都要重新處理
                if (lrec.id === rec.id || winner.id === rec.id)
                    movedSelf = true;
                continue;
            }
            if (fold === 'wait') {
                // 要收進去、但輸的那一方的內容還沒到：兩邊都先等（不改名成副本，那會和別台不同），內容到了再收
                wait = true;
                continue;
            }
            const newPath = this.#freePath(conflictCopyName(loser.t.path, loser.t.label, loser.t.pathAt), loser.id);
            const sortedHeads = [...lrec.heads].sort();
            const node = {
                ...loser.t,
                id: deterministicId('collide', loser.id, ...sortedHeads, newPath),
                parents: sortedHeads,
                path: newPath,
                pathAt: loser.t.at,
            };
            this.#addNode(lrec, node);
            lrec.unsent[node.id] = false;
            this.#enqueueSend(lrec.id, node.id);
            this.#updateTarget(lrec);
            this.#conflict({ kind: 'path-collision', fileId: lrec.id, path: loser.t.path, copyPath: newPath, at: this.#clock.now() });
            if (lrec.id === rec.id)
                movedSelf = true;
            else
                this.#toMaterialize.add(lrec.id);
        }
        return movedSelf ? 'changed' : wait ? 'pending' : 'none';
    }
    /**
     * 相撞的兩個檔案內容相同：輸的那個收斂進留下的那個（SDK ADR 0035 §G10）。做得到回 true；不安全時回 false（照舊產生副本）。
     *
     * 只在磁碟狀態明確時做：輸的那個沒有落地，或它在磁碟上的正是這個路徑、內容就是這個雜湊，而留下的那個還沒落地
     * （磁碟那一份改記在留下的名下）。其他情況（例如輸的那個在磁碟上有還沒收進來的修改）照舊產生衝突副本——絕不刪掉可能不同的內容。
     *
     * 相容：舊版（≤ v0.29）的裝置對同一組相撞會產生「改名成副本」的版本；它與這裡的刪除版本是並行的，
     * 合併規則「一邊刪、另一邊只改名沒改內容 → 刪」讓兩種版本收斂到同一個結果（舊版那台會把副本刪掉）。
     */
    #dedupeCollision(winner, loser) {
        if (winner.t.deleted || loser.t.deleted)
            return false;
        // 輸的是空檔、留下的有內容：空檔收掉（SDK ADR 0048）。磁碟上那一份照常經由刪除版本移除（前置條件保護還沒收進來的修改）
        const emptyLoser = loser.t.size === 0 && winner.t.size > 0;
        if (winner.t.hash !== loser.t.hash && !emptyLoser)
            return false;
        const wrec = this.#files.get(winner.id);
        const lrec = this.#files.get(loser.id);
        if (!wrec || !lrec)
            return false;
        // 留下的那個版本只是沿用父版本的內容（改名、搬家）：那份內容可能已經在另一個分支被搬走（例如搬進衝突副本），
        // 合併之後留下的檔案會換成別的內容，輸的那一份就沒有任何地方有了。只看版本資料（每台判斷一樣）：照舊產生衝突副本，多一份、不丟資料。
        // 兩邊各自新建的同內容檔案（G10 原本的情境）、或真的改成這份內容的版本，照常收斂
        if (!emptyLoser && winner.t.parents.some((p) => wrec.nodes[p]?.hash === winner.t.hash))
            return false;
        const key = this.#key(loser.t.path);
        const handOver = !emptyLoser && lrec.disk !== null && lrec.disk !== undefined;
        if (handOver) {
            if (wrec.disk || this.#key(lrec.disk.path) !== key || lrec.disk.hash !== winner.t.hash)
                return false;
        }
        const sortedHeads = [...lrec.heads].sort();
        const node = {
            ...loser.t,
            id: deterministicId('dedupe', loser.id, ...sortedHeads),
            parents: sortedHeads,
            deleted: true,
            hash: '',
            size: 0,
            text: false,
            p2p: false,
        };
        if (handOver) {
            const disk = lrec.disk;
            this.#setDisk(lrec, null);
            this.#setDisk(wrec, { ...disk, base: winner.t.id });
            this.#toMaterialize.add(wrec.id);
        }
        // 輸的那份是別台寫的（例如新裝置帶著同一份檔案加入）：先把留下的那份連同祖先排給那台，再排刪除版本（SDK ADR 0088）——
        // 那台先收到留下的那份（在等祖先也好），刪除版本到的時候磁碟上那一份直接交給它，不先刪再寫
        const recipients = this.#recipients();
        if (loser.t.device !== this.#deviceId && (recipients === null || recipients.includes(loser.t.device))) {
            for (const id of ancestryOf(wrec.nodes, wrec.heads).reverse())
                this.#resend(wrec.id, id, loser.t.device);
        }
        this.#addNode(lrec, node);
        lrec.unsent[node.id] = false;
        this.#enqueueSend(lrec.id, node.id);
        this.#updateTarget(lrec);
        this.#toMaterialize.add(lrec.id);
        return true;
    }
    /**
     * 兩台各自新建同一個路徑的文字檔（裁示 5，SDK ADR 0059）：不把較晚的改名成衝突副本，而是把它**收進**留下的那個檔案，
     * 以空檔為共同祖先三方合併。只在兩個版本都支援 Markdown 合併規則（id 的標記）、都是文字檔時做；做了回 true。
     *
     * 做法（全部由版本資料決定 id，每台各自做也得到同樣的版本）：
     * - 留下的檔案多一個**沒有父版本**的版本 A（內容＝輸的那一方目前的內容；id 由輸的檔案、它的版本頭、留下的檔案與路徑決定），
     *   於是留下的檔案有兩個版本頭、沒有共同祖先 → 一般的合併（`planMerge` 的合併規則：以兩邊共同的行為祖先），
     *   合不了的地方照舊 callout／衝突副本；
     * - 輸的檔案加一個刪除版本（父版本＝它的版本頭）。它的內容已經在 A 裡，所以什麼都沒丟；它之後若在別台被改了，
     *   「一刪一改保留修改」讓它回來，再收一次（新的 A），一樣收斂。
     * - 磁碟上的那一份是輸的、而留下的還沒落地：直接交給留下的檔案（基準＝A），不先刪再寫（開著的筆記不會閃一下）。
     */
    async #foldCollision(winner, loser, loserHeads) {
        const w = winner.t;
        const l = loser.t;
        if (w.deleted || l.deleted || !w.text || !l.text || w.p2p || l.p2p)
            return 'no';
        const wrec = this.#files.get(winner.id);
        const lrec = this.#files.get(loser.id);
        if (!wrec || !lrec || !this.#rulesCapable(wrec, w.id) || !this.#rulesCapable(lrec, l.id))
            return 'no';
        const lheads = [...(loserHeads ?? lrec.heads)].sort();
        // A 也帶標記：它只會在兩邊都支援時出現；callout 的標記照輸的那一方
        const aid = foldAdoptId(loser.id, lheads, winner.id, w.path, this.#calloutCapable(lrec, l.id));
        const adopted = { ...l, id: aid, parents: [], path: w.path, pathAt: w.pathAt };
        const removed = {
            ...l,
            // 標成「被收進別的檔案的刪除」：別台先收到它時，磁碟上那一份交給留下的檔案（`#handOverFolded`）
            id: markFoldId(markMergeRulesId(deterministicId('fold-del', loser.id, ...lheads, winner.id))),
            parents: lheads,
            deleted: true,
            hash: '',
            size: 0,
            text: false,
            p2p: false,
        };
        if (!wrec.nodes[aid] && !wrec.pruned.includes(aid)) {
            const bytes = await this.#getContent(lrec, l.hash);
            if (!bytes) {
                // 版本 A 要帶著輸的那一方的內容送出去（別台可能都沒有它的內容了）：先要內容
                this.#markPending(lrec, l);
                return 'wait';
            }
            this.#taskCache.set(l.hash, bytes);
            await this.#putBlob(wrec, l.hash, bytes);
            this.#addNode(wrec, adopted);
            wrec.unsent[aid] = false;
            this.#enqueueSend(wrec.id, aid);
        }
        const disk = lrec.disk;
        if (wrec.nodes[aid] && disk && !wrec.disk && this.#key(disk.path) === this.#key(w.path) && disk.hash === l.hash && disk.base === l.id) {
            // 磁碟上那一份就是 A 的內容：交給留下的檔案，接著的合併以前置條件直接覆寫，不先刪再寫
            this.#setDisk(lrec, null);
            this.#setDisk(wrec, { ...disk, base: aid });
            if (this.#scope && !this.#wantsContent(wrec))
                this.#touchLru(wrec.id);
        }
        if (!lrec.nodes[removed.id] && !lrec.pruned.includes(removed.id)) {
            this.#addNode(lrec, removed);
            lrec.unsent[removed.id] = false;
            this.#enqueueSend(lrec.id, removed.id);
        }
        this.#updateTarget(wrec);
        this.#updateTarget(lrec);
        this.#toMaterialize.add(wrec.id);
        this.#toMaterialize.add(lrec.id);
        this.#pending.delete(l.id);
        return 'folded';
    }
    /** 被收進別的檔案的刪除版本 `del`：收進了哪個檔案（id 由它決定；這台認得才找得到） */
    #foldWinner(rec, del) {
        if (del.parents.length !== 1)
            return undefined;
        for (const other of this.#files.values()) {
            if (other.id === rec.id || other.heads.length === 0)
                continue;
            if (del.id === markFoldId(markMergeRulesId(deterministicId('fold-del', rec.id, del.parents[0], other.id))))
                return other;
        }
        return undefined;
    }
    /**
     * 別台已經把 `occupant` 收進 `rec`（它的版本頭是那次的刪除版本，id 由「收進哪個檔案」決定，對得上才算），這台還沒收到版本 A：
     * 用同樣的輸入在這台做一次（得到同樣的 A），磁碟上那一份交給 `rec`。做了回 true。
     */
    async #refold(rec, occupant) {
        const del = this.#target(occupant);
        const w = this.#target(rec);
        if (!del?.deleted || !isFoldId(del.id) || del.parents.length !== 1 || !w || w.deleted || !occupant.disk)
            return false;
        const l = occupant.nodes[del.parents[0]];
        if (!l || l.deleted || occupant.disk.base !== l.id)
            return false;
        if (del.id !== markFoldId(markMergeRulesId(deterministicId('fold-del', occupant.id, l.id, rec.id))))
            return false;
        if ((await this.#foldCollision({ id: rec.id, t: w }, { id: occupant.id, t: l }, del.parents)) !== 'folded')
            return false;
        return rec.disk !== null;
    }
    /**
     * 這個檔案被刪了，而同一個路徑上另一個還沒落地的檔案的版本圖裡，有一個版本的內容正是磁碟上這一份（同路徑新建的合併：
     * 別台先做了、送來刪除版本與收進去的版本 A；SDK ADR 0059）：把磁碟上這一份交給它（基準＝那個版本），接著它的寫入以前置條件
     * 直接覆寫，不先刪再寫。做了回 true。
     */
    /** `target` 是不是同內容收斂（G10，`#dedupeCollision`）替 `rec` 產生的刪除版本：id 由檔案與父版本決定 */
    #isDedupeDelete(rec, target) {
        return target.deleted && target.parents.length > 0 && target.id === deterministicId('dedupe', rec.id, ...[...target.parents].sort());
    }
    /**
     * 同內容收斂的刪除先到（SDK ADR 0088）：留下的那份（同路徑、同內容）已經收到、還在等祖先，就先不刪磁碟上這一份——
     * 它併進來時 `#claimDeduped` 直接接手。留下的那份這台還不認得：照舊刪（它到了再寫，SDK ADR 0048〈未處理〉）。
     */
    #awaitDedupeWinner(rec, target) {
        const disk = rec.disk;
        if (!disk || !this.#isDedupeDelete(rec, target))
            return false;
        const key = this.#key(disk.path);
        // 同路徑已經有別的檔案寫在磁碟上（例如留下的那份先到、這一份被搬到暫存名）：不必等，照常刪
        for (const other of this.#files.values()) {
            if (other.id !== rec.id && other.disk && this.#key(other.disk.path) === this.#key(target.path))
                return false;
        }
        // 只在留下的那份確實已經收到、在等祖先時才等（同路徑、同內容）——有根據才等，不靠計時
        for (const entry of this.#waiting.values()) {
            const n = entry.node;
            if (entry.fileId !== rec.id && !n.deleted && n.hash === disk.hash && this.#key(n.path) === key)
                return true;
        }
        return false;
    }
    /** 路徑被同內容收斂輸的那一份佔著、內容就是這個檔案要寫的（SDK ADR 0088）：磁碟上那一份交給這個檔案。做了回 true */
    #claimDeduped(rec, occupant, target) {
        const disk = occupant.disk;
        const otarget = this.#target(occupant);
        if (!disk || !otarget || !this.#isDedupeDelete(occupant, otarget) || disk.hash !== target.hash)
            return false;
        if (this.#key(disk.path) !== this.#key(target.path))
            return false;
        this.#setDisk(occupant, null);
        this.#setDisk(rec, { ...disk, base: target.id });
        this.#toMaterialize.add(rec.id);
        this.#toMaterialize.add(occupant.id);
        return true;
    }
    #handOverFolded(rec) {
        const disk = rec.disk;
        const target = this.#target(rec);
        if (!disk || !target?.deleted || !isFoldId(target.id))
            return false;
        const other = this.#foldWinner(rec, target);
        if (!other || other.disk)
            return false;
        // 版本 A 的 id 由「誰、哪些版本頭、收進誰、路徑」決定：對得上才是這一次收進去的（不是別的檔案剛好同內容的第一個版本）
        const lheads = target.parents;
        const adopted = Object.values(other.nodes).find((n) => n.parents.length === 0 &&
            !n.deleted &&
            n.hash === disk.hash &&
            (n.id === foldAdoptId(rec.id, lheads, other.id, n.path, false) || n.id === foldAdoptId(rec.id, lheads, other.id, n.path, true)));
        if (!adopted)
            return false;
        this.#setDisk(rec, null);
        this.#setDisk(other, { ...disk, base: adopted.id });
        this.#toMaterialize.add(other.id);
        return true;
    }
    // ───────────────────────────── 收 ─────────────────────────────
    /**
     * 收到一則同步訊息。回傳的 Promise 完成＝處理完而且狀態已經保存（SDK ADR 0067：傳輸層據此送收件確認）；
     * 沒保存好就 reject。不處理的（自己的、格式不對、沉睡暫停中先擱著的）回 undefined＝不表態。
     */
    #onMessage(raw) {
        if (this.#stopped || raw.from === this.#deviceId)
            return undefined;
        // 不信任傳輸層：路徑、id、內容雜湊在這裡再驗一次（自訂的傳輸層可能沒有經過 codec）
        const message = validateVaultMessage(raw);
        if (!message) {
            this.#emit('error', { context: 'invalid-message', error: new Error('收到格式不正確的同步訊息，已丟棄') });
            return undefined;
        }
        if (this.#paused) {
            this.#held.push(message);
            return undefined;
        }
        let failuresBefore = 0;
        const task = this.#run(async () => {
            failuresBefore = this.#persistFailures;
            this.#meta.lastSyncAt = this.#clock.now();
            this.#metaDirty = true;
            this.#noteSeen(message.from, this.#clock.now());
            if (message.type === 'node')
                await this.#receiveNode(message.from, message.fileId, message.node, message.content);
            else if (message.type === 'nodes')
                for (const [fileId, node] of message.items)
                    await this.#receiveNode(message.from, fileId, node);
            else if (message.type === 'bundle')
                for (const item of message.items)
                    await this.#receiveNode(message.from, item.fileId, item.node, item.content);
            else if (message.type === 'digest')
                this.#receiveDigest(message);
            else if (message.type === 'receipt')
                this.#receiveReceipt(message);
            else
                this.#receiveWant(message);
            await this.#drain();
            // 對方剛送來訊息＝它很可能此刻在線（SDK ADR 0090）：有要經直連給它的就馬上排，不等退避（摘要原本就這樣做）
            if (message.type !== 'digest')
                this.#pokeP2P(message.from);
            // 處理完、和結果一起保存：之後回簽收單給寄件人（SDK ADR 0068）；已處理到的最大序號放進之後的摘要（SDK ADR 0074）
            if (message.rs !== undefined) {
                const rh = (this.#meta.rh ??= {});
                if (message.rs > (rh[message.from] ?? 0))
                    rh[message.from] = message.rs;
                if (this.#receiptsOn)
                    this.#noteProcessed(message.from, message.rs);
            }
        });
        void task.then(() => this.#pump()).catch(() => { });
        return task.then(() => {
            if (this.#persistFailures !== failuresBefore)
                throw new Error('狀態沒有保存');
        });
    }
    /** 已知有這個版本（或它的後代）的裝置；一台都不知道時 `undefined`（廣播） */
    #knowers(rec, nodeId) {
        const devices = Object.entries(rec.peers)
            .filter(([device, ids]) => device !== this.#deviceId && ids.some((k) => k === nodeId || (rec.nodes[k] !== undefined && isAncestor(rec.nodes, nodeId, k))))
            .map(([device]) => device);
        return devices.length > 0 ? devices.sort() : undefined;
    }
    #notePeer(rec, from, nodeId) {
        const known = rec.peers[from] ?? [];
        const next = known.filter((k) => !(rec.nodes[k] && isAncestor(rec.nodes, k, nodeId)));
        if (!next.includes(nodeId))
            next.push(nodeId);
        rec.peers[from] = next.slice(-8);
        this.#markDirty(rec);
        // 輕量成員：等著對方確認才清的那一份，現在可能可以清了（SDK ADR 0058）
        if (this.#scope && rec.disk)
            this.#toMaterialize.add(rec.id);
    }
    async #receiveNode(from, fileId, node, content) {
        const waiting = this.#waiting.get(node.id);
        if (waiting) {
            if (content && !waiting.content) {
                waiting.content = b64.encode(content);
                this.#bg(this.#store.set(`w:${node.id}`, encodeJson(waiting)));
            }
            return;
        }
        let rec = this.#files.get(fileId);
        if (rec?.nodes[node.id]) {
            this.#notePeer(rec, from, node.id);
            // 內容到了：在等的、或還是版本頭卻沒有內容的（例如先收到只有版本資訊的補送、重開後忘了在等）都收下
            // （比對內容雜湊：改名、相撞改名等後代版本與它同內容，版本頭可能已經是後代）
            const known = rec;
            const lacking = known.heads.some((h) => known.nodes[h]?.hash === node.hash) && known.disk?.hash !== node.hash && !this.#sparseOut(known) && !this.#excludedRecord(known);
            if (content && !node.deleted && !rec.blobs.includes(node.hash) && (this.#pending.has(node.id) || lacking)) {
                this.#taskCache.set(node.hash, content);
                await this.#putBlob(rec, node.hash, content);
                this.#pending.delete(node.id);
                for (const h of rec.heads)
                    if (rec.nodes[h]?.hash === node.hash)
                        this.#pending.delete(h);
                await this.#converge(rec);
            }
            return;
        }
        if (rec?.pruned.includes(node.id))
            return;
        const missing = node.parents.filter((p) => !rec?.nodes[p] && !rec?.pruned.includes(p));
        if (missing.length > 0) {
            this.#wait({ fileId, node, from, since: this.#clock.now(), ...(content ? { content: b64.encode(content) } : {}) });
            // 這個檔案這台還不認得：連祖先一起要（SDK ADR 0088），不必一層一層索取
            // 父版本問送這個版本來的那台：它一定有（SDK ADR 0104）；問不到的話維護時會再廣播一次
            this.#want(missing.map((p) => [fileId, p]), false, !rec, [from]);
            return;
        }
        rec ??= this.#newRecord(fileId);
        await this.#integrate(rec, from, node, content);
        await this.#releaseWaiting(rec);
        await this.#converge(rec);
    }
    async #integrate(rec, from, node, content) {
        this.#addNode(rec, node);
        this.#notePeer(rec, from, node.id);
        if (content && !node.deleted) {
            this.#taskCache.set(node.hash, content);
            // 輕量成員：範圍外的內容不保存（只留在這次工作的快取裡；SDK ADR 0058）
            if (!this.#sparseOut(rec))
                await this.#putBlob(rec, node.hash, content);
        }
        this.#updateTarget(rec);
    }
    #wait(entry) {
        // 輕量成員：範圍外的版本等父版本時不保存內容（SDK ADR 0058）
        const scope = this.#scope;
        if (scope && entry.content !== undefined && !scope.content(entry.node.path) && !this.#pins.has(entry.fileId) && !this.#lru.has(entry.fileId) && !this.#fetching.has(entry.fileId)) {
            delete entry.content;
        }
        if (this.#waiting.size >= MAX_WAITING) {
            const [oldest] = this.#waiting.values();
            this.#removeWaiting(oldest);
        }
        this.#addWaiting(entry);
        this.#bg(this.#store.set(`w:${entry.node.id}`, encodeJson(entry)));
    }
    #addWaiting(entry) {
        this.#waiting.set(entry.node.id, entry);
        let set = this.#waitingByFile.get(entry.fileId);
        if (!set)
            this.#waitingByFile.set(entry.fileId, (set = new Set()));
        set.add(entry.node.id);
    }
    #removeWaiting(entry) {
        this.#waiting.delete(entry.node.id);
        const set = this.#waitingByFile.get(entry.fileId);
        set?.delete(entry.node.id);
        if (set?.size === 0)
            this.#waitingByFile.delete(entry.fileId);
        this.#bg(this.#store.delete(`w:${entry.node.id}`));
    }
    /**
     * 父版本到了（遠端送來的，或本機算出的合併、路徑相撞版本）：把等著它的版本依序併入（可能一路連鎖）。
     * 回傳是否有併入任何版本。
     */
    async #releaseWaiting(rec, orphanBefore) {
        let any = false;
        for (let progress = true; progress;) {
            progress = false;
            for (const id of [...(this.#waitingByFile.get(rec.id) ?? [])]) {
                const entry = this.#waiting.get(id);
                const ready = entry.node.parents.every((p) => rec.nodes[p] || rec.pruned.includes(p));
                const orphan = orphanBefore !== undefined && entry.since <= orphanBefore;
                if (!ready && !orphan)
                    continue;
                this.#removeWaiting(entry);
                if (rec.nodes[entry.node.id])
                    continue;
                await this.#integrate(rec, entry.from, entry.node, entry.content ? b64.decode(entry.content) : undefined);
                progress = true;
                any = true;
            }
        }
        return any;
    }
    #receiveDigest(message) {
        const wants = [];
        let acc = this.#digests.get(message.digestId);
        if (!acc) {
            // 這份摘要反映到我們的哪個序號（SDK ADR 0074）：舊版沒有 `seen`、或它的狀態重建過（`sid` 換了）就不能比對
            const known = this.#peerSid.get(message.from);
            if (message.sid !== undefined)
                this.#peerSid.set(message.from, message.sid);
            const comparable = message.seen !== undefined && (message.sid === undefined || known === undefined || known === message.sid);
            const seen = comparable ? (message.seen.find(([d]) => d === this.#deviceId)?.[1] ?? 0) : null;
            acc = { parts: message.parts, got: new Set(), files: new Set(), from: message.from, seen };
            this.#digests.set(message.digestId, acc);
            if (this.#digests.size > 16)
                this.#digests.delete(this.#digests.keys().next().value);
        }
        for (const [fileId, theirHeads] of message.files) {
            acc.files.add(fileId);
            const rec = this.#files.get(fileId);
            const unknown = theirHeads.filter((h) => !rec?.nodes[h] && !rec?.pruned.includes(h));
            if (rec) {
                const known = theirHeads.slice(0, 8);
                const prev = rec.peers[message.from];
                if (!prev || prev.length !== known.length || prev.some((h, i) => h !== known[i])) {
                    rec.peers[message.from] = known;
                    this.#markDirty(rec);
                    if (this.#scope && rec.disk && this.#sparseOut(rec))
                        this.#toMaterialize.add(rec.id);
                }
                // 對方有我們不認得的版本：它可能已經包含我們的版本頭，先要來看再說（分岔的話，合併版本送出時對方會來要）
                if (unknown.length === 0)
                    for (const h of rec.heads) {
                        const covered = theirHeads.some((t) => t === h || (rec.nodes[t] !== undefined && isAncestor(rec.nodes, h, t)));
                        if (!covered && !this.#stillInFlight(message.from, h, acc.seen))
                            this.#resend(fileId, h, message.from);
                    }
            }
            for (const h of unknown)
                if (!this.#waiting.has(h))
                    wants.push([fileId, h]);
        }
        acc.got.add(message.part);
        if (acc.got.size === acc.parts && acc.from === message.from) {
            // 完整的摘要：對方完全沒有的檔案，把版本頭連同祖先送過去（SDK ADR 0088）——只送版本頭的話，
            // 對方要一層一層索取父版本，排程模式下每一層都要等兩邊各同步一輪。版本頭在前、祖先在後：對方先把版本頭放進等待區，
            // 最後一個祖先到了才一次併入，只寫最新的內容（父版本在前的話，每到一層就寫一次舊內容）
            for (const rec of this.#files.values()) {
                if (acc.files.has(rec.id))
                    continue;
                for (const id of ancestryOf(rec.nodes, rec.heads).reverse())
                    if (!this.#stillInFlight(acc.from, id, acc.seen))
                        this.#resend(rec.id, id, acc.from);
            }
            this.#noteSeen(acc.from, this.#clock.now(), true);
            this.#digests.delete(message.digestId);
        }
        if (wants.length > 0)
            this.#want(wants, false, false, [message.from]);
        // 對方在線上（剛送來摘要）：它的版本頭裡有我們磁碟上的大檔、它可能還沒有內容 → 排 P2P 直送，並立刻試一次連線
        if (this.#peers && this.#peerDevices().includes(message.from)) {
            for (const [fileId, theirHeads] of message.files) {
                const rec = this.#files.get(fileId);
                if (!rec?.disk)
                    continue;
                for (const h of theirHeads) {
                    const node = rec.nodes[h];
                    // 對方是輕量成員、而且在它的範圍外：不直送（SDK ADR 0058）
                    if (node?.p2p && !node.deleted && node.hash === rec.disk.hash && !this.#metaOnlyFor(message.from, node))
                        this.#addPush(message.from, fileId, h);
                }
            }
            this.#scheduleP2P(message.from, true);
        }
    }
    /** 對方要（或缺）某個版本：排進送出佇列（已經排著就不重複）。`content`：它明確要內容（不依它的範圍裁剪；SDK ADR 0058） */
    #resend(fileId, nodeId, forDevice, content = false) {
        const rec = this.#files.get(fileId);
        if (!rec?.nodes[nodeId])
            return;
        this.#enqueueSend(fileId, nodeId, forDevice, content);
    }
    /** 索取（SDK ADR 0025 §5；ADR 0058：`fetch`＝要的是內容） */
    #receiveWant(message) {
        const content = message.fetch === true;
        for (const [fileId, nodeId] of message.items) {
            const rec = this.#files.get(fileId);
            const node = rec?.nodes[nodeId];
            if (!rec || !node)
                continue;
            // 連祖先一起要（SDK ADR 0088）：對方不認得這個檔案，把它的祖先也送過去（子版本在前：對方最後一個到了才一次併入）；
            // 要的那一個照下面的規則
            if (message.deep === true)
                for (const id of ancestryOf(rec.nodes, [nodeId]).reverse())
                    if (id !== nodeId)
                        this.#resend(fileId, id, message.from);
            if (content && !node.deleted) {
                // 輕量成員不是內容來源：手上沒有的內容不回（回了也只是沒有內容的版本；SDK ADR 0058）
                if (!this.#hasContentFor(rec, node))
                    continue;
                // 大檔只走直連：排進直送（對方是要內容的）
                if (node.p2p) {
                    if (this.#peers && this.#peerDevices().includes(message.from) && rec.disk?.hash === node.hash) {
                        this.#addPush(message.from, fileId, nodeId);
                        this.#scheduleP2P(message.from, true);
                    }
                    continue;
                }
            }
            this.#resend(fileId, nodeId, message.from, content);
        }
    }
    /** 這台手上有這個版本的內容（保存的、或磁碟上的就是它；不讀檔） */
    #hasContentFor(rec, node) {
        return rec.blobs.includes(node.hash) || rec.disk?.hash === node.hash || rec.det?.hash === node.hash;
    }
    /**
     * 向其他裝置索取版本（盡力而為，不持久化；同一個版本有節流）。`content`：要的是內容（SDK ADR 0058，`fetch`）。
     * `to`：只問這幾台（SDK ADR 0104），省略＝廣播。先收集 {@link WANT_BATCH_MS} 再一起送，每則最多 1000 項。
     */
    #want(items, content = false, deep = false, to) {
        const now = this.#clock.now();
        const fresh = items.filter(([, id]) => {
            const last = this.#wantedAt.get(id);
            if (last !== undefined && now - last < this.#opts.wantIntervalMs)
                return false;
            this.#wantedAt.set(id, now);
            return true;
        });
        if (fresh.length === 0 || !this.#online || this.#paused || this.#stopped)
            return;
        const key = `${content ? 1 : 0}${deep ? 1 : 0}|${to ? [...to].sort().join(',') : '*'}`;
        let group = this.#wantBatch.get(key);
        if (!group) {
            group = { content, deep, to, items: new Map() };
            this.#wantBatch.set(key, group);
        }
        for (const item of fresh)
            group.items.set(item[1], item);
        if (this.#wantTimer !== undefined)
            return;
        // 收集中也算「還有東西要送」：`sent()` 不會在索取送出之前就回報送完
        this.#auxSending += 1;
        this.#wantTimer = this.#clock.setTimeout(() => this.#flushWants(), WANT_BATCH_MS);
    }
    #flushWants() {
        this.#wantTimer = undefined;
        this.#auxSending -= 1;
        const groups = [...this.#wantBatch.values()];
        this.#wantBatch.clear();
        if (!this.#online || this.#paused || this.#stopped) {
            // 沒送出去：下次可以馬上再要
            for (const g of groups)
                for (const id of g.items.keys())
                    this.#wantedAt.delete(id);
            this.#checkSent();
            return;
        }
        for (const g of groups) {
            const all = [...g.items.values()];
            for (let i = 0; i < all.length; i += 1000) {
                const part = all.slice(i, i + 1000);
                this.#auxSending += 1;
                void this.#sendCounted({ type: 'want', from: this.#deviceId, items: part, ...(g.content ? { fetch: true } : {}), ...(g.deep ? { deep: true } : {}) }, g.to ? { to: g.to } : undefined)
                    .catch(() => {
                    for (const [, id] of part)
                        this.#wantedAt.delete(id);
                })
                    .finally(() => {
                    this.#auxSending -= 1;
                    this.#checkSent();
                });
            }
        }
        this.#checkSent();
    }
    #dropWantBatch() {
        if (this.#wantTimer === undefined)
            return;
        this.#clock.clearTimeout(this.#wantTimer);
        this.#wantTimer = undefined;
        this.#auxSending -= 1;
        for (const g of this.#wantBatch.values())
            for (const id of g.items.keys())
                this.#wantedAt.delete(id);
        this.#wantBatch.clear();
    }
    // ───────────────────────────── 送 ─────────────────────────────
    #onStatus(online) {
        const wasOnline = this.#online;
        this.#online = online;
        if (online && !this.#paused && this.#started && !this.#stopped) {
            this.#touchSync();
            // 摘要在送出佇列清空後才送：否則它會比佇列裡的版本先到，對方以為缺了、又來要一次
            if (!wasOnline && this.#autoDigest())
                this.#digestDue = true;
            this.#pump();
            // 離線時累積（或送不出去）的簽收單（SDK ADR 0068）
            if (!wasOnline)
                this.#scheduleReceipts(RECEIPT_DELAY_MS);
        }
        this.#emitStatus();
    }
    /** 這次連上要不要自動送摘要（SDK ADR 0045，`digestPolicy`） */
    #autoDigest() {
        if (this.#digestPolicy === 'manual')
            return false;
        const last = this.#meta.digestAt;
        const now = this.#clock.now();
        if (last !== undefined && now - last < this.#digestMinIntervalMs)
            return false;
        if (this.#digestPolicy === 'on-connect')
            return true;
        if (last === undefined || this.#meta.digestDirty === true)
            return true;
        return this.#digestMaxIntervalMs > 0 && now - last >= this.#digestMaxIntervalMs;
    }
    /** `full`：不帶 `seen`，對方照舊重送這台缺的全部（SDK ADR 0074） */
    async #sendDigest(full = false) {
        const gen = this.#changeGen;
        const parts = await this.#run(async () => {
            const files = [...this.#files.values()].map((rec) => [rec.id, [...rec.heads]]);
            const chunk = this.#opts.digestChunk;
            const count = Math.max(1, Math.ceil(files.length / chunk));
            const digestId = this.#randomId();
            // 已處理到各寄件人的序號（SDK ADR 0074）：在這之後才送來的，摘要裡沒有不代表缺。台數有上限（實際上不會到），超過時留序號大的
            const seen = Object.entries(this.#meta.rh ?? {})
                .sort((x, y) => y[1] - x[1])
                .slice(0, MAX_SEEN);
            return Array.from({ length: count }, (_, part) => ({
                type: 'digest',
                from: this.#deviceId,
                digestId,
                part,
                parts: count,
                files: files.slice(part * chunk, (part + 1) * chunk),
                ...(full ? {} : { seen }),
                ...(this.#meta.sid ? { sid: this.#meta.sid } : {}),
            }));
        });
        for (const message of parts) {
            try {
                await this.#sendCounted(message);
            }
            catch {
                // 下次上線再送；這台可能漏收（`full`）的標記留著，下一份摘要照樣不帶 `seen`
                if (full)
                    this.#digestFull = true;
                return;
            }
        }
        await this.#run(async () => {
            this.#meta.digestAt = this.#clock.now();
            // 送摘要期間又有新版本要廣播：標記留著，下一次照送
            if (gen === this.#changeGen)
                delete this.#meta.digestDirty;
            this.#metaDirty = true;
        });
    }
    #pump() {
        this.#prunePushes();
        if (this.#peers && this.#started && !this.#stopped && (this.#pushes.size > 0 || this.#bulkMode()))
            this.#scheduleP2P();
        if (this.#pumping || !this.#online || this.#paused || !this.#started || this.#stopped)
            return;
        this.#pumping = true;
        void this.#pumpLoop().finally(() => {
            this.#pumping = false;
            this.#emitStatus();
        });
    }
    async #pumpLoop() {
        while (this.#online && !this.#paused && !this.#stopped) {
            const built = await this.#run(async () => this.#buildNext());
            if (!built) {
                if (this.#digestDue) {
                    this.#digestDue = false;
                    const full = this.#digestFull;
                    this.#digestFull = false;
                    await this.#sendDigest(full);
                    // 送摘要期間排進來的版本：送摘要時 `#pump()` 被略過（正在 pumping），這裡再看一次佇列
                    continue;
                }
                return;
            }
            const { seqs, message, options, owed } = built;
            try {
                await this.#sendCounted(message, options);
            }
            catch (error) {
                for (const seq of seqs)
                    this.#inflight.delete(seq);
                this.#sendFailing = true;
                this.#lastError = error instanceof Error ? error.message : String(error);
                if (isRelayRejectsFilesError(error)) {
                    // 中繼不收 kind 1060：重試也沒用，只偶爾探一次（站方可能之後開了）；明確回報一次（SDK ADR 0027）
                    if (this.#blocked !== 'relay-rejects-files') {
                        this.#blocked = 'relay-rejects-files';
                        this.#emit('error', { context: 'relay-rejects-files', error });
                    }
                    this.#retryDelay = this.#opts.retryMaxMs;
                    this.#scheduleP2P();
                }
                else if (isRelaysFullError(error)) {
                    // 中繼（含備援）都滿了（只有傳輸層設了 durability 才會出現；SDK ADR 0041）：同一個模式——回報一次、最長退避、任何一座收下就恢復
                    if (this.#blocked !== 'relays-full') {
                        this.#blocked = 'relays-full';
                        this.#emit('error', { context: 'relays-full', error });
                    }
                    this.#retryDelay = this.#opts.retryMaxMs;
                    this.#scheduleP2P();
                }
                else
                    this.#retryDelay = this.#retryDelay === 0 ? this.#opts.retryInitialMs : Math.min(this.#opts.retryMaxMs, this.#retryDelay * 2);
                this.#clock.clearTimeout(this.#retryTimer);
                this.#retryTimer = this.#clock.setTimeout(() => this.#pump(), this.#retryDelay);
                return;
            }
            this.#sendFailing = false;
            if (this.#blocked !== undefined)
                this.#scheduleReceipts(0);
            this.#blocked = undefined;
            this.#retryDelay = 0;
            await this.#run(async () => {
                for (const seq of seqs)
                    this.#onSent(seq, owed);
                if (this.#toMaterialize.size > 0 && this.#scope)
                    await this.#drain();
            });
        }
    }
    async #buildNext() {
        this.#throttledUntil = null;
        const bulk = this.#bulkMode();
        // 積壓的收件人（SDK ADR 0091）：中繼不收檔案塊、或傳輸層不能照收件人送時沒辦法拆，整批照舊限速
        const heavy = bulk && this.#blocked === undefined && this.#transport.targeted === true ? this.#backlogged() : null;
        // 帳滿或限速而先跳過的項目最早什麼時候可以送（SDK ADR 0068：不能擋住後面送給其他收件人的；全部都跳過才等）
        let quotaWait = Number.POSITIVE_INFINITY;
        const usedMemo = new Map();
        for (const entry of this.#outbox.values()) {
            if (this.#inflight.has(entry.seq))
                continue;
            const rec = this.#files.get(entry.fileId);
            const node = rec?.nodes[entry.nodeId];
            if (!rec || !node) {
                this.#dropOutbox(entry.seq);
                continue;
            }
            const route = this.#route(entry, bulk, heavy);
            let to = route.to;
            let owed = route.owed;
            const { throttled, split } = route;
            if (throttled) {
                // 暫停經中繼補送（`setRelayBulkPerHour(0)`，SDK ADR 0053 §G16）：只走 P2P，調回來時 `setRelayBulkPerHour` 會再推一次
                if (this.#relayBulkPerHour === 0) {
                    this.#scheduleP2P();
                    if (heavy)
                        continue;
                    return null;
                }
                // 批次模式：主要走 P2P；中繼（kind 1060，會佔收件人的儲存配額）只以限速補送（SDK ADR 0026 §5）。
                // 兩道：每小時訊息數（平滑）與保存期內的塊數預算——按收件人（SDK ADR 0029、0068）：帳滿的那幾台先排除，其他照送
                const rateWait = this.#relayBulkWait();
                if (rateWait > 0) {
                    if (heavy) {
                        // 後面可能還有要給不積壓的裝置的
                        quotaWait = Math.min(quotaWait, rateWait);
                        continue;
                    }
                    this.#clock.clearTimeout(this.#retryTimer);
                    this.#retryTimer = this.#clock.setTimeout(() => this.#pump(), rateWait);
                    this.#throttledUntil = this.#clock.now() + rateWait;
                    this.#scheduleP2P();
                    return null;
                }
                const recipients = this.#recipients();
                const targets = to ?? recipients;
                const plan = this.#quotaPlan(targets, this.#estimateFrames(rec.id, node), usedMemo);
                if (plan.wait > 0) {
                    // 這一則的收件人帳都滿了：先看後面的（可能是送給其他收件人的）
                    quotaWait = Math.min(quotaWait, plan.wait);
                    continue;
                }
                if (plan.blocked.length > 0 && targets) {
                    owed = plan.blocked;
                    to = targets.filter((d) => !owed.includes(d));
                }
                this.#relayBulkSent.push(this.#clock.now());
            }
            // 而且都在它們範圍外：只帶版本資訊；傳輸層會照收件人送時，連續幾個合成一則（SDK ADR 0058）
            const metaOnly = to !== undefined && to.every((d) => this.#metaOnlyFor(d, node, entry));
            // 合成一則（同一組 `to` 的連續幾項）：按積壓拆過收件人的這一項單獨送（SDK ADR 0091）
            if (metaOnly && this.#transport.targeted === true && entry.to !== undefined && !split) {
                const batch = this.#batchMetaOnly(entry, rec.id, node);
                if (batch) {
                    for (const seq of batch.seqs)
                        this.#handOver(seq);
                    return { seqs: batch.seqs, message: { type: 'nodes', from: this.#deviceId, items: batch.items }, options: { to }, owed };
                }
            }
            // 小檔合併（SDK ADR 0095、0096）：實際收件人與欠款一樣的後幾項一起裝進一則，不超過一個訊框；限速與配額照一則算
            if (!metaOnly) {
                const bundle = await this.#bundleFrom(entry, rec.id, node, to, route, bulk, heavy);
                if (bundle) {
                    for (const seq of bundle.seqs)
                        this.#handOver(seq);
                    return { seqs: bundle.seqs, message: { type: 'bundle', from: this.#deviceId, items: bundle.items }, ...(to !== undefined ? { options: { to } } : {}), owed };
                }
            }
            let content;
            if (!node.deleted && !node.p2p && !metaOnly)
                content = await this.#getContent(rec, node.hash);
            this.#handOver(entry.seq);
            const message = { type: 'node', from: this.#deviceId, fileId: rec.id, node, ...(content ? { content } : {}) };
            // 宣告為輕量的收件人、版本在它的範圍外：傳輸層對它拿掉內容（它明確要內容的除外；SDK ADR 0058）
            const omit = content ? [...this.#peerScopes.keys()].filter((d) => (to === undefined || to.includes(d)) && this.#metaOnlyFor(d, node, entry)) : [];
            const options = { ...(to !== undefined ? { to } : {}), ...(omit.length > 0 ? { omitContentFor: omit } : {}) };
            return { seqs: [entry.seq], message, ...(to !== undefined || omit.length > 0 ? { options } : {}), owed };
        }
        if (Number.isFinite(quotaWait)) {
            this.#clock.clearTimeout(this.#retryTimer);
            this.#retryTimer = this.#clock.setTimeout(() => this.#pump(), quotaWait);
            this.#throttledUntil = this.#clock.now() + quotaWait;
            this.#scheduleP2P();
        }
        return null;
    }
    /** 交給傳輸層了：送出中，而且就可能有一部分裝置收到了（例如送給第一台成功、第二台失敗）——之後不能再被本機編輯合併掉 */
    #handOver(seq) {
        this.#inflight.add(seq);
        const entry = this.#outbox.get(seq);
        const rec = entry ? this.#files.get(entry.fileId) : undefined;
        if (entry && rec && rec.unsent[entry.nodeId] === true) {
            rec.unsent[entry.nodeId] = false;
            this.#markDirty(rec);
        }
    }
    /**
     * 把佇列裡送給同一組輕量收件人、都只帶版本資訊的版本合成一則 `nodes` 訊息（一個訊框以內）。只有一個就回 null（照常送 `node`）。
     * 新加入的輕量成員要整個 Vault 的版本資訊時，5,000 個檔案只要幾十則（SDK ADR 0058）。
     */
    #batchMetaOnly(first, fileId, node) {
        const key = [...first.to].sort().join(',');
        const items = [[fileId, node]];
        const seqs = [first.seq];
        let bytes = 256 + JSON.stringify([fileId, node]).length;
        for (const other of this.#outbox.values()) {
            if (items.length >= MAX_NODES_PER_MESSAGE)
                break;
            if (other === first || this.#inflight.has(other.seq) || !other.to || [...other.to].sort().join(',') !== key)
                continue;
            const orec = this.#files.get(other.fileId);
            const onode = orec?.nodes[other.nodeId];
            if (!onode || !other.to.every((d) => this.#metaOnlyFor(d, onode, other)))
                continue;
            const size = JSON.stringify([other.fileId, onode]).length + 1;
            if (bytes + size > FILE_CHUNK_BYTES - 1024)
                break;
            items.push([other.fileId, onode]);
            seqs.push(other.seq);
            bytes += size;
        }
        return items.length > 1 ? { seqs, items } : null;
    }
    /**
     * 這一項這次要送給誰（限速與配額之前）：
     * - 只有輕量成員要的（它們的摘要或索取引起的補送）：只送給它們（傳輸層做得到時）。完整成員要的照舊廣播——
     *   其他裝置順便收到，少一輪對帳（v0.45 的行為）。之前因為帳滿被排除、還欠著的（SDK ADR 0068 §3）：只送給它們。
     * - 只限速要給積壓那幾台的（SDK ADR 0091）：還沒經直連收到的收件人裡有不積壓的，就先照常送給它們，積壓的記成還欠著。
     */
    #route(entry, bulk, heavy) {
        let to = entry.owed !== undefined && entry.owed.length > 0 && this.#transport.targeted === true
            ? [...entry.owed]
            : entry.to !== undefined && entry.to.length > 0 && entry.to.every((d) => this.#peerScopes.has(d))
                ? entry.to
                : undefined;
        let owed = [];
        let throttled = bulk;
        let split = false;
        if (heavy) {
            const remaining = (to ?? this.#recipients() ?? this.#peerDevices()).filter((d) => !entry.got?.includes(d));
            const light = remaining.filter((d) => !heavy.has(d));
            if (light.length > 0) {
                throttled = false;
                owed = remaining.filter((d) => heavy.has(d));
                if (owed.length > 0 || (entry.got?.length ?? 0) > 0) {
                    to = light;
                    split = true;
                }
            }
        }
        return { to, owed, throttled, split };
    }
    /** 兩項能不能合進同一則（SDK ADR 0096）：這次實際的收件人、欠款、要不要限速都一樣 */
    #routeKey(route) {
        return JSON.stringify([route.to === undefined ? null : [...route.to].sort(), [...route.owed].sort(), route.throttled]);
    }
    /**
     * 從 `first` 開始，把佇列裡收件條件一樣、還沒送出的小版本連同內容合成一則 `bundle`（SDK ADR 0095）。
     * 收件人要全部看得懂、而且都不是輕量成員；編碼後不超過一個訊框；只走 P2P 的大檔不合。湊不到兩項回 null（照舊送 `node`）。
     */
    async #bundleFrom(first, fileId, node, to, route, bulk, heavy) {
        if (this.#bundleDevices.size === 0)
            return null;
        const targets = to ?? this.#recipients() ?? this.#peerDevices();
        if (targets.length === 0 || !targets.every((d) => this.#bundleDevices.has(d) && !this.#peerScopes.has(d)))
            return null;
        // 照這次實際的去向分組（SDK ADR 0096）：佇列裡的欄位（`to`／`got`／`owed`）不同、算出來的去向卻一樣的，照樣合
        const key = this.#routeKey(route);
        const items = [];
        const seqs = [];
        let bytes = encodedVaultMessageLength({ type: 'bundle', from: this.#deviceId, items: [] }) + HEADER_SLACK;
        const add = async (seq, id, version) => {
            if (version.p2p && !version.deleted)
                return false;
            const size = encodedVaultMessageLength({ type: 'bundle', from: this.#deviceId, items: [{ fileId: id, node: version }] }) - encodedVaultMessageLength({ type: 'bundle', from: this.#deviceId, items: [] }) + 24 + (version.deleted ? 0 : version.size);
            if (bytes + size > BUNDLE_MAX_BYTES)
                return false;
            const rec = this.#files.get(id);
            const content = version.deleted ? undefined : rec ? await this.#getContent(rec, version.hash) : undefined;
            if (!version.deleted && content === undefined)
                return false;
            items.push({ fileId: id, node: version, ...(content ? { content } : {}) });
            seqs.push(seq);
            bytes += size;
            return true;
        };
        if (!(await add(first.seq, fileId, node)))
            return null;
        for (const other of this.#outbox.values()) {
            if (items.length >= MAX_BUNDLE_ITEMS)
                break;
            if (other === first || this.#inflight.has(other.seq) || this.#routeKey(this.#route(other, bulk, heavy)) !== key)
                continue;
            const rec = this.#files.get(other.fileId);
            const version = rec?.nodes[other.nodeId];
            if (!rec || !version)
                continue;
            // 裝不下的這一項留給下一則；後面更小的還可以裝
            await add(other.seq, rec.id, version);
        }
        return items.length >= 2 ? { seqs, items } : null;
    }
    #onSent(seq, owed = []) {
        const entry = this.#outbox.get(seq);
        this.#inflight.delete(seq);
        if (!entry)
            return;
        if (owed.length > 0) {
            // 帳滿被排除的那幾台（SDK ADR 0068 §3）：還欠它們，留著
            entry.owed = [...owed];
            delete entry.again;
            this.#saveOutbox(entry);
            return;
        }
        if (entry.owed)
            delete entry.owed;
        if (entry.again) {
            delete entry.again;
            this.#saveOutbox(entry);
            return;
        }
        this.#dropOutbox(seq);
        this.#meta.lastSyncAt = this.#clock.now();
        this.#metaDirty = true;
        const rec = this.#files.get(entry.fileId);
        if (rec && entry.nodeId in rec.unsent) {
            delete rec.unsent[entry.nodeId];
            this.#markDirty(rec);
            this.#gcFile(rec);
        }
        // 輕量成員：範圍外、等著送出才清的本機那一份，現在可以清了（SDK ADR 0058）
        if (rec?.disk && this.#scope && this.#sparseOut(rec))
            this.#toMaterialize.add(rec.id);
    }
    // ───────────────────────────── P2P 批次（SDK ADR 0026） ─────────────────────────────
    #peerDevices() {
        return (this.#peers?.devices() ?? []).filter((d) => d !== this.#deviceId);
    }
    /** 待送出的版本多到超過門檻（或中繼根本不收檔案塊）：改走 P2P 批次，中繼只限速補送 */
    #bulkMode() {
        if (this.#peers === undefined || this.#peerDevices().length === 0)
            return false;
        const waiting = this.#outbox.size - this.#inflight.size;
        if (this.#blocked !== undefined && waiting > 0)
            return true;
        return waiting >= this.#bulkThreshold && this.#backlogged().size > 0;
    }
    /**
     * 積壓的收件人：佇列裡還欠它（還沒經直連收到）的版本達到門檻的裝置（SDK ADR 0091）。批次限速只套在要給它們的那一份；
     * 只欠其他裝置的新修改照常即時經中繼送——一台長期離線、剛加入的裝置不會拖住其他裝置之間的同步。
     */
    #backlogged() {
        const all = this.#peerDevices();
        const counts = new Map();
        const heavy = new Set();
        for (const entry of this.#outbox.values()) {
            if (this.#inflight.has(entry.seq))
                continue;
            for (const d of entry.owed ?? entry.to ?? all) {
                if (entry.got?.includes(d))
                    continue;
                const n = (counts.get(d) ?? 0) + 1;
                counts.set(d, n);
                if (n >= this.#bulkThreshold)
                    heavy.add(d);
            }
        }
        return heavy;
    }
    /** 批次模式下走中繼還要等多久（滑動一小時內最多 `relayBulkPerHour` 則） */
    #relayBulkWait() {
        const now = this.#clock.now();
        while (this.#relayBulkSent.length > 0 && now - this.#relayBulkSent[0] >= 3_600_000)
            this.#relayBulkSent.shift();
        if (this.#relayBulkSent.length < this.#relayBulkPerHour)
            return 0;
        return Math.max(1, this.#relayBulkSent[0] + 3_600_000 - now);
    }
    /**
     * 送一則經傳輸層的訊息，成功就把它佔的檔案塊記帳（SDK ADR 0029；ADR 0068：按收件人、帶寄件序號，收件人簽收了就劃掉）。
     * 簽收單本身不帶序號、不記帳：它很小（一塊），收件人處理完照樣以 ADR 0067 的收件確認讓中繼提早清掉；記進帳只會過期，
     * 每輪一份、七天累積下來會佔掉預算的一大塊。
     */
    async #sendCounted(message, options) {
        let out = message;
        let rs = 0;
        if (message.type !== 'receipt') {
            rs = (this.#meta.rs ?? 0) + 1;
            this.#meta.rs = rs;
            this.#metaDirty = true;
            out = { ...message, rs };
        }
        if (options)
            await this.#transport.send(out, options);
        else
            await this.#transport.send(out);
        if (rs === 0)
            return;
        const v = message.type === 'node'
            ? [[message.fileId, message.node.id]]
            : message.type === 'nodes'
                ? message.items.map(([fileId, node]) => [fileId, node.id])
                : message.type === 'bundle'
                    ? message.items.map((item) => [item.fileId, item.node.id])
                    : [];
        const to = options?.to && this.#transport.targeted === true ? [...options.to] : undefined;
        this.#noteRelaySent(rs, v, to ?? this.#recipients());
        this.#ledger.record({ rs, f: vaultFrameCount(encodedVaultMessageLength(out)), ...(to ? { to } : {}), ...(v.length > 0 ? { v } : {}) });
        if (this.#ledger.size > LEDGER_MAX_ENTRIES)
            this.#ledger.compact(LEDGER_MAX_ENTRIES);
        this.#saveLedger();
    }
    /** 記下這些版本以序號 `rs` 經中繼送給了 `recipients`（SDK ADR 0074）；不知道收件人就不記（照舊重送） */
    #noteRelaySent(rs, versions, recipients) {
        if (!recipients || versions.length === 0)
            return;
        const at = this.#clock.now();
        for (const device of recipients) {
            for (const [fileId, nodeId] of versions) {
                const key = `${device}\n${nodeId}`;
                this.#relaySent.delete(key);
                this.#relaySent.set(key, { rs, at, fileId });
            }
        }
        // 上限：先丟最舊的（只會讓那幾個版本照舊重送）
        if (this.#relaySent.size > RELAY_SENT_MAX) {
            const drop = this.#relaySent.size - Math.floor(RELAY_SENT_MAX * 0.9);
            let i = 0;
            for (const key of this.#relaySent.keys()) {
                if (i++ >= drop)
                    break;
                this.#relaySent.delete(key);
            }
        }
    }
    /**
     * 對方（`device`）的摘要說它沒有 `nodeId`，但那是在摘要反映的序號 `seen` 之後才經中繼送給它、還在保存期內：還在路上，不重送（SDK ADR 0074）。
     * `seen` 為 null＝不能比對（舊版、或它的狀態重建過）。
     */
    #stillInFlight(device, nodeId, seen) {
        if (seen === null)
            return false;
        const sent = this.#relaySent.get(`${device}\n${nodeId}`);
        return sent !== undefined && sent.rs > seen && this.#clock.now() - sent.at < this.#relayWindowMs;
    }
    /**
     * 中繼弄丟的（SDK ADR 0106）：經中繼送給某台的版本，那台簽收了更後面的序號、這一則送出超過 {@link RELAY_LOST_AFTER_MS} 卻一直沒簽收——
     * 中繼在送到之前把它丟了（收件匣滿了被淘汰、中繼重開），或那台當時還不信任這台而沒收。不再當作「還在路上」（SDK ADR 0074），
     * 那台還不知道這個版本（或它的後代）的話重送（照既有的補送規則，）。只看簽收過的裝置：舊版不簽收，維持原狀。
     */
    #recoverLost() {
        if (this.#relaySent.size === 0)
            return;
        const now = this.#clock.now();
        for (const [key, sent] of this.#relaySent) {
            if (now - sent.at < RELAY_LOST_AFTER_MS)
                continue;
            const cut = key.indexOf('\n');
            const device = key.slice(0, cut);
            const ranges = this.#ledger.receipts(device);
            const top = ranges?.[ranges.length - 1]?.[1];
            if (top === undefined || top <= sent.rs || coversRange(ranges, sent.rs))
                continue;
            this.#relaySent.delete(key);
            const nodeId = key.slice(cut + 1);
            const rec = this.#files.get(sent.fileId);
            if (!rec?.nodes[nodeId] || this.#peerHas(rec, rec.peers[device], nodeId))
                continue;
            this.#resend(sent.fileId, nodeId, device);
        }
    }
    /**
     * 帳變了：節流保存（累積 `LEDGER_SAVE_EVERY` 筆變動才轉成 JSON 寫進狀態；停止時一定寫）。
     * 每送一則就整份轉一次，大量補送時是平方級（5,000 個檔案的初次同步慢好幾倍）。當掉時最多少記這一小段：只會讓送出端多送一點。
     */
    #saveLedger() {
        this.#ledgerDirty = true;
        this.#ledgerUnsaved += 1;
    }
    /** 中繼帳寫進自己的鍵（`rb`）：累積夠多筆變動、或 `force`（停止時）才寫 */
    #ledgerWrites(writes, force = false) {
        if (!this.#ledgerDirty)
            return;
        if (!force && this.#ledgerUnsaved < LEDGER_SAVE_EVERY)
            return;
        this.#ledgerDirty = false;
        this.#ledgerUnsaved = 0;
        writes.push(this.#ledger.size > 0 ? this.#store.set('rb', encodeJson(this.#ledger.toJSON())) : this.#store.delete('rb'));
        if (this.#meta.rb !== undefined || this.#meta.relayUse !== undefined) {
            delete this.#meta.rb;
            delete this.#meta.relayUse;
            this.#metaDirty = true;
        }
    }
    /** 目前的收件裝置（傳輸層知道才有；SDK ADR 0068）；null＝不知道，用舊的一本帳 */
    #recipients() {
        const list = this.#transport.recipients?.();
        if (!list)
            return null;
        const out = [...new Set(list)].filter((d) => d !== this.#deviceId).sort();
        // 第一次成為收件人的時間（SDK ADR 0107）：之前的廣播不算它的用量。新記的要盡快存下（晚存＝重開後當作更晚加入，會少算）
        if (this.#ledger.join(out)) {
            this.#ledgerDirty = true;
            this.#ledgerUnsaved = LEDGER_SAVE_EVERY;
        }
        return out;
    }
    /** 還沒取內容之前估這則版本訊息會佔幾塊（寧可多估） */
    #estimateFrames(fileId, node) {
        const header = encodedVaultMessageLength({ type: 'node', from: this.#deviceId, fileId, node }) + HEADER_SLACK;
        return vaultFrameCount(header + (!node.deleted && !node.p2p ? node.size : 0));
    }
    /**
     * 批次模式下再送 `frames` 塊（SDK ADR 0029、0068）：要送給的 `targets` 裡，加上它會超過預算的那幾台先排除；
     * 全部都超過（或傳輸層不能照收件人送）就等——`wait` 是最早有一台空出來的時間（只看過期；簽收單來了會更早）。
     * 不知道收件人時照舊用一本帳。
     */
    #quotaPlan(targets, frames, memo) {
        if (targets === null || targets.length === 0)
            return { wait: this.#ledger.wait(null, frames, this.#relayBudget), blocked: [] };
        // 同一次挑選（`#buildNext`）裡每台的用量只算一次：佇列很長、又有一台帳滿時，逐則重算是平方級
        const usedOf = (d) => {
            let used = memo?.get(d);
            if (used === undefined) {
                used = this.#ledger.used(d);
                memo?.set(d, used);
            }
            return used;
        };
        const waits = targets.map((d) => {
            const used = usedOf(d);
            if (used === 0 || used + frames <= this.#relayBudget)
                return [d, 0];
            const key = `${d}\n${frames}`;
            let wait = memo?.get(key);
            if (wait === undefined) {
                wait = this.#ledger.wait(d, frames, this.#relayBudget);
                memo?.set(key, wait);
            }
            return [d, wait];
        });
        const blocked = waits.filter(([, w]) => w > 0).map(([d]) => d);
        if (blocked.length === 0)
            return { wait: 0, blocked: [] };
        if (blocked.length < targets.length && this.#transport.targeted === true)
            return { wait: 0, blocked };
        const pending = waits.filter(([, w]) => w > 0).map(([, w]) => w);
        return { wait: blocked.length < targets.length ? Math.max(...pending) : Math.min(...pending), blocked: [] };
    }
    // ───────────────────────────── 簽收單（SDK ADR 0068） ─────────────────────────────
    /** 收件端：`from` 寄來的序號 `rs` 處理完、已保存（在協調器的工作佇列裡呼叫，和那則的結果一起存） */
    #noteProcessed(from, rs) {
        const rp = (this.#meta.rp ??= {});
        rp[from] = addRange(rp[from] ?? [], rs, rs);
        this.#metaDirty = true;
        this.#receiptPending += 1;
        this.#scheduleReceipts(this.#receiptPending >= RECEIPT_BATCH ? 0 : RECEIPT_DELAY_MS);
    }
    #scheduleReceipts(delay) {
        if (!this.#receiptsOn || this.#stopped || !this.#meta.rp)
            return;
        if (this.#receiptTimer !== undefined) {
            if (delay > 0)
                return;
            this.#clock.clearTimeout(this.#receiptTimer);
        }
        this.#receiptTimer = this.#clock.setTimeout(() => {
            this.#receiptTimer = undefined;
            void this.flushReceipts().catch(() => { });
        }, delay);
    }
    /**
     * 立刻送出累積的簽收單（SDK ADR 0068）。協調器自己會在處理完一批（或滿 500 則）後送；排程同步的應用在一輪結束、斷線之前
     * 呼叫它，簽收單不必等到下一輪。送不出去的留著（跨重開），下次連上再送。
     */
    async flushReceipts() {
        if (!this.#receiptsOn || this.#receiptSending || this.#stopped || !this.#started)
            return;
        this.#receiptSending = true;
        try {
            const batch = await this.#run(async () => {
                const rp = this.#meta.rp;
                // 中繼都滿了或不收（`blocked`）：簽收單也送不進去，不另外重試（不風暴）；恢復時再送
                if (!rp || !this.#online || this.#paused || this.#blocked !== undefined)
                    return null;
                delete this.#meta.rp;
                this.#receiptPending = 0;
                this.#metaDirty = true;
                return rp;
            });
            if (!batch)
                return;
            const failed = {};
            for (const [device, ranges] of Object.entries(batch)) {
                for (let i = 0; i < ranges.length; i += MAX_RECEIPT_RANGES) {
                    const part = ranges.slice(i, i + MAX_RECEIPT_RANGES);
                    try {
                        await this.#sendCounted({ type: 'receipt', from: this.#deviceId, for: device, ranges: part }, { to: [device] });
                    }
                    catch {
                        failed[device] = [...(failed[device] ?? []), ...part];
                    }
                }
            }
            if (Object.keys(failed).length > 0) {
                await this.#run(async () => {
                    const rp = (this.#meta.rp ??= {});
                    for (const [device, ranges] of Object.entries(failed))
                        for (const [lo, hi] of ranges)
                            rp[device] = addRange(rp[device] ?? [], lo, hi);
                    this.#metaDirty = true;
                });
            }
        }
        finally {
            this.#receiptSending = false;
        }
    }
    /** 寄件端：收到 `from` 的簽收單——劃掉送給它的帳；簽收的訊息帶的版本，記成它已經有了（不必等它的摘要） */
    #receiveReceipt(message) {
        if (message.for !== this.#deviceId)
            return;
        for (const versions of this.#ledger.receipt(message.from, message.ranges)) {
            for (const [fileId, nodeId] of versions) {
                const rec = this.#files.get(fileId);
                if (rec?.nodes[nodeId])
                    this.#notePeer(rec, message.from, nodeId);
            }
        }
        this.#ledger.prune(this.#recipients() ?? []);
        this.#saveLedger();
        this.#recoverLost();
    }
    #addPush(device, fileId, nodeId) {
        const key = `${device}\n${nodeId}`;
        if (this.#pushes.has(key))
            return;
        if (this.#pushes.size >= MAX_PUSHES) {
            const [oldest] = this.#pushes.keys();
            this.#dropPush(oldest);
        }
        this.#meta.seq += 1;
        this.#metaDirty = true;
        const entry = { seq: this.#meta.seq, device, fileId, nodeId, at: this.#clock.now() };
        this.#pushes.set(key, entry);
        this.#bg(this.#store.set(`x:${String(entry.seq).padStart(12, '0')}`, encodeJson(entry)));
    }
    /**
     * 內容已經不在磁碟上的待直送（檔案刪了、被新版本取代）馬上剔除（SDK ADR 0086）：不必等連上那台才發現，
     * 應用也不會因為「還有大檔要直傳」一直等對方上線。新版本自己會另外排一筆。
     */
    #prunePushes() {
        for (const [key, push] of this.#pushes) {
            const rec = this.#files.get(push.fileId);
            const node = rec?.nodes[push.nodeId];
            if (!rec || !node || node.deleted || rec.disk?.hash !== node.hash)
                this.#dropPush(key);
        }
    }
    #dropPush(key) {
        const entry = this.#pushes.get(key);
        if (!entry)
            return;
        this.#pushes.delete(key);
        this.#bg(this.#store.delete(`x:${String(entry.seq).padStart(12, '0')}`));
    }
    /** 在通道上掛上收方處理器（對方連上來的，或我們自己開的都要：對方也可能在同一條通道上送） */
    #attach(device, channel) {
        if (this.#attached.has(channel))
            return;
        this.#attached.add(channel);
        const stream = StreamTransfer.for(channel, this.#streamOpts);
        // 收方進度（SDK ADR 0053 §G14）：工作階段 id → 傳輸 id
        const receiving = new Map();
        const mode = channel.mode === 'relayed-websocket' ? 'relayed-websocket' : 'p2p-webrtc';
        this.#unhandle.push(stream.handle(VAULT_STREAM_PURPOSE, {
            store: this.#staging,
            ...(this.#stagingMax !== undefined ? { maxEntryBytes: this.#stagingMax } : {}),
            onSession: (info) => {
                const ok = this.#started && !this.#stopped && !this.#paused;
                if (ok)
                    receiving.set(info.id, this.#beginTransfer(device, 'receive', mode, { files: info.count, bytes: info.bytes }));
                return ok;
            },
            accept: (header) => this.#acceptEntry(device, header),
            onEntry: (entry) => this.#receiveEntry(device, entry),
            onProgress: ({ session, entries, bytes, entry }) => {
                const id = receiving.get(session.id);
                if (id === undefined)
                    return;
                // 這個檔案的中繼資料在 accept 已經驗過（不合格的根本不會收資料）；這裡只取顯示用的欄位
                const fileId = entry?.meta.fileId;
                const path = entry?.meta.node?.path;
                const current = entry && entry.size > 0 && typeof fileId === 'string' && typeof path === 'string' ? { fileId, path, size: entry.size, done: entry.received } : null;
                this.#updateTransfer(id, { files: entries, bytes, current });
            },
            onSessionEnd: (session, outcome) => {
                const id = receiving.get(session.id);
                if (id === undefined)
                    return;
                receiving.delete(session.id);
                this.#endTransfer(id, outcome === 'finished' ? 'finished' : 'failed');
            },
        }));
    }
    /** 開（或沿用已經開著的）到那台的通道並掛上收方；拿不到就算了（退避照舊） */
    async #listenTo(device) {
        let channel = null;
        try {
            channel = await this.#peers.open(device);
        }
        catch {
            return;
        }
        if (channel && !this.#stopped)
            this.#attach(device, channel);
    }
    /**
     * 收到 `device` 的訊息：有要經直連給它的（批次、大檔）就重設它的退避、馬上排直連（SDK ADR 0090）。
     * 中繼補送的舊訊息可能一次來很多則、而寄件人早就離線了：同一台 `P2P_POKE_INTERVAL_MS` 內最多觸發一次。
     */
    #pokeP2P(device) {
        if (!this.#peers || this.#stopped || !this.#started || this.#paused)
            return;
        if (!this.#peerDevices().includes(device))
            return;
        const now = this.#clock.now();
        const last = this.#p2pPokedAt.get(device);
        if (last !== undefined && now - last < P2P_POKE_INTERVAL_MS)
            return;
        if (this.#p2pWork(device).length === 0)
            return;
        this.#p2pPokedAt.set(device, now);
        this.#scheduleP2P(device, true);
    }
    #scheduleP2P(device, reset = false) {
        if (!this.#peers || this.#stopped || !this.#started || this.#paused)
            return;
        if (device !== undefined && reset)
            this.#p2pState.delete(device);
        if (this.#p2pRunning) {
            this.#p2pAgain = true;
            return;
        }
        this.#p2pRunning = true;
        void this.#p2pLoop().finally(() => {
            this.#p2pRunning = false;
            this.#emitStatus();
        });
    }
    async #p2pLoop() {
        do {
            this.#p2pAgain = false;
            for (const device of this.#peerDevices()) {
                if (this.#stopped || this.#paused)
                    return;
                const state = this.#p2pState.get(device);
                if (state && this.#clock.now() < state.nextTry)
                    continue;
                const work = await this.#run(async () => this.#p2pWork(device));
                if (work.length === 0)
                    continue;
                const outcome = await this.#p2pSend(device, work, state?.fresh === true).catch(() => 'fail');
                if (outcome === 'progress')
                    this.#p2pState.delete(device);
                else {
                    // 連不上、被拒、或一個都沒送成：退避，等對方送摘要／連上來／背景維護時再試；中繼補送照常進行
                    const delay = state ? Math.min(this.#p2pRetry.max, state.delay * 2) : this.#p2pRetry.initial;
                    this.#p2pState.set(device, { delay, nextTry: this.#clock.now() + delay, fresh: outcome === 'rejected' });
                }
            }
        } while (this.#p2pAgain && !this.#stopped);
    }
    /** 要經 P2P 送給這台裝置的：批次模式下佇列裡它還沒收到的版本，加上等著直送的大檔內容 */
    #p2pWork(device) {
        const work = [];
        const seen = new Set();
        if (this.#bulkMode()) {
            const all = this.#peerDevices();
            for (const entry of this.#outbox.values()) {
                if (this.#inflight.has(entry.seq))
                    continue;
                if (!(entry.owed ?? entry.to ?? all).includes(device) || entry.got?.includes(device))
                    continue;
                work.push({ type: 'node', seq: entry.seq, nodeId: entry.nodeId });
                seen.add(entry.nodeId);
            }
        }
        for (const [key, push] of this.#pushes)
            if (push.device === device && !seen.has(push.nodeId))
                work.push({ type: 'push', key, nodeId: push.nodeId });
        return work;
    }
    async #p2pSend(device, work, fresh) {
        let channel = null;
        try {
            channel = await this.#peers.open(device, fresh ? { fresh: true } : undefined);
        }
        catch {
            channel = null;
        }
        if (!channel || this.#stopped)
            return 'fail';
        this.#attach(device, channel);
        // 中繼軌（P2P 打不通時的 kind 20079）只送小檔的版本；大檔內容等 P2P
        const relayed = channel.mode === 'relayed-websocket';
        const items = relayed ? work.filter((w) => w.type === 'node') : work;
        if (items.length === 0)
            return 'fail';
        const stream = StreamTransfer.for(channel, this.#streamOpts);
        const sent = [];
        let progress = 0;
        let obsolete = 0;
        // 進度（SDK ADR 0053 §G14）：檔案數＝工作項目數、位元組總數是預估
        const totalBytes = await this.#run(async () => this.#estimateP2PBytes(device, items, relayed));
        const transfer = this.#beginTransfer(device, 'send', relayed ? 'relayed-websocket' : 'p2p-webrtc', { files: items.length, bytes: totalBytes });
        const settled = new Set();
        let sentBytes = 0;
        let entryStart = 0;
        let current = null;
        const build = (w) => this.#run(async () => this.#buildEntries(device, w, relayed));
        const stopped = () => this.#stopped;
        const startEntry = (entry) => {
            const meta = entry.meta;
            entryStart = sentBytes;
            current = entry.size > 0 ? { fileId: meta.fileId, path: meta.node.path, size: entry.size, done: 0 } : null;
            this.#updateTransfer(transfer, { current });
        };
        async function* entries() {
            for (const w of items) {
                if (stopped())
                    return;
                const built = await build(w);
                if (!built) {
                    obsolete += 1;
                    settled.add(w);
                    continue;
                }
                for (const { entry, part } of built) {
                    sent.push({ work: w, part });
                    startEntry(entry);
                    yield entry;
                }
            }
        }
        let ended = 'failed';
        try {
            await stream.send(entries(), {
                purpose: VAULT_STREAM_PURPOSE,
                count: items.length,
                ...(totalBytes > 0 ? { bytes: totalBytes } : {}),
                onProgress: ({ bytes }) => {
                    sentBytes = bytes;
                    if (current)
                        current = { ...current, done: Math.min(current.size, bytes - entryStart) };
                    this.#updateTransfer(transfer, { bytes, ...(current ? { current } : {}) });
                },
                onEntryDone: (i, _id, result) => {
                    const item = sent[i];
                    if (!item)
                        return;
                    // 只算真的讓工作變少的：佇列裡的版本送到了、或大檔內容送到了（直送前面那個「只有版本」的不算）
                    if (result.status !== 'failed' && (item.part === 'content' || item.work.type === 'node'))
                        progress += 1;
                    // 一個工作項目的最後一個部分有結果了，才算一個檔案
                    if (sent.slice(i + 1).every((s) => s.work !== item.work))
                        settled.add(item.work);
                    this.#updateTransfer(transfer, { files: settled.size });
                    void this.#run(async () => {
                        this.#p2pDone(device, item.work, item.part, result);
                        if (this.#toMaterialize.size > 0 && this.#scope)
                            await this.#drain();
                    })
                        .then(() => this.#pump())
                        .catch(() => { });
                },
            });
            ended = 'finished';
        }
        catch (error) {
            // 斷線、逾時、被拒：已經送達的已經記下；其餘留著，下次再送（大檔內容從斷點續傳）
            if (error instanceof StreamRejectedError && progress === 0) {
                this.#endTransfer(transfer, 'failed');
                return 'rejected';
            }
        }
        finally {
            if (ended === 'finished')
                this.#updateTransfer(transfer, { files: settled.size });
        }
        this.#endTransfer(transfer, ended);
        return progress > 0 || (sent.length === 0 && obsolete > 0) ? 'progress' : 'fail';
    }
    /** 這批直連工作大概要送多少資料位元組（進度的總數；寧可少估，例如對方已經有的大檔內容會被略過） */
    #estimateP2PBytes(device, items, relayed) {
        let total = 0;
        for (const w of items) {
            let rec;
            let node;
            if (w.type === 'node') {
                const entry = this.#outbox.get(w.seq);
                rec = entry ? this.#files.get(entry.fileId) : undefined;
                node = entry ? rec?.nodes[entry.nodeId] : undefined;
            }
            else {
                const push = this.#pushes.get(w.key);
                rec = push ? this.#files.get(push.fileId) : undefined;
                node = push ? rec?.nodes[push.nodeId] : undefined;
            }
            if (!rec || !node || node.deleted)
                continue;
            if (w.type === 'node' && this.#metaOnlyFor(device, node, this.#outbox.get(w.seq)))
                continue;
            if (!node.p2p)
                total += node.size;
            else if (!relayed && rec.disk?.hash === node.hash)
                total += node.size;
        }
        return total;
    }
    /**
     * 把一項工作變成批次裡的檔案；已經不需要送的回 null（並清掉）。
     * 大檔拆成兩個：先送版本（不附內容），再送內容。收方併入版本後，內容已經在手上（例如只是改名）就回 skip，
     * 不必重傳；版本本身一定送到，不會因為略過內容而漏掉。
     */
    async #buildEntries(device, w, relayed) {
        let rec;
        let node;
        if (w.type === 'node') {
            const entry = this.#outbox.get(w.seq);
            if (!entry || entry.got?.includes(device))
                return null;
            rec = this.#files.get(entry.fileId);
            node = rec?.nodes[entry.nodeId];
            if (!rec || !node) {
                this.#dropOutbox(w.seq);
                return null;
            }
            // 交出去就可能有裝置收到了：之後不能再被本機編輯合併掉（同中繼送出）
            if (rec.unsent[node.id] === true) {
                rec.unsent[node.id] = false;
                this.#markDirty(rec);
            }
            // 宣告為輕量的收件人、版本在它的範圍外：只送版本資訊（SDK ADR 0058）
            if (node.deleted || this.#metaOnlyFor(device, node, entry))
                return [{ entry: this.#entryOf(rec, node, null), part: 'meta' }];
            if (!node.p2p) {
                const bytes = await this.#getContent(rec, node.hash);
                const source = bytes ? { size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) } : null;
                return [{ entry: this.#entryOf(rec, node, source), part: source ? 'whole' : 'meta' }];
            }
            const source = relayed ? null : this.#diskSource(rec, node);
            const out = [{ entry: this.#entryOf(rec, node, null), part: 'meta' }];
            if (source)
                out.push({ entry: this.#entryOf(rec, node, source), part: 'content' });
            return out;
        }
        const push = this.#pushes.get(w.key);
        if (!push)
            return null;
        rec = this.#files.get(push.fileId);
        node = rec?.nodes[push.nodeId];
        const source = rec && node && !node.deleted ? this.#diskSource(rec, node) : null;
        if (!rec || !node || !source) {
            // 內容已經不在磁碟上（被新版本取代、檔案刪了）：不必再送
            this.#dropPush(w.key);
            return null;
        }
        // 直送也先送版本：同樣交出去了，之後不能再被本機編輯合併掉（中繼那一則可能還排在佇列裡）
        if (rec.unsent[node.id] === true) {
            rec.unsent[node.id] = false;
            this.#markDirty(rec);
        }
        return [
            { entry: this.#entryOf(rec, node, null), part: 'meta' },
            { entry: this.#entryOf(rec, node, source), part: 'content' },
        ];
    }
    /** 磁碟上的內容就是這個版本時，給一個分段讀的來源（大檔用 `readRange`，沒有就整檔讀一次） */
    #diskSource(rec, node) {
        if (!rec.disk || rec.disk.hash !== node.hash)
            return null;
        const path = rec.disk.path;
        const adapter = this.#adapter;
        if (adapter.readRange)
            return { size: node.size, sha256: node.hash, read: (o, l) => adapter.readRange(path, o, l) };
        let whole;
        return {
            size: node.size,
            sha256: node.hash,
            read: async (o, l) => {
                whole ??= adapter.read(path);
                return (await whole).subarray(o, o + l);
            },
        };
    }
    #entryOf(rec, node, source) {
        const meta = { v: VAULT_WIRE_VERSION, from: this.#deviceId, fileId: rec.id, node, c: source ? 1 : 0 };
        return {
            id: node.id,
            size: source ? node.size : 0,
            sha256: source ? node.hash : EMPTY_SHA256,
            meta: meta,
            read: source ? (o, l) => source.read(o, l) : async () => new Uint8Array(0),
        };
    }
    #p2pDone(device, w, part, result) {
        if (result.status === 'failed')
            return; // 留著，下次再送（中繼補送也會送到）
        this.#meta.lastSyncAt = this.#clock.now();
        this.#metaDirty = true;
        this.#noteSeen(device, this.#clock.now());
        // 直連的送達確認＝對方已經併入這個版本（收方併入才回成功）：記成它已知的版本頭（SDK ADR 0053 §G17），不必等它的摘要
        const fileId = w.type === 'node' ? this.#outbox.get(w.seq)?.fileId : this.#pushes.get(w.key)?.fileId;
        const acked = fileId !== undefined ? this.#files.get(fileId) : undefined;
        if (acked?.nodes[w.nodeId])
            this.#notePeer(acked, device, w.nodeId);
        if (part === 'content') {
            const pushKey = `${device}\n${w.nodeId}`;
            this.#dropPush(pushKey);
            return;
        }
        if (w.type !== 'node')
            return;
        const entry = this.#outbox.get(w.seq);
        if (!entry)
            return;
        entry.got = [...new Set([...(entry.got ?? []), device])];
        const targets = entry.owed ?? entry.to ?? this.#peerDevices();
        if (targets.every((d) => entry.got.includes(d)))
            this.#onSent(w.seq);
        else
            this.#saveOutbox(entry);
    }
    /** 收方：收資料之前先決定要不要（格式、寄件人綁定、大小一致；已經有的內容就不必再傳） */
    #acceptEntry(device, header) {
        const parsed = parseVaultEntryMeta(header.meta, device, header);
        if (!parsed)
            return false;
        if (!parsed.withContent)
            return true;
        // 非大檔（會存成內容、可經中繼轉送）不得超過經中繼的絕對上限。送端依它的中繼宣告決定門檻（SDK ADR 0029），
        // 收端不知道是多少，所以不再要求「大小與 p2p 旗標」和自己的門檻一致
        // 大檔一定比快照層大（任何送端的門檻都不低於快照層上限）：小檔標成大檔一樣拒收
        if (parsed.node.p2p ? header.size <= SNAPSHOT_TIER_MAX_BYTES : header.size > RELAY_FILE_MAX_BYTES_CAP)
            return false;
        const rec = this.#files.get(parsed.fileId);
        // 本機排除的大檔、輕量成員範圍外的大檔：不收內容（送方當作送達；SDK ADR 0047、0058）
        if (rec && parsed.node.p2p && (this.#excludedRecord(rec) || this.#sparseOut(rec)))
            return 'skip';
        const known = rec?.nodes[parsed.node.id];
        if (rec && known) {
            const needed = this.#pending.has(known.id) || (rec.heads.includes(known.id) && rec.disk?.hash !== known.hash && !rec.blobs.includes(known.hash));
            if (!needed)
                return 'skip';
        }
        return true;
    }
    /** 收方：一個版本（已通過 SHA-256 校驗）。與中繼收到的走同一條路；大檔從暫存直接寫進 Vault。 */
    async #receiveEntry(device, entry) {
        const parsed = parseVaultEntryMeta(entry.meta, device, entry);
        if (!parsed)
            throw new Error('版本格式不正確');
        const { fileId, node } = parsed;
        let content;
        let big;
        if (parsed.withContent) {
            // sha256：串流收完時已校驗過（parseVaultEntryMeta 要求 entry.sha256 === node.hash），交給 writeStream 比對（SDK ADR 0057）
            // 暫存區回報了本機路徑：轉接器可以直接改名取用（SDK ADR 0089）
            if (node.p2p)
                big = { size: entry.size, sha256: node.hash, read: (o, l) => entry.readRange(o, l), ...(entry.stagedPath ? { stagedPath: entry.stagedPath } : {}) };
            else
                content = entry.bytes ?? (await entry.read()); // 非大檔 ≤ 檔案塊層（與中繼收到的一樣在記憶體裡）
        }
        const stillPending = await this.#run(async () => {
            // 沒有真的併入就不能回成功（送方會把它當已送達、從佇列移除）
            if (this.#stopped || this.#paused)
                return 'stopped';
            const message = validateVaultMessage({ type: 'node', from: device, fileId, node, ...(content ? { content } : {}) });
            if (!message || message.type !== 'node')
                return 'invalid';
            this.#noteSeen(device, this.#clock.now());
            this.#meta.lastSyncAt = this.#clock.now();
            this.#metaDirty = true;
            if (big)
                this.#staged.set(node.hash, big);
            try {
                await this.#receiveNode(device, fileId, message.node, message.content);
                const rec = this.#files.get(fileId);
                if (big && rec?.nodes[node.id])
                    await this.#converge(rec);
                await this.#drain();
            }
            finally {
                if (big)
                    this.#staged.delete(node.hash);
            }
            // 大檔內容沒有真的寫進磁碟（還在等父版本、寫入失敗、仍是版本頭卻不在磁碟上）：回報失敗，
            // 暫存留著（之後再送時不必重傳），送方的直送也留著
            if (big === undefined)
                return 'ok';
            const rec = this.#files.get(fileId);
            const unapplied = this.#pending.has(node.id) ||
                this.#waiting.has(node.id) ||
                this.#failed.has(fileId) ||
                (rec !== undefined && rec.heads.includes(node.id) && rec.disk?.hash !== node.hash && !this.#skip(node.path));
            return unapplied ? 'pending' : 'ok';
        });
        this.#pump();
        if (stillPending === 'stopped')
            throw new Error('收方暫停中');
        if (stillPending === 'invalid')
            throw new Error('版本內容不正確');
        if (stillPending === 'pending')
            throw new Error('內容暫時用不上');
    }
    // ───────────────────────────── 維護 ─────────────────────────────
    #scheduleTick() {
        if (this.#opts.tickMs <= 0 || this.#stopped)
            return;
        this.#tickTimer = this.#clock.setTimeout(() => {
            void this.tick().finally(() => this.#scheduleTick());
        }, this.#opts.tickMs);
    }
    /** 在線（訂閱著）就等於在同步：別台的刪除會即時收到。沉睡裝置的判斷看這個時間。 */
    #touchSync() {
        this.#meta.lastSyncAt = this.#clock.now();
        this.#metaDirty = true;
    }
    async #maintenance() {
        const now = this.#clock.now();
        if (this.#online && !this.#paused)
            this.#touchSync();
        // 1. 還在等父版本的：再索取一次；等太久就當父版本遺失，直接併入
        const byFile = new Map();
        for (const entry of this.#waiting.values()) {
            const rec = this.#files.get(entry.fileId);
            for (const p of entry.node.parents) {
                if (rec?.nodes[p] || rec?.pruned.includes(p))
                    continue;
                const list = byFile.get(entry.fileId) ?? [];
                list.push([entry.fileId, p]);
                byFile.set(entry.fileId, list);
            }
        }
        this.#want([...byFile.values()].flat());
        // 1½. 經中繼送出、被中繼弄丟的版本：重送給那台（SDK ADR 0106）
        this.#recoverLost();
        const orphanBefore = now - this.#opts.orphanAfterMs;
        for (const fileId of new Set([...this.#waiting.values()].filter((e) => e.since <= orphanBefore).map((e) => e.fileId))) {
            const rec = this.#files.get(fileId) ?? this.#newRecord(fileId);
            await this.#releaseWaiting(rec, orphanBefore);
            await this.#converge(rec);
        }
        // 2. 上次套用失敗的：再試一次
        for (const id of this.#failed)
            this.#toMaterialize.add(id);
        // 輕量成員：範圍外、之前因為還沒送出或還沒確認而留著的本機那一份，再看一次能不能清（SDK ADR 0058）
        if (this.#scope)
            for (const rec of this.#files.values())
                if (rec.disk && this.#sparseOut(rec))
                    this.#toMaterialize.add(rec.id);
        this.#failed.clear();
        // 3. 內容還沒到的：再要一次。只走直連的大檔也要（有直連時）：本來只靠對方收到這台的摘要才排直送，
        //    但這台送摘要時手上有內容的那台可能正好把它排除了（停止追蹤、不直送），之後它重新納入時沒有人再觸發——
        //    帶 `fetch` 的索取讓有內容的那台排直送（v0.49 修正，SDK ADR 0063 §實作）
        this.#want([...this.#pending.values()].filter((p) => p.via === 'relay' || this.#scope !== null || this.#peers !== undefined).map((p) => [p.fileId, p.versionId]), true);
        // 4. 墓碑過了保留期：整筆紀錄清掉（沉睡裝置回來時由 isStaleDevice 擋住復活）
        const tombstones = [];
        for (const rec of this.#files.values()) {
            const head = this.#target(rec);
            if (head?.deleted && !rec.disk && Object.keys(rec.unsent).length === 0 && !this.#hasQueued(rec.id))
                tombstones.push({ path: rec.id, deletedAt: head.at });
        }
        const alive = new Set(gcTombstones(tombstones, now).map((t) => t.path));
        for (const t of tombstones)
            if (!alive.has(t.path))
                this.#dropRecord(t.path);
        // 5. 版本歷史：依保留規則稀疏化、清掉過期的（SDK ADR 0063；只整理到期的檔案）
        await this.#histRetainAll(now, false);
        // 6. 等 P2P 直送的大檔：裝置已經不在名單、或排太久（對方可能永遠不會上線）的清掉；對方之後送摘要時會再排
        if (this.#pushes.size > 0) {
            const devices = new Set(this.#peerDevices());
            for (const [key, push] of this.#pushes)
                if (!devices.has(push.device) || now - push.at > STALE_DEVICE_MS)
                    this.#dropPush(key);
        }
    }
    #hasQueued(fileId) {
        for (const entry of this.#outbox.values())
            if (entry.fileId === fileId)
                return true;
        return false;
    }
    #dropRecord(fileId) {
        const rec = this.#files.get(fileId);
        if (!rec)
            return;
        for (const hash of rec.blobs)
            this.#bg(this.#store.delete(`b:${fileId}:${hash}`));
        if (rec.det)
            this.#setDet(rec, null);
        this.#files.delete(fileId);
        this.#diskGen += 1;
        this.#updateTargetRemoved(fileId);
        this.#dirty.delete(fileId);
        this.#removedRecords.add(fileId);
        // 歸檔照留（墓碑清掉之後也找得回來）；只剩「清掉了哪些」的空紀錄才一起刪（SDK ADR 0063）
        if (this.#histSum.get(fileId)?.c === 0)
            this.#histForget(fileId);
    }
    #updateTargetRemoved(fileId) {
        const old = this.#targetKey.get(fileId);
        if (old === undefined)
            return;
        this.#byTarget.get(old)?.delete(fileId);
        if (this.#byTarget.get(old)?.size === 0)
            this.#byTarget.delete(old);
        this.#targetKey.delete(fileId);
    }
    // ───────────────────────────── 版本歷史（SDK ADR 0063） ─────────────────────────────
    /** 要不要歸檔：沒明說時完整成員開、輕量成員關（裁示 4） */
    #histEnabled() {
        return this.#histOpts.enabled ?? this.#scope === null;
    }
    /** 記下要看要不要歸檔的版本（工作結束時處理；已經歸檔的在那時候跳過） */
    #histNote(fileId, nodeId) {
        if (this.#histSum.get(fileId)?.l?.versionId === nodeId)
            return;
        let set = this.#histNew.get(fileId);
        if (!set)
            this.#histNew.set(fileId, (set = new Set()));
        set.add(nodeId);
    }
    /**
     * 這個版本該不該歸檔（不讀歸檔就能判斷的部分）：排除範圍裡的不歸檔（ADR 0047）；輕量成員只歸檔內容範圍內的版本
     * （刪除＝這台一直在歸檔的檔案被刪了）
     */
    #histEligible(rec, node) {
        if (this.#skip(node.path))
            return false;
        const scope = this.#scope;
        if (!scope)
            return true;
        if (node.deleted)
            return (this.#histSum.get(rec.id)?.c ?? 0) > 0;
        return scope.content(node.path) || this.#pins.has(rec.id) || this.#lru.has(rec.id) || this.#fetching.has(rec.id);
    }
    /**
     * 版本圖裡還沒歸檔的版本排進來（啟動、從關閉改成打開時）；`clearHistory()` 之前的、保留規則清掉的不補。
     * `full`：逐一比對（工作結束時讀歸檔去重）；否則只補比這個檔案歸檔過的最新時間還新的版本（歷史一直開著時，其餘的都已經歸檔了）。
     */
    #histSeed(full) {
        if (!this.#histEnabled())
            return;
        const clearedAt = this.#meta.hx;
        let noted = false;
        for (const rec of this.#files.values()) {
            const s = this.#histSum.get(rec.id);
            const floor = full ? s?.cut : s ? Math.max(s.top, s.cut ?? -Infinity) : undefined;
            const nodes = Object.values(rec.nodes).filter((n) => (clearedAt === undefined || n.at > clearedAt) && (floor === undefined || n.at > floor) && s?.l?.versionId !== n.id && this.#histEligible(rec, n));
            if (nodes.length === 0)
                continue;
            this.#histNoteInOrder(rec, nodes);
            noted = true;
        }
        if (!full)
            return;
        if (noted)
            this.#histSeedPending = true;
        else if (!this.#meta.hl) {
            this.#meta.hl = true;
            this.#metaDirty = true;
        }
    }
    /** 依因果順序記下要歸檔的版本：時間相同時祖先在前（合併版本的時間等於較晚的父版本） */
    #histNoteInOrder(rec, nodes) {
        const depth = new Map();
        const depthOf = (id, guard = 0) => {
            const known = depth.get(id);
            if (known !== undefined)
                return known;
            const node = rec.nodes[id];
            const d = node && guard < 200 ? 1 + Math.max(0, ...node.parents.map((p) => depthOf(p, guard + 1))) : 0;
            depth.set(id, d);
            return d;
        };
        nodes.sort((a, b) => a.at - b.at || depthOf(a.id) - depthOf(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const n of nodes) {
            let set = this.#histNew.get(rec.id);
            if (!set)
                this.#histNew.set(rec.id, (set = new Set()));
            set.add(n.id);
        }
    }
    /** 讀回摘要（v0.50 的格式）；沒有、或是 v0.49 的 `ha:`，遷移一次 */
    async #histLoad() {
        if (this.#meta.hv !== HIST_LAYOUT) {
            await this.#histMigrate();
            return;
        }
        for (const key of await this.#store.keys(HIST_SHARD_PREFIX)) {
            const shard = decodeJson(await this.#store.get(key));
            if (!shard || typeof shard !== 'object')
                continue;
            for (const [fileId, summary] of Object.entries(shard))
                if (validSummary(summary))
                    this.#histSetSummary(fileId, summary, false);
        }
        const own = decodeJson(await this.#store.get('hq'));
        if (own && typeof own === 'object') {
            for (const [hash, size] of Object.entries(own)) {
                if (typeof size !== 'number' || !Number.isFinite(size) || !this.#cpRefs.has(hash))
                    continue;
                this.#cpOwn.set(hash, size);
                this.#histBytes += size;
            }
        }
    }
    /**
     * v0.49 → v0.50（SDK ADR 0063〈待決〉裁示 3）：逐檔讀 `ha:`（格式不變）算出摘要，順便比對版本圖補上還沒歸檔的版本
     * （v0.49 每次啟動都做的事）；`hc:` 改寫成「參照的檔案＋內容」，只有檢查點留著的記進 `hq`，沒有人參照的刪掉。
     * 中途中斷下次會整個重做（`hc:` 兩種格式都讀得懂，改寫是冪等的）；最後才寫摘要與完成的標記（`m.hv`）。
     */
    async #histMigrate() {
        const owners = new Map();
        const now = this.#clock.now();
        const keepMs = this.#histOpts.keepDays * 24 * HOUR_MS;
        const seed = this.#histEnabled();
        const clearedAt = this.#meta.hx;
        let noted = false;
        for (const key of await this.#store.keys('ha:')) {
            const fileId = key.slice(3);
            const raw = decodeJson(await this.#store.get(key));
            if (!raw || typeof raw.fileId !== 'string' || raw.fileId !== fileId) {
                await this.#store.delete(key);
                continue;
            }
            const hf = normalizeHistFile(raw, fileId);
            for (const e of hf.entries) {
                if (!e.content)
                    continue;
                let set = owners.get(e.hash);
                if (!set)
                    owners.set(e.hash, (set = new Set()));
                set.add(fileId);
            }
            this.#histSetSummary(fileId, summarizeHist(hf, undefined, now, keepMs), true);
            const rec = this.#files.get(fileId);
            if (!seed || !rec)
                continue;
            const known = new Set([...hf.entries.map((e) => e.versionId), ...(hf.dropped ?? [])]);
            const nodes = Object.values(rec.nodes).filter((n) => !known.has(n.id) && (clearedAt === undefined || n.at > clearedAt) && (hf.cut === undefined || n.at > hf.cut) && this.#histEligible(rec, n));
            if (nodes.length > 0) {
                this.#histNoteInOrder(rec, nodes);
                noted = true;
            }
        }
        if (seed) {
            for (const rec of this.#files.values()) {
                if (this.#histSum.has(rec.id))
                    continue;
                const nodes = Object.values(rec.nodes).filter((n) => (clearedAt === undefined || n.at > clearedAt) && this.#histEligible(rec, n));
                if (nodes.length === 0)
                    continue;
                this.#histNoteInOrder(rec, nodes);
                noted = true;
            }
            if (noted)
                this.#histSeedPending = true;
            else
                this.#meta.hl = true;
        }
        for (const key of await this.#store.keys('hc:')) {
            const hash = key.slice(3);
            const value = await this.#store.get(key);
            if (!value)
                continue;
            const { content } = decodeHc(value);
            const by = owners.get(hash);
            if (by)
                this.#hcPut(hash, [...by].sort(), content);
            else if (this.#cpRefs.has(hash)) {
                this.#hcPut(hash, [], content);
                this.#cpOwn.set(hash, content.length);
                this.#histBytes += content.length;
                this.#cpOwnDirty = true;
            }
            else
                this.#hcDelete(hash);
        }
        this.#meta.hv = HIST_LAYOUT;
        this.#metaDirty = true;
        this.#histMigrated = true;
        // 摘要、`hq` 與完成的標記馬上寫出（不等第一個工作）：之後的啟動不再遷移
        await this.#histSpill();
    }
    /** 換掉一個檔案的摘要（`next` 是 undefined＝刪掉）：佔用、在等的內容、分片一起更新 */
    #histSetSummary(fileId, next, dirty = true) {
        const prev = this.#histSum.get(fileId);
        if (prev) {
            this.#histBytes -= prev.b;
            for (const hash of prev.w ?? []) {
                const set = this.#histWant.get(hash);
                set?.delete(fileId);
                if (set?.size === 0)
                    this.#histWant.delete(hash);
            }
        }
        const shard = histShard(fileId);
        if (next) {
            this.#histBytes += next.b;
            for (const hash of next.w ?? []) {
                let set = this.#histWant.get(hash);
                if (!set)
                    this.#histWant.set(hash, (set = new Set()));
                set.add(fileId);
            }
            this.#histSum.set(fileId, next);
            let ids = this.#histShards.get(shard);
            if (!ids)
                this.#histShards.set(shard, (ids = new Set()));
            ids.add(fileId);
        }
        else {
            this.#histSum.delete(fileId);
            this.#histShards.get(shard)?.delete(fileId);
        }
        if (dirty)
            this.#histShardDirty.add(shard);
    }
    #histSummarize(hf) {
        this.#histSetSummary(hf.fileId, summarizeHist(hf, this.#histSum.get(hf.fileId), this.#clock.now(), this.#histOpts.keepDays * 24 * HOUR_MS));
    }
    /** 改過一個檔案的歸檔：放回快取（最近用過）、記下要寫回、更新摘要 */
    #histTouch(hf) {
        this.#histCache.delete(hf.fileId);
        this.#histCache.set(hf.fileId, hf);
        this.#histDirty.add(hf.fileId);
        this.#histSummarize(hf);
    }
    /** 整個檔案的歸檔都不要了（`ha:` 與摘要一起刪） */
    #histForget(fileId) {
        this.#histCache.delete(fileId);
        this.#histDirty.add(fileId);
        this.#histSetSummary(fileId, undefined);
    }
    /** 一個檔案完整的歸檔（第一次讀進快取；之後從快取拿）；沒有歸檔回 undefined。要改它就用這個 */
    #histGet(fileId) {
        const cached = this.#histCache.get(fileId);
        if (cached) {
            this.#histCache.delete(fileId);
            this.#histCache.set(fileId, cached);
            return Promise.resolve(cached);
        }
        return this.#histRead(fileId, true);
    }
    /** 只讀：快取裡有就用，沒有就從狀態儲存讀、不放進快取（整庫的串流讀取用，不把快取洗掉） */
    #histPeek(fileId) {
        const cached = this.#histCache.get(fileId);
        return cached ? Promise.resolve(cached) : this.#histRead(fileId, false);
    }
    #histRead(fileId, keep) {
        if (!this.#histSum.has(fileId))
            return Promise.resolve(undefined);
        const gen = this.#histGen;
        let loading = this.#histLoading.get(fileId);
        if (!loading) {
            loading = this.#store
                .get(`ha:${fileId}`)
                .then((bytes) => normalizeHistFile(decodeJson(bytes), fileId))
                .finally(() => {
                if (this.#histLoading.get(fileId) === loading)
                    this.#histLoading.delete(fileId);
            });
            this.#histLoading.set(fileId, loading);
        }
        return loading.then((hf) => {
            if (gen !== this.#histGen || !this.#histSum.has(fileId))
                return undefined;
            // 讀的時候別的地方已經放進快取（而且可能改過了）：以快取的為準
            const cached = this.#histCache.get(fileId);
            if (cached)
                return cached;
            if (keep)
                this.#histCache.set(fileId, hf);
            return hf;
        });
    }
    /** 要寫回的歸檔與摘要分片、只有檢查點留著的內容（`#persist` 與整庫整理時） */
    #histWrites(writes) {
        for (const id of this.#histDirty) {
            if (!this.#histSum.has(id))
                writes.push(this.#store.delete(`ha:${id}`));
            else {
                const hf = this.#histCache.get(id);
                if (hf)
                    writes.push(this.#store.set(`ha:${id}`, encodeJson(hf)));
            }
        }
        this.#histDirty.clear();
        for (const shard of this.#histShardDirty) {
            const ids = this.#histShards.get(shard);
            if (!ids || ids.size === 0) {
                this.#histShards.delete(shard);
                writes.push(this.#store.delete(HIST_SHARD_PREFIX + shard));
                continue;
            }
            const out = {};
            for (const id of ids)
                out[id] = this.#histSum.get(id);
            writes.push(this.#store.set(HIST_SHARD_PREFIX + shard, encodeJson(out)));
        }
        this.#histShardDirty.clear();
        if (this.#cpOwnDirty) {
            this.#cpOwnDirty = false;
            writes.push(this.#store.set('hq', encodeJson(Object.fromEntries(this.#cpOwn))));
        }
    }
    /** 快取超過上限：從最久沒用的清（還沒寫回的不清）。只在沒有人拿著歸檔物件的時候呼叫（工作結束、整庫整理的檔案之間） */
    #histTrim() {
        let entries = 0;
        for (const hf of this.#histCache.values())
            entries += hf.entries.length;
        for (const [id, hf] of this.#histCache) {
            if (this.#histCache.size <= HIST_CACHE_MAX_FILES && entries <= HIST_CACHE_MAX_ENTRIES)
                break;
            if (this.#histDirty.has(id))
                continue;
            this.#histCache.delete(id);
            entries -= hf.entries.length;
        }
    }
    /** 整庫整理的中途：改過的寫出去、清快取（不讓整批留在記憶體） */
    async #histSpill() {
        const writes = [];
        this.#histWrites(writes);
        this.#ledgerWrites(writes);
        if (this.#metaDirty) {
            this.#metaDirty = false;
            writes.push(this.#store.set('m', encodeJson(this.#meta)));
        }
        await Promise.all(writes);
        this.#histTrim();
    }
    // ── 歸檔的內容（`hc:<雜湊>`＝參照的檔案＋內容；以雜湊全域去重） ──
    async #hcRead(hash) {
        const value = await this.#store.get(`hc:${hash}`);
        return value ? decodeHc(value) : null;
    }
    #hcPut(hash, owners, content) {
        this.#store.set(`hc:${hash}`, encodeHc(owners, content)).catch((error) => this.#emit('error', { context: 'history', error }));
    }
    #hcDelete(hash) {
        this.#store.delete(`hc:${hash}`).catch((error) => this.#emit('error', { context: 'history', error }));
    }
    /** 這個檔案的一個版本要參照這份內容：已經有就把檔案加進參照者，沒有就存（有 `bytes` 時）。拿到內容回 true */
    async #histOwn(hf, hash, bytes) {
        if (hf.entries.some((e) => e.content && e.hash === hash))
            return true;
        const stored = await this.#hcRead(hash);
        if (stored) {
            if (!stored.owners.includes(hf.fileId))
                this.#hcPut(hash, [...stored.owners, hf.fileId], stored.content);
            // 原本只有檢查點留著：現在算在這個檔案的佔用
            const own = this.#cpOwn.get(hash);
            if (own !== undefined) {
                this.#cpOwn.delete(hash);
                this.#histBytes -= own;
                this.#cpOwnDirty = true;
            }
            return true;
        }
        if (!bytes)
            return false;
        this.#hcPut(hash, [hf.fileId], bytes);
        return true;
    }
    /** 這個檔案已經沒有版本參照這份內容：從參照者拿掉；沒有任何檔案參照時，檢查點還留著就只算檢查點的，否則刪掉 */
    async #histDisown(hf, hash) {
        if (hf.entries.some((e) => e.content && e.hash === hash))
            return;
        const stored = await this.#hcRead(hash);
        if (!stored)
            return;
        const owners = stored.owners.filter((o) => o !== hf.fileId);
        if (owners.length > 0) {
            if (owners.length !== stored.owners.length)
                this.#hcPut(hash, owners, stored.content);
            return;
        }
        if (!this.#cpRefs.has(hash)) {
            this.#hcDelete(hash);
            return;
        }
        if (stored.owners.length > 0)
            this.#hcPut(hash, [], stored.content);
        if (!this.#cpOwn.has(hash)) {
            this.#cpOwn.set(hash, stored.content.length);
            this.#histBytes += stored.content.length;
            this.#cpOwnDirty = true;
        }
    }
    /** 處理這次工作加入的版本，並收下晚到的內容；然後依保留規則整理動到的檔案 */
    async #histFlush() {
        const touched = new Set();
        const now = this.#clock.now();
        let bulk = false;
        if (this.#histNew.size > 0) {
            const batch = [...this.#histNew];
            this.#histNew.clear();
            // 大批（升級、重新打開歷史）：逐檔歸檔、整理，定期寫出，不讓整批留在記憶體
            bulk = batch.length > HIST_SPILL_EVERY;
            if (this.#histEnabled()) {
                let done = 0;
                for (const [fileId, ids] of batch) {
                    const rec = this.#files.get(fileId);
                    if (!rec)
                        continue;
                    let archived = false;
                    for (const id of ids) {
                        const node = rec.nodes[id];
                        if (node && (await this.#histArchive(rec, node)))
                            archived = true;
                    }
                    if (!bulk) {
                        if (archived)
                            touched.add(fileId);
                        continue;
                    }
                    if (archived)
                        await this.#histThin(fileId, now);
                    // 讀過（去重時）的也算：不讓整批的歸檔都留在快取裡
                    if (++done % HIST_SPILL_EVERY === 0)
                        await this.#histSpill();
                }
            }
        }
        if (this.#histWant.size > 0 && this.#taskCache.size > 0) {
            for (const [hash, bytes] of this.#taskCache) {
                if (this.#histWant.has(hash) && sha256Hex(bytes) === hash)
                    for (const fileId of await this.#histAttach(hash, bytes))
                        touched.add(fileId);
            }
        }
        if (this.#histSeedPending && this.#histEnabled()) {
            this.#histSeedPending = false;
            this.#meta.hl = true;
            this.#metaDirty = true;
        }
        if (touched.size === 0 && !bulk)
            return;
        for (const fileId of touched)
            await this.#histThin(fileId, now);
        await this.#histBudget();
    }
    /** 內容晚到：歸檔裡在等這份內容的版本收下它。回傳動到的檔案 */
    async #histAttach(hash, bytes) {
        const files = this.#histWant.get(hash);
        if (!files)
            return [];
        const touched = [];
        for (const fileId of [...files]) {
            const hf = await this.#histGet(fileId);
            let changed = false;
            for (const e of hf?.entries ?? []) {
                if (e.hash !== hash || e.content || e.deleted || !e.text)
                    continue;
                e.content = await this.#histOwn(hf, hash, bytes);
                changed = true;
            }
            if (changed) {
                this.#histTouch(hf);
                touched.push(fileId);
            }
            else
                files.delete(fileId);
        }
        if (files.size === 0)
            this.#histWant.delete(hash);
        return touched;
    }
    /** 歸檔一個版本（已經歸檔、清掉過的跳過）；歸檔了回 true */
    async #histArchive(rec, node) {
        if (!this.#histEligible(rec, node))
            return false;
        let hf = await this.#histGet(rec.id);
        if (hf && (hf.entries.some((e) => e.versionId === node.id) || hf.dropped?.includes(node.id)))
            return false;
        const textual = node.text && !node.deleted && !node.p2p;
        let bytes;
        if (textual && !hf?.entries.some((e) => e.content && e.hash === node.hash) && !this.#cpRefs.has(node.hash)) {
            bytes = this.#taskCache.get(node.hash) ?? (await this.#getContent(rec, node.hash));
            if (bytes && sha256Hex(bytes) !== node.hash)
                bytes = undefined;
            // 輕量成員：內容不在這台（也不在歸檔）就不歸檔（打開歷史時才補）
            if (!bytes && this.#scope && !(await this.#hcRead(node.hash)))
                return false;
        }
        if (!hf)
            hf = { fileId: rec.id, entries: [] };
        this.#meta.hs = (this.#meta.hs ?? 0) + 1;
        this.#metaDirty = true;
        const entry = {
            versionId: node.id,
            path: node.path,
            at: node.at,
            n: this.#meta.hs,
            device: node.device,
            label: node.label,
            hash: node.hash,
            size: node.size,
            deleted: node.deleted,
            text: node.text,
            content: false,
        };
        if (node.deleted && (isFoldId(node.id) || node.id === deterministicId('dedupe', rec.id, ...[...node.parents].sort())))
            entry.absorbed = true;
        if (textual)
            entry.content = await this.#histOwn(hf, node.hash, bytes);
        if (node.parents.length === 0 && hf.entries.length === 0 && hf.cut === undefined)
            hf.born = node.at;
        const last = hf.entries[hf.entries.length - 1];
        hf.entries.push(entry);
        if (last && compareHistory(last, entry) > 0)
            hf.entries.sort(compareHistory);
        this.#histTouch(hf);
        return true;
    }
    #histOffset() {
        return this.#histOpts.dayBoundary === 'utc' ? () => 0 : localOffset;
    }
    /** 從歸檔清掉一些版本（內容沒人參照就刪），記下清掉的 id（啟動時不再從版本圖補回來） */
    async #histDrop(hf, drop) {
        if (drop.length === 0)
            return;
        const gone = new Set(drop);
        hf.entries = hf.entries.filter((e) => !gone.has(e));
        const dropped = hf.dropped ?? [];
        const hashes = new Set();
        for (const e of drop) {
            if (e.content)
                hashes.add(e.hash);
            dropped.push(e.versionId);
        }
        hf.dropped = dropped.slice(-MAX_HIST_DROPPED);
        this.#histTouch(hf);
        for (const hash of hashes)
            await this.#histDisown(hf, hash);
        // 整個檔案都清掉了：版本圖也不認得它時連紀錄一起刪（認得時留著 `dropped`，啟動時不補回來）
        if (hf.entries.length === 0 && !this.#files.has(hf.fileId))
            this.#histForget(hf.fileId);
    }
    async #histThin(fileId, now) {
        const hf = await this.#histGet(fileId);
        if (!hf || hf.entries.length === 0)
            return;
        const { drop, cut } = thinHistory(hf.entries, now, { keepDays: this.#histOpts.keepDays, maxVersions: this.#histOpts.maxVersionsPerFile, offset: this.#histOffset() });
        if (cut !== undefined)
            hf.cut = Math.max(hf.cut ?? cut, cut);
        if (drop.length > 0)
            await this.#histDrop(hf, drop);
        // 沒有變化也要更新「下一次可能有變化的時間」
        else
            this.#histSummarize(hf);
    }
    /**
     * 總容量（命名檢查點釘住的不算）超過上限：先從最舊的版本清（每個檔案至少留一版；檢查點留著的內容清了版本也省不下，不清），
     * 還是超過就清最舊的自動／「還原之前」的檢查點（最新的檢查點不清）。逐檔進行：以摘要的最舊時間排優先順序，用到才讀那個檔案。
     */
    async #histBudget() {
        const limit = this.#histOpts.maxBytes;
        const over = () => this.#histBytes - this.#cpPinnedBytes() > limit;
        for (let guard = 0; guard < 10_000 && over(); guard += 1) {
            await this.#histBudgetVersions(over);
            if (!over())
                return;
            const victim = this.#cps.slice(0, -1).find((c) => c.kind !== 'named');
            if (!victim)
                return;
            this.#cpDelete(victim, 'evicted');
        }
    }
    /** 從所有檔案裡最舊的、可以清的版本開始清，直到不超過（小根堆：鍵是那個檔案下一個可清版本的時間下限） */
    async #histBudgetVersions(over) {
        const less = (a, b) => a.at - b.at || a.n - b.n || (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0);
        const heap = [];
        const push = (item) => {
            heap.push(item);
            for (let i = heap.length - 1; i > 0;) {
                const parent = (i - 1) >> 1;
                if (less(heap[parent], heap[i]) <= 0)
                    break;
                [heap[parent], heap[i]] = [heap[i], heap[parent]];
                i = parent;
            }
        };
        const pop = () => {
            const top = heap[0];
            const last = heap.pop();
            if (heap.length > 0 && last) {
                heap[0] = last;
                for (let i = 0;;) {
                    const l = 2 * i + 1;
                    const r = l + 1;
                    let m = i;
                    if (l < heap.length && less(heap[l], heap[m]) < 0)
                        m = l;
                    if (r < heap.length && less(heap[r], heap[m]) < 0)
                        m = r;
                    if (m === i)
                        break;
                    [heap[m], heap[i]] = [heap[i], heap[m]];
                    i = m;
                }
            }
            return top;
        };
        for (const [fileId, s] of this.#histSum)
            if (s.c >= 2 && s.b > 0)
                push({ at: s.o, n: -Infinity, fileId });
        let steps = 0;
        while (over()) {
            const item = pop();
            if (!item)
                return;
            if (++steps % HIST_SPILL_EVERY === 0)
                await this.#histSpill();
            const hf = await this.#histGet(item.fileId);
            if (!hf || hf.entries.length < 2)
                continue;
            const candidate = hf.entries.slice(0, -1).find((e) => e.content && !this.#cpRefs.has(e.hash));
            if (!candidate)
                continue;
            if (candidate.at > item.at || (candidate.at === item.at && candidate.n > item.n)) {
                push({ at: candidate.at, n: candidate.n, fileId: item.fileId });
                continue;
            }
            hf.cut = Math.max(hf.cut ?? candidate.at, candidate.at);
            await this.#histDrop(hf, [candidate]);
            if (hf.entries.length >= 2)
                push({ at: candidate.at, n: candidate.n, fileId: item.fileId });
        }
    }
    /** 依保留規則整理（`all`：每個檔案；否則只整理到期的與超過版本數上限的），再看檢查點與總容量 */
    async #histRetainAll(now, all) {
        let done = 0;
        for (const [fileId, s] of [...this.#histSum]) {
            if (s.c === 0)
                continue;
            if (!all && !(s.t !== undefined && s.t <= now) && s.c <= this.#histOpts.maxVersionsPerFile)
                continue;
            await this.#histThin(fileId, now);
            if (++done % HIST_SPILL_EVERY === 0)
                await this.#histSpill();
        }
        this.#cpRetain(now);
        await this.#histBudget();
    }
    /** 找一個歸檔版本：給了 fileId 直接讀那個檔案；只有版本 id 時找快取、摘要、版本圖，最後才逐檔找 */
    async #histLocate(version) {
        const find = async (fileId, versionId) => {
            const e = (await this.#histGet(fileId))?.entries.find((x) => x.versionId === versionId);
            return e ? { fileId, entry: e } : undefined;
        };
        if (typeof version !== 'string')
            return find(version.fileId, version.versionId);
        for (const [fileId, hf] of this.#histCache) {
            const e = hf.entries.find((x) => x.versionId === version);
            if (e)
                return { fileId, entry: e };
        }
        for (const [fileId, s] of this.#histSum)
            if (s.l?.versionId === version || s.lv?.versionId === version)
                return find(fileId, version);
        for (const rec of this.#files.values()) {
            if (rec.nodes[version] === undefined || !this.#histSum.has(rec.id))
                continue;
            const found = await find(rec.id, version);
            if (found)
                return found;
        }
        for (const fileId of [...this.#histSum.keys()]) {
            if (this.#histCache.has(fileId))
                continue;
            const e = (await this.#histPeek(fileId))?.entries.find((x) => x.versionId === version);
            if (e)
                return find(fileId, version);
        }
        return undefined;
    }
    /** 現在可以還原：歸檔裡有內容，或內容和這個檔案現在的相同 */
    #histRestorable(fileId, e) {
        return !e.deleted && (e.content || this.#files.get(fileId)?.disk?.hash === e.hash);
    }
    #histPublic(fileId, e) {
        return {
            fileId,
            versionId: e.versionId,
            path: e.path,
            at: e.at,
            device: e.device,
            label: e.label,
            hash: e.hash,
            size: e.size,
            deleted: e.deleted,
            text: e.text,
            content: e.content,
            restorable: this.#histRestorable(fileId, e),
            ...(e.absorbed ? { absorbed: true } : {}),
        };
    }
    /** `history(target)` 的檔案：fileId；或現在／最後在這個路徑上的檔案；沒有就找曾經在這個路徑上的（摘要的 `l`、`ps`） */
    #histResolve(target) {
        if (typeof target !== 'string')
            return this.#histSum.has(target.fileId) ? [target.fileId] : [];
        if (this.#histSum.has(target))
            return [target];
        const key = this.#key(target);
        const out = new Set();
        const live = this.#byDisk.get(target) ?? this.#diskOccupant(target, '');
        if (live !== undefined && this.#histSum.has(live))
            out.add(live);
        for (const [fileId, s] of this.#histSum) {
            if (!s.l || this.#key(s.l.path) !== key)
                continue;
            // 最後在這個路徑上、但現在（版本圖）已經搬走的不算
            const rec = this.#files.get(fileId);
            if (rec?.disk && this.#key(rec.disk.path) !== key)
                continue;
            out.add(fileId);
        }
        if (out.size === 0) {
            for (const [fileId, s] of this.#histSum) {
                if (s.l && (this.#key(s.l.path) === key || s.ps?.some((p) => this.#key(p) === key)))
                    out.add(fileId);
            }
        }
        return [...out];
    }
    /** 一個檔案現在的狀態（還原預覽用） */
    #histCurrent(fileId) {
        const rec = this.#files.get(fileId);
        if (!rec)
            return { state: 'gone' };
        if (rec.disk) {
            const node = rec.nodes[rec.disk.base];
            return { state: 'live', path: rec.disk.path, hash: rec.disk.hash, versionId: rec.disk.base, size: rec.disk.size, ...(node ? { text: node.text } : {}) };
        }
        const live = rec.heads.map((h) => rec.nodes[h]).filter((n) => n !== undefined && !n.deleted);
        if (live.length === 0)
            return { state: 'gone' };
        const path = rec.det?.path ?? live[live.length - 1].path;
        if (rec.det || live.every((n) => this.#skip(n.path)))
            return { state: 'not-local', path, reason: 'excluded' };
        return { state: 'not-local', path, reason: 'not-local' };
    }
    /** 這份內容（這個檔案的）在歸檔裡：檢查點留著、摘要的最新一版、快取裡的版本，最後看 `hc:` 有沒有 */
    async #histHas(fileId, hash) {
        if (this.#cpRefs.has(hash))
            return true;
        const s = this.#histSum.get(fileId);
        if ((s?.l?.hash === hash && s.l.content) || (s?.lv?.hash === hash && s.lv.content))
            return true;
        if (this.#histCache.get(fileId)?.entries.some((e) => e.content && e.hash === hash))
            return true;
        return (await this.#hcRead(hash)) !== null;
    }
    /**
     * 要覆寫或刪掉的現有內容找得回來（在歸檔裡）：覆寫前先把這次工作剛收進來的版本歸檔。
     * 磁碟上的內容和索引記的不同（使用者剛改了還沒通知）時，呼叫端先收成版本再問。
     */
    async #histKeeps(rec) {
        const disk = rec.disk;
        if (!disk)
            return true;
        if (this.#histNew.size > 0)
            await this.#histFlush();
        return this.#histHas(rec.id, disk.hash);
    }
    /** 先把磁碟上還沒通知的修改收成版本（大小或時間不同才讀）；檔案不見了就收成刪除。回傳檔案還在不在磁碟上 */
    async #absorbLocal(rec) {
        const disk = rec.disk;
        if (!disk)
            return false;
        const st = await this.#adapter.stat(disk.path);
        if (!st) {
            await this.#ingestPath(disk.path);
            return false;
        }
        if (st.size !== disk.size || st.mtime !== disk.mtime) {
            await this.#ingestExisting(rec, st);
            await this.#converge(rec);
        }
        return rec.disk !== null;
    }
    /**
     * 把內容寫到 `path`，當成本機修改收成版本（`restore` 與 `restoreVault` 的復原共用）。`owner`：版本所屬的檔案
     * （`path` 上沒有同步中的檔案、而它不在磁碟上時，讓它在 `path` 復活）。一直寫不進去回 'changed'。
     */
    async #restoreWrite(path, bytes, hash, owner, versionId) {
        if (!isSafeVaultPath(path) || this.#skip(path))
            return new VaultScopeError('excluded', path);
        for (let attempt = 0; attempt < MAX_RESTORE_ATTEMPTS; attempt += 1) {
            // 磁碟上這個路徑還沒通知的變更先收進來（不遺失）
            const id = this.#byDisk.get(path);
            const tracked = id !== undefined ? this.#files.get(id) : undefined;
            if (tracked?.disk)
                await this.#absorbLocal(tracked);
            else if (await this.#adapter.stat(path)) {
                this.#blockedNow = new Map();
                try {
                    await this.#ingestPath(path);
                    const blocked = this.#blockedNow.get(path);
                    if (blocked)
                        return blocked;
                }
                finally {
                    this.#blockedNow = null;
                }
            }
            const rid = this.#byDisk.get(path);
            const rec = rid !== undefined ? this.#files.get(rid) : undefined;
            if (rec?.disk) {
                if (rec.disk.hash === hash)
                    return { fileId: rec.id, path, versionId: rec.disk.base, outcome: 'unchanged' };
                if (!(await this.#histKeeps(rec)))
                    return new VaultHistoryError('content-missing', versionId);
                if (!(await this.#apply({ type: 'write', path, bytes, expect: sameHash(rec.disk.hash), fileId: rec.id })))
                    continue;
                // 和 notifyLocalChange 一樣從磁碟讀回來收成版本（應用經 applyRemote 寫入時內容以磁碟上的為準）
                const st = await this.#adapter.stat(path);
                if (!st)
                    continue;
                await this.#ingestExisting(rec, st);
                await this.#converge(rec);
                return { fileId: rec.id, path, versionId: rec.disk?.base ?? rec.heads[rec.heads.length - 1] ?? '', outcome: 'restored' };
            }
            if (this.#diskOccupant(path, '') !== undefined || (await this.#adapter.stat(path)))
                continue;
            if (this.#scope) {
                const block = this.#sparseBlock(path);
                if (block)
                    return new VaultScopeError(block, path);
            }
            const revive = owner && !owner.disk && !owner.det && this.#files.get(owner.id) === owner ? owner : undefined;
            const fileId = revive?.id ?? this.#randomId();
            if (!(await this.#apply({ type: 'write', path, bytes, expect: absent, fileId })))
                continue;
            const st = await this.#adapter.stat(path);
            if (!st)
                continue;
            const local = await this.#readLocal(path, st.size);
            this.#clearDetAt(path);
            const target = revive ?? this.#newRecord(fileId);
            await this.#localVersion(target, { path, deleted: false, bytes: local.bytes, hash: local.hash, stat: st });
            await this.#converge(target);
            return { fileId: target.id, path, versionId: target.disk?.base ?? target.heads[target.heads.length - 1] ?? '', outcome: 'restored' };
        }
        return 'changed';
    }
    /** 執行還原預覽（佇列內） */
    async #restoreVault(plan, options) {
        const restored = [];
        const removed = [];
        const skipped = [...plan.unrestorable];
        const fail = (item, reason, error) => skipped.push({ fileId: item.fileId, path: item.path, reason, versionId: item.versionId, ...(error !== undefined ? { error } : {}) });
        const failWith = (item, error) => {
            if (error instanceof VaultScopeError)
                fail(item, error.code === 'excluded' ? 'excluded' : 'scope', error);
            else if (error instanceof VaultHistoryError)
                fail(item, error.code === 'binary' ? 'binary' : 'content-missing', error);
            else
                fail(item, 'error', error);
        };
        /** 這個檔案的內容不在這台（輕量成員範圍外、或還沒到） */
        const notLocal = (item, rec) => {
            if (rec && this.#scope && this.#sparseOut(rec))
                fail(item, 'scope', new VaultScopeError('base-missing', item.path));
            else
                fail(item, 'changed');
        };
        // 1. 刪掉 T 之後才建立的（先騰出路徑）
        for (const item of plan.remove) {
            try {
                const rec = this.#files.get(item.fileId);
                if (!rec?.disk || !(await this.#absorbLocal(rec))) {
                    fail(item, 'changed');
                    continue;
                }
                // 預覽之後被改了：不刪較新的內容
                if (rec.disk.hash !== item.hash) {
                    fail(item, 'changed');
                    continue;
                }
                const path = rec.disk.path;
                if (item.irreversible) {
                    // 歸檔沒有內容（二進位檔）：應用在刪之前備份（v0.50 裁示 1 乙）；沒備份成功就不刪
                    if (options.beforeIrreversible) {
                        let ok;
                        try {
                            ok = await options.beforeIrreversible({ ...item, path });
                        }
                        catch (error) {
                            fail(item, 'backup-failed', error);
                            continue;
                        }
                        if (ok === false) {
                            fail(item, 'backup-failed');
                            continue;
                        }
                    }
                }
                else if (!(await this.#histKeeps(rec))) {
                    fail(item, 'content-missing');
                    continue;
                }
                if (!(await this.#apply({ type: 'remove', path, expect: sameHash(rec.disk.hash), fileId: rec.id }))) {
                    await this.#absorbLocal(rec);
                    fail(item, 'changed');
                    continue;
                }
                await this.#ingestPath(path);
                removed.push({ ...item, path });
            }
            catch (error) {
                failWith(item, error);
            }
        }
        const moves = [];
        for (const item of plan.revert) {
            try {
                const rec = this.#files.get(item.fileId);
                if (!rec?.disk) {
                    notLocal(item, rec);
                    continue;
                }
                if (!(await this.#absorbLocal(rec))) {
                    fail(item, 'changed');
                    continue;
                }
                if (this.#skip(item.path)) {
                    fail(item, 'excluded');
                    continue;
                }
                const move = { item, rec };
                if (rec.disk.hash !== item.hash) {
                    const bytes = await this.#contentOf(item.fileId, item.hash);
                    if (!bytes) {
                        fail(item, item.text ? 'content-missing' : 'binary');
                        continue;
                    }
                    if (!(await this.#histKeeps(rec))) {
                        fail(item, 'content-missing');
                        continue;
                    }
                    move.bytes = bytes;
                }
                moves.push(move);
            }
            catch (error) {
                failWith(item, error);
            }
        }
        const done = new Set();
        let pending = moves.filter((m) => m.rec.disk && m.rec.disk.path !== m.item.path);
        const pendingOf = (fileId) => pending.find((m) => m.rec.id === fileId);
        for (let guard = 0; pending.length > 0 && guard < moves.length * 4 + 8; guard += 1) {
            let progress = false;
            for (const m of [...pending]) {
                const disk = m.rec.disk;
                if (!disk) {
                    fail(m.item, 'changed');
                    pending = pending.filter((x) => x !== m);
                    progress = true;
                    continue;
                }
                const target = m.item.path;
                const occupant = this.#diskOccupant(target, m.rec.id);
                if (occupant !== undefined && pendingOf(occupant))
                    continue; // 等它先搬走
                const caseOnly = this.#key(disk.path) === this.#key(target);
                if (occupant !== undefined || (!caseOnly && (await this.#adapter.stat(target)))) {
                    fail(m.item, 'occupied');
                    pending = pending.filter((x) => x !== m);
                    progress = true;
                    continue;
                }
                pending = pending.filter((x) => x !== m);
                progress = true;
                try {
                    const from = disk.path;
                    if (!(await this.#apply({ type: 'rename', from, to: target, expect: sameHash(disk.hash), fileId: m.rec.id }))) {
                        await this.#absorbLocal(m.rec);
                        fail(m.item, 'changed');
                        continue;
                    }
                    await this.#ingestRename(from, target);
                    if (!m.rec.disk || m.rec.disk.path !== target) {
                        fail(m.item, 'changed');
                        continue;
                    }
                    if (!m.bytes)
                        done.add(m);
                }
                catch (error) {
                    failWith(m.item, error);
                }
            }
            if (progress || pending.length === 0)
                continue;
            // 成環（例如互換名字）：把擋路的那一個先改名到一個空著的路徑（像使用者自己會做的：一個一般的改名版本，照順序送出，
            // 別台不會看到兩個檔案同時要同一個路徑），下一輪再搬到目的地
            const first = pending[0];
            const blocker = pendingOf(this.#diskOccupant(first.item.path, first.rec.id));
            const bd = blocker.rec.disk;
            let temp = '';
            for (let n = 2;; n += 1) {
                temp = this.#freePath(freePathCandidate(bd.path, n), blocker.rec.id);
                if (!this.#skip(temp) && !(await this.#adapter.stat(temp)))
                    break;
            }
            if (!(await this.#apply({ type: 'rename', from: bd.path, to: temp, expect: sameHash(bd.hash), fileId: blocker.rec.id }))) {
                await this.#absorbLocal(blocker.rec);
                fail(blocker.item, 'changed');
                pending = pending.filter((x) => x !== blocker);
                continue;
            }
            await this.#ingestRename(bd.path, temp);
            // 這一版要真的送出去（不讓下一次本機修改把它合併掉），別台才會先看到路徑空出來
            const tempVersion = blocker.rec.disk?.base;
            if (tempVersion !== undefined && blocker.rec.unsent[tempVersion] === true) {
                blocker.rec.unsent[tempVersion] = false;
                this.#markDirty(blocker.rec);
            }
        }
        for (const m of pending)
            fail(m.item, 'changed');
        for (const m of moves) {
            if (done.has(m) || !m.rec.disk)
                continue;
            if (m.rec.disk.path !== m.item.path)
                continue; // 搬移失敗（已回報）
            if (!m.bytes) {
                done.add(m);
                continue;
            }
            try {
                const result = await this.#restoreWrite(m.item.path, m.bytes, m.item.hash, m.rec, m.item.versionId);
                if (result === 'changed')
                    fail(m.item, 'changed');
                else if (result instanceof Error)
                    failWith(m.item, result);
                else
                    done.add(m);
            }
            catch (error) {
                failWith(m.item, error);
            }
        }
        for (const m of moves)
            if (done.has(m))
                restored.push(m.item);
        // 3. 復原已刪除的檔案
        for (const item of plan.undelete) {
            try {
                const rec = this.#files.get(item.fileId);
                if (rec?.disk) {
                    if (rec.disk.path === item.path && rec.disk.hash === item.hash)
                        restored.push(item);
                    else
                        fail(item, 'changed');
                    continue;
                }
                if (this.#skip(item.path)) {
                    fail(item, 'excluded');
                    continue;
                }
                if (this.#diskOccupant(item.path, '') !== undefined || (await this.#adapter.stat(item.path))) {
                    fail(item, 'occupied');
                    continue;
                }
                const bytes = await this.#contentOf(item.fileId, item.hash);
                if (!bytes) {
                    fail(item, item.text ? 'content-missing' : 'binary');
                    continue;
                }
                const result = await this.#restoreWrite(item.path, bytes, item.hash, rec, item.versionId);
                if (result === 'changed')
                    fail(item, 'changed');
                else if (result instanceof Error)
                    failWith(item, result);
                else
                    restored.push(item);
            }
            catch (error) {
                failWith(item, error);
            }
        }
        const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.fileId < b.fileId ? -1 : 1);
        return { restored: restored.sort(byPath), removed: removed.sort(byPath), skipped };
    }
    // ───────────────────────────── 檢查點與操作紀錄（SDK ADR 0063 補充） ─────────────────────────────
    #cpById(id) {
        return this.#cps.find((c) => c.id === id);
    }
    #cpPublic(c) {
        return { id: c.id, at: c.at, kind: c.kind, ...(c.name !== undefined ? { name: c.name } : {}), files: c.files };
    }
    /** 名稱檢查：去掉頭尾空白、1–100 字、和其他命名檢查點不同名 */
    #cpName(name, self) {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (trimmed.length === 0 || trimmed.length > 100)
            return new VaultHistoryError('checkpoint-name', self ?? '');
        if (this.#cps.some((c) => c.id !== self && c.kind === 'named' && c.name === trimmed))
            return new VaultHistoryError('checkpoint-name', self ?? '');
        return trimmed;
    }
    /** 解出一個檢查點的清單（沿著差異的基準往回找到完整的那一個，再依序套上）；最近一次的結果快取著。回傳的清單不要改 */
    #cpMaterialize(cp) {
        if (this.#cpCache?.id === cp.id)
            return this.#cpCache.manifest;
        const chain = [];
        for (let cur = cp; cur && chain.length < 10_000;) {
            chain.push(cur);
            if (cur.base === undefined || cur.m.d === undefined)
                break;
            cur = this.#cpById(cur.base);
        }
        let manifest = new Map();
        for (const r of chain.reverse())
            manifest = decodeManifest(r.m, manifest);
        this.#cpCache = { id: cp.id, manifest };
        return manifest;
    }
    /** 差異鏈的長度（到完整的那一個為止） */
    #cpDepth(cp) {
        let depth = 0;
        for (let cur = cp; cur && cur.base !== undefined && cur.m.d !== undefined && depth < 10_000; depth += 1)
            cur = this.#cpById(cur.base);
        return depth;
    }
    /**
     * 現在整個 Vault 的清單：磁碟上同步中的每個檔案（磁碟上的版本）；還在、但內容不在這台的（輕量成員範圍外、內容還沒到）也列、
     * 標成不在本機。被排除的、停止追蹤的、刪除的不列。
     */
    #cpCurrent() {
        const out = new Map();
        for (const rec of this.#files.values()) {
            if (rec.disk) {
                if (this.#skip(rec.disk.path))
                    continue;
                const node = rec.nodes[rec.disk.base];
                out.set(rec.id, { path: rec.disk.path, versionId: rec.disk.base, hash: rec.disk.hash, size: rec.disk.size, text: node?.text ?? false, local: true });
                continue;
            }
            if (rec.det)
                continue;
            const head = this.#latestHead(rec);
            if (!head || head.deleted || this.#skip(head.path))
                continue;
            out.set(rec.id, { path: head.path, versionId: head.id, hash: head.hash, size: head.size, text: head.text, local: false });
        }
        return out;
    }
    /** 這個清單留著的內容（文字檔、在本機的；雜湊去重） */
    #cpHashes(manifest) {
        const out = new Map();
        for (const f of manifest.values())
            if (f.text && f.local)
                out.set(f.hash, f.size);
        return out;
    }
    /**
     * 檢查點留著（+1）或放開（-1）這些內容。沒有任何檢查點留著、而且只有檢查點留著（`#cpOwn`，沒有檔案的歸檔參照）的內容一起刪掉；
     * 有檔案參照的照留（由那些檔案的歸檔管）。
     */
    #cpHold(manifest, sign) {
        for (const [hash, size] of this.#cpHashes(manifest)) {
            const ref = this.#cpRefs.get(hash);
            if (sign > 0) {
                if (ref)
                    ref.n += 1;
                else
                    this.#cpRefs.set(hash, { n: 1, size });
                continue;
            }
            if (!ref)
                continue;
            ref.n -= 1;
            if (ref.n > 0)
                continue;
            this.#cpRefs.delete(hash);
            const own = this.#cpOwn.get(hash);
            if (own === undefined)
                continue;
            this.#cpOwn.delete(hash);
            this.#histBytes -= own;
            this.#cpOwnDirty = true;
            this.#hcDelete(hash);
        }
    }
    /** 命名檢查點釘住（+1）或放開（-1）這些內容（不受保留天數與 `maxBytes` 限制） */
    #cpPin(manifest, sign) {
        for (const hash of this.#cpHashes(manifest).keys()) {
            const n = (this.#cpNamed.get(hash) ?? 0) + sign;
            if (n > 0)
                this.#cpNamed.set(hash, n);
            else
                this.#cpNamed.delete(hash);
        }
    }
    /** 命名檢查點釘住的內容（位元組） */
    #cpPinnedBytes() {
        let bytes = 0;
        for (const hash of this.#cpNamed.keys())
            bytes += this.#cpRefs.get(hash)?.size ?? 0;
        return bytes;
    }
    /** 建立一個檢查點（佇列內）：文字檔的內容確定存進歸檔，拿不到內容的標成不在本機（不能從這個檢查點還原） */
    async #cpCreate(kind, name) {
        const manifest = this.#cpCurrent();
        const stored = new Set();
        for (const [fileId, f] of manifest) {
            if (!f.text || !f.local || stored.has(f.hash) || this.#cpRefs.has(f.hash))
                continue;
            // 這個檔案的歸檔最新一版就是它（平常的情形）：內容已經在
            const s = this.#histSum.get(fileId);
            if (s?.l?.hash === f.hash && s.l.content)
                continue;
            const existing = await this.#hcRead(f.hash);
            if (existing) {
                // 沒有任何檔案參照（例如寫到一半重開留下的）：之後算在檢查點
                if (existing.owners.length === 0 && !this.#cpOwn.has(f.hash)) {
                    this.#cpOwn.set(f.hash, existing.content.length);
                    this.#histBytes += existing.content.length;
                    this.#cpOwnDirty = true;
                }
                stored.add(f.hash);
                continue;
            }
            const rec = this.#files.get(fileId);
            let bytes = rec ? (this.#taskCache.get(f.hash) ?? (await this.#getContent(rec, f.hash))) : undefined;
            if (bytes && sha256Hex(bytes) !== f.hash)
                bytes = undefined;
            if (bytes) {
                // 先記成只有檢查點留著（下面 `#cpHold` 加上這個檢查點的參照）；歸檔裡在等這份內容的版本一起收下（就改算在那些檔案）
                this.#hcPut(f.hash, [], bytes);
                this.#cpOwn.set(f.hash, bytes.length);
                this.#histBytes += bytes.length;
                this.#cpOwnDirty = true;
                stored.add(f.hash);
                await this.#histAttach(f.hash, bytes);
            }
            else
                manifest.set(fileId, { ...f, local: false });
        }
        const latest = this.#cps[this.#cps.length - 1];
        let m;
        let base;
        if (latest && this.#cpDepth(latest) < MAX_CHECKPOINT_CHAIN) {
            m = diffManifest(this.#cpMaterialize(latest), manifest);
            base = latest.id;
        }
        else
            m = encodeManifest(manifest);
        this.#meta.cs = (this.#meta.cs ?? 0) + 1;
        this.#metaDirty = true;
        const cp = {
            id: `c${this.#meta.cs}`,
            n: this.#meta.cs,
            at: Math.max(this.#clock.now(), this.#meta.hlc),
            kind,
            ...(name !== undefined ? { name } : {}),
            files: manifest.size,
            hn: this.#meta.hs ?? 0,
            ...(base !== undefined ? { base } : {}),
            m,
        };
        this.#cps.push(cp);
        // 之後的本機版本時間一定晚於這個檢查點
        if (cp.at > this.#meta.hlc)
            this.#meta.hlc = cp.at;
        this.#cpCache = { id: cp.id, manifest };
        this.#cpHold(manifest, 1);
        if (kind === 'named')
            this.#cpPin(manifest, 1);
        this.#cpDirty.add(cp.id);
        return cp;
    }
    /**
     * 刪掉一個檢查點：以它為基準的差異改成以它的基準為基準（或改成完整的），放開它留著的內容。
     * `reason`：拿它當「還原之前」的操作紀錄記下它為什麼不在了（`operations()` 的 `undoUnavailable`）。
     */
    #cpDelete(cp, reason) {
        const manifest = this.#cpMaterialize(cp);
        for (const next of this.#cps) {
            if (next.base !== cp.id)
                continue;
            const nm = this.#cpMaterialize(next);
            const base = cp.base !== undefined && cp.m.d !== undefined ? this.#cpById(cp.base) : undefined;
            if (base) {
                next.m = diffManifest(this.#cpMaterialize(base), nm);
                next.base = base.id;
            }
            else {
                next.m = encodeManifest(nm);
                delete next.base;
            }
            this.#cpDirty.add(next.id);
        }
        const index = this.#cps.indexOf(cp);
        if (index >= 0)
            this.#cps.splice(index, 1);
        if (this.#cpCache?.id === cp.id)
            this.#cpCache = null;
        this.#cpHold(manifest, -1);
        if (cp.kind === 'named')
            this.#cpPin(manifest, -1);
        this.#cpDirty.add(cp.id);
        for (const op of this.#ops) {
            if (op.before !== cp.id || op.ux !== undefined)
                continue;
            op.ux = reason;
            this.#opsDirty = true;
        }
    }
    /** 自動檢查點依稀疏化規則保留；「還原之前」的跟著保留天數過期（v0.50 裁示 2 甲）；命名的不動 */
    #cpRetain(now) {
        const autos = this.#cps.filter((c) => c.kind === 'auto').map((c) => ({ at: c.at, n: c.n, deleted: false, c }));
        const { drop } = thinHistory(autos, now, { keepDays: this.#histOpts.keepDays, maxVersions: Infinity, offset: this.#histOffset() });
        for (const d of drop)
            this.#cpDelete(d.c, 'deleted');
        const keepMs = this.#histOpts.keepDays * 86_400_000;
        for (const c of this.#cps.filter((x) => x.kind === 'restore' && now - x.at >= keepMs))
            this.#cpDelete(c, 'expired');
    }
    async #cpLoad() {
        const loaded = [];
        for (const key of await this.#store.keys('hk:')) {
            const cp = decodeJson(await this.#store.get(key));
            if (!cp || typeof cp.id !== 'string' || typeof cp.at !== 'number' || typeof cp.n !== 'number' || typeof cp.hn !== 'number' || !cp.m || !Array.isArray(cp.m.s))
                continue;
            if (cp.kind !== 'auto' && cp.kind !== 'restore' && cp.kind !== 'named')
                continue;
            loaded.push(cp);
        }
        loaded.sort((a, b) => a.at - b.at || a.n - b.n);
        this.#cps.push(...loaded);
        let prev = null;
        for (const cp of this.#cps) {
            const manifest = cp.base === undefined || cp.m.d === undefined ? decodeManifest(cp.m) : prev && prev.id === cp.base ? decodeManifest(cp.m, prev.manifest) : this.#cpMaterialize(cp);
            this.#cpHold(manifest, 1);
            if (cp.kind === 'named')
                this.#cpPin(manifest, 1);
            prev = { id: cp.id, manifest };
        }
        this.#cpCache = prev;
        const ops = decodeJson(await this.#store.get('ho'));
        if (Array.isArray(ops))
            this.#ops.push(...ops.filter((op) => op && typeof op.id === 'string' && typeof op.at === 'number'));
    }
    /**
     * 同步告一段落（佇列空、沒有要送的、沒有在等的）：最多每小時一個自動檢查點（`autoCheckpoint: 'app'` 時不建，由應用決定）。
     * 沒建出來（沒有變動、或離上一個還不滿一小時）的那一次嘗試，`AUTO_CHECKPOINT_RETRY_MS` 後就能再試（SDK ADR 0072：不再佔掉一整個小時）。
     */
    #maybeAutoCheckpoint() {
        if (this.#autoCheckpoint === 'app')
            return;
        if (this.#queued !== 0 || !this.#started || this.#stopped || this.#paused || !this.#histEnabled())
            return;
        if (this.#outbox.size > 0 || this.#pending.size > 0 || this.#waiting.size > 0 || this.#toMaterialize.size > 0)
            return;
        const now = this.#clock.now();
        if (this.#cpTriedAt !== undefined && now - this.#cpTriedAt < AUTO_CHECKPOINT_RETRY_MS)
            return;
        this.#cpTriedAt = now;
        void this.checkpoint({ auto: true }).catch((error) => this.#emit('error', { context: 'checkpoint', error }));
    }
    /** 檢查點清單裡的一筆當成歸檔版本（版本資訊盡量從歸檔補：時間、裝置；摘要裡有就不讀完整的歸檔） */
    async #cpEntry(fileId, f, cp) {
        const s = this.#histSum.get(fileId);
        let archived = s?.l?.versionId === f.versionId ? s.l : s?.lv?.versionId === f.versionId ? s.lv : undefined;
        if (!archived && s && s.c > 0)
            archived = (await this.#histPeek(fileId))?.entries.find((e) => e.versionId === f.versionId);
        return {
            versionId: f.versionId,
            path: f.path,
            hash: f.hash,
            size: f.size,
            text: f.text,
            at: archived?.at ?? cp.at,
            n: archived?.n ?? 0,
            deleted: false,
            device: archived?.device ?? '',
            label: archived?.label ?? '',
            content: f.text && f.local && this.#cpRefs.has(f.hash),
            ...(f.local ? {} : { unavailable: 'not-local' }),
        };
    }
    /**
     * 時間點的解法（裁示補充 4）：T 之前（含）最近的檢查點當起點，檢查點之後歸檔、時間不晚於 T 的版本蓋在上面（`mixed`）；
     * 沒有檢查點就全部照各檔歸檔推算。指定檢查點時就是那個檢查點（跟著保留天數過期的「還原之前」檢查點回 `checkpoint-expired`）。
     */
    #pointSpec(target) {
        let cp;
        let at;
        if (typeof target === 'number') {
            at = target;
            for (const c of this.#cps)
                if (c.at <= at)
                    cp = c;
        }
        else {
            cp = this.#cpById(target.checkpoint);
            if (!cp) {
                const expired = this.#ops.some((op) => op.before === target.checkpoint && op.ux === 'expired');
                return new VaultHistoryError(expired ? 'checkpoint-expired' : 'checkpoint-unknown', target.checkpoint);
            }
            at = cp.at;
        }
        return { at, ...(cp ? { cp, manifest: this.#cpMaterialize(cp) } : {}), exact: typeof target !== 'number', mixed: !cp };
    }
    /** 時間點涉及的檔案：有歸檔的、檢查點清單裡的、現在在磁碟上的 */
    #pointFiles(point) {
        const ids = new Set(this.#histSum.keys());
        if (point.manifest)
            for (const id of point.manifest.keys())
                ids.add(id);
        for (const rec of this.#files.values())
            if (rec.disk)
                ids.add(rec.id);
        return [...ids];
    }
    /** 一個檔案在時間點的狀態；摘要夠用時不讀完整的歸檔（只在 T 之前有變動時才讀） */
    async #pointState(point, fileId) {
        const s = this.#histSum.get(fileId);
        const { cp, manifest, at } = point;
        if (!cp || !manifest) {
            if (!s || s.c === 0 || !s.l)
                return s?.born !== undefined && at < s.born ? { known: true, entry: null } : { known: false };
            if (s.l.at <= at)
                return { known: true, entry: s.l.deleted ? null : s.l };
            const hf = await this.#histPeek(fileId);
            return hf ? fileStateAt(hf, at) : { known: false };
        }
        const fromCheckpoint = async () => {
            const f = manifest.get(fileId);
            return { known: true, entry: f ? await this.#cpEntry(fileId, f, cp) : null };
        };
        // 指定檢查點：就是那一刻的清單，不再蓋上之後的版本
        if (point.exact || !s || s.c === 0 || !s.l || s.nx <= cp.hn)
            return fromCheckpoint();
        // 檢查點之後才歸檔的版本（歸檔序號較大），而且時間不晚於 T
        let later;
        if (s.l.at <= at && s.l.n > cp.hn)
            later = s.l;
        else {
            for (const e of (await this.#histPeek(fileId))?.entries ?? []) {
                if (e.at > at)
                    break;
                if (e.n > cp.hn)
                    later = e;
            }
        }
        if (!later)
            return fromCheckpoint();
        point.mixed = true;
        return { known: true, entry: later.deleted ? null : later };
    }
    /** 一份內容：歸檔（`hc:`）裡的，或版本圖拿得到的（保存的、磁碟上雜湊相同的） */
    async #contentOf(fileId, hash) {
        const stored = await this.#hcRead(hash);
        if (stored && sha256Hex(stored.content) === hash)
            return stored.content.slice();
        const rec = this.#files.get(fileId);
        return rec ? this.#getContent(rec, hash) : undefined;
    }
    /** 記一筆操作紀錄（最多 200 筆，每筆的路徑清單最多 1,000 個） */
    #logOperation(op) {
        this.#meta.os = (this.#meta.os ?? 0) + 1;
        this.#metaDirty = true;
        const cap = (xs) => xs.slice(0, MAX_OPERATION_PATHS);
        this.#ops.push({
            id: `o${this.#meta.os}`,
            at: Math.max(this.#clock.now(), this.#meta.hlc),
            kind: op.kind,
            target: op.target,
            ...(op.before !== undefined ? { before: op.before } : {}),
            restored: cap(op.restored),
            removed: cap(op.removed),
            skipped: cap(op.skipped),
            counts: { restored: op.restored.length, removed: op.removed.length, skipped: op.skipped.length },
        });
        if (this.#ops.length > MAX_OPERATIONS)
            this.#ops.splice(0, this.#ops.length - MAX_OPERATIONS);
        this.#opsDirty = true;
    }
    /**
     * 修剪版本圖與內容：保留版本頭往回數（逐層）最近的 `maxVersionsPerFile` 個版本；
     * 內容只留可能當共同祖先的文字版本、還沒送出的版本、以及不在磁碟上的版本頭。
     */
    #gcFile(rec) {
        const ids = Object.keys(rec.nodes);
        const order = [];
        const seen = new Set();
        let level = [...rec.heads];
        while (level.length > 0) {
            const next = [];
            for (const id of level) {
                if (seen.has(id) || !rec.nodes[id])
                    continue;
                seen.add(id);
                order.push(id);
                next.push(...rec.nodes[id].parents);
            }
            level = next;
        }
        const must = new Set([...rec.heads, ...Object.keys(rec.unsent), ...(rec.disk ? [rec.disk.base] : []), ...(rec.det ? [rec.det.base] : [])]);
        if (ids.length > this.#opts.maxVersionsPerFile * 1.5) {
            const keep = new Set(order.slice(0, this.#opts.maxVersionsPerFile));
            for (const id of must)
                keep.add(id);
            for (const id of ids) {
                if (keep.has(id))
                    continue;
                delete rec.nodes[id];
                if (rec.cm)
                    delete rec.cm[id];
                if (rec.mr)
                    delete rec.mr[id];
                if (rec.cb)
                    delete rec.cb[id];
                rec.pruned.push(id);
            }
            if (rec.pruned.length > MAX_PRUNED)
                rec.pruned.splice(0, rec.pruned.length - MAX_PRUNED);
            this.#markDirty(rec);
        }
        const needed = new Set();
        // 輕量成員、範圍外：只留還沒送出的本機版本的內容（SDK ADR 0058）
        const out = this.#sparseOut(rec);
        const peerHeads = Object.values(rec.peers).flat();
        const baseCandidates = new Set([...must, ...peerHeads, ...order.slice(0, DEFAULT_BASE_VERSIONS_KEPT)]);
        for (const id of baseCandidates) {
            const node = rec.nodes[id];
            if (!node || node.deleted || node.p2p)
                continue;
            const unsent = id in rec.unsent;
            if (out && !unsent)
                continue;
            // 本機排除範圍裡的版本頭不在這台保存內容（重新納入時再向別台要；SDK ADR 0047）
            const offDisk = rec.heads.includes(id) && rec.disk?.hash !== node.hash && !this.#excluded(node.path);
            if (node.text || unsent || offDisk)
                needed.add(node.hash);
        }
        const drop = rec.blobs.filter((h) => !needed.has(h));
        if (drop.length > 0) {
            rec.blobs = rec.blobs.filter((h) => needed.has(h));
            for (const h of drop)
                this.#bg(this.#store.delete(`b:${rec.id}:${h}`));
            this.#markDirty(rec);
        }
    }
}
//# sourceMappingURL=coordinator.js.map