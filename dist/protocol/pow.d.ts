import { type EventTemplate, type NostrEvent } from "./event.js";
import type { SecretKeyOrSigner } from "./signer.js";
/** NIP-13：event id（hex）開頭的零位元數（工作量證明難度）。 */
export declare function leadingZeroBits(hex: string): number;
/**
 * 挖礦的嘗試次數上限。
 *
 * 期望嘗試次數是 `2^difficulty`，所以這個上限同時是「難度上限」的實質表達：
 * 2^24 ≈ 1,678 萬次，在 JS 裡是十幾秒等級。**超過就拋**而不是繼續轉——
 * 一個轉到天荒地老的迴圈在 UI 執行緒上等同當掉，而當掉比失敗難查得多。
 */
export declare const DEFAULT_MAX_ITERATIONS: number;
/**
 * 對事件挖到指定的 NIP-13 難度，然後**簽一次**。
 *
 * 只算雜湊、不逐輪簽章：Schnorr 簽章比 SHA-256 貴好幾個數量級，逐輪簽等於把成本
 * 花在錯的地方（而且那些簽章一顆都用不到）。
 *
 * `["nonce", <n>, <target>]` 的第三個元素是**自報的目標難度**（NIP-13）：它讓驗證方
 * 分得出「這顆剛好湊巧有幾個前導零」與「這顆是為了某個目標挖出來的」。
 *
 * @throws 達到 `maxIterations` 仍未達標時拋出——呼叫端應把難度調低或改用背景執行緒。
 */
export declare function minePow(template: EventTemplate, 
/** 原始私鑰或 `NostrSigner`（例如 `Identity`；SDK ADR 0023） */
sk: SecretKeyOrSigner, difficulty: number, opts?: {
    maxIterations?: number;
}): NostrEvent;
/**
 * 事件是否達到指定難度（中繼端的判定）。
 *
 * ⚠ **只看 id 的前導零，不看 `nonce` tag 自報的 target**：自報值是給人看的提示，
 * 不是證據——拿它當判準等於讓發送方自己決定及不及格。
 */
export declare function meetsPow(event: Pick<NostrEvent, "id">, difficulty: number): boolean;
//# sourceMappingURL=pow.d.ts.map