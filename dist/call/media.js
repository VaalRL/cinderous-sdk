// 通話執行期用到的 WebRTC 與媒體介面（SDK ADR 0016）：只列 `CallManager` 用到的部分。
// 瀏覽器的 `RTCPeerConnection`、`MediaStream`、`navigator.mediaDevices.getUserMedia` 直接符合；
// 測試與非瀏覽器環境可以注入自己的實作。
/** 沒有 `MediaStream` 的環境用的最小串流 */
class PlainStream {
    #tracks;
    constructor(tracks) {
        this.#tracks = [...tracks];
    }
    getTracks() {
        return [...this.#tracks];
    }
    getVideoTracks() {
        return this.#tracks.filter((t) => t.kind === 'video');
    }
    addTrack(track) {
        if (!this.#tracks.includes(track))
            this.#tracks.push(track);
    }
    removeTrack(track) {
        this.#tracks = this.#tracks.filter((t) => t !== track);
    }
}
/** 瀏覽器預設 `new MediaStream(tracks)`；沒有就用最小實作 */
export function defaultCreateMediaStream() {
    const Ctor = globalThis.MediaStream;
    return typeof Ctor === 'function' ? (tracks) => new Ctor(tracks) : (tracks) => new PlainStream(tracks);
}
/** 鏡頭忙碌（多數手機不能同時開兩顆）：只有這類錯誤才值得「先關舊的再開新的」（Cinderous ADR-0424） */
export function isCameraBusy(error) {
    const name = error?.name;
    return name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError';
}
/** 協商過（或環境沒有 mid 可看）、還沒停的 transceiver */
export function isNegotiated(t) {
    return t.mid !== null && t.direction !== 'stopped';
}
/** 瀏覽器預設；沒有就回 null，建構 `CallManager` 時要自己注入 */
export function defaultCallRtc() {
    const Ctor = globalThis.RTCPeerConnection;
    return typeof Ctor === 'function' ? (config) => new Ctor(config) : null;
}
export function defaultGetUserMedia() {
    const devices = globalThis.navigator?.mediaDevices;
    return devices?.getUserMedia ? (constraints) => devices.getUserMedia(constraints) : null;
}
//# sourceMappingURL=media.js.map