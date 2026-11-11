// NIP-86 管理 API（SDK ADR 0132；Cinderous ADR-0261）：只在自架 Node 主機提供、預設關。
//
// 三條規則，任何一條都不能放鬆：
// 1. 成員只能用**名冊金鑰簽的名冊**改（`cinder_applyroster`）——運維金鑰只是送達管道。
//    `allowpubkey` 之類一律拒絕，否則中繼能悄悄加人、客戶端驗不出來（Cinderous ADR-0047）。
// 2. 🔴 運維金鑰不得等於名冊金鑰：名冊金鑰是組織的成員權威，運維金鑰可能交給託管方。
// 3. 事件類型只改**已存在**的清單：不從空清單起建（一行指令讓整站只收一種事件）、不刪最後一個。
//
// 純邏輯、無 I/O：套用（換掉 RelayCore 的 Set）、存檔、日誌都由宿主以回呼注入。
import { rosterAllowlist, verifyHttpAuth, verifyOrgRoster, } from '../protocol/index.js';
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
/** 成員類的寫入方法：一律拒絕、指向名冊流程。 */
const MEMBER_WRITES = new Set(['allowpubkey', 'unallowpubkey', 'banpubkey', 'unbanpubkey']);
const MEMBER_WRITE_ERROR = 'membership is managed by the signed organization roster; use cinder_applyroster (Cinderous ADR-0047/0261)';
/** 管理 API 的狀態與方法分派。 */
export class Nip86Admin {
    opts;
    admins;
    rosterAdmin;
    allowed;
    kinds;
    state;
    constructor(opts) {
        this.opts = opts;
        this.admins = new Set(opts.admins);
        if (this.admins.size === 0)
            throw new Error('NIP86_ADMIN_PUBKEYS 是空的：沒有人能用的管理端點不該開（SDK ADR 0132）');
        this.rosterAdmin = opts.rosterAdmin;
        if (this.rosterAdmin !== undefined && this.admins.has(this.rosterAdmin)) {
            throw new Error('ROSTER_ADMIN_PUBKEY 不能同時是運維金鑰（NIP86_ADMIN_PUBKEYS）：名冊金鑰是成員權威，要分開保管（SDK ADR 0132 §5）');
        }
        this.allowed = opts.allowed === undefined ? undefined : [...opts.allowed];
        this.kinds = opts.allowedKinds === undefined ? undefined : [...opts.allowedKinds];
        this.state = { ...(opts.state ?? {}) };
    }
    /** 這個 pubkey 能不能呼叫管理 API。 */
    isAdmin(pubkey) {
        return this.admins.has(pubkey);
    }
    /** 實際提供的方法（NIP-86 `supportedmethods`）。 */
    supportedMethods() {
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
        if (this.rosterAdmin !== undefined)
            methods.push('cinder_applyroster');
        return methods;
    }
    /** 執行期改過的 NIP-11 欄位（宿主回應時蓋在原本的文件上）。 */
    info() {
        const out = {};
        if (this.state.name !== undefined)
            out.name = this.state.name;
        if (this.state.description !== undefined)
            out.description = this.state.description;
        return out;
    }
    /** 呼叫一個方法。`caller` 是已通過 NIP-98 的運維金鑰（只用於日誌）。 */
    call(caller, method, params) {
        const args = Array.isArray(params) ? params : [];
        if (MEMBER_WRITES.has(method))
            return { error: MEMBER_WRITE_ERROR };
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
                return this.applyRoster(caller, args[0]);
            default:
                return { error: `unsupported method: ${method.slice(0, 64)}` };
        }
    }
    commit(caller, method) {
        this.opts.save?.({ ...this.state });
        this.opts.log?.(`NIP-86：${caller.slice(0, 8)} 執行 ${method}（SDK ADR 0132）`);
    }
    applyRoster(caller, raw) {
        if (this.rosterAdmin === undefined)
            return { error: 'cinder_applyroster is disabled: ROSTER_ADMIN_PUBKEY is not set' };
        if (!isEventShape(raw))
            return { error: 'invalid: expected a signed roster event' };
        let doc;
        try {
            doc = verifyOrgRoster(raw, this.rosterAdmin);
        }
        catch {
            doc = null;
        }
        if (doc === null)
            return { error: 'invalid: not a valid roster signed by the roster admin' };
        const last = this.state.roster?.updatedAt;
        if (last !== undefined && doc.updatedAt <= last) {
            return { error: `stale: roster updatedAt ${doc.updatedAt} is not newer than the applied ${last}` };
        }
        const allowed = rosterAllowlist(doc);
        // 全部成員都輪替作廢＝白名單是空的＝整站沒人寫得進：多半是佈建錯了，不套用
        if (allowed.length === 0)
            return { error: 'refused: the roster has no active members' };
        this.allowed = allowed;
        this.state.roster = { updatedAt: doc.updatedAt, allowed };
        this.opts.apply.allowed([...allowed]);
        this.commit(caller, 'cinder_applyroster');
        return { result: { allowed: allowed.length, updatedAt: doc.updatedAt } };
    }
    allowKind(caller, raw) {
        if (!isKind(raw))
            return { error: 'invalid: kind must be an integer between 0 and 65535' };
        // 沒有清單＝全部接受：本來就允許，不起建清單（SDK ADR 0132 §6）
        if (this.kinds === undefined || this.kinds.includes(raw))
            return { result: true };
        this.setKinds([...this.kinds, raw]);
        this.commit(caller, 'allowkind');
        return { result: true };
    }
    disallowKind(caller, raw) {
        if (!isKind(raw))
            return { error: 'invalid: kind must be an integer between 0 and 65535' };
        if (this.kinds === undefined) {
            return { error: 'this relay accepts every kind; set ALLOWED_KINDS at startup to enable a kind policy' };
        }
        if (!this.kinds.includes(raw))
            return { result: true };
        if (this.kinds.length === 1)
            return { error: 'refused: removing the last allowed kind would reject every event' };
        this.setKinds(this.kinds.filter((k) => k !== raw));
        this.commit(caller, 'disallowkind');
        return { result: true };
    }
    setKinds(list) {
        this.kinds = list;
        this.state.allowedKinds = [...list];
        this.opts.apply.kinds([...list]);
    }
    changeText(caller, method, field, raw, max) {
        if (typeof raw !== 'string' || raw.trim() === '' || [...raw].length > max) {
            return { error: `invalid: ${field} must be a non-empty string of at most ${max} characters` };
        }
        this.state[field] = raw.trim();
        this.commit(caller, method);
        return { result: true };
    }
}
function isKind(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= KIND_MAX;
}
/** 結構檢查（先結構、後驗簽；同 http-auth 的 ADR-0235 C1）。 */
function isEventShape(v) {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return false;
    const e = v;
    if (!Number.isInteger(e.kind) || !Number.isInteger(e.created_at))
        return false;
    for (const f of ['id', 'pubkey', 'sig', 'content'])
        if (typeof e[f] !== 'string')
            return false;
    return Array.isArray(e.tags) && e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'));
}
/** 這個 HTTP 請求是不是 NIP-86（POST＋`application/nostr+json+rpc`）。 */
export function isNip86Request(method, contentType) {
    if ((method ?? '').toUpperCase() !== 'POST')
        return false;
    return (contentType ?? '').split(';')[0].trim().toLowerCase() === NIP86_CONTENT_TYPE;
}
/**
 * 處理一個 NIP-86 HTTP 請求：大小 → NIP-98（綁 URL、method、內容、時間）→ 解析 → 分派。
 * 授權失敗一律 401、不說原因（同 `verifyHttpAuth`）。
 */
