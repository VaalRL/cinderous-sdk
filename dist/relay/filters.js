/** 判斷事件是否符合單一 filter（NIP-01：欄位間為 AND，陣列內為 OR）。 */
export function matchFilter(filter, event) {
    if (filter.ids && !filter.ids.includes(event.id))
        return false;
    if (filter.authors && !filter.authors.includes(event.pubkey))
        return false;
    if (filter.kinds && !filter.kinds.includes(event.kind))
        return false;
    if (filter.since !== undefined && event.created_at < filter.since)
        return false;
    if (filter.until !== undefined && event.created_at > filter.until)
        return false;
    // `#<tag>` 標籤 filter：每個指定的標籤都必須有任一值命中（欄位間 AND）。
    for (const key in filter) {
        if (key.charCodeAt(0) !== 35 /* '#' */)
            continue;
        const wanted = filter[key];
        if (!wanted)
            continue;
        const tagName = key.slice(1);
        const hit = event.tags.some((t) => t[0] === tagName && t[1] !== undefined && wanted.includes(t[1]));
        if (!hit)
            return false;
    }
    return true;
}
//# sourceMappingURL=filters.js.map