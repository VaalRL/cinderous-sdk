/** topic 最長幾個字元（MQTT 允許 65,535；IoT 協定只需要短 topic，且每層前綴都要盲化成一個標籤） */
export declare const IOT_TOPIC_MAX_LENGTH = 256;
/** topic 最多幾層（每層一個 `tp` 標籤；中繼單顆事件最多 128 個標籤） */
export declare const IOT_TOPIC_MAX_LEVELS = 16;
/** 角色名單管理用的保留 topic（只有 `owner` 能操作；ADR 0049 §2.5） */
export declare const IOT_ACL_TOPIC = "$sys/acl";
/** 推播登記用的保留 topic（任何有效成員都能登記自己的端點；ADR 0049 §11.1） */
export declare const IOT_PUSH_TOPIC = "$sys/push";
/** 中繼額度預警與狀態（ADR 0049 §10.3；C′ 的 relay 發給 owner） */
export declare const IOT_QUOTA_TOPIC = "$sys/quota";
/** 具體的 topic（發布用）：不能有萬用字元 */
export declare function assertIotTopic(topic: string): void;
/** 訂閱樣式：`+` 必須獨佔一層，`#` 必須獨佔最後一層 */
export declare function assertIotTopicPattern(pattern: string): void;
export declare function isValidIotTopic(topic: unknown): topic is string;
export declare function isValidIotTopicPattern(pattern: unknown): pattern is string;
/** MQTT 樣式比對（`+` 一層、`#` 零或多層；`$` 開頭的 topic 不被第一層萬用字元配到） */
export declare function topicMatches(pattern: string, topic: string): boolean;
/**
 * 一則狀態要帶的前綴（盲化前）：`a/b/c` → `a/#`、`a/b/#`、`a/b/c/#`（MQTT 的 `a/b/c/#` 也配得到 `a/b/c` 本身）。
 * 訂閱 `a/b/#` 就是 `#tp`＝blind("a/b/#")。
 */
export declare function topicPrefixes(topic: string): string[];
/**
 * 訂閱樣式 → 中繼上的過濾方式（盲化前）：
 * - `exact`：沒有萬用字元 → `#t`；
 * - `prefix`：第一個萬用字元之前有前綴 → `#tp`＝前綴＋`/#`；
 * - `home`：第一層就是萬用字元 → 只以 `#h` 過濾。
 * 有 `+`（或 `prefix`／`home`）時，客戶端解密後一定再以 {@link topicMatches} 比對一次。
 */
export type IotTopicPlan = {
    readonly by: 'exact';
    readonly value: string;
} | {
    readonly by: 'prefix';
    readonly value: string;
} | {
    readonly by: 'home';
};
export declare function topicSubscriptionPlan(pattern: string): IotTopicPlan;
/** 設備 id：1–64 字元的 `[A-Za-z0-9._:-]`（會出現在盲化輸入與設定檔裡） */
export declare function isValidIotDeviceId(id: unknown): id is string;
/** 設備 id 的樣式：完全相同，或以 `*` 結尾的前綴（ADR 0049 §2.5，`light-*`）；單獨的 `*`＝全部 */
export declare function deviceMatches(pattern: string, deviceId: string): boolean;
//# sourceMappingURL=topic.d.ts.map