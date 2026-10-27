// Markdown 的衝突 callout（SDK ADR 0046）：同一行（同一個 merge3 衝突區塊）兩邊改得不一樣時，
// 不再另存衝突副本，而是在檔案裡就地插入一個 Obsidian callout，只包住衝突的那幾行，裡面放**每一個**版本
// （標示裝置名稱與時間，依時間排序）；其他不衝突的部分照常三方合併。
//
// 硬限制：**確定性**。每台裝置對同一組版本頭必須算出位元組完全相同的結果（SDK ADR 0025 的收斂原則），
// 所以 callout 裡沒有相對字眼（「你這邊」）、時間一律 UTC、裝置名稱取自版本節點本身（`label`），
// 版本的順序只由 `(at, device, 內容)` 決定。外掛顯示時再標出哪一段是本機。
//
// 格式（`>` 開頭的連續行；最後一行是單獨的 `>`，擋掉 Markdown 的「懶惰續行」）：
//
//   > [!conflict]- 同步衝突（2 個版本） %% cinder-conflict:<id> %%
//   > **MacBook · 2026-10-01 10:32 UTC** %% cinder-version:<at>:<device> %%
//   > （該版本的衝突行，逐行加 "> "；空行是單獨的 ">"）
//   >
//   > **iPhone · 2026-10-01 10:45 UTC** %% cinder-version:<at>:<device> %%
//   > （…）
//   >
//
// 「callout 後空一行」模式（SDK ADR 0087；所有版本頭都帶標記時）：標題多一個 `%% cinder-break %%`，callout 後固定接一個空行——
// Obsidian 會把 callout 下一行的內文也算進 callout（懶惰續行），摺疊時那行看不到。解析時這個空行算進 callout，解決時一起拿掉。
// 沒開時輸出與 v0.60 位元組相同（新舊版混用時不分歧）。
//
// 合不進 callout 的內容（程式碼圍欄、front matter 裡、前後緊鄰引言、內容帶著 callout 標記、太長……）
// 退回衝突副本（舊行為）——絕不損壞內容或遺失資料。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { merge3Chunks } from '../merge3.js';
/** callout 的類型（`> [!conflict]`） */
export const CONFLICT_CALLOUT_TYPE = 'conflict';
/** 機器可解析的標記：標題行 `%% cinder-conflict:<id> %%`、每個版本 `%% cinder-version:<at>:<device> %%` */
export const CONFLICT_CALLOUT_MARKER = 'cinder-conflict';
const VERSION_MARKER = 'cinder-version';
/** 「callout 後空一行」格式的旗標（SDK ADR 0087）：在標題的 `cinder-conflict` 註解之前，舊版的解析照樣認得這個標題 */
const BREAK_FLAG = '%% cinder-break %%';
/**
 * 名單能力宣告（SDK ADR 0035 §G9）裡表示「這台開了衝突 callout」的鍵（SDK ADR 0046 §4）。只給 UI 提示用，
 * 不參與模式選擇：`declareCapabilities({ ...CURRENT_DEVICE_CAPABILITIES, [CONFLICT_CALLOUTS_CAPABILITY]: true })`。
 */
