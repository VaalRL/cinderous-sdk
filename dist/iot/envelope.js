// 設備信封（SDK ADR 0049 §2.6）：路線 C／C′ 的端到端加密。relay 只看得到信封的明文欄位，看不到 topic、指令與狀態值。
//
//   { "v": 1, "alg": "A256GCM", "kid": "<設備 id>.<epoch>", "dir": "down|up", "ctr": <整數>, "ts": <unix 秒>,
//     "nonce": "<12 bytes base64>", "ct": "<base64，含 16 bytes tag>" }
//
// - AAD＝`cinder-iot/v1|<dir>|<kid>|<ctr>|<ts>`（UTF-8）——這些欄位被竄改就解不開。
// - nonce 分區：down（手機 → 設備）＝0x00＋11 bytes 隨機；up（設備 → 手機）＝0x01＋3 個零＋8 bytes 大端 ctr。
//   兩個方向的 nonce 空間不相交，同一把金鑰不會重用 nonce；解開時也檢查 nonce 與 dir／ctr 一致，不接受「借用」別的分區。
// - base64 用標準字母、有補齊（Berry、mbedtls、Python 都內建）。
//
// 純函式、零 Node 內建模組（可在 Workers、瀏覽器、設備模擬器使用）。
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { iotHomeSecretBytes } from './keys.js';
export const IOT_ENVELOPE_VERSION = 1;
export const IOT_ENVELOPE_ALG = 'A256GCM';
/** 信封明文上限（bytes）：retained 以單顆 32 KB 為限（車道可尋址上限），密文＋base64＋外層 NIP-44 都要放得進去 */
export const IOT_ENVELOPE_MAX_PLAINTEXT_BYTES = 16 * 1024;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const AAD_PREFIX = 'cinder-iot/v1';
const INFO_DEVICE_DOWN = 'cinder-iot/v1/device-key-down';
/** 信封解不開（`code`：格式不對／nonce 與方向或計數器不符／驗證失敗） */
export class IotEnvelopeError extends Error {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
        this.name = 'IotEnvelopeError';
    }
}
const KID_PATTERN = /^(.+)\.(0|[1-9][0-9]*)$/;
/** `kid`＝`<設備 id>.<epoch>`（設備 id 可以含點，以最後一個點切） */
export function iotKid(deviceId, epoch) {
    if (deviceId.length === 0)
        throw new RangeError('設備 id 不可為空');
    if (!Number.isSafeInteger(epoch) || epoch < 0)
        throw new RangeError(`epoch 必須是非負整數（收到 ${String(epoch)}）`);
    return `${deviceId}.${epoch}`;
}
/** 解析 `kid`；不合法回 undefined */
export function parseIotKid(kid) {
    const m = KID_PATTERN.exec(kid);
    if (!m)
        return undefined;
    const epoch = Number(m[2]);
    return Number.isSafeInteger(epoch) ? { deviceId: m[1], epoch } : undefined;
}
/** AAD 字串（設備端照這個格式組，逐字相同） */
export function iotEnvelopeAad(env) {
    return `${AAD_PREFIX}|${env.dir}|${env.kid}|${env.ctr}|${env.ts}`;
}
/**
 * 門鎖類設備（`class: 'lock'`）down 方向的金鑰（ADR 0049 §9.5）：只發給 operator／owner 的 `operatorSecret` 導出——
 * 「viewer＋被攻破的 relay」也做不出設備解得開的指令。up 方向仍用 {@link deriveIotDeviceKey}。
 */
