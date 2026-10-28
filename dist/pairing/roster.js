// Vault 成員名單（SDK ADR 0028 §4）：互相信任的裝置清單＋共享的 Vault 金鑰。
//
// 每台裝置各自一把身分金鑰（CinderSync ADR 0003），私鑰不離開裝置；名單記的是公鑰。
// 名單是可合併的狀態（CRDT），任何一台有效成員都能改，改完以 NIP-59 送給其他成員（`NostrRosterSync`）。
//
// **每一筆都有簽章**（安全審查 #1、#3）：
//   - 裝置：裝置自己簽「我是這個 deviceId、這個名稱」（claim），把它加進來的成員再簽整筆（含加入時間）；
//     所以別的成員改不了某台裝置的 deviceId 或名稱，`addedBy`／`addedAt` 也不能冒名。
//   - 撤銷：撤銷者簽（誰撤了誰、何時）。
//   - 金鑰：建立者簽（epoch、id、建立時間、建立時的撤銷集合雜湊 `rv`）；金鑰本身以 id（SHA-256 前綴）綁定。
//
// 合併規則（每一台由同一組資料算出同一個結果）：
//   - 裝置以公鑰聯集（同一把公鑰取 (加入時間, 簽章) 較早的一筆）；撤銷以公鑰聯集、**撤銷永遠贏**；
//   - 金鑰以 id 聯集。**建立者已被撤銷的金鑰不能當「目前的金鑰」**；目前的金鑰＝有效金鑰中 epoch 最大（同 epoch 取 id 較小）。
//     合併後目前的金鑰若沒有涵蓋所有撤銷（`rv` 對不上）或建立者已被撤銷，這台就再輪換一次；
//     所以被撤銷的裝置最後一定拿不到目前的金鑰——就算它在被撤銷前自己塞了一把 epoch 很大的金鑰。
//   - epoch 不超過 2^31；新金鑰的 epoch＝**有效**金鑰的最大 epoch＋1（審查 #2：被撤銷的裝置塞的超大 epoch 不影響之後的輪換）。
//   - 超過上限時依固定規則部分保留，**不整筆拒收**（審查 #4：否則兩個分區各自加裝置後永遠不收斂）。
//
// 協調器（ADR 0025）本身**不用**共享金鑰：它對每台收件裝置各包一顆 NIP-59，需要的只是名單。
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { getEventHash } from '../protocol/event.js';
import { isPoint } from './crypto.js';
import { PairingError } from './errors.js';
import { ROSTER_STANDBY_MAX_URLS, shareableStandbyUrls } from './standby.js';
export const ROSTER_VERSION = 1;
/** 有效裝置上限 */
export const ROSTER_MAX_DEVICES = 32;
/** 撤銷紀錄上限（超過時先丟「撤銷者本身已被撤銷」的，再丟最舊的） */
export const ROSTER_MAX_REVOKED = 32;
/** 保留的金鑰數（超過時先丟建立者已被撤銷的，再丟 epoch 最小的） */
export const ROSTER_MAX_KEYS = 8;
export const ROSTER_LABEL_MAX = 40;
export const VAULT_KEY_BYTES = 32;
/** epoch 上限 */
export const ROSTER_MAX_EPOCH = 2 ** 31;
/**
 * 舊版（≤ v0.29，沒有能力宣告）的裝置經中繼收得下的單檔上限：360 塊 × 48,000 B（≈16.5 MB）。
 * 與 `sync/ingest` 的 `FILE_TIER_MAX_BYTES` 同一個數字（測試釘住；這個子路徑不匯入同步零件）。
 * 其實 v0.25–v0.29 已經收得下 64 MiB，但名單看不出來是哪一版，只能照最舊的算。
 */
export const LEGACY_MAX_RELAY_FILE_BYTES = 360 * 48_000;
/** 這一版 SDK 的版本號（`package.json` 的 version；測試釘住兩者一致） */
export const SDK_VERSION = '0.77.7';
/**
 * 這一版 SDK 的裝置能力（SDK ADR 0035 §G9）：
 * - `sdk`：SDK 版本；
 * - `maxRelayFileBytes`：經中繼收得下的單檔上限——v0.25 起收端的絕對上限 64 MiB（`RELAY_FILE_MAX_BYTES_CAP`）。
 */
export const CURRENT_DEVICE_CAPABILITIES = Object.freeze({ sdk: SDK_VERSION, maxRelayFileBytes: 64 * 1024 * 1024 });
/** 一台裝置的能力宣告，正規化 JSON 的長度上限（32 台都塞滿仍放得進歡迎訊息與名單事件的 NIP-44 明文上限） */
export const ROSTER_CAPS_MAX_JSON = 160;
const CAPS_MAX_FIELDS = 8;
const CAPS_KEY = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,24}))?$/;
/** 只用來做簽章的領域分隔 kind（不會發布） */
const SIGN_KIND = 4362;
const SIGN_LABEL = 'cinderous/roster/v1';
const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_ID = /^d[0-9a-f]{16}$/;
/** 輕量成員宣告最多幾條規則（SDK ADR 0058） */
export const ROSTER_SPARSE_MAX_PATTERNS = 16;
/** 每條規則的長度上限 */
export const ROSTER_SPARSE_MAX_PATTERN_LENGTH = 200;
/** 整份規則（JSON）的長度上限：32 台都塞滿，名單事件仍在中繼的單顆上限內 */
const ROSTER_SPARSE_MAX_JSON = 1024;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
/**
 * 輕量成員宣告的規則正規化：去掉前後空白、空行與 `#` 註解、去重；有控制字元、太長、太多 → null（不合規）。
 * 這裡只看形狀，不驗 gitignore 語法（`./pairing` 不匯入同步零件；收方編譯時不合法的規則略過）。
 */
