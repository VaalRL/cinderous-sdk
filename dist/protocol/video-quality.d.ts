/** 畫質檔位（由省到清晰）。 */
export type VideoQuality = "low" | "medium" | "high";
/** 全部檔位，**順序即由省到清晰**（UI 依此排列，測試依此驗遞增）。 */
export declare const VIDEO_QUALITIES: readonly VideoQuality[];
/** 預設檔位。見檔頭：刻意不是 `high`。 */
export declare const DEFAULT_VIDEO_QUALITY: VideoQuality;
/** 一個檔位的具體參數。 */
export interface VideoProfile {
    width: number;
    height: number;
    frameRate: number;
    /** 視訊編碼位元率上限（bps）。**是上限不是保證**——網路差時實際會更低。 */
    maxBitrate: number;
}
/** 取得某檔位的參數。 */
export declare function videoProfile(q: VideoQuality): VideoProfile;
/** 鏡頭朝向（ADR-0339）：手機的前／後鏡頭。 */
export type CameraFacing = "user" | "environment";
/**
 * 選哪一個鏡頭（ADR-0339）。兩種選法**不是同一件事**：
 *
 * - 手機是**翻面**（`facingMode`）——前後是有意義的關係。
 * - 桌面是**選裝置**（`deviceId`）——內建／外接／擷取卡是一份清單，沒有前後可言。
 *
 * 兩者皆省略＝沿用瀏覽器預設。
 */
export interface CameraSelection {
    facingMode?: CameraFacing;
    deviceId?: string;
}
/** {@link videoConstraints} 的回傳型別（`getUserMedia` / `applyConstraints` 皆可用）。 */
export interface VideoConstraints {
    width: {
        ideal: number;
    };
    height: {
        ideal: number;
    };
    frameRate: {
        ideal: number;
    };
    facingMode?: {
        ideal: CameraFacing;
    };
    deviceId?: {
        exact: string;
    };
}
/**
 * 轉成 `getUserMedia` / `track.applyConstraints` 可用的約束。
 *
 * ⚠ 解析度與 fps 一律用 `ideal` 而非 `exact`：相機不支援時應**退而求其次**，
 * 而不是讓整個取媒體失敗——沒有畫面比畫面不夠漂亮嚴重得多。
 *
 * ⚠ **但 `facingMode` 與 `deviceId` 的嚴格程度刻意不同**（ADR-0339）：
 *
 * - `facingMode` ⇒ **`ideal`**。它是偏好：只有一個鏡頭的裝置仍應拿得到畫面。
 *   ⇒ 呼叫端必須以**實際取得的軌**（`getSettings().facingMode`）更新 UI，而不是以「我要求了什麼」。
 * - `deviceId` ⇒ **`exact`**。使用者從清單裡**明確挑了那一台**；
 *   給他另一台而不說，是說謊。拔掉了就該失敗並讓他知道。
 */
export declare function videoConstraints(q: VideoQuality, camera?: CameraSelection): VideoConstraints;
/** 翻到另一面（ADR-0339）。 */
export declare function flipFacing(f: CameraFacing): CameraFacing;
/**
 * 自我預覽要不要鏡像（ADR-0339 §4）。
 *
 * 前鏡頭該鏡像（照鏡子的直覺）；**後鏡頭不該**——鏡像等於把字反過來給自己看。
 * 朝向未知（桌面的 webcam、或裝置不回報）時**當作前鏡頭**，那是最常見的情形。
 *
 * ⚠ 只用於**自我預覽**。送出去的畫面從來不該鏡像——對方看到的字必須是正的。
 */
export declare function shouldMirror(facing: CameraFacing | null | undefined): boolean;
/** 型別守衛：偏好存在 localStorage，舊版或使用者可能塞進任何東西。 */
export declare function isVideoQuality(v: unknown): v is VideoQuality;
//# sourceMappingURL=video-quality.d.ts.map