/**
 * 身分：NIP-01 金鑰對、NIP-19 編碼、事件簽章、NIP-44 加解密。包住 nostr-tools 的純函式，私鑰只留在這個物件裡。
 * 私鑰的持久化（Web：WebCrypto 加密進 IndexedDB／NIP-07；桌面：OS Keychain）另外做，這裡不碰儲存。
 */

import * as nip19 from 'nostr-tools/nip19';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
  type VerifiedEvent,
} from 'nostr-tools/pure';

import type { NostrEvent } from './protocol/event.js';
import { type Opened, openWrap, type RecipientLike, type RumorInput, sealAndWrap, type WrapSpec } from './protocol/nip59.js';
import type { NostrSigner } from './protocol/signer.js';

/** 對話金鑰快取的上限（把數） */
const CONVERSATION_KEY_CACHE = 256;

/**
 * `Identity` 實作 `NostrSigner`（SDK ADR 0023）：協定與同步 API 的金鑰參數都可以直接傳它，不必交出私鑰。
 */
export class Identity implements NostrSigner {
  readonly #secretKey: Uint8Array;
  /**
   * 每個對方公鑰一把對話金鑰（NIP-44 的 ECDH 結果），算一次就快取。
   * 有上限（SDK ADR 0023）：`openWrap(event, identity)` 會對每則禮物包的一次性金鑰各算一把，不設限會無限長大。
   */
  readonly #conversationKeys = new Map<string, Uint8Array>();
  /** 64 位 hex 公鑰（事件的 `pubkey` 欄位） */
  readonly pubkey: string;
  /** NIP-19 編碼的公鑰（給人看的） */
  readonly npub: string;

  private constructor(secretKey: Uint8Array) {
    this.#secretKey = secretKey;
    this.pubkey = getPublicKey(secretKey);
    this.npub = nip19.npubEncode(this.pubkey);
  }

  static generate(): Identity {
    return new Identity(generateSecretKey());
  }

  /** 從 `nsec1…` 還原；不是 nsec（含 npub、壞 checksum）就丟例外。 */
  static fromNsec(nsec: string): Identity {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') {
      throw new Error(`不是 nsec：${decoded.type}`);
    }
    return new Identity(decoded.data);
  }

  nsec(): string {
    return nip19.nsecEncode(this.#secretKey);
  }

  /** 補上 pubkey、id 與簽章。 */
  sign(template: EventTemplate): VerifiedEvent {
    return finalizeEvent(template, this.#secretKey);
  }

  /** NIP-44 v2：加密給某個公鑰，只有對方（和自己）解得開。 */
  encryptTo(pubkey: string, plaintext: string): string {
    return encrypt(plaintext, this.#conversationKey(pubkey));
  }

  /** 解開某個公鑰用 NIP-44 加給我的內容；解不開（不是給我的、被改過）就丟例外。 */
  decryptFrom(pubkey: string, payload: string): string {
    return decrypt(payload, this.#conversationKey(pubkey));
  }

  /**
   * NIP-59：rumor → seal（我簽）→ wrap（一次性金鑰簽），只有 `recipient` 拆得開（SDK ADR 0009）。
   * `recipient` 可以是公鑰字串，或 `{ pk: 對方 EK, pq: ML-KEM 公鑰 }`（走後量子混合封裝；ADR 0010）。
   * 中繼只看得到外層的一次性金鑰與 `wrap.tags`，看不出是誰寄的。
   */
  sealAndWrap(rumor: RumorInput, recipient: RecipientLike, wrap: WrapSpec): NostrEvent {
    return sealAndWrap(rumor, this.#secretKey, recipient, wrap);
  }

  /** 拆開封給我的 NIP-59，並驗證寄件人真實性；不是給我的、被改過、偽造的都丟例外。 */
  openWrap(event: NostrEvent): Opened {
    return openWrap(event, this.#secretKey);
  }

  /**
   * 與對方的 NIP-44 對話金鑰（副本）：雙棘輪握手把它混進共享秘密，綁定雙方身分（SDK ADR 0010）。
   * 拿到它能做的事與 `encryptTo`／`decryptFrom` 相同，不是額外交出私鑰。
   */
  conversationKey(pubkey: string): Uint8Array {
    return this.#conversationKey(pubkey).slice();
  }

  #conversationKey(pubkey: string): Uint8Array {
    let key = this.#conversationKeys.get(pubkey);
    if (key === undefined) {
      key = getConversationKey(this.#secretKey, pubkey);
      if (this.#conversationKeys.size >= CONVERSATION_KEY_CACHE) {
        // 丟掉最早放進來的一把（Map 依插入順序）；被丟掉的對象下次再算一次即可
        const oldest = this.#conversationKeys.keys().next().value;
        if (oldest !== undefined) {
          this.#conversationKeys.get(oldest)?.fill(0);
          this.#conversationKeys.delete(oldest);
        }
      }
      this.#conversationKeys.set(pubkey, key);
    }
    return key;
  }
}
