// 行級三方合併（SDK ADR 0011 §3；PRD 2.6）：兩台裝置離線各自改了同一個檔案時，
// 改到不重疊的地方就自動合併，同一塊改得不一樣才算衝突、交給 App 的衝突解決 UI。
//
// 演算法：以行為單位，Myers diff 算「共同祖先 ↔ 本機」「共同祖先 ↔ 遠端」相同的行；
// 兩邊都對得上的祖先行是「穩定行」，穩定行之間是「不穩定區塊」，逐塊判斷（Khanna 等人的 diff3）：
// 只有一邊改 → 取改的那邊；兩邊改法相同 → 取任一邊；兩邊改法不同 → 衝突。
/** Myers diff：回傳兩邊相同的行 `[a 的索引, b 的索引]`（最長共同子序列，索引遞增）。 */
export function diffLines(a, b) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    if (max === 0)
        return [];
    const offset = max;
    let v = new Array(2 * max + 1).fill(0);
    const trace = [];
    let found = false;
    for (let d = 0; d <= max && !found; d += 1) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x += 1;
                y += 1;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                found = true;
                break;
            }
        }
        if (found)
            trace.push(v.slice());
    }
    // 從終點沿著每一步的記錄往回走，收集斜線（相同的行）
    const matches = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d -= 1) {
        const prev = trace[d];
        const k = x - y;
        const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1;
        const prevX = prev[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            x -= 1;
            y -= 1;
            matches.push([x, y]);
        }
        if (d > 0) {
            x = prevX;
            y = prevY;
        }
    }
    // d = 0 的起點若有一段開頭相同的行，上面的迴圈在 d=0 時已經收掉；剩下的（x、y 同步遞減）再補一次
    while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
        x -= 1;
        y -= 1;
        matches.push([x, y]);
    }
    return matches.reverse();
}
const sameLines = (x, y) => x.length === y.length && x.every((line, i) => line === y[i]);
function chunks(base, local, remote, resolve) {
    const toLocal = new Map(diffLines(base, local));
    const toRemote = new Map(diffLines(base, remote));
    const out = [];
    const push = (lines) => {
        if (lines.length === 0)
            return;
        const last = out[out.length - 1];
        if (last?.kind === 'ok')
            last.lines.push(...lines);
        else
            out.push({ kind: 'ok', lines: [...lines] });
    };
    const unstable = (o, a, b) => {
        if (sameLines(a, o))
            push(b);
        else if (sameLines(b, o) || sameLines(a, b))
            push(a);
        else {
            // 衝突區塊交給解決規則（例如任務勾選框；SDK ADR 0059）：解得開就當作兩邊一致的行，否則照舊是衝突
            const resolved = resolve?.({ base: o, local: a, remote: b }) ?? null;
            if (resolved)
                push(resolved);
            else
                out.push({ kind: 'conflict', base: o, local: a, remote: b });
        }
    };
    let i = 0;
    let j = 0;
    let k = 0;
    while (i <= base.length) {
        // 下一個兩邊都對得上的祖先行
        let stable = i;
        while (stable < base.length && !(toLocal.has(stable) && toRemote.has(stable)))
            stable += 1;
        if (stable >= base.length) {
            unstable(base.slice(i), local.slice(j), remote.slice(k));
            break;
        }
        const lj = toLocal.get(stable);
        const rk = toRemote.get(stable);
        unstable(base.slice(i, stable), local.slice(j, lj), remote.slice(k, rk));
        push([base[stable]]);
        i = stable + 1;
        j = lj + 1;
        k = rk + 1;
    }
    return out;
}
/**
 * 逐段的三方合併（SDK ADR 0046）：與 {@link merge3} 同一套演算法，但保留每一段的位置——衝突區塊之間至少隔一行穩定行。
 * 給「把衝突就地呈現」（例如 Markdown 的衝突 callout）用。
 */
