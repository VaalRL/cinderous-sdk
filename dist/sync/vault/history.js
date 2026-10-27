// 版本歷史（SDK ADR 0063）的純函式：稀疏化與保留、容量上限、整個 Vault 回到時間點的預覽。
//
// 協調器負責歸檔的儲存（狀態儲存的 `ha:`／`hc:`／`hk:`）與執行還原；這裡只做「留哪些」「要做什麼」的決定與檢查點清單的編碼，
// 全部可重現、可單獨測試。
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
/** 保留天數的預設（裁示 1） */
export const DEFAULT_HISTORY_KEEP_DAYS = 30;
/** 每個檔案最多幾版的預設（裁示 1） */
export const DEFAULT_HISTORY_MAX_VERSIONS = 100;
/** 歸檔內容總容量上限的預設：1 GiB（裁示 1） */
export const DEFAULT_HISTORY_MAX_BYTES = 1024 ** 3;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** `restore()`、`readHistory()` 的錯誤 */
export class VaultHistoryError extends Error {
    code;
    versionId;
    constructor(code, versionId, message) {
        super(message ?? historyErrorMessage(code, versionId));
        this.name = 'VaultHistoryError';
        this.code = code;
        this.versionId = versionId;
    }
}
function historyErrorMessage(code, versionId) {
    switch (code) {
        case 'unknown':
            return `歸檔裡沒有版本 ${versionId}`;
        case 'deleted':
            return `版本 ${versionId} 是刪除，沒有內容可以還原`;
        case 'binary':
            return `版本 ${versionId} 是二進位檔：內容不在歸檔，和現在的也不同`;
        case 'content-missing':
            return `版本 ${versionId} 的內容不在歸檔，或要覆寫的現有內容不在歸檔`;
        case 'stopped':
            return '同步已停止';
        case 'checkpoint-limit':
            return `命名檢查點已經 ${MAX_NAMED_CHECKPOINTS} 個：請先刪掉不要的再建立`;
        case 'checkpoint-unknown':
            return `沒有檢查點 ${versionId}`;
        case 'checkpoint-expired':
            return `還原之前的檢查點 ${versionId} 已經過期（超過保留天數），不能再復原那次還原`;
        case 'checkpoint-name':
            return '檢查點名稱不合格（空的、超過 100 字）或已經有同名的檢查點';
    }
}
/** 命名檢查點最多幾個（裁示補充 3）：超過時拒絕建立，不自動清掉任何一個 */
export const MAX_NAMED_CHECKPOINTS = 50;
/** 自動檢查點最多多久一個（裁示補充 1） */
export const AUTO_CHECKPOINT_INTERVAL_MS = 3_600_000;
export function isVaultHistoryError(error) {
    return error instanceof VaultHistoryError;
}
export function compareHistory(a, b) {
    return a.at - b.at || a.n - b.n;
}
/**
 * 一個檔案的歸檔稀疏化（裁示 3）：
 * - 最新的一版一律留下（檔案目前的狀態）；只有最新的一版是刪除、而且超過保留天數時，整個檔案的歷史清掉。
 * - 1 小時內的全留；1 天內每個（當地）小時留最新的一版；之後到保留天數為止每個（當地）日期留最新的一版；更舊的清掉。
 *   刪除不佔區段：區段裡刪除之前的最後一版（有內容的）照留，刪除本身也留（之後沒有再出現內容時）。
 * - 稀疏化後超過 `maxVersions` 就從最舊的清。
 *
 * 「最新的一版」以 `(at, n)` 比。每個區段留下的一定是那個區段（小時或日期）最新的一版，所以同一份歸檔隔一陣子再做一次，
 * 結果和一次做到那個時間相同（不含版本數上限）。
 */
