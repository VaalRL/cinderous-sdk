export declare const IOT_ENVELOPE_VERSION = 1;
export declare const IOT_ENVELOPE_ALG = "A256GCM";
/** 信封明文上限（bytes）：retained 以單顆 32 KB 為限（車道可尋址上限），密文＋base64＋外層 NIP-44 都要放得進去 */
export declare const IOT_ENVELOPE_MAX_PLAINTEXT_BYTES: number;
export type IotEnvelopeDirection = 'down' | 'up';
export interface IotDeviceEnvelope {
    readonly v: 1;
    readonly alg: 'A256GCM';
    readonly kid: string;
    readonly dir: IotEnvelopeDirection;
    readonly ctr: number;
    readonly ts: number;
    readonly nonce: string;
    readonly ct: string;
}
export type IotEnvelopeErrorCode = 'format' | 'nonce' | 'auth';
/** 信封解不開（`code`：格式不對／nonce 與方向或計數器不符／驗證失敗） */
export declare class IotEnvelopeError extends Error {
    readonly code: IotEnvelopeErrorCode;
    constructor(code: IotEnvelopeErrorCode, message: string);
}
/** `kid`＝`<設備 id>.<epoch>`（設備 id 可以含點，以最後一個點切） */
export declare function iotKid(deviceId: string, epoch: number): string;
/** 解析 `kid`；不合法回 undefined */
export declare function parseIotKid(kid: string): {
    deviceId: string;
    epoch: number;
} | undefined;
/** AAD 字串（設備端照這個格式組，逐字相同） */
export declare function iotEnvelopeAad(env: Pick<IotDeviceEnvelope, 'dir' | 'kid' | 'ctr' | 'ts'>): string;
/**
 * 門鎖類設備（`class: 'lock'`）down 方向的金鑰（ADR 0049 §9.5）：只發給 operator／owner 的 `operatorSecret` 導出——
 * 「viewer＋被攻破的 relay」也做不出設備解得開的指令。up 方向仍用 {@link deriveIotDeviceKey}。
 */
export declare function deriveIotDeviceKeyDown(operatorSecret: Uint8Array | string, deviceId: string, epoch?: number): Uint8Array;
export interface SealIotEnvelopeInput {
    key: Uint8Array;
    kid: string;
    dir: IotEnvelopeDirection;
    /** up：設備嚴格遞增、持久化的計數器；down：發送端自己的序號（只進 AAD） */
    ctr: number;
    /** unix 秒 */
    ts: number;
    plaintext: Uint8Array | string;
    /** 只給測試向量用：down 的 nonce（必須 0x00 開頭）；up 一律由 ctr 算出，不接受指定 */
    nonce?: Uint8Array;
}
/** 封裝一個設備信封 */
export declare function sealIotEnvelope(input: SealIotEnvelopeInput): IotDeviceEnvelope;
/** 驗證信封形狀（不解密）；不合法回 undefined。relay 轉送前用它擋掉壞信封 */
export declare function parseIotEnvelope(value: unknown): IotDeviceEnvelope | undefined;
/** 解開設備信封；失敗丟 {@link IotEnvelopeError} */
export declare function openIotEnvelope(value: IotDeviceEnvelope | unknown, key: Uint8Array): Uint8Array;
export interface IotUpCounterGuardOptions {
    /** 從持久化恢復：kid → 最後接受的 ctr */
    initial?: Record<string, number>;
    /** 最多記幾個 kid（預設 4,096），最舊的先丟 */
    maxEntries?: number;
}
/**
 * up 方向的計數器檢查（ADR 0049 §2.6）：每個 kid 只接受嚴格遞增的 ctr。手機與 relay（看得到明文的 ctr，先擋省一次扇出）都用。
 * 只在信封**驗證通過之後**才呼叫 {@link accept}——否則偽造的大 ctr 會把真的設備擋在外面。
 */
export declare class IotUpCounterGuard {
    #private;
    constructor(opts?: IotUpCounterGuardOptions);
    /** 比上次大才接受並記下 */
    accept(kid: string, ctr: number): boolean;
    last(kid: string): number | undefined;
    /** 給持久化用 */
    snapshot(): Record<string, number>;
}
//# sourceMappingURL=envelope.d.ts.map