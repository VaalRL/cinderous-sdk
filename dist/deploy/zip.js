// 最小的 zip 產生器（SDK ADR 0142）：只做 STORE（不壓縮）、不加任何相依，瀏覽器與 Node 都能跑。
// 給網頁設定器把部署包（`renderDeployPackage` 的檔案）打成一個 zip 下載；部署包都是幾十 KB 的文字，不壓縮也無妨。
// 格式照 PKWARE APPNOTE 6.3.x：每個檔案一個本機標頭＋資料，最後是中央目錄與結尾紀錄；檔名以 UTF-8（通用旗標第 11 位元）。
// 不支援 ZIP64（單檔或總大小超過 4 GiB、超過 65535 個檔案）——部署包遠小於此，超過就丟錯而不是產生壞檔。
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();
/** CRC-32（IEEE 802.3，zip／gzip 用的那個） */
export function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i += 1)
        c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
/**
 * 相對路徑而且留在原目錄裡：不是絕對路徑、沒有磁碟代號、沒有反斜線、沒有 `..`／`.`／空段。
 * zip 的檔名（zip slip）與 `relay build` 清單裡的路徑共用這一條規則。
 */
export function isSafeRelativePath(path) {
    if (path === '' || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path))
        return false;
    return !path.split('/').some((p) => p === '' || p === '.' || p === '..');
}
function safePath(path) {
    if (!isSafeRelativePath(path))
        throw new Error(`zip 路徑不安全：${JSON.stringify(path)}`);
    return path;
}
/** MS-DOS 日期時間（zip 標頭用；以 UTC 表示，避免同一份輸入在不同時區產生不同位元組） */
function dosDateTime(date) {
    const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
    return {
        time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
        day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    };
}
/** 把檔案打成 STORE（不壓縮）的 zip；回傳整個檔案的位元組 */
export function createStoreZip(entries, opts = {}) {
    const encoder = new TextEncoder();
    const root = opts.root !== undefined ? `${safePath(opts.root)}/` : '';
    const { time, day } = dosDateTime(opts.date ?? new Date());
    if (entries.length > MAX_U16)
        throw new Error('zip 檔案數超過 65535（不支援 ZIP64）');
    const seen = new Set();
    const prepared = entries.map((entry) => {
        const name = root + safePath(entry.path);
        if (seen.has(name))
            throw new Error(`zip 路徑重複：${name}`);
        seen.add(name);
        const nameBytes = encoder.encode(name);
        const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
        if (nameBytes.length > MAX_U16)
            throw new Error(`zip 檔名太長：${name}`);
        return { nameBytes, data, crc: crc32(data) };
    });
    const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
    const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
    if (localSize + centralSize + 22 > MAX_U32)
        throw new Error('zip 超過 4 GiB（不支援 ZIP64）');
    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);
    const FLAGS = 0x0800; // 檔名是 UTF-8
    const VERSION = 20; // 2.0：STORE 與資料夾所需的最低版本
    let p = 0;
    const offsets = [];
    for (const e of prepared) {
        offsets.push(p);
        view.setUint32(p, 0x04034b50, true);
        view.setUint16(p + 4, VERSION, true);
        view.setUint16(p + 6, FLAGS, true);
        view.setUint16(p + 8, 0, true); // STORE
        view.setUint16(p + 10, time, true);
        view.setUint16(p + 12, day, true);
        view.setUint32(p + 14, e.crc, true);
        view.setUint32(p + 18, e.data.length, true);
        view.setUint32(p + 22, e.data.length, true);
        view.setUint16(p + 26, e.nameBytes.length, true);
        view.setUint16(p + 28, 0, true);
        out.set(e.nameBytes, p + 30);
        out.set(e.data, p + 30 + e.nameBytes.length);
        p += 30 + e.nameBytes.length + e.data.length;
    }
    const centralStart = p;
    for (const [i, e] of prepared.entries()) {
        view.setUint32(p, 0x02014b50, true);
        view.setUint16(p + 4, (3 << 8) | VERSION, true); // 由 Unix 產生：解壓時採用下面的權限位元
        view.setUint16(p + 6, VERSION, true);
        view.setUint16(p + 8, FLAGS, true);
        view.setUint16(p + 10, 0, true);
        view.setUint16(p + 12, time, true);
        view.setUint16(p + 14, day, true);
        view.setUint32(p + 16, e.crc, true);
        view.setUint32(p + 20, e.data.length, true);
        view.setUint32(p + 24, e.data.length, true);
        view.setUint16(p + 28, e.nameBytes.length, true);
        view.setUint16(p + 30, 0, true);
        view.setUint16(p + 32, 0, true);
        view.setUint16(p + 34, 0, true);
        view.setUint16(p + 36, 0, true);
        view.setUint32(p + 38, (0o100644 << 16) >>> 0, true); // 一般檔案 rw-r--r--
        view.setUint32(p + 42, offsets[i], true);
        out.set(e.nameBytes, p + 46);
        p += 46 + e.nameBytes.length;
    }
    view.setUint32(p, 0x06054b50, true);
    view.setUint16(p + 4, 0, true);
    view.setUint16(p + 6, 0, true);
    view.setUint16(p + 8, prepared.length, true);
    view.setUint16(p + 10, prepared.length, true);
    view.setUint32(p + 12, p - centralStart, true);
    view.setUint32(p + 16, centralStart, true);
    view.setUint16(p + 20, 0, true);
    return out;
}
//# sourceMappingURL=zip.js.map