import type { NostrEvent } from '../protocol/event.js';
import type { PubkeyHex } from '../protocol/keys.js';
import type { NostrSigner } from '../protocol/signer.js';
import { type IotDeviceEnvelope } from './envelope.js';
import type { IotHome } from './keys.js';
/** 酬載的編碼：文字或 base64（二進位） */
export type IotEncoding = 'utf8' | 'base64';
/**
 * ack 的結果（ADR 0049 §2.3）。C′ 即時通道（§9.4、§10）另有：`offline`（設備沒有連線，即時等級不排隊）、
 * `stale`（連線還在、心跳已過期）、`quota`（中繼今日額度用完，附 `reset`）。
 */
export type IotAckStatus = 'ok' | 'rejected' | 'timeout' | 'unknown-topic' | 'not-allowed' | 'throttled' | 'offline' | 'stale' | 'quota';
export declare const IOT_ACK_STATUSES: readonly IotAckStatus[];
/** 單一酬載的位元組上限（指令與狀態；設備的訊息很短，這是防濫用上界） */
export declare const IOT_PAYLOAD_MAX_BYTES: number;
/** retained 單顆的明文上限：NIP-44 補齊與 base64 之後約 22 KB，在車道可尋址上限 32 KB 之內（ADR 0049 §2.3） */
export declare const IOT_RETAINED_PART_MAX_BYTES: number;
/** 一台設備的 retained 最多拆成幾顆 */
export declare const IOT_RETAINED_MAX_PARTS = 8;
export interface IotTopicValue {
    readonly payload: string;
    readonly enc?: IotEncoding;
    /** 這個值的時間（毫秒） */
    readonly ts: number;
}
interface IotBodyBase {
    readonly v: 1;
    /** 128 位元的訊息 id（32 位 hex；QoS 1 重送沿用同一個） */
    readonly msgId: string;
    /** 毫秒 */
    readonly ts: number;
}
/** 25170 操作 */
export interface IotCommandBody extends IotBodyBase {
    readonly type: 'cmd';
    readonly topic: string;
    readonly device?: string;
    readonly payload: string;
    readonly enc: IotEncoding;
    readonly qos: 0 | 1;
    /** 標了 `confirm: true` 的 topic 需要呼叫端明確確認（ADR 0049 §2.5） */
    readonly confirmed?: boolean;
}
/** 25173 查詢：要求設備立刻回報 */
export interface IotQueryBody extends IotBodyBase {
    readonly type: 'query';
    readonly device: string;
}
/** 25171 ack */
export interface IotAckBody extends IotBodyBase {
    readonly type: 'ack';
    /** 被回覆的指令或查詢的 msgId */
    readonly inReplyTo: string;
    readonly status: IotAckStatus;
    readonly reason?: string;
    /** 查詢的回覆：設備目前（或 retained 的）所有 topic 的值 */
    readonly topics?: Readonly<Record<string, IotTopicValue>>;
    readonly device?: string;
    /** `topics` 來自閘道的快取（＝retained），不是設備此刻的回報（查詢被節流、逾時、或設備不支援查詢） */
    readonly fromRetained?: boolean;
    /** C′ `dev-link` 的回覆：設備現在有沒有連線（relay 即時回答，不落庫；ADR 0049 §9.4） */
    readonly online?: boolean;
    /** C′：設備最後一次心跳（毫秒） */
    readonly lastHeartbeat?: number;
    /** `quota`：額度重置時間（unix 秒，ADR 0049 §10） */
    readonly reset?: number;
}
/**
 * C′／C 的 E2EE 設備指令（ADR 0049 §2.6、§9）：外層以 NIP-44（成員私鑰 × **閘道公鑰**）加密給 relay 的轉送半，內層是設備信封。
 * relay 看得到 `device`、`msgId` 與信封的明文欄位，看不到 topic、指令內容。
 * - `dev-cmd`（25170，需 `operator`）／`dev-query`（25173，需 `viewer`）：`env` 是 down 信封，轉給設備。
 * - `dev-link`（25173）：只問 relay「這台設備現在連著嗎」，不打擾設備、不帶 `env`。
 */
