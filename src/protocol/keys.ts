import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";

/** 32-byte secp256k1 私鑰。 */
export type SecretKey = Uint8Array;
/** 32-byte x-only 公鑰的 hex 表示（Nostr pubkey）。 */
export type PubkeyHex = string;

const BECH32_LIMIT = 1000;

/** 產生一把符合 secp256k1 的隨機私鑰（32 bytes）。 */
export function generateSecretKey(): SecretKey {
  return schnorr.utils.randomSecretKey();
}

/** 由私鑰導出 Nostr 公鑰（BIP-340 x-only，hex）。 */
export function getPublicKey(sk: SecretKey): PubkeyHex {
  return bytesToHex(schnorr.getPublicKey(sk));
}

function encodeBech32(prefix: string, data: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(data), BECH32_LIMIT);
}

function decodeBech32(expectedPrefix: string, value: string): Uint8Array {
  const { prefix, words } = bech32.decode(value as `${string}1${string}`, BECH32_LIMIT);
  if (prefix !== expectedPrefix) {
    throw new Error(`bech32 前綴不符：期望 ${expectedPrefix}，實得 ${prefix}`);
  }
  return bech32.fromWords(words);
}

/** 將公鑰（hex）編碼為 NIP-19 `npub`。 */
export function npubEncode(pubkey: PubkeyHex): string {
  return encodeBech32("npub", hexToBytes(pubkey));
}

/** 將 `npub` 解碼回公鑰（hex）。 */
export function npubDecode(npub: string): PubkeyHex {
  return bytesToHex(decodeBech32("npub", npub));
}

/** 將私鑰編碼為 NIP-19 `nsec`。 */
export function nsecEncode(sk: SecretKey): string {
  return encodeBech32("nsec", sk);
}

/** 將 `nsec` 解碼回私鑰（bytes）。 */
export function nsecDecode(nsec: string): SecretKey {
  return decodeBech32("nsec", nsec);
}
