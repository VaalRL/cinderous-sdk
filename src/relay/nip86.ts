// NIP-86 管理 API（SDK ADR 0132；Cinderous ADR-0261）：只在自架 Node 主機提供、預設關。
//
// 三條規則，任何一條都不能放鬆：
// 1. 成員只能用**名冊金鑰簽的名冊**改（`cinder_applyroster`）——運維金鑰只是送達管道。
//    `allowpubkey` 之類一律拒絕，否則中繼能悄悄加人、客戶端驗不出來（Cinderous ADR-0047）。
// 2. 🔴 運維金鑰不得等於名冊金鑰：名冊金鑰是組織的成員權威，運維金鑰可能交給託管方。
// 3. 事件類型只改**已存在**的清單：不從空清單起建（一行指令讓整站只收一種事件）、不刪最後一個。
//
// 純邏輯、無 I/O：套用（換掉 RelayCore 的 Set）、存檔、日誌都由宿主以回呼注入。
//
// 名冊有兩條送達管道，檢查完全相同（SDK ADR 0134）：
//   - 運維金鑰呼叫 `cinder_applyroster`；
//   - 名冊金鑰把名冊事件直接發到這座中繼（`applyRosterEvent`，宿主在收到事件時呼叫）。
//     只設 `ROSTER_ADMIN_PUBKEY`、不開管理 API 也能用——管理者不必經手運維金鑰。
import {
  httpAuthSigner,
  type NostrEvent,
  rosterAllowlist,
  verifyHttpAuth,
  verifyOrgRoster,
  rosterSigners,
} from '../protocol/index.js';

/** NIP-86 請求的 Content-Type。 */
export const NIP86_CONTENT_TYPE = 'application/nostr+json+rpc';
/** 請求內容上限（位元組）：一千人的名冊約 100 KiB，留十倍。 */
export const NIP86_MAX_BODY_BYTES = 1 << 20;
/** 站名上限（字元）。 */
export const NIP86_NAME_MAX = 100;
/** 說明上限（字元）。 */
export const NIP86_DESCRIPTION_MAX = 2000;
/** kind 的上限（NIP-01 的 kind 是 0–65535）。 */
const KIND_MAX = 65535;
/** 名冊的 `updatedAt` 最多能超前現在多久（秒）。客戶端為了遞增會 +1，留一天的餘裕。 */
const ROSTER_FUTURE_SKEW_SEC = 86_400;
const PERSIST_ERROR = 'internal: could not persist the change; nothing was applied';

/** 執行期改過、要存起來的東西；重開後蓋過環境變數（SDK ADR 0132 §8）。 */
export interface Nip86State {
  /**
   * `admin`＝名冊金鑰（擁有者，SDK ADR 0133）：重開後名冊金鑰換了或拿掉，這份就不再生效。
   * `coAdmins`／`ownerUpdatedAt`＝擁有者最新一份名冊列的共同管理者與那份的時間（SDK ADR 0135）。
   */
  roster?: { updatedAt: number; allowed: string[]; admin?: string; coAdmins?: string[]; ownerUpdatedAt?: number };
  allowedKinds?: number[];
  name?: string;
  description?: string;
}

/** 一次呼叫的結果：二選一。 */
export type Nip86Response = { result: unknown } | { error: string };

/** `Nip86Admin` 的設定。 */
export interface Nip86Options {
  /** 運維金鑰（hex）：可以呼叫管理 API 的人（`NIP86_ADMIN_PUBKEYS`）。 */
  admins: Iterable<string>;
  /** 名冊金鑰（hex，`ROSTER_ADMIN_PUBKEY`）：沒設＝不提供 `cinder_applyroster`。 */
  rosterAdmin?: string | undefined;
  /** 啟動時生效的白名單（環境變數，已被存檔蓋過的話是存檔的值）。 */
  allowed?: readonly string[] | undefined;
  /** 啟動時生效的事件類型清單；undefined＝全部接受。 */
  allowedKinds?: readonly number[] | undefined;
  /** 上次存的狀態（名冊的 `updatedAt` 用來擋舊名冊）。 */
  state?: Nip86State | undefined;
  /** 套用到中繼核心。 */
  apply: { allowed(list: string[]): void; kinds(list: number[]): void };
  /** 存檔（純記憶體模式不給）。 */
  save?: ((state: Nip86State) => void) | undefined;
  /** 日誌（每次成功的寫入一行；不記參數內容）。 */
  log?: ((line: string) => void) | undefined;
}