export function normalizeSparsePatterns(patterns) {
    const out = [];
    for (const raw of patterns) {
        if (typeof raw !== 'string')
            return null;
        const p = raw.trim();
        if (p === '' || p.startsWith('#'))
            continue;
        if (p.length > ROSTER_SPARSE_MAX_PATTERN_LENGTH || CONTROL.test(p))
            return null;
        if (!out.includes(p))
            out.push(p);
    }
    if (out.length > ROSTER_SPARSE_MAX_PATTERNS || JSON.stringify(out).length > ROSTER_SPARSE_MAX_JSON)
        return null;
    return out;
}
/** 由公鑰決定的 deviceId（`d` ＋ 公鑰前 16 位 hex）：每台裝置各自一把身分，天然不重複 */
export function defaultDeviceId(pubkey) {
    return `d${pubkey.slice(0, 16)}`;
}
/** 清掉控制字元、截到上限 */
export function sanitizeLabel(label) {
    if (typeof label !== 'string')
        return '';
    // eslint-disable-next-line no-control-regex
    return [...label.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim()].slice(0, ROSTER_LABEL_MAX).join('');
}
function keyId(key) {
    return bytesToHex(sha256(key)).slice(0, 16);
}
function revokedHash(revoked) {
    return bytesToHex(sha256(utf8ToBytes([...revoked].sort().join(','))));
}
function isTime(x) {
    return Number.isSafeInteger(x) && x >= 0;
}
// ───────────────────────── 簽章 ─────────────────────────
function signContent(type, fields) {
    return JSON.stringify([SIGN_LABEL, type, ...fields]);
}
function signFields(signer, type, fields) {
    const event = signer.sign({ kind: SIGN_KIND, created_at: 0, tags: [], content: signContent(type, fields) });
    return base64.encode(hexToBytes(event.sig));
}
const verified = new Set();
function verifyFields(pubkey, type, fields, sig) {
    if (typeof sig !== 'string' || sig.length !== 88)
        return false;
    const content = signContent(type, fields);
    const cacheKey = `${pubkey}:${sig}:${content}`;
    if (verified.has(cacheKey))
        return true;
    let ok = false;
    try {
        const id = getEventHash({ pubkey, created_at: 0, kind: SIGN_KIND, tags: [], content });
        ok = schnorr.verify(base64.decode(sig), hexToBytes(id), hexToBytes(pubkey));
    }
    catch {
        ok = false;
    }
    if (ok) {
        if (verified.size > 4096)
            verified.clear();
        verified.add(cacheKey);
    }
    return ok;
}
const claimFields = (d) => [d.pubkey, d.deviceId, d.label];
const deviceFields = (vaultId, d) => [vaultId, d.pubkey, d.deviceId, d.label, d.claim, d.addedAt];
const revokeFields = (vaultId, r) => [vaultId, r.pubkey, r.at];
const keyFields = (vaultId, k) => [vaultId, k.epoch, k.id, k.at, k.rv];
const capsFields = (vaultId, c) => [vaultId, c.pubkey, canonicalCaps(c.caps), c.at];
const standbyFields = (vaultId, s) => [vaultId, s.pubkey, s.urls, s.at];
const sparseFields = (vaultId, s) => [vaultId, s.pubkey, s.patterns, s.at];
const labelFields = (vaultId, l) => [vaultId, l.pubkey, l.label, l.at];
/** 一筆改名宣告：形狀、名稱（要原本就是清理過的）、簽章都對才收；不對回 null（只丟這一筆） */
function parseLabelEntry(vaultId, raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const x = raw;
    if (!isPoint(x.pubkey) || !isTime(x.at) || typeof x.sig !== 'string' || typeof x.label !== 'string' || sanitizeLabel(x.label) !== x.label)
        return null;
    const entry = { pubkey: x.pubkey, label: x.label, at: x.at, sig: x.sig };
    return verifyFields(entry.pubkey, 'label', labelFields(vaultId, entry), entry.sig) ? entry : null;
}
/** 一筆輕量成員宣告：形狀、規則（要原本就是正規化過的）、簽章都對才收；不對回 null（只丟這一筆） */
function parseSparseEntry(vaultId, raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const x = raw;
    if (!isPoint(x.pubkey) || !isTime(x.at) || typeof x.sig !== 'string')
        return null;
    let patterns = null;
    if (x.patterns !== null) {
        const given = x.patterns;
        if (!Array.isArray(given))
            return null;
        patterns = normalizeSparsePatterns(given);
        if (!patterns || patterns.length !== given.length || patterns.some((p, i) => p !== given[i]))
            return null;
    }
    const entry = { pubkey: x.pubkey, patterns, at: x.at, sig: x.sig };
    return verifyFields(entry.pubkey, 'sparse', sparseFields(vaultId, entry), entry.sig) ? entry : null;
}
/** 一筆備援宣告：形狀、網址（要原本就是正規化過、分享得出去的）、簽章都對才收；不對回 null（只丟這一筆） */
function parseStandbyEntry(vaultId, raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const x = raw;
    const raws = x.urls;
    if (!isPoint(x.pubkey) || !isTime(x.at) || typeof x.sig !== 'string' || !Array.isArray(raws) || raws.length > ROSTER_STANDBY_MAX_URLS)
        return null;
    const urls = shareableStandbyUrls(raws);
    if (urls.length !== raws.length || urls.some((u, i) => u !== raws[i]))
        return null;
    const entry = { pubkey: x.pubkey, urls, at: x.at, sig: x.sig };
    return verifyFields(entry.pubkey, 'standby', standbyFields(vaultId, entry), entry.sig) ? entry : null;
}
/** 能力的正規化 JSON（鍵排序）：簽章與長度上限都以它為準 */
function canonicalCaps(caps) {
    return JSON.stringify(Object.fromEntries(Object.keys(caps).sort().map((k) => [k, caps[k]])));
}
/** 驗證能力的形狀；不合法回 null */
export function parseCapabilities(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return null;
    const entries = Object.entries(raw);
    if (entries.length > CAPS_MAX_FIELDS)
        return null;
    for (const [k, v] of entries) {
        if (!CAPS_KEY.test(k))
            return null;
        if (typeof v === 'string') {
            if (v.length > 24)
                return null;
        }
        else if (typeof v === 'number') {
            if (!Number.isSafeInteger(v) || v < 0)
                return null;
        }
        else if (typeof v !== 'boolean')
            return null;
    }
    const caps = Object.fromEntries(entries);
    if (typeof caps.sdk !== 'string' || !SEMVER.test(caps.sdk))
        return null;
    if (typeof caps.maxRelayFileBytes !== 'number' || caps.maxRelayFileBytes < 1)
        return null;
    if (canonicalCaps(caps).length > ROSTER_CAPS_MAX_JSON)
        return null;
    return caps;
}
/** semver 比大小（預發行版比正式版小） */
export function compareSdkVersions(a, b) {
    const ma = SEMVER.exec(a);
    const mb = SEMVER.exec(b);
    if (!ma || !mb)
        return a < b ? -1 : a > b ? 1 : 0;
    for (let i = 1; i <= 3; i += 1) {
        const d = Number(ma[i]) - Number(mb[i]);
        if (d !== 0)
            return d;
    }
    if (ma[4] === mb[4])
        return 0;
    if (ma[4] === undefined)
        return 1;
    if (mb[4] === undefined)
        return -1;
    return ma[4] < mb[4] ? -1 : 1;
}
/**
 * 裝置自己對 (公鑰, deviceId, 名稱) 的簽章。配對時新裝置送給成員，成員加入名單時一併存下；
 * 別台成員因此改不了這台的 deviceId 與名稱。
 */
