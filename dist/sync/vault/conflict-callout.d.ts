import { type Merge3Options } from '../merge3.js';
/** callout 的類型（`> [!conflict]`） */
export declare const CONFLICT_CALLOUT_TYPE = "conflict";
/** 機器可解析的標記：標題行 `%% cinder-conflict:<id> %%`、每個版本 `%% cinder-version:<at>:<device> %%` */
export declare const CONFLICT_CALLOUT_MARKER = "cinder-conflict";
/**
 * 名單能力宣告（SDK ADR 0035 §G9）裡表示「這台開了衝突 callout」的鍵（SDK ADR 0046 §4）。只給 UI 提示用，
 * 不參與模式選擇：`declareCapabilities({ ...CURRENT_DEVICE_CAPABILITIES, [CONFLICT_CALLOUTS_CAPABILITY]: true })`。
 */
export declare const CONFLICT_CALLOUTS_CAPABILITY = "conflictCallouts";
/** 一個 callout 最多放幾個版本（再衝突時會累積；超過就退回衝突副本） */
export declare const CONFLICT_CALLOUT_MAX_VERSIONS = 16;
/** 一個 callout 最多幾行、幾個字元（超過就退回衝突副本） */
export declare const CONFLICT_CALLOUT_MAX_LINES = 2000;
export declare const CONFLICT_CALLOUT_MAX_CHARS: number;
/** callout 裡的一個版本 */
export interface ConflictCalloutVersion {
    /** 裝置名稱（取自版本節點的 `label`） */
    label: string;
    /** 寫入這個版本的裝置（協調器的 deviceId） */
    device: string;
    /** 這個版本的時間（毫秒，混合邏輯時鐘）；callout 裡顯示成 UTC 到分鐘，外掛可轉成本地時間 */
    at: number;
    /** 這個版本在衝突處的行（不含 `> ` 前綴；空陣列＝這個版本把這幾行刪掉了） */
    lines: string[];
}
/** 文件裡的一個衝突 callout */
export interface ConflictCallout {
    /** 穩定的衝突 id（12 位 hex，由版本內容決定） */
    id: string;
    /** 依 `(at, device, 內容)` 排序（舊 → 新） */
    versions: ConflictCalloutVersion[];
    /** callout 的第一行與結束後的下一行（行號從 0 起，`endLine` 不含） */
    startLine: number;
    endLine: number;
    /** 字元位置（`end` 不含；含最後一行的換行） */
    start: number;
    end: number;
}
/**
 * 解決方式：某個版本的索引（`versions[i]`）、`'both-by-time'`（全部留下，依時間排序，舊 → 新）、
 * 或自訂文字（`{ text }`，取代整個 callout）。
 */
export type ConflictCalloutChoice = number | 'both-by-time' | {
    text: string;
};
/** 只有 Markdown（副檔名 `.md`，不分大小寫）用 callout；其他文字檔與二進位照舊衝突副本 */
export declare function isMarkdownPath(path: string): boolean;
/** callout 的格式選項（SDK ADR 0087） */
export interface ConflictCalloutFormat {
    /** callout 後空一行（標題帶旗標）。預設 false＝v0.60 的格式 */
    calloutBreak?: boolean;
}
/** 把版本排好、算 id、產生 callout 的每一行（LF、不含結尾換行；`calloutBreak` 時最後一行是空行） */
export declare function renderConflictCallout(versions: readonly ConflictCalloutVersion[], format?: ConflictCalloutFormat): {
    id: string;
    lines: string[];
};
/**
 * 找出文字裡所有的衝突 callout（SDK ADR 0046）。手動刪掉的 callout 自然不在結果裡（＝已解決）。
 * CRLF 也認得（比對時忽略行尾的 `\r`）。
 */
export declare function parseConflictCallouts(text: string): ConflictCallout[];
/**
 * 解決一個衝突 callout（SDK ADR 0046）：回傳新的全文，由外掛寫回（成為新的本機版本、正常同步）。
 * 找不到 `id`（已經解決或被刪掉）丟例外；索引超出範圍丟 `RangeError`。CRLF 文件維持 CRLF。
 */
export declare function resolveConflictCallout(text: string, id: string, choice: ConflictCalloutChoice): string;
/** 誰寫了某一邊的這幾行（合併的一邊可能是好幾個版本頭合起來的，由呼叫端判斷） */
export type CalloutAuthorOf = (side: 'local' | 'remote', lines: readonly string[]) => Pick<ConflictCalloutVersion, 'label' | 'device' | 'at'>;
/**
 * 三方合併，衝突區塊就地換成 callout（SDK ADR 0046）。做不到（任何一處不安全）回 null，呼叫端退回衝突副本。
 * 純函式：同樣的輸入在每台裝置得到位元組相同的輸出與相同的 callout id。
 * `options.resolve`：先交給衝突解決規則（例如任務勾選框；SDK ADR 0059），解不開的才放進 callout。
 * `options.calloutBreak`：callout 後空一行的新格式（SDK ADR 0087）；呼叫端只在所有版本頭都支援時打開。
 */
export declare function mergeWithConflictCallouts(base: string, local: string, remote: string, authorOf: CalloutAuthorOf, options?: Merge3Options & ConflictCalloutFormat): {
    text: string;
    callouts: string[];
} | null;
//# sourceMappingURL=conflict-callout.d.ts.map