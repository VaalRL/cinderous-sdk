import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
const BECH32_LIMIT = 1000;
/** 產生一把符合 secp256k1 的隨機私鑰（32 bytes）。 */
export function generateSecretKey() {
    return schnorr.utils.randomSecretKey();
}
/** 由私鑰導出 Nostr 公鑰（BIP-340 x-only，hex）。 */
export function getPublicKey(sk) {
    return bytesToHex(schnorr.getPublicKey(sk));
}
function encodeBech32(prefix, data) {
    return bech32.encode(prefix, bech32.toWords(data), BECH32_LIMIT);
}
function decodeBech32(expectedPrefix, value) {
    const { prefix, words } = bech32.decode(value, BECH32_LIMIT);
    if (prefix !== expectedPrefix) {
        throw new Error(`bech32 前綴不符：期望 ${expectedPrefix}，實得 ${prefix}`);
    }
    return bech32.fromWords(words);
}
/** 將公鑰（hex）編碼為 NIP-19 `npub`。 */
export function npubEncode(pubkey) {
    return encodeBech32("npub", hexToBytes(pubkey));
}
/** 將 `npub` 解碼回公鑰（hex）。 */
export function npubDecode(npub) {
    return bytesToHex(decodeBech32("npub", npub));
}
/** 將私鑰編碼為 NIP-19 `nsec`。 */
export function nsecEncode(sk) {
    return encodeBech32("nsec", sk);
}
/** 將 `nsec` 解碼回私鑰（bytes）。 */
export function nsecDecode(nsec) {
    return decodeBech32("nsec", nsec);
}
//# sourceMappingURL=keys.js.map