export function handleNip86Request(admin, req, nowSec = Math.floor(Date.now() / 1000)) {
    if (new TextEncoder().encode(req.body).length > NIP86_MAX_BODY_BYTES) {
        return { status: 413, body: { error: 'payload too large' } };
    }
    const caller = authorizedCaller(admin, req, nowSec);
    if (caller === undefined)
        return { status: 401, body: { error: 'unauthorized' } };
    let parsed;
    try {
        parsed = JSON.parse(req.body);
    }
    catch {
        return { status: 400, body: { error: 'invalid JSON' } };
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.method !== 'string') {
        return { status: 400, body: { error: 'invalid request: missing method' } };
    }
    const { method, params } = parsed;
    return { status: 200, body: admin.call(caller, method, params) };
}
/** 驗 NIP-98 並確認是運維金鑰；`u` 接受 http／https、有無結尾斜線（反向代理後面分不出原本的協定）。 */
function authorizedCaller(admin, req, nowSec) {
    if (!req.authorization || !req.host)
        return undefined;
    const path = req.path === '' ? '/' : req.path;
    const paths = path === '/' ? ['/', ''] : [path, path.endsWith('/') ? path.slice(0, -1) : `${path}/`];
    for (const scheme of ['https', 'http']) {
        for (const p of paths) {
            const who = verifyHttpAuth(req.authorization, `${scheme}://${req.host}${p}`, 'POST', nowSec, { payload: req.body });
            if (who !== null)
                return admin.isAdmin(who) ? who : undefined;
        }
    }
    return undefined;
}
//# sourceMappingURL=nip86.js.map