// 橋接器與 `iot acl` 的設定檔（SDK ADR 0049 §3；秘密的寫法沿用 ADR 0050 §4：檔案裡只寫 `{ "$env": "NAME" }`）。
// 純函式、零 Node：讀檔與環境變數由呼叫端（CLI）給。
import { hexToBytes } from '@noble/hashes/utils.js';

import { resolveSecret } from '../../deploy/config/secrets.js';
import { isSecretRef, type SecretRef } from '../../deploy/config/types.js';
import { nsecEncode } from '../../protocol/keys.js';
import { iotPubkeyOf, parseIotAcl, type IotAcl } from '../acl.js';
import { iotHomeSecretBytes } from '../keys.js';
import { iotPushLimits, type IotPushLimits } from '../push.js';
import { clampIot } from '../replay.js';
import type { IotQueryMapEntry, IotTopicMapEntry } from './mapping.js';

/** 預設的環境變數名稱 */
export const IOT_ENV = {
  homeSecret: 'IOT_HOME_SECRET',
  gatewayKey: 'IOT_GATEWAY_KEY',
  memberKey: 'IOT_MEMBER_KEY',
  mqttPassword: 'MQTT_PASSWORD',
} as const;

/** `iot-bridge.json` */
export interface IotBridgeConfigFile {
  mqtt: { url: string; username?: string; password?: SecretRef; clientId?: string };
  relays: string[];
  gatewayKey?: SecretRef;
  homeSecret?: SecretRef;
  /** 初始角色名單（之後以 `$sys/acl` 由 owner 更新，存在 `aclFile`） */
  acl?: unknown;
  /** 角色名單的存檔（相對於設定檔）；預設 `iot-acl.json` */
  aclFile?: string;
  topicMap: IotTopicMapEntry[];
  queryMap?: IotQueryMapEntry[];
  throttle?: { minIntervalSec?: number; onChangeOnly?: boolean; queryMinIntervalSec?: number };
  heartbeatSec?: number;
  maxSkewSec?: number;
  /**
   * 推播（ADR 0049 §11.1；路線 A 由閘道送）：有這一段才開。`storeFile`＝端點清單的存檔（相對於設定檔，預設 `iot-push.json`）；
   * 上限可調（預設每家 32 端點、標準 1／分、即時 6／分、TTL 30 天）；`allowPrivateHttp`＝允許家裡 `http://` 的 ntfy。
   */
  push?: IotBridgePushConfig;
}

export interface IotBridgePushConfig {
  enabled?: boolean;
  storeFile?: string;
  maxEndpoints?: number;
  standardPerMinute?: number;
  instantPerMinute?: number;
  registrationTtlSec?: number;
  allowPrivateHttp?: boolean;
}

/** `iot-client.json`（`cinderous iot acl` 用：owner 自己的身分、家庭秘密、閘道、中繼） */
export interface IotClientConfigFile {
  relays: string[];
  gateway: string;
  homeSecret?: SecretRef;
  memberKey?: SecretRef;
}

export interface ResolvedIotBridgeConfig {
  mqtt: { url: string; username?: string; password?: string; clientId?: string };
  relays: string[];
  /** nsec */
  gatewayNsec: string;
  homeSecret: Uint8Array;
  acl?: IotAcl;
  aclFile: string;
  topicMap: IotTopicMapEntry[];
  queryMap: IotQueryMapEntry[];
  throttle: { minIntervalSec?: number; onChangeOnly?: boolean };
  queryMinIntervalSec?: number;
  heartbeatSec?: number;
  maxSkewSec?: number;
  /** 推播：沒開＝undefined */
  push?: { storeFile: string; limits: Pick<IotPushLimits, 'maxEndpoints' | 'standardPerMinute' | 'instantPerMinute' | 'registrationTtlSec'>; allowPrivateHttp: boolean };
}

export interface ResolvedIotClientConfig {
  relays: string[];
  gateway: string;
  homeSecret: Uint8Array;
  memberNsec: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function relayList(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((u) => typeof u === 'string' && /^wss?:\/\/\S+$/.test(u))) {
    throw new RangeError(`${where} 要是至少一個 ws:// 或 wss:// 網址`);
  }
  return [...raw] as string[];
}

