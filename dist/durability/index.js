/**
 * `@cinderous/client/durability`（SDK ADR 0041，實作 ADR 0038 P1 的讀回稽核與中繼清單）：
 *
 * - `auditOwnEvents`／`OwnEventAuditor`：逐座以 `#d`／`ids` 查回自己寫過的事件，找出被淘汰的（M4）。
 * - NIP-65（kind 10002）與 NIP-17（kind 10050）中繼清單的建立與解析；由應用決定要不要發布（決策 7）。
 *
 * 獨立子路徑：只用連線池的應用不必載入；零 Node 內建模組、不拉進連線池執行期（只用它的型別）。
 * 健康狀態與 `durability` 發布選項在主入口的 `RelayPool` 上。
 */
export { auditOwnEvents, OwnEventAuditor, } from './audit.js';
export { DM_RELAY_LIST_KIND, dmRelayListTemplate, dmRelaysFor, latestRelayLists, normalizeRelayUrl, outboxRelaysFor, parseDmRelayList, parseRelayList, RELAY_LIST_KIND, relayListFilter, relayListTemplate, relayListWithStandby, } from './relay-lists.js';
//# sourceMappingURL=index.js.map