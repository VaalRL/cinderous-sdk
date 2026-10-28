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
export const RELAY_REJECT_TOKENS = {
    // blocked:
    tooManyTags: 'too-many-tags',
    tooManyRecipients: 'too-many-recipients',
    tooLarge: 'too-large',
    notAllowed: 'not-allowed',
    kindDisabled: 'kind-disabled',
    filesDisabled: 'files-disabled',
    quota: 'quota',
    ceiling: 'ceiling',
    stale: 'stale',
    // invalid:
    badSignature: 'bad-signature',
    clockSkew: 'clock-skew',
    expired: 'expired',
    relayTag: 'relay-tag',
    malformed: 'malformed',
    // rate-limited:
    events: 'events',
    messages: 'messages',
    ip: 'ip',
    subscriptions: 'subscriptions',
    /** IoT 即時通道的家庭今日額度用完（ADR 0049 §10；關閉碼 4429 也是這個詞元，SDK ADR 0122） */
    iotQuota: 'iot-quota',
    // restricted:
    scope: 'scope',
    tooManyConnections: 'too-many-connections',
    selfOnly: 'self-only',
    /** 唯讀寬限期的舊路徑（SDK ADR 0052） */
    readOnly: 'read-only',
    // auth-required: ／ auth-failed:
    nip42: 'nip42',
    noChallenge: 'no-challenge',
    badAuth: 'bad-auth',
    authTooOld: 'too-old',
    // pow:
    difficulty: 'difficulty',
    // duplicate:
    seen: 'seen',
    // error:
    internal: 'internal',
    resubscribe: 'resubscribe',
};
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
export const RELAY_WARNING_TOKENS = {
    borrowed: 'borrowed',
    nearFull: 'near-full',
    dropped: 'dropped',
};
/**
 * IoT 即時通道（C′）的家庭額度用完（ADR 0049 §10.2）：relay 以 4429 `iot-quota:<重置 unix 秒>` 關掉這個家的所有連線。
 * 設備與手機都據此睡到重置時間，不狂重連（SDK ADR 0122）。
 */
export const IOT_QUOTA_CLOSE_CODE = 4429;
const IOT_QUOTA_CLOSE_REASON = /^iot-quota:\s*(\d{1,12})\b/i;
const TRAITS = {
    duplicate: { retryable: false, tryOtherRelays: false },
    // 收下了但只是借用（溢位帶、會最先被淘汰）：不必重送這一座，但要耐久就得另找一座
    borrowed: { retryable: false, tryOtherRelays: true },
    // 收下了（耐久），只是空間快滿：不必重送；要不要另存一份由應用決定
    'near-full': { retryable: false, tryOtherRelays: false },
    'auth-required': { retryable: true, tryOtherRelays: false },
    restricted: { retryable: false, tryOtherRelays: true },
    policy: { retryable: false, tryOtherRelays: true },
    pow: { retryable: true, tryOtherRelays: true },
    'too-large': { retryable: false, tryOtherRelays: true },
    quota: { retryable: true, tryOtherRelays: true },
    ceiling: { retryable: true, tryOtherRelays: true },
    stale: { retryable: false, tryOtherRelays: false },
    'rate-limited': { retryable: true, tryOtherRelays: true },
    invalid: { retryable: false, tryOtherRelays: false },
    error: { retryable: true, tryOtherRelays: true },
    unavailable: { retryable: true, tryOtherRelays: true },
    timeout: { retryable: true, tryOtherRelays: true },
    disconnected: { retryable: true, tryOtherRelays: true },
    unknown: { retryable: true, tryOtherRelays: true },
};
/**
 * `OK true "warning: borrowed: <秒>: …"` 的借用保存秒數（SDK ADR 0039／0041）。不是借用回 undefined；
 * 是借用但沒寫秒數回 `{ ttlSec: undefined }`。
 */
export function parseBorrowedWarning(message) {
    const klass = classifyRelayMessage(message);
    if (klass.kind !== 'borrowed')
        return undefined;
    const seconds = /^(\d+)\s*(?::|$)/.exec(klass.detail);
    return { ttlSec: seconds === null ? undefined : Number(seconds[1]) };
}
/**
 * `OK true "warning: near-full: <級>: …"` 的那一級（百分比，SDK ADR 0042）。不是這種警告回 undefined。
 * 只有粗分級（站方設定的一級與 95），不是精確用量。
 */
export function parseNearFullWarning(message) {
    const klass = classifyRelayMessage(message);
    if (klass.kind !== 'near-full')
        return undefined;
    const grade = /^(\d+)\s*(?::|$)/.exec(klass.detail);
    return grade === null ? undefined : { percent: Number(grade[1]) };
}
/** 解析 `NOTICE "warning: dropped: <則數>: <since>: <until>: …"`；不是這種通知回 undefined。 */
export function parseDroppedNotice(message) {
    const klass = classifyRelayMessage(message);
    if (klass.prefix !== 'warning' || klass.token !== RELAY_WARNING_TOKENS.dropped)
        return undefined;
    const m = /^(\d+)\s*:\s*(\d+)\s*:\s*(\d+)\s*(?::|$)/.exec(klass.detail);
    if (m === null)
        return undefined;
    return { count: Number(m[1]), since: Number(m[2]), until: Number(m[3]) };
}
/**
 * 中繼說「認不得這個路徑」（ADR-0368 的升級拒絕：`NOTICE` 或 1008 關閉原因，以 `unknown relay path` 開頭）。
 * 私人路徑的中繼（SDK ADR 0051）換了路徑、舊路徑的唯讀寬限期也過了（SDK ADR 0052）之後，連舊網址就是這樣——
 * 應用據此提示「這座中繼已失效」。沒有 NIP-01 前綴，`classifyRelayMessage` 分不出來，所以另外給一個。
 */