export function deriveIotDeviceKeyDown(operatorSecret, deviceId, epoch = 0) {
    if (!Number.isInteger(epoch) || epoch < 0)
        throw new RangeError(`epoch 必須是非負整數（收到 ${String(epoch)}）`);
    return hkdf(sha256, iotHomeSecretBytes(operatorSecret), new Uint8Array(0), utf8ToBytes(`${INFO_DEVICE_DOWN}|${deviceId}|${epoch}`), KEY_BYTES);
}
function upNonce(ctr) {
    const nonce = new Uint8Array(NONCE_BYTES);
    nonce[0] = 0x01;
    let n = BigInt(ctr);
    for (let i = NONCE_BYTES - 1; i >= 4; i--) {
        nonce[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    return nonce;
}
function nonceFits(nonce, dir, ctr) {
    if (nonce.length !== NONCE_BYTES)
        return false;
    if (dir === 'down')
        return nonce[0] === 0x00;
    const expected = upNonce(ctr);
    return nonce.every((b, i) => b === expected[i]);
}
function checkInteger(name, value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`${name} 必須是非負安全整數（收到 ${String(value)}）`);
}
/** 封裝一個設備信封 */
export function sealIotEnvelope(input) {
    if (input.key.length !== KEY_BYTES)
        throw new RangeError(`設備金鑰必須是 ${KEY_BYTES} bytes`);
    if (!parseIotKid(input.kid))
        throw new RangeError(`kid 格式不對：${input.kid}`);
    checkInteger('ctr', input.ctr);
    checkInteger('ts', input.ts);
    const plaintext = typeof input.plaintext === 'string' ? utf8ToBytes(input.plaintext) : input.plaintext;
    if (plaintext.length > IOT_ENVELOPE_MAX_PLAINTEXT_BYTES) {
        throw new RangeError(`信封明文超過上限 ${IOT_ENVELOPE_MAX_PLAINTEXT_BYTES} bytes（收到 ${plaintext.length}）`);
    }
    let nonce;
    if (input.dir === 'up') {
        if (input.nonce !== undefined)
            throw new IotEnvelopeError('nonce', 'up 方向的 nonce 由 ctr 算出，不可指定');
        nonce = upNonce(input.ctr);
    }
    else {
        nonce = input.nonce ?? (() => {
            const r = randomBytes(NONCE_BYTES);
            r[0] = 0x00;
            return r;
        })();
        if (!nonceFits(nonce, 'down', input.ctr))
            throw new IotEnvelopeError('nonce', 'down 方向的 nonce 必須 12 bytes 且以 0x00 開頭');
    }
    const header = { dir: input.dir, kid: input.kid, ctr: input.ctr, ts: input.ts };
    const ct = gcm(input.key, nonce, utf8ToBytes(iotEnvelopeAad(header))).encrypt(plaintext);
    return { v: IOT_ENVELOPE_VERSION, alg: IOT_ENVELOPE_ALG, kid: input.kid, dir: input.dir, ctr: input.ctr, ts: input.ts, nonce: base64.encode(nonce), ct: base64.encode(ct) };
}
function decodeBase64(value) {
    if (typeof value !== 'string')
        return undefined;
    try {
        return base64.decode(value);
    }
    catch {
        return undefined;
    }
}
/** 驗證信封形狀（不解密）；不合法回 undefined。relay 轉送前用它擋掉壞信封 */
export function parseIotEnvelope(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const o = value;
    if (o.v !== IOT_ENVELOPE_VERSION || o.alg !== IOT_ENVELOPE_ALG)
        return undefined;
    if (typeof o.kid !== 'string' || !parseIotKid(o.kid))
        return undefined;
    if (o.dir !== 'down' && o.dir !== 'up')
        return undefined;
    for (const n of [o.ctr, o.ts])
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
            return undefined;
    const nonce = decodeBase64(o.nonce);
    const ct = decodeBase64(o.ct);
    if (!nonce || nonce.length !== NONCE_BYTES || !ct || ct.length < TAG_BYTES)
        return undefined;
    if (ct.length > IOT_ENVELOPE_MAX_PLAINTEXT_BYTES + TAG_BYTES)
        return undefined;
    return { v: IOT_ENVELOPE_VERSION, alg: IOT_ENVELOPE_ALG, kid: o.kid, dir: o.dir, ctr: o.ctr, ts: o.ts, nonce: o.nonce, ct: o.ct };
}
/** 解開設備信封；失敗丟 {@link IotEnvelopeError} */
export function openIotEnvelope(value, key) {
    const env = parseIotEnvelope(value);
    if (!env)
        throw new IotEnvelopeError('format', '信封格式不對');
    if (key.length !== KEY_BYTES)
        throw new RangeError(`設備金鑰必須是 ${KEY_BYTES} bytes`);
    const nonce = base64.decode(env.nonce);
    if (!nonceFits(nonce, env.dir, env.ctr))
        throw new IotEnvelopeError('nonce', 'nonce 與方向或計數器不符');
    try {
        return gcm(key, nonce, utf8ToBytes(iotEnvelopeAad(env))).decrypt(base64.decode(env.ct));
    }
    catch {
        throw new IotEnvelopeError('auth', '驗證失敗（金鑰不對，或內容、標頭被竄改）');
    }
}
/**
 * up 方向的計數器檢查（ADR 0049 §2.6）：每個 kid 只接受嚴格遞增的 ctr。手機與 relay（看得到明文的 ctr，先擋省一次扇出）都用。
 * 只在信封**驗證通過之後**才呼叫 {@link accept}——否則偽造的大 ctr 會把真的設備擋在外面。
 */
export class IotUpCounterGuard {
    #last = new Map();
    #max;
    constructor(opts = {}) {
        this.#max = Math.max(1, Math.floor(opts.maxEntries ?? 4096));
        for (const [kid, ctr] of Object.entries(opts.initial ?? {}))
            this.#remember(kid, ctr);
    }
    /** 比上次大才接受並記下 */
    accept(kid, ctr) {
        const last = this.#last.get(kid);
        if (last !== undefined && ctr <= last)
            return false;
        this.#remember(kid, ctr);
        return true;
    }
    last(kid) {
        return this.#last.get(kid);
    }
    /** 給持久化用 */
    snapshot() {
        return Object.fromEntries(this.#last);
    }
    #remember(kid, ctr) {
        this.#last.delete(kid);
        this.#last.set(kid, ctr);
        while (this.#last.size > this.#max)
            this.#last.delete(this.#last.keys().next().value);
    }
}
//# sourceMappingURL=envelope.js.map