export function claimDevice(signer, device) {
    return signFields(signer, 'claim', claimFields({ pubkey: signer.pubkey, deviceId: device.deviceId, label: sanitizeLabel(device.label ?? '') }));
}
export function verifyDeviceClaim(device, claim) {
    return verifyFields(device.pubkey, 'claim', claimFields(device), claim);
}
/** 驗證名單資料的每一欄與每一個簽章；不合法回 null（不信任網路來源） */
export function parseRosterData(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const r = raw;
    if (r.v !== ROSTER_VERSION || typeof r.vaultId !== 'string' || !HEX32.test(r.vaultId))
        return null;
    if (!Array.isArray(r.devices) || !Array.isArray(r.revoked) || !Array.isArray(r.keys))
        return null;
    if (r.devices.length > ROSTER_MAX_DEVICES || r.revoked.length > ROSTER_MAX_REVOKED || r.keys.length > ROSTER_MAX_KEYS)
        return null;
    const vaultId = r.vaultId;
    const devices = [];
    for (const d of r.devices) {
        if (typeof d !== 'object' || d === null)
            return null;
        const x = d;
        if (!isPoint(x.pubkey) || typeof x.deviceId !== 'string' || !DEVICE_ID.test(x.deviceId) || !isPoint(x.addedBy) || !isTime(x.addedAt))
            return null;
        if (typeof x.label !== 'string' || sanitizeLabel(x.label) !== x.label || typeof x.claim !== 'string' || typeof x.sig !== 'string')
            return null;
        const entry = { pubkey: x.pubkey, deviceId: x.deviceId, label: x.label, claim: x.claim, addedAt: x.addedAt, addedBy: x.addedBy, sig: x.sig };
        if (!verifyDeviceClaim(entry, entry.claim) || !verifyFields(entry.addedBy, 'device', deviceFields(vaultId, entry), entry.sig))
            return null;
        devices.push(entry);
    }
    const revoked = [];
    for (const d of r.revoked) {
        if (typeof d !== 'object' || d === null)
            return null;
        const x = d;
        if (!isPoint(x.pubkey) || !isPoint(x.by) || !isTime(x.at) || typeof x.sig !== 'string')
            return null;
        const entry = { pubkey: x.pubkey, at: x.at, by: x.by, sig: x.sig };
        if (!verifyFields(entry.by, 'revoke', revokeFields(vaultId, entry), entry.sig))
            return null;
        revoked.push(entry);
    }
    const keys = [];
    for (const k of r.keys) {
        if (typeof k !== 'object' || k === null)
            return null;
        const x = k;
        if (!Number.isSafeInteger(x.epoch) || x.epoch < 1 || x.epoch > ROSTER_MAX_EPOCH)
            return null;
        if (typeof x.id !== 'string' || !HEX16.test(x.id) || !isTime(x.at) || !isPoint(x.by) || typeof x.rv !== 'string' || !HEX64.test(x.rv))
            return null;
        if (typeof x.key !== 'string' || typeof x.sig !== 'string')
            return null;
        let key;
        try {
            key = base64.decode(x.key);
        }
        catch {
            return null;
        }
        if (key.length !== VAULT_KEY_BYTES || keyId(key) !== x.id)
            return null;
        const entry = { epoch: x.epoch, id: x.id, key, at: x.at, by: x.by, rv: x.rv, sig: x.sig };
        if (!verifyFields(entry.by, 'key', keyFields(vaultId, entry), entry.sig))
            return null;
        keys.push(entry);
    }
    if (keys.length === 0)
        return null;
    // 能力宣告（v0.30 起；沒有這一欄＝舊名單）：每一筆都要那台裝置自己的簽章
    const caps = [];
    if (r.caps !== undefined) {
        if (!Array.isArray(r.caps) || r.caps.length > ROSTER_MAX_DEVICES)
            return null;
        for (const c of r.caps) {
            if (typeof c !== 'object' || c === null)
                return null;
            const x = c;
            const parsedCaps = parseCapabilities(x.caps);
            if (!isPoint(x.pubkey) || !parsedCaps || !isTime(x.at) || typeof x.sig !== 'string')
                return null;
            const entry = { pubkey: x.pubkey, caps: parsedCaps, at: x.at, sig: x.sig };
            if (!verifyFields(entry.pubkey, 'caps', capsFields(vaultId, entry), entry.sig))
                return null;
            caps.push(entry);
        }
    }
    // 備援宣告（v0.45 起，SDK ADR 0056）：不合規或簽章不對的那一筆丟掉，名單其他部分照收
    //（較新的版本可能放寬規則，不能因此整份不收）
    const standby = [];
    if (Array.isArray(r.standby)) {
        for (const s of r.standby.slice(0, ROSTER_MAX_DEVICES + ROSTER_MAX_REVOKED)) {
            const entry = parseStandbyEntry(vaultId, s);
            if (entry)
                standby.push(entry);
        }
    }
    // 輕量成員宣告（v0.46 起，SDK ADR 0058）：同備援宣告，不合規的那一筆丟掉
    const sparse = [];
    if (Array.isArray(r.sparse)) {
        for (const s of r.sparse.slice(0, ROSTER_MAX_DEVICES + ROSTER_MAX_REVOKED)) {
            const entry = parseSparseEntry(vaultId, s);
            if (entry)
                sparse.push(entry);
        }
    }
    // 改名宣告（v0.52 起，SDK ADR 0069）：同備援宣告，不合規的那一筆丟掉
    const labels = [];
    if (Array.isArray(r.labels)) {
        for (const s of r.labels.slice(0, ROSTER_MAX_DEVICES + ROSTER_MAX_REVOKED)) {
            const entry = parseLabelEntry(vaultId, s);
            if (entry)
                labels.push(entry);
        }
    }
    return { vaultId, devices, revoked, keys, caps, standby, sparse, labels };
}
/** 能力（與備援）宣告取哪一個：時間較晚的（同時間取簽章較大的，各台一致） */
function later(a, b) {
    if (a.at !== b.at)
        return a.at > b.at ? a : b;
    return a.sig >= b.sig ? a : b;
}
/** 同一筆資料取哪一個：(時間, 簽章) 較早的 */
function earlier(a, b, at) {
    const ta = at(a);
    const tb = at(b);
    if (ta !== tb)
        return ta < tb ? a : b;
    return a.sig <= b.sig ? a : b;
}
/**
 * 這台裝置所屬的 Vault 成員名單與共享金鑰。修改（加入、撤銷、輪換，以及合併後的自動輪換）都要以這台的身分簽章，
 * 所以建立時要給 `signer`（例如 `Identity`；私鑰不交出）。
 *
 * 狀態含共享金鑰，屬於機密：以 `toJSON()` 匯出、存進平台的機密儲存（例如 Obsidian `app.secretStorage`），
 * **不要**寫進會被同步出去的設定檔；以 `VaultMembership.restore()` 讀回。
 */
