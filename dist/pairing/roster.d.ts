import type { NostrSigner } from '../protocol/signer.js';
export declare const ROSTER_VERSION = 1;
/** 有效裝置上限 */
export declare const ROSTER_MAX_DEVICES = 32;
/** 撤銷紀錄上限（超過時先丟「撤銷者本身已被撤銷」的，再丟最舊的） */
export declare const ROSTER_MAX_REVOKED = 32;
/** 保留的金鑰數（超過時先丟建立者已被撤銷的，再丟 epoch 最小的） */
export declare const ROSTER_MAX_KEYS = 8;
export declare const ROSTER_LABEL_MAX = 40;
export declare const VAULT_KEY_BYTES = 32;
/** epoch 上限 */
export declare const ROSTER_MAX_EPOCH: number;
/**
 * 舊版（≤ v0.29，沒有能力宣告）的裝置經中繼收得下的單檔上限：360 塊 × 48,000 B（≈16.5 MB）。
 * 與 `sync/ingest` 的 `FILE_TIER_MAX_BYTES` 同一個數字（測試釘住；這個子路徑不匯入同步零件）。
 * 其實 v0.25–v0.29 已經收得下 64 MiB，但名單看不出來是哪一版，只能照最舊的算。
 */
export declare const LEGACY_MAX_RELAY_FILE_BYTES: number;
/** 這一版 SDK 的版本號（`package.json` 的 version；測試釘住兩者一致） */
export declare const SDK_VERSION = "0.78.0";
/**
 * 這一版 SDK 的裝置能力（SDK ADR 0035 §G9）：
 * - `sdk`：SDK 版本；
 * - `maxRelayFileBytes`：經中繼收得下的單檔上限——v0.25 起收端的絕對上限 64 MiB（`RELAY_FILE_MAX_BYTES_CAP`）。
 */
export declare const CURRENT_DEVICE_CAPABILITIES: Readonly<DeviceCapabilities>;
/** 一台裝置的能力宣告，正規化 JSON 的長度上限（32 台都塞滿仍放得進歡迎訊息與名單事件的 NIP-44 明文上限） */
export declare const ROSTER_CAPS_MAX_JSON = 160;
export interface RosterDevice {
    pubkey: string;
    /** 協調器的 deviceId（英數與 `_.:-`，最長 64）；建議用 `defaultDeviceId(pubkey)` */
    deviceId: string;
    label: string;
    /** 裝置自己對 (pubkey, deviceId, label) 的簽章（base64） */
    claim: string;
    /** 加入時間（毫秒；由加入者簽） */
    addedAt: number;
    /** 誰把它加進來（公鑰） */
    addedBy: string;
    /** 加入者的簽章（base64） */
    sig: string;
}
/**
 * 裝置能力（SDK ADR 0035 §G9）。`sdk` 與 `maxRelayFileBytes` 必填；未來版本可以多帶其他欄位
 * （英數鍵、值為字串／數字／布林），舊版原樣保留、照驗簽章。
 */
export interface DeviceCapabilities {
    sdk: string;
    /** 經中繼收得下的單檔上限（位元組） */
    maxRelayFileBytes: number;
    [feature: string]: string | number | boolean;
}
/** 名單上的一筆能力宣告：**裝置自己簽**（別的成員改不了、也冒名不了） */
export interface RosterCapability {
    pubkey: string;
    caps: DeviceCapabilities;
    /** 宣告時間（毫秒）；同一台取較晚的 */
    at: number;
    sig: string;
}
/**
 * 名單上的一筆備援宣告（SDK ADR 0056）：能力宣告的延伸，**裝置自己簽**（別的成員改不了、也冒名不了）。
 * `urls` 是正規化過、可以分享的公開 `wss://` 網址（最多 {@link ROSTER_STANDBY_MAX_URLS} 座）；空陣列＝這台沒有備援。
 */
