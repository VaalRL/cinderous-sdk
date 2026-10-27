import { type IotRetainedBody, type IotTopicValue } from './content.js';
export interface IotRetainedSnapshot {
    readonly device: string;
    readonly topics: Readonly<Record<string, IotTopicValue>>;
    /** 這次打包的時間（毫秒） */
    readonly ts: number;
    readonly online?: boolean;
    /** 最新一次打包的每一顆都讀到了 */
    readonly complete: boolean;
}
/** 把一台設備的所有 topic 打包成一或多顆 retained 內容；超過 {@link IOT_RETAINED_MAX_PARTS} 顆丟例外 */
export declare function packIotRetained(input: {
    device: string;
    topics: Readonly<Record<string, IotTopicValue>>;
    ts: number;
    online?: boolean;
}): IotRetainedBody[];
/** 合併同一台設備讀回來的各顆（只取最新一次打包）；沒有任何一顆回 undefined */
export declare function mergeIotRetained(parts: readonly IotRetainedBody[]): IotRetainedSnapshot | undefined;
//# sourceMappingURL=retained.d.ts.map