export function merge3Chunks(base, local, remote, options = {}) {
    return chunks(base.split('\n'), local.split('\n'), remote.split('\n'), options.resolve);
}
/** 三方合併：`base` 是兩邊最後一次同步時的共同版本。 */
export function merge3(base, local, remote, options = {}) {
    const result = chunks(base.split('\n'), local.split('\n'), remote.split('\n'), options.resolve);
    const conflicts = result.filter((c) => c.kind === 'conflict').map(({ base: o, local: a, remote: b }) => ({ base: o, local: a, remote: b }));
    const merged = result.flatMap((c) => (c.kind === 'ok' ? c.lines : c.local)).join('\n');
    return { clean: conflicts.length === 0, merged, conflicts };
}
/** 「雙版本合併拼接」：衝突區塊前後插入標記，兩邊全文都保留（PRD 2.6.2）。 */
export function renderWithConflictMarkers(result, labels = {}) {
    if (result.clean)
        return result.merged;
    // 重新走一次合併，衝突處換成標記。merged 已經丟掉遠端的衝突內容，所以要從衝突清單補回來。
    const out = [];
    let conflictIndex = 0;
    const mergedLines = result.merged.split('\n');
    let cursor = 0;
    for (const conflict of result.conflicts) {
        // 在 merged 裡找到這個衝突（它以本機內容佔位）的位置
        const at = findSequence(mergedLines, conflict.local, cursor);
        out.push(...mergedLines.slice(cursor, at));
        out.push(`<<<<<<< ${labels.local ?? '本機'}`, ...conflict.local, '=======', ...conflict.remote, `>>>>>>> ${labels.remote ?? '遠端'}`);
        cursor = at + conflict.local.length;
        conflictIndex += 1;
    }
    out.push(...mergedLines.slice(cursor));
    return out.join('\n');
}
function findSequence(haystack, needle, from) {
    if (needle.length === 0)
        return from;
    for (let i = from; i + needle.length <= haystack.length; i += 1) {
        if (needle.every((line, n) => haystack[i + n] === line))
            return i;
    }
    return from;
}
/**
 * 兩份沒有共同祖先的文字（例如兩台各自新建的同一天的筆記）合併時用的「虛擬共同祖先」（SDK ADR 0059）：
 * 兩邊共同的行（最長共同子序列）。以它當祖先做三方合併，等於「以空檔為祖先」再把衝突區塊精簡到真正不同的地方——
 * 兩邊都有的行只出現一次、只有一邊有的行直接採用、同一處兩邊各自新增不同的行才算衝突。
 * 祖先裡的每一行兩邊都有，所以三方合併不會刪掉任何一邊的內容。純函式：同樣的輸入得到同樣的輸出。
 */
export function commonLinesBase(local, remote) {
    const a = local.split('\n');
    return diffLines(a, remote.split('\n'))
        .map(([i]) => a[i])
        .join('\n');
}
/** Markdown 任務項目：`- [ ] 事項`、`* [x] 事項`、`1. [X] 事項`，可以縮排、可以在引言裡 */
const TASK_LINE = /^(\s*(?:>\s?)*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\](?:\s.*)?)$/;
/** Tasks 外掛勾選時附加的完成日期 */
const DONE_DATE = / ✅ (\d{4}-\d{2}-\d{2})/;
const DONE_DATE_ALL = / ✅ \d{4}-\d{2}-\d{2}/g;
function parseTaskLine(line) {
    const m = TASK_LINE.exec(line);
    if (!m)
        return null;
    const rest = m[3];
    return { key: `${m[1]}[]${rest.replace(DONE_DATE_ALL, '')}`, checked: m[2] !== ' ', done: DONE_DATE.exec(rest)?.[1] ?? null };
}
/** 兩行只差在勾選狀態（與完成日期）時取哪一行：已勾的贏；都勾了取有完成日期的、日期較早的；其餘取字典序較小的（與順序無關） */
function pickTask(a, ta, b, tb) {
    if (ta.checked !== tb.checked)
        return ta.checked ? a : b;
    if (ta.checked && (ta.done === null) !== (tb.done === null))
        return ta.done !== null ? a : b;
    if (ta.done !== null && tb.done !== null && ta.done !== tb.done)
        return ta.done < tb.done ? a : b;
    return a <= b ? a : b;
}
/**
 * 任務勾選框的衝突自動合併（SDK ADR 0059，裁示 7）：衝突區塊兩邊行數相同、而且每一行要嘛相同、要嘛只差在任務的勾選狀態
 * （`- [ ]`／`- [x]`，含 Tasks 外掛勾選時附加的 ` ✅ YYYY-MM-DD`）時，逐行合併；否則回 null（照舊是衝突）。
 *
 * - 兩邊不同的每一行都必須是同一個任務、只差在勾選（文字、縮排、項目符號有任何不同就回 null）；
 * - 祖先也是同樣行數時逐行三方：只有一邊改的那一行取改的那邊（例如一台把勾拿掉、另一台沒動那一行）；
 * - 兩邊都改了同一行（或沒有逐行對得上的祖先）：**已勾的贏**；都勾了取有完成日期的、日期較早的（第一次完成）；
 *   其餘（例如 `[x]` 與 `[X]`）取字典序較小的。只看兩行本身，與 `local`／`remote` 的順序無關，每台裝置一致。
 */