export const CONFLICT_CALLOUTS_CAPABILITY = 'conflictCallouts';
/** 一個 callout 最多放幾個版本（再衝突時會累積；超過就退回衝突副本） */
export const CONFLICT_CALLOUT_MAX_VERSIONS = 16;
/** 一個 callout 最多幾行、幾個字元（超過就退回衝突副本） */
export const CONFLICT_CALLOUT_MAX_LINES = 2000;
export const CONFLICT_CALLOUT_MAX_CHARS = 256 * 1024;
const HEADER_RE = /^> \[!conflict\][+-]?.*%% cinder-conflict:([0-9a-f]{12}) %%\s*$/;
const ENTRY_RE = /^> \*\*(.*) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC\*\* %% cinder-version:(\d{1,16}):([A-Za-z0-9_.:-]{1,64}) %%\s*$/;
const MARKER_RE = /cinder-(?:conflict|version):/;
const BREAK_RE = / %% cinder-break %% %% cinder-conflict:/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** 只有 Markdown（副檔名 `.md`，不分大小寫）用 callout；其他文字檔與二進位照舊衝突副本 */
export function isMarkdownPath(path) {
    return path.toLowerCase().endsWith('.md');
}
function pad(n, width = 2) {
    return String(n).padStart(width, '0');
}
/** `YYYY-MM-DD HH:MM`（UTC）——確定性：不看時區 */
function formatUtc(at) {
    const d = new Date(at);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
/** 裝置名稱放進粗體：控制字元換成空白、Markdown 有作用的字元加反斜線 */
function escapeLabel(label) {
    // 控制字元與 U+2028／U+2029（會被當成換行）換成空白
    const clean = [...label].map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f || c === LINE_SEP || c === PARA_SEP ? ' ' : c)).join('').trim();
    return clean.replace(/[\\`*_[\]<>#|~=%$!]/g, (c) => `\\${c}`);
}
function unescapeLabel(label) {
    return label.replace(/\\(.)/g, '$1');
}
function wrap(line) {
    return line === '' ? '>' : `> ${line}`;
}
function unwrap(line) {
    if (line === '>')
        return '';
    return line.startsWith('> ') ? line.slice(2) : line.slice(1);
}
function compareVersions(a, b) {
    if (a.at !== b.at)
        return a.at - b.at;
    if (a.device !== b.device)
        return a.device < b.device ? -1 : 1;
    const x = a.lines.join('\n');
    const y = b.lines.join('\n');
    return x < y ? -1 : x > y ? 1 : 0;
}
/** 排序並去重（同一裝置、同一時間、同樣內容只留一個；名稱取字典序最小的，確定性） */
function normalizeVersions(versions) {
    const byKey = new Map();
    for (const v of versions) {
        const key = `${v.at}\u0000${v.device}\u0000${v.lines.join('\n')}`;
        const seen = byKey.get(key);
        if (!seen || v.label < seen.label)
            byKey.set(key, { label: v.label, device: v.device, at: v.at, lines: [...v.lines] });
    }
    return [...byKey.values()].sort(compareVersions);
}
function calloutId(sorted) {
    const json = JSON.stringify(sorted.map((v) => [v.at, v.device, v.lines]));
    return bytesToHex(sha256(new TextEncoder().encode(`${CONFLICT_CALLOUT_MARKER}\u0000${json}`))).slice(0, 12);
}
/** 把版本排好、算 id、產生 callout 的每一行（LF、不含結尾換行；`calloutBreak` 時最後一行是空行） */
export function renderConflictCallout(versions, format = {}) {
    const sorted = normalizeVersions(versions);
    const id = calloutId(sorted);
    const flag = format.calloutBreak === true ? `${BREAK_FLAG} ` : '';
    const lines = [`> [!${CONFLICT_CALLOUT_TYPE}]- 同步衝突（${sorted.length} 個版本） ${flag}%% ${CONFLICT_CALLOUT_MARKER}:${id} %%`];
    for (const v of sorted) {
        const name = escapeLabel(v.label) || v.device;
        lines.push(`> **${name} · ${formatUtc(v.at)} UTC** %% ${VERSION_MARKER}:${v.at}:${v.device} %%`, ...v.lines.map(wrap), '>');
    }
    if (format.calloutBreak === true)
        lines.push('');
    return { id, lines };
}
/** callout 標題之後的 `>` 行 → 版本；沒有任何版本標頭回空陣列 */
function parseVersions(block) {
    const heads = [];
    block.forEach((line, index) => {
        const match = ENTRY_RE.exec(line);
        if (match)
            heads.push({ index, match });
    });
    return heads.map(({ index, match }, k) => {
        const end = k + 1 < heads.length ? heads[k + 1].index : block.length;
        const content = block.slice(index + 1, end);
        // 每個版本後面固定一行單獨的 `>`（分隔／結尾）
        if (content.length > 0 && unwrap(content[content.length - 1]) === '')
            content.pop();
        return { label: unescapeLabel(match[1]), at: Number(match[3]), device: match[4], lines: content.map(unwrap) };
    });
}
function stripCr(line) {
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}
/**
 * 找出文字裡所有的衝突 callout（SDK ADR 0046）。手動刪掉的 callout 自然不在結果裡（＝已解決）。
 * CRLF 也認得（比對時忽略行尾的 `\r`）。
 */
export function parseConflictCallouts(text) {
    const raw = text.split('\n');
    const lines = raw.map(stripCr);
    const offsets = [];
    let offset = 0;
    for (const line of raw) {
        offsets.push(offset);
        offset += line.length + 1;
    }
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
        const header = HEADER_RE.exec(lines[i]);
        if (!header)
            continue;
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('>') && !HEADER_RE.test(lines[j]))
            j += 1;
        const versions = parseVersions(lines.slice(i + 1, j));
        if (versions.length === 0)
            continue;
        // 新格式的 callout 後面那個空行是 callout 的一部分（SDK ADR 0087）：解決時一起拿掉，往返不多空行
        const end = BREAK_RE.test(lines[i]) && j < lines.length && lines[j] === '' ? j + 1 : j;
        out.push({ id: header[1], versions, startLine: i, endLine: end, start: offsets[i], end: end < lines.length ? offsets[end] : text.length });
        i = end - 1;
    }
    return out;
}
/** 文字整份都是 CRLF（每個 `\n` 前面都是 `\r`、沒有落單的 `\r`） */
function isPureCrlf(text) {
    return text.includes('\r\n') && !/\r(?!\n)/.test(text) && !/(^|[^\r])\n/.test(text);
}
/**
 * 解決一個衝突 callout（SDK ADR 0046）：回傳新的全文，由外掛寫回（成為新的本機版本、正常同步）。
 * 找不到 `id`（已經解決或被刪掉）丟例外；索引超出範圍丟 `RangeError`。CRLF 文件維持 CRLF。
 */
export function resolveConflictCallout(text, id, choice) {
    const crlf = isPureCrlf(text);
    const doc = crlf ? text.replace(/\r\n/g, '\n') : text;
    const callout = parseConflictCallouts(doc).find((c) => c.id === id);
    if (!callout)
        throw new Error(`找不到衝突 callout ${id}（可能已經解決）`);
    let replacement;
    if (typeof choice === 'number') {
        const version = Number.isInteger(choice) ? callout.versions[choice] : undefined;
        if (!version)
            throw new RangeError(`衝突 callout ${id} 沒有第 ${String(choice)} 個版本`);
        replacement = version.lines;
    }
    else if (choice === 'both-by-time') {
        replacement = normalizeVersions(callout.versions).flatMap((v) => v.lines);
    }
    else if (typeof choice === 'object' && choice !== null && typeof choice.text === 'string') {
        replacement = choice.text.replace(/\r\n/g, '\n').split('\n');
    }
    else {
        throw new TypeError('resolveConflictCallout：choice 要是版本索引、both-by-time 或 { text }');
    }
    const lines = doc.split('\n');
    const joined = [...lines.slice(0, callout.startLine), ...replacement, ...lines.slice(callout.endLine)].join('\n');
    return crlf ? joined.replace(/\n/g, '\r\n') : joined;
}
/**
 * 整段都是**一個**衝突 callout（再衝突時把它的版本攤開併入，不巢狀）。`calloutBreak`：新格式的 callout 連同後面的空行
 * 也算（SDK ADR 0087）；沒開時照 v0.60（多一行空行就不算，與舊版裝置算出同一個結果）。
 */
function exactCallout(input, calloutBreak = false) {
    const lines = calloutBreak && input.length > 2 && BREAK_RE.test(input[0]) && input[input.length - 1] === '' ? input.slice(0, -1) : input;
    if (lines.length < 2 || !HEADER_RE.test(lines[0]))
        return null;
    for (let i = 1; i < lines.length; i += 1)
        if (!lines[i].startsWith('>') || HEADER_RE.test(lines[i]))
            return null;
    const versions = parseVersions(lines.slice(1));
    return versions.length > 0 ? versions : null;
}
function countMatches(lines, re) {
    let n = 0;
    for (const line of lines)
        n += line.match(re)?.length ?? 0;
    return n;
}
/** 這個版本的內容放進 callout 會不會破壞結構（未閉合的圍欄、`%%` 註解、HTML 註解、數學區塊） */
function breaksCallout(lines) {
    if (lines.some((line) => line.includes('\r')))
        return true;
    if (lines.filter((line) => FENCE_RE.test(line)).length % 2 !== 0)
        return true;
    if (countMatches(lines, /%%/g) % 2 !== 0)
        return true;
    if (countMatches(lines, /\$\$/g) % 2 !== 0)
        return true;
    if (countMatches(lines, /<!--/g) !== countMatches(lines, /-->/g))
        return true;
    return false;
}
/**
 * 三方合併，衝突區塊就地換成 callout（SDK ADR 0046）。做不到（任何一處不安全）回 null，呼叫端退回衝突副本。
 * 純函式：同樣的輸入在每台裝置得到位元組相同的輸出與相同的 callout id。
 * `options.resolve`：先交給衝突解決規則（例如任務勾選框；SDK ADR 0059），解不開的才放進 callout。
 * `options.calloutBreak`：callout 後空一行的新格式（SDK ADR 0087）；呼叫端只在所有版本頭都支援時打開。
 */
export function mergeWithConflictCallouts(base, local, remote, authorOf, options = {}) {
    const calloutBreak = options.calloutBreak === true;
    const anyCr = base.includes('\r') || local.includes('\r') || remote.includes('\r');
    // 換行：三份都是 LF，或三份都是純 CRLF（轉成 LF 合併、再轉回）；混用的不碰
    const crlf = anyCr && [base, local, remote].every((t) => !t.includes('\n') || isPureCrlf(t)) && ![base, local, remote].some((t) => /\r(?!\n)/.test(t));
    if (anyCr && !crlf)
        return null;
    const norm = (t) => (crlf ? t.replace(/\r\n/g, '\n') : t);
    const chunks = merge3Chunks(norm(base), norm(local), norm(remote), options);
    const out = [];
    const ids = [];
    let inFence = null;
    let frontMatter = false;
    const push = (lines) => {
        for (const line of lines) {
            if (out.length === 0 && line === '---')
                frontMatter = true;
            else if (frontMatter && (line === '---' || line === '...'))
                frontMatter = false;
            else if (!frontMatter) {
                const fence = FENCE_RE.exec(line);
                if (fence) {
                    const marker = fence[1];
                    if (inFence === null)
                        inFence = marker;
                    else if (marker[0] === inFence[0] && marker.length >= inFence.length)
                        inFence = null;
                }
            }
            out.push(line);
        }
    };
    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (chunk.kind === 'ok') {
            push(chunk.lines);
            continue;
        }
        // 位置：程式碼圍欄裡、front matter 裡（或檔案開頭就是 front matter 被改）、前後緊鄰引言 → 不安全
        if (inFence !== null || frontMatter)
            return null;
        if (out.length === 0 && [chunk.base, chunk.local, chunk.remote].some((side) => side[0] === '---'))
            return null;
        const prev = out[out.length - 1];
        if (prev !== undefined && prev.startsWith('>'))
            return null;
        const next = chunks[i + 1];
        if (next?.kind === 'ok' && next.lines[0]?.startsWith('>'))
            return null;
        const versions = [];
        for (const [side, lines] of [['local', chunk.local], ['remote', chunk.remote]]) {
            const absorbed = exactCallout(lines, calloutBreak);
            if (absorbed) {
                versions.push(...absorbed);
                continue;
            }
            if (lines.some((line) => MARKER_RE.test(line)))
                return null; // 半個 callout、或內容本身帶著標記：不巢狀，退回副本
            versions.push({ ...authorOf(side, lines), lines: [...lines] });
        }
        const sorted = normalizeVersions(versions);
        if (sorted.length < 2) {
            push(sorted[0]?.lines ?? []);
            continue;
        }
        if (sorted.length > CONFLICT_CALLOUT_MAX_VERSIONS)
            return null;
        if (sorted.some((v) => breaksCallout(v.lines) || v.lines.some((line) => MARKER_RE.test(line))))
            return null;
        const { id, lines } = renderConflictCallout(sorted, { calloutBreak });
        if (lines.length > CONFLICT_CALLOUT_MAX_LINES || lines.reduce((n, line) => n + line.length + 1, 0) > CONFLICT_CALLOUT_MAX_CHARS)
            return null;
        out.push(...lines); // `>` 開頭的行不影響圍欄與 front matter 的狀態
        ids.push(id);
    }
    const text = out.join('\n');
    return { text: crlf ? text.replace(/\n/g, '\r\n') : text, callouts: ids };
}
//# sourceMappingURL=conflict-callout.js.map