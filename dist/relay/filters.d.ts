import type { NostrEvent } from "../protocol/index.js";
import type { RelayFilter } from "./protocol.js";
/** 判斷事件是否符合單一 filter（NIP-01：欄位間為 AND，陣列內為 OR）。 */
export declare function matchFilter(filter: RelayFilter, event: NostrEvent): boolean;
//# sourceMappingURL=filters.d.ts.map