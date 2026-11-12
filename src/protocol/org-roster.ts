// 企業佈建與組織通訊錄（Cinderous ADR-0047）：管理者簽章的成員名冊。
//
// SDK ADR 0132：自 Cinderous `packages/core` 搬來（同 ADR-0370 的協定搬遷），讓中繼的 NIP-86
// `cinder_applyroster` 能驗名冊；Cinderous 照原名轉出。文中 ADR 編號未加前綴者皆指 Cinderous ADR。
//
// 複用 ADR-0039 簽章清單機制：管理者金鑰簽章（NIP-01 事件，kind ORG_ROSTER_KIND），
// 信任根＝管理者公鑰。採用前驗簽 + 防清空（成員數 ≥1）+ 較新才取代。名冊同時餵
// 客戶端通訊錄（diffRoster）與 relay allowlist（rosterAllowlist）。純函式、無 I/O。

import type { NostrEvent } from "./event.js";
import type { PubkeyHex, SecretKey } from "./keys.js";
import { finalizeEvent, verifyEvent } from "./sign.js";

/** 組織名冊事件 kind（可取代事件，Cinderous ADR-0047）。 */
export const ORG_ROSTER_KIND = 10038;

/** 組織成員。`relayUrl` 為該成員的 home relay hint（可選）。 */
export interface OrgMember {
  pubkey: PubkeyHex;
  name: string;
  relayUrl?: string;
  /**
   * 身分輪替（ADR-0052）：此成員（舊 npub）已被 `supersededBy` 指向的新 npub 取代。
   * 帶此欄位者為「已作廢的舊身分」——不計入 allowlist，客戶端據此把本機聯絡人/群成員
   * 從舊 npub 接續到新 npub（remap）。無此欄位＝在世成員（現況不變）。
   */
  supersededBy?: PubkeyHex;
}

/** 企業政策（ADR-0048）：管理者集中控管的功能停用/強制 TURN 旗標。 */
export interface OrgPolicy {
  disableFiles?: boolean;
  disableCalls?: boolean;
  disableStickers?: boolean;
  /** 強制 WebRTC 只走 TURN（iceTransportPolicy: "relay"），避免揭露內網 IP。 */
  forceTurn?: boolean;
  /** 禁止工作身分把狀態快照上雲（ADR-0071）：組織不願工作狀態密文駐留 relay 時啟用。 */
  disableCloudBackup?: boolean;
  /**
   * 訊息保留天數（ADR-0160，1–365 整數）：發送端對聊天/檔案 metadata 蓋 `now+N天`
   * 外層過期——企業自架 relay 搭配 `MAX_TTL_DAYS` 放寬上限才生效（站方上限恆為權威）。
   * 未設＝預設 7 天。閱後即焚（disappearAt）不受影響。
   */
  messageTtlDays?: number;
  /**
   * 組織檔案經 relay 暫存的大小上限（MB，ADR-0162，1–16 整數）：設定後名冊成員 1:1
   * 的 ≤ 上限檔案改走加密分塊 relay（離線也送得到）；需自架 relay 設 `MAX_FILE_MB`
   * 才收。未設＝關（維持 P2P）。
   */
  relayFilesMaxMb?: number;
}

/** relay 檔案上限的政策最大值（MB，ADR-0162）。 */
export const ORG_RELAY_FILE_MAX_MB = 16;

/** 訊息保留天數上限（ADR-0160）。 */
export const ORG_TTL_MAX_DAYS = 365;

/** 政策保留天數 → 秒（ADR-0160）；未設回 undefined，供發送端蓋章。 */
export function policyTtlSeconds(policy: OrgPolicy | undefined): number | undefined {
  const d = policy?.messageTtlDays;
  return d !== undefined ? d * 86_400 : undefined;
}

/**
 * 政策在使用者眼中的一條規則（ADR-0312）：供設定頁條列「公司政策做了什麼」。
 *
 * 過去政策只表現為「按鈕消失」——使用者看不出是壞掉還是被公司關掉。
 * 這裡把 `OrgPolicy` 攤成可讀清單；**文案留給各端的 i18n**（core 不認識 i18n），
 * 本函式只負責「有哪幾條、什麼順序」，讓桌面與行動端不會各列一份、也不會漏掉新旗標。
 */
export type PolicyNoticeId =
  | "files"
  | "calls"
  | "stickers"
  | "cloudBackup"
  | "forceTurn"
  | "ttlDays"
  | "relayFilesMb";