export interface RosterStandby {
    pubkey: string;
    urls: string[];
    /** 宣告時間（毫秒）；同一台取較晚的 */
    at: number;
    sig: string;
}
/**
 * 名單上的一筆輕量成員宣告（SDK ADR 0058）：能力宣告的延伸，**裝置自己簽**。`patterns` 是這台的內容範圍
 * （gitignore 語法、符合＝在範圍內；`@cinderous/client/sync/vault` 的 `compilePathScope` 編譯）；`null`＝完整成員。
 */
export interface RosterSparse {
    pubkey: string;
    patterns: string[] | null;
    /** 宣告時間（毫秒）；同一台取較晚的 */
    at: number;
    sig: string;
}
/**
 * 名單上的一筆改名宣告（SDK ADR 0069）：能力宣告的延伸，**裝置自己簽**（別的成員改不了、也冒名不了）。
 * `label` 照 {@link sanitizeLabel} 清理過；有宣告時蓋過配對時簽進 `devices` 的名稱。
 */
export interface RosterLabel {
    pubkey: string;
    label: string;
    /** 宣告時間（毫秒）；同一台取較晚的 */
    at: number;
    sig: string;
}
/** {@link VaultMembership.sparseMembers} 的一筆 */
export interface SparseMember {
    readonly pubkey: string;
    readonly deviceId: string;
    readonly label: string;
    readonly patterns: readonly string[];
    readonly at: number;
}
/** 輕量成員宣告最多幾條規則（SDK ADR 0058） */
export declare const ROSTER_SPARSE_MAX_PATTERNS = 16;
/** 每條規則的長度上限 */
export declare const ROSTER_SPARSE_MAX_PATTERN_LENGTH = 200;
/**
 * 輕量成員宣告的規則正規化：去掉前後空白、空行與 `#` 註解、去重；有控制字元、太長、太多 → null（不合規）。
 * 這裡只看形狀，不驗 gitignore 語法（`./pairing` 不匯入同步零件；收方編譯時不合法的規則略過）。
 */
export declare function normalizeSparsePatterns(patterns: readonly unknown[]): string[] | null;
/** {@link VaultMembership.declaredStandbys} 的一筆：某台有效成員宣告的備援 */
export interface DeclaredStandby {
    readonly pubkey: string;
    readonly deviceId: string;
    readonly label: string;
    readonly urls: readonly string[];
    readonly at: number;
}
/** {@link VaultMembership.minCapability} 的結果 */
export interface MinCapability {
    /** 所有有效成員都收得下的單檔上限；有任何一台沒宣告就是 {@link LEGACY_MAX_RELAY_FILE_BYTES} */
    maxRelayFileBytes: number;
    /** 所有有效成員中最舊的 SDK 版本；有任何一台沒宣告就是 null */
    sdk: string | null;
    /** 沒有能力宣告的有效成員（舊版，或升級後還沒宣告）的公鑰，排序過 */
    missing: string[];
}
export interface RosterRevocation {
    pubkey: string;
    at: number;
    by: string;
    sig: string;
}
export interface VaultKey {
    epoch: number;
    /** 金鑰 SHA-256 的前 8 bytes（hex）；應用可以把它記在密文旁邊，解密時找對的金鑰 */
    id: string;
    key: Uint8Array;
    at: number;
    by: string;
    /** 建立時的撤銷集合雜湊 */
    rv: string;
    sig: string;
}
/** 線上與持久化格式（金鑰以 base64） */
export interface VaultRosterData {
    v: number;
    vaultId: string;
    devices: RosterDevice[];
    revoked: RosterRevocation[];
    keys: Array<Omit<VaultKey, 'key'> & {
        key: string;
    }>;
    /** 裝置能力宣告（v0.30 起；舊名單沒有這一欄，舊版解析時略過） */
    caps?: RosterCapability[];
    /** 裝置自己簽的備援清單（v0.45 起，SDK ADR 0056；舊版解析時略過） */
    standby?: RosterStandby[];
    /** 裝置自己簽的輕量成員宣告（v0.46 起，SDK ADR 0058；舊版解析時略過） */
    sparse?: RosterSparse[];
    /** 裝置自己簽的改名宣告（v0.52 起，SDK ADR 0069；舊版解析時略過） */
    labels?: RosterLabel[];
}
export interface MembershipChange {
    /** `caps`：這台裝置更新了自己的能力宣告（v0.30，SDK ADR 0035）、備援宣告（v0.45，SDK ADR 0056）、輕量成員宣告（ADR 0058）或名稱（v0.52，ADR 0069） */
    reason: 'create' | 'add' | 'revoke' | 'rotate' | 'merge' | 'caps';
    /** 新加入的公鑰 */
    added: string[];
    /** 新撤銷的公鑰 */
    revoked: string[];
    /** 目前的金鑰換了 */
    keyChanged: boolean;
    /** 這台裝置自己不再是成員（被撤銷）：應停止同步、提示使用者 */
    selfRevoked: boolean;
}
/** 由公鑰決定的 deviceId（`d` ＋ 公鑰前 16 位 hex）：每台裝置各自一把身分，天然不重複 */
export declare function defaultDeviceId(pubkey: string): string;
/** 清掉控制字元、截到上限 */
export declare function sanitizeLabel(label: unknown): string;
/** 驗證能力的形狀；不合法回 null */
export declare function parseCapabilities(raw: unknown): DeviceCapabilities | null;
/** semver 比大小（預發行版比正式版小） */
export declare function compareSdkVersions(a: string, b: string): number;
/**
 * 裝置自己對 (公鑰, deviceId, 名稱) 的簽章。配對時新裝置送給成員，成員加入名單時一併存下；
 * 別台成員因此改不了這台的 deviceId 與名稱。
 */
