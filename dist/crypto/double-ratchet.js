// 雙棘輪（SDK ADR 0010 §2）：照 Signal 的 Double Ratchet 規格，外加後量子混合步進（PRD 3.5.4）。
//
// ⚠ 實驗性、未經外部審計。只用在雙方都在線的即時通道（`secureChannel`），不跨裝置、不跨離線
//    ——理由見 Cinderous `docs/research/double-ratchet-on-current-design.md`。
//
// | 部件 | 內容 |
// |---|---|
// | DH | secp256k1 ECDH 取 x 座標（同 NIP-44）；公鑰是 32 位元組 x-only |
// | KDF_RK | HKDF-SHA256(salt=根金鑰, ikm=DH ‖ ML-KEM 共享秘密) → 新根金鑰 ‖ 鏈金鑰 |
// | KDF_CK | HMAC-SHA256(鏈金鑰, 0x01) → 訊息金鑰；(鏈金鑰, 0x02) → 下一把鏈金鑰 |
// | 加密 | XChaCha20-Poly1305；金鑰由訊息金鑰 HKDF 導出，nonce 每則隨機（密文前 24 位元組）；AD = 會話 AD ‖ header |
//
// nonce 用隨機而不是從訊息金鑰導出：萬一 App 還原了一份舊的狀態、同一把訊息金鑰被用兩次，
// 隨機 nonce 仍讓兩次的金鑰流不同（ADR 0010 §5，安全審查 #1）。
//
// 後量子（ADR 0033，線路格式 v2）：ML-KEM 的「輪次」與 DH 步進脫鉤。
//   - 每一方各有一把「目前的」ML-KEM 公鑰（編號 0, 1, 2…），附在訊息上直到對方回報收到（ackPk）。
//   - 對方的公鑰到手、而且我自上一輪以來送滿 `pqRekeyInterval` 則（預設 50），就封裝一次，
//     把密文附在接下來的一則訊息上（每條傳送鏈最多附一次，直到對方混入）。
//   - 解封裝的一方在**自己下一次 DH 步進**時把共享秘密串進 KDF_RK，並在那條鏈的每則 header 寫 `mix`＝輪次編號；
//     封裝的一方收到那條鏈時用同一份秘密推導接收鏈。延後混入 ⇒ 帶密文的那一則遺失或晚到，只會延後後量子
//     的自癒，**不會**讓任何一則解不開。
//   - 例外：Alice 的第一條鏈綁定握手時 Bob 的 ML-KEM 公鑰（輪次 0，立即混入，與 v1 相同），所以第一條鏈的
//     每一則都帶那份密文 ⇒ 從第一則起所有鏈金鑰都含後量子秘密。
//   - 看門狗：對方已經步進 16 次，我封出去的輪次還沒被混入（或我的公鑰還沒被收到）⇒ 丟
//     `SecurityDowngradeError` 並銷毀會話——有人專挑帶 KEM 的訊息丟，不能讓它靜默退回純古典。
//
// header（大端序）：
//   古典：[0] 版本 1、[1..33) DH 公鑰、[33..37) 上一條鏈的長度、[37..41) 序號（41 B，與 v0.27 相同）
//   後量子 v2：[0] 版本 3、[1..41) 同上、[41] 旗標（bit0 帶公鑰、bit1 帶密文，其餘必須是 0）、
//     [42..46) ackPk（我收到的對方公鑰最大編號；0xFFFFFFFF＝還沒有）、[46..50) mix（這條鏈混入的我方輪次；0xFFFFFFFF＝沒有），
//     有公鑰時接 [編號 u32 ‖ ML-KEM 公鑰 1,184 B]，有密文時再接 [輪次 u32 ‖ 封裝密文 1,088 B]。
//   版本 2 是 v0.27 以前的後量子格式（每則固定 2,314 B），已不支援（ADR 0033 §5）。
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { generatePqSeed, PQ_CIPHERTEXT_BYTES, PQ_PUBLIC_KEY_BYTES, PQ_SEED_BYTES, pqDecapsulate, pqEncapsulate, pqKeyFromSeed, } from '../protocol/hybrid-kem.js';
import { SecurityDowngradeError } from './cinder-ek.js';
/** 跳過（亂序、遺失）的訊息金鑰最多留幾把（PRD 3.5.2） */
export const DEFAULT_MAX_SKIPPED_KEYS = 2_000;
/** `maxSkippedKeys` 的上限：再大，對方一個假序號就能讓我們算上萬次 HMAC */
export const MAX_SKIPPED_KEYS_LIMIT = 10_000;
/** 後量子：我每送幾則就發起一輪新的 ML-KEM（ADR 0033 §3；iMessage PQ3 也是約 50 則） */
export const DEFAULT_PQ_REKEY_INTERVAL = 50;
/** `pqRekeyInterval` 的上限 */
export const MAX_PQ_REKEY_INTERVAL = 10_000;
/** 對方步進幾次、後量子輪次仍沒有進展，就視為遭遇降級（ADR 0033 §6） */
export const PQ_STALL_LIMIT = 16;
/**
 * 匯出狀態裡的後量子欄位與型別（`exportState`／`fromState` 共用）：
 * i＝KEM 編號（−1＝沒有）、n＝計數、b＝布林、k＝32 位元組秘密（hex）、s／p／c＝ML-KEM 種子／公鑰／密文（base64）
 */
