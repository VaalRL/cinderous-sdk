/**
 * `@cinderous/client/pairing`（SDK ADR 0028）：QR 裝置配對與 Vault 名單。
 *
 * 平台無關（零 Node 內建模組）。QR 影像的產生與掃描不在 SDK：這裡只產生與解析 QR 字串，應用用自己的 QR 函式庫。
 *
 * - `createPairingOffer`／`acceptPairingUri`：一次性秘密＋臨時 ECDH＋身分金鑰的相互認證握手，6 位數 SAS 雙方確認，
 *   完成後成員把新裝置加進名單、把名單與共享金鑰交給新裝置。每台裝置各自一把身分金鑰，**私鑰不交付**。
 * - `VaultMembership`：互相信任的裝置清單＋共享 Vault 金鑰；給協調器、`PeerNode`、白名單用的查詢；撤銷＋輪換。
 * - `NostrRosterSync`：名單變動時送給其他成員（kind 1060 外層、內層 4361），收到的合併。
 * - 中繼搬家通知（SDK ADR 0052）：`announceRelayMove` 把「舊網址 → 新網址」送給名單上的有效成員（內層 4363），
 *   `NostrRosterSync` 的 `onRelayMove` 交出驗證過寄件人的通知，`planRelayMoves`＋`probeRelayEndpoint` 決定要不要替換。
 * - 備援中繼經名單共享（SDK ADR 0056）：`membership.declareStandby` 自己簽一份備援清單，`declaredStandbys()` 讀別台的；
 *   `StandbySuggestions`／`planStandbyAdoption` 列出**建議新增**的備援（只新增、公開的 `wss://`、測得通，使用者確認才採用）；
 *   配對的歡迎訊息帶邀請方的備援（`PairingResult.standby`）。
 */
export {
  acceptPairingUri,
  createPairingOffer,
  DEFAULT_PAIRING_CONFIRM_MS,
  DEFAULT_PAIRING_HANDSHAKE_MS,
  DEFAULT_PAIRING_RESEND_MS,
  PAIRING_CLOCK_SKEW_MS,
  PAIRING_KIND,
  PairingSession,
  type PairingClock,
  type PairingDevice,
  type PairingOfferOptions,
  type PairingPeer,
  type PairingResult,
  type PairingSessionOptions,
  type PairingState,
  type PairingUpdate,
} from './session.js';
export {
  compactRelayUrl,
  DEFAULT_PAIRING_TTL_MS,
  encodePairingUri,
  MAX_PAIRING_URI_BYTES,
  PAIRING_MAX_RELAYS,
  PAIRING_QR_TARGET,
  PAIRING_SECRET_BYTES,
  PAIRING_URI_PREFIX,
  PAIRING_VERSION,
  parsePairingUri,
  qrVersionFor,
  type PairingInvite,
  type PairingRole,
} from './uri.js';
export { isPairingError, PairingError, type PairingFailure } from './errors.js';
export {
  claimDevice,
  compareSdkVersions,
  CURRENT_DEVICE_CAPABILITIES,
  defaultDeviceId,
  LEGACY_MAX_RELAY_FILE_BYTES,
  normalizeSparsePatterns,
  parseCapabilities,
  parseRosterData,
  ROSTER_CAPS_MAX_JSON,
  ROSTER_LABEL_MAX,
  ROSTER_MAX_DEVICES,
  ROSTER_MAX_EPOCH,
  ROSTER_MAX_KEYS,
  ROSTER_MAX_REVOKED,
  ROSTER_SPARSE_MAX_PATTERN_LENGTH,
  ROSTER_SPARSE_MAX_PATTERNS,
  ROSTER_VERSION,
  sanitizeLabel,
  SDK_VERSION,
  VAULT_KEY_BYTES,
  VaultMembership,
  verifyDeviceClaim,
  type DeclaredStandby,
  type DeviceCapabilities,
  type MembershipChange,
  type MembershipOptions,
  type MinCapability,
  type RosterCapability,
  type RosterDevice,
  type RosterLabel,
  type RosterRevocation,
  type RosterSparse,
  type RosterStandby,
  type SparseMember,
  type VaultKey,
  type VaultRosterData,
} from './roster.js';
export {
  buildRosterEvents,
  buildRevocationNotice,
  DEFAULT_ROSTER_OUTER_KIND,
  DEFAULT_ROSTER_TTL_SECONDS,
  NostrRosterSync,
  openRosterEvent,
  VAULT_ROSTER_KIND,
  type NostrRosterSyncOptions,
  type RosterMemberActivity,
  type RosterPendingStore,
  type RosterOuterKind,
} from './roster-sync.js';
export {
  announceRelayMove,
  buildRelayMoveEvents,
  DEFAULT_RELAY_MOVE_CONNECT_MS,
  DEFAULT_RELAY_MOVE_TTL_SECONDS,
  isRelayMoveUrl,
  openRelayMoveEvent,
  planRelayMoves,
  probeRelayEndpoint,
  RELAY_MOVE_MAX_URL_LENGTH,
  sameRelayUrl,
  VAULT_RELAY_MOVE_KIND,
  type AnnounceRelayMoveOptions,
  type AnnounceRelayMoveResult,
  type PlanRelayMovesOptions,
  type ReceivedRelayMove,
  type RelayMove,
  type RelayMoveConnection,
  type RelayMovePlan,
  type RelayMoveProbeFetch,
} from './relay-move.js';
export {
  DEFAULT_STANDBY_RETRY_MS,
  isShareableStandbyUrl,
  normalizeStandbyUrl,
  planStandbyAdoption,
  ROSTER_STANDBY_MAX_URL_LENGTH,
  ROSTER_STANDBY_MAX_URLS,
  shareableStandbyUrls,
  StandbySuggestions,
  type PlanStandbyAdoptionOptions,
  type StandbyCandidate,
  type StandbyOffer,
  type StandbyProbeState,
  type StandbySuggestion,
  type StandbySuggestionSource,
  type StandbySuggestionsOptions,
} from './standby.js';
export { RelayEventBudget, relayEventsPerMinute, sharedRelayEventBudget, type RelayEventBudgetOptions } from '../relay-budget.js';
export type { NostrSigner } from '../protocol/signer.js';