export declare function claimDevice(signer: NostrSigner, device: {
    deviceId: string;
    label?: string;
}): string;
export declare function verifyDeviceClaim(device: {
    pubkey: string;
    deviceId: string;
    label: string;
}, claim: unknown): boolean;
interface ParsedRoster {
    vaultId: string;
    devices: RosterDevice[];
    revoked: RosterRevocation[];
    keys: VaultKey[];
    caps: RosterCapability[];
    standby: RosterStandby[];
    sparse: RosterSparse[];
    labels: RosterLabel[];
}
/** 驗證名單資料的每一欄與每一個簽章；不合法回 null（不信任網路來源） */
export declare function parseRosterData(raw: unknown): ParsedRoster | null;
export interface MembershipOptions {
    now?: () => number;
    random?: (bytes: number) => Uint8Array;
}
/**
 * 這台裝置所屬的 Vault 成員名單與共享金鑰。修改（加入、撤銷、輪換，以及合併後的自動輪換）都要以這台的身分簽章，
 * 所以建立時要給 `signer`（例如 `Identity`；私鑰不交出）。
 *
 * 狀態含共享金鑰，屬於機密：以 `toJSON()` 匯出、存進平台的機密儲存（例如 Obsidian `app.secretStorage`），
 * **不要**寫進會被同步出去的設定檔；以 `VaultMembership.restore()` 讀回。
 */
