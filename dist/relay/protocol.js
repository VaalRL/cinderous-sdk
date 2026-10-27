const invalid = (reason) => ({ type: "INVALID", reason });
/**
 * 事件結構驗證（ADR-0235 C1）——**必須在 `verifyEvent` 之前**。
 *
 * ## 為什麼簽章驗證不夠
 *
 * `verifyEvent` 只保證「`id` 等於這串 JSON 的 sha256，且 `sig` 是 `pubkey` 對 `id` 的簽章」。
 * 它**完全沒有檢查欄位型別**——而 `getEventHash` 是對 `JSON.stringify([0,pubkey,created_at,kind,tags,content])`
 * 取雜湊，`tags` 是物件、字串或 null 都能算出一個合法雜湊。攻擊者隨手產一把金鑰，
 * 對 `{tags:{}}` 這種結構自己算 hash、自己簽，`verifyEvent` **會回傳 true**。
 *
 * 接著 `getExpiration()` 的 `event.tags.find(...)`／`matchFilter()` 的 `event.tags.some(...)`
 * 拋 `TypeError`。Worker 的 `webSocketMessage` 沒有 try/catch，未捕捉例外會中止 Durable Object
 * ——而這是**單一全域房間**（`idFromName("global")`），等於全站連線一起斷。
 *
 * 一則訊息、可無限重複、成本趨近於零。故在解析層就把非法形狀擋掉。
 */
function isValidEventShape(e) {
    if (typeof e !== "object" || e === null || Array.isArray(e))
        return false;
    const ev = e;
    if (!Number.isFinite(ev.kind) || !Number.isFinite(ev.created_at))
        return false;
    for (const field of ["id", "pubkey", "sig", "content"]) {
        if (typeof ev[field] !== "string")
            return false;
    }
    if (!Array.isArray(ev.tags))
        return false;
    for (const tag of ev.tags) {
        // 每個 tag 必須是字串陣列——`recipientsOf`／`getExpiration`／`matchFilter` 都做 `t[0]`/`t[1]`。
        if (!Array.isArray(tag))
            return false;
        for (const v of tag)
            if (typeof v !== "string")
                return false;
    }
    return true;
}
/** 單一 filter 的形狀：必須是純物件（非陣列、非 null）。 */
function isValidFilterShape(f) {
    return typeof f === "object" && f !== null && !Array.isArray(f);
}
/** 解析客戶端送來的原始字串為結構化訊息；無法解析時回傳 INVALID。 */
export function parseClientMessage(raw) {
    let arr;
    try {
        arr = JSON.parse(raw);
    }
    catch {
        return invalid("invalid json");
    }
    if (!Array.isArray(arr) || arr.length === 0)
        return invalid("not a non-empty array");
    switch (arr[0]) {
        case "EVENT": {
            const event = arr[1];
            if (!isValidEventShape(event))
                return invalid("malformed event");
            return { type: "EVENT", event: event };
        }
        case "REQ": {
            const subId = arr[1];
            if (typeof subId !== "string")
                return invalid("missing subscription id");
            const rest = arr.slice(2);
            if (!rest.every(isValidFilterShape))
                return invalid("malformed filter");
            return { type: "REQ", subId, filters: rest.length > 0 ? rest : [{}] };
        }
        case "CLOSE": {
            const subId = arr[1];
            if (typeof subId !== "string")
                return invalid("missing subscription id");
            return { type: "CLOSE", subId };
        }
        case "AUTH": {
            const event = arr[1];
            if (!isValidEventShape(event))
                return invalid("malformed auth event");
            return { type: "AUTH", event: event };
        }
        default:
            return invalid(`unknown message type: ${String(arr[0])}`);
    }
}
//# sourceMappingURL=protocol.js.map