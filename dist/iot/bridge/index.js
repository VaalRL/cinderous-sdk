/**
 * `@cinderous/client/iot/bridge`（SDK ADR 0049 P0，路線 A）：家中橋接器——連本地 MQTT broker 與**任一** relay，在家做端到端加密，
 * 中繼只看到密文。Node 限定。
 *
 * - mqtt.js 是**選用 peer 相依**（使用者裁示 10）：以動態 `import('mqtt')` 載入，沒安裝時丟出「請執行 npm install mqtt」。
 * - 閘道核心是 `./iot` 的 `IotGateway`（三條路線共用的一份）；這裡只負責 MQTT 那一側與 topic 對照表。
 * - 角色名單只以閘道本地為準（`fileIotAclStore`），只有 owner 能經 `$sys/acl` 修改（使用者裁示 5）。
 * - 不做中繼代發遺囑（使用者裁示 6）：閘道離線＝心跳過期；設備自己的 LWT（例如 Tasmota `tele/<dev>/LWT`）以對照表的 `lwt` 轉成狀態。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Identity } from '../../identity.js';
import { RelayPool } from '../../relay-pool.js';
import { parseIotAcl } from '../acl.js';
import { IotClient } from '../client.js';
import { IotGateway } from '../gateway.js';
import { deriveIotHome } from '../keys.js';
import { parseIotPushRegistrations } from '../push-registry.js';
import { compileIotTopicMap } from './mapping.js';
export * from './mapping.js';
export * from './config.js';
/** 載入 mqtt.js（選用 peer 相依）；沒安裝就丟出明確的錯誤 */
export async function loadMqttConnect(importer = () => import('mqtt')) {
    let mod;
    try {
        mod = await importer();
    }
    catch (error) {
        const code = error.code;
        if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find (package|module)/.test(String(error))) {
            throw new Error('IoT 橋接器需要 mqtt.js（選用相依）：請執行 npm install mqtt', { cause: error });
        }
        throw error;
    }
    const m = mod;
    const connect = m.connect ?? m.default?.connect;
    if (typeof connect !== 'function')
        throw new Error('載入的 mqtt 套件沒有 connect()：請確認安裝的是 mqtt.js（npm install mqtt）');
    return connect;
}
/** 角色名單存成 JSON 檔（先寫暫存檔再換名，寫到一半斷電不會留下壞檔） */
export function fileIotAclStore(path) {
    return {
        load: () => (existsSync(path) ? parseIotAcl(JSON.parse(readFileSync(path, 'utf8'))) : undefined),
        save: (acl) => {
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(acl, null, 2)}\n`, { mode: 0o600 });
            renameSync(tmp, path);
        },
    };
}
/**
 * 推播端點清單存成 JSON 檔（ADR 0049 §11.1；先寫暫存檔再換名）。⚠ 內含端點能力（UnifiedPush 網址、登記密鑰），權限 0600、不要提交。
 */
export function fileIotPushStore(path, opts = {}) {
    return {
        load: () => (existsSync(path) ? parseIotPushRegistrations(JSON.parse(readFileSync(path, 'utf8')), opts) : undefined),
        save: (list) => {
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
            renameSync(tmp, path);
        },
    };
}
const utf8 = new TextDecoder('utf-8', { fatal: true });
/** MQTT 的位元組酬載 → 文字（是合法 UTF-8 時）或 base64 */
function decodePayload(payload) {
    try {
        return { payload: utf8.decode(payload), enc: 'utf8' };
    }
    catch {
        return { payload: Buffer.from(payload).toString('base64'), enc: 'base64' };
    }
}
async function socketFactory(custom) {
    if (custom)
        return custom;
    if (typeof globalThis.WebSocket === 'function')
        return undefined; // RelayPool 預設
    const ws = (await import('ws'));
    return (url) => new ws.WebSocket(url);
}
/** 等任一座 relay 連上（或逾時） */
function waitForAnyOpen(pool, timeoutMs) {
    if ([...pool.status().values()].includes('open'))
        return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        const off = pool.onStatusChange((_url, status) => {
            if (status === 'open')
                done();
        });
        function done() {
            clearTimeout(timer);
            off();
            resolve();
        }
    });
}
/** 啟動橋接器：連 relay 與本地 broker、訂閱對照表、啟動閘道 */
export async function startIotBridge(opts) {
    const map = compileIotTopicMap(opts.topicMap, opts.queryMap ?? []);
    const connect = opts.mqttConnect ?? (await loadMqttConnect());
    let ownPool;
    let pool;
    if (opts.pool)
        pool = opts.pool;
    else {
        if (!opts.relays || opts.relays.length === 0)
            throw new Error('橋接器至少要連一座 relay（relays）');
        const createSocket = await socketFactory(opts.createSocket);
        ownPool = new RelayPool({ urls: opts.relays, identity: opts.signer, ...(createSocket ? { createSocket } : {}) });
        ownPool.connect();
        pool = ownPool;
        await waitForAnyOpen(ownPool, opts.connectTimeoutMs ?? 10_000);
    }
    const mqtt = connect(opts.mqtt.url, {
        ...(opts.mqtt.username !== undefined ? { username: opts.mqtt.username } : {}),
        ...(opts.mqtt.password !== undefined ? { password: opts.mqtt.password } : {}),
        clientId: opts.mqtt.clientId ?? `cinderous-iot-${opts.signer.pubkey.slice(0, 12)}`,
        connectTimeout: 10_000,
        reconnectPeriod: 2_000,
    });
    const publishTimeout = opts.mqttPublishTimeoutMs ?? 5_000;
    const publishMqtt = (topic, payload) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ status: 'timeout', reason: 'mqtt-timeout' }), publishTimeout);
        mqtt.publish(topic, payload, { qos: 1 }, (error) => {
            clearTimeout(timer);
            resolve(error ? { status: 'rejected', reason: 'mqtt-error' } : { status: 'ok' });
        });
    });
    const gateway = new IotGateway({
        pool,
        signer: opts.signer,
        home: opts.home,
        ...(opts.acl !== undefined ? { acl: opts.acl } : {}),
        ...(opts.aclStore ? { aclStore: opts.aclStore } : {}),
        ...(opts.budget ? { budget: opts.budget } : {}),
        ...(opts.heartbeatSec !== undefined ? { heartbeatSec: opts.heartbeatSec } : {}),
        ...(opts.maxSkewSec !== undefined ? { maxSkewSec: opts.maxSkewSec } : {}),
        ...(opts.queryTimeoutMs !== undefined ? { queryTimeoutMs: opts.queryTimeoutMs } : {}),
        ...(opts.queryCollectMs !== undefined ? { queryCollectMs: opts.queryCollectMs } : {}),
        ...(opts.retainedDebounceMs !== undefined ? { retainedDebounceMs: opts.retainedDebounceMs } : {}),
        ...(opts.throttle?.queryMinIntervalSec !== undefined ? { queryMinIntervalSec: opts.throttle.queryMinIntervalSec } : {}),
        throttle: { ...(opts.throttle?.minIntervalSec !== undefined ? { minIntervalSec: opts.throttle.minIntervalSec } : {}), ...(opts.throttle?.onChangeOnly !== undefined ? { onChangeOnly: opts.throttle.onChangeOnly } : {}) },
        ...(opts.push ? { push: opts.push } : {}),
        ...(opts.onLog ? { onLog: opts.onLog } : {}),
        ...(opts.onError ? { onError: opts.onError } : {}),
        handler: {
            command: async (req) => {
                const target = map.down(req.topic);
                if (!target)
                    return { status: 'unknown-topic' };
                const payload = req.enc === 'base64' ? Buffer.from(req.payload, 'base64') : req.payload;
                return publishMqtt(target.mqtt, payload);
            },
            query: async (device) => {
                if (!map.devices.has(device))
                    return 'unknown-device';
                const queries = map.queries(device);
                if (queries.length === 0)
                    return 'unsupported';
                const results = await Promise.all(queries.map((q) => publishMqtt(q.mqtt, q.payload ?? '')));
                return results.some((r) => r.status === 'ok') ? 'sent' : 'unsupported';
            },
            deviceOf: (topic) => map.deviceOf(topic),
        },
    });
    mqtt.on('message', (mqttTopic, raw) => {
        const up = map.up(mqttTopic);
        if (!up)
            return;
        const { payload, enc } = decodePayload(raw);
        const online = up.lwt ? (payload === up.lwt.online ? true : payload === up.lwt.offline ? false : undefined) : undefined;
        void gateway
            .reportState({ topic: up.topic, device: up.device, payload, enc, ...(online !== undefined ? { online, will: !online } : {}) })
            .catch((error) => opts.onError?.(error));
    });
    mqtt.on('error', (error) => opts.onError?.(error));
    // 每次（重新）連上 broker 都重新訂閱（clean session 時 broker 不會記得）
    const subscribed = new Promise((resolve) => {
        mqtt.on('connect', () => {
            mqtt.subscribe([...map.subscriptions], { qos: 1 }, (error) => {
                if (error)
                    opts.onError?.(error);
                resolve();
            });
        });
    });
    await gateway.start();
    await subscribed;
    let closing;
    return {
        gateway,
        pool,
        close: () => (closing ??= (async () => {
            await gateway.stop();
            await new Promise((resolve) => mqtt.end(false, {}, () => resolve()));
            ownPool?.close();
        })()),
    };
}
/** 從解析過的設定檔啟動（CLI `cinderous iot bridge` 用） */
export async function startIotBridgeFromConfig(config, extra) {
    const signer = Identity.fromNsec(config.gatewayNsec);
    const home = deriveIotHome(config.homeSecret);
    const bridge = await startIotBridge({
        mqtt: config.mqtt,
        relays: config.relays,
        signer,
        home,
        ...(config.acl ? { acl: config.acl } : {}),
        aclStore: fileIotAclStore(extra.aclPath),
        topicMap: config.topicMap,
        queryMap: config.queryMap,
        throttle: { ...config.throttle, ...(config.queryMinIntervalSec !== undefined ? { queryMinIntervalSec: config.queryMinIntervalSec } : {}) },
        ...(config.heartbeatSec !== undefined ? { heartbeatSec: config.heartbeatSec } : {}),
        ...(config.maxSkewSec !== undefined ? { maxSkewSec: config.maxSkewSec } : {}),
        ...(config.push
            ? {
                push: {
                    store: fileIotPushStore(extra.pushPath ?? config.push.storeFile, { allowPrivateHttp: config.push.allowPrivateHttp }),
                    limits: config.push.limits,
                    allowPrivateHttp: config.push.allowPrivateHttp,
                },
            }
            : {}),
        ...(extra.onLog ? { onLog: extra.onLog } : {}),
        ...(extra.onError ? { onError: extra.onError } : {}),
    });
    return { ...bridge, gatewayNpub: signer.npub, homeTag: home.homeTag };
}
/** 以成員（owner）身分連上 relay，給 CLI `cinderous iot acl` 用；用完記得 `close()` */
export async function connectIotClient(config, opts = {}) {
    const signer = Identity.fromNsec(config.memberNsec);
    const createSocket = await socketFactory(opts.createSocket);
    const pool = new RelayPool({ urls: config.relays, identity: signer, ...(createSocket ? { createSocket } : {}) });
    pool.connect();
    await waitForAnyOpen(pool, 10_000);
    const client = new IotClient({ pool, signer, home: deriveIotHome(config.homeSecret), gateway: config.gateway });
    return {
        client,
        close: () => {
            client.close();
            pool.close();
        },
    };
}
//# sourceMappingURL=index.js.map