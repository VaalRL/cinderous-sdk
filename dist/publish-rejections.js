/**
 * 發布結果裡的拒收：補齊分類、挑出「送到了但沒收下」的那些、往上回報（SDK ADR 0038 P0-C）。
 *
 * 獨立成一個檔案：私訊、Vault 傳輸層、名單同步、PeerNode 都要用，但 `./pairing`、`./sync/vault` 子路徑
 * 不能把連線池的執行期拉進來（見 `tests/pairing/subpath.test.ts`）。這裡只依賴 `protocol/relay-reject`。
 */
import { classifyRelayMessage, relayRejectKindOf } from './protocol/relay-reject.js';
/** 把一筆拒收補齊分類：`RelayPool` 給的照用，自訂傳輸層只給 `reason` 的就從字串推回來 */
export function classifyPublishRejection(entry) {
    if (entry.kind !== undefined) {
        const traits = relayRejectKindOf(entry.kind);
        return {
            url: entry.url,
            reason: entry.reason,
            kind: entry.kind,
            retryable: entry.retryable ?? traits.retryable,
            tryOtherRelays: entry.tryOtherRelays ?? traits.tryOtherRelays,
            ...(entry.token !== undefined ? { token: entry.token } : {}),
        };
    }
    return rejectedEntry(entry.url, entry.reason, localKind(entry.reason) ?? classifyRelayMessage(entry.reason));
}
/**
 * 一次發布裡「有送到、但沒收下」的中繼，補齊分類。`not connected` 不算：那一座根本沒送到，
 * 連線狀態另有 `status()`／`onStatusChange` 可看；逾時與中途斷線算（送了、沒有結果）。
 */
export function publishRejections(result) {
    return result.rejected.filter((entry) => entry.reason !== 'not connected').map(classifyPublishRejection);
}
/** 有拒收就回報一次（沒有就不叫），回傳分類後的拒收 */
export function reportPublishRejections(eventId, result, onRejected) {
    const rejected = publishRejections(result);
    if (rejected.length > 0)
        onRejected?.({ eventId, accepted: [...result.accepted], rejected });
    return rejected;
}
/** 連線池自己產生的原因（不是中繼說的） */
export function localKind(reason) {
    if (reason === 'timeout')
        return { kind: 'timeout' };
    if (reason === 'not connected' || reason.startsWith('disconnected'))
        return { kind: 'disconnected' };
    return undefined;
}
export function rejectedEntry(url, reason, klass) {
    return {
        url,
        reason,
        kind: klass.kind,
        ...relayRejectKindOf(klass.kind),
        ...(klass.token !== undefined ? { token: klass.token } : {}),
    };
}
/**
 * 這次發布算不算成功（SDK ADR 0041）：沒有耐久度要求＝v0.32 的判斷（至少一座收下）；
 * 有要求＝連線池回報的 `durability.satisfied`，自訂傳輸層沒回報時以「收下但不是借用的座數 ≥ `minAccepted`」自己算。
 */
export function meetsDurability(result, durability) {
    if (durability === undefined)
        return result.accepted.length > 0;
    if (result.durability !== undefined)
        return result.durability.satisfied;
    const borrowed = new Set(result.borrowed ?? []);
    return result.accepted.filter((url) => !borrowed.has(url)).length >= Math.max(0, Math.floor(durability.minAccepted ?? 1));
}
/** 耐久度不足時給人看的原因 */
export function durabilityShortfall(result, durability) {
    const need = Math.max(0, Math.floor(durability.minAccepted ?? 1));
    const got = result.durability?.durable.length ?? result.accepted.filter((url) => !(result.borrowed ?? []).includes(url)).length;
    const full = result.durability?.relaysFull === true ? '，其餘中繼都滿了' : '';
    return `只有 ${got} 座中繼耐久收下（需要 ${need}）${full}`;
}
//# sourceMappingURL=publish-rejections.js.map