export function thinHistory(entries, now, options) {
    const sorted = [...entries].sort(compareHistory);
    if (sorted.length === 0)
        return { keep: [], drop: [] };
    const offset = options.offset ?? (() => 0);
    const keepMs = options.keepDays * DAY_MS;
    const latest = sorted[sorted.length - 1];
    if (latest.deleted && now - latest.at >= keepMs)
        return { keep: [], drop: sorted };
    const keep = [];
    const drop = [];
    let cut;
    const hours = new Set();
    const days = new Set();
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
        const e = sorted[i];
        const age = now - e.at;
        const local = e.at + offset(e.at);
        const hour = Math.floor(local / HOUR_MS);
        const day = Math.floor(local / DAY_MS);
        let kept;
        if (e === latest || age < HOUR_MS)
            kept = true;
        else if (age < DAY_MS)
            kept = !hours.has(hour);
        else if (age < keepMs)
            kept = !days.has(day);
        else {
            kept = false;
            cut = Math.max(cut ?? -Infinity, e.at);
        }
        if (kept) {
            keep.push(e);
            // 刪除沒有內容，不代表那個區段的內容狀態：同一個區段裡刪除之前的最後一版照留（「最近刪除的檔案」還原得回來）
            if (!e.deleted) {
                hours.add(hour);
                days.add(day);
            }
        }
        else
            drop.push(e);
    }
    keep.reverse();
    const max = Math.max(1, Math.floor(options.maxVersions));
    if (keep.length > max) {
        const over = keep.splice(0, keep.length - max);
        for (const e of over)
            cut = Math.max(cut ?? -Infinity, e.at);
        drop.push(...over);
    }
    return cut === undefined ? { keep, drop } : { keep, drop, cut };
}
/**
 * 歸檔內容超過總容量上限時要清掉哪些版本：從最舊的開始，每個檔案至少留最新的一版；只清有內容的
 * （沒有內容的版本清了也不省空間）。內容以雜湊去重：同一份內容的最後一個版本清掉時才算省下。
 */