export interface IotDeviceCommandBody extends IotBodyBase {
    readonly type: 'dev-cmd' | 'dev-query' | 'dev-link';
    readonly device: string;
    readonly env?: IotDeviceEnvelope;
    readonly confirmed?: boolean;
}
/**
 * relay 把設備的 up 信封轉給全家（ADR 0049 §2.6 第 4 步）：外層 NIP-44（閘道私鑰 × `homePub`）。
 * `dev-ack` 走 25171（`p`＝還在等這台設備回覆的成員；回覆哪一個指令寫在信封裡面），`dev-state` 走 25172／31170。
 */
export interface IotDeviceReportBody extends IotBodyBase {
    readonly type: 'dev-ack' | 'dev-state';
    readonly device: string;
    readonly env: IotDeviceEnvelope;
}
/** 25172 即時狀態 */
export interface IotStateBody extends IotBodyBase {
    readonly type: 'state';
    readonly topic: string;
    readonly device?: string;
    readonly payload: string;
    readonly enc: IotEncoding;
    readonly inReplyTo?: string;
    /** 設備層的遺囑（例如 Tasmota `tele/<dev>/LWT` 的 Offline）轉譯成的狀態 */
    readonly will?: boolean;
}
/** 31170 retained（以設備為單位打包） */
export interface IotRetainedBody extends IotBodyBase {
    readonly type: 'retained';
    readonly device: string;
    readonly topics: Readonly<Record<string, IotTopicValue>>;
    readonly online?: boolean;
    /** 第幾顆（0 起算）與總共幾顆（超過單顆上限時拆開，ADR 0049 §2.3） */
    readonly part: number;
    readonly parts: number;
}
/** 31170 `d`＝blind("sys:acl")：閘道目前的角色名單（加密給全家，讓成員看得到） */
export interface IotAclBody extends IotBodyBase {
    readonly type: 'acl';
    readonly acl: unknown;
}
/** 31171 閘道存活 */
export interface IotGatewayBody extends IotBodyBase {
    readonly type: 'gw';
    readonly online: boolean;
    readonly heartbeatSec: number;
}
export type IotBody = IotCommandBody | IotQueryBody | IotAckBody | IotStateBody | IotRetainedBody | IotAclBody | IotGatewayBody | IotDeviceCommandBody | IotDeviceReportBody;
/** 新的 128 位元訊息 id（32 位 hex） */
export declare function newIotMsgId(): string;
/** 驗證解開的內容；不認得或欄位不對回 undefined（不丟例外：中繼與其他成員都不可信） */
export declare function parseIotBody(raw: unknown): IotBody | undefined;
/**
 * NIP-44 對話金鑰的快取：寄件時是「自己的簽章者 × homePub」，收件時是「homeKey × 寄件人公鑰」。
 * 兩者都是 ECDH，每則事件重算太浪費。
 */
export declare class IotKeyring {
    #private;
    constructor(home: IotHome, signer: NostrSigner);
    /** 把內容加密給全家（寄件人＝自己的簽章者） */
    seal(body: IotBody): string;
    /** 以 homeKey 解開某人寄給全家的內容；解不開或格式不對回 undefined */
    open(content: string, sender: PubkeyHex): IotBody | undefined;
}
/** 包成已簽章的事件 */
export declare function buildIotEvent(keyring: IotKeyring, signer: NostrSigner, kind: number, tags: string[][], body: IotBody): NostrEvent;
/** 事件的某個標籤值（第一個） */
export declare function tagValue(event: {
    tags: string[][];
}, name: string): string | undefined;
/** NIP-40 `expiration`（秒）；沒有或不合法回 undefined */
export declare function expirationOf(event: {
    tags: string[][];
}): number | undefined;
export {};
//# sourceMappingURL=content.d.ts.map