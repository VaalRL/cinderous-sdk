/**
 * `@cinderous/client` v0.1（SDK ADR 0001）：Cinderous 中繼的客戶端基礎。
 *
 * - `RelayPool`：多中繼同時連線、事件以 id 去重、驗簽、NIP-42 AUTH、退避重連（撐過 30 秒才歸零）
 * - `Identity`：NIP-01／19 金鑰與簽章、NIP-44 v2 加解密；私鑰不外露
 * - `DirectMessages`／`wrapDm`／`unwrapDm`：標準 NIP-17 私訊（一份 rumor 封兩次、rumor id 去重）
 * - `Blocklist`：本機封鎖名單
 * - `loadOrCreateIdentity`：私鑰持久化的接縫（儲存由應用實作）
 *
 * - 每座中繼的健康狀態、`publish(event, { durability })` 的耐久度要求與延遲連線的備援、`queryEach`（SDK ADR 0041）
 *
 * 資源試算器在子路徑 `@cinderous/client/estimator`，不跟著主入口載入；讀回稽核與 NIP-65／17 中繼清單在 `@cinderous/client/durability`。
 * 檔案傳輸另有子路徑 `@cinderous/client/transfer`（SDK ADR 0023），主入口也轉出同一個實作。
 * WebSocket 與儲存一律以介面注入：瀏覽器、Tauri WebView 與 Node 測試用同一套。
 */
export { Blocklist, DEFAULT_BLOCKLIST_STORAGE_KEY } from './blocklist.js';
export { MemoryAsyncChatStorage } from './chat-storage.js';
export { DEFAULT_DM_STORAGE_KEY, DirectMessages, DM_HISTORY_PER_PEER, DM_LOOKBACK_SEC, DM_MAX_CHARS, DM_PEERS_LIMIT, DM_RUMOR_KIND, DM_SEAL_KIND, DM_WRAP_KIND, unwrapDm, wrapDm, } from './dm.js';
export { Identity } from './identity.js';
export { isNostrSigner } from './protocol/signer.js';
export { DEFAULT_PUBLISH_TIMEOUT_MS, DEFAULT_RECONNECT_DELAYS_MS, DEFAULT_RECONNECT_STABLE_MS, DEFAULT_RELAY_HEALTH_COOLDOWNS, DEFAULT_STANDBY_IDLE_MS, DEFAULT_MAX_SEEN_PER_SUBSCRIPTION, SEEN_GRACE_MS, SEEN_PRUNE_EVERY, BACKDATED_KINDS, classifyPublishRejection, durabilityShortfall, isBackdatableFilter, meetsDurability, NIP59_MAX_BACKDATE_SEC, publishRejections, RelayPool, relayDataPlaneOf, reportPublishRejections, resumeSince, } from './relay-pool.js';
export { classifyRelayClose, classifyRelayMessage, isUnknownRelayPathMessage, parseBorrowedWarning, parseDroppedNotice, parseNearFullWarning, RELAY_REJECT_TOKENS, RELAY_WARNING_TOKENS, relayRejectKindOf, } from './protocol/relay-reject.js';
export { loadOrCreateIdentity } from './secret-store.js';
export { DEFAULT_RELAY_EVENTS_PER_MINUTE, publishPaced, rateLimitBackoffMs, RELAY_MAX_EVENTS_PER_MINUTE, RELAY_RATE_LIMIT_BACKOFF_MS, RelayEventBudget, relayEventsPerMinute, sharedRelayEventBudget, } from './relay-budget.js';
export { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_RELAY_FRAMES_PER_MINUTE, LARGE_PAYLOAD_WARNING_BYTES, PeerNode, RELAY_FRAME_KIND, } from './peer/peer-node.js';
export { decodeFrame, encodeFrames, FRAME_PAYLOAD_BYTES, FrameAssembler } from './peer/frames.js';
export { CinderEkKeyring, PeerUpgradedError, SecurityDowngradeError, } from './crypto/cinder-ek.js';
export { DEFAULT_MAX_SKIPPED_KEYS, DEFAULT_PQ_REKEY_INTERVAL, DoubleRatchetSession, generateRatchetKeyPair, RatchetProtocolError, } from './crypto/double-ratchet.js';
export { DEFAULT_HANDSHAKE_TIMEOUT_MS, secureChannel, UnsupportedRatchetVersionError, } from './crypto/secure-channel.js';
export { chooseEngine, CRYPTO_ENGINES_TAG, engineCapabilityTag, engineConfigFor, readEngineCapabilities, SUPPORTED_ENGINES, UnsupportedEngineError, } from './crypto/presets.js';
export { blobSource, bytesSource, DEFAULT_FILE_CHUNK_BYTES, DEFAULT_MAX_FILE_BYTES, FileIntegrityError, FileRejectedError, FileTransfer, isFileTransferMessage, LargeFileOverRelayError, MemoryPartialStore, } from './transfer/file-transfer.js';
export { P2PFileQueue } from './transfer/p2p-queue.js';
export { CallManager } from './call/call-manager.js';
export { DEFAULT_STUN, TurnProvider } from './call/turn-provider.js';
//# sourceMappingURL=index.js.map