export declare class VaultMembership {
    #private;
    readonly self: string;
    readonly vaultId: string;
    private constructor();
    /** 建立一個新的 Vault（這台是第一台裝置） */
    static create(self: {
        signer: NostrSigner;
        deviceId?: string;
        label?: string;
    }, opts?: MembershipOptions): VaultMembership;
    /** 從名單資料建立（新裝置收到歡迎訊息時） */
    static fromRoster(signer: NostrSigner, data: unknown, opts?: MembershipOptions): VaultMembership;
    /** 還原 `toJSON()` 的結果；`signer` 必須是這台裝置的身分 */
    static restore(json: string, signer: NostrSigner, opts?: MembershipOptions): VaultMembership;
    toJSON(): string;
    /** 完整名單（含共享金鑰；只能經加密通道送給成員） */
    roster(): VaultRosterData;
    onChange(listener: (change: MembershipChange) => void): () => void;
    /** 這台裝置還是成員（沒被撤銷、也沒有因 deviceId 相撞或超過上限被排除） */
    get active(): boolean;
    /** 這台在名單上的那一筆；`label` 是目前的名稱（有改名宣告時用宣告的，SDK ADR 0069） */
    get selfDevice(): RosterDevice | undefined;
    /**
     * 目前有效的裝置（含自己），依加入時間排序。`label` 是目前的名稱：有改名宣告時用宣告的（SDK ADR 0069），
     * `claim`、`sig` 仍是配對時那一筆的（要驗聲明請用 {@link roster} 的原始資料）。
     */
    devices(): RosterDevice[];
    isMember(pubkey: string): boolean;
    isRevoked(pubkey: string): boolean;
    revocations(): RosterRevocation[];
    /** 其他成員的公鑰：給 `NostrVaultTransport` 的 `devices`、`PeerNode` 的 `acceptFrom`、名單同步的收件人 */
    peerPubkeys(): string[];
    /** 其他成員：協調器的 deviceId → 公鑰（給 `peerNodeLink` 的 `devices`） */
    peerDevices(): Record<string, string>;
    /** 公鑰 → deviceId（有效成員，含自己）；給 `NostrVaultTransport` 的 `deviceOf` */
    deviceIdOf(pubkey: string): string | undefined;
    /**
     * 自己中繼的白名單（ADR 0027 部署的 `allowedPubkeys`）：所有有效成員（含自己），加上 `extra`
     * （例如正在配對、還沒完成的新裝置）。被撤銷的公鑰一律不在裡面。
     */
    allowedPubkeys(extra?: readonly string[]): string[];
    /** 目前的共享金鑰（加密新內容用）：建立者沒被撤銷的金鑰中 epoch 最大者 */
    currentKey(): VaultKey;
    /** 依 id 找金鑰（解開舊內容用）；已經被丟掉的回 undefined */
    key(id: string): VaultKey | undefined;
    keys(): VaultKey[];
    /** 由某台裝置加進來的裝置（有簽章，不能冒名）。撤銷一台被入侵的裝置時，應一併檢查它加進來的裝置 */
    devicesAddedBy(pubkey: string): RosterDevice[];
    /** 某台有效成員宣告的能力；沒宣告（舊版）或不是成員回 undefined */
    capabilitiesOf(pubkey: string): DeviceCapabilities | undefined;
    /**
     * 所有有效成員（含自己）都支援的能力下限（SDK ADR 0035 §G9）。給協調器決定經中繼送的單檔門檻：
     * `coordinator.setMemberCapabilities(membership.minCapability())`。任何一台沒宣告就當它是舊版（16.5 MB）。
     */
    minCapability(): MinCapability;
    /** 某台有效成員宣告的備援（SDK ADR 0056）；沒宣告（舊版）或不是成員回 undefined。空陣列＝宣告了「沒有備援」 */
    standbyOf(pubkey: string): string[] | undefined;
    /**
     * 其他有效成員宣告的備援（SDK ADR 0056；不含自己、沒宣告的、被撤銷的），依加入時間排序。
     * 交給 `StandbySuggestions.update({ own, declared })`／`planStandbyAdoption` 算出建議——**只是建議**，由使用者確認才採用。
     */
    declaredStandbys(): DeclaredStandby[];
    /**
     * 某台有效成員的內容範圍（SDK ADR 0058）：輕量成員回它宣告的規則；完整成員（沒宣告、或宣告了 `null`）回 null；
     * 不是成員回 undefined。舊版裝置不會宣告，一律是完整成員。
     */
    scopeOf(pubkey: string): string[] | null | undefined;
    /** 宣告為輕量成員的有效成員（含自己），依加入時間排序。給協調器：`sync.setPeerScopes(sparsePeerScopes(membership))` */
    sparseMembers(): SparseMember[];
    /** 完整成員（沒宣告為輕量的有效成員，含舊版與自己），依加入時間排序：內容的來源 */
    fullMembers(): RosterDevice[];
    /**
     * 所有有效成員（含自己）都在能力宣告裡把 `feature` 設成 true（SDK ADR 0058／0059）。任何一台沒宣告（舊版）就是 false。
     * 例：`sync.setMergeRules(membership.allDeclare(MERGE_RULES_CAPABILITY))`。
     */
    allDeclare(feature: string): boolean;
    /**
     * 宣告這台裝置的能力（SDK ADR 0035 §G9；預設 {@link CURRENT_DEVICE_CAPABILITIES}）。以這台的身分簽章、放進名單，
     * 經 `NostrRosterSync` 送給其他成員。建議每次啟動呼叫一次：內容沒變就不重簽、回 false、不發 `change`。
     */
    declareCapabilities(caps?: DeviceCapabilities): boolean;
    /**
     * 宣告這台的備援中繼（SDK ADR 0056；能力宣告的延伸）。以這台的身分簽章、放進名單，經 `NostrRosterSync` 送給其他成員，
     * 別台據此**建議**使用者加入（不會自動採用）。只宣告分享得出去的：公開的 `wss://`、不帶帳密、不是本機或私有網段，
     * 正規化、去重、最多前 {@link ROSTER_STANDBY_MAX_URLS} 座；其他的照樣留在這台自己的設定，只是不分享。
     * 空陣列也會宣告（「我沒有備援」）。建議每次啟動與備援清單改變時呼叫：內容沒變就不重簽、回 false、不發 `change`。
     */
    declareStandby(urls: readonly string[]): boolean;
    /**
     * 宣告這台是輕量成員、內容範圍是 `patterns`（SDK ADR 0058）；`null`＝完整成員。以這台的身分簽章、放進名單，
     * 經 `NostrRosterSync` 送給其他成員——它們送給這台的版本，範圍外的只帶版本資訊。規則正規化（去空白、空行、註解、去重）；
     * 超過 {@link ROSTER_SPARSE_MAX_PATTERNS} 條、單條超過 {@link ROSTER_SPARSE_MAX_PATTERN_LENGTH} 字或有控制字元丟 `RangeError`。
     * 舊版成員略過這一欄（照樣送完整內容，這台照樣只保存範圍內的）。內容沒變回 false、不重簽、不發 `change`。
     */
    declareSparse(patterns: readonly string[] | null): boolean;
    /**
     * 改這台的名稱（SDK ADR 0069；能力宣告的延伸）。以這台的身分帶時間簽章、放進名單，經 `NostrRosterSync` 送給其他成員，
     * 較晚的蓋過；配對時簽進名單的那一筆不動（舊版成員略過這一欄，照舊顯示配對時的名稱）。名稱照 {@link sanitizeLabel} 清理。
     * 建議每次啟動與使用者改名時呼叫：和目前的名稱一樣就不重簽、回 false、不發 `change`。
     */
    declareLabel(label: string): boolean;
    /**
     * 加入一台裝置（配對成功時由 `PairingSession` 呼叫）。`claim` 是那台裝置自己的簽章（`claimDevice`）。
     * 已經在名單上回 false。
     */
    addDevice(device: {
        pubkey: string;
        deviceId: string;
        label?: string;
        claim: string;
    }): boolean;
    /**
     * 撤銷一台或多台裝置，並輪換共享金鑰。被撤銷的裝置：收不到之後的名單與新金鑰、協調器不再送給它也不再收它的訊息、
     * 從白名單移除；**它已經拿到的內容與舊金鑰無法追回**。不能撤銷自己（請由另一台裝置撤銷）。
     */
    revoke(pubkeys: string | readonly string[]): boolean;
    /** 手動輪換共享金鑰（不撤銷任何裝置） */
    rotateKey(): void;
    /**
     * 合併另一台成員送來的名單。寄件人必須是目前的有效成員、Vault 相同、資料與簽章都合法，否則不動、回 false。
     * 有變動回 true（並發 `change`）。
     */
    merge(data: unknown, from: string): boolean;
}
export {};
//# sourceMappingURL=roster.d.ts.map