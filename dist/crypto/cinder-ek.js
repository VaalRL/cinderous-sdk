// Cinder EK 金鑰環（SDK ADR 0010 §1）：Cinderous 的 EK 純函式（`protocol/subkey`）之上，
// 補「持有金鑰、到期輪替、刪掉過期私鑰、封裝給對方的 EK、防降級」這一層。
//
// - EK 是**傳輸金鑰**：隨機生成、不從 nsec 導出；舊 EK 過了寬限期就刪 ⇒ 事後 nsec 失竊也解不開側錄的密文。
// - 狀態（EK 私鑰、後量子種子、對方的釘選）由 `exportState` 交給 App 自己加密保存；這裡不碰儲存。
// - 🔴 後量子只保護加密，簽章仍是 secp256k1：不得對外稱「量子安全」（Cinderous ADR-0306 D2.2）。
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { engineCapabilityTag } from './presets.js';
import { decodePqPublicKey, encodePqPublicKey, encodePqSeed, generatePqSeed, pqKeyFromStored, } from '../protocol/hybrid-kem.js';
import { getPublicKey } from '../protocol/keys.js';
import { EK_ANNOUNCE_KIND, ekAnnounceContent, FS_CAPABILITY, FS_CAPABILITY_PQ, FS_GRACE_MS, FS_ROTATE_INTERVAL_MS, generateEncryptionKey, openWrapWithEks, pinAfterDeclare, pinIsDowngraded, pruneFsKeys, readEkAnnounce, shouldRotateFs, withEkHint, } from '../protocol/subkey.js';
/** 對方的加密等級比先前釘選的弱（或公告不見了）：可能有人在中間把它剝掉（PRD 3.4）。 */
export class SecurityDowngradeError extends Error {
    peer;
    pinned;
    declared;
    name = 'SecurityDowngradeError';
    constructor(peer, 
    /** 先前見過的最強機制 */
    pinned, 
    /** 這次看到的機制；`undefined`＝公告不見了 */
    declared) {
        super(`對方的加密等級從 ${pinned} 變成 ${declared ?? '沒有公告'}：可能遭遇降級攻擊，已拒絕送出`);
        this.peer = peer;
        this.pinned = pinned;
        this.declared = declared;
    }
}
/**
 * 釘選過的對方改發了我們不認得的新版 EK 公告（ADR 0010 §5，安全審查 #9）。
 * 對方是升級不是被攻擊，但我們讀不懂，只能退回身分金鑰、失去前向保密 ⇒ 不默默退回，請 App 提示更新 SDK。
 */
