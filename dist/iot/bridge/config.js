// 橋接器與 `iot acl` 的設定檔（SDK ADR 0049 §3；秘密的寫法沿用 ADR 0050 §4：檔案裡只寫 `{ "$env": "NAME" }`）。
// 純函式、零 Node：讀檔與環境變數由呼叫端（CLI）給。
import { hexToBytes } from '@noble/hashes/utils.js';
import { resolveSecret } from '../../deploy/config/secrets.js';
import { isSecretRef } from '../../deploy/config/types.js';
import { nsecEncode } from '../../protocol/keys.js';
import { iotPubkeyOf, parseIotAcl } from '../acl.js';
import { iotHomeSecretBytes } from '../keys.js';
import { iotPushLimits } from '../push.js';
import { clampIot } from '../replay.js';
/** 預設的環境變數名稱 */
export const IOT_ENV = {
    homeSecret: 'IOT_HOME_SECRET',
    gatewayKey: 'IOT_GATEWAY_KEY',
    memberKey: 'IOT_MEMBER_KEY',
    mqttPassword: 'MQTT_PASSWORD',
};
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function relayList(raw, where) {
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((u) => typeof u === 'string' && /^wss?:\/\/\S+$/.test(u))) {
        throw new RangeError(`${where} 要是至少一個 ws:// 或 wss:// 網址`);
    }
    return [...raw];
}
function secret(raw, where, env, defaultEnv, required) {
    if (raw !== undefined && !isSecretRef(raw))
        throw new RangeError(`${where} 是秘密：設定檔裡只能寫 { "$env": "變數名稱" }，值放在環境變數或 .env`);
    const value = resolveSecret(raw, env, defaultEnv);
    if (value === undefined && required)
        throw new RangeError(`缺少 ${where}：請設定環境變數 ${raw?.$env ?? defaultEnv}`);
    return value;
}
/** nsec 或 64 位 hex 私鑰 → nsec */
export function iotNsecOf(value, where) {
    const v = value.trim();
    if (/^nsec1[02-9ac-hj-np-z]+$/.test(v))
        return v;
    if (/^[0-9a-fA-F]{64}$/.test(v))
        return nsecEncode(hexToBytes(v.toLowerCase()));
    throw new RangeError(`${where} 要是 nsec 或 64 位 hex 私鑰`);
}
function optionalNumber(raw, where) {
    if (raw === undefined)
        return undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
        throw new RangeError(`${where} 要是非負數字`);
    return raw;
}
const PUSH_KEYS = ['enabled', 'storeFile', 'maxEndpoints', 'standardPerMinute', 'instantPerMinute', 'registrationTtlSec', 'allowPrivateHttp'];
/** `push` 段：上限以 `IOT_PUSH_LIMITS` 的範圍檢查（超出就拒絕，不默默夾） */
function pushConfig(raw) {
    if (raw === undefined)
        return undefined;
    if (!isObject(raw))
        throw new RangeError('push 要是物件');
    const unknown = Object.keys(raw).filter((k) => !PUSH_KEYS.includes(k));
    if (unknown.length > 0)
        throw new RangeError(`push 不認得的設定：${unknown.join('、')}`);
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
        throw new RangeError('push.enabled 要是 true 或 false');
    if (raw.enabled === false)
        return undefined;
    if (raw.storeFile !== undefined && (typeof raw.storeFile !== 'string' || raw.storeFile.length === 0))
        throw new RangeError('push.storeFile 要是檔名');
    if (raw.allowPrivateHttp !== undefined && typeof raw.allowPrivateHttp !== 'boolean')
        throw new RangeError('push.allowPrivateHttp 要是 true 或 false');
    const numbers = {};
    for (const key of ['maxEndpoints', 'standardPerMinute', 'instantPerMinute', 'registrationTtlSec']) {
        const value = raw[key];
        if (value === undefined)
            continue;
        if (typeof value !== 'number')
            throw new RangeError(`push.${key} 要是整數`);
        numbers[key] = value;
    }
    let limits;
    try {
        limits = iotPushLimits(numbers, { strict: true });
    }
    catch (error) {
        throw new RangeError(`push.${error.message}`);
    }
    return {
        storeFile: raw.storeFile ?? 'iot-push.json',
        limits: { maxEndpoints: limits.maxEndpoints, standardPerMinute: limits.standardPerMinute, instantPerMinute: limits.instantPerMinute, registrationTtlSec: limits.registrationTtlSec },
        allowPrivateHttp: raw.allowPrivateHttp === true,
    };
}
/** 驗證並解析 `iot-bridge.json`；秘密從 `env` 讀。寫錯就丟例外 */
export function resolveIotBridgeConfig(raw, env) {
    if (!isObject(raw))
        throw new RangeError('橋接器設定檔要是 JSON 物件');
    const mqtt = raw.mqtt;
    if (!isObject(mqtt) || typeof mqtt.url !== 'string' || !/^(mqtts?|wss?|tcp|ssl):\/\/\S+$/.test(mqtt.url)) {
        throw new RangeError('mqtt.url 要是 mqtt://、mqtts://、ws:// 或 wss:// 網址');
    }
    if (mqtt.username !== undefined && typeof mqtt.username !== 'string')
        throw new RangeError('mqtt.username 要是字串');
    if (mqtt.clientId !== undefined && typeof mqtt.clientId !== 'string')
        throw new RangeError('mqtt.clientId 要是字串');
    const password = secret(mqtt.password, 'mqtt.password', env, IOT_ENV.mqttPassword, false);
    const homeSecret = iotHomeSecretBytes(secret(raw.homeSecret, 'homeSecret', env, IOT_ENV.homeSecret, true));
    const gatewayNsec = iotNsecOf(secret(raw.gatewayKey, 'gatewayKey', env, IOT_ENV.gatewayKey, true), 'gatewayKey');
    if (!Array.isArray(raw.topicMap))
        throw new RangeError('topicMap 要是陣列');
    if (raw.queryMap !== undefined && !Array.isArray(raw.queryMap))
        throw new RangeError('queryMap 要是陣列');
    if (raw.aclFile !== undefined && (typeof raw.aclFile !== 'string' || raw.aclFile.length === 0))
        throw new RangeError('aclFile 要是檔名');
    const throttle = isObject(raw.throttle) ? raw.throttle : {};
    if (raw.throttle !== undefined && !isObject(raw.throttle))
        throw new RangeError('throttle 要是物件');
    const minIntervalSec = optionalNumber(throttle.minIntervalSec, 'throttle.minIntervalSec');
    if (throttle.onChangeOnly !== undefined && typeof throttle.onChangeOnly !== 'boolean')
        throw new RangeError('throttle.onChangeOnly 要是 true 或 false');
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
        aclFile: raw.aclFile ?? 'iot-acl.json',
        topicMap: raw.topicMap,
        queryMap: raw.queryMap ?? [],
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
export function resolveIotClientConfig(raw, env) {
    if (!isObject(raw))
        throw new RangeError('客戶端設定檔要是 JSON 物件');
    if (typeof raw.gateway !== 'string')
        throw new RangeError('gateway 要是閘道的 npub 或 hex 公鑰');
    return {
        relays: relayList(raw.relays, 'relays'),
        gateway: iotPubkeyOf(raw.gateway),
        homeSecret: iotHomeSecretBytes(secret(raw.homeSecret, 'homeSecret', env, IOT_ENV.homeSecret, true)),
        memberNsec: iotNsecOf(secret(raw.memberKey, 'memberKey', env, IOT_ENV.memberKey, true), 'memberKey'),
    };
}
//# sourceMappingURL=config.js.map