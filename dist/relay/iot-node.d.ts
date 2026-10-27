import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { SqlExec } from './sql-message-store.js';
export interface IotNodeHub {
    /** 這是 IoT 路徑嗎；是的話已處理（接受或拒絕） */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    /** 一般 HTTP 請求打到 `/iot/`：回錯誤；不是 IoT 路徑回 false */
    handleHttp(path: string): {
        status: number;
        error: string;
    } | undefined;
    close(): void;
}
/**
 * 建立 Node 的 IoT 集線器。`IOT_REALTIME` 沒設＝回傳的集線器對所有 `/iot/` 回 404 `blocked: iot-disabled:`（與 Workers 版相同）。
 * `exec` 給了就把角色名單存進 `iot_acl` 表。
 */
export declare function createIotNodeHub(env: Record<string, string | undefined>, opts?: {
    exec?: SqlExec;
}): IotNodeHub;
//# sourceMappingURL=iot-node.d.ts.map