export interface PolicyNotice {
  id: PolicyNoticeId;
  /** `disabled`＝功能被關掉；`rule`＝功能還在，但行為受限。 */
  kind: "disabled" | "rule";
  /** 帶數值的規則（`ttlDays`／`relayFilesMb`）。 */
  value?: number;
}

/**
 * 攤平政策為顯示清單：先列停用的功能，再列生效中的規則。
 * 無政策（或政策為空）回空陣列——呼叫端據此整段不顯示。
 */
export function policyNotices(policy: OrgPolicy | undefined): PolicyNotice[] {
  if (!policy) return [];
  const out: PolicyNotice[] = [];
  if (policy.disableFiles) out.push({ id: "files", kind: "disabled" });
  if (policy.disableCalls) out.push({ id: "calls", kind: "disabled" });
  if (policy.disableStickers) out.push({ id: "stickers", kind: "disabled" });
  if (policy.disableCloudBackup) out.push({ id: "cloudBackup", kind: "disabled" });
  if (policy.forceTurn) out.push({ id: "forceTurn", kind: "rule" });
  if (policy.messageTtlDays !== undefined) out.push({ id: "ttlDays", kind: "rule", value: policy.messageTtlDays });
  if (policy.relayFilesMaxMb !== undefined) {
    out.push({ id: "relayFilesMb", kind: "rule", value: policy.relayFilesMaxMb });
  }
  return out;
}

/** 組織群組（ADR-0049）：管理者佈建的部門群／公告頻道。 */
export interface OrgGroup {
  id: string;
  name: string;
  members: PubkeyHex[];
  /** 公告頻道：僅管理者可發文、成員唯讀。 */
  announce?: boolean;
}

/** 表定上下班時間（ADR-0157）：`"HH:MM"` 24 小時制；支援跨夜（start > end）。 */
export interface OrgWorkHours {
  start: string;
  end: string;
}

/** 組織名冊文件（簽章事件的 content JSON）。 */
export interface OrgRosterDoc {
  org: string;
  members: OrgMember[];
  /** 集中政策（可選，ADR-0048）。 */
  policy?: OrgPolicy;
  /** 組織群組（可選，ADR-0049）。 */
  groups?: OrgGroup[];
  /** 歡迎詞／基本規範（可選，ADR-0157）：新成員首次採用時一次性顯示；組織資訊面板可查。 */
  welcome?: string;
  /** 表定上下班時間（可選，ADR-0157）：成員端下班時間自動靜音組織通知。 */
  workHours?: OrgWorkHours;
  /**
   * 共同管理者（SDK ADR 0135；Cinderous ADR-0418）：除了擁有者（信任根）之外也能簽名冊的 pubkey。
   * **只有擁有者簽的名冊裡的這份名單算數**；共同管理者簽的名冊裡的值一律忽略。
   * 必須是這份名冊的在世成員（不是的會被濾掉），上限 `ROSTER_MAX_ADMINS`。
   */
  admins?: PubkeyHex[];
  /** 發佈時間（unix 秒）；用於「較新才取代」。 */
  updatedAt: number;
}

/** 共同管理者人數上限（SDK ADR 0135）。 */
export const ROSTER_MAX_ADMINS = 16;

/**
 * 名冊的信任設定（SDK ADR 0135）：`owner` 是信任根（邀請碼裡的管理者、自架站的 `ROSTER_ADMIN_PUBKEY`）；
 * `coAdmins` 是**擁有者最新一份名冊**列的共同管理者——呼叫端自己記著，收到擁有者的新名冊就更新。
 */
export interface RosterTrust {
  owner: PubkeyHex;
  coAdmins?: readonly PubkeyHex[];
}

/** 可以簽名冊的 pubkey（擁有者在前），供訂閱名冊事件的 `authors`。 */
export function rosterSigners(owner: PubkeyHex, coAdmins: readonly PubkeyHex[] | undefined): PubkeyHex[] {
  const out = [owner];
  for (const pk of coAdmins ?? []) if (!out.includes(pk)) out.push(pk);
  return out;
}

/** 清洗共同管理者：字串、去重、不是擁有者、是在世成員、截到上限；空回 undefined。 */
function parseAdmins(value: unknown, members: OrgMember[], owner: PubkeyHex | undefined): PubkeyHex[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const live = new Set(members.filter((m) => !m.supersededBy).map((m) => m.pubkey));
  const out: PubkeyHex[] = [];
  for (const pk of value) {
    if (typeof pk !== "string" || pk === owner || out.includes(pk) || !live.has(pk)) continue;
    out.push(pk);
    if (out.length >= ROSTER_MAX_ADMINS) break;
  }
  return out.length > 0 ? out : undefined;
}

