/**
 * 私鑰持久化的接縫：SDK 不碰平台儲存，只定義存放私鑰（nsec）的介面，
 * 各應用自己實作——例如 Web 用 WebCrypto 加密進 IndexedDB、桌面走 OS Keychain。
 * `loadOrCreateIdentity` 是共用邏輯：有就還原、沒有（或壞掉）就產一把新的存回去。
 */
import { Identity } from './identity.js';
export interface SecretStore {
    /** 讀回存著的 nsec；沒有或讀不到回 `null` */
    get(): Promise<string | null>;
    /** 存起這個 nsec（覆蓋舊的） */
    set(nsec: string): Promise<void>;
}
/**
 * 還原持久化的身分；沒有就產一把新的並存回去。存著的值壞掉（不是合法 nsec）也當作沒有，
 * 產新的覆蓋掉——壞掉的條目會自癒，不會每次啟動都失敗。
 */
export declare function loadOrCreateIdentity(store: SecretStore): Promise<Identity>;
//# sourceMappingURL=secret-store.d.ts.map