// secureChannel（SDK ADR 0010 §2）：在已驗證身分的 PeerChannel 上握手，之後每則都走雙棘輪。
//
// 通道本身已經驗證過對方身分（P2P 軌的 DTLS 指紋經 NIP-59 信令交換；中繼軌每框都是 NIP-59），
// 所以握手在通道內做即可。
//
// 握手：雙方一連上就各送一則 hello（臨時 DH 公鑰＋ML-KEM 公鑰）。兩邊都送，才不會在
// 「中繼軌要有框到達對方才知道通道存在」時互等。公鑰較小的一方當 Alice。
//   共享秘密 = HKDF(雙方身分的 NIP-44 對話金鑰 ‖ 臨時 DH；info = 兩則 hello 的雜湊)
//   Alice 以 Bob 的 hello 起始棘輪，第一步就封裝給 Bob 的 ML-KEM 公鑰 ⇒ 所有鏈金鑰都混入後量子秘密。
//   ⚠ 握手本身的秘密只有古典的部分：擋得住「今天側錄、將來解密」，擋不住握手當下就有量子電腦的主動攻擊者。
//
// 金鑰確認（ADR 0010 §5，安全審查 #4）：Alice 送「開始」，Bob 解開後回「確認」；
// 雙方各自**解開過一則對方的訊息**才算完成。對方中途放棄時，這邊逾時失敗，不會「成功」連到空氣。
//
// 後量子線路格式協商（ADR 0033 §5）：hello 帶 `pqf`（支援的後量子線路格式版本清單）。兩則 hello 都雜湊進
// 共享秘密，改掉 `pqf` 會讓握手失敗，中間人無法把雙方降到舊格式。要後量子而對方沒有共同版本
// （v0.27 以前的 SDK 不帶 `pqf`）⇒ 丟 `UnsupportedRatchetVersionError`，不退回舊格式也不退回古典。
// 純古典模式的 header 與 v0.27 相同，新舊版本照樣互通。
//
// 線路格式：第一個位元組 1＝hello（JSON）、2＝棘輪訊息（header ‖ 密文）。
// 棘輪訊息解開後，第一個位元組 0＝控制（開始／確認）、1＝資料。
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { decodePqPublicKey, encodePqPublicKey, generatePqSeed, pqKeyFromSeed } from '../protocol/hybrid-kem.js';
import { SecurityDowngradeError } from './cinder-ek.js';
import { DEFAULT_MAX_SKIPPED_KEYS, DoubleRatchetSession, generateRatchetKeyPair, RatchetProtocolError, ratchetHeaderLength } from './double-ratchet.js';
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const WIRE_HELLO = 1;
const WIRE_RATCHET = 2;
const PAYLOAD_CONTROL = 0;
const PAYLOAD_DATA = 1;
/** 本版支援的後量子線路格式（ADR 0033）。1＝v0.27 以前每則固定 2,314 B 的格式，已不支援。 */
const PQ_WIRE_FORMATS = [2];
const HANDSHAKE_SALT = utf8ToBytes('cinderous/dr/v1/handshake');
const AD_LABEL = utf8ToBytes('cinderous/dr/v1');
/** 握手完成前最多先收著幾則棘輪訊息 */
const MAX_EARLY_MESSAGES = 64;
/** 還沒人聽的訊息最多先收著幾則 */
const MAX_BUFFERED_MESSAGES = 1_000;
/** 對方的 SDK 不支援我們要的後量子線路格式（例如 v0.27 以前的版本）：請雙方升級，不會退回舊格式或古典。 */
export class UnsupportedRatchetVersionError extends Error {
    peer;
    peerFormats;
    name = 'UnsupportedRatchetVersionError';
    constructor(peer, 
    /** 對方宣告的版本；空陣列＝沒宣告（v0.27 以前） */
    peerFormats) {
        super(`對方的雙棘輪後量子線路格式（${peerFormats.length ? peerFormats.join('、') : '舊版，未宣告'}）與本版（${PQ_WIRE_FORMATS.join('、')}）不相容：請雙方都升級 SDK 到 0.28.0 以上`);
        this.peer = peer;
        this.peerFormats = peerFormats;
    }
}
function parseHello(bytes) {
    try {
        const hello = JSON.parse(new TextDecoder().decode(bytes));
        if (hello.v !== 1 || typeof hello.dh !== 'string' || !/^[0-9a-f]{64}$/.test(hello.dh))
            return null;
        if (hello.kem !== undefined && typeof hello.kem !== 'string')
            return null;
        if (hello.pqf !== undefined && (!Array.isArray(hello.pqf) || hello.pqf.length > 16 || !hello.pqf.every((f) => Number.isInteger(f) && f > 0 && f < 256)))
            return null;
        return hello;
    }
    catch {
        return null;
    }
}
function encodeRatchet(envelope) {
    return concatBytes(new Uint8Array([WIRE_RATCHET]), envelope.header, envelope.ciphertext);
}
function decodeRatchet(bytes) {
    const headerBytes = ratchetHeaderLength(bytes.subarray(1));
    if (headerBytes === 0)
        return null;
    return {
        engineType: 'double-ratchet',
        header: bytes.slice(1, 1 + headerBytes),
        ciphertext: bytes.slice(1 + headerBytes),
    };
}
const asError = (error) => (error instanceof Error ? error : new Error(String(error)));
/** 在 `channel` 上握手，回傳雙棘輪加密的通道。對方也要對同一條通道呼叫 `secureChannel`。 */
export async function secureChannel(channel, identity, opts = {}) {
    const wantPq = opts.postQuantum ?? true;
    const peer = channel.peerPublicKey.toLowerCase();
    const me = identity.pubkey.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(peer))
        throw new Error('雙棘輪：對方公鑰格式不正確');
    // 同一個身分的兩台裝置：雙方算出同一個角色，握手永遠不會完成（雙棘輪本來就不跨自己的裝置，ADR 0010 §2）
    if (peer === me)
        throw new Error('雙棘輪：通道的對方是自己，不能建立會話');
    const iAmAlice = me < peer;
    const ephemeral = generateRatchetKeyPair();
    const kemSeed = wantPq ? generatePqSeed() : undefined;
    const kem = kemSeed ? pqKeyFromSeed(kemSeed) : undefined;
    const myHello = { v: 1, dh: bytesToHex(ephemeral.publicKey), ...(kem ? { kem: encodePqPublicKey(kem.pk) } : {}), pqf: [...PQ_WIRE_FORMATS] };
    const myHelloBytes = utf8ToBytes(JSON.stringify(myHello));
    const wipeHandshakeKem = () => {
        kem?.sk.fill(0);
        kemSeed?.fill(0);
    };
    return new Promise((resolve, reject) => {
        let session;
        let secure;
        let settled = false;
        let confirmed = false;
        const early = [];
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            offClose();
            secure?.detach();
            session?.destroy();
            ephemeral.secretKey.fill(0);
            wipeHandshakeKem();
            reject(error);
        };
        const succeed = () => {
            if (settled || !secure)
                return;
            settled = true;
            clearTimeout(timer);
            offClose();
            resolve(secure);
        };
        const timer = setTimeout(() => fail(new Error('雙棘輪握手逾時：對方沒有回應或沒有確認')), opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
        const offClose = channel.onClose(() => fail(new Error('握手完成前通道就關閉了')));
        const handleRatchet = async (bytes) => {
            if (!session || !secure) {
                if (early.length < MAX_EARLY_MESSAGES)
                    early.push(bytes);
                return;
            }
            const envelope = decodeRatchet(bytes);
            if (!envelope)
                return;
            let plaintext;
            try {
                plaintext = await session.decrypt(envelope);
            }
            catch (error) {
                if (error instanceof SecurityDowngradeError || error instanceof RatchetProtocolError) {
                    // 後量子輪次長期完成不了（ADR 0033 §6），或通過 MAC 的訊息違反協定（§10 #5）：
                    // 會話已銷毀，關掉通道並回報，不靜默退回純古典、也不卡著不動
                    if (settled)
                        opts.onListenerError?.(error);
                    else
                        fail(error);
                    channel.close();
                }
                return; // 竄改、重放、不是這個會話的：丟掉（會話狀態不變）
            }
            if (!confirmed) {
                confirmed = true;
                // Bob：解開 Alice 的第一則，回一則確認，Alice 才知道金鑰對得上
                if (!iAmAlice) {
                    try {
                        await secure.sendRaw(new Uint8Array([PAYLOAD_CONTROL]));
                    }
                    catch (error) {
                        fail(asError(error));
                        return;
                    }
                }
                succeed();
            }
            if (plaintext[0] === PAYLOAD_DATA)
                secure.deliver(plaintext.subarray(1));
        };
        const handleHello = async (bytes) => {
            if (session)
                return; // 重複的 hello
            const hello = parseHello(bytes);
            if (!hello)
                return;
            const peerKem = hello.kem ? decodePqPublicKey(hello.kem) : undefined;
            if (wantPq && !peerKem) {
                fail(new SecurityDowngradeError(peer, 'pq-double-ratchet-v2', 'double-ratchet'));
                return;
            }
            const pq = wantPq && peerKem !== undefined;
            if (pq && !(hello.pqf ?? []).some((f) => PQ_WIRE_FORMATS.includes(f))) {
                fail(new UnsupportedRatchetVersionError(peer, hello.pqf ?? []));
                return;
            }
            const peerEphemeral = hexToBytes(hello.dh);
            let dhOut;
            try {
                dhOut = secp256k1.getSharedSecret(ephemeral.secretKey, concatBytes(new Uint8Array([2]), peerEphemeral)).subarray(1, 33);
            }
            catch {
                fail(new Error('對方的握手公鑰不合法'));
                return;
            }
            const [aliceHello, bobHello] = iAmAlice ? [myHelloBytes, bytes] : [bytes, myHelloBytes];
            const identitySecret = identity.conversationKey(peer);
            const sharedSecret = hkdf(sha256, concatBytes(identitySecret, dhOut), HANDSHAKE_SALT, sha256(concatBytes(aliceHello, bobHello)), 32);
            identitySecret.fill(0);
            dhOut.fill(0);
            const [alicePk, bobPk] = iAmAlice ? [me, peer] : [peer, me];
            const associatedData = concatBytes(AD_LABEL, hexToBytes(alicePk), hexToBytes(bobPk));
            const common = { sharedSecret, associatedData, peerPublicKey: peer, maxSkippedKeys: opts.maxSkippedKeys ?? DEFAULT_MAX_SKIPPED_KEYS, pqRekeyInterval: opts.pqRekeyInterval };
            try {
                if (iAmAlice) {
                    session = DoubleRatchetSession.initAlice({ ...common, bobRatchetPublicKey: peerEphemeral, bobKemPublicKey: pq ? peerKem : undefined });
                    ephemeral.secretKey.fill(0); // Alice 的臨時金鑰只用在握手
                    wipeHandshakeKem(); // Alice 自己的握手 ML-KEM 金鑰用不到
                }
                else {
                    session = DoubleRatchetSession.initBob({
                        ...common,
                        ratchetKeyPair: ephemeral, // Bob 的臨時金鑰就是他的初始棘輪金鑰
                        kemKeyPair: pq ? kem : undefined,
                        kemSeed: pq ? kemSeed : undefined,
                    });
                    if (!pq)
                        wipeHandshakeKem();
                }
            }
            catch (error) {
                fail(asError(error));
                return;
            }
            finally {
                sharedSecret.fill(0);
            }
            secure = new SecureChannelImpl(channel, session, pq, opts.onListenerError);
            if (iAmAlice) {
                try {
                    await secure.sendRaw(new Uint8Array([PAYLOAD_CONTROL])); // 「開始」：Bob 收到後才有傳送鏈
                }
                catch (error) {
                    fail(asError(error));
                    return;
                }
            }
            for (const queued of early.splice(0))
                await handleRatchet(queued);
        };
        // 同一條通道上的訊息依序處理（hello 的非同步步驟還沒做完，下一則不能先跑）。
        // 每一步都自己接住錯誤：一次失敗不能讓整條佇列停擺（安全審查 #2）。
        let queue = Promise.resolve();
        const unsubscribe = channel.onMessage((bytes) => {
            const step = bytes[0] === WIRE_HELLO ? () => handleHello(bytes.subarray(1)) : bytes[0] === WIRE_RATCHET ? () => handleRatchet(bytes) : undefined;
            if (step)
                queue = queue.then(step).catch((error) => opts.onListenerError?.(error));
        });
        void channel.send(concatBytes(new Uint8Array([WIRE_HELLO]), myHelloBytes)).catch((error) => fail(asError(error)));
    });
}
class SecureChannelImpl {
    channel;
    session;
    postQuantum;
    onListenerError;
    engineType = 'double-ratchet';
    #listeners = new Set();
    #buffered = [];
    #offClose;
    #sending = Promise.resolve();
    constructor(channel, session, postQuantum, onListenerError) {
        this.channel = channel;
        this.session = session;
        this.postQuantum = postQuantum;
        this.onListenerError = onListenerError;
        this.#offClose = channel.onClose(() => session.destroy());
    }
    get peerPublicKey() {
        return this.channel.peerPublicKey;
    }
    get mode() {
        return this.channel.mode;
    }
    /** 握手失敗時解除掛在通道上的監聽 */
    detach() {
        this.#offClose();
    }
    deliver(data) {
        if (this.#listeners.size === 0) {
            if (this.#buffered.length < MAX_BUFFERED_MESSAGES)
                this.#buffered.push(data);
            return;
        }
        for (const listener of this.#listeners) {
            try {
                listener(data);
            }
            catch (error) {
                this.onListenerError?.(error); // App 的監聽出錯，不影響其他監聽與之後的訊息
            }
        }
    }
    sendRaw(payload) {
        // 依呼叫順序加密、依序送出：棘輪序號與送出順序一致，接收端少算跳過的金鑰
        const next = this.#sending.then(async () => {
            if (this.channel.closed)
                throw new Error('通道已關閉');
            const envelope = await this.session.encrypt(payload);
            await this.channel.send(encodeRatchet(envelope));
        });
        this.#sending = next.catch(() => { });
        return next;
    }
    send(data) {
        return this.sendRaw(concatBytes(new Uint8Array([PAYLOAD_DATA]), data));
    }
    onMessage(listener) {
        this.#listeners.add(listener);
        for (const data of this.#buffered.splice(0)) {
            try {
                listener(data);
            }
            catch (error) {
                this.onListenerError?.(error);
            }
        }
        return () => this.#listeners.delete(listener);
    }
    onClose(listener) {
        return this.channel.onClose(listener);
    }
    close() {
        this.channel.close();
    }
}
//# sourceMappingURL=secure-channel.js.map