/** 成員類的寫入方法：一律拒絕、指向名冊流程。 */
const MEMBER_WRITES = new Set(['allowpubkey', 'unallowpubkey', 'banpubkey', 'unbanpubkey']);
const MEMBER_WRITE_ERROR =
  'membership is managed by the signed organization roster; use cinder_applyroster (Cinderous ADR-0047/0261)';

/** 管理 API 的狀態與方法分派。 */
export class Nip86Admin {
  private readonly admins: ReadonlySet<string>;
  private readonly rosterAdmin: string | undefined;
  private allowed: string[] | undefined;
  private kinds: number[] | undefined;
  private state: Nip86State;

  constructor(private readonly opts: Nip86Options) {
    this.admins = new Set(opts.admins);
    // 沒有運維金鑰時只剩「名冊事件自動套用」（SDK ADR 0134），那至少要有名冊金鑰。
    // 宿主在這種情況下不開 HTTP 端點（沒人能用的端點不該存在）。
    if (this.admins.size === 0 && opts.rosterAdmin === undefined) {
      throw new Error('NIP86_ADMIN_PUBKEYS 是空的：沒有人能用的管理端點不該開（SDK ADR 0132）');
    }
    this.rosterAdmin = opts.rosterAdmin;
    if (this.rosterAdmin !== undefined && this.admins.has(this.rosterAdmin)) {
      throw new Error('ROSTER_ADMIN_PUBKEY 不能同時是運維金鑰（NIP86_ADMIN_PUBKEYS）：名冊金鑰是成員權威，要分開保管（SDK ADR 0132 §5）');
    }
    this.allowed = opts.allowed === undefined ? undefined : [...opts.allowed];
    this.kinds = opts.allowedKinds === undefined ? undefined : [...opts.allowedKinds];
    this.state = { ...(opts.state ?? {}) };
  }

  /**
   * 現在可以簽名冊的 pubkey（擁有者在前，再接共同管理者；SDK ADR 0135）。沒設名冊金鑰回空陣列。
   * 宿主據此決定收到的 kind 10038 要不要交給 `applyRosterEvent`。
   */
  rosterSigners(): string[] {
    return this.rosterAdmin === undefined ? [] : rosterSigners(this.rosterAdmin, this.state.roster?.coAdmins);
  }

  /** 這個 pubkey 能不能呼叫管理 API。 */
  isAdmin(pubkey: string): boolean {
    return this.admins.has(pubkey);
  }

  /** 實際提供的方法（NIP-86 `supportedmethods`）。 */
  supportedMethods(): string[] {
    const methods = [
      'supportedmethods',
      'listallowedpubkeys',
      'listbannedpubkeys',
      'allowkind',
      'disallowkind',
      'listallowedkinds',
      'changerelayname',
      'changerelaydescription',
    ];
    if (this.rosterAdmin !== undefined) methods.push('cinder_applyroster');
    return methods;
  }

  /** 執行期改過的 NIP-11 欄位（宿主回應時蓋在原本的文件上）。 */
  info(): { name?: string; description?: string } {
    const out: { name?: string; description?: string } = {};
    if (this.state.name !== undefined) out.name = this.state.name;
    if (this.state.description !== undefined) out.description = this.state.description;
    return out;
  }

  /** 呼叫一個方法。`caller` 是已通過 NIP-98 的運維金鑰（只用於日誌）。 */
  call(caller: string, method: string, params: unknown, nowSec: number = Math.floor(Date.now() / 1000)): Nip86Response {
    const args = Array.isArray(params) ? params : [];
    if (MEMBER_WRITES.has(method)) return { error: MEMBER_WRITE_ERROR };
    switch (method) {
      case 'supportedmethods':
        return { result: this.supportedMethods() };
      case 'listallowedpubkeys':
        return { result: (this.allowed ?? []).map((pubkey) => ({ pubkey })) };
      case 'listbannedpubkeys':
        return { result: [] };
      case 'listallowedkinds':
        return { result: [...(this.kinds ?? [])] };
      case 'allowkind':
        return this.allowKind(caller, args[0]);
      case 'disallowkind':
        return this.disallowKind(caller, args[0]);
      case 'changerelayname':
        return this.changeText(caller, method, 'name', args[0], NIP86_NAME_MAX);
      case 'changerelaydescription':
        return this.changeText(caller, method, 'description', args[0], NIP86_DESCRIPTION_MAX);
      case 'cinder_applyroster':
        return this.applyRoster(caller, args[0], nowSec);
      default:
        return { error: `unsupported method: ${method.slice(0, 64)}` };
    }
  }