export function overByteBudget(files, sizeOf, maxBytes) {
    const refs = new Map();
    for (const entries of files.values())
        for (const e of entries)
            if (e.content)
                refs.set(e.hash, (refs.get(e.hash) ?? 0) + 1);
    let total = 0;
    for (const hash of refs.keys())
        total += sizeOf(hash);
    if (total <= maxBytes)
        return [];
    const candidates = [];
    for (const [fileId, entries] of files) {
        if (entries.length < 2)
            continue;
        const sorted = [...entries].sort(compareHistory);
        for (const entry of sorted.slice(0, -1))
            if (entry.content)
                candidates.push({ fileId, entry });
    }
    candidates.sort((a, b) => compareHistory(a.entry, b.entry) || (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
    const out = [];
    for (const c of candidates) {
        if (total <= maxBytes)
            break;
        // 不計大小的內容（例如被其他東西留著）：清了也省不下
        if (sizeOf(c.entry.hash) === 0)
            continue;
        out.push(c);
        const left = refs.get(c.entry.hash) - 1;
        if (left === 0) {
            refs.delete(c.entry.hash);
            total -= sizeOf(c.entry.hash);
        }
        else
            refs.set(c.entry.hash, left);
    }
    return out;
}
/** 檔案在時間 T 的狀態：`known: false`＝歸檔沒涵蓋；`entry` 是 null＝那時不存在 */
export function fileStateAt(file, at) {
    let found;
    for (const e of file.entries) {
        if (e.at > at)
            break;
        found = e;
    }
    if (found)
        return { known: true, entry: found.deleted ? null : found };
    if (file.born !== undefined && at < file.born)
        return { known: true, entry: null };
    return { known: false };
}
function itemOf(fileId, e, from) {
    return { fileId, path: e.path, ...(from !== undefined ? { from } : {}), versionId: e.versionId, hash: e.hash, size: e.size, text: e.text, at: e.at };
}
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0;
/** 空的預覽（`addToRestorePlan` 逐檔加入、`finishRestorePlan` 收尾；協調器逐檔串流時用） */
export function emptyRestorePlan(at, now) {
    return { at, createdAt: now, revert: [], undelete: [], remove: [], keep: [], unrestorable: [], irreversibleBytes: 0 };
}
/**
 * 一個檔案加入預覽（裁示 6）。每個檔案取 `at ≤ T` 的最後一版（`state`）：
 * - T 時存在、現在也在：內容或路徑不同 → 改回（內容要拿得到：歸檔裡有，或和現在相同；要覆寫的現有內容也要在歸檔裡，覆寫了才找得回來）。
 * - T 時存在、現在刪了 → 復原（內容要在歸檔裡）。
 * - T 時不存在（確定）、現在在 → `removeCreatedAfter` 才刪（現有內容要在歸檔裡，刪了才找得回來；二進位檔只有
 *   `removeCreatedBinaries` 打開時刪，標 `irreversible`）。
 * - 歸檔沒涵蓋 T 時的狀態、現在在 → 無法還原（`out-of-range`）。
 */
export function addToRestorePlan(plan, fileId, state, cur, ctx) {
    const excluded = ctx.excluded ?? (() => false);
    const skip = (path, reason, versionId) => plan.unrestorable.push({ fileId, path, reason, ...(versionId !== undefined ? { versionId } : {}) });
    const curPath = cur.state === 'gone' ? undefined : cur.path;
    const thenPath = state.known && state.entry ? state.entry.path : undefined;
    if (ctx.include && !(thenPath !== undefined && ctx.include(thenPath)) && !(curPath !== undefined && ctx.include(curPath)))
        return;
    if (!state.known) {
        if (cur.state !== 'gone')
            skip(cur.path, 'out-of-range');
        return;
    }
    const e = state.entry;
    if (!e) {
        // T 時不存在：現在在的是之後才建立（或刪了又回來）的
        if (cur.state !== 'live')
            return;
        const size = cur.size ?? ctx.curVersion?.size ?? 0;
        const text = cur.text ?? ctx.curVersion?.text ?? true;
        const item = { fileId, path: cur.path, from: cur.path, versionId: cur.versionId, hash: cur.hash, size, text, at: ctx.curVersion?.at ?? plan.at };
        if (!ctx.removeCreatedAfter) {
            // 留著（SDK ADR 0070）：只給預覽看得到；排除的不列
            if (!excluded(cur.path))
                (plan.keep ??= []).push(item);
            return;
        }
        if (excluded(cur.path))
            skip(cur.path, 'excluded');
        else if (ctx.curArchived)
            plan.remove.push(item);
        else if (text)
            skip(cur.path, 'content-missing', cur.versionId);
        else if (ctx.removeCreatedBinaries) {
            plan.remove.push({ ...item, irreversible: true });
            plan.irreversibleBytes += size;
        }
        else
            skip(cur.path, 'binary', cur.versionId);
        return;
    }
    if (excluded(e.path)) {
        skip(e.path, 'excluded', e.versionId);
        return;
    }
    if (cur.state === 'not-local') {
        skip(e.path, cur.reason, e.versionId);
        return;
    }
    const missing = () => e.unavailable ?? (e.text ? 'content-missing' : 'binary');
    if (cur.state === 'live') {
        if (cur.path === e.path && cur.hash === e.hash)
            return;
        if (cur.hash !== e.hash) {
            if (!e.content || !ctx.thenArchived) {
                skip(e.path, missing(), e.versionId);
                return;
            }
            if (!ctx.curArchived) {
                skip(e.path, 'content-missing', e.versionId);
                return;
            }
        }
        plan.revert.push(itemOf(fileId, e, cur.path));
        return;
    }
    if (!e.content || !ctx.thenArchived)
        skip(e.path, missing(), e.versionId);
    else
        plan.undelete.push(itemOf(fileId, e));
}
/** 預覽收尾：每一類依路徑排序 */
export function finishRestorePlan(plan) {
    plan.revert.sort(byPath);
    plan.undelete.sort(byPath);
    plan.remove.sort(byPath);
    plan.keep?.sort(byPath);
    plan.unrestorable.sort(byPath);
    return plan;
}
/**
 * 整個 Vault 回到時間 T 的預覽（裁示 6）：每個檔案照 `addToRestorePlan` 判斷（見那裡的規則）。
 */
export function buildRestorePlan(at, files, current, options) {
    const plan = emptyRestorePlan(at, options.now);
    const stateOf = options.stateOf ?? ((file) => fileStateAt(file, at));
    for (const file of files) {
        const state = stateOf(file);
        const cur = current(file.fileId);
        const now = cur.state === 'live' ? file.entries.find((x) => x.versionId === cur.versionId) : undefined;
        const e = state.known ? state.entry : null;
        addToRestorePlan(plan, file.fileId, state, cur, {
            ...(options.removeCreatedAfter !== undefined ? { removeCreatedAfter: options.removeCreatedAfter } : {}),
            ...(options.removeCreatedBinaries !== undefined ? { removeCreatedBinaries: options.removeCreatedBinaries } : {}),
            ...(options.include ? { include: options.include } : {}),
            ...(options.excluded ? { excluded: options.excluded } : {}),
            curArchived: cur.state === 'live' && options.archived(cur.hash),
            thenArchived: e !== null && options.archived(e.hash),
            ...(now ? { curVersion: { size: now.size, text: now.text, at: now.at } } : {}),
        });
    }
    return finishRestorePlan(plan);
}
const HEX = /^(?:[0-9a-f]{2})+$/;
/** 小寫 hex 的 id／雜湊改成 base64url（短 1/3）；不是 hex 的原樣、前面加 `~` */
function packId(id) {
    return HEX.test(id) ? base64urlnopad.encode(hexToBytes(id)) : `~${id}`;
}
function unpackId(s) {
    return s.startsWith('~') ? s.slice(1) : bytesToHex(base64urlnopad.decode(s));
}
function sharedPrefix(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a.charCodeAt(i) === b.charCodeAt(i))
        i += 1;
    // 不要切在 UTF-16 代理對中間
    if (i > 0 && i < a.length && a.charCodeAt(i - 1) >= 0xd800 && a.charCodeAt(i - 1) <= 0xdbff)
        i -= 1;
    return i;
}
function encodeRows(files) {
    const sorted = [...files].sort(([fa, a], [fb, b]) => (a.path < b.path ? -1 : a.path > b.path ? 1 : fa < fb ? -1 : fa > fb ? 1 : 0));
    const rows = [];
    let prev = '';
    for (const [fileId, f] of sorted) {
        const k = sharedPrefix(prev, f.path);
        rows.push([packId(fileId), k >= 3 ? [k, f.path.slice(k)] : f.path, packId(f.versionId), packId(f.hash), f.size, (f.text ? 1 : 0) | (f.local ? 0 : 2)]);
        prev = f.path;
    }
    return rows;
}
function decodeRows(rows, into) {
    let prev = '';
    for (const [fid, p, vid, hash, size, flags] of rows) {
        const path = typeof p === 'string' ? p : prev.slice(0, p[0]) + p[1];
        prev = path;
        into.set(unpackId(fid), { path, versionId: unpackId(vid), hash: unpackId(hash), size, text: (flags & 1) === 1, local: (flags & 2) === 0 });
    }
}
const sameFile = (a, b) => a.path === b.path && a.versionId === b.versionId && a.hash === b.hash && a.size === b.size && a.text === b.text && a.local === b.local;
/** 完整的清單 */
export function encodeManifest(manifest) {
    return { s: encodeRows(manifest) };
}
/** `next` 相對於 `prev` 的差異（沒有差異時 `s`、`d` 都是空的） */
export function diffManifest(prev, next) {
    const changed = [];
    for (const [id, f] of next) {
        const old = prev.get(id);
        if (!old || !sameFile(old, f))
            changed.push([id, f]);
    }
    const removed = [...prev.keys()].filter((id) => !next.has(id)).sort();
    return { s: encodeRows(changed), d: removed.map(packId) };
}
/** 差異是空的（兩個清單相同） */
export function isEmptyDiff(diff) {
    return diff.s.length === 0 && (diff.d?.length ?? 0) === 0;
}
/** 解出清單：完整的直接解；差異套在 `base` 上（`base` 不會被改） */
export function decodeManifest(encoded, base) {
    const out = new Map(encoded.d !== undefined && base ? base : []);
    for (const id of encoded.d ?? [])
        out.delete(unpackId(id));
    decodeRows(encoded.s, out);
    return out;
}
//# sourceMappingURL=history.js.map