// 通話執行期用到的 WebRTC 與媒體介面（SDK ADR 0016）：只列 `CallManager` 用到的部分。
// 瀏覽器的 `RTCPeerConnection`、`MediaStream`、`navigator.mediaDevices.getUserMedia` 直接符合；
// 測試與非瀏覽器環境可以注入自己的實作。
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