  /**
   * 名冊金鑰簽的名冊事件**發到了這座中繼**：照 `cinder_applyroster` 同一套檢查套用（SDK ADR 0134）。
   *
   * 不需要運維金鑰：權威本來就是名冊的簽章（Cinderous ADR-0047），運維金鑰只是另一條送達管道。
   * 舊的、重送的名冊回 `stale:` 錯誤（客戶端重新發布同一份名冊是常態，宿主不必當成問題）。
   */
  applyRosterEvent(event: unknown, nowSec: number = Math.floor(Date.now() / 1000)): Nip86Response {
    return this.applyRoster(this.rosterAdmin ?? '', event, nowSec, 'cinder_applyroster（名冊事件自動套用）');
  }

  /**
   * 先存檔、存成功才換掉記憶體裡的狀態（SDK ADR 0133）。回 `false`＝沒存成，呼叫端不得套用。
   *
   * 過去是先套用後存檔：存檔拋錯會變成「這次生效、重開就消失」，被移除的人重開後又寫得進。
   */
  private persist(next: Nip86State, caller: string, method: string): boolean {
    try {
      this.opts.save?.({ ...next });
    } catch {
      return false;
    }
    this.state = next;
    this.opts.log?.(`NIP-86：${caller.slice(0, 8)} 執行 ${method}（SDK ADR 0132）`);
    return true;
  }

  private applyRoster(caller: string, raw: unknown, nowSec: number, via = 'cinder_applyroster'): Nip86Response {
    if (this.rosterAdmin === undefined) return { error: 'cinder_applyroster is disabled: ROSTER_ADMIN_PUBKEY is not set' };
    if (!isEventShape(raw)) return { error: 'invalid: expected a signed roster event' };
    const prev = this.state.roster;
    let doc: ReturnType<typeof verifyOrgRoster>;
    try {
      // 擁有者或擁有者名冊列的共同管理者（SDK ADR 0135）
      doc = verifyOrgRoster(raw, { owner: this.rosterAdmin, coAdmins: prev?.coAdmins ?? [] });
    } catch {
      doc = null;
    }
    if (doc === null) return { error: 'invalid: not a valid roster signed by the roster admin or a co-admin' };
    // updatedAt 是秒（Cinderous 以 `created_at` 同值簽出）。不是非負整數、或遠在未來（多半是誤用毫秒）
    // 一旦存進去，之後所有正常的名冊都會被當成「舊的」，只能手動改資料庫救（SDK ADR 0133）。
    if (!Number.isInteger(doc.updatedAt) || doc.updatedAt < 0 || doc.updatedAt > nowSec + ROSTER_FUTURE_SKEW_SEC) {
      return { error: 'invalid: roster updatedAt must be a unix time in seconds, not in the future' };
    }
    // 共同管理者名單只看擁有者最新的那份（SDK ADR 0135）——即使成員那部分比已套用的舊，也照樣更新，與客戶端同一規則
    const byOwner = raw.pubkey === this.rosterAdmin;
    const ownerNewer = byOwner && (prev?.ownerUpdatedAt === undefined || doc.updatedAt > prev.ownerUpdatedAt);
    const trust = ownerNewer
      ? { ...(doc.admins ? { coAdmins: [...doc.admins] } : {}), ownerUpdatedAt: doc.updatedAt }
      : {
          ...(prev?.coAdmins ? { coAdmins: prev.coAdmins } : {}),
          ...(prev?.ownerUpdatedAt !== undefined ? { ownerUpdatedAt: prev.ownerUpdatedAt } : {}),
        };
    const last = prev?.updatedAt;
    if (last !== undefined && doc.updatedAt <= last) {
      if (ownerNewer && prev !== undefined) {
        const { coAdmins: _old, ownerUpdatedAt: _oldAt, ...base } = prev;
        if (!this.persist({ ...this.state, roster: { ...base, ...trust } }, caller, via)) return { error: PERSIST_ERROR };
      }
      return { error: `stale: roster updatedAt ${doc.updatedAt} is not newer than the applied ${last}` };
    }
    const allowed = rosterAllowlist(doc);
    // 全部成員都輪替作廢＝白名單是空的＝整站沒人寫得進：多半是佈建錯了，不套用
    if (allowed.length === 0) return { error: 'refused: the roster has no active members' };
    // 白名單以 64 個小寫 hex 比對；別的寫法（npub、大寫）永遠比不中＝那個人寫不進。整份拒絕、讓人修好再送。
    if (!allowed.every(isHexPubkey)) return { error: 'invalid: every active member pubkey must be 64 lowercase hex characters' };
    const next: Nip86State = { ...this.state, roster: { updatedAt: doc.updatedAt, allowed, admin: this.rosterAdmin, ...trust } };
    if (!this.persist(next, caller, via)) return { error: PERSIST_ERROR };
    this.allowed = allowed;
    this.opts.apply.allowed([...allowed]);
    return { result: { allowed: allowed.length, updatedAt: doc.updatedAt } };
  }