export class PeerUpgradedError extends Error {
    peer;
    version;
    name = 'PeerUpgradedError';
    constructor(peer, version) {
        super(`對方的 EK 公告是新版（v${version}），這個版本的 SDK 讀不懂：請更新後再送，以免退回沒有前向保密的身分金鑰`);
        this.peer = peer;
        this.version = version;
    }
}
export class CinderEkKeyring {
    #identity;
    #postQuantum;
    #rotateIntervalMs;
    #graceMs;
    #now;
    #keys;
    #pins;
    #seen;
    /** 展開後的 ML-KEM 金鑰（種子 → 金鑰對很貴，只算一次） */
    #pqCache = new Map();
    constructor(identity, state, opts) {
        this.#identity = identity;
        this.#postQuantum = opts.postQuantum ?? true;
        this.#rotateIntervalMs = opts.rotateIntervalMs ?? FS_ROTATE_INTERVAL_MS;
        this.#graceMs = opts.graceMs ?? FS_GRACE_MS;
        this.#now = opts.now ?? Date.now;
        this.#keys = state.keys;
        this.#pins = state.pins;
        this.#seen = state.seen;
    }
    /** 新的金鑰環：生成第一把 EK。 */
    static create(identity, opts = {}) {
        const ring = new CinderEkKeyring(identity, { v: 1, keys: [], pins: {}, seen: {} }, opts);
        ring.#keys.push(ring.#newKey());
        return ring;
    }
    /** 從 `exportState` 的內容還原。格式不對就丟例外，不會默默變成空的金鑰環。 */
    static fromState(identity, json, opts = {}) {
        const state = JSON.parse(json);
        const bad = () => {
            throw new Error('Cinder EK 金鑰環狀態格式不正確');
        };
        const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
        const validKey = (k) => isObject(k) &&
            typeof k.sk === 'string' &&
            /^[0-9a-f]{64}$/.test(k.sk) &&
            Number.isFinite(k.at) &&
            // 壞掉的種子會讓這把默默變成純古典 ⇒ 我的公告退回古典 ⇒ 釘選過我的人全部報降級（安全審查 #12）
            (k.pq === undefined || pqKeyFromStored(k.pq) !== undefined);
        if (state.v !== 1 || !Array.isArray(state.keys) || state.keys.length === 0 || !state.keys.every(validKey))
            bad();
        const pins = state.pins ?? {};
        if (!isObject(pins) || !Object.values(pins).every((pin) => isObject(pin) && typeof pin.scheme === 'string' && Number.isFinite(pin.at)))
            bad();
        const seen = state.seen ?? {};
        if (!isObject(seen) || !Object.values(seen).every((at) => Number.isFinite(at)))
            bad();
        return new CinderEkKeyring(identity, { v: 1, keys: state.keys, pins, seen }, opts);
    }
    /** 匯出狀態（含 EK 私鑰）：App 必須加密後再保存。不含身分私鑰。 */
    exportState() {
        const state = { v: 1, keys: this.#keys, pins: this.#pins, seen: this.#seen };
        return JSON.stringify(state);
    }
    /** 目前的 EK 公鑰 */
    get currentPublicKey() {
        return getPublicKey(hexToBytes(this.#current().sk));
    }
    /** 滿輪替週期（預設 7 天）就換一把新的，並刪掉過了寬限期的舊私鑰。回傳是否換了。 */
    rotateIfDue() {
        const now = this.#now();
        const due = shouldRotateFs(this.#keys, now, this.#rotateIntervalMs);
        if (due)
            this.#keys.push(this.#newKey());
        const kept = pruneFsKeys(this.#keys, now, this.#graceMs);
        // 刪掉的 EK：展開過的 ML-KEM 私鑰也從快取清掉、清零（安全審查 #11）
        for (const removed of this.#keys.filter((k) => !kept.includes(k))) {
            if (removed.pq) {
                this.#pqCache.get(removed.pq)?.sk.fill(0);
                this.#pqCache.delete(removed.pq);
            }
        }
        this.#keys = kept;
        return due;
    }
    /** 我的 kind 10040 公告（身分簽章）：輪替後要重新發布。 */
    buildAnnounce() {
        const current = this.#current();
        const pq = current.pq ? this.#pqOf(current.pq) : undefined;
        return this.#identity.sign({
            kind: EK_ANNOUNCE_KIND,
            created_at: Math.floor(this.#now() / 1000),
            // 能力宣告（PRD 3.5.3；SDK ADR 0014）：放在 tags，舊版讀者（今天的 Cinderous App）直接忽略
            tags: [engineCapabilityTag()],
            content: ekAnnounceContent(this.currentPublicKey, pq ? { pq: encodePqPublicKey(pq.pk) } : {}),
        });
    }
    /**
     * 封給對方：有公告就封給對方目前的 EK（對方有後量子就走混合式），沒有就封給身分金鑰。
     * rumor 裡順便夾上我目前的 EK，對方解開就學到。
     * 對方的加密等級比先前釘選的弱 → 丟 `SecurityDowngradeError`，不送。
     */
    seal(rumor, peer, announce, wrap) {
        const recipient = this.#recipientFor(peer, announce);
        const tags = withEkHint(rumor.tags, this.currentPublicKey);
        return this.#identity.sealAndWrap({ ...rumor, tags }, recipient, wrap);
    }
    /** 解封：依序試目前的 EK、寬限期內的舊 EK，最後退回身分金鑰。 */
    open(event) {
        const candidates = [...this.#keys]
            .sort((a, b) => b.at - a.at)
            .map((k) => {
            const pq = k.pq ? this.#pqOf(k.pq) : undefined;
            return pq ? { sk: hexToBytes(k.sk), pqSk: pq.sk } : { sk: hexToBytes(k.sk) };
        });
        let opened;
        let via;
        try {
            opened = openWrapWithEks(event, candidates);
            via = 'ek';
        }
        catch {
            opened = this.#identity.openWrap(event);
            via = 'identity';
        }
        return { ...opened, via, senderPinned: this.#pins[opened.sender] !== undefined };
    }
    #recipientFor(peer, announce) {
        const pinned = this.#pins[peer];
        const parsed = announce ? readEkAnnounce(announce) : null;
        if (parsed && parsed.ik !== peer)
            throw new Error('這份 EK 公告不是對方簽的');
        if (announce && parsed) {
            // 比先前看過的還舊 ⇒ 中繼在重放舊公告，照做會把訊息封給對方已經刪掉的 EK（安全審查 #12）
            const last = this.#seen[peer];
            if (last !== undefined && announce.created_at < last)
                throw new Error('這份 EK 公告比先前看過的舊：可能是中繼在重放舊公告');
            this.#seen[peer] = announce.created_at;
        }
        if (!parsed || parsed.kind !== 'ok') {
            // 沒有公告：退回身分金鑰。但先前見過對方的 FS 公告而這次沒有 ⇒ 可能被中繼藏起來了，不能默默退回。
            if (pinned && !parsed)
                throw new SecurityDowngradeError(peer, pinned.scheme, undefined);
            // 對方升級到我們讀不懂的版本：沒釘選過就照舊退回身分金鑰；釘選過就不默默失去前向保密（#9）
            if (pinned && parsed?.kind === 'newer')
                throw new PeerUpgradedError(peer, parsed.v);
            return peer;
        }
        const pq = parsed.pq ? decodePqPublicKey(parsed.pq) : undefined;
        const scheme = pq ? FS_CAPABILITY_PQ : FS_CAPABILITY;
        const pin = pinAfterDeclare(pinned, scheme, this.#now());
        this.#pins[peer] = pin;
        if (pinIsDowngraded(pin))
            throw new SecurityDowngradeError(peer, pin.scheme, scheme);
        return pq ? { pk: parsed.ek, pq } : { pk: parsed.ek };
    }
    #current() {
        return this.#keys.reduce((newest, k) => (k.at > newest.at ? k : newest));
    }
    #newKey() {
        const ek = generateEncryptionKey();
        const key = { sk: bytesToHex(ek.sk), at: this.#now() };
        if (this.#postQuantum)
            key.pq = encodePqSeed(generatePqSeed());
        return key;
    }
    #pqOf(seed) {
        if (!this.#pqCache.has(seed))
            this.#pqCache.set(seed, pqKeyFromStored(seed));
        return this.#pqCache.get(seed);
    }
}
//# sourceMappingURL=cinder-ek.js.map