/** 秘密欄位只收 `{ "$env": "NAME" }`；沒寫就讀預設的環境變數 */
function secret(raw: unknown, where: string, env: Readonly<Record<string, string | undefined>>, defaultEnv: string, required: true): string;
function secret(raw: unknown, where: string, env: Readonly<Record<string, string | undefined>>, defaultEnv: string, required: false): string | undefined;
function secret(raw: unknown, where: string, env: Readonly<Record<string, string | undefined>>, defaultEnv: string, required: boolean): string | undefined {
  if (raw !== undefined && !isSecretRef(raw)) throw new RangeError(`${where} 是秘密：設定檔裡只能寫 { "$env": "變數名稱" }，值放在環境變數或 .env`);
  const value = resolveSecret(raw as SecretRef | undefined, env, defaultEnv);
  if (value === undefined && required) throw new RangeError(`缺少 ${where}：請設定環境變數 ${(raw as SecretRef | undefined)?.$env ?? defaultEnv}`);
  return value;
}

/** nsec 或 64 位 hex 私鑰 → nsec */
export function iotNsecOf(value: string, where: string): string {
  const v = value.trim();
  if (/^nsec1[02-9ac-hj-np-z]+$/.test(v)) return v;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return nsecEncode(hexToBytes(v.toLowerCase()));
  throw new RangeError(`${where} 要是 nsec 或 64 位 hex 私鑰`);
}

function optionalNumber(raw: unknown, where: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new RangeError(`${where} 要是非負數字`);
  return raw;
}

const PUSH_KEYS = ['enabled', 'storeFile', 'maxEndpoints', 'standardPerMinute', 'instantPerMinute', 'registrationTtlSec', 'allowPrivateHttp'];

/** `push` 段：上限以 `IOT_PUSH_LIMITS` 的範圍檢查（超出就拒絕，不默默夾） */
function pushConfig(raw: unknown): ResolvedIotBridgeConfig['push'] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new RangeError('push 要是物件');
  const unknown = Object.keys(raw).filter((k) => !PUSH_KEYS.includes(k));
  if (unknown.length > 0) throw new RangeError(`push 不認得的設定：${unknown.join('、')}`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new RangeError('push.enabled 要是 true 或 false');
  if (raw.enabled === false) return undefined;
  if (raw.storeFile !== undefined && (typeof raw.storeFile !== 'string' || raw.storeFile.length === 0)) throw new RangeError('push.storeFile 要是檔名');
  if (raw.allowPrivateHttp !== undefined && typeof raw.allowPrivateHttp !== 'boolean') throw new RangeError('push.allowPrivateHttp 要是 true 或 false');
  const numbers: Record<string, number> = {};
  for (const key of ['maxEndpoints', 'standardPerMinute', 'instantPerMinute', 'registrationTtlSec']) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number') throw new RangeError(`push.${key} 要是整數`);
    numbers[key] = value;
  }
  let limits: IotPushLimits;
  try {
    limits = iotPushLimits(numbers, { strict: true });
  } catch (error) {
    throw new RangeError(`push.${(error as Error).message}`);
  }
  return {
    storeFile: (raw.storeFile as string | undefined) ?? 'iot-push.json',
    limits: { maxEndpoints: limits.maxEndpoints, standardPerMinute: limits.standardPerMinute, instantPerMinute: limits.instantPerMinute, registrationTtlSec: limits.registrationTtlSec },
    allowPrivateHttp: raw.allowPrivateHttp === true,
  };
}

