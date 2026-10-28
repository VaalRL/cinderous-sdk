/**
 * 中繼拒收訊息的詞元與分類（SDK ADR 0038 P0-R2／P0-C；ADR 0040 詞元表）。
 *
 * 格式：`<NIP-01 前綴>: <英文詞元>: <給人看的說明>`，例如 `blocked: ceiling: 本站離線留言空間已滿…`。
 * 第三方中繼只保證 NIP-01 的前綴（`blocked`、`invalid`、`rate-limited`…），所以分類先看前綴，
 * 再看冒號後第一個詞元（只有 Cinderous／SDK 中繼會帶）。說明文字可以是中文，客戶端只看前兩層。
 *
 * 🔴 詞元是中繼與客戶端之間的契約（單一真實來源）：SDK 中繼、Cinderous 錨點與客戶端都引用這張表，
 * 改詞元要走契約測試（`tests/relay/reject-contract.test.ts`）。
 *
 * 這個檔案不帶任何中繼的完整句子（那在 `relay/reject-messages.ts`），只用連線池的應用不會把中文句子一起載入。
 */
/** 中繼寫在前綴後面的英文詞元（SDK ADR 0040）。 */
export declare const RELAY_REJECT_TOKENS: {
    readonly tooManyTags: "too-many-tags";
    readonly tooManyRecipients: "too-many-recipients";
    readonly tooLarge: "too-large";
    readonly notAllowed: "not-allowed";
    readonly kindDisabled: "kind-disabled";
    readonly filesDisabled: "files-disabled";
    readonly quota: "quota";
    readonly ceiling: "ceiling";
    readonly stale: "stale";
    readonly badSignature: "bad-signature";
    readonly clockSkew: "clock-skew";
    readonly expired: "expired";
    readonly relayTag: "relay-tag";
    readonly malformed: "malformed";
    readonly events: "events";
    readonly messages: "messages";
    readonly ip: "ip";
    readonly subscriptions: "subscriptions";
    /** IoT 即時通道的家庭今日額度用完（ADR 0049 §10；關閉碼 4429 也是這個詞元，SDK ADR 0122） */
    readonly iotQuota: "iot-quota";
    readonly scope: "scope";
    readonly tooManyConnections: "too-many-connections";
    readonly selfOnly: "self-only";
    /** 唯讀寬限期的舊路徑（SDK ADR 0052） */
    readonly readOnly: "read-only";
    readonly nip42: "nip42";
    readonly noChallenge: "no-challenge";
    readonly badAuth: "bad-auth";
    readonly authTooOld: "too-old";
    readonly difficulty: "difficulty";
    readonly seen: "seen";
    readonly internal: "internal";
    readonly resubscribe: "resubscribe";
};
export type RelayRejectToken = (typeof RELAY_REJECT_TOKENS)[keyof typeof RELAY_REJECT_TOKENS];
/**
 * 中繼寫在 `warning:` 後面的詞元（SDK ADR 0042；ADR 0040 詞元表）。不是拒收：事件收下了但有附帶條件，或是一則通知。
 *
 * - `borrowed`：`OK true "warning: borrowed: 7200: …"`——收進溢位帶，只保存那麼多秒、會最先被淘汰（ADR 0039）。
 *   **算即時送達，不算耐久收下**：`durability.minAccepted` 不計它（SDK ADR 0041）。
 * - `near-full`：`OK true "warning: near-full: 80: …"`——收下了（耐久），但這一類資料的空間已用這一級以上（粗分級：站方設定的一級與 95）。
 *   健康狀態記一個軟標記（`RelayHealthSnapshot.nearFull`），不影響發布（ADR 0038 決策 5）。
 * - `dropped`：`NOTICE "warning: dropped: <則數>: <since>: <until>: …"`——收件人讀自己的收件匣時，中繼告訴他有幾則寄給他的留言
 *   在送到之前因空間不足被刪掉（ADR 0038 M8）。`parseDroppedNotice()` 取出數字；連線池以 `onRelayDropped` 回報。
 */
export declare const RELAY_WARNING_TOKENS: {
    readonly borrowed: "borrowed";
    readonly nearFull: "near-full";
    readonly dropped: "dropped";
};
/**
 * 客戶端依拒收原因採取的動作分類（SDK ADR 0038 研究結果三 M1 的表）。
 * `timeout`／`disconnected` 不是中繼說的，是連線池自己觀察到的。
 */
export type RelayRejectKind = 'duplicate' | 'borrowed' | 'near-full' | 'auth-required' | 'restricted' | 'policy' | 'pow' | 'too-large' | 'quota' | 'ceiling' | 'stale' | 'rate-limited' | 'invalid' | 'error'
/** 這座暫時不能用（1013 Try Again Later：額度用完、儲存起不來；SDK ADR 0108）——不是拒收這台 */
 | 'unavailable' | 'timeout' | 'disconnected' | 'unknown';
