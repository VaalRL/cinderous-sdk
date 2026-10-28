/**
 * `@cinderous/client/sync/vault`（SDK ADR 0025）：檔案樹（Vault）層級的同步協調器。
 *
 * 平台無關（零 Node 內建模組）：檔案系統（`VaultAdapter`）、狀態儲存（`SyncStateStore`）、
 * 時間（`VaultSyncClock`）、網路（`VaultSyncTransport`）一律注入。身分用 `NostrSigner`（例如 `Identity`）。
 *
 * - `VaultSyncCoordinator`：本機變更偵測、路徑→版本索引、合併祖先保存、持久化送出佇列、
 *   回環抑制、改名語意、墓碑、衝突副本、狀態事件。
 * - `NostrVaultTransport`：沿用 kind 1060 外層的網路層。
 * - `peerNodeLink`（SDK ADR 0026）：以 `PeerNode` 直連其他裝置；大量變更與大檔內容改走 P2P 批次串流。
 * - `MemorySyncStateStore`：記憶體狀態儲存（測試與範例）。
 * - `compileSyncExcludes`／`compilePathFilter`／`validatePattern`／`DEFAULT_USER_EXCLUDES`（SDK ADR 0047）：
 *   gitignore 風格的同步排除範圍（固定＋使用者兩層），給協調器的 `excludes`／`setExcludes` 與設定頁共用。
 * - 版本歷史（SDK ADR 0063）：協調器的 `history`／`readHistory`／`restore`／`deletedFiles`／`vaultAt`／`planRestoreVault`／
 *   `restoreVault`／`clearHistory`、檢查點（`checkpoint`／`checkpoints`／`renameCheckpoint`／`deleteCheckpoint`）與操作紀錄
 *   （`operations`），只在這台、不同步；`thinHistory`／`buildRestorePlan`／檢查點清單的編碼等純函式。
 */
export { BUNDLE_CAPABILITY, DEFAULT_BASE_VERSIONS_KEPT, DEFAULT_BULK_THRESHOLD, DEFAULT_P2P_RETRY_INITIAL_MS, DEFAULT_P2P_RETRY_MAX_MS, DEFAULT_RELAY_BULK_PER_HOUR, DEFAULT_DIGEST_CHUNK, DEFAULT_DIGEST_MAX_INTERVAL_MS, DEFAULT_MAX_VERSIONS_PER_FILE, DEFAULT_ORPHAN_AFTER_MS, DEFAULT_RETRY_INITIAL_MS, DEFAULT_RETRY_MAX_MS, DEFAULT_TEXT_EXTENSIONS, DEFAULT_WANT_INTERVAL_MS, defaultIsText, defaultPathKey, SWAP_SUFFIX, VaultSyncCoordinator, } from './coordinator.js';
export { decodeVaultMessage, encodedVaultMessageLength, encodeVaultMessage, isSafeVaultPath, MAX_BUNDLE_ITEMS, parseVersion, validateVaultMessage, vaultFrameCount, VAULT_WIRE_VERSION, } from './codec.js';
export { CONFLICT_CALLOUT_MARKER, CONFLICT_CALLOUT_MAX_CHARS, CONFLICT_CALLOUT_MAX_LINES, CONFLICT_CALLOUT_MAX_VERSIONS, CONFLICT_CALLOUT_TYPE, CONFLICT_CALLOUTS_CAPABILITY, isMarkdownPath, mergeWithConflictCallouts, parseConflictCallouts, renderConflictCallout, resolveConflictCallout, } from './conflict-callout.js';
export { ancestorsOf, bestCommonAncestor, compareVersions, computeHeads, deterministicId, CALLOUT_BREAK_CAPABILITY, isCalloutBreakId, isCalloutCapableId, isMergeRulesId, isMergeVersion, markCalloutBreakId, markCalloutCapableId, markMergeRulesId, MERGE_RULES_CAPABILITY, MissingContentError, planMerge, sha256Hex, supportsCalloutBreak, supportsConflictCallouts, supportsMergeRules, } from './graph.js';
export { createNostrVaultTransport, BACKFILL_PAGE_TIMEOUT_MS, DEFAULT_VAULT_TTL_SECONDS, frameVaultMessage, NostrVaultTransport, VAULT_FRAME_BYTES, VAULT_MAX_FRAMES, VAULT_OP_KIND, } from './nostr-transport.js';
export { RelayEventBudget, relayEventsPerMinute, sharedRelayEventBudget } from '../../relay-budget.js';
export { addRange, coversRange, RelayLedger } from './relay-ledger.js';
export { EMPTY_SHA256, parseVaultEntryMeta, peerNodeLink, VAULT_STREAM_PURPOSE, } from './p2p.js';
export { checkRelayAcceptsFiles, DEFAULT_RELAY_FILE_LIMITS, DEFAULT_RELAY_INFO_REFRESH_MS, fetchRelayFilePolicy, inboxAckRelays, isFileEventsDisabledReason, isRelayRejectsFilesError, isRelaysFullError, loadRelayFileLimits, RELAY_QUOTA_SAFETY, relayChunkBudget, relayFileLimits, RelayRejectsFilesError, RelaysFullError, relayHttpUrl, safeRelayChunksPerHour, watchRelayFileLimits, } from './relay-check.js';
export { asPathFilter, combinePathFilters, compilePathFilter, compileSyncExcludes, DEFAULT_USER_EXCLUDES, literalPathPattern, MAX_PATH_PATTERN_LENGTH, validatePattern, } from './path-filter.js';
export { addToRestorePlan, AUTO_CHECKPOINT_INTERVAL_MS, buildRestorePlan, compareHistory, decodeManifest, DEFAULT_HISTORY_KEEP_DAYS, DEFAULT_HISTORY_MAX_BYTES, DEFAULT_HISTORY_MAX_VERSIONS, diffManifest, emptyRestorePlan, encodeManifest, fileStateAt, finishRestorePlan, isEmptyDiff, isVaultHistoryError, MAX_NAMED_CHECKPOINTS, overByteBudget, thinHistory, VaultHistoryError, } from './history.js';
export { MemorySyncStateStore } from './state-store.js';
export { compilePathScope, compilePeerScopes, DEFAULT_SPARSE_CACHE_BYTES, isVaultScopeError, sparsePeerScopes, VaultScopeError, } from './scope.js';
export { VaultWantResponder } from './responder.js';
export { isRelayQueryIncompleteError, RelayQueryIncompleteError } from '../hydrator.js';
//# sourceMappingURL=index.js.map