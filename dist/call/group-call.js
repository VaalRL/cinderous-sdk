import { CALL_SIGNAL_KIND } from '../protocol/call.js';
import { GROUP_CALL_DEFAULT_MAX, GROUP_CALL_HARD_MAX, parseGroupCallSignal, } from '../protocol/group-call.js';
import { DEFAULT_VIDEO_QUALITY, videoConstraints, videoProfile, } from '../protocol/video-quality.js';
import { defaultCallRtc, defaultCreateMediaStream, defaultGetUserMedia, isCameraBusy, isNegotiated, } from './media.js';
const SEEN_MEMORY = 4_096;
const HEX64 = /^[0-9a-f]{64}$/;
const ALIVE = new Set(['invited', 'joined', 'connecting', 'connected']);
function kindOf(t) {
    return t.receiver?.track?.kind ?? t.sender?.track?.kind;
}
function randomGroupId() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export class GroupCallManager {
    #identity;
    #transport;
    #rtc;
    #getUserMedia;
    #createStream;
    #iceServers;
    #isBlocked;
    #isBusyElsewhere;
    #max;
    #ringTimeoutMs;
    #subscription;
    #seen = new Set();
    #videoQuality;
    #camera;
    #state = 'idle';
    #groupId = null;
    #inviter = null;
    #inviteMedia = 'audio';
    #members = [];
    #parts = new Map();
    #legs = new Map();
    #pending = new Map();
    /** 還不在名單上的人送來的加入（名單更新可能晚到）：名單補上他之後重放 */
    #unknownJoins = new Map();
    #timers = new Map();
    #localStream = null;
    #audio = null;
    #video = null;
    #localMedia = 'audio';
    #muted = false;
    #closed = false;
    #listeners = {
        incoming: new Set(),
        state: new Set(),
        participants: new Set(),
        localStream: new Set(),
        remoteStream: new Set(),
        peerFailed: new Set(),
        ended: new Set(),
        error: new Set(),
    };
    constructor(opts) {
        const max = opts.maxParticipants ?? GROUP_CALL_DEFAULT_MAX;
        if (!Number.isInteger(max) || max < 2 || max > GROUP_CALL_HARD_MAX) {
            throw new Error(`maxParticipants 必須是 2～${GROUP_CALL_HARD_MAX}（網狀拓撲每人上傳 N−1 份，見 SDK ADR 0141）`);
        }
        const rtc = opts.rtc ?? defaultCallRtc();
        const getUserMedia = opts.getUserMedia ?? defaultGetUserMedia();
        if (!rtc || !getUserMedia)
            throw new Error('這個環境沒有 WebRTC 或 getUserMedia，請注入 rtc 與 getUserMedia');
        this.#identity = opts.identity;
        this.#transport = opts.transport;
        this.#rtc = rtc;
        this.#getUserMedia = getUserMedia;
        this.#createStream = opts.createStream ?? defaultCreateMediaStream();
        this.#iceServers = opts.iceServers;
        this.#isBlocked = opts.isBlocked ?? (() => false);
        this.#isBusyElsewhere = opts.isBusy ?? (() => false);
        this.#videoQuality = opts.videoQuality ?? DEFAULT_VIDEO_QUALITY;
        this.#max = max;
        this.#ringTimeoutMs = opts.ringTimeoutMs ?? 45_000;
        this.#subscription = this.#transport.subscribe([{ kinds: [CALL_SIGNAL_KIND], '#p': [this.#identity.pubkey] }], {
            onEvent: (event) => void this.#onEvent(event),
        });
    }
    // ── 事件 ─────────────────────────────────────────────────────────────────
    onIncoming(l) {
        return this.#add('incoming', l);
    }
    onState(l) {
        return this.#add('state', l);
    }
    onParticipants(l) {
        return this.#add('participants', l);
    }
    onLocalStream(l) {
        return this.#add('localStream', l);
    }
    /** 每個人一個串流；內容變了送新物件，他離開或連線失敗時送 null */
    onRemoteStream(l) {
        return this.#add('remoteStream', l);
    }
    /** 只有這一對打不通（unreachable）或斷線（lost）；其他人不受影響 */
    onPeerFailed(l) {
        return this.#add('peerFailed', l);
    }
    onEnded(l) {
        return this.#add('ended', l);
    }
    onError(l) {
        return this.#add('error', l);
    }
    get state() {
        return this.#state;
    }
    get groupId() {
        return this.#groupId;
    }
    get localMedia() {
        return this.#localMedia;
    }
    get maxParticipants() {
        return this.#max;
    }
    participants() {
        return [...this.#parts.values()].map((p) => ({ ...p }));
    }
    // ── 操作 ─────────────────────────────────────────────────────────────────
    /** 開一通群組通話並邀請 `peers`（不含自己）。回傳 groupId。 */
    async start(peers, media) {
        if (this.#closed)
            throw new Error('GroupCallManager 已關閉');
        if (this.#busy() || this.#isBusyElsewhere())
            throw new Error('已經在通話中');
        const me = this.#identity.pubkey;
        const others = [...new Set(peers)].filter((p) => p !== me);
        if (others.length === 0)
            throw new Error('至少要邀請一個人');
        for (const p of others)
            if (!HEX64.test(p))
                throw new Error(`不是合法的 pubkey：${p}`);
        if (others.length + 1 > this.#max)
            throw new Error(`人數超過上限 ${this.#max}（含自己）`);
        this.#reset();
        this.#groupId = randomGroupId();
        this.#members = [me, ...others];
        this.#inviteMedia = media;
        await this.#acquire(media);
        this.#state = 'in-call';
        for (const p of others) {
            this.#parts.set(p, { pubkey: p, status: 'invited', media: 'audio' });
            this.#startRing(p);
        }
        this.#fire('state', this.#state);
        this.#emitParticipants();
        for (const p of others)
            await this.#send(p, { type: 'group-invite', media, members: this.#members });
        return this.#groupId;
    }
    async accept() {
        if (this.#state !== 'incoming' || !this.#groupId)
            return;
        try {
            await this.#acquire(this.#inviteMedia);
        }
        catch (error) {
            this.#fire('error', `無法取得麥克風／鏡頭：${String(error)}`);
            await this.reject();
            return;
        }
        this.#state = 'in-call';
        this.#fire('state', this.#state);
        const me = this.#identity.pubkey;
        for (const [p, part] of this.#parts)
            if (part.status === 'invited')
                this.#startRing(p);
        for (const p of this.#members)
            if (p !== me)
                await this.#send(p, { type: 'group-join', members: this.#members });
        // 已知在通話裡的人（至少有邀請者）：我較小就由我發 offer；我較大的，對方收到我的 join 會發
        for (const [p, part] of this.#parts)
            if (part.status === 'joined' && me < p && !this.#legs.has(p))
                await this.#offerTo(p);
        this.#emitParticipants();
    }
    async reject() {
        if (this.#state !== 'incoming')
            return;
        const me = this.#identity.pubkey;
        for (const p of this.#members)
            if (p !== me)
                await this.#send(p, { type: 'group-decline', reason: 'declined' }).catch(() => { });
        this.#end('declined');
    }
    async leave() {
        if (this.#state === 'incoming')
            return this.reject();
        if (this.#state !== 'in-call')
            return;
        for (const [p, part] of this.#parts)
            if (ALIVE.has(part.status))
                await this.#send(p, { type: 'group-leave' }).catch(() => { });
        this.#end('left');
    }
    /** 通話中再邀一位（任何已加入的人都可以）；名單變動會告訴其他人 */
    async invite(peer) {
        if (this.#state !== 'in-call')
            throw new Error('不在通話中');
        if (!HEX64.test(peer))
            throw new Error(`不是合法的 pubkey：${peer}`);
        if (this.#members.includes(peer))
            return;
        if (this.#members.length + 1 > this.#max)
            throw new Error(`人數超過上限 ${this.#max}（含自己）`);
        this.#members = [...this.#members, peer];
        this.#parts.set(peer, { pubkey: peer, status: 'invited', media: 'audio' });
        this.#startRing(peer);
        this.#emitParticipants();
        await this.#send(peer, { type: 'group-invite', media: this.#localMedia, members: this.#members });
        for (const [p, part] of this.#parts) {
            if (p !== peer && ALIVE.has(part.status))
                await this.#send(p, { type: 'group-members', members: this.#members }).catch(() => { });
        }
    }
    /** 改自己這一方送什麼：對每一條連線都生效；先把相機換好，成功了才通知大家 */
    async setLocalMedia(media) {
        if (this.#state !== 'in-call' || this.#localMedia === media)
            return;
        if (media === 'video') {
            let track;
            try {
                track = await this.#openCamera();
            }
            catch (error) {
                this.#fire('error', `無法開啟視訊：${String(error)}`);
                return;
            }
            await this.#putVideoOnAllLegs(track);
            this.#video = track;
            this.#replaceLocalTrack(track, null);
            this.#applyVideoQuality();
        }
        else {
            this.#dropVideo();
        }
        this.#localMedia = media;
        await this.#broadcastMedia();
    }
    /** 靜音：麥克風軌 `enabled=false`，對所有人生效（裝置不關，解除時不用重新取用） */
    setMuted(muted) {
        this.#muted = muted;
        if (this.#audio)
            this.#audio.enabled = !muted;
    }
    get muted() {
        return this.#muted;
    }
    /**
     * 換鏡頭，所有連線一起換。先試著直接開新的（桌面可以同時開兩顆，沒有空窗）；
     * 🔴 遇到「鏡頭忙碌」（多數手機同時只能開一顆）就先停舊的再開。新的開不了就重開原本那顆；
     * 連原本的都開不了就降成語音並通知大家，不送一條死掉的軌（Cinderous ADR-0424）。
     */
    async setCamera(selection) {
        const previous = this.#camera;
        this.#camera = selection;
        const old = this.#video;
        if (!old || this.#state !== 'in-call')
            return;
        let track;
        try {
            track = await this.#openCamera();
        }
        catch (error) {
            if (!isCameraBusy(error)) {
                this.#camera = previous;
                this.#fire('error', `無法切換鏡頭：${String(error)}`);
                return;
            }
            old.stop();
            try {
                track = await this.#openCamera();
            }
            catch (retryError) {
                this.#fire('error', `無法切換鏡頭：${String(retryError)}`);
                this.#camera = previous;
                try {
                    track = await this.#openCamera();
                }
                catch {
                    this.#dropVideo();
                    this.#localMedia = 'audio';
                    await this.#broadcastMedia();
                    return;
                }
            }
        }
        await this.#putVideoOnAllLegs(track);
        old.stop();
        this.#video = track;
        this.#replaceLocalTrack(track, old);
        this.#applyVideoQuality();
    }
    setVideoQuality(quality) {
        this.#videoQuality = quality;
        this.#applyVideoQuality();
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#subscription.close();
        if (this.#state === 'in-call' || this.#state === 'incoming')
            this.#end(this.#state === 'incoming' ? 'declined' : 'left');
    }
    // ── 信令 ─────────────────────────────────────────────────────────────────
    #add(name, listener) {
        this.#listeners[name].add(listener);
        return () => this.#listeners[name].delete(listener);
    }
    #fire(name, ...args) {
        for (const listener of this.#listeners[name]) {
            try {
                listener(...args);
            }
            catch {
                // App 的監聽出錯不影響通話
            }
        }
    }
    #busy() {
        return this.#state === 'incoming' || this.#state === 'in-call';
    }
    async #send(peer, body) {
        if (!this.#groupId)
            return;
        const signal = { v: 1, groupId: this.#groupId, ...body };
        const event = this.#identity.sealAndWrap({ kind: CALL_SIGNAL_KIND, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(signal) }, peer, { kind: CALL_SIGNAL_KIND, tags: [['p', peer]] });
        await this.#transport.publish(event);
    }
    async #onEvent(event) {
        if (this.#closed || event.kind !== CALL_SIGNAL_KIND || this.#seen.has(event.id))
            return;
        this.#seen.add(event.id);
        if (this.#seen.size > SEEN_MEMORY) {
            const oldest = this.#seen.values().next().value;
            if (oldest !== undefined)
                this.#seen.delete(oldest);
        }
        let sender;
        let signal;
        try {
            const opened = this.#identity.openWrap(event);
            if (opened.rumor.kind !== CALL_SIGNAL_KIND)
                return;
            sender = opened.sender;
            signal = parseGroupCallSignal(opened.rumor.content); // 一對一信令在這裡丟例外 ⇒ 不歸我管
        }
        catch {
            return;
        }
        if (sender === this.#identity.pubkey || this.#isBlocked(sender))
            return;
        try {
            await this.#handle(sender, signal);
        }
        catch (error) {
            this.#fire('error', `群組通話處理失敗：${String(error)}`);
        }
    }
    async #handle(sender, sig) {
        const me = this.#identity.pubkey;
        if (sig.type === 'group-invite') {
            if (sig.groupId === this.#groupId)
                return;
            if (!sig.members.includes(me) || !sig.members.includes(sender))
                return;
            if (this.#busy() || this.#isBusyElsewhere()) {
                await this.#reply(sig.groupId, sender, 'busy');
                return;
            }
            if (sig.members.length > this.#max) {
                await this.#reply(sig.groupId, sender, 'full');
                return;
            }
            this.#reset();
            this.#groupId = sig.groupId;
            this.#inviter = sender;
            this.#inviteMedia = sig.media;
            this.#members = [...sig.members];
            for (const p of sig.members) {
                if (p === me)
                    continue;
                this.#parts.set(p, { pubkey: p, status: p === sender ? 'joined' : 'invited', media: p === sender ? sig.media : 'audio' });
            }
            this.#state = 'incoming';
            this.#fire('incoming', { groupId: sig.groupId, from: sender, members: [...sig.members], media: sig.media });
            this.#fire('state', this.#state);
            this.#emitParticipants();
            return;
        }
        if (sig.groupId !== this.#groupId || !this.#busy())
            return;
        if (!this.#members.includes(sender)) {
            if (sig.type === 'group-join')
                this.#unknownJoins.set(sender, sig);
            return;
        }
        const part = this.#parts.get(sender);
        if (!part)
            return;
        switch (sig.type) {
            case 'group-join': {
                this.#clearRing(sender);
                if (part.status !== 'connecting' && part.status !== 'connected')
                    part.status = 'joined';
                this.#mergeMembers(sig.members);
                if (this.#state === 'in-call' && !this.#legs.has(sender)) {
                    if (me < sender)
                        await this.#offerTo(sender);
                    else if (!sig.ack)
                        await this.#send(sender, { type: 'group-join', members: this.#members, ack: true });
                }
                this.#emitParticipants();
                await this.#replayUnknownJoins();
                return;
            }
            case 'group-members':
                if (part.status === 'joined' || part.status === 'connecting' || part.status === 'connected') {
                    this.#mergeMembers(sig.members);
                    this.#emitParticipants();
                    await this.#replayUnknownJoins();
                }
                return;
            case 'group-decline':
                this.#clearRing(sender);
                part.status = sig.reason === 'declined' ? 'declined' : sig.reason;
                this.#emitParticipants();
                this.#checkEnd();
                return;
            case 'group-leave':
                this.#clearRing(sender);
                this.#closeLeg(sender);
                part.status = 'left';
                this.#emitParticipants();
                if (this.#state === 'incoming') {
                    if (![...this.#parts.values()].some((p) => p.status === 'joined'))
                        this.#end('cancelled');
                }
                else {
                    this.#checkEnd();
                }
                return;
            case 'group-offer':
                if (this.#state !== 'in-call')
                    return;
                if (this.#legs.has(sender)) {
                    if (me < sender)
                        return; // 這一對該由我發 offer：對方的忽略
                    this.#closeLeg(sender);
                }
                part.media = sig.media;
                await this.#answer(sender, sig.sdp);
                return;
            case 'group-answer': {
                const leg = this.#legs.get(sender);
                if (!leg || leg.hasRemote)
                    return;
                part.media = sig.media;
                await leg.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
                leg.hasRemote = true;
                await this.#flushCandidates(sender, leg);
                this.#emitParticipants();
                return;
            }
            case 'group-candidate': {
                const candidate = { candidate: sig.candidate, sdpMid: sig.sdpMid ?? null, sdpMLineIndex: sig.sdpMLineIndex ?? null };
                const leg = this.#legs.get(sender);
                if (leg?.hasRemote)
                    await leg.pc.addIceCandidate(candidate).catch(() => { });
                else
                    this.#pending.set(sender, [...(this.#pending.get(sender) ?? []), candidate]);
                return;
            }
            case 'group-media':
                part.media = sig.media;
                this.#emitParticipants();
                return;
        }
    }
    async #reply(groupId, peer, reason) {
        const signal = { v: 1, groupId, type: 'group-decline', reason };
        const event = this.#identity.sealAndWrap({ kind: CALL_SIGNAL_KIND, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(signal) }, peer, { kind: CALL_SIGNAL_KIND, tags: [['p', peer]] });
        await this.#transport.publish(event).catch(() => { });
    }
    #mergeMembers(list) {
        const me = this.#identity.pubkey;
        for (const p of list) {
            if (this.#members.includes(p))
                continue;
            if (this.#members.length >= this.#max)
                break;
            this.#members.push(p);
            if (p !== me && !this.#parts.has(p)) {
                this.#parts.set(p, { pubkey: p, status: 'invited', media: 'audio' });
                if (this.#state === 'in-call')
                    this.#startRing(p);
            }
        }
    }
    async #replayUnknownJoins() {
        for (const [sender, sig] of [...this.#unknownJoins]) {
            if (!this.#members.includes(sender))
                continue;
            this.#unknownJoins.delete(sender);
            await this.#handle(sender, sig);
        }
    }
    #startRing(peer) {
        this.#clearRing(peer);
        this.#timers.set(peer, setTimeout(() => {
            this.#timers.delete(peer);
            const part = this.#parts.get(peer);
            if (part?.status !== 'invited')
                return;
            part.status = 'no-answer';
            this.#emitParticipants();
            this.#checkEnd();
        }, this.#ringTimeoutMs));
    }
    #clearRing(peer) {
        const t = this.#timers.get(peer);
        if (t)
            clearTimeout(t);
        this.#timers.delete(peer);
    }
    #checkEnd() {
        if (this.#state !== 'in-call')
            return;
        if (![...this.#parts.values()].some((p) => ALIVE.has(p.status)))
            this.#end('empty');
    }
    #emitParticipants() {
        this.#fire('participants', this.participants());
    }
    async #broadcastMedia() {
        for (const [p, part] of this.#parts) {
            if (part.status === 'joined' || part.status === 'connecting' || part.status === 'connected') {
                await this.#send(p, { type: 'group-media', media: this.#localMedia }).catch(() => { });
            }
        }
    }
    // ── 每一對的連線 ───────────────────────────────────────────────────────────
    #newLeg(peer) {
        const servers = typeof this.#iceServers === 'function' ? this.#iceServers() : this.#iceServers;
        const pc = this.#rtc(servers ? { iceServers: servers } : {});
        const leg = { pc, everConnected: false, hasRemote: false, remoteTracks: [] };
        pc.onicecandidate = (event) => {
            const c = event.candidate;
            if (!c || this.#legs.get(peer) !== leg)
                return;
            void this.#send(peer, {
                type: 'group-candidate',
                candidate: c.candidate,
                ...(c.sdpMid != null ? { sdpMid: c.sdpMid } : {}),
                ...(c.sdpMLineIndex != null ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
            }).catch(() => { });
        };
        pc.ontrack = (event) => {
            if (this.#legs.get(peer) !== leg)
                return;
            // 🔴 ADR-0424：對方沒綁 stream 時 streams 是空的——每條軌都併進這個人的遠端串流，送新物件
            const incoming = [...(event.streams[0]?.getTracks() ?? []), ...(event.track ? [event.track] : [])];
            let changed = false;
            for (const track of incoming) {
                if (!leg.remoteTracks.includes(track)) {
                    leg.remoteTracks.push(track);
                    changed = true;
                }
            }
            if (changed)
                this.#fire('remoteStream', peer, this.#createStream(leg.remoteTracks));
        };
        pc.onconnectionstatechange = () => {
            if (this.#legs.get(peer) !== leg)
                return;
            const part = this.#parts.get(peer);
            if (pc.connectionState === 'connected') {
                leg.everConnected = true;
                if (part)
                    part.status = 'connected';
                this.#emitParticipants();
            }
            else if (pc.connectionState === 'failed') {
                // 只有這一對：關掉這條、告訴 App，其他人照常
                this.#closeLeg(peer);
                if (part)
                    part.status = 'failed';
                this.#fire('peerFailed', peer, leg.everConnected ? 'lost' : 'unreachable');
                this.#emitParticipants();
                this.#checkEnd();
            }
        };
        this.#legs.set(peer, leg);
        const part = this.#parts.get(peer);
        if (part)
            part.status = 'connecting';
        return leg;
    }
    async #offerTo(peer) {
        const leg = this.#newLeg(peer);
        const { pc } = leg;
        const stream = this.#localStream ?? this.#createStream([]);
        if (this.#audio)
            pc.addTrack(this.#audio, stream);
        // 預鋪視訊並綁 stream（ADR-0424：不綁的話對方 ontrack 拿不到 stream）；通話中開關鏡頭只要 replaceTrack
        let video;
        try {
            video = pc.addTransceiver('video', { direction: 'sendrecv', streams: [stream] });
        }
        catch {
            // 舊環境沒有 addTransceiver：這一對只能照開始時的型態
        }
        video ??= pc.getTransceivers?.().find((t) => kindOf(t) === 'video');
        if (this.#video) {
            if (video)
                await video.sender.replaceTrack(this.#video);
            else
                pc.addTrack(this.#video, stream);
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.#applyVideoQuality();
        await this.#send(peer, { type: 'group-offer', sdp: offer.sdp ?? '', media: this.#localMedia });
        this.#emitParticipants();
    }
    async #answer(peer, sdp) {
        const leg = this.#newLeg(peer);
        const { pc } = leg;
        await pc.setRemoteDescription({ type: 'offer', sdp });
        const stream = this.#localStream ?? this.#createStream([]);
        const transceivers = pc.getTransceivers?.();
        if (transceivers) {
            // 🔴 ADR-0424：答方不自己鋪 transceiver，也不用 addTrack；直接放到 offer 帶來的（協商過的）那幾條
            for (const t of transceivers) {
                if (!isNegotiated(t))
                    continue;
                const kind = kindOf(t);
                t.direction = 'sendrecv';
                const track = kind === 'audio' ? this.#audio : kind === 'video' ? this.#video : null;
                if (track && !t.sender.track)
                    await t.sender.replaceTrack(track);
                t.sender.setStreams?.(stream);
            }
        }
        else {
            for (const track of stream.getTracks())
                pc.addTrack(track, stream);
        }
        leg.hasRemote = true;
        await this.#flushCandidates(peer, leg);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.#applyVideoQuality();
        await this.#send(peer, { type: 'group-answer', sdp: answer.sdp ?? '', media: this.#localMedia });
        this.#emitParticipants();
    }
    async #flushCandidates(peer, leg) {
        for (const c of this.#pending.get(peer) ?? [])
            await leg.pc.addIceCandidate(c).catch(() => { });
        this.#pending.delete(peer);
    }
    #closeLeg(peer) {
        const leg = this.#legs.get(peer);
        this.#pending.delete(peer);
        if (!leg)
            return;
        this.#legs.delete(peer);
        try {
            leg.pc.close();
        }
        catch {
            // 已關閉
        }
        this.#fire('remoteStream', peer, null);
    }
    // ── 本地媒體 ─────────────────────────────────────────────────────────────
    async #acquire(media) {
        const stream = await this.#getUserMedia({
            audio: true,
            // 不是裸 true（Cinderous ADR-0337）：網狀拓撲每人上傳 N−1 份，畫質上限更要守住
            video: media === 'video' ? videoConstraints(this.#videoQuality, this.#camera) : false,
        });
        const tracks = stream.getTracks();
        this.#audio = tracks.find((t) => t.kind === 'audio') ?? null;
        this.#video = tracks.find((t) => t.kind === 'video') ?? null;
        if (this.#audio)
            this.#audio.enabled = !this.#muted;
        this.#localMedia = this.#video ? 'video' : 'audio';
        this.#localStream = this.#createStream(tracks);
        this.#fire('localStream', this.#localStream);
    }
    async #openCamera() {
        const stream = await this.#getUserMedia({ audio: false, video: videoConstraints(this.#videoQuality, this.#camera) });
        const track = stream.getVideoTracks()[0];
        if (!track)
            throw new Error('取不到視訊軌');
        return track;
    }
    #videoSender(pc) {
        const videos = (pc.getTransceivers?.() ?? []).filter((t) => kindOf(t) === 'video' && isNegotiated(t));
        return videos[0]?.sender ?? null;
    }
    async #putVideoOnAllLegs(track) {
        for (const [peer, leg] of this.#legs) {
            const sender = this.#videoSender(leg.pc);
            if (!sender)
                continue;
            try {
                await sender.replaceTrack(track);
            }
            catch (error) {
                this.#fire('error', `換不了送給 ${peer.slice(0, 8)} 的畫面：${String(error)}`);
            }
        }
    }
    #dropVideo() {
        const old = this.#video;
        void this.#putVideoOnAllLegs(null);
        if (old)
            old.stop(); // 真的關相機，指示燈要誠實
        this.#video = null;
        this.#replaceLocalTrack(null, old);
    }
    /** 本地串流換一條軌：送**新的**串流物件（UI 只在物件變了才重綁） */
    #replaceLocalTrack(add, remove) {
        const kept = (this.#localStream?.getTracks() ?? []).filter((t) => t !== remove && t !== add);
        this.#localStream = this.#createStream(add ? [...kept, add] : kept);
        this.#fire('localStream', this.#localStream);
    }
    #applyVideoQuality() {
        const profile = videoProfile(this.#videoQuality);
        const legs = [...this.#legs.values()];
        const video = this.#video;
        void (async () => {
            try {
                for (const leg of legs) {
                    for (const sender of leg.pc.getSenders()) {
                        if (sender.track?.kind !== 'video' || !sender.getParameters || !sender.setParameters)
                            continue;
                        const params = sender.getParameters();
                        const encodings = params.encodings?.length ? params.encodings : [{}];
                        encodings[0].maxBitrate = profile.maxBitrate;
                        await sender.setParameters({ ...params, encodings, degradationPreference: 'maintain-framerate' });
                    }
                }
                await video?.applyConstraints?.(videoConstraints(this.#videoQuality, this.#camera));
            }
            catch {
                // 畫質是加分項，不是通話前提
            }
        })();
    }
    // ── 收尾 ─────────────────────────────────────────────────────────────────
    #end(reason) {
        for (const peer of [...this.#legs.keys()])
            this.#closeLeg(peer);
        for (const t of this.#timers.values())
            clearTimeout(t);
        this.#timers.clear();
        if (this.#localStream)
            for (const track of this.#localStream.getTracks())
                track.stop();
        this.#audio?.stop();
        this.#video?.stop();
        this.#audio = null;
        this.#video = null;
        this.#localStream = null;
        this.#state = 'ended';
        this.#fire('localStream', null);
        this.#fire('ended', reason);
        this.#fire('state', this.#state);
    }
    #reset() {
        for (const t of this.#timers.values())
            clearTimeout(t);
        this.#timers.clear();
        this.#parts = new Map();
        this.#legs = new Map();
        this.#pending = new Map();
        this.#unknownJoins = new Map();
        this.#members = [];
        this.#inviter = null;
        this.#groupId = null;
        this.#localMedia = 'audio';
    }
    /** 邀請我的人（還沒接聽時有意義） */
    get inviter() {
        return this.#inviter;
    }
}
//# sourceMappingURL=group-call.js.map