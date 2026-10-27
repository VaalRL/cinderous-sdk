// 家庭金鑰衍生與 topic 盲化（SDK ADR 0049 §2.1）。純函式、零 Node 內建模組，固定測試向量見 tests/iot/keys.test.ts。
//
//   homeKey   = HKDF-SHA256(homeSecret, salt="", info="cinder-iot/v1/enc", 32)      → secp256k1 私鑰；公鑰 homePub 是所有 IoT 內容的 NIP-44 收件者
//   topicKey  = HKDF-SHA256(homeSecret, salt="", info="cinder-iot/v1/topic", 32)    → 盲化用的 HMAC 金鑰
//   homeTag   = blind("home")
//   blind(s)  = base64url(HMAC-SHA256(topicKey, s)) 取前 22 字元（約 128 位元）
//   deviceKey = HKDF-SHA256(homeSecret, salt="", info="cinder-iot/v1/device-key|<id>|<epoch>", 32)（路線 C 的 E2EE 設備金鑰，§2.6；P0 只提供衍生）
//
// ADR 只對 deviceKey 寫明 salt=""；homeKey／topicKey 沿用同一個約定（HKDF 的空 salt＝32 個零位元組，RFC 5869 §2.2）。
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';

import { getPublicKey, type PubkeyHex, type SecretKey } from '../protocol/keys.js';

/** 家庭秘密的長度（bytes） */
export const IOT_HOME_SECRET_BYTES = 32;
/** 盲化結果的長度（base64url 字元） */
export const IOT_BLIND_LENGTH = 22;

const EMPTY_SALT = new Uint8Array(0);
const INFO_ENC = 'cinder-iot/v1/enc';
const INFO_TOPIC = 'cinder-iot/v1/topic';
const INFO_DEVICE = 'cinder-iot/v1/device-key';

/** 家庭秘密衍生出來的一切（{@link deriveIotHome}） */
export interface IotHome {
  /** 所有 IoT 內容的 NIP-44 收件者私鑰（成員與閘道都持有；任何成員都能以它 × 寄件人公鑰解密） */
  readonly homeKey: SecretKey;
  /** `homeKey` 的公鑰（公開值）：加密給全家只需要寄件人自己的私鑰與它 */
  readonly homePub: PubkeyHex;
  /** 盲化用的 HMAC 金鑰 */
  readonly topicKey: Uint8Array;
  /** 家的路由標籤（`h`）＝`blind("home")` */
  readonly homeTag: string;
  /** 盲化任意字串（topic、`dev:<id>`、`gw`、`sys:acl`…） */
  blind(value: string): string;
  /** 路線 C 的設備金鑰（ADR 0049 §2.6；P0 只提供衍生，信封在 P2） */
  deviceKey(deviceId: string, epoch?: number): Uint8Array;
}

/** 把家庭秘密（32 bytes 或 64 位 hex）正規化成位元組；長度不對就丟例外 */
export function iotHomeSecretBytes(secret: Uint8Array | string): Uint8Array {
  const bytes = typeof secret === 'string' ? (/^[0-9a-fA-F]{64}$/.test(secret.trim()) ? hexToBytes(secret.trim().toLowerCase()) : undefined) : secret;
  if (bytes === undefined || bytes.length !== IOT_HOME_SECRET_BYTES) throw new RangeError(`家庭秘密必須是 ${IOT_HOME_SECRET_BYTES} bytes（64 位 hex）`);
  return bytes;
}

/** 以 topicKey 盲化：`base64url(HMAC-SHA256(topicKey, value))` 取前 22 字元 */
export function blindWith(topicKey: Uint8Array, value: string): string {
  return base64urlnopad.encode(hmac(sha256, topicKey, utf8ToBytes(value))).slice(0, IOT_BLIND_LENGTH);
}

/** 從家庭秘密導出設備金鑰（ADR 0049 §2.1、§2.6） */
export function deriveIotDeviceKey(homeSecret: Uint8Array | string, deviceId: string, epoch = 0): Uint8Array {
  if (!Number.isInteger(epoch) || epoch < 0) throw new RangeError(`epoch 必須是非負整數（收到 ${String(epoch)}）`);
  return hkdf(sha256, iotHomeSecretBytes(homeSecret), EMPTY_SALT, utf8ToBytes(`${INFO_DEVICE}|${deviceId}|${epoch}`), 32);
}

/** 從家庭秘密導出 `homeKey`、`homePub`、`topicKey`、`homeTag`（純函式、可測向量） */
export function deriveIotHome(homeSecret: Uint8Array | string): IotHome {
  const secret = iotHomeSecretBytes(homeSecret);
  const homeKey = hkdf(sha256, secret, EMPTY_SALT, utf8ToBytes(INFO_ENC), 32);
  // HKDF 輸出不是合法純量的機率約 2^-128；真的遇到就拒絕（換一個家庭秘密），不默默改寫
  if (!secp256k1.utils.isValidSecretKey(homeKey)) throw new RangeError('這個家庭秘密導出的 homeKey 不是合法的 secp256k1 私鑰，請換一個家庭秘密');
  const topicKey = hkdf(sha256, secret, EMPTY_SALT, utf8ToBytes(INFO_TOPIC), 32);
  const homePub = getPublicKey(homeKey);
  const blind = (value: string): string => blindWith(topicKey, value);
  return {
    homeKey,
    homePub,
    topicKey,
    homeTag: blind('home'),
    blind,
    deviceKey: (deviceId: string, epoch = 0) => deriveIotDeviceKey(secret, deviceId, epoch),
  };
}

/** 盲化的保留名稱（ADR 0049 §2.2、§2.5） */
export const iotBlindNames = {
  device: (deviceId: string): string => `dev:${deviceId}`,
  devicePart: (deviceId: string, part: number): string => (part === 0 ? `dev:${deviceId}` : `dev:${deviceId}|${part}`),
  gateway: 'gw',
  acl: 'sys:acl',
} as const;

/** 新的家庭秘密（64 位 hex；CLI `iot keygen` 用） */
export function generateIotHomeSecret(): string {
  return bytesToHex(randomBytes(IOT_HOME_SECRET_BYTES));
}
