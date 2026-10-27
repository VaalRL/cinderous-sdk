// MQTT 樣式的 topic 與萬用字元（SDK ADR 0049 §2.4）。
//
// - `#`：訂閱前綴標籤 `#tp`（每一則狀態帶「每層前綴 + /#」的盲化值）；
// - `+`：訂閱 `+` 之前最寬的前綴，解密後在客戶端以 {@link topicMatches} 比對；
// - 以 `$` 開頭的 topic（例如保留的 `$sys/acl`）不會被第一層的萬用字元配到（MQTT 3.1.1 §4.7.2）。
/** topic 最長幾個字元（MQTT 允許 65,535；IoT 協定只需要短 topic，且每層前綴都要盲化成一個標籤） */
export const IOT_TOPIC_MAX_LENGTH = 256;
/** topic 最多幾層（每層一個 `tp` 標籤；中繼單顆事件最多 128 個標籤） */
export const IOT_TOPIC_MAX_LEVELS = 16;
/** 角色名單管理用的保留 topic（只有 `owner` 能操作；ADR 0049 §2.5） */
export const IOT_ACL_TOPIC = '$sys/acl';
/** 推播登記用的保留 topic（任何有效成員都能登記自己的端點；ADR 0049 §11.1） */
export const IOT_PUSH_TOPIC = '$sys/push';
/** 中繼額度預警與狀態（ADR 0049 §10.3；C′ 的 relay 發給 owner） */
export const IOT_QUOTA_TOPIC = '$sys/quota';
function checkCommon(value, what) {
    if (typeof value !== 'string' || value.length === 0)
        throw new RangeError(`${what}不能是空的`);
    if (value.length > IOT_TOPIC_MAX_LENGTH)
        throw new RangeError(`${what}太長（最多 ${IOT_TOPIC_MAX_LENGTH} 字元）：${value.slice(0, 40)}…`);
    if (value.includes('\u0000'))
        throw new RangeError(`${what}不能含 NUL 字元`);
    const levels = value.split('/');
    if (levels.length > IOT_TOPIC_MAX_LEVELS)
        throw new RangeError(`${what}最多 ${IOT_TOPIC_MAX_LEVELS} 層：${value}`);
    return levels;
}
/** 具體的 topic（發布用）：不能有萬用字元 */
export function assertIotTopic(topic) {
    const levels = checkCommon(topic, 'topic ');
    if (levels.some((level) => level.includes('+') || level.includes('#')))
        throw new RangeError(`topic 不能有萬用字元（+、#）：${topic}`);
}
/** 訂閱樣式：`+` 必須獨佔一層，`#` 必須獨佔最後一層 */
export function assertIotTopicPattern(pattern) {
    const levels = checkCommon(pattern, 'topic 樣式');
    levels.forEach((level, index) => {
        if (level.includes('#') && (level !== '#' || index !== levels.length - 1))
            throw new RangeError(`# 只能獨佔最後一層：${pattern}`);
        if (level.includes('+') && level !== '+')
            throw new RangeError(`+ 必須獨佔一層：${pattern}`);
    });
}
export function isValidIotTopic(topic) {
    try {
        assertIotTopic(topic);
        return true;
    }
    catch {
        return false;
    }
}
export function isValidIotTopicPattern(pattern) {
    try {
        assertIotTopicPattern(pattern);
        return true;
    }
    catch {
        return false;
    }
}
/** MQTT 樣式比對（`+` 一層、`#` 零或多層；`$` 開頭的 topic 不被第一層萬用字元配到） */
export function topicMatches(pattern, topic) {
    const p = pattern.split('/');
    const t = topic.split('/');
    if (topic.startsWith('$') && (p[0] === '+' || p[0] === '#'))
        return false;
    for (let i = 0; i < p.length; i += 1) {
        const level = p[i];
        if (level === '#')
            return i === p.length - 1;
        if (i >= t.length)
            return false;
        if (level !== '+' && level !== t[i])
            return false;
    }
    return p.length === t.length;
}
/**
 * 一則狀態要帶的前綴（盲化前）：`a/b/c` → `a/#`、`a/b/#`、`a/b/c/#`（MQTT 的 `a/b/c/#` 也配得到 `a/b/c` 本身）。
 * 訂閱 `a/b/#` 就是 `#tp`＝blind("a/b/#")。
 */
export function topicPrefixes(topic) {
    const levels = topic.split('/');
    return levels.map((_, i) => `${levels.slice(0, i + 1).join('/')}/#`);
}
export function topicSubscriptionPlan(pattern) {
    assertIotTopicPattern(pattern);
    const levels = pattern.split('/');
    const first = levels.findIndex((level) => level === '+' || level === '#');
    if (first === -1)
        return { by: 'exact', value: pattern };
    if (first === 0)
        return { by: 'home' };
    return { by: 'prefix', value: `${levels.slice(0, first).join('/')}/#` };
}
/** 設備 id：1–64 字元的 `[A-Za-z0-9._:-]`（會出現在盲化輸入與設定檔裡） */
export function isValidIotDeviceId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(id);
}
/** 設備 id 的樣式：完全相同，或以 `*` 結尾的前綴（ADR 0049 §2.5，`light-*`）；單獨的 `*`＝全部 */
export function deviceMatches(pattern, deviceId) {
    if (pattern.endsWith('*'))
        return deviceId.startsWith(pattern.slice(0, -1));
    return pattern === deviceId;
}
//# sourceMappingURL=topic.js.map