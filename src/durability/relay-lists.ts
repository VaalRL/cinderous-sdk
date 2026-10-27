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

export const RELAY_LIST_KIND = 10_002;
export const DM_RELAY_LIST_KIND = 10_050;

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
export function normalizeRelayUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

function nowSec(createdAt: number | undefined): number {
  return createdAt ?? Math.floor(Date.now() / 1000);
}

/**
 * kind 10002 範本。項目可以只給網址（read＋write），或 `{ url, read, write }`；同一個網址合併、不合法的丟掉。
 * 兩者皆是的不帶標記（NIP-65：沒有標記＝兩者皆是）。
 */
export function relayListTemplate(
  entries: readonly (string | { readonly url: string; readonly read?: boolean; readonly write?: boolean })[],
  opts: { readonly createdAt?: number } = {},
): EventTemplate {
  const merged = new Map<string, { read: boolean; write: boolean }>();
  for (const entry of entries) {
    const e = typeof entry === 'string' ? { url: entry } : entry;
    const url = normalizeRelayUrl(e.url);
    if (url === undefined) continue;
    const read = e.read ?? true;
    const write = e.write ?? true;
    if (!read && !write) continue;
    const prev = merged.get(url);
    merged.set(url, { read: read || (prev?.read ?? false), write: write || (prev?.write ?? false) });
  }
  const tags = [...merged].map(([url, { read, write }]) => (read && write ? ['r', url] : ['r', url, read ? 'read' : 'write']));
  return { kind: RELAY_LIST_KIND, created_at: nowSec(opts.createdAt), tags, content: '' };
}

/**
 * 把主要中繼與備援一起列進 kind 10002（ADR 0038 研究結果四 §5）：兩者都標 write，別的裝置讀你時會合併全部；
 * 備援預設也標 read（`standbyRead: false` 可以只標 write）。
 */
export function relayListWithStandby(
  primary: readonly string[],
  standby: readonly string[],
  opts: { readonly standbyRead?: boolean; readonly createdAt?: number } = {},
): EventTemplate {
  const read = opts.standbyRead ?? true;
  return relayListTemplate(
    [...primary, ...standby.map((url) => ({ url, read, write: true }))],
    opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {},
  );
}

/** 解析 kind 10002；不是 10002 回 null。不合法的網址略過 */
export function parseRelayList(event: Pick<Event, 'kind' | 'tags'>): RelayList | null {
  if (event.kind !== RELAY_LIST_KIND) return null;
  const merged = new Map<string, { read: boolean; write: boolean }>();
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue;
    const url = normalizeRelayUrl(tag[1]);
    if (url === undefined) continue;
    const marker = tag[2];
    const read = marker === undefined || marker === '' || marker === 'read';
    const write = marker === undefined || marker === '' || marker === 'write';
    if (!read && !write) continue;
    const prev = merged.get(url);
    merged.set(url, { read: read || (prev?.read ?? false), write: write || (prev?.write ?? false) });
  }
  const entries = [...merged].map(([url, flags]) => ({ url, ...flags }));
  return {
    entries,
    read: entries.filter((e) => e.read).map((e) => e.url),
    write: entries.filter((e) => e.write).map((e) => e.url),
  };
}

/** kind 10050 範本（收私訊的中繼；NIP-17 建議 1–3 座） */
export function dmRelayListTemplate(urls: readonly string[], opts: { readonly createdAt?: number } = {}): EventTemplate {
  const seen = new Set<string>();
  for (const raw of urls) {
    const url = normalizeRelayUrl(raw);
    if (url !== undefined) seen.add(url);
  }
  return { kind: DM_RELAY_LIST_KIND, created_at: nowSec(opts.createdAt), tags: [...seen].map((url) => ['relay', url]), content: '' };
}

/** 解析 kind 10050；不是 10050 回 null */
export function parseDmRelayList(event: Pick<Event, 'kind' | 'tags'>): string[] | null {
  if (event.kind !== DM_RELAY_LIST_KIND) return null;
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== 'relay' || typeof tag[1] !== 'string') continue;
    const url = normalizeRelayUrl(tag[1]);
    if (url !== undefined) seen.add(url);
  }
  return [...seen];
}

/** 查某些人的中繼清單用的 filter（兩種 kind 一起查；可取代事件，每人每種只留最新的） */
export function relayListFilter(pubkeys: readonly string[]): Filter {
  return { kinds: [RELAY_LIST_KIND, DM_RELAY_LIST_KIND], authors: [...pubkeys] };
}

export interface PublishedRelayLists {
  /** kind 10002（最新的那顆） */
  readonly relayList?: RelayList & { readonly createdAt: number };
  /** kind 10050（最新的那顆） */
  readonly dmRelays?: readonly string[];
  readonly dmRelaysCreatedAt?: number;
}

/**
 * 把查回來的 10002／10050 依作者整理，每人每種只留最新的（NIP-01 可取代事件）。
 * 事件要先驗過簽（`RelayPool.query` 已驗）。
 */
export function latestRelayLists(events: readonly Pick<Event, 'kind' | 'tags' | 'pubkey' | 'created_at'>[]): Map<string, PublishedRelayLists> {
  const newest = new Map<string, Pick<Event, 'kind' | 'tags' | 'pubkey' | 'created_at'>>();
  for (const event of events) {
    if (event.kind !== RELAY_LIST_KIND && event.kind !== DM_RELAY_LIST_KIND) continue;
    const key = `${event.pubkey}:${event.kind}`;
    const prev = newest.get(key);
    if (prev === undefined || event.created_at > prev.created_at) newest.set(key, event);
  }
  const out = new Map<string, PublishedRelayLists>();
  for (const event of newest.values()) {
    const prev = out.get(event.pubkey) ?? {};
    if (event.kind === RELAY_LIST_KIND) {
      out.set(event.pubkey, { ...prev, relayList: { ...parseRelayList(event)!, createdAt: event.created_at } });
    } else {
      out.set(event.pubkey, { ...prev, dmRelays: parseDmRelayList(event)!, dmRelaysCreatedAt: event.created_at });
    }
  }
  return out;
}

/**
 * 私訊要寄到對方的哪幾座（NIP-17）：有 10050 用它（`nip17`）；沒有就 `none`——NIP-17 說不該寄，
 * 要不要退回 10002 的 read 中繼（`fallbackToRead: true` → `nip65-read`）或自己的中繼，由應用決定。
 */
export function dmRelaysFor(
  lists: PublishedRelayLists | undefined,
  opts: { readonly fallbackToRead?: boolean } = {},
): { readonly relays: readonly string[]; readonly source: 'nip17' | 'nip65-read' | 'none' } {
  if (lists?.dmRelays !== undefined && lists.dmRelays.length > 0) return { relays: lists.dmRelays, source: 'nip17' };
  if (opts.fallbackToRead === true && lists?.relayList !== undefined && lists.relayList.read.length > 0) {
    return { relays: lists.relayList.read, source: 'nip65-read' };
  }
  return { relays: [], source: 'none' };
}

/** 要讀某位作者寫的東西，去哪幾座（NIP-65 write 中繼；含對方事先列上的備援） */
export function outboxRelaysFor(lists: PublishedRelayLists | undefined): readonly string[] {
  return lists?.relayList?.write ?? [];
}