  private allowKind(caller: string, raw: unknown): Nip86Response {
    if (!isKind(raw)) return { error: 'invalid: kind must be an integer between 0 and 65535' };
    // 沒有清單＝全部接受：本來就允許，不起建清單（SDK ADR 0132 §6）
    if (this.kinds === undefined || this.kinds.includes(raw)) return { result: true };
    return this.setKinds([...this.kinds, raw], caller, 'allowkind');
  }

  private disallowKind(caller: string, raw: unknown): Nip86Response {
    if (!isKind(raw)) return { error: 'invalid: kind must be an integer between 0 and 65535' };
    if (this.kinds === undefined) {
      return { error: 'this relay accepts every kind; set ALLOWED_KINDS at startup to enable a kind policy' };
    }
    if (!this.kinds.includes(raw)) return { result: true };
    if (this.kinds.length === 1) return { error: 'refused: removing the last allowed kind would reject every event' };
    return this.setKinds(
      this.kinds.filter((k) => k !== raw),
      caller,
      'disallowkind',
    );
  }

  private setKinds(list: number[], caller: string, method: string): Nip86Response {
    if (!this.persist({ ...this.state, allowedKinds: [...list] }, caller, method)) return { error: PERSIST_ERROR };
    this.kinds = list;
    this.opts.apply.kinds([...list]);
    return { result: true };
  }

  private changeText(caller: string, method: string, field: 'name' | 'description', raw: unknown, max: number): Nip86Response {
    if (typeof raw !== 'string' || raw.trim() === '' || [...raw].length > max) {
      return { error: `invalid: ${field} must be a non-empty string of at most ${max} characters` };
    }
    if (!this.persist({ ...this.state, [field]: raw.trim() }, caller, method)) return { error: PERSIST_ERROR };
    return { result: true };
  }
}

function isHexPubkey(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/**
 * 讀回存檔時驗結構（SDK ADR 0133）。任何一格不對就**整份不用**（回 `undefined`）：
 * 壞掉的存檔不該變成政策——`allowed: "abc"` 會被逐字拆成三個「成員」、空的 `allowedKinds` 會讓整站拒收、
 * 少了 `updatedAt` 會讓舊名冊重新被接受。
 */
export function parseNip86State(json: string): Nip86State | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const out: Nip86State = {};
  if (v.roster !== undefined) {
    const r = v.roster as Record<string, unknown> | null;
    if (typeof r !== 'object' || r === null) return undefined;
    if (!Number.isInteger(r.updatedAt) || (r.updatedAt as number) < 0) return undefined;
    if (!Array.isArray(r.allowed) || r.allowed.length === 0 || !r.allowed.every(isHexPubkey)) return undefined;
    if (r.admin !== undefined && !isHexPubkey(r.admin)) return undefined;
    // 共同管理者（SDK ADR 0135）
    if (r.coAdmins !== undefined && (!Array.isArray(r.coAdmins) || !r.coAdmins.every(isHexPubkey))) return undefined;
    if (r.ownerUpdatedAt !== undefined && (!Number.isInteger(r.ownerUpdatedAt) || (r.ownerUpdatedAt as number) < 0)) return undefined;
    out.roster = { updatedAt: r.updatedAt as number, allowed: [...(r.allowed as string[])] };
    if (r.admin !== undefined) out.roster.admin = r.admin as string;
    if (r.coAdmins !== undefined) out.roster.coAdmins = [...(r.coAdmins as string[])];
    if (r.ownerUpdatedAt !== undefined) out.roster.ownerUpdatedAt = r.ownerUpdatedAt as number;
  }
  if (v.allowedKinds !== undefined) {
    if (!Array.isArray(v.allowedKinds) || v.allowedKinds.length === 0 || !v.allowedKinds.every(isKind)) return undefined;
    out.allowedKinds = [...(v.allowedKinds as number[])];
  }
  for (const [field, max] of [
    ['name', NIP86_NAME_MAX],
    ['description', NIP86_DESCRIPTION_MAX],
  ] as const) {
    const text = v[field];
    if (text === undefined) continue;
    if (typeof text !== 'string' || text === '' || [...text].length > max) return undefined;
    out[field] = text;
  }
  return out;
}

