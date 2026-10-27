export interface IotTopicMapEntry {
    readonly mqtt: string;
    readonly topic: string;
    readonly device: string;
    readonly dir: 'up' | 'down';
    /** 只對 `up`：這是設備的遺囑 topic；預設 `Online`／`Offline` */
    readonly lwt?: boolean | {
        readonly online?: string;
        readonly offline?: string;
    };
}
export interface IotQueryMapEntry {
    readonly device: string;
    /** 要發布到本地 broker 的原生查詢（例如 Tasmota `cmnd/plug1/STATUS`） */
    readonly mqtt: string;
    /** 預設空字串 */
    readonly payload?: string;
}
export interface IotUpMatch {
    readonly topic: string;
    readonly device: string;
    readonly lwt?: {
        readonly online: string;
        readonly offline: string;
    };
}
export interface IotDownMatch {
    readonly mqtt: string;
    readonly device: string;
}
export interface IotTopicMap {
    /** 本地 broker 上要訂閱的樣式 */
    readonly subscriptions: readonly string[];
    /** 本地 MQTT 訊息 → IoT topic；沒有對應回 undefined */
    up(mqttTopic: string): IotUpMatch | undefined;
    /** 手機的 IoT topic → 本地 MQTT topic；沒有對應回 undefined */
    down(topic: string): IotDownMatch | undefined;
    /** IoT topic 屬於哪台設備（角色名單依設備細分時用） */
    deviceOf(topic: string): string | undefined;
    /** 某台設備的原生查詢 */
    queries(device: string): readonly IotQueryMapEntry[];
    /** 對照表裡出現過的設備 */
    readonly devices: ReadonlySet<string>;
}
/** 驗證並編譯對照表；寫錯就丟例外（設定檔錯了不啟動） */
export declare function compileIotTopicMap(entries: readonly IotTopicMapEntry[], queries?: readonly IotQueryMapEntry[]): IotTopicMap;
//# sourceMappingURL=mapping.d.ts.map