export interface RelayRejectTraits {
    /** 同一座稍後（或處理完前置條件後）再送有沒有機會收下 */
    readonly retryable: boolean;
    /** 改寄別座中繼有沒有用 */
    readonly tryOtherRelays: boolean;
}
export interface RelayMessageClass extends RelayRejectTraits {
    /** NIP-01 機器可讀前綴（小寫）；沒有就是 undefined */
    readonly prefix: string | undefined;
    /** 前綴後的英文詞元（小寫）；第三方中繼通常沒有 */
    readonly token: string | undefined;
    readonly kind: RelayRejectKind;
    /** 去掉前綴與詞元之後的說明文字 */
    readonly detail: string;
}
export interface RelayCloseClass extends RelayRejectTraits {
    readonly kind: RelayRejectKind;
    readonly code: number | undefined;
    readonly reason: string;
    /** 關閉碼本身就說明了原因時的詞元（4429＝`iot-quota`） */
    readonly token?: string;
    /** 什麼時候恢復（unix 秒；4429 `iot-quota:<reset>`） */
    readonly reset?: number;
}
/**
 * IoT 即時通道（C′）的家庭額度用完（ADR 0049 §10.2）：relay 以 4429 `iot-quota:<重置 unix 秒>` 關掉這個家的所有連線。
 * 設備與手機都據此睡到重置時間，不狂重連（SDK ADR 0122）。
 */
export declare const IOT_QUOTA_CLOSE_CODE = 4429;
/**
 * `OK true "warning: borrowed: <秒>: …"` 的借用保存秒數（SDK ADR 0039／0041）。不是借用回 undefined；
 * 是借用但沒寫秒數回 `{ ttlSec: undefined }`。
 */
export declare function parseBorrowedWarning(message: string): {
    readonly ttlSec: number | undefined;
} | undefined;
/**
 * `OK true "warning: near-full: <級>: …"` 的那一級（百分比，SDK ADR 0042）。不是這種警告回 undefined。
 * 只有粗分級（站方設定的一級與 95），不是精確用量。
 */
export declare function parseNearFullWarning(message: string): {
    readonly percent: number;
} | undefined;
/** 中繼告訴收件人：有幾則寄給他的留言在送到之前被刪掉了（SDK ADR 0042；ADR 0038 M8） */
export interface RelayDroppedNotice {
    /** 則數 */
    readonly count: number;
    /** 被刪掉的事件裡最早的 `created_at`（unix 秒）。禮物包的外層時間被往前推過（NIP-59，最多兩天），找回時要放寬 */
    readonly since: number;
    /** 被刪掉的事件裡最晚的 `created_at`（unix 秒） */
    readonly until: number;
}
/** 解析 `NOTICE "warning: dropped: <則數>: <since>: <until>: …"`；不是這種通知回 undefined。 */
export declare function parseDroppedNotice(message: string): RelayDroppedNotice | undefined;
/**
 * 中繼說「認不得這個路徑」（ADR-0368 的升級拒絕：`NOTICE` 或 1008 關閉原因，以 `unknown relay path` 開頭）。
 * 私人路徑的中繼（SDK ADR 0051）換了路徑、舊路徑的唯讀寬限期也過了（SDK ADR 0052）之後，連舊網址就是這樣——
 * 應用據此提示「這座中繼已失效」。沒有 NIP-01 前綴，`classifyRelayMessage` 分不出來，所以另外給一個。
 */
export declare function isUnknownRelayPathMessage(message: string): boolean;
/** 某個分類可不可以重試、換座有沒有用 */
export declare function relayRejectKindOf(kind: RelayRejectKind): RelayRejectTraits;
/**
 * 把中繼的 `OK`／`CLOSED`／`NOTICE` 訊息拆成前綴、詞元與分類。
 * 對任何字串都回結果（不丟例外）；認不得的是 `unknown`。
 */
export declare function classifyRelayMessage(message: string): RelayMessageClass;
/**
 * 分類 WebSocket 關閉碼（SDK ADR 0038 P0-C）：中繼以 1008 `rate-limited` 踢掉超量的連線、
 * 以 4003 關掉白名單外的人、以 1008 `too-many-connections` 關掉同一把公鑰多出來的連線；
 * 車道升級被拒也是 1008（原因是 `unknown relay path`／`invalid app lane`）。
 * 1013 Try Again Later＝這座暫時不能用（額度用完 `over quota`、儲存起不來 `temporarily unavailable`；SDK ADR 0097、0108）。
 * 其他都當網路斷線。
 */
export declare function classifyRelayClose(code?: number, reason?: string): RelayCloseClass;
//# sourceMappingURL=relay-reject.d.ts.map