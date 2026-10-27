/**
 * 身分：NIP-01 金鑰對、NIP-19 編碼、事件簽章、NIP-44 加解密。包住 nostr-tools 的純函式，私鑰只留在這個物件裡。
 * 私鑰的持久化（Web：WebCrypto 加密進 IndexedDB／NIP-07；桌面：OS Keychain）另外做，這裡不碰儲存。
 */
import { type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { NostrEvent } from './protocol/event.js';
import { type Opened, type RecipientLike, type RumorInput, type WrapSpec } from './protocol/nip59.js';
import type { NostrSigner } from './protocol/signer.js';
/**
 * `Identity` 實作 `NostrSigner`（SDK ADR 0023）：協定與同步 API 的金鑰參數都可以直接傳它，不必交出私鑰。
 */
export declare class Identity implements NostrSigner {
    #private;
    /** 64 位 hex 公鑰（事件的 `pubkey` 欄位） */
    readonly pubkey: string;
    /** NIP-19 編碼的公鑰（給人看的） */
    readonly npub: string;
    private constructor();
    static generate(): Identity;
    /** 從 `nsec1…` 還原；不是 nsec（含 npub、壞 checksum）就丟例外。 */
    static fromNsec(nsec: string): Identity;
    nsec(): string;
    /** 補上 pubkey、id 與簽章。 */
    sign(template: EventTemplate): VerifiedEvent;
    /** NIP-44 v2：加密給某個公鑰，只有對方（和自己）解得開。 */
    encryptTo(pubkey: string, plaintext: string): string;
    /** 解開某個公鑰用 NIP-44 加給我的內容；解不開（不是給我的、被改過）就丟例外。 */
    decryptFrom(pubkey: string, payload: string): string;
    /**
     * NIP-59：rumor → seal（我簽）→ wrap（一次性金鑰簽），只有 `recipient` 拆得開（SDK ADR 0009）。
     * `recipient` 可以是公鑰字串，或 `{ pk: 對方 EK, pq: ML-KEM 公鑰 }`（走後量子混合封裝；ADR 0010）。
     * 中繼只看得到外層的一次性金鑰與 `wrap.tags`，看不出是誰寄的。
     */
    sealAndWrap(rumor: RumorInput, recipient: RecipientLike, wrap: WrapSpec): NostrEvent;
    /** 拆開封給我的 NIP-59，並驗證寄件人真實性；不是給我的、被改過、偽造的都丟例外。 */
    openWrap(event: NostrEvent): Opened;
    /**
     * 與對方的 NIP-44 對話金鑰（副本）：雙棘輪握手把它混進共享秘密，綁定雙方身分（SDK ADR 0010）。
     * 拿到它能做的事與 `encryptTo`／`decryptFrom` 相同，不是額外交出私鑰。
     */
    conversationKey(pubkey: string): Uint8Array;
}
//# sourceMappingURL=identity.d.ts.map