export function isUnknownRelayPathMessage(message) {
    return /^unknown relay path\b/i.test(message.trim());
}
/** 某個分類可不可以重試、換座有沒有用 */
export function relayRejectKindOf(kind) {
    return TRAITS[kind];
}
/** 前綴本身的分類（NIP-01／NIP-42 的標準前綴；`auth-failed` 是 Cinderous 對 AUTH 的回覆） */
const PREFIX_KIND = {
    duplicate: 'duplicate',
    'auth-required': 'auth-required',
    'auth-failed': 'restricted',
    restricted: 'restricted',
    blocked: 'policy',
    mute: 'policy',
    unsupported: 'policy',
    pow: 'pow',
    'rate-limited': 'rate-limited',
    invalid: 'invalid',
    error: 'error',
};
/** 詞元對分類的覆寫（只有這幾個會改變前綴給的分類） */
const TOKEN_KIND = {
    [RELAY_REJECT_TOKENS.tooLarge]: 'too-large',
    [RELAY_REJECT_TOKENS.tooManyTags]: 'too-large',
    [RELAY_REJECT_TOKENS.tooManyRecipients]: 'too-large',
    [RELAY_REJECT_TOKENS.quota]: 'quota',
    [RELAY_REJECT_TOKENS.ceiling]: 'ceiling',
    [RELAY_REJECT_TOKENS.stale]: 'stale',
};
const WORD = /^([a-z][a-z0-9-]*):\s*/;
/**
 * 把中繼的 `OK`／`CLOSED`／`NOTICE` 訊息拆成前綴、詞元與分類。
 * 對任何字串都回結果（不丟例外）；認不得的是 `unknown`。
 */
export function classifyRelayMessage(message) {
    let rest = message.trim();
    const lower = rest.toLowerCase();
    const head = WORD.exec(lower);
    let prefix;
    let token;
    if (head !== null) {
        prefix = head[1];
        rest = rest.slice(head[0].length);
        const next = WORD.exec(rest.toLowerCase());
        if (next !== null) {
            token = next[1];
            rest = rest.slice(next[0].length);
        }
    }
    let kind = prefix === undefined ? 'unknown' : (PREFIX_KIND[prefix] ?? 'unknown');
    // 舊版中繼（沒有詞元）的幾句，照樣認得
    if (token === undefined)
        token = legacyToken(prefix, lower);
    if (prefix === undefined && (lower.startsWith('unknown relay path') || lower.startsWith('invalid app lane')))
        kind = 'invalid';
    if (token !== undefined && (prefix === 'blocked' || prefix === 'invalid'))
        kind = TOKEN_KIND[token] ?? kind;
    if (prefix === 'warning' && token === RELAY_WARNING_TOKENS.borrowed)
        kind = 'borrowed';
    if (prefix === 'warning' && token === RELAY_WARNING_TOKENS.nearFull)
        kind = 'near-full';
    return { prefix, token, kind, detail: rest.trim(), ...TRAITS[kind] };
}
function legacyToken(prefix, lower) {
    // ADR 0027：舊中繼的「檔案事件未啟用」只有 `MAX_FILE_MB` 這個記號
    if (prefix === 'blocked' && lower.includes('max_file_mb'))
        return RELAY_REJECT_TOKENS.filesDisabled;
    // Cinderous ADR-0373：DO 重啟後遺失、或存不住的訂閱，舊句子請客戶端重訂
    if (prefix === 'error' && lower.includes('please resubscribe'))
        return RELAY_REJECT_TOKENS.resubscribe;
    return undefined;
}
/**
 * 分類 WebSocket 關閉碼（SDK ADR 0038 P0-C）：中繼以 1008 `rate-limited` 踢掉超量的連線、
 * 以 4003 關掉白名單外的人、以 1008 `too-many-connections` 關掉同一把公鑰多出來的連線；
 * 車道升級被拒也是 1008（原因是 `unknown relay path`／`invalid app lane`）。
 * 1013 Try Again Later＝這座暫時不能用（額度用完 `over quota`、儲存起不來 `temporarily unavailable`；SDK ADR 0097、0108）。
 * 其他都當網路斷線。
 */
export function classifyRelayClose(code, reason) {
    const r = (reason ?? '').trim();
    const lower = r.toLowerCase();
    let kind = 'disconnected';
    if (code === 4003)
        kind = 'restricted';
    else if (code === 1013)
        kind = 'unavailable';
    else if (code === IOT_QUOTA_CLOSE_CODE) {
        const reset = IOT_QUOTA_CLOSE_REASON.exec(r)?.[1];
        return { kind: 'unavailable', code, reason: r, token: RELAY_REJECT_TOKENS.iotQuota, ...(reset !== undefined ? { reset: Number(reset) } : {}), ...TRAITS.unavailable };
    }
    else if (code === 1008) {
        if (lower.startsWith('rate-limited'))
            kind = 'rate-limited';
        else if (lower.startsWith('too-many-connections') || lower.startsWith('restricted'))
            kind = 'restricted';
        else if (lower.startsWith('unknown relay path') || lower.startsWith('invalid app lane'))
            kind = 'invalid';
        else
            kind = 'policy';
    }
    return { kind, code, reason: r, ...TRAITS[kind] };
}
//# sourceMappingURL=relay-reject.js.map