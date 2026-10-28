import { verifyEvent } from '../protocol/sign.js';
import { publishRejections } from '../publish-rejections.js';
import { publishPaced } from '../relay-budget.js';
/** 中繼的額度拒收（ADR 0049 §10）：`…iot-quota:<重置 unix 秒>` 或只有詞元；4429 關閉的原因也是這個格式 */
export const IOT_QUOTA_REJECTION = /\biot-quota:\s*(\d{1,12})?/;
/**
 * 這條路線的每一座（不含備援）都還掛著 4429 `iot-quota` 的標記（SDK ADR 0122）：額度用完、連線被關、還沒到重置時間。
 * 回 `{ reset }`（unix 秒，取最早的；不知道就沒有），否則 undefined。
 */
export function iotQuotaHold(pool) {
    const primaries = [...(pool.relayHealth?.().values() ?? [])].filter((h) => !h.standby);
    if (primaries.length === 0)
        return undefined;
    let reset;
    for (const health of primaries) {
        const m = health.marks.filter((mark) => mark.kind === 'unavailable').map((mark) => IOT_QUOTA_REJECTION.exec(mark.reason)).find((x) => x !== null);
        if (m === undefined)
            return undefined;
        if (m[1] !== undefined)
            reset = Math.min(reset ?? Infinity, Number(m[1]));
    }
    return reset !== undefined ? { reset } : {};
}
/** 一次性查詢：有 `query` 用它，否則訂閱到第一個 EOSE（或逾時）為止 */
export function iotQuery(pool, filters, timeoutMs) {
    if (typeof pool.query === 'function')
        return pool.query(filters, timeoutMs);
    return new Promise((resolve) => {
        const events = new Map();
        let done = false;
        const finish = () => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            queueMicrotask(() => sub.close());
            resolve([...events.values()].sort((a, b) => b.created_at - a.created_at));
        };
        const timer = setTimeout(finish, timeoutMs);
        const sub = pool.subscribe(filters, {
            onEvent: (event) => {
                if (!done)
                    events.set(event.id, event);
            },
            onEose: finish,
        });
    });
}
/** 驗簽（連線池已經驗過；自訂傳輸層不一定，閘道與客戶端是安全邊界，再驗一次） */
export function iotVerified(event) {
    try {
        return verifyEvent(event);
    }
    catch {
        return false;
    }
}
/** 取預算 → 發布（限速就退避重送）；至少一座收下算成功 */
export async function iotPublish(pool, budget, event) {
    const result = await publishPaced(budget, () => pool.publish(event));
    return { ok: result.accepted.length > 0, result, rejected: publishRejections(result) };
}
//# sourceMappingURL=transport.js.map