export function resolveTaskCheckboxConflict(conflict) {
    const { base, local, remote } = conflict;
    if (local.length === 0 || local.length !== remote.length)
        return null;
    const aligned = base.length === local.length;
    const out = [];
    for (let i = 0; i < local.length; i += 1) {
        const a = local[i];
        const b = remote[i];
        if (a === b) {
            out.push(a);
            continue;
        }
        // 只處理「只差在勾選」的行：其他任何不同（文字、縮排、項目符號）都照舊是衝突
        const ta = parseTaskLine(a);
        const tb = parseTaskLine(b);
        if (!ta || !tb || ta.key !== tb.key)
            return null;
        const o = aligned ? base[i] : undefined;
        if (o === a)
            out.push(b);
        else if (o === b)
            out.push(a);
        else
            out.push(pickTask(a, ta, b, tb));
    }
    return out;
}
/** 拆成「資料夾＋主檔名」與副檔名：檔名開頭的點（隱藏檔）不算副檔名，資料夾名稱裡的點也不算 */
function splitExt(path) {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    return dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
}
/**
 * 路徑被佔用時的第 `n` 個候選名稱（`n` ≥ 2）：`notes/doc.md` → `notes/doc 2.md`。
 * 協調器替衝突副本、路徑相撞找空位時用（`#freePath`）；`parseConflictCopyName` 以同一個規則拆回來（CinderSync G18）。
 */
export function freePathCandidate(path, n) {
    const [stem, ext] = splitExt(path);
    return `${stem} ${n}${ext}`;
}
/** 衝突副本檔名（PRD 2.6.1）：`[檔名] (衝突-[設備別名]-[時間戳]).[副檔名]`，時間戳用 UTC。 */
export function conflictCopyName(path, deviceLabel, at) {
    const [stem, ext] = splitExt(path);
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    const label = deviceLabel.replace(/[/\\:*?"<>|]/g, '_');
    return `${stem} (衝突-${label}-${stamp})${ext}`;
}
const COPY_FILE = /^(.+) \(衝突-(.*)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\)$/;
const NUMBERED = /^(.+) ([2-9]|[1-9]\d+)$/;
function parseExactCopy(path) {
    // 原檔沒有副檔名、裝置名稱卻含點（README＋「Joe.Mac」）時，splitExt 會把裝置名稱後半當成副檔名：再以「沒有副檔名」試一次
    const [stem, ext] = splitExt(path);
    return parseCopyParts(path, stem, ext) ?? (ext === '' ? null : parseCopyParts(path, path, ''));
}
function parseCopyParts(path, stem, ext) {
    const m = COPY_FILE.exec(stem);
    if (!m)
        return null;
    const [, origStem, label, y, mo, d, h, mi, s] = m;
    const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    if (!Number.isFinite(at))
        return null;
    const original = `${origStem}${ext}`;
    // 用 conflictCopyName 組回去：日期溢位（13 月、24:60）、裝置名稱含會被換掉的字元、拆錯位置都對不上
    if (conflictCopyName(original, label, at) !== path)
        return null;
    return { original, label, at, copyPath: path };
}
/**
 * 這個路徑是不是 `conflictCopyName` 產生的衝突副本（CinderSync G18）；是的話拆出原檔、裝置名稱、時間。
 * 也認得名稱被佔用時協調器加的編號（`freePathCandidate`，` 2`、` 3`……加在副檔名之前）。
 * 只認 SDK 組得出來的名稱：使用者自己取的「會議 (衝突-討論).md」、日期不合法的都回 null。純函式，不碰磁碟。
 */
export function parseConflictCopyName(path) {
    const exact = parseExactCopy(path);
    if (exact)
        return exact;
    const [stem, ext] = splitExt(path);
    const m = NUMBERED.exec(stem);
    if (!m)
        return null;
    const base = parseExactCopy(`${m[1]}${ext}`);
    if (!base)
        return null;
    const n = Number(m[2]);
    return freePathCandidate(base.copyPath, n) === path ? { ...base, n } : null;
}
//# sourceMappingURL=merge3.js.map