/** 歡迎詞長度上限（防惡意巨大名冊；sign/verify 兩側皆截斷防禦）。 */
export const WELCOME_MAX_CHARS = 2000;

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 解析/清洗歡迎詞：修剪＋截斷；空回 undefined。 */
function parseWelcome(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim().slice(0, WELCOME_MAX_CHARS);
  return t ? t : undefined;
}

/** 解析/清洗上下班時間：兩端皆合法 HH:MM 且不相等才有效（相等＝無意義，視為未設）。 */
function parseWorkHours(value: unknown): OrgWorkHours | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.start !== "string" || typeof v.end !== "string") return undefined;
  if (!HHMM_RE.test(v.start) || !HHMM_RE.test(v.end) || v.start === v.end) return undefined;
  return { start: v.start, end: v.end };
}

/** `"HH:MM"` → 當日分鐘數。 */
function toMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * 是否在表定上班時間內（ADR-0157）。`minutesOfDay`＝當地時間的當日分鐘數（0–1439）。
 * 支援跨夜班表（start > end，如 22:00–06:00）：`m >= start || m < end`。
 */
export function inWorkHours(wh: OrgWorkHours, minutesOfDay: number): boolean {
  const s = toMinutes(wh.start);
  const e = toMinutes(wh.end);
  if (s < e) return minutesOfDay >= s && minutesOfDay < e;
  return minutesOfDay >= s || minutesOfDay < e;
}

