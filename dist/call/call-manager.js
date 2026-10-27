import { CALL_SIGNAL_KIND, CallSession, parseCallSignal, } from '../protocol/call.js';
import { DEFAULT_VIDEO_QUALITY, videoConstraints, videoProfile } from '../protocol/video-quality.js';
import { defaultCallRtc, defaultGetUserMedia, } from './media.js';
const SEEN_MEMORY = 4_096;
function isVideoTransceiver(t) {
    return t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video';
}
export class CallManager {
    #identity;
    #transport;
    #rtc;
    #getUserMedia;
    #iceServers;
    #isBlocked;
    #subscription;
    #seen = new Set();
    #session = new CallSession();
    #pc = null;
    #peer = null;
    #media = null;
    #localStream = null;
    #hasRemote = false;
    #pendingCandidates = [];
    #everConnected = false;
    #videoQuality;
    #closed = false;
    #listeners = {
        incoming: new Set(),
        state: new Set(),
        localStream: new Set(),
        remoteStream: new Set(),
        media: new Set(),
        ended: new Set(),
        failed: new Set(),
        error: new Set(),
    };
    constructor(opts) {
        const rtc = opts.rtc ?? defaultCallRtc();
        const getUserMedia = opts.getUserMedia ?? defaultGetUserMedia();
        if (!rtc || !getUserMedia)
            throw new Error('這個環境沒有 WebRTC 或 getUserMedia，請注入 rtc 與 getUserMedia');
        this.#identity = opts.identity;
        this.#transport = opts.transport;
        this.#rtc = rtc;
        this.#getUserMedia = getUserMedia;
        this.#iceServers = opts.iceServers;
        this.#isBlocked = opts.isBlocked ?? (() => false);
        this.#videoQuality = opts.videoQuality ?? DEFAULT_VIDEO_QUALITY;
        this.#subscription = this.#transport.subscribe([{ kinds: [CALL_SIGNAL_KIND], '#p': [this.#identity.pubkey] }], {
            onEvent: (event) => void this.#onEvent(event),
        });
    }
    // ── 事件 ─────────────────────────────────────────────────────────────────
    onIncoming(listener) {
        return this.#add('incoming', listener);
    }
    onState(listener) {
        return this.#add('state', listener);
    }
    onLocalStream(listener) {
        return this.#add('localStream', listener);
    }
    onRemoteStream(listener) {
        return this.#add('remoteStream', listener);
    }
    /** 我在送什麼、對方在送什麼：兩者各自獨立（「我送視訊、他只送語音」是合法狀態） */
    onMedia(listener) {
        return this.#add('media', listener);
    }
    onEnded(listener) {
        return this.#add('ended', listener);
    }
    /** P2P 連不通（unreachable：多為限制網路、需要 TURN）或斷線（lost） */
    onFailed(listener) {
        return this.#add('failed', listener);
    }
    onError(listener) {
        return this.#add('error', listener);
    }
    get state() {
        return this.#session.state;
    }
    get peer() {
        return this.#peer;
    }
    get localMedia() {
        return this.#session.localMedia;
    }
    get remoteMedia() {
        return this.#session.remoteMedia;
    }
    // ── 操作 ─────────────────────────────────────────────────────────────────
    async startCall(peer, media) {
        if (this.#closed || this.#busy())
            return;
        this.#session = new CallSession();
        this.#peer = peer;
        this.#media = media;
        this.#ensurePc();
        const callId = `sdk-call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        await this.#run(this.#session.startCall(callId, media));
    }
    async accept() {
        await this.#run(this.#session.accept());
    }
    async reject() {
        await this.#run(this.#session.reject());
    }
    async hangup() {
        await this.#run(this.#session.hangup());
    }
    /** 這通能不能在通話中切換語音／視訊（對方的 offer 沒有視訊 m-line 就不行；UI 據此不顯示按鈕） */
    canChangeMedia() {
        return this.#videoSender() !== null;
    }
    /** 通話中改變自己這一方的型態：先把相機換好，成功了才通知對方；失敗就改回去。 */
    async setLocalMedia(media) {
        const previous = this.#session.localMedia;
        const actions = this.#session.setLocalMedia(media);
        if (actions.length === 0)
            return;
        try {
            if (media === 'video')
                await this.#attachVideo();
            else
                this.#detachVideo();
        }
        catch (error) {
            if (previous)
                this.#session.setLocalMedia(previous); // 回滾，而且不送任何信令
            this.#fire('error', `無法開啟視訊：${String(error)}`);
            this.#emitMedia();
            return;
        }
        for (const action of actions)
            if (action.type === 'send')
                await this.#exec(action);
        this.#emitMedia();
    }
    /** 畫質檔位：通話中呼叫立即生效（改編碼上限與擷取解析度） */
    setVideoQuality(quality) {
        this.#videoQuality = quality;
        this.#applyVideoQuality();
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#subscription.close();
        this.#teardown();
    }
    // ── 內部 ─────────────────────────────────────────────────────────────────
    #add(name, listener) {
        const set = this.#listeners[name];
        set.add(listener);
        return () => set.delete(listener);
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
        return this.#session.state !== 'idle' && this.#session.state !== 'ended';
    }
    async #publish(signal, peer) {
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
            signal = parseCallSignal(opened.rumor.content);
        }
        catch {
            return;
        }
        if (sender === this.#identity.pubkey || this.#isBlocked(sender))
            return;
        if (signal.type === 'call-candidate') {
            if (this.#peer !== sender || this.#session.activeCallId !== signal.callId)
                return;
            const candidate = { candidate: signal.candidate, sdpMid: signal.sdpMid ?? null, sdpMLineIndex: signal.sdpMLineIndex ?? null };
            if (this.#hasRemote)
                await this.#pc?.addIceCandidate(candidate).catch(() => { });
            else
                this.#pendingCandidates.push(candidate);
            return;
        }
        if (signal.type === 'call-invite') {
            if (this.#busy()) {
                await this.#publish({ type: 'call-reject', callId: signal.callId, reason: 'busy' }, sender).catch(() => { });
                return;
            }
            this.#session = new CallSession();
            this.#peer = sender;
            this.#media = signal.media;
            this.#ensurePc();
            await this.#run(this.#session.onSignal(signal));
            this.#fire('incoming', { peer: sender, media: signal.media });
            return;
        }
        if (this.#peer !== sender)
            return;
        await this.#run(this.#session.onSignal(signal));
        if (signal.type === 'call-media')
            this.#emitMedia();
    }
    #ensurePc() {
        this.#everConnected = false;
        const servers = typeof this.#iceServers === 'function' ? this.#iceServers() : this.#iceServers;
        const pc = this.#rtc(servers ? { iceServers: servers } : {});
        pc.onicecandidate = (event) => {
            const c = event.candidate;
            const callId = this.#session.activeCallId;
            if (!c || !this.#peer || !callId)
                return;
            const signal = {
                type: 'call-candidate',
                callId,
                candidate: c.candidate,
                ...(c.sdpMid != null ? { sdpMid: c.sdpMid } : {}),
                ...(c.sdpMLineIndex != null ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
            };
            void this.#publish(signal, this.#peer).catch(() => { });
        };
        pc.ontrack = (event) => {
            const stream = event.streams[0];
            if (stream)
                this.#fire('remoteStream', stream);
        };
        pc.onconnectionstatechange = () => {
            if (this.#pc !== pc)
                return;
            if (pc.connectionState === 'connected') {
                this.#everConnected = true;
                void this.#run(this.#session.onConnected());
            }
            else if (pc.connectionState === 'failed') {
                const peer = this.#peer;
                const reason = this.#everConnected ? 'lost' : 'unreachable';
                if (peer)
                    this.#fire('failed', peer, reason);
                // 走正常掛斷：送 hangup 給對方（經中繼，與失敗的 P2P 不同路，對方也能乾淨結束）
                void this.#run(this.#session.hangup());
            }
        };
        // 一律預先協商視訊 transceiver（ADR-0338）：語音通話也有，之後升級只要 replaceTrack
        try {
            pc.addTransceiver('video', { direction: 'sendrecv' });
        }
        catch {
            // 舊環境沒有 addTransceiver：這通不能切換型態（canChangeMedia 回 false）
        }
        this.#pc = pc;
    }
    #videoSender() {
        const pc = this.#pc;
        if (!pc)
            return null;
        const transceiver = pc.getTransceivers?.().find(isVideoTransceiver);
        if (transceiver)
            return transceiver.sender;
        return pc.getSenders().find((s) => s.track?.kind === 'video') ?? null;
    }
    async #attachVideo() {
        const sender = this.#videoSender();
        if (!sender)
            throw new Error('這通沒有可用的視訊軌道');
        const stream = await this.#getUserMedia({ audio: false, video: videoConstraints(this.#videoQuality) });
        const track = stream.getVideoTracks()[0];
        if (!track)
            throw new Error('取不到視訊軌');
        try {
            await sender.replaceTrack(track);
            this.#localStream?.addTrack?.(track);
        }
        catch (error) {
            track.stop(); // 取到之後失敗一定要停掉：不然相機一直亮著
            throw error;
        }
        this.#applyVideoQuality();
        if (this.#localStream)
            this.#fire('localStream', this.#localStream);
    }
    #detachVideo() {
        const sender = this.#videoSender();
        const track = sender?.track ?? null;
        void sender?.replaceTrack(null);
        if (track) {
            track.stop(); // 真的關相機，不只是送黑畫面
            this.#localStream?.removeTrack?.(track);
        }
        if (this.#localStream)
            this.#fire('localStream', this.#localStream);
    }
    async #run(actions) {
        for (const action of actions) {
            try {
                await this.#exec(action);
            }
            catch (error) {
                this.#fire('error', `通話處理失敗：${String(error)}`);
            }
        }
        this.#fire('state', this.#peer, this.#session.state, this.#session.effectiveMedia ?? this.#media);
    }
    async #exec(action) {
        const pc = this.#pc;
        switch (action.type) {
            case 'acquire-media':
                await this.#acquireMedia(action.media);
                return;
            case 'create-offer': {
                if (!pc)
                    return;
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await this.#run(this.#session.localDescription(offer.sdp ?? ''));
                return;
            }
            case 'create-answer': {
                if (!pc)
                    return;
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                await this.#run(this.#session.localDescription(answer.sdp ?? ''));
                return;
            }
            case 'set-remote': {
                if (!pc)
                    return;
                await pc.setRemoteDescription({ type: action.kind, sdp: action.sdp });
                // 🔴 ADR-0338 §3：答方為對方視訊 m-line 自動建立的 transceiver 是 recvonly，不改就永遠送不出視訊
                if (action.kind === 'offer') {
                    for (const t of pc.getTransceivers?.() ?? [])
                        if (isVideoTransceiver(t) && t.direction === 'recvonly')
                            t.direction = 'sendrecv';
                }
                this.#hasRemote = true;
                for (const candidate of this.#pendingCandidates.splice(0))
                    await pc.addIceCandidate(candidate).catch(() => { });
                return;
            }
            case 'send':
                if (this.#peer)
                    await this.#publish(action.signal, this.#peer);
                return;
            case 'ended':
                this.#fire('ended', action.reason);
                return;
            case 'close':
                this.#teardown();
                return;
        }
    }
    async #acquireMedia(media) {
        if (!this.#pc)
            return;
        const stream = await this.#getUserMedia({
            audio: true,
            // 不是裸 true（ADR-0337）：裸 true 拿相機預設，使用者付行動數據、站方付 TURN 流量，兩邊都不知道
            video: media === 'video' ? videoConstraints(this.#videoQuality) : false,
        });
        this.#localStream = stream;
        for (const track of stream.getTracks())
            this.#pc.addTrack(track, stream);
        this.#applyVideoQuality();
        this.#fire('localStream', stream);
    }
    #applyVideoQuality() {
        const pc = this.#pc;
        if (!pc)
            return;
        const profile = videoProfile(this.#videoQuality);
        void (async () => {
            try {
                for (const sender of pc.getSenders()) {
                    if (sender.track?.kind !== 'video' || !sender.getParameters || !sender.setParameters)
                        continue;
                    const params = sender.getParameters();
                    const encodings = params.encodings?.length ? params.encodings : [{}];
                    encodings[0].maxBitrate = profile.maxBitrate;
                    await sender.setParameters({ ...params, encodings, degradationPreference: 'maintain-framerate' });
                }
                for (const track of this.#localStream?.getVideoTracks() ?? [])
                    await track.applyConstraints?.(videoConstraints(this.#videoQuality));
            }
            catch {
                // 畫質是加分項，不是通話前提
            }
        })();
    }
    #emitMedia() {
        const local = this.#session.localMedia;
        const remote = this.#session.remoteMedia;
        if (local && remote)
            this.#fire('media', local, remote);
    }
    #teardown() {
        if (this.#localStream)
            for (const track of this.#localStream.getTracks())
                track.stop();
        const pc = this.#pc;
        if (pc) {
            // 換上來的視訊軌不在 localStream 裡時也要停
            for (const sender of pc.getSenders())
                sender.track?.stop();
            try {
                pc.close();
            }
            catch {
                // 已關閉
            }
        }
        this.#pc = null;
        this.#localStream = null;
        this.#hasRemote = false;
        this.#pendingCandidates = [];
        this.#fire('localStream', null);
        this.#fire('remoteStream', null);
        this.#peer = null;
    }
}
//# sourceMappingURL=call-manager.js.map