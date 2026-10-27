/**
 * NIP-65（kind 10002）與 NIP-17（kind 10050）中繼清單的小工具（SDK ADR 0038 決策 7；ADR 0041 §5）。
 *
 * **只建立與解析，不自動發布**：要不要公開自己的中繼清單由應用決定（決策 7）——公開了，別的客戶端找得到你、
 * 也看得到你用哪幾座；不公開比較私密，但別的客戶端只能靠應用自己給的清單。
 *
 * - kind 10002：作者的 write 中繼（別人去哪裡讀你寫的）與 read 中繼（別人標記你時寫到哪裡）。
 *   **備援要事先列上**：事後才臨時改寫到清單外的站，別的裝置找不到（ADR 0038 研究結果四 §5）。
 * - kind 10050：收私訊的中繼。NIP-17：寄件端只發到那些中繼；對方沒公布就不該寄（本工具回 `source: 'none'`，由應用決定）。
 *
 * 產出的是未簽章的範本（`EventTemplate`），用 `signer.sign(template)`（例如 `Identity`）簽。
 */
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { EventTemplate } from '../protocol/event.js';
export declare const RELAY_LIST_KIND = 10002;
export declare const DM_RELAY_LIST_KIND = 10050;
export interface RelayListEntry {
    readonly url: string;
    /** 別人標記我（提到我、回覆我）時寫到這裡 */
    readonly read: boolean;
    /** 我寫的東西放在這裡；別人從這裡讀我 */
    readonly write: boolean;
}
export interface RelayList {
    readonly entries: readonly RelayListEntry[];
    readonly read: readonly string[];
    readonly write: readonly string[];
}
/** 正規化中繼網址：只收 `ws://`／`wss://`，主機小寫、去掉只有 `/` 的路徑與尾端斜線；不合法回 undefined */
export declare function normalizeRelayUrl(raw: string): string | undefined;
/**
 * kind 10002 範本。項目可以只給網址（read＋write），或 `{ url, read, write }`；同一個網址合併、不合法的丟掉。
 * 兩者皆是的不帶標記（NIP-65：沒有標記＝兩者皆是）。
 */
export declare function relayListTemplate(entries: readonly (string | {
    readonly url: string;
    readonly read?: boolean;
    readonly write?: boolean;
})[], opts?: {
    readonly createdAt?: number;
}): EventTemplate;
/**
 * 把主要中繼與備援一起列進 kind 10002（ADR 0038 研究結果四 §5）：兩者都標 write，別的裝置讀你時會合併全部；
 * 備援預設也標 read（`standbyRead: false` 可以只標 write）。
 */
export declare function relayListWithStandby(primary: readonly string[], standby: readonly string[], opts?: {
    readonly standbyRead?: boolean;
    readonly createdAt?: number;
}): EventTemplate;
/** 解析 kind 10002；不是 10002 回 null。不合法的網址略過 */
export declare function parseRelayList(event: Pick<Event, 'kind' | 'tags'>): RelayList | null;
/** kind 10050 範本（收私訊的中繼；NIP-17 建議 1–3 座） */
export declare function dmRelayListTemplate(urls: readonly string[], opts?: {
    readonly createdAt?: number;
}): EventTemplate;
/** 解析 kind 10050；不是 10050 回 null */
export declare function parseDmRelayList(event: Pick<Event, 'kind' | 'tags'>): string[] | null;
/** 查某些人的中繼清單用的 filter（兩種 kind 一起查；可取代事件，每人每種只留最新的） */
export declare function relayListFilter(pubkeys: readonly string[]): Filter;
export interface PublishedRelayLists {
    /** kind 10002（最新的那顆） */
    readonly relayList?: RelayList & {
        readonly createdAt: number;
    };
    /** kind 10050（最新的那顆） */
    readonly dmRelays?: readonly string[];
    readonly dmRelaysCreatedAt?: number;
}
/**
 * 把查回來的 10002／10050 依作者整理，每人每種只留最新的（NIP-01 可取代事件）。
 * 事件要先驗過簽（`RelayPool.query` 已驗）。
 */
export declare function latestRelayLists(events: readonly Pick<Event, 'kind' | 'tags' | 'pubkey' | 'created_at'>[]): Map<string, PublishedRelayLists>;
/**
 * 私訊要寄到對方的哪幾座（NIP-17）：有 10050 用它（`nip17`）；沒有就 `none`——NIP-17 說不該寄，
 * 要不要退回 10002 的 read 中繼（`fallbackToRead: true` → `nip65-read`）或自己的中繼，由應用決定。
 */
export declare function dmRelaysFor(lists: PublishedRelayLists | undefined, opts?: {
    readonly fallbackToRead?: boolean;
}): {
    readonly relays: readonly string[];
    readonly source: 'nip17' | 'nip65-read' | 'none';
};
/** 要讀某位作者寫的東西，去哪幾座（NIP-65 write 中繼；含對方事先列上的備援） */
export declare function outboxRelaysFor(lists: PublishedRelayLists | undefined): readonly string[];
//# sourceMappingURL=relay-lists.d.ts.map