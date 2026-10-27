// WebRTC 的最小介面（SDK ADR 0009）：只列 `PeerNode` 用到的部分。
// 瀏覽器的 `RTCPeerConnection` 直接符合；Node 或測試環境可以注入自己的實作。
/** 環境裡有全域 `RTCPeerConnection`（瀏覽器）就用它；沒有（Node）回 null＝只能走中繼。 */
export function defaultRtcFactory() {
    const Ctor = globalThis.RTCPeerConnection;
    if (typeof Ctor !== 'function')
        return null;
    return (config) => new Ctor(config);
}
//# sourceMappingURL=rtc.js.map