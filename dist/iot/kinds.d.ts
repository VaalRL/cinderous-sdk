/** 操作（成員 → 閘道；會改變設備狀態，需 `operator`） */
export declare const IOT_KIND_COMMAND = 25170;
/** ack（閘道 → 下指令／查詢的成員） */
export declare const IOT_KIND_ACK = 25171;
/** 即時狀態／遙測（閘道 → 全家） */
export declare const IOT_KIND_STATE = 25172;
/** 查詢：要求設備立刻回報（成員 → 閘道；不改變狀態，`viewer` 以上） */
export declare const IOT_KIND_QUERY = 25173;
/** retained 狀態，以設備為單位打包（閘道 → 全家；可尋址） */
export declare const IOT_KIND_RETAINED = 31170;
/** 閘道存活（心跳；可尋址，`expiration`＝現在＋3×心跳間隔） */
export declare const IOT_KIND_HEARTBEAT = 31171;
/** 只有閘道能簽的狀態類 kind（客戶端只收 `authors=[閘道]`；ADR 0049 §6） */
export declare const IOT_STATE_KINDS: readonly number[];
/** 協定版本（內容的 `v`） */
export declare const IOT_PROTOCOL_VERSION = 1;
/** 指令與查詢的 `expiration` 最多比 `ts` 晚多久（秒；ADR 0049 §5：指令存活 5–300） */
export declare const IOT_MAX_TTL_SEC = 300;
//# sourceMappingURL=kinds.d.ts.map