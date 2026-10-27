/**
 * 發布結果裡的拒收：補齊分類、挑出「送到了但沒收下」的那些、往上回報（SDK ADR 0038 P0-C）。
 *
 * 獨立成一個檔案：私訊、Vault 傳輸層、名單同步、PeerNode 都要用，但 `./pairing`、`./sync/vault` 子路徑
 * 不能把連線池的執行期拉進來（見 `tests/pairing/subpath.test.ts`）。這裡只依賴 `protocol/relay-reject`。
 */
import { type RelayRejectKind } from './protocol/relay-reject.js';
import type { PublishDurability, PublishResult, RejectedRelay } from './relay-pool.js';
/** {@link classifyPublishRejection} 的結果：分類欄位都有值 */
export type ClassifiedRejection = RejectedRelay & {
    readonly kind: RelayRejectKind;
    readonly retryable: boolean;
    readonly tryOtherRelays: boolean;
};
/** 把一筆拒收補齊分類：`RelayPool` 給的照用，自訂傳輸層只給 `reason` 的就從字串推回來 */
export declare function classifyPublishRejection(entry: RejectedRelay): ClassifiedRejection;
/** 一次發布的拒收回報（給私訊、Vault、名單同步、PeerNode 往上報部分拒收；SDK ADR 0038 P0-C） */
export interface PublishRejectionReport {
    readonly eventId: string;
    /** 收下的中繼（成功與否仍以「至少一座收下」判斷；這裡讓應用看得到冗餘少了幾份） */
    readonly accepted: readonly string[];
    readonly rejected: readonly ClassifiedRejection[];
}
/**
 * 一次發布裡「有送到、但沒收下」的中繼，補齊分類。`not connected` 不算：那一座根本沒送到，
 * 連線狀態另有 `status()`／`onStatusChange` 可看；逾時與中途斷線算（送了、沒有結果）。
 */
export declare function publishRejections(result: PublishResult): ClassifiedRejection[];
/** 有拒收就回報一次（沒有就不叫），回傳分類後的拒收 */
export declare function reportPublishRejections(eventId: string, result: PublishResult, onRejected: ((report: PublishRejectionReport) => void) | undefined): ClassifiedRejection[];
/** 連線池自己產生的原因（不是中繼說的） */
export declare function localKind(reason: string): {
    readonly kind: RelayRejectKind;
} | undefined;
export declare function rejectedEntry(url: string, reason: string, klass: {
    readonly kind: RelayRejectKind;
    readonly token?: string | undefined;
}): ClassifiedRejection;
/**
 * 這次發布算不算成功（SDK ADR 0041）：沒有耐久度要求＝v0.32 的判斷（至少一座收下）；
 * 有要求＝連線池回報的 `durability.satisfied`，自訂傳輸層沒回報時以「收下但不是借用的座數 ≥ `minAccepted`」自己算。
 */
export declare function meetsDurability(result: PublishResult, durability: PublishDurability | undefined): boolean;
/** 耐久度不足時給人看的原因 */
export declare function durabilityShortfall(result: PublishResult, durability: PublishDurability): string;
//# sourceMappingURL=publish-rejections.d.ts.map