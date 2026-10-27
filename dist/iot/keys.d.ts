import { type PubkeyHex, type SecretKey } from '../protocol/keys.js';
/** 家庭秘密的長度（bytes） */
export declare const IOT_HOME_SECRET_BYTES = 32;
/** 盲化結果的長度（base64url 字元） */
export declare const IOT_BLIND_LENGTH = 22;
/** 家庭秘密衍生出來的一切（{@link deriveIotHome}） */
export interface IotHome {
    /** 所有 IoT 內容的 NIP-44 收件者私鑰（成員與閘道都持有；任何成員都能以它 × 寄件人公鑰解密） */
    readonly homeKey: SecretKey;
    /** `homeKey` 的公鑰（公開值）：加密給全家只需要寄件人自己的私鑰與它 */
    readonly homePub: PubkeyHex;
    /** 盲化用的 HMAC 金鑰 */
    readonly topicKey: Uint8Array;
    /** 家的路由標籤（`h`）＝`blind("home")` */
    readonly homeTag: string;
    /** 盲化任意字串（topic、`dev:<id>`、`gw`、`sys:acl`…） */
    blind(value: string): string;
    /** 路線 C 的設備金鑰（ADR 0049 §2.6；P0 只提供衍生，信封在 P2） */
    deviceKey(deviceId: string, epoch?: number): Uint8Array;
}
/** 把家庭秘密（32 bytes 或 64 位 hex）正規化成位元組；長度不對就丟例外 */
export declare function iotHomeSecretBytes(secret: Uint8Array | string): Uint8Array;
/** 以 topicKey 盲化：`base64url(HMAC-SHA256(topicKey, value))` 取前 22 字元 */
export declare function blindWith(topicKey: Uint8Array, value: string): string;
/** 從家庭秘密導出設備金鑰（ADR 0049 §2.1、§2.6） */
export declare function deriveIotDeviceKey(homeSecret: Uint8Array | string, deviceId: string, epoch?: number): Uint8Array;
/** 從家庭秘密導出 `homeKey`、`homePub`、`topicKey`、`homeTag`（純函式、可測向量） */
export declare function deriveIotHome(homeSecret: Uint8Array | string): IotHome;
/** 盲化的保留名稱（ADR 0049 §2.2、§2.5） */
export declare const iotBlindNames: {
    readonly device: (deviceId: string) => string;
    readonly devicePart: (deviceId: string, part: number) => string;
    readonly gateway: "gw";
    readonly acl: "sys:acl";
};
/** 新的家庭秘密（64 位 hex；CLI `iot keygen` 用） */
export declare function generateIotHomeSecret(): string;
//# sourceMappingURL=keys.d.ts.map