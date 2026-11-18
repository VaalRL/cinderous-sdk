import type { IotRealtimeDeviceConfig } from './iot-realtime-config.js';
export { IOT_SHELLY_MAX_SWITCHES } from './iot-realtime-config.js';
/** relay 在 RPC 裡自稱的 `src`（Shelly 回覆時放在 `dst`） */
export declare const IOT_SHELLY_RPC_SRC = "cinder-relay";
export interface IotShellyTranslatorOptions {
    /** 這台設備的設定（`transport: 'shelly'`，有 `shelly.switches`） */
    device: IotRealtimeDeviceConfig;
    /** `deriveIotHome(homeSecret).deviceKey(id, epoch)`：來自 `IOT_PLAINTEXT_DEVICE_KEYS` */
    deviceKey: Uint8Array;
    /** 毫秒 */
    now?: () => number;
}
/** 一次轉譯的結果：`toDevice`＝要送給 Shelly 的 RPC；`up`＝要交給 `IotRealtimeHome.onDeviceFrame` 的設備幀（ack／state） */
export interface IotShellyOutput {
    readonly toDevice: string[];
    readonly up: string[];
}
export declare class IotShellyTranslator {
    #private;
    constructor(opts: IotShellyTranslatorOptions);
    /** relay → 設備的幀（`cmd`／`query`，down 信封）→ Shelly RPC；馬上能回答的（不認得的 topic、過期）直接回 up ack */
    fromRelay(text: string): IotShellyOutput;
    /** Shelly 送來的訊息：RPC 回覆 → up ack；`NotifyStatus`／`NotifyFullStatus` 的開關輸出 → up state；其他丟掉 */
    fromDevice(text: string): IotShellyOutput;
}
//# sourceMappingURL=iot-shelly.d.ts.map