/** 驗證並解析 `iot-bridge.json`；秘密從 `env` 讀。寫錯就丟例外 */
export function resolveIotBridgeConfig(raw: unknown, env: Readonly<Record<string, string | undefined>>): ResolvedIotBridgeConfig {
  if (!isObject(raw)) throw new RangeError('橋接器設定檔要是 JSON 物件');
  const mqtt = raw.mqtt;
  if (!isObject(mqtt) || typeof mqtt.url !== 'string' || !/^(mqtts?|wss?|tcp|ssl):\/\/\S+$/.test(mqtt.url)) {
    throw new RangeError('mqtt.url 要是 mqtt://、mqtts://、ws:// 或 wss:// 網址');
  }
  if (mqtt.username !== undefined && typeof mqtt.username !== 'string') throw new RangeError('mqtt.username 要是字串');
  if (mqtt.clientId !== undefined && typeof mqtt.clientId !== 'string') throw new RangeError('mqtt.clientId 要是字串');
  const password = secret(mqtt.password, 'mqtt.password', env, IOT_ENV.mqttPassword, false);
  const homeSecret = iotHomeSecretBytes(secret(raw.homeSecret, 'homeSecret', env, IOT_ENV.homeSecret, true));
  const gatewayNsec = iotNsecOf(secret(raw.gatewayKey, 'gatewayKey', env, IOT_ENV.gatewayKey, true), 'gatewayKey');
  if (!Array.isArray(raw.topicMap)) throw new RangeError('topicMap 要是陣列');
  if (raw.queryMap !== undefined && !Array.isArray(raw.queryMap)) throw new RangeError('queryMap 要是陣列');
  if (raw.aclFile !== undefined && (typeof raw.aclFile !== 'string' || raw.aclFile.length === 0)) throw new RangeError('aclFile 要是檔名');
  const throttle = isObject(raw.throttle) ? raw.throttle : {};
  if (raw.throttle !== undefined && !isObject(raw.throttle)) throw new RangeError('throttle 要是物件');
  const minIntervalSec = optionalNumber(throttle.minIntervalSec, 'throttle.minIntervalSec');
  if (throttle.onChangeOnly !== undefined && typeof throttle.onChangeOnly !== 'boolean') throw new RangeError('throttle.onChangeOnly 要是 true 或 false');
  const queryMinIntervalSec = optionalNumber(throttle.queryMinIntervalSec, 'throttle.queryMinIntervalSec');
  const heartbeatSec = optionalNumber(raw.heartbeatSec, 'heartbeatSec');
  const maxSkewSec = optionalNumber(raw.maxSkewSec, 'maxSkewSec');
  const push = pushConfig(raw.push);
  return {
    mqtt: {
      url: mqtt.url,
      ...(typeof mqtt.username === 'string' ? { username: mqtt.username } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(typeof mqtt.clientId === 'string' ? { clientId: mqtt.clientId } : {}),
    },
    relays: relayList(raw.relays, 'relays'),
    gatewayNsec,
    homeSecret,
    ...(raw.acl !== undefined ? { acl: parseIotAcl(raw.acl) } : {}),
    aclFile: (raw.aclFile as string | undefined) ?? 'iot-acl.json',
    topicMap: raw.topicMap as IotTopicMapEntry[],
    queryMap: (raw.queryMap as IotQueryMapEntry[] | undefined) ?? [],
    throttle: {
      ...(minIntervalSec !== undefined ? { minIntervalSec } : {}),
      ...(typeof throttle.onChangeOnly === 'boolean' ? { onChangeOnly: throttle.onChangeOnly } : {}),
    },
    ...(queryMinIntervalSec !== undefined ? { queryMinIntervalSec: clampIot(queryMinIntervalSec, 5, 1, 300) } : {}),
    ...(heartbeatSec !== undefined ? { heartbeatSec } : {}),
    ...(maxSkewSec !== undefined ? { maxSkewSec } : {}),
    ...(push ? { push } : {}),
  };
}

/** 驗證並解析 `iot-client.json` */
export function resolveIotClientConfig(raw: unknown, env: Readonly<Record<string, string | undefined>>): ResolvedIotClientConfig {
  if (!isObject(raw)) throw new RangeError('客戶端設定檔要是 JSON 物件');
  if (typeof raw.gateway !== 'string') throw new RangeError('gateway 要是閘道的 npub 或 hex 公鑰');
  return {
    relays: relayList(raw.relays, 'relays'),
    gateway: iotPubkeyOf(raw.gateway),
    homeSecret: iotHomeSecretBytes(secret(raw.homeSecret, 'homeSecret', env, IOT_ENV.homeSecret, true)),
    memberNsec: iotNsecOf(secret(raw.memberKey, 'memberKey', env, IOT_ENV.memberKey, true), 'memberKey'),
  };
}