const PQ_STATE_FIELDS = {
    interval: 'n',
    kemSeed: 's',
    kemId: 'i',
    peerAck: 'i',
    pkSent: 'b',
    pkStall: 'n',
    peerKemId: 'i',
    peerKemPk: 'p',
    outId: 'i',
    outCt: 'c',
    outSs: 'k',
    outStall: 'n',
    ctSent: 'b',
    inId: 'i',
    inSs: 'k',
    sendMix: 'i',
    sinceRound: 'n',
    initCt: 'c',
};
const PQ_OPTIONAL = new Set(['peerKemPk', 'outId', 'outCt', 'outSs', 'inId', 'inSs', 'initCt']);
const VERSION_CLASSIC = 1;
/** v0.27 以前的後量子格式（每則固定 2,314 B）：已不支援 */
const VERSION_PQ_LEGACY = 2;
const VERSION_PQ = 3;
const HEADER_CLASSIC_BYTES = 41;
const HEADER_PQ_BASE_BYTES = 50;
const PK_FIELD_BYTES = 4 + PQ_PUBLIC_KEY_BYTES;
const CT_FIELD_BYTES = 4 + PQ_CIPHERTEXT_BYTES;
const FLAG_PK = 1;
const FLAG_CT = 2;
/** header 裡的「沒有」 */
const NONE_WIRE = 0xffff_ffff;
/** ML-KEM 輪次編號的上限（再上去就撞到「沒有」）：到頂就必須重新握手 */
const MAX_KEM_ID = 0xffff_fffe;
const NONCE_BYTES = 24;
/** 序號用 32 位元寫在 header：到頂就必須重新握手，不能讓它繞回 0 */
const MAX_COUNTER = 0xffff_ffff;
/** 記住最近幾把已退役的對方 DH 公鑰：舊鏈的訊息直接拒絕，不必做一次 DH 步進才失敗 */
const RETIRED_MEMORY = 32;
const INFO_RK = utf8ToBytes('cinderous/dr/v1/rk');
const INFO_MK = utf8ToBytes('cinderous/dr/v1/mk');
const ZERO_SALT = new Uint8Array(32);
/**
 * 對方送來的訊息**通過 MAC** 卻違反協定（KEM 編號跳號、回報不存在的公鑰、公鑰不合法……）。
 * 只有惡意或有 bug 的對方會這樣：會話已銷毀，`secureChannel` 會關閉通道（ADR 0033 §10 #5）。
 */
export class RatchetProtocolError extends Error {
    name = 'RatchetProtocolError';
}
/**
 * FIPS 203 的封裝金鑰檢查：公鑰裡 3×256 個 12 位元係數都必須小於 q＝3329（ByteEncode12(ByteDecode12(ek)) = ek）。
 * 不合格的公鑰要在收下時就拒絕，不能等到封裝時才每次失敗（ADR 0033 §10 #2）。
 */
function validPqPublicKey(pk) {
    if (pk.length !== PQ_PUBLIC_KEY_BYTES)
        return false;
    for (let i = 0; i < PQ_PUBLIC_KEY_BYTES - 32; i += 3) {
        const a = pk[i];
        const b = pk[i + 1];
        const c = pk[i + 2];
        if ((a | ((b & 0x0f) << 8)) >= 3329 || ((b >> 4) | (c << 4)) >= 3329)
            return false;
    }
    return true;
}
export function generateRatchetKeyPair() {
    const secretKey = schnorr.utils.randomSecretKey();
    return { secretKey, publicKey: schnorr.getPublicKey(secretKey) };
}
/** secp256k1 ECDH，取 x 座標（x-only 公鑰補上偶數 y；x 與 y 的正負無關） */
function dh(secretKey, publicKey) {
    return secp256k1.getSharedSecret(secretKey, concatBytes(new Uint8Array([2]), publicKey)).subarray(1, 33);
}
function kdfRk(rootKey, dhOut, kemSecret) {
    const out = hkdf(sha256, kemSecret ? concatBytes(dhOut, kemSecret) : dhOut, rootKey, INFO_RK, 64);
    return [out.slice(0, 32), out.slice(32)];
}
function kdfCk(chainKey) {
    return [hmac(sha256, chainKey, new Uint8Array([2])), hmac(sha256, chainKey, new Uint8Array([1]))];
}
function seal(messageKey, plaintext, associatedData) {
    const key = hkdf(sha256, messageKey, ZERO_SALT, INFO_MK, 32);
    const nonce = randomBytes(NONCE_BYTES);
    const out = concatBytes(nonce, xchacha20poly1305(key, nonce, associatedData).encrypt(plaintext));
    key.fill(0);
    return out;
}
function open(messageKey, data, associatedData) {
    if (data.length < NONCE_BYTES)
        throw new Error('雙棘輪：密文太短');
    const key = hkdf(sha256, messageKey, ZERO_SALT, INFO_MK, 32);
    try {
        return xchacha20poly1305(key, data.subarray(0, NONCE_BYTES), associatedData).decrypt(data.subarray(NONCE_BYTES));
    }
    finally {
        key.fill(0);
    }
}
/**
 * 從線路上的位元組讀出 header 有多長（不驗內容）；不是認得的格式就回 0。
 * `secureChannel` 用它把「header ‖ 密文」切開。
 */
