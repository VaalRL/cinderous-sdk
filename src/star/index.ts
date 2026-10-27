/**
 * `@cinderous/client/star`（SDK ADR 0030）：多人星狀會話——一個 Host、N 位成員，每位成員與 Host 各一條成對的雙棘輪通道。
 *
 * ⚠ **這不是端到端的群組加密**：Host 解密每位成員送來的訊息，再以其他成員各自的通道重新加密轉送。
 * Host 看得到、也改得了經過它的所有內容；只讓你信任的人當 Host。真正的群組加密（例如 MLS）是另一回事（ADR 0030 §9）。
 *
 * - `StarHost`：邀請（一次性、有時效、可撤銷、可綁定公鑰）、加入、離開、踢出、名單事件、Host 序號（全體一致的順序）、
 *   單播、每位成員的佇列上限與溢出策略、進站速率上限、中繼軌事件預算。
 * - `StarMember`：以邀請字串加入；收到的每則都帶 Host 填的寄件人與序號；Host 斷線有明確事件，不自動換 Host。
 * - 平台無關（零 Node 內建模組）。雙棘輪的線路格式不變；批次（多筆小更新合成一則棘輪訊息）攤掉後量子 header。
 */
export {
  DEFAULT_STAR_INBOUND_RATE,
  DEFAULT_STAR_JOIN_TIMEOUT_MS,
  DEFAULT_STAR_MAX_MEMBERS,
  DEFAULT_STAR_MAX_PAYLOAD_BYTES,
  STAR_MAX_MEMBERS_LIMIT,
  STAR_MAX_PAYLOAD_LIMIT,
  StarHost,
  StarHostError,
  type StarHostEvent,
  type StarHostOptions,
  type StarJoinRequest,
  type StarMemberInfo,
  type StarMessage,
  type StarRateLimit,
  type StarSendOptions,
} from './host.js';
export {
  StarJoinError,
  StarMember,
  StarMemberError,
  type StarHostLostReason,
  type StarJoinFailure,
  type StarJoinOptions,
  type StarMemberErrorCode,
  type StarMemberEvent,
  type StarMemberOptions,
} from './member.js';
export {
  DEFAULT_STAR_INVITE_TTL_MS,
  encodeStarInvite,
  isStarInviteExpired,
  MAX_STAR_INVITE_TTL_MS,
  MAX_STAR_INVITES,
  parseStarInvite,
  STAR_INVITE_MAX_RELAYS,
  STAR_INVITE_PREFIX,
  STAR_INVITE_VERSION,
  StarInviteError,
  type CreateStarInviteOptions,
  type StarInvite,
  type StarInviteInfo,
  type StarInvitePayload,
} from './invite.js';
export {
  DEFAULT_STAR_RELAY_EVENTS_PER_MINUTE,
  defaultTuning,
  starRelayBudget,
  starRelayEventsPerMinute,
  type LinkStats,
  type LinkTuning,
  type StarChannel,
  type StarTimers,
  type StarTransportOptions,
} from './link.js';
export {
  isStarPacket,
  PACKET_HEADER_BYTES,
  RECORD_HEADER_BYTES,
  STAR_INVITE_SECRET_BYTES,
  STAR_LABEL_MAX_BYTES,
  STAR_MAGIC,
  STAR_MAX_RECIPIENTS,
  STAR_WIRE_VERSION,
  type RosterEntry,
  type StarEndReason,
  type StarRejectReason,
} from './wire.js';
