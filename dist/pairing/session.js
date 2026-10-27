import { openWrap, sealAndWrap } from '../protocol/nip59.js';
import { confirmMac, deriveKeys, generateEphemeral, isPoint, macEquals, openPayload, pairingId, sasCode, sealPayload, transcriptHash, } from './crypto.js';
import { PairingError } from './errors.js';
import { claimDevice, defaultDeviceId, sanitizeLabel, verifyDeviceClaim, VaultMembership } from './roster.js';
import { shareableStandbyUrls } from './standby.js';
import { DEFAULT_PAIRING_TTL_MS, encodePairingUri, PAIRING_SECRET_BYTES, PAIRING_VERSION, parsePairingUri, } from './uri.js';
import { randomBytes } from '@noble/hashes/utils.js';
/** 配對訊息的 ephemeral kind（外層與內層相同；接在 21000 信令、21002 通話之後） */
export const PAIRING_KIND = 21003;
/** 使用者比對 SAS、按確認的時限（預設 3 分鐘） */
export const DEFAULT_PAIRING_CONFIRM_MS = 3 * 60_000;
/** 掃描方等顯示方回應的時限（預設 60 秒） */
export const DEFAULT_PAIRING_HANDSHAKE_MS = 60_000;
export const DEFAULT_PAIRING_RESEND_MS = 3_000;
/** 掃描方允許的時鐘誤差（QR 的到期時間是顯示方的時鐘） */
export const PAIRING_CLOCK_SKEW_MS = 2 * 60_000;
const MAX_RESEND_MS = 30_000;
const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** NIP-44 的明文上限 */
const MAX_CONTENT = 65_535;
const MAX_SEEN = 1024;
/** 歡迎訊息裡交給新裝置的中繼清單上限 */
const MAX_WELCOME_RELAYS = 16;
const MAX_RELAY_URL = 512;
const systemClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
};
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    promise.catch(() => { }); // 應用沒等這個 promise 時不要變成未處理的拒絕
    return { promise, resolve, reject };
}
/** 一次配對。以 `createPairingOffer`（顯示 QR 的一方）或 `acceptPairingUri`（掃描的一方）建立。 */
export class PairingSession {
    /** 顯示方才有：要做成 QR 的字串 */
    uri;
    invite;
    /** `displayer`＝顯示 QR 的一方 */
    position;
    /** `member`＝已在 Vault 裡的一方 */
    side;
    #opts;
    #clock;
    #signer;
    #device;
    #pid;
    #ephemeral;
    #listeners = new Set();
    #ready = deferred();
    #result = deferred();
    #seen = new Set();
    #state = 'waiting';
    #sub;
    #peer;
    #peerEphemeral;
    #keys;
    #th;
    #sas;
    #keyConfirmed = false;
    #localOk = false;
    #peerOk = false;
    #peerAdvanced = false;
    #welcomeSent = false;
    #peerClaim;
    #deadline;
    #resendTimer;
    #resendDelay;
    #resend;
    #error;
    /** @internal 請用 `createPairingOffer`／`acceptPairingUri` */
    constructor(invite, position, opts, uri) {
        this.invite = invite;
        this.position = position;
        this.uri = uri;
        this.#opts = opts;
        this.#clock = opts.clock ?? systemClock;
        this.#signer = opts.signer;
        const memberDisplays = invite.role === 'invite';
        this.side = (position === 'displayer') === memberDisplays ? 'member' : 'joiner';
        if (this.side === 'member' && (!opts.membership || !opts.membership.active || opts.membership.self !== opts.signer.pubkey)) {
            throw new PairingError('wrong-role', '成員這一側需要這台裝置有效的 VaultMembership');
        }
        const self = this.side === 'member' ? opts.membership.selfDevice : undefined;
        const deviceId = self?.deviceId ?? opts.device?.deviceId ?? defaultDeviceId(opts.signer.pubkey);
        if (!DEVICE_ID.test(deviceId))
            throw new PairingError('device-id-conflict', 'deviceId 只能用英數與 _.:-，最長 64');
        this.#device = { deviceId, label: sanitizeLabel(self?.label ?? opts.device?.label ?? '') };
        this.#pid = pairingId(invite.secret);
        this.#ephemeral = generateEphemeral();
        this.#resendDelay = opts.resendMs ?? DEFAULT_PAIRING_RESEND_MS;
    }
    get state() {
        return this.#state;
    }
    get peer() {
        return this.#peer ? { ...this.#peer } : undefined;
    }
    /** 6 位數短驗證碼：兩台螢幕都顯示，使用者比對一致才按確認 */
    get sas() {
        return this.#sas;
    }
    get error() {
        return this.#error;
    }
    /** SAS 算出來時完成（失敗時拒絕） */
    get ready() {
        return this.#ready.promise;
    }
    /** 配對完成時完成（失敗時以 `PairingError` 拒絕） */
    get result() {
        return this.#result.promise;
    }
    onUpdate(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    /** 使用者確認兩台的 SAS 相同 */
    confirm() {
        if (this.#state !== 'confirming')
            throw new Error('PairingSession：還不能確認（SAS 尚未出現或配對已結束）');
        if (this.#localOk)
            return;
        this.#localOk = true;
        if (this.side === 'joiner') {
            this.#setState('delivering');
            const c = claimDevice(this.#signer, this.#device);
            this.#startResend(() => this.#msg('ok', { m: this.#mac('ok'), c }));
        }
        else {
            try {
                this.#maybeWelcome();
            }
            catch (error) {
                // 例如在等待確認的期間名單變了（deviceId 被另一台佔走、名單滿了）：作廢並通知對方，不把例外丟給 UI
                this.#abort(error instanceof PairingError ? error.reason : 'bad-message', error instanceof Error ? error.message : String(error));
            }
        }
    }
    /** 使用者說 SAS 不同（或不認得對方）：通知對方、作廢 */
    reject() {
        this.#abort('rejected', '使用者拒絕');
    }
    cancel() {
        this.#abort('cancelled', '已取消');
    }
    // ───────────────────────── 啟動 ─────────────────────────
    /** @internal */
    start() {
        this.#sub = this.#opts.pool.subscribe([{ kinds: [PAIRING_KIND], '#p': [this.#signer.pubkey] }], {
            onEvent: (event) => this.#ingest(event),
        });
        if (this.position === 'displayer') {
            const ms = this.invite.expiresAt * 1000 - this.#clock.now();
            this.#deadline = this.#clock.setTimeout(() => this.#fail(new PairingError('expired', '配對 QR 已過期，請重新產生')), Math.max(0, ms));
            return;
        }
        // 掃描方
        if (this.#clock.now() > this.invite.expiresAt * 1000 + PAIRING_CLOCK_SKEW_MS) {
            this.#fail(new PairingError('expired', '配對 QR 已過期，請在另一台重新產生'));
            return;
        }
        if (this.invite.pubkey === this.#signer.pubkey) {
            this.#fail(new PairingError('wrong-role', '不能和自己配對'));
            return;
        }
        if (this.side === 'member' && this.#opts.membership.isRevoked(this.invite.pubkey)) {
            this.#fail(new PairingError('revoked-device', '這台裝置已被撤銷；請在那台裝置重設身分後再配對'));
            return;
        }
        this.#setState('handshake');
        this.#deadline = this.#clock.setTimeout(() => this.#fail(this.#relaysUnavailable() ?? new PairingError('timeout', '沒有收到另一台的回應（確認兩台連到同一座中繼）')), this.#opts.handshakeTimeoutMs ?? DEFAULT_PAIRING_HANDSHAKE_MS);
        this.#startResend(() => this.#msg('hello', { e: this.#ephemeral.publicKey, d: this.#device.deviceId, l: this.#device.label }));
    }
    /**
     * 配對用的每一座主要中繼都標成暫時不能用（SDK ADR 0108）時，逾時的原因是中繼、不是另一台。
     * 只看得到 `RelayPool` 的健康狀態；自訂傳輸層沒有就回 undefined（照舊 `timeout`）。
     */
    #relaysUnavailable() {
        const pool = this.#opts.pool;
        const primaries = [...(pool.relayHealth?.().values() ?? [])].filter((h) => !h.standby);
        const reasons = primaries.map((h) => h.marks.find((mark) => mark.kind === 'unavailable')?.reason);
        if (primaries.length === 0 || reasons.some((reason) => reason === undefined))
            return undefined;
        return new PairingError('relay-unavailable', `配對用的中繼暫時不能用（${[...new Set(reasons)].join('、')}）`);
    }
    // ───────────────────────── 收訊 ─────────────────────────
    #ingest(event) {
        // 完成後新裝置還會多聽一會兒（回覆重送的 welcome），所以只擋失敗
        if (this.#state === 'failed' || event.kind !== PAIRING_KIND || this.#seen.has(event.id))
            return;
        this.#seen.add(event.id);
        if (this.#seen.size > MAX_SEEN)
            this.#seen.delete(this.#seen.values().next().value);
        if (!event.tags.some((t) => t[0] === 'p' && t[1] === this.#signer.pubkey))
            return;
        let sender;
        let msg;
        try {
            const opened = openWrap(event, this.#signer);
            if (opened.rumor.kind !== PAIRING_KIND || opened.rumor.content.length > MAX_CONTENT)
                return;
            sender = opened.sender;
            msg = JSON.parse(opened.rumor.content);
        }
        catch {
            return; // 不是給我的、壞掉的
        }
        if (typeof msg !== 'object' || msg === null || msg.v !== PAIRING_VERSION || msg.p !== this.#pid || sender === this.#signer.pubkey)
            return;
        try {
            if (this.position === 'displayer')
                this.#onDisplayer(sender, msg);
            else
                this.#onScanner(sender, msg);
        }
        catch (error) {
            this.#abort(error instanceof PairingError ? error.reason : 'bad-message', error instanceof Error ? error.message : String(error));
        }
    }
    #onDisplayer(sender, msg) {
        if (msg.t === 'hello') {
            if (!this.#peer) {
                if (this.#clock.now() > this.invite.expiresAt * 1000)
                    return;
                const device = this.#parseDevice(msg);
                if (!device || !isPoint(msg.e))
                    return;
                const peer = { pubkey: sender, ...device };
                this.#peer = peer; // 先綁定：下面檢查不過時 abort 會通知對方
                if (this.side === 'member')
                    this.#checkJoiner(peer);
                this.#peerEphemeral = msg.e;
                this.#derive();
                this.#clock.clearTimeout(this.#deadline);
                this.#deadline = this.#clock.setTimeout(() => this.#onConfirmTimeout(), this.#opts.confirmTimeoutMs ?? DEFAULT_PAIRING_CONFIRM_MS);
                this.#setState('handshake');
                this.#sendAccept();
                return;
            }
            if (sender === this.#peer.pubkey && msg.e === this.#peerEphemeral) {
                if (!this.#keyConfirmed)
                    this.#sendAccept(); // 對方沒收到 accept
                return;
            }
            // 另一台（或同一台換了臨時金鑰）也拿這個 QR 來配對：QR 可能被別人拍到。作廢，請重新產生
            if (this.#state === 'complete')
                return;
            if (sender !== this.#peer.pubkey)
                this.#send(this.#msg('abort', { why: 'contested' }), sender); // 第二台也要知道（審查 #7）
            this.#abort('contested', '有另一台裝置也用這個 QR 配對（QR 可能被別人看到），這次配對已作廢，請重新產生');
            return;
        }
        if (!this.#peer || sender !== this.#peer.pubkey)
            return;
        this.#afterHandshake(msg);
    }
    #onScanner(sender, msg) {
        if (sender !== this.invite.pubkey)
            return; // 只信 QR 上那把公鑰
        if (msg.t === 'accept') {
            if (this.#peer) {
                if (msg.e === this.#peerEphemeral && !this.#peerAdvanced)
                    this.#send(this.#msg('confirm', { m: this.#mac('confirm') }));
                return;
            }
            const device = this.#parseDevice(msg);
            if (!device || !isPoint(msg.e))
                throw new PairingError('bad-message', '對方的回應格式不對');
            const peer = { pubkey: sender, ...device };
            this.#peerEphemeral = msg.e;
            this.#peer = peer;
            this.#derive();
            if (!macEquals(msg.m, this.#mac('accept')))
                throw new PairingError('bad-message', '對方的回應驗證失敗（配對秘密不符或訊息被竄改）');
            if (this.side === 'member')
                this.#checkJoiner(peer);
            this.#keyConfirmed = true;
            this.#clock.clearTimeout(this.#deadline);
            this.#deadline = this.#clock.setTimeout(() => this.#onConfirmTimeout(), this.#opts.confirmTimeoutMs ?? DEFAULT_PAIRING_CONFIRM_MS);
            this.#resendDelay = this.#opts.resendMs ?? DEFAULT_PAIRING_RESEND_MS;
            this.#startResend(() => this.#msg('confirm', { m: this.#mac('confirm') }));
            this.#showSas();
            return;
        }
        if (!this.#peer && msg.t !== 'abort')
            return;
        this.#afterHandshake(msg);
    }
    /** accept／confirm 之後兩個位置共用的部分 */
    #afterHandshake(msg) {
        switch (msg.t) {
            case 'confirm':
                if (this.position !== 'displayer' || this.#keyConfirmed)
                    return;
                if (!macEquals(msg.m, this.#mac('confirm')))
                    throw new PairingError('bad-message', '對方的確認驗證失敗（配對秘密不符或訊息被竄改）');
                this.#keyConfirmed = true;
                this.#showSas();
                return;
            case 'ok':
                if (this.side !== 'member')
                    return;
                if (!macEquals(msg.m, this.#mac('ok')))
                    throw new PairingError('bad-message', '對方的確認驗證失敗');
                // 新裝置自己對 (公鑰, deviceId, 名稱) 的簽章：名單上的這一筆別台改不了（審查 #3）
                if (!verifyDeviceClaim(this.#peer, msg.c))
                    throw new PairingError('bad-message', '對方的裝置聲明驗證失敗');
                this.#peerClaim = msg.c;
                this.#peerAdvance();
                if (!this.#keyConfirmed) {
                    // confirm 遺失了，但 ok 也證明對方有同一把金鑰
                    this.#keyConfirmed = true;
                    this.#showSas();
                }
                this.#peerOk = true;
                this.#maybeWelcome();
                return;
            case 'welcome':
                if (this.side !== 'joiner')
                    return;
                this.#peerAdvance();
                this.#onWelcome(msg);
                return;
            case 'done':
                if (this.side !== 'member' || !this.#welcomeSent)
                    return;
                if (!macEquals(msg.m, this.#mac('done')))
                    throw new PairingError('bad-message', '對方的回報驗證失敗');
                this.#complete(true);
                return;
            case 'abort': {
                const why = typeof msg.why === 'string' ? msg.why.slice(0, 64) : '';
                if (this.#state === 'complete')
                    return;
                const passThrough = ['contested', 'revoked-device', 'device-id-conflict', 'timeout'];
                this.#fail(new PairingError(passThrough.includes(why) ? why : 'peer-rejected', `另一台取消了配對${why ? `（${why}）` : ''}`));
                return;
            }
            default:
                return;
        }
    }
    #peerAdvance() {
        if (this.position === 'scanner' && !this.#peerAdvanced) {
            this.#peerAdvanced = true;
            if (!this.#localOk || this.side === 'member')
                this.#stopResend();
        }
    }
    #checkJoiner(peer) {
        const m = this.#opts.membership;
        if (m.isRevoked(peer.pubkey))
            throw new PairingError('revoked-device', '這台裝置已被撤銷；請在那台裝置重設身分後再配對');
        for (const d of m.devices()) {
            if (d.deviceId === peer.deviceId && d.pubkey !== peer.pubkey)
                throw new PairingError('device-id-conflict', `deviceId ${peer.deviceId} 已被 Vault 裡另一台裝置使用`);
        }
    }
    #parseDevice(msg) {
        if (typeof msg.d !== 'string' || !DEVICE_ID.test(msg.d) || typeof msg.l !== 'string' || msg.l.length > 200)
            return null;
        return { deviceId: msg.d, label: sanitizeLabel(msg.l) };
    }
    // ───────────────────────── 金鑰 ─────────────────────────
    #derive() {
        const displayer = this.position === 'displayer';
        const peer = this.#peer;
        this.#th = transcriptHash({
            role: this.invite.role,
            displayer: displayer ? this.#signer.pubkey : peer.pubkey,
            scanner: displayer ? peer.pubkey : this.#signer.pubkey,
            pid: this.#pid,
            scannerEphemeral: displayer ? this.#peerEphemeral : this.#ephemeral.publicKey,
            displayerEphemeral: displayer ? this.#ephemeral.publicKey : this.#peerEphemeral,
            scannerDevice: displayer ? peer : this.#device,
            displayerDevice: displayer ? this.#device : peer,
        });
        this.#keys = deriveKeys({
            ephemeral: this.#ephemeral,
            peerEphemeral: this.#peerEphemeral,
            signer: this.#signer,
            peer: peer.pubkey,
            secret: this.invite.secret,
            transcript: this.#th,
        });
        this.#ephemeral.secretKey.fill(0);
    }
    #mac(label) {
        return confirmMac(this.#keys, label, this.#th);
    }
    #sendAccept() {
        this.#send(this.#msg('accept', { e: this.#ephemeral.publicKey, d: this.#device.deviceId, l: this.#device.label, m: this.#mac('accept') }));
    }
    #showSas() {
        if (this.#sas)
            return;
        this.#sas = sasCode(this.#keys);
        this.#setState('confirming');
        this.#ready.resolve({ sas: this.#sas, peer: { ...this.#peer } });
    }
    // ───────────────────────── 交付 ─────────────────────────
    #maybeWelcome() {
        if (this.side !== 'member' || !this.#localOk || !this.#peerOk || this.#welcomeSent || this.#done())
            return;
        const m = this.#opts.membership;
        m.addDevice({ ...this.#peer, claim: this.#peerClaim }); // 被撤銷、deviceId 相撞會丟 PairingError → abort
        this.#welcomeSent = true;
        this.#setState('delivering');
        const relays = welcomeRelays(this.#opts.relays ?? this.invite.relays);
        // 名單上的備援宣告只帶邀請方自己的（其他成員的之後經名單同步補上），歡迎訊息的大小不受成員數影響
        const roster = m.roster();
        const own = roster.standby?.filter((x) => x.pubkey === m.self) ?? [];
        if (own.length > 0)
            roster.standby = own;
        else
            delete roster.standby;
        // 輕量成員宣告同理（SDK ADR 0058）
        const ownSparse = roster.sparse?.filter((x) => x.pubkey === m.self) ?? [];
        if (ownSparse.length > 0)
            roster.sparse = ownSparse;
        else
            delete roster.sparse;
        // 改名宣告同理（SDK ADR 0069）
        const ownLabel = roster.labels?.filter((x) => x.pubkey === m.self) ?? [];
        if (ownLabel.length > 0)
            roster.labels = ownLabel;
        else
            delete roster.labels;
        const standby = this.#welcomeStandby();
        const payload = new TextEncoder().encode(JSON.stringify({ roster, relays, ...(standby.length > 0 ? { standby } : {}) }));
        const c = sealPayload(this.#keys.memberToJoiner, payload, this.#th);
        payload.fill(0);
        this.#startResend(() => this.#msg('welcome', { c }));
    }
    #onWelcome(msg) {
        if (this.#state === 'complete') {
            this.#send(this.#msg('done', { m: this.#mac('done') })); // 對方沒收到 done
            return;
        }
        if (!this.#localOk)
            return;
        const plain = openPayload(this.#keys.memberToJoiner, msg.c, this.#th);
        if (!plain)
            throw new PairingError('bad-message', '歡迎訊息解不開（可能被竄改）');
        let body;
        try {
            body = JSON.parse(new TextDecoder().decode(plain));
        }
        catch {
            throw new PairingError('bad-message', '歡迎訊息格式不對');
        }
        let membership;
        try {
            membership = VaultMembership.fromRoster(this.#signer, body.roster);
        }
        catch {
            throw new PairingError('bad-message', '歡迎訊息裡的名單不合法');
        }
        const self = membership.selfDevice;
        if (!membership.active || !self || self.deviceId !== this.#device.deviceId || !membership.isMember(this.#peer.pubkey)) {
            throw new PairingError('bad-message', '歡迎訊息裡的名單沒有正確列入這兩台裝置');
        }
        const relays = welcomeRelays(Array.isArray(body.relays) ? body.relays : []);
        const standby = shareableStandbyUrls(Array.isArray(body.standby) ? body.standby : []);
        this.#send(this.#msg('done', { m: this.#mac('done') }));
        this.#finish({ peer: { ...this.#peer }, membership, relays, standby, acknowledged: true }, true);
    }
    /** 成員交給新裝置的備援（SDK ADR 0056） */
    #welcomeStandby() {
        const m = this.#opts.membership;
        return shareableStandbyUrls(this.#opts.standby ?? m.standbyOf(m.self) ?? []);
    }
    #complete(acknowledged) {
        this.#finish({
            peer: { ...this.#peer },
            membership: this.#opts.membership,
            relays: welcomeRelays(this.#opts.relays ?? this.invite.relays),
            standby: this.#welcomeStandby(),
            acknowledged,
        }, false);
    }
    #finish(result, linger) {
        if (this.#done())
            return;
        this.#stopResend();
        this.#clock.clearTimeout(this.#deadline);
        this.#setState('complete');
        this.#result.resolve(result);
        if (linger) {
            // 新裝置多聽一會兒：done 遺失時成員會重送 welcome，這邊再回一次 done
            this.#deadline = this.#clock.setTimeout(() => this.#close(), MAX_RESEND_MS * 2);
        }
        else {
            this.#close();
        }
    }
    #onConfirmTimeout() {
        if (this.#welcomeSent) {
            this.#complete(false); // 名單已加入；只是沒收到對方的回報
            return;
        }
        this.#abort('timeout', '等待確認逾時');
    }
    // ───────────────────────── 送出 ─────────────────────────
    #msg(t, fields) {
        return { v: PAIRING_VERSION, t, p: this.#pid, ...fields };
    }
    #send(msg, recipient) {
        const to = recipient ?? this.#peer?.pubkey ?? this.invite.pubkey;
        let event;
        try {
            const now = Math.floor(this.#clock.now() / 1000);
            event = sealAndWrap({ kind: PAIRING_KIND, created_at: now, tags: [], content: JSON.stringify(msg) }, this.#signer, to, {
                kind: PAIRING_KIND,
                created_at: now,
                tags: [['p', to]],
            });
        }
        catch {
            return;
        }
        void this.#opts.pool.publish(event).catch(() => { });
    }
    #startResend(build) {
        this.#stopResend();
        this.#resend = build;
        this.#resendDelay = this.#opts.resendMs ?? DEFAULT_PAIRING_RESEND_MS;
        this.#send(build());
        this.#scheduleResend();
    }
    #scheduleResend() {
        this.#resendTimer = this.#clock.setTimeout(() => {
            if (!this.#resend || this.#done())
                return;
            this.#send(this.#resend());
            this.#resendDelay = Math.min(this.#resendDelay * 2, MAX_RESEND_MS);
            this.#scheduleResend();
        }, this.#resendDelay);
    }
    #stopResend() {
        this.#resend = undefined;
        this.#clock.clearTimeout(this.#resendTimer);
    }
    // ───────────────────────── 結束 ─────────────────────────
    #done() {
        return this.#state === 'complete' || this.#state === 'failed';
    }
    #abort(reason, message) {
        if (this.#done())
            return;
        if (this.#peer)
            this.#send(this.#msg('abort', { why: reason }));
        this.#fail(new PairingError(reason, message));
    }
    #fail(error) {
        if (this.#done())
            return;
        this.#error = error;
        this.#stopResend();
        this.#clock.clearTimeout(this.#deadline);
        this.#state = 'failed';
        this.#ready.reject(error);
        this.#result.reject(error);
        this.#close();
        this.#notify();
    }
    #close() {
        this.#sub?.close();
        this.#sub = undefined;
        this.#keys?.confirm.fill(0);
        this.#keys?.memberToJoiner.fill(0);
        this.#keys?.sas.fill(0);
        this.invite.secret.fill(0); // 一次性秘密用完即焚（審查 #8）
    }
    #setState(state) {
        if (this.#state === state)
            return;
        this.#state = state;
        this.#notify();
    }
    #notify() {
        const update = { state: this.#state };
        if (this.#peer)
            update.peer = { ...this.#peer };
        if (this.#sas)
            update.sas = this.#sas;
        if (this.#error)
            update.error = this.#error;
        for (const listener of [...this.#listeners]) {
            try {
                listener(update);
            }
            catch {
                // 監聽者的例外不影響配對
            }
        }
    }
}
function welcomeRelays(list) {
    const out = [];
    for (const r of list) {
        if (typeof r === 'string' && /^wss?:\/\/\S+$/i.test(r) && r.length <= MAX_RELAY_URL && !out.includes(r))
            out.push(r);
        if (out.length >= MAX_WELCOME_RELAYS)
            break;
    }
    return out;
}
/**
 * 顯示 QR 的一方：產生一次性秘密與 QR 字串，開始等對方掃描。
 *
 * - `role: 'invite'`：這台是 Vault 成員（要給 `membership`），邀請新裝置加入；
 * - `role: 'join'`：這台是新裝置，請已經在 Vault 裡的裝置掃描。
 */
export function createPairingOffer(opts) {
    const clock = opts.clock ?? systemClock;
    const secret = opts.secret ?? randomBytes(PAIRING_SECRET_BYTES);
    const invite = {
        version: PAIRING_VERSION,
        role: opts.role,
        pubkey: opts.signer.pubkey,
        secret,
        expiresAt: Math.ceil((clock.now() + (opts.ttlMs ?? DEFAULT_PAIRING_TTL_MS)) / 1000),
        relays: [...(opts.relays ?? [])],
    };
    const uri = encodePairingUri(invite);
    const parsed = parsePairingUri(uri); // 只保留真的放進 QR 的中繼
    const session = new PairingSession(parsed, 'displayer', opts, uri);
    session.start();
    return session;
}
/** 掃描的一方：解析 QR 字串、連到裡面的中繼（`pool` 由應用依 `parsePairingUri(uri).relays` 建立）、開始握手。 */
export function acceptPairingUri(uri, opts) {
    const invite = parsePairingUri(uri);
    const session = new PairingSession(invite, 'scanner', opts);
    session.start();
    return session;
}
//# sourceMappingURL=session.js.map