function isKind(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= KIND_MAX;
}

/** 結構檢查（先結構、後驗簽；同 http-auth 的 ADR-0235 C1）。 */
function isEventShape(v: unknown): v is NostrEvent {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (!Number.isInteger(e.kind) || !Number.isInteger(e.created_at)) return false;
  for (const f of ['id', 'pubkey', 'sig', 'content']) if (typeof e[f] !== 'string') return false;
  return Array.isArray(e.tags) && e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'));
}

/** 這個 HTTP 請求是不是 NIP-86（POST＋`application/nostr+json+rpc`）。 */
export function isNip86Request(method: string | undefined, contentType: string | undefined): boolean {
  if ((method ?? '').toUpperCase() !== 'POST') return false;
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase() === NIP86_CONTENT_TYPE;
}

/** 宿主交進來的 HTTP 請求。 */
export interface Nip86HttpRequest {
  method: string;
  contentType?: string | undefined;
  authorization?: string | undefined;
  body: string;
  /** 請求的 `Host` 標頭。⚠ 這是對方寫的——沒設 `publicUrl` 時簽章只綁到「對方自稱的主機」。 */
  host?: string | undefined;
  /**
   * 本站對外的網址（`NIP86_PUBLIC_URL`，SDK ADR 0133）。設了就**只認簽給它的請求**，不看 `host` 與 `path`：
   * 同一把運維金鑰管好幾座站時，簽給甲站的請求不能拿到乙站重送。
   */
  publicUrl?: string | undefined;
  /** 路徑（不含查詢字串）。 */
  path: string;
}

/**
 * 處理一個 NIP-86 HTTP 請求：大小 → NIP-98（綁 URL、method、內容、時間）→ 解析 → 分派。
 * 授權失敗一律 401、不說原因（同 `verifyHttpAuth`）。
 */
export function handleNip86Request(
  admin: Nip86Admin,
  req: Nip86HttpRequest,
  nowSec: number = Math.floor(Date.now() / 1000),
): { status: number; body: Nip86Response } {
  if (new TextEncoder().encode(req.body).length > NIP86_MAX_BODY_BYTES) {
    return { status: 413, body: { error: 'payload too large' } };
  }
  const caller = authorizedCaller(admin, req, nowSec);
  if (caller === undefined) return { status: 401, body: { error: 'unauthorized' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { method?: unknown }).method !== 'string') {
    return { status: 400, body: { error: 'invalid request: missing method' } };
  }
  const { method, params } = parsed as { method: string; params?: unknown };
  return { status: 200, body: admin.call(caller, method, params, nowSec) };
}

/**
 * 讀請求內容**之前**的檢查（SDK ADR 0133）：標頭是運維金鑰簽的、還在時間窗內。
 * 沒過就不必收內容——否則任何人都能讓伺服器替他緩衝 1 MiB。⚠ 這不是授權（沒綁網址與內容），
 * 通過之後仍要走 {@link handleNip86Request}。
 */
export function nip86Precheck(
  admin: Nip86Admin,
  authorization: string | null | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const who = httpAuthSigner(authorization, nowSec);
  return who !== null && admin.isAdmin(who);
}

/** 驗 NIP-98 並確認是運維金鑰；`u` 接受 http／https、有無結尾斜線（反向代理後面分不出原本的協定）。 */
function authorizedCaller(admin: Nip86Admin, req: Nip86HttpRequest, nowSec: number): string | undefined {
  if (!req.authorization) return undefined;
  const urls: string[] = [];
  if (req.publicUrl !== undefined) {
    // 只認設定的對外網址（有無結尾斜線算同一個；協定要一樣）
    const base = req.publicUrl.endsWith('/') ? req.publicUrl.slice(0, -1) : req.publicUrl;
    urls.push(`${base}/`, base);
  } else {
    if (!req.host) return undefined;
    const path = req.path === '' ? '/' : req.path;
    const paths = path === '/' ? ['/', ''] : [path, path.endsWith('/') ? path.slice(0, -1) : `${path}/`];
    for (const scheme of ['https', 'http']) for (const p of paths) urls.push(`${scheme}://${req.host}${p}`);
  }
  for (const url of urls) {
    const who = verifyHttpAuth(req.authorization, url, 'POST', nowSec, { payload: req.body });
    if (who !== null) return admin.isAdmin(who) ? who : undefined;
  }
  return undefined;
}
