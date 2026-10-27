import type { EventTemplate, NostrEvent } from "./event.js";
import { type PubkeyHex } from "./keys.js";
import { type SecretKeyOrSigner } from "./signer.js";
/** 這把金鑰的公鑰 */
export declare function pubkeyOf(key: SecretKeyOrSigner): PubkeyHex;
/** 補上 pubkey、id 與簽章 */
export declare function signWith(template: EventTemplate, key: SecretKeyOrSigner): NostrEvent;
/** 與 `pk` 的古典 NIP-44 對話金鑰 */
export declare function conversationKeyOf(key: SecretKeyOrSigner, pk: PubkeyHex): Uint8Array;
//# sourceMappingURL=key-ops.d.ts.map