export class VaultMembership {
    self;
    vaultId;
    #signer;
    #devices = new Map();
    #revoked = new Map();
    #keys = new Map();
    #caps = new Map();
    #standby = new Map();
    #sparse = new Map();
    #labels = new Map();
    #listeners = new Set();
    #now;
    #random;
    constructor(signer, vaultId, opts) {
        this.#signer = signer;
        this.self = signer.pubkey;
        this.vaultId = vaultId;
        this.#now = opts.now ?? (() => Date.now());
        this.#random = opts.random ?? randomBytes;
    }
    /** 建立一個新的 Vault（這台是第一台裝置） */
    static create(self, opts = {}) {
        const random = opts.random ?? randomBytes;
        const m = new VaultMembership(self.signer, bytesToHex(random(16)), opts);
        const deviceId = self.deviceId ?? defaultDeviceId(m.self);
        if (!DEVICE_ID.test(deviceId))
            throw new Error('VaultMembership：deviceId 只能用英數與 _.:-，最長 64');
        const label = sanitizeLabel(self.label ?? '');
        m.#devices.set(m.self, m.#signDevice({ pubkey: m.self, deviceId, label, claim: claimDevice(self.signer, { deviceId, label }) }));
        m.#newKey();
        return m;
    }
    /** 從名單資料建立（新裝置收到歡迎訊息時） */
    static fromRoster(signer, data, opts = {}) {
        const parsed = parseRosterData(data);
        if (!parsed)
            throw new Error('VaultMembership：名單資料不合法');
        const m = new VaultMembership(signer, parsed.vaultId, opts);
        m.#absorb(parsed);
        return m;
    }
    /** 還原 `toJSON()` 的結果；`signer` 必須是這台裝置的身分 */
    static restore(json, signer, opts = {}) {
        const raw = JSON.parse(json);
        if (raw.v !== ROSTER_VERSION || raw.self !== signer.pubkey)
            throw new Error('VaultMembership：狀態不屬於這把身分');
        return VaultMembership.fromRoster(signer, raw.roster, opts);
    }
    toJSON() {
        return JSON.stringify({ v: ROSTER_VERSION, self: this.self, roster: this.roster() });
    }
    /** 完整名單（含共享金鑰；只能經加密通道送給成員） */
    roster() {
        const byPk = (xs) => [...xs].sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
        const caps = byPk(this.#caps.values()).map((c) => ({ ...c, caps: { ...c.caps } }));
        const standby = byPk(this.#standby.values()).map((x) => ({ ...x, urls: [...x.urls] }));
        const sparse = byPk(this.#sparse.values()).map((x) => ({ ...x, patterns: x.patterns ? [...x.patterns] : null }));
        const labels = byPk(this.#labels.values()).map((x) => ({ ...x }));
        return {
            ...(caps.length > 0 ? { caps } : {}),
            ...(standby.length > 0 ? { standby } : {}),
            ...(sparse.length > 0 ? { sparse } : {}),
            ...(labels.length > 0 ? { labels } : {}),
            v: ROSTER_VERSION,
            vaultId: this.vaultId,
            devices: byPk(this.#devices.values()).map((d) => ({ ...d })),
            revoked: byPk(this.#revoked.values()).map((d) => ({ ...d })),
            keys: [...this.#keys.values()]
                .sort((a, b) => a.epoch - b.epoch || (a.id < b.id ? -1 : 1))
                .map((k) => ({ epoch: k.epoch, id: k.id, key: base64.encode(k.key), at: k.at, by: k.by, rv: k.rv, sig: k.sig })),
        };
    }
    onChange(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    // ───────────────────────── 查詢 ─────────────────────────
    /** 這台裝置還是成員（沒被撤銷、也沒有因 deviceId 相撞或超過上限被排除） */
    get active() {
        return this.#active().has(this.self);
    }
    /** 這台在名單上的那一筆；`label` 是目前的名稱（有改名宣告時用宣告的，SDK ADR 0069） */
    get selfDevice() {
        const d = this.#devices.get(this.self);
        return d ? this.#view(d) : undefined;
    }
    /**
     * 目前有效的裝置（含自己），依加入時間排序。`label` 是目前的名稱：有改名宣告時用宣告的（SDK ADR 0069），
     * `claim`、`sig` 仍是配對時那一筆的（要驗聲明請用 {@link roster} 的原始資料）。
     */
    devices() {
        return [...this.#active().values()].map((d) => this.#view(d));
    }
    isMember(pubkey) {
        return this.#active().has(pubkey);
    }
    isRevoked(pubkey) {
        return this.#revoked.has(pubkey);
    }
    revocations() {
        return [...this.#revoked.values()].map((r) => ({ ...r }));
    }
    /** 其他成員的公鑰：給 `NostrVaultTransport` 的 `devices`、`PeerNode` 的 `acceptFrom`、名單同步的收件人 */
    peerPubkeys() {
        if (!this.active)
            return [];
        return this.devices()
            .map((d) => d.pubkey)
            .filter((pk) => pk !== this.self);
    }
    /** 其他成員：協調器的 deviceId → 公鑰（給 `peerNodeLink` 的 `devices`） */
    peerDevices() {
        const out = {};
        if (!this.active)
            return out;
        for (const d of this.devices())
            if (d.pubkey !== this.self)
                out[d.deviceId] = d.pubkey;
        return out;
    }
    /** 公鑰 → deviceId（有效成員，含自己）；給 `NostrVaultTransport` 的 `deviceOf` */
    deviceIdOf(pubkey) {
        return this.#active().get(pubkey)?.deviceId;
    }
    /**
     * 自己中繼的白名單（ADR 0027 部署的 `allowedPubkeys`）：所有有效成員（含自己），加上 `extra`
     * （例如正在配對、還沒完成的新裝置）。被撤銷的公鑰一律不在裡面。
     */
    allowedPubkeys(extra = []) {
        const set = new Set(this.devices().map((d) => d.pubkey));
        for (const pk of extra)
            if (isPoint(pk) && !this.#revoked.has(pk))
                set.add(pk);
        return [...set].sort();
    }
    /** 目前的共享金鑰（加密新內容用）：建立者沒被撤銷的金鑰中 epoch 最大者 */
    currentKey() {
        const best = this.#current() ?? this.#best([...this.#keys.values()]);
        return { ...best, key: best.key.slice() };
    }
    /** 依 id 找金鑰（解開舊內容用）；已經被丟掉的回 undefined */
    key(id) {
        const k = this.#keys.get(id);
        return k ? { ...k, key: k.key.slice() } : undefined;
    }
    keys() {
        return [...this.#keys.values()].sort((a, b) => a.epoch - b.epoch).map((k) => ({ ...k, key: k.key.slice() }));
    }
    /** 由某台裝置加進來的裝置（有簽章，不能冒名）。撤銷一台被入侵的裝置時，應一併檢查它加進來的裝置 */
    devicesAddedBy(pubkey) {
        return this.devices().filter((d) => d.addedBy === pubkey && d.pubkey !== pubkey);
    }
    /** 某台有效成員宣告的能力；沒宣告（舊版）或不是成員回 undefined */
    capabilitiesOf(pubkey) {
        if (!this.isMember(pubkey))
            return undefined;
        const c = this.#caps.get(pubkey);
        return c ? { ...c.caps } : undefined;
    }
    /**
     * 所有有效成員（含自己）都支援的能力下限（SDK ADR 0035 §G9）。給協調器決定經中繼送的單檔門檻：
     * `coordinator.setMemberCapabilities(membership.minCapability())`。任何一台沒宣告就當它是舊版（16.5 MB）。
     */
    minCapability() {
        const missing = [];
        let maxRelayFileBytes = Infinity;
        let sdk;
        for (const d of this.devices()) {
            const c = this.#caps.get(d.pubkey);
            if (!c) {
                missing.push(d.pubkey);
                continue;
            }
            maxRelayFileBytes = Math.min(maxRelayFileBytes, c.caps.maxRelayFileBytes);
            if (sdk === undefined || compareSdkVersions(c.caps.sdk, sdk) < 0)
                sdk = c.caps.sdk;
        }
        if (missing.length > 0 || sdk === undefined) {
            return { maxRelayFileBytes: LEGACY_MAX_RELAY_FILE_BYTES, sdk: null, missing: missing.sort() };
        }
        return { maxRelayFileBytes, sdk, missing };
    }
    /** 某台有效成員宣告的備援（SDK ADR 0056）；沒宣告（舊版）或不是成員回 undefined。空陣列＝宣告了「沒有備援」 */
    standbyOf(pubkey) {
        if (!this.isMember(pubkey))
            return undefined;
        const s = this.#standby.get(pubkey);
        return s ? [...s.urls] : undefined;
    }
    /**
     * 其他有效成員宣告的備援（SDK ADR 0056；不含自己、沒宣告的、被撤銷的），依加入時間排序。
     * 交給 `StandbySuggestions.update({ own, declared })`／`planStandbyAdoption` 算出建議——**只是建議**，由使用者確認才採用。
     */
    declaredStandbys() {
        const out = [];
        for (const d of this.devices()) {
            if (d.pubkey === this.self)
                continue;
            const s = this.#standby.get(d.pubkey);
            if (s)
                out.push({ pubkey: d.pubkey, deviceId: d.deviceId, label: d.label, urls: [...s.urls], at: s.at });
        }
        return out;
    }
    /**
     * 某台有效成員的內容範圍（SDK ADR 0058）：輕量成員回它宣告的規則；完整成員（沒宣告、或宣告了 `null`）回 null；
     * 不是成員回 undefined。舊版裝置不會宣告，一律是完整成員。
     */
    scopeOf(pubkey) {
        if (!this.isMember(pubkey))
            return undefined;
        const s = this.#sparse.get(pubkey);
        return s?.patterns ? [...s.patterns] : null;
    }
    /** 宣告為輕量成員的有效成員（含自己），依加入時間排序。給協調器：`sync.setPeerScopes(sparsePeerScopes(membership))` */
    sparseMembers() {
        const out = [];
        for (const d of this.devices()) {
            const s = this.#sparse.get(d.pubkey);
            if (s?.patterns)
                out.push({ pubkey: d.pubkey, deviceId: d.deviceId, label: d.label, patterns: [...s.patterns], at: s.at });
        }
        return out;
    }
    /** 完整成員（沒宣告為輕量的有效成員，含舊版與自己），依加入時間排序：內容的來源 */
    fullMembers() {
        return this.devices().filter((d) => !this.#sparse.get(d.pubkey)?.patterns);
    }
    /**
     * 所有有效成員（含自己）都在能力宣告裡把 `feature` 設成 true（SDK ADR 0058／0059）。任何一台沒宣告（舊版）就是 false。
     * 例：`sync.setMergeRules(membership.allDeclare(MERGE_RULES_CAPABILITY))`。
     */
    allDeclare(feature) {
        const devices = this.devices();
        return devices.length > 0 && devices.every((d) => this.#caps.get(d.pubkey)?.caps[feature] === true);
    }
    // ───────────────────────── 修改 ─────────────────────────
    /**
     * 宣告這台裝置的能力（SDK ADR 0035 §G9；預設 {@link CURRENT_DEVICE_CAPABILITIES}）。以這台的身分簽章、放進名單，
     * 經 `NostrRosterSync` 送給其他成員。建議每次啟動呼叫一次：內容沒變就不重簽、回 false、不發 `change`。
     */
    declareCapabilities(caps = CURRENT_DEVICE_CAPABILITIES) {
        this.#requireActive();
        const parsed = parseCapabilities(caps);
        if (!parsed)
            throw new Error('VaultMembership：能力宣告格式不對（sdk 要是 semver、maxRelayFileBytes ≥ 1、最多 8 個英數欄位、總長有上限）');
        const prev = this.#caps.get(this.self);
        if (prev && canonicalCaps(prev.caps) === canonicalCaps(parsed))
            return false;
        const at = Math.max(this.#now(), (prev?.at ?? -1) + 1);
        const entry = { pubkey: this.self, caps: parsed, at };
        this.#caps.set(this.self, { ...entry, sig: signFields(this.#signer, 'caps', capsFields(this.vaultId, entry)) });
        this.#emit({ reason: 'caps', added: [], revoked: [], keyChanged: false, selfRevoked: false });
        return true;
    }
    /**
     * 宣告這台的備援中繼（SDK ADR 0056；能力宣告的延伸）。以這台的身分簽章、放進名單，經 `NostrRosterSync` 送給其他成員，
     * 別台據此**建議**使用者加入（不會自動採用）。只宣告分享得出去的：公開的 `wss://`、不帶帳密、不是本機或私有網段，
     * 正規化、去重、最多前 {@link ROSTER_STANDBY_MAX_URLS} 座；其他的照樣留在這台自己的設定，只是不分享。
     * 空陣列也會宣告（「我沒有備援」）。建議每次啟動與備援清單改變時呼叫：內容沒變就不重簽、回 false、不發 `change`。
     */
    declareStandby(urls) {
        this.#requireActive();
        const list = shareableStandbyUrls(urls);
        const prev = this.#standby.get(this.self);
        if (prev && prev.urls.length === list.length && prev.urls.every((u, i) => u === list[i]))
            return false;
        const at = Math.max(this.#now(), (prev?.at ?? -1) + 1);
        const entry = { pubkey: this.self, urls: list, at };
        this.#standby.set(this.self, { ...entry, sig: signFields(this.#signer, 'standby', standbyFields(this.vaultId, entry)) });
        this.#emit({ reason: 'caps', added: [], revoked: [], keyChanged: false, selfRevoked: false });
        return true;
    }
    /**
     * 宣告這台是輕量成員、內容範圍是 `patterns`（SDK ADR 0058）；`null`＝完整成員。以這台的身分簽章、放進名單，
     * 經 `NostrRosterSync` 送給其他成員——它們送給這台的版本，範圍外的只帶版本資訊。規則正規化（去空白、空行、註解、去重）；
     * 超過 {@link ROSTER_SPARSE_MAX_PATTERNS} 條、單條超過 {@link ROSTER_SPARSE_MAX_PATTERN_LENGTH} 字或有控制字元丟 `RangeError`。
     * 舊版成員略過這一欄（照樣送完整內容，這台照樣只保存範圍內的）。內容沒變回 false、不重簽、不發 `change`。
     */
    declareSparse(patterns) {
        this.#requireActive();
        let list = null;
        if (patterns !== null) {
            list = normalizeSparsePatterns(patterns);
            if (!list)
                throw new RangeError(`VaultMembership：輕量成員的規則不合規（最多 ${ROSTER_SPARSE_MAX_PATTERNS} 條、每條 ≤ ${ROSTER_SPARSE_MAX_PATTERN_LENGTH} 字、不能有控制字元）`);
        }
        const prev = this.#sparse.get(this.self);
        const prevList = prev?.patterns ?? null;
        const same = prevList === null ? list === null && prev !== undefined : list !== null && prevList.length === list.length && prevList.every((p, i) => p === list[i]);
        if (same || (prev === undefined && list === null))
            return false;
        const at = Math.max(this.#now(), (prev?.at ?? -1) + 1);
        const entry = { pubkey: this.self, patterns: list, at };
        this.#sparse.set(this.self, { ...entry, sig: signFields(this.#signer, 'sparse', sparseFields(this.vaultId, entry)) });
        this.#emit({ reason: 'caps', added: [], revoked: [], keyChanged: false, selfRevoked: false });
        return true;
    }
    /**
     * 改這台的名稱（SDK ADR 0069；能力宣告的延伸）。以這台的身分帶時間簽章、放進名單，經 `NostrRosterSync` 送給其他成員，
     * 較晚的蓋過；配對時簽進名單的那一筆不動（舊版成員略過這一欄，照舊顯示配對時的名稱）。名稱照 {@link sanitizeLabel} 清理。
     * 建議每次啟動與使用者改名時呼叫：和目前的名稱一樣就不重簽、回 false、不發 `change`。
     */
    declareLabel(label) {
        this.#requireActive();
        const clean = sanitizeLabel(label);
        const prev = this.#labels.get(this.self);
        if (clean === (prev?.label ?? this.#devices.get(this.self).label))
            return false;
        const at = Math.max(this.#now(), (prev?.at ?? -1) + 1);
        const entry = { pubkey: this.self, label: clean, at };
        this.#labels.set(this.self, { ...entry, sig: signFields(this.#signer, 'label', labelFields(this.vaultId, entry)) });
        this.#emit({ reason: 'caps', added: [], revoked: [], keyChanged: false, selfRevoked: false });
        return true;
    }
    /**
     * 加入一台裝置（配對成功時由 `PairingSession` 呼叫）。`claim` 是那台裝置自己的簽章（`claimDevice`）。
     * 已經在名單上回 false。
     */
    addDevice(device) {
        this.#requireActive();
        if (!isPoint(device.pubkey))
            throw new Error('VaultMembership：公鑰不合法');
        if (!DEVICE_ID.test(device.deviceId))
            throw new PairingError('device-id-conflict', 'deviceId 只能用英數與 _.:-，最長 64');
        const label = sanitizeLabel(device.label ?? '');
        if (!verifyDeviceClaim({ pubkey: device.pubkey, deviceId: device.deviceId, label }, device.claim)) {
            throw new PairingError('bad-message', '裝置的自簽聲明不符');
        }
        if (this.#revoked.has(device.pubkey))
            throw new PairingError('revoked-device', '這把公鑰已被撤銷；請在那台裝置重設身分後再配對');
        const existing = this.#devices.get(device.pubkey);
        if (existing) {
            if (existing.deviceId !== device.deviceId)
                throw new PairingError('device-id-conflict', '這台裝置已在名單上，但 deviceId 不同');
            return false;
        }
        if (DEFAULT_ID.test(device.deviceId) && device.deviceId !== defaultDeviceId(device.pubkey)) {
            throw new PairingError('device-id-conflict', `deviceId ${device.deviceId} 是保留給另一把公鑰的預設名稱`);
        }
        for (const d of this.#active().values())
            if (d.deviceId === device.deviceId)
                throw new PairingError('device-id-conflict', `deviceId ${device.deviceId} 已被另一台裝置使用`);
        if (this.#active().size >= ROSTER_MAX_DEVICES)
            throw new Error(`VaultMembership：最多 ${ROSTER_MAX_DEVICES} 台裝置`);
        this.#devices.set(device.pubkey, this.#signDevice({ pubkey: device.pubkey, deviceId: device.deviceId, label, claim: device.claim }));
        this.#emit({ reason: 'add', added: [device.pubkey], revoked: [], keyChanged: false, selfRevoked: false });
        return true;
    }
    /**
     * 撤銷一台或多台裝置，並輪換共享金鑰。被撤銷的裝置：收不到之後的名單與新金鑰、協調器不再送給它也不再收它的訊息、
     * 從白名單移除；**它已經拿到的內容與舊金鑰無法追回**。不能撤銷自己（請由另一台裝置撤銷）。
     */
    revoke(pubkeys) {
        this.#requireActive();
        const list = typeof pubkeys === 'string' ? [pubkeys] : [...pubkeys];
        const fresh = [...new Set(list)].filter((pk) => !this.#revoked.has(pk));
        if (fresh.includes(this.self))
            throw new Error('VaultMembership：不能撤銷自己');
        for (const pk of fresh)
            if (!isPoint(pk))
                throw new Error('VaultMembership：公鑰不合法');
        if (fresh.length === 0)
            return false;
        const at = this.#now();
        for (const pk of fresh) {
            this.#revoked.set(pk, { pubkey: pk, at, by: this.self, sig: signFields(this.#signer, 'revoke', revokeFields(this.vaultId, { pubkey: pk, at })) });
            this.#devices.delete(pk);
        }
        this.#trim();
        this.#newKey();
        this.#emit({ reason: 'revoke', added: [], revoked: fresh, keyChanged: true, selfRevoked: false });
        return true;
    }
    /** 手動輪換共享金鑰（不撤銷任何裝置） */
    rotateKey() {
        this.#requireActive();
        this.#newKey();
        this.#emit({ reason: 'rotate', added: [], revoked: [], keyChanged: true, selfRevoked: false });
    }
    /**
     * 合併另一台成員送來的名單。寄件人必須是目前的有效成員、Vault 相同、資料與簽章都合法，否則不動、回 false。
     * 有變動回 true（並發 `change`）。
     */
    merge(data, from) {
        if (from === this.self || !this.isMember(from))
            return false;
        const parsed = parseRosterData(data);
        if (!parsed || parsed.vaultId !== this.vaultId)
            return false;
        const before = { active: new Set(this.#active().keys()), revoked: new Set(this.#revoked.keys()), key: this.currentKey().id, serialized: this.#serialized() };
        const wasActive = this.active;
        if (!this.#absorb(parsed))
            return false;
        let keyChanged = this.currentKey().id !== before.key;
        if (this.active && this.#needsRotation()) {
            try {
                this.#newKey();
                keyChanged = true;
            }
            catch {
                // epoch 已達上限（只有還是成員的裝置塞了上限值才會發生）：等它被撤銷後再輪換
            }
        }
        const after = this.#active();
        const added = [...after.keys()].filter((pk) => !before.active.has(pk));
        const revoked = [...this.#revoked.keys()].filter((pk) => !before.revoked.has(pk));
        if (added.length === 0 && revoked.length === 0 && !keyChanged && this.#serialized() === before.serialized)
            return false;
        this.#emit({ reason: 'merge', added, revoked, keyChanged, selfRevoked: wasActive && !this.active });
        return true;
    }
    // ───────────────────────── 內部 ─────────────────────────
    #requireActive() {
        if (!this.active)
            throw new Error('VaultMembership：這台裝置已不是成員');
    }
    #serialized() {
        return JSON.stringify(this.roster());
    }
    /** 對外的一筆：複本，名稱換成改名宣告的（有的話） */
    #view(d) {
        const renamed = this.#labels.get(d.pubkey);
        return renamed ? { ...d, label: renamed.label } : { ...d };
    }
    #signDevice(d) {
        const entry = { ...d, addedAt: this.#now(), addedBy: this.self };
        return { ...entry, sig: signFields(this.#signer, 'device', deviceFields(this.vaultId, entry)) };
    }
    /** 併入（聯集、撤銷永遠贏、上限時依固定規則保留） */
    #absorb(parsed) {
        for (const k of parsed.keys)
            if (!this.#keys.has(k.id))
                this.#keys.set(k.id, k);
        for (const r of parsed.revoked) {
            const prev = this.#revoked.get(r.pubkey);
            this.#revoked.set(r.pubkey, prev ? earlier(prev, r, (x) => x.at) : r);
        }
        for (const d of parsed.devices) {
            const prev = this.#devices.get(d.pubkey);
            this.#devices.set(d.pubkey, prev ? earlier(prev, d, (x) => x.addedAt) : d);
        }
        for (const c of parsed.caps) {
            const prev = this.#caps.get(c.pubkey);
            this.#caps.set(c.pubkey, prev ? later(prev, c) : c);
        }
        for (const x of parsed.standby) {
            const prev = this.#standby.get(x.pubkey);
            this.#standby.set(x.pubkey, prev ? later(prev, x) : x);
        }
        for (const x of parsed.sparse) {
            const prev = this.#sparse.get(x.pubkey);
            this.#sparse.set(x.pubkey, prev ? later(prev, x) : x);
        }
        for (const x of parsed.labels) {
            const prev = this.#labels.get(x.pubkey);
            this.#labels.set(x.pubkey, prev ? later(prev, x) : x);
        }
        this.#trim();
        return true;
    }
    /** 上限：每一台由同一組資料算出同一個結果 */
    #trim() {
        for (const pk of this.#revoked.keys())
            this.#devices.delete(pk);
        if (this.#revoked.size > ROSTER_MAX_REVOKED) {
            // 先丟「撤銷者本身已被撤銷」的（被撤銷的裝置事先塞滿的撤銷），再丟最舊的
            const order = [...this.#revoked.values()].sort((a, b) => {
                const ra = this.#revoked.has(a.by) ? 0 : 1;
                const rb = this.#revoked.has(b.by) ? 0 : 1;
                return ra - rb || a.at - b.at || (a.pubkey < b.pubkey ? -1 : 1);
            });
            for (const r of order.slice(0, this.#revoked.size - ROSTER_MAX_REVOKED))
                this.#revoked.delete(r.pubkey);
        }
        if (this.#devices.size > ROSTER_MAX_DEVICES) {
            const order = [...this.#devices.values()].sort((a, b) => b.addedAt - a.addedAt || (a.pubkey < b.pubkey ? 1 : -1));
            for (const d of order.slice(0, this.#devices.size - ROSTER_MAX_DEVICES))
                this.#devices.delete(d.pubkey);
        }
        // 能力宣告只留名單上（沒被撤銷）的裝置的
        for (const pk of [...this.#caps.keys()])
            if (!this.#devices.has(pk))
                this.#caps.delete(pk);
        for (const pk of [...this.#standby.keys()])
            if (!this.#devices.has(pk))
                this.#standby.delete(pk);
        for (const pk of [...this.#sparse.keys()])
            if (!this.#devices.has(pk))
                this.#sparse.delete(pk);
        for (const pk of [...this.#labels.keys()])
            if (!this.#devices.has(pk))
                this.#labels.delete(pk);
        if (this.#keys.size > ROSTER_MAX_KEYS) {
            const order = [...this.#keys.values()].sort((a, b) => {
                const va = this.#keyValid(a) ? 1 : 0;
                const vb = this.#keyValid(b) ? 1 : 0;
                return va - vb || a.epoch - b.epoch || (a.id < b.id ? 1 : -1);
            });
            for (const k of order.slice(0, this.#keys.size - ROSTER_MAX_KEYS))
                this.#keys.delete(k.id);
        }
    }
    /** 金鑰的建立者是（或曾是）名單上的裝置、而且沒被撤銷 */
    #keyValid(k) {
        return this.#devices.has(k.by) && !this.#revoked.has(k.by);
    }
    #best(keys) {
        let best;
        for (const k of keys)
            if (!best || k.epoch > best.epoch || (k.epoch === best.epoch && k.id < best.id))
                best = k;
        return best;
    }
    #current() {
        return this.#best([...this.#keys.values()].filter((k) => this.#keyValid(k)));
    }
    #needsRotation() {
        const current = this.#current();
        return !current || current.rv !== revokedHash(this.#revoked.keys());
    }
    #newKey() {
        // 只看有效金鑰：被撤銷的裝置事先塞進來的超大 epoch 不影響之後的輪換
        let max = 0;
        for (const k of this.#keys.values())
            if (this.#keyValid(k))
                max = Math.max(max, k.epoch);
        const epoch = max + 1;
        if (epoch > ROSTER_MAX_EPOCH)
            throw new Error('VaultMembership：金鑰 epoch 已達上限');
        const key = this.#random(VAULT_KEY_BYTES);
        const meta = { epoch, id: keyId(key), at: this.#now(), rv: revokedHash(this.#revoked.keys()) };
        this.#keys.set(meta.id, { ...meta, key, by: this.self, sig: signFields(this.#signer, 'key', keyFields(this.vaultId, meta)) });
        this.#trim();
    }
    /**
     * 有效裝置：沒被撤銷；deviceId 相撞時（兩台同時各加一台同名的）取 (加入時間, 公鑰) 較早的，各台結果一致。
     * 別的公鑰的預設 deviceId（`d`＋公鑰前綴）不能拿來用。
     */
    #active() {
        const byId = new Map();
        const sorted = [...this.#devices.values()].sort((a, b) => a.addedAt - b.addedAt || (a.pubkey < b.pubkey ? -1 : 1));
        for (const d of sorted) {
            if (this.#revoked.has(d.pubkey) || byId.has(d.deviceId))
                continue;
            if (DEFAULT_ID.test(d.deviceId) && d.deviceId !== defaultDeviceId(d.pubkey))
                continue;
            byId.set(d.deviceId, d);
        }
        return new Map([...byId.values()].map((d) => [d.pubkey, d]));
    }
    #emit(change) {
        for (const listener of [...this.#listeners]) {
            try {
                listener(change);
            }
            catch {
                // 監聽者的例外不影響名單
            }
        }
    }
}
//# sourceMappingURL=roster.js.map