export function ratchetHeaderLength(bytes) {
    if (bytes[0] === VERSION_CLASSIC)
        return bytes.length >= HEADER_CLASSIC_BYTES ? HEADER_CLASSIC_BYTES : 0;
    if (bytes[0] !== VERSION_PQ || bytes.length < HEADER_PQ_BASE_BYTES)
        return 0;
    const flags = bytes[41];
    if ((flags & ~(FLAG_PK | FLAG_CT)) !== 0)
        return 0;
    const length = HEADER_PQ_BASE_BYTES + (flags & FLAG_PK ? PK_FIELD_BYTES : 0) + (flags & FLAG_CT ? CT_FIELD_BYTES : 0);
    return bytes.length >= length ? length : 0;
}
const toWire = (id) => (id < 0 ? NONE_WIRE : id);
const fromWire = (value) => (value === NONE_WIRE ? -1 : value);
function encodeClassicHeader(h) {
    const out = new Uint8Array(HEADER_CLASSIC_BYTES);
    const view = new DataView(out.buffer);
    out[0] = VERSION_CLASSIC;
    out.set(h.dh, 1);
    view.setUint32(33, h.pn);
    view.setUint32(37, h.n);
    return out;
}
function encodePqHeader(h) {
    const out = new Uint8Array(HEADER_PQ_BASE_BYTES + (h.pk ? PK_FIELD_BYTES : 0) + (h.ct ? CT_FIELD_BYTES : 0));
    const view = new DataView(out.buffer);
    out[0] = VERSION_PQ;
    out.set(h.dh, 1);
    view.setUint32(33, h.pn);
    view.setUint32(37, h.n);
    out[41] = (h.pk ? FLAG_PK : 0) | (h.ct ? FLAG_CT : 0);
    view.setUint32(42, toWire(h.ackPk));
    view.setUint32(46, toWire(h.mix));
    let at = HEADER_PQ_BASE_BYTES;
    if (h.pk) {
        view.setUint32(at, h.pk.id);
        out.set(h.pk.key, at + 4);
        at += PK_FIELD_BYTES;
    }
    if (h.ct) {
        view.setUint32(at, h.ct.id);
        out.set(h.ct.ct, at + 4);
    }
    return out;
}
function decodeHeader(bytes, postQuantum) {
    if (postQuantum && bytes[0] === VERSION_PQ_LEGACY)
        throw new Error('雙棘輪：對方用的是 v0.27 以前的後量子線路格式，已不支援');
    // 🔴 會話是後量子的，就只收後量子 header：拿掉 KEM 欄位假裝成古典，不會默默降級
    if (bytes[0] !== (postQuantum ? VERSION_PQ : VERSION_CLASSIC))
        throw new Error('雙棘輪：header 版本與會話不符');
    if (bytes.length !== ratchetHeaderLength(bytes))
        throw new Error('雙棘輪：header 長度不正確');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = { dh: bytes.slice(1, 33), pn: view.getUint32(33), n: view.getUint32(37), ackPk: -1, mix: -1 };
    if (!postQuantum)
        return header;
    const flags = bytes[41];
    header.ackPk = fromWire(view.getUint32(42));
    header.mix = fromWire(view.getUint32(46));
    let at = HEADER_PQ_BASE_BYTES;
    if (flags & FLAG_PK) {
        header.pk = { id: view.getUint32(at), key: bytes.slice(at + 4, at + PK_FIELD_BYTES) };
        at += PK_FIELD_BYTES;
    }
    if (flags & FLAG_CT)
        header.ct = { id: view.getUint32(at), ct: bytes.slice(at + 4, at + CT_FIELD_BYTES) };
    if (header.pk?.id === NONE_WIRE || header.ct?.id === NONE_WIRE)
        throw new Error('雙棘輪：KEM 編號不正確');
    return header;
}
function checkedMaxSkip(value) {
    const max = value ?? DEFAULT_MAX_SKIPPED_KEYS;
    if (!Number.isInteger(max) || max < 1 || max > MAX_SKIPPED_KEYS_LIMIT) {
        throw new RangeError(`雙棘輪：maxSkippedKeys 必須是 1～${MAX_SKIPPED_KEYS_LIMIT} 的整數`);
    }
    return max;
}
function checkedInterval(value) {
    const interval = value ?? DEFAULT_PQ_REKEY_INTERVAL;
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_PQ_REKEY_INTERVAL) {
        throw new RangeError(`雙棘輪：pqRekeyInterval 必須是 1～${MAX_PQ_REKEY_INTERVAL} 的整數`);
    }
    return interval;
}
function cloneState(s) {
    return { ...s, skipped: new Map(s.skipped), retired: [...s.retired] };
}
/** 解密成功之後：舊狀態裡、新狀態已經不再引用的秘密，全部清零。 */
function wipeSuperseded(before, after) {
    const pairs = [
        [before.rk, after.rk],
        [before.cks, after.cks],
        [before.ckr, after.ckr],
        [before.dhs.secretKey, after.dhs.secretKey],
        [before.kem?.sk, after.kem?.sk],
        [before.kemSeed, after.kemSeed],
        [before.outSs, after.outSs],
        [before.inSs, after.inSs],
    ];
    for (const [old, current] of pairs)
        if (old && old !== current)
            old.fill(0);
    for (const [key, mk] of before.skipped)
        if (after.skipped.get(key) !== mk)
            mk.fill(0);
}
function newKem() {
    const seed = generatePqSeed();
    return { seed, pair: pqKeyFromSeed(seed) };
}
function baseState(init, pq, dhs) {
    return {
        peer: init.peerPublicKey,
        ad: init.associatedData.slice(),
        pq,
        maxSkip: checkedMaxSkip(init.maxSkippedKeys),
        dhs,
        rk: init.sharedSecret.slice(),
        ns: 0,
        nr: 0,
        pn: 0,
        skipped: new Map(),
        retired: [],
        interval: checkedInterval(init.pqRekeyInterval),
        kemId: 0,
        peerAck: -1,
        pkSent: false,
        pkStall: 0,
        peerKemId: -1,
        outStall: 0,
        ctSent: false,
        sendMix: -1,
        sinceRound: 0,
    };
}
export class DoubleRatchetSession {
    engineType = 'double-ratchet';
    #s;
    #destroyed = false;
    /** 解密交易進行中時的快照：交易中新產生、快照沒有引用的中間秘密可以立刻清零 */
    #snapshot;
    constructor(state) {
        this.#s = state;
    }
    /** 先送的一方：知道對方的初始棘輪公鑰（與 ML-KEM 公鑰）後，立刻有傳送鏈。 */
    static initAlice(init) {
        const pq = init.bobKemPublicKey !== undefined;
        const dhs = generateRatchetKeyPair();
        const state = baseState(init, pq, dhs);
        state.dhr = init.bobRatchetPublicKey.slice();
        let ss;
        if (pq) {
            const kem = newKem();
            state.kemSeed = kem.seed;
            state.kem = kem.pair;
            // 輪次 0：封給 Bob 握手時公布的 ML-KEM 公鑰，立即混入第一條鏈
            const encapsulated = pqEncapsulate(init.bobKemPublicKey);
            state.initCt = encapsulated.ct;
            state.peerKemId = 0;
            ss = encapsulated.ss;
        }
        const initialRoot = state.rk;
        [state.rk, state.cks] = kdfRk(initialRoot, dh(dhs.secretKey, state.dhr), ss);
        initialRoot.fill(0);
        ss?.fill(0);
        return new DoubleRatchetSession(state);
    }
    /** 後送的一方：用握手時公布的棘輪金鑰對起步；收到對方第一則之後才有傳送鏈。 */
    static initBob(init) {
        const state = baseState(init, init.kemKeyPair !== undefined, init.ratchetKeyPair);
        if (init.kemKeyPair) {
            state.kem = init.kemKeyPair; // 輪次 0＝握手時公布的那一把
            if (init.kemSeed)
                state.kemSeed = init.kemSeed;
        }
        return new DoubleRatchetSession(state);
    }
    get peerPublicKey() {
        return this.#s.peer;
    }
    get postQuantum() {
        return this.#s.pq;
    }
    /** 已經可以送了嗎（後送的一方要等收到第一則） */
    get canSend() {
        return this.#s.cks !== undefined && !this.#destroyed;
    }
    async encrypt(plaintext) {
        // ⚠ 從這裡到 return 之間不可以有 await：同時送出的兩則會拿到同一把訊息金鑰（並發測試守著）
        this.#alive();
        const s = this.#s;
        if (!s.cks)
            throw new Error('雙棘輪：還沒收到對方的第一則訊息，不能送');
        if (s.ns >= MAX_COUNTER)
            throw new Error('雙棘輪：這條鏈的序號用完了，請重新握手');
        if (s.pq)
            this.#maybeStartRound();
        const [nextCk, mk] = kdfCk(s.cks);
        s.cks.fill(0);
        s.cks = nextCk;
        const h = { dh: s.dhs.publicKey, pn: s.pn, n: s.ns, ackPk: s.peerKemId, mix: s.sendMix };
        if (s.pq) {
            if (s.peerAck < s.kemId && !s.pkSent) {
                h.pk = { id: s.kemId, key: s.kem.pk };
                s.pkSent = true;
            }
            if (s.initCt)
                h.ct = { id: 0, ct: s.initCt };
            else if (s.outCt && !s.ctSent) {
                h.ct = { id: s.outId, ct: s.outCt };
                s.ctSent = true;
            }
            if (s.sinceRound < MAX_PQ_REKEY_INTERVAL)
                s.sinceRound += 1;
        }
        const header = s.pq ? encodePqHeader(h) : encodeClassicHeader(h);
        s.ns += 1;
        const ciphertext = seal(mk, plaintext, concatBytes(s.ad, header));
        mk.fill(0);
        return s.pq
            ? { engineType: 'double-ratchet', kemAlgorithm: 'pq-double-ratchet-v2', header, ciphertext }
            : { engineType: 'double-ratchet', header, ciphertext };
    }
    /** 對方的公鑰到手、上一輪已經被混入、而且我送滿了間隔 ⇒ 封裝一輪新的 */
    #maybeStartRound() {
        const s = this.#s;
        if (s.initCt || s.outId !== undefined || !s.peerKemPk || s.sinceRound < s.interval)
            return;
        const encapsulated = pqEncapsulate(s.peerKemPk);
        s.outId = s.peerKemId;
        s.outCt = encapsulated.ct;
        s.outSs = encapsulated.ss;
        s.outStall = 0;
        s.ctSent = false;
        s.peerKemPk = undefined; // 一把公鑰只封裝一次
        s.sinceRound = 0;
    }
    async decrypt(envelope) {
        this.#alive();
        // 交易式：任何一步失敗（MAC 錯、跳過太多、header 壞掉）都還原成解之前的狀態。
        // 快照與現行狀態共用同一批 Uint8Array，所以失敗路徑上**不可以**原地清零任何東西；
        // 成功之後才把新狀態不再引用的舊秘密清掉。
        const snapshot = cloneState(this.#s);
        let plaintext;
        this.#snapshot = snapshot;
        try {
            plaintext = this.#decrypt(envelope);
        }
        catch (error) {
            this.#s = snapshot;
            if (error instanceof RatchetProtocolError)
                this.destroy(); // 通過 MAC 的協定違規：不再和這個對方繼續
            throw error;
        }
        finally {
            this.#snapshot = undefined;
        }
        wipeSuperseded(snapshot, this.#s);
        const s = this.#s;
        if (s.pq && (s.outStall > PQ_STALL_LIMIT || s.pkStall > PQ_STALL_LIMIT)) {
            // 🔴 對方一直在步進，後量子輪次卻一直完成不了：有人專挑帶 KEM 的訊息丟。不靜默退回純古典。
            plaintext.fill(0);
            this.destroy();
            throw new SecurityDowngradeError(s.peer, 'pq-double-ratchet-v2', 'double-ratchet');
        }
        return plaintext;
    }
    #decrypt(envelope) {
        const s = this.#s;
        if (envelope.engineType !== 'double-ratchet')
            throw new Error('雙棘輪：不是雙棘輪的信封');
        const header = decodeHeader(envelope.header, s.pq);
        const ad = concatBytes(s.ad, envelope.header);
        const dhHex = bytesToHex(header.dh);
        const skippedKey = `${dhHex}:${header.n}`;
        const skipped = s.skipped.get(skippedKey);
        if (skipped) {
            const plaintext = open(skipped, envelope.ciphertext, ad);
            s.skipped.delete(skippedKey); // 用過即刪（清零在 decrypt 成功後）
            this.#absorbKem(header);
            return plaintext;
        }
        const currentChain = s.dhr !== undefined && dhHex === bytesToHex(s.dhr);
        if (currentChain && header.n < s.nr)
            throw new Error('雙棘輪：這則已經收過了（重放）');
        if (!currentChain && s.retired.includes(dhHex))
            throw new Error('雙棘輪：來自已退役的舊鏈，而且已經收過或跳過太久');
        // 新鏈：舊鏈要補算的（pn − nr）加上新鏈的 n，合計也受 maxSkip 限制——偽造的訊息在 MAC 前最多算 maxSkip 次（ADR 0033 §10 #7）
        if (!currentChain && s.ckr && Math.max(0, header.pn - s.nr) + header.n > s.maxSkip)
            throw new Error('雙棘輪：跳過的訊息太多');
        if (!currentChain) {
            this.#skip(header.pn);
            this.#receiveStep(header);
        }
        this.#skip(header.n);
        const [nextCk, mk] = kdfCk(s.ckr);
        this.#wipeIfFresh(s.ckr);
        s.ckr = nextCk;
        s.nr += 1;
        const plaintext = open(mk, envelope.ciphertext, ad);
        mk.fill(0); // 這把是新算出來的，快照裡沒有，可以直接清
        this.#absorbKem(header);
        // 傳送半步放在 MAC 驗過、KEM 欄位收下之後：步進那一則自己帶的密文，這一步就能混入
        if (!currentChain)
            this.#sendStep();
        return plaintext;
    }
    /** 這次交易中新算出來的中間秘密（快照沒有引用）被取代時，立刻清零；快照引用的留到成功後由 `wipeSuperseded` 處理 */
    #wipeIfFresh(buffer) {
        const snap = this.#snapshot;
        if (!buffer || !snap)
            return;
        if (buffer === snap.rk || buffer === snap.ckr || buffer === snap.cks || buffer === snap.inSs || buffer === snap.outSs)
            return;
        buffer.fill(0);
    }
    /** 把這條接收鏈上、序號小於 `until` 的訊息金鑰先算出來存著（亂序與遺失）。 */
    #skip(until) {
        const s = this.#s;
        if (s.nr + s.maxSkip < until)
            throw new Error('雙棘輪：跳過的訊息太多');
        if (!s.ckr || !s.dhr)
            return;
        const dhr = bytesToHex(s.dhr);
        while (s.nr < until) {
            const [nextCk, mk] = kdfCk(s.ckr);
            this.#wipeIfFresh(s.ckr);
            s.ckr = nextCk;
            s.skipped.set(`${dhr}:${s.nr}`, mk);
            s.nr += 1;
            if (s.skipped.size > s.maxSkip) {
                const oldest = s.skipped.keys().next().value;
                if (oldest !== undefined)
                    s.skipped.delete(oldest); // 清零在 decrypt 成功後
            }
        }
    }
    /** DH 步進的接收半步：對方這條新鏈的接收鏈金鑰 */
    #receiveStep(header) {
        const s = this.#s;
        const initial = s.dhr === undefined;
        if (s.dhr) {
            s.retired.push(bytesToHex(s.dhr));
            if (s.retired.length > RETIRED_MEMORY)
                s.retired.shift();
        }
        s.pn = s.ns;
        s.ns = 0;
        s.nr = 0;
        s.dhr = header.dh;
        // 接收半步：對方這條鏈混入的 KEM 秘密
        let ssIn;
        let ssInFresh = false;
        if (s.pq && initial) {
            // Bob 的第一條接收鏈：綁定握手的 ML-KEM（輪次 0，立即混入）。ML-KEM 是隱式拒絕，
            // 壞密文只會導出錯的鏈金鑰、在 MAC 失敗，狀態整批還原。
            if (!header.ct || header.ct.id !== 0 || s.kemId !== 0 || header.mix !== -1)
                throw new Error('雙棘輪：第一條鏈缺少握手的封裝密文');
            ssIn = pqDecapsulate(s.kem.sk, header.ct.ct);
            ssInFresh = true;
            this.#rotateOwnKem();
        }
        else if (s.pq) {
            if (header.mix !== -1) {
                if (s.outId === undefined || header.mix !== s.outId)
                    throw new Error('雙棘輪：對方混入的 KEM 輪次對不上');
                ssIn = s.outSs; // 清零在 decrypt 成功後（快照也引用它）
                s.outId = undefined;
                s.outCt = undefined;
                s.outSs = undefined;
                s.outStall = 0;
            }
            else if (s.outId !== undefined) {
                s.outStall += 1;
            }
            if (Math.max(s.peerAck, header.ackPk) < s.kemId)
                s.pkStall += 1;
            else
                s.pkStall = 0;
        }
        [s.rk, s.ckr] = kdfRk(s.rk, dh(s.dhs.secretKey, s.dhr), ssIn);
        if (ssInFresh)
            ssIn.fill(0);
    }
    /** DH 步進的傳送半步：換新的棘輪金鑰，混入對方封裝給我、還沒混入的輪次 */
    #sendStep() {
        const s = this.#s;
        s.dhs = generateRatchetKeyPair();
        let ssOut;
        if (s.pq) {
            ssOut = s.inSs; // 清零在 decrypt 成功後
            s.sendMix = s.inId ?? -1;
            s.inId = undefined;
            s.inSs = undefined;
            s.pkSent = false;
            s.ctSent = false;
            s.initCt = undefined;
        }
        const middleRoot = s.rk; // 接收半步剛算出來的，這次交易才有
        [s.rk, s.cks] = kdfRk(middleRoot, dh(s.dhs.secretKey, s.dhr), ssOut);
        this.#wipeIfFresh(middleRoot);
        this.#wipeIfFresh(ssOut); // 步進那一則自己帶的密文：這次交易才解封裝出來
    }
    /** 已通過 MAC 的 header：收下對方的公鑰、封裝密文與回報。只在這裡解封裝，保證密文是對方送的。 */
    #absorbKem(header) {
        const s = this.#s;
        if (!s.pq)
            return;
        if (header.ackPk > s.kemId)
            throw new RatchetProtocolError('雙棘輪：對方回報收到一把我還沒產生的公鑰');
        if (header.ackPk > s.peerAck)
            s.peerAck = header.ackPk;
        if (header.pk) {
            if (header.pk.id > s.peerKemId + 1)
                throw new RatchetProtocolError('雙棘輪：對方的 ML-KEM 公鑰編號跳號');
            if (header.pk.id === s.peerKemId + 1) {
                if (!validPqPublicKey(header.pk.key))
                    throw new RatchetProtocolError('雙棘輪：對方的 ML-KEM 公鑰不合法');
                s.peerKemId = header.pk.id;
                s.peerKemPk = header.pk.key;
            }
        }
        if (header.ct && header.ct.id >= s.kemId) {
            if (header.ct.id > s.kemId || s.inId !== undefined)
                throw new RatchetProtocolError('雙棘輪：對方的封裝密文對不上我的公鑰');
            s.inSs = pqDecapsulate(s.kem.sk, header.ct.ct);
            s.inId = header.ct.id;
            this.#rotateOwnKem();
        }
        // 編號比較小的密文：那一輪已經處理過（重帶或晚到），略過
    }
    /** 我目前的 ML-KEM 私鑰用過了：換一把新的，附在接下來的訊息上 */
    #rotateOwnKem() {
        const s = this.#s;
        if (s.kemId >= MAX_KEM_ID)
            throw new RatchetProtocolError('雙棘輪：ML-KEM 輪次編號用完了，請重新握手');
        const kem = newKem();
        s.kemSeed = kem.seed; // 舊的私鑰與種子在 decrypt 成功後清零
        s.kem = kem.pair;
        s.kemId += 1;
        s.pkSent = false;
        s.pkStall = 0;
    }
    /**
     * 匯出狀態並**銷毀這個會話**（搬走，不是複製）：同一份狀態同時活在兩處，就會用同一把訊息金鑰加密兩次。
     * 匯出的內容含鏈金鑰，必須加密保存；不可複製到另一台裝置，也不要還原比較舊的那一份。
     */
    async exportState() {
        this.#alive();
        const s = this.#s;
        // 匯出後就銷毀：還原不了的東西不能匯出（例如 initBob 沒給 kemSeed），否則等於把會話丟掉（ADR 0033 §10 #4）
        if (s.pq && !s.kemSeed)
            throw new Error('雙棘輪：這個後量子會話沒有 ML-KEM 種子（initBob 要給 kemSeed），無法匯出');
        const hex = (b) => (b ? bytesToHex(b) : undefined);
        const pqFields = {};
        if (s.pq) {
            for (const [key, kind] of Object.entries(PQ_STATE_FIELDS)) {
                const value = s[key];
                pqFields[key] = value instanceof Uint8Array ? (kind === 'k' ? bytesToHex(value) : base64.encode(value)) : value;
            }
        }
        const bytes = utf8ToBytes(JSON.stringify({
            v: 2,
            peer: s.peer,
            ad: base64.encode(s.ad),
            pq: s.pq,
            maxSkip: s.maxSkip,
            dhs: hex(s.dhs.secretKey),
            dhr: hex(s.dhr),
            rk: hex(s.rk),
            cks: hex(s.cks),
            ckr: hex(s.ckr),
            ns: s.ns,
            nr: s.nr,
            pn: s.pn,
            skipped: [...s.skipped].map(([k, v]) => [k, bytesToHex(v)]),
            retired: s.retired,
            ...pqFields,
        }));
        this.destroy();
        return bytes;
    }
    /**
     * 從 `exportState` 還原。格式有任何不對就丟例外。
     * v0.27 以前匯出的古典會話（v:1）照樣還原；v0.27 以前的**後量子**會話線路格式已不同，只能重新握手。
     */
    static fromState(bytes) {
        const j = JSON.parse(new TextDecoder().decode(bytes));
        const fail = (what) => {
            throw new Error(`雙棘輪：狀態格式不正確（${what}）`);
        };
        const key32 = (v, what) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? hexToBytes(v) : fail(what);
        const optKey32 = (v, what) => (v === undefined ? undefined : key32(v, what));
        const counter = (v, what) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNTER ? v : fail(what);
        const kemId = (v, what) => typeof v === 'number' && Number.isInteger(v) && v >= -1 && v <= MAX_KEM_ID ? v : fail(what);
        const bool = (v, what) => (typeof v === 'boolean' ? v : fail(what));
        const bytesOf = (v, length, what) => {
            if (typeof v !== 'string')
                return fail(what);
            let out;
            try {
                out = base64.decode(v);
            }
            catch {
                return fail(what);
            }
            return out.length === length ? out : fail(`${what} 長度`);
        };
        if (j.v !== 1 && j.v !== 2)
            fail('版本');
        if (typeof j.peer !== 'string' || !/^[0-9a-f]{64}$/.test(j.peer))
            fail('peer');
        if (typeof j.pq !== 'boolean')
            fail('pq');
        const pq = j.pq;
        if (pq && j.v === 1)
            fail('v0.27 以前的後量子會話線路格式已不同，請重新握手');
        const maxSkip = typeof j.maxSkip === 'number' ? checkedMaxSkip(j.maxSkip) : fail('maxSkip');
        const dhsSecret = key32(j.dhs, 'dhs');
        if (!Array.isArray(j.skipped))
            fail('skipped');
        const skipped = new Map();
        for (const entry of j.skipped) {
            if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !/^[0-9a-f]{64}:\d+$/.test(entry[0]))
                fail('skipped');
            const pair = entry;
            if (Number(pair[0].slice(65)) > MAX_COUNTER)
                fail('skipped');
            skipped.set(pair[0], key32(pair[1], 'skipped'));
        }
        if (skipped.size > maxSkip)
            fail('skipped 超過上限');
        if (j.retired !== undefined && !Array.isArray(j.retired))
            fail('retired');
        const retired = Array.isArray(j.retired) ? j.retired : [];
        if (!retired.every((r) => typeof r === 'string' && /^[0-9a-f]{64}$/.test(r)))
            fail('retired');
        let ad;
        try {
            ad = base64.decode(String(j.ad));
        }
        catch {
            ad = fail('ad');
        }
        const state = {
            peer: j.peer,
            ad,
            pq,
            maxSkip,
            dhs: { secretKey: dhsSecret, publicKey: schnorr.getPublicKey(dhsSecret) },
            rk: key32(j.rk, 'rk'),
            ns: counter(j.ns, 'ns'),
            nr: counter(j.nr, 'nr'),
            pn: counter(j.pn, 'pn'),
            skipped,
            retired: retired.slice(-RETIRED_MEMORY),
            interval: DEFAULT_PQ_REKEY_INTERVAL,
            kemId: 0,
            peerAck: -1,
            pkSent: false,
            pkStall: 0,
            peerKemId: -1,
            outStall: 0,
            ctSent: false,
            sendMix: -1,
            sinceRound: 0,
        };
        const dhr = optKey32(j.dhr, 'dhr');
        if (dhr)
            state.dhr = dhr;
        const cks = optKey32(j.cks, 'cks');
        if (cks)
            state.cks = cks;
        const ckr = optKey32(j.ckr, 'ckr');
        if (ckr)
            state.ckr = ckr;
        if (!pq) {
            // 把後量子狀態改成 pq:false 載入，就是降級
            if (Object.keys(PQ_STATE_FIELDS).some((k) => j[k] !== undefined))
                fail('古典會話不應有後量子欄位');
            return new DoubleRatchetSession(state);
        }
        // 後量子：每個欄位先依表驗型別與長度，再驗彼此的一致性
        const pqState = state;
        for (const [key, kind] of Object.entries(PQ_STATE_FIELDS)) {
            const v = j[key];
            if (v === undefined) {
                if (PQ_OPTIONAL.has(key))
                    continue;
                fail(key);
            }
            pqState[key] =
                kind === 'k' ? key32(v, key)
                    : kind === 'i' ? kemId(v, key)
                        : kind === 'n' ? counter(v, key)
                            : kind === 'b' ? bool(v, key)
                                : bytesOf(v, kind === 's' ? PQ_SEED_BYTES : kind === 'p' ? PQ_PUBLIC_KEY_BYTES : PQ_CIPHERTEXT_BYTES, key);
        }
        state.interval = checkedInterval(state.interval);
        state.kem = pqKeyFromSeed(state.kemSeed);
        if (state.kemId < 0)
            fail('kemId');
        if (state.peerAck > state.kemId)
            fail('peerAck');
        if (state.pkStall > PQ_STALL_LIMIT)
            fail('pkStall');
        if (state.outStall > PQ_STALL_LIMIT)
            fail('outStall');
        if (state.peerKemPk && (state.peerKemId < 0 || !validPqPublicKey(state.peerKemPk)))
            fail('peerKemPk');
        const hasOut = [state.outId, state.outCt, state.outSs].map((v) => v !== undefined);
        if (hasOut.some((x) => x !== hasOut[0]))
            fail('out 欄位不完整');
        if (state.outId !== undefined) {
            if (state.outId < 0 || state.outId > state.peerKemId)
                fail('outId');
            if (state.outId === state.peerKemId && state.peerKemPk)
                fail('peerKemPk'); // 同一把公鑰不封裝兩次
        }
        if ((state.inId === undefined) !== (state.inSs === undefined))
            fail('in 欄位不完整');
        if (state.inId !== undefined && (state.inId < 0 || state.inId >= state.kemId))
            fail('inId');
        if (state.sendMix >= state.kemId)
            fail('sendMix');
        if (state.initCt && (!state.cks || state.dhr === undefined || state.kemId !== 0))
            fail('initCt');
        // Bob 還沒收到第一則：只能是握手那一把（輪次 0）；已經起步的後量子會話一定有 initCt 或已步進過
        if (state.dhr === undefined && state.kemId !== 0)
            fail('kemId');
        if (state.dhr !== undefined && !state.cks)
            fail('cks'); // 已經起步的會話一定有傳送鏈
        return new DoubleRatchetSession(state);
    }
    destroy() {
        if (this.#destroyed)
            return;
        this.#destroyed = true;
        const s = this.#s;
        for (const key of [s.rk, s.cks, s.ckr, s.dhs.secretKey, s.kem?.sk, s.kemSeed, s.outSs, s.inSs, ...s.skipped.values()])
            key?.fill(0);
        s.skipped.clear();
    }
    #alive() {
        if (this.#destroyed)
            throw new Error('雙棘輪：會話已銷毀');
    }
}
//# sourceMappingURL=double-ratchet.js.map