/** 從任意值解析組織群組（僅保留合法項）；無有效群組回傳 undefined。 */
function parseGroups(value: unknown): OrgGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: OrgGroup[] = [];
  for (const g of value) {
    if (!g || typeof g !== "object") continue;
    const o = g as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string" || !Array.isArray(o.members)) continue;
    const members = o.members.filter((m): m is string => typeof m === "string");
    out.push({ id: o.id, name: o.name, members, ...(o.announce === true ? { announce: true } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

/** 從任意值解析政策（僅保留布林旗標）；無有效旗標回傳 undefined。 */
function parsePolicy(value: unknown): OrgPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const p: OrgPolicy = {};
  if (v.disableFiles === true) p.disableFiles = true;
  if (v.disableCalls === true) p.disableCalls = true;
  if (v.disableStickers === true) p.disableStickers = true;
  if (v.forceTurn === true) p.forceTurn = true;
  if (v.disableCloudBackup === true) p.disableCloudBackup = true;
  // ADR-0160：保留天數僅接受 1–365 整數（壞值視為未設，退回預設 7 天）。
  if (typeof v.messageTtlDays === "number" && Number.isInteger(v.messageTtlDays) && v.messageTtlDays >= 1 && v.messageTtlDays <= ORG_TTL_MAX_DAYS) {
    p.messageTtlDays = v.messageTtlDays;
  }
  // ADR-0162：relay 檔案上限僅接受 1–16 整數 MB（壞值視為未設＝關）。
  if (typeof v.relayFilesMaxMb === "number" && Number.isInteger(v.relayFilesMaxMb) && v.relayFilesMaxMb >= 1 && v.relayFilesMaxMb <= ORG_RELAY_FILE_MAX_MB) {
    p.relayFilesMaxMb = v.relayFilesMaxMb;
  }
  return Object.keys(p).length > 0 ? p : undefined;
}

/** 採用名冊所需的最小成員數（防自動化腳本清空）。 */
export const MIN_ROSTER = 1;

/** 以 pubkey 去重成員（保留首次出現），保留 relayUrl 與 supersededBy 選填欄位。 */
function dedupeMembers(members: OrgMember[]): OrgMember[] {
  const seen = new Set<string>();
  const out: OrgMember[] = [];
  for (const m of members) {
    if (seen.has(m.pubkey)) continue;
    seen.add(m.pubkey);
    const clean: OrgMember = { pubkey: m.pubkey, name: m.name };
    if (m.relayUrl) clean.relayUrl = m.relayUrl;
    if (m.supersededBy) clean.supersededBy = m.supersededBy;
    out.push(clean);
  }
  return out;
}

/** 建立並簽章一份組織名冊事件（管理者金鑰）。 */
export function signOrgRoster(doc: OrgRosterDoc, adminSk: SecretKey): NostrEvent {
  const members = dedupeMembers(doc.members);
  const policy = parsePolicy(doc.policy);
  const groups = parseGroups(doc.groups);
  const welcome = parseWelcome(doc.welcome); // ADR-0157
  const workHours = parseWorkHours(doc.workHours);
  // 共同管理者（SDK ADR 0135）：簽的人若是共同管理者，驗證端會忽略這欄——照樣寫進去無害
  const admins = parseAdmins(doc.admins, members, undefined);
  return finalizeEvent(
    {
      kind: ORG_ROSTER_KIND,
      created_at: doc.updatedAt,
      tags: [],
      content: JSON.stringify({
        org: doc.org,
        members,
        ...(policy ? { policy } : {}),
        ...(groups ? { groups } : {}),
        ...(welcome ? { welcome } : {}),
        ...(workHours ? { workHours } : {}),
        ...(admins ? { admins } : {}),
        updatedAt: doc.updatedAt,
      }),
    },
    adminSk,
  );
}

/**
 * 驗證名冊事件並取出文件；任一條件不符回傳 null：
 * kind 不符、作者不是可以簽名冊的人、簽章無效、內容非法、成員數不足。
 *
 * `trust` 是單一 pubkey（只認這一把，舊用法）或 `RosterTrust`（擁有者＋共同管理者，SDK ADR 0135）：
 * - 擁有者簽的：`admins` 取自內容（清洗過）。
 * - 共同管理者簽的：內容裡的 `admins` 忽略、換成 `trust.coAdmins`；而且名冊必須保留**每一位**共同管理者
 *   為在世成員，否則整份無效——共同管理者不能把彼此踢出組織。
 */
export function verifyOrgRoster(event: NostrEvent, trust: PubkeyHex | RosterTrust): OrgRosterDoc | null {
  const owner = typeof trust === "string" ? trust : trust.owner;
  const coAdmins = typeof trust === "string" ? [] : (trust.coAdmins ?? []).filter((pk) => pk !== owner);
  if (event.kind !== ORG_ROSTER_KIND) return null;
  const byOwner = event.pubkey === owner;
  if (!byOwner && !coAdmins.includes(event.pubkey)) return null;
  if (!verifyEvent(event)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const doc = parsed as Partial<OrgRosterDoc>;
  if (typeof doc.org !== "string" || typeof doc.updatedAt !== "number" || !Array.isArray(doc.members)) return null;
  const members = dedupeMembers(
    doc.members.filter(
      (m): m is OrgMember =>
        !!m &&
        typeof m === "object" &&
        typeof (m as OrgMember).pubkey === "string" &&
        typeof (m as OrgMember).name === "string" &&
        ((m as OrgMember).relayUrl === undefined || typeof (m as OrgMember).relayUrl === "string") &&
        ((m as OrgMember).supersededBy === undefined || typeof (m as OrgMember).supersededBy === "string"),
    ),
  );
  if (members.length < MIN_ROSTER) return null;
  let admins: PubkeyHex[] | undefined;
  if (byOwner) {
    admins = parseAdmins(doc.admins, members, owner);
  } else {
    const live = new Set(members.filter((m) => !m.supersededBy).map((m) => m.pubkey));
    if (!coAdmins.every((pk) => live.has(pk))) return null;
    admins = coAdmins.length > 0 ? [...coAdmins] : undefined;
  }
  const policy = parsePolicy(doc.policy);
  const groups = parseGroups(doc.groups);
  const welcome = parseWelcome(doc.welcome); // ADR-0157：修剪/截斷防禦；壞值視為未設
  const workHours = parseWorkHours(doc.workHours);
  return {
    org: doc.org,
    members,
    ...(policy ? { policy } : {}),
    ...(groups ? { groups } : {}),
    ...(welcome ? { welcome } : {}),
    ...(workHours ? { workHours } : {}),
    ...(admins ? { admins } : {}),
    updatedAt: doc.updatedAt,
  };
}

/**
 * 佈建輔助（ADR-0052）：把「舊→新」輪替套用到成員清單，供管理者發布名冊。
 * 每筆輪替：把舊成員標記 `supersededBy=新`（不存在則補一筆已作廢舊條目）、
 * 並確保新 npub 在列（不存在則以 `name`／舊名補入）。回傳新陣列，不改動輸入。
 */
export function applyRosterRotations(
  members: OrgMember[],
  rotations: { from: PubkeyHex; to: PubkeyHex; name?: string }[],
): OrgMember[] {
  const out = members.map((m) => ({ ...m }));
  const byKey = new Map(out.map((m) => [m.pubkey, m] as const));
  for (const { from, to, name } of rotations) {
    if (from === to) continue;
    const old = byKey.get(from);
    if (old) old.supersededBy = to;
    else {
      const added: OrgMember = { pubkey: from, name: name || "前身分", supersededBy: to };
      out.push(added);
      byKey.set(from, added);
    }
    if (!byKey.has(to)) {
      const added: OrgMember = { pubkey: to, name: name || old?.name || "成員" };
      out.push(added);
      byKey.set(to, added);
    }
  }
  return out;
}

/** 僅當候選較新（updatedAt 更大）且成員數達標時取代目前 last-known-good。 */
export function shouldAdoptRoster(current: OrgRosterDoc | null, candidate: OrgRosterDoc): boolean {
  if (candidate.members.length < MIN_ROSTER) return false;
  if (!current) return true;
  return candidate.updatedAt > current.updatedAt;
}

/**
 * 取出**在世**成員 pubkey 陣列，供 relay `allowedAuthors` 佈建（單一真實來源）。
 * 排除已輪替作廢者（`supersededBy`，ADR-0052）——舊金鑰不再放行。無輪替時行為不變。
 */
export function rosterAllowlist(doc: OrgRosterDoc): PubkeyHex[] {
  return doc.members.filter((m) => !m.supersededBy).map((m) => m.pubkey);
}

/** 一筆身分輪替對映（ADR-0052）：本機持有 `from`（舊 npub）者接續為 `to`（新 npub）。 */
export interface RosterRemap {
  from: PubkeyHex;
  to: PubkeyHex;
}

/**
 * 從名冊解出身分輪替對映（ADR-0052）。每個帶 `supersededBy` 的成員（舊 npub）順著
 * supersede 鏈解析到最終繼任者（連續輪替 A→B→C 時，A 與 B 皆對映到 C）。鏈上出現
 * 環、或最終指回自己者，略過該筆。
 */
export function rosterRemap(doc: OrgRosterDoc): RosterRemap[] {
  const byKey = new Map(doc.members.map((m) => [m.pubkey, m]));
  const out: RosterRemap[] = [];
  for (const m of doc.members) {
    if (!m.supersededBy) continue;
    const seen = new Set<string>([m.pubkey]);
    let to = m.supersededBy;
    let cyclic = false;
    while (true) {
      if (seen.has(to)) {
        cyclic = true; // 回到已訪節點（含指回自己）＝環
        break;
      }
      seen.add(to);
      const next = byKey.get(to)?.supersededBy;
      if (!next) break; // 抵達在世繼任者（或名冊未含此 key）
      to = next;
    }
    if (!cyclic) out.push({ from: m.pubkey, to });
  }
  return out;
}

/**
 * 名冊變更差異（供客戶端同步聯絡人）：相對前一份名冊——
 * - `toRemap`：本機原本認得的舊 npub 接續為新 npub（身分輪替，ADR-0052）；
 * - `toAdd`：新成員（不含 remap 目標，那已由 remap 接續而來）；
 * - `toRemove`：離職者（不含被 remap 的舊 npub，那由 remap 消化）。
 * 皆排除自己（self）。無 `supersededBy` 時 `toRemap` 為空、行為與 ADR-0047 一致。
 */
export function diffRoster(
  prev: OrgRosterDoc | null,
  next: OrgRosterDoc,
  self: PubkeyHex,
): { toAdd: OrgMember[]; toRemove: PubkeyHex[]; toRemap: RosterRemap[] } {
  const prevKeys = new Set((prev?.members ?? []).map((m) => m.pubkey));
  // 僅對「本機原本就認得舊 npub」者套用 remap（prev 有 from）；排除牽涉自己者。
  const toRemap = rosterRemap(next).filter((r) => r.from !== self && r.to !== self && prevKeys.has(r.from));
  const remapSources = new Set(toRemap.map((r) => r.from));
  const remapTargets = new Set(toRemap.map((r) => r.to));
  const liveMembers = next.members.filter((m) => !m.supersededBy);
  const nextLiveKeys = new Set(liveMembers.map((m) => m.pubkey));
  const toAdd = liveMembers.filter(
    (m) => m.pubkey !== self && !prevKeys.has(m.pubkey) && !remapTargets.has(m.pubkey),
  );
  const toRemove = [...prevKeys].filter(
    (pk) => pk !== self && !nextLiveKeys.has(pk) && !remapSources.has(pk),
  );
  return { toAdd, toRemove, toRemap };
}
