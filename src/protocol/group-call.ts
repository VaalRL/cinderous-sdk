// 網狀（mesh）小群組通話的信令（SDK ADR 0141）。
//
// - 每人直連每人：N 人 ⇒ 每人 N−1 條 WebRTC 連線，不經任何媒體伺服器，媒體一樣是端到端的 DTLS-SRTP。
// - 信令跟一對一通話同一種包裝：kind 21002 的 NIP-59 ephemeral Gift Wrap，每則只給一個收件人。
// - 🔴 相容：群組信令**沒有** `callId`，type 也全是 `group-*`。只懂一對一的對端（舊版 SDK、Cinderous App）
//   的 `parseCallSignal` 會丟例外而忽略它——不會把群組邀請當成一對一來電響鈴。代價是邀請舊版的人
//   不會有任何回應，邀請方只能等響鈴逾時（`no-answer`）。
// - 誰向誰發 offer：每一對由 pubkey 字典序較小的那位發（`groupCallOfferer`），兩邊算出同一個答案，沒有 glare。
import type { CallMedia } from './call.js';

/** 預設上限（含自己）。理由見 SDK ADR 0141 的頻寬估算：4 人視訊時每人上傳 3 份 */
export const GROUP_CALL_DEFAULT_MAX = 4;
/** 硬上限（含自己）：網狀拓撲每人上傳 N−1 份，6 人以上連標準畫質也要 3 Mbps 上傳，行動網路撐不住 */
export const GROUP_CALL_HARD_MAX = 6;
/** 群組信令版本 */
export const GROUP_CALL_VERSION = 1;

export type GroupDeclineReason = 'declined' | 'busy' | 'full';

interface Base {
  v: 1;
  groupId: string;
}
export interface GroupInvite extends Base {
  type: 'group-invite';
  media: CallMedia;
  /** 含邀請者自己 */
  members: string[];
}
/** 我加入了（廣播給所有成員）；`ack` 是回覆別人的加入，收到 ack 不再回 ack */
export interface GroupJoin extends Base {
  type: 'group-join';
  members: string[];
  ack?: true;
}
export interface GroupDecline extends Base {
  type: 'group-decline';
  reason: GroupDeclineReason;
}
export interface GroupLeave extends Base {
  type: 'group-leave';
}
/** 有人邀了新成員：告訴其他已加入的人名單變了 */
export interface GroupMembers extends Base {
  type: 'group-members';
  members: string[];
}
export interface GroupOffer extends Base {
  type: 'group-offer';
  sdp: string;
  media: CallMedia;
}
export interface GroupAnswer extends Base {
  type: 'group-answer';
  sdp: string;
  media: CallMedia;
}
export interface GroupCandidate extends Base {
  type: 'group-candidate';
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}
export interface GroupMediaChange extends Base {
  type: 'group-media';
  media: CallMedia;
}

export type GroupCallSignal =
  | GroupInvite
  | GroupJoin
  | GroupDecline
  | GroupLeave
  | GroupMembers
  | GroupOffer
  | GroupAnswer
  | GroupCandidate
  | GroupMediaChange;

/** 這一對裡由誰發 offer：字典序較小的 pubkey */
export function groupCallOfferer(a: string, b: string): string {
  return a < b ? a : b;
}

const HEX64 = /^[0-9a-f]{64}$/;
const GROUP_ID = /^[0-9a-f]{32,64}$/;
const MAX_SDP = 64 * 1024;

function members(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > GROUP_CALL_HARD_MAX) throw new Error('群組通話成員名單非法');
  for (const m of value) if (typeof m !== 'string' || !HEX64.test(m)) throw new Error('群組通話成員不是 64 個小寫 hex');
  if (new Set(value).size !== value.length) throw new Error('群組通話成員重複');
  return [...(value as string[])];
}

function media(value: unknown): CallMedia {
  if (value !== 'audio' && value !== 'video') throw new Error('群組通話 media 非法');
  return value;
}

function sdp(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SDP) throw new Error('群組通話 sdp 非法');
  return value;
}

/** 解析並驗證群組通話信令（信任邊界）。不是群組信令、版本不對或欄位非法一律丟例外。 */
export function parseGroupCallSignal(content: string): GroupCallSignal {
  const value: unknown = JSON.parse(content);
  if (typeof value !== 'object' || value === null) throw new Error('群組通話信令格式錯誤：非物件');
  const s = value as Record<string, unknown>;
  if (s.v !== GROUP_CALL_VERSION) throw new Error('群組通話信令版本不支援');
  if (typeof s.groupId !== 'string' || !GROUP_ID.test(s.groupId)) throw new Error('群組通話信令 groupId 非法');
  const base = { v: 1 as const, groupId: s.groupId };
  switch (s.type) {
    case 'group-invite':
      return { ...base, type: 'group-invite', media: media(s.media), members: members(s.members) };
    case 'group-join':
      return { ...base, type: 'group-join', members: members(s.members), ...(s.ack === true ? { ack: true as const } : {}) };
    case 'group-decline':
      if (s.reason !== 'declined' && s.reason !== 'busy' && s.reason !== 'full') throw new Error('group-decline reason 非法');
      return { ...base, type: 'group-decline', reason: s.reason };
    case 'group-leave':
      return { ...base, type: 'group-leave' };
    case 'group-members':
      return { ...base, type: 'group-members', members: members(s.members) };
    case 'group-offer':
      return { ...base, type: 'group-offer', sdp: sdp(s.sdp), media: media(s.media) };
    case 'group-answer':
      return { ...base, type: 'group-answer', sdp: sdp(s.sdp), media: media(s.media) };
    case 'group-candidate': {
      if (typeof s.candidate !== 'string' || s.candidate.length > 4096) throw new Error('group-candidate 缺少 candidate');
      const out: GroupCandidate = { ...base, type: 'group-candidate', candidate: s.candidate };
      if (typeof s.sdpMid === 'string') out.sdpMid = s.sdpMid;
      if (typeof s.sdpMLineIndex === 'number') out.sdpMLineIndex = s.sdpMLineIndex;
      return out;
    }
    case 'group-media':
      return { ...base, type: 'group-media', media: media(s.media) };
    default:
      throw new Error(`未知群組通話信令類型：${String(s.type)}`);
  }
}
