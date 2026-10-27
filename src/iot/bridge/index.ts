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
import type { NostrSigner } from '../../protocol/signer.js';
import type { RelayEventBudget } from '../../relay-budget.js';
import { RelayPool, type SocketLike } from '../../relay-pool.js';
import { parseIotAcl, type IotAcl, type IotAclInput, type IotAclStore } from '../acl.js';
import { IotClient } from '../client.js';
import type { IotEncoding } from '../content.js';
import { IotGateway, type IotCommandOutcome, type IotGatewayLogEntry, type IotGatewayPushOptions, type IotQueryDispatch } from '../gateway.js';
import { deriveIotHome, type IotHome } from '../keys.js';
import type { IotPushRegistration } from '../push.js';
import { parseIotPushRegistrations, type IotPushStore } from '../push-registry.js';
import type { IotTransport } from '../transport.js';
import type { ResolvedIotBridgeConfig, ResolvedIotClientConfig } from './config.js';
import { compileIotTopicMap, type IotQueryMapEntry, type IotTopicMapEntry } from './mapping.js';

export * from './mapping.js';
export * from './config.js';

/** 只用到的 mqtt.js 客戶端子集（不把 mqtt 的型別寫進我們的 .d.ts：沒裝 mqtt 的使用者也能編譯） */
export interface IotMqttClientLike {
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'message', listener: (topic: string, payload: Uint8Array) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close' | 'offline' | 'reconnect', listener: () => void): unknown;
  subscribe(topics: string[], opts: { qos: 0 | 1 }, callback: (error: Error | null | undefined) => void): unknown;
  publish(topic: string, payload: string | Uint8Array, opts: { qos: 0 | 1; retain?: boolean }, callback: (error?: Error | null) => void): unknown;
  end(force?: boolean, opts?: object, callback?: () => void): unknown;
}

export interface IotMqttConnectOptions {
  username?: string;
  password?: string;
  clientId?: string;
  connectTimeout?: number;
  reconnectPeriod?: number;
}

export type IotMqttConnect = (url: string, opts: IotMqttConnectOptions) => IotMqttClientLike;

/** 載入 mqtt.js（選用 peer 相依）；沒安裝就丟出明確的錯誤 */
export async function loadMqttConnect(importer: () => Promise<unknown> = () => import('mqtt')): Promise<IotMqttConnect> {
  let mod: unknown;
  try {
    mod = await importer();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find (package|module)/.test(String(error))) {
      throw new Error('IoT 橋接器需要 mqtt.js（選用相依）：請執行 npm install mqtt', { cause: error });
    }
    throw error;
  }
  const m = mod as { connect?: unknown; default?: { connect?: unknown } };
  const connect = m.connect ?? m.default?.connect;
  if (typeof connect !== 'function') throw new Error('載入的 mqtt 套件沒有 connect()：請確認安裝的是 mqtt.js（npm install mqtt）');
  return connect as IotMqttConnect;
}

/** 角色名單存成 JSON 檔（先寫暫存檔再換名，寫到一半斷電不會留下壞檔） */
export function fileIotAclStore(path: string): IotAclStore {
  return {
    load: () => (existsSync(path) ? parseIotAcl(JSON.parse(readFileSync(path, 'utf8'))) : undefined),
    save: (acl: IotAcl) => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(acl, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

/**
 * 推播端點清單存成 JSON 檔（ADR 0049 §11.1；先寫暫存檔再換名）。⚠ 內含端點能力（UnifiedPush 網址、登記密鑰），權限 0600、不要提交。
 */
export function fileIotPushStore(path: string, opts: { allowPrivateHttp?: boolean } = {}): IotPushStore {
  return {
    load: () => (existsSync(path) ? parseIotPushRegistrations(JSON.parse(readFileSync(path, 'utf8')), opts) : undefined),
    save: (list: readonly IotPushRegistration[]) => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export interface IotBridgeOptions {
  mqtt: { url: string; username?: string; password?: string; clientId?: string };
  /** 要連的 relay（例如自架站，或官方錨點的 `iot` 車道）；`pool` 有給就不用 */
  relays?: readonly string[];
  /** 自己建好的連線池（測試、或與其他元件共用）；要以閘道身分認證 */
  pool?: IotTransport & { close?(): void };
  /** 閘道的身分 */
  signer: NostrSigner;
  home: IotHome;
  acl?: IotAclInput;
  aclStore?: IotAclStore;
  topicMap: readonly IotTopicMapEntry[];
  queryMap?: readonly IotQueryMapEntry[];
  throttle?: { minIntervalSec?: number; onChangeOnly?: boolean; queryMinIntervalSec?: number };
  heartbeatSec?: number;
  maxSkewSec?: number;
  queryTimeoutMs?: number;
  queryCollectMs?: number;
  retainedDebounceMs?: number;
  budget?: RelayEventBudget;
  /** 推播（ADR 0049 §11.1）：有給才開，閘道收 `$sys/push` 登記並在設備狀態變化時送出空的喚醒 */
  push?: IotGatewayPushOptions;
  /** 測試或自訂：取代 `import('mqtt').connect` */
  mqttConnect?: IotMqttConnect;
  /** 測試或自訂：WebSocket 工廠（預設全域 `WebSocket`；Node 20 沒有時載入 `ws`） */
  createSocket?: (url: string) => SocketLike;
  /** 啟動時等 relay 連上多久（毫秒），預設 10,000；逾時照樣啟動（連線池會自己重連，沒送出的名單與心跳稍後重送） */
  connectTimeoutMs?: number;
  /** MQTT publish 等多久沒回覆算逾時（毫秒），預設 5,000 */
  mqttPublishTimeoutMs?: number;
  onLog?: (entry: IotGatewayLogEntry) => void;
  onError?: (error: unknown) => void;
}

export interface IotBridge {
  readonly gateway: IotGateway;
  readonly pool: IotTransport;
  close(): Promise<void>;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** MQTT 的位元組酬載 → 文字（是合法 UTF-8 時）或 base64 */
function decodePayload(payload: Uint8Array): { payload: string; enc: IotEncoding } {
  try {
    return { payload: utf8.decode(payload), enc: 'utf8' };
  } catch {
    return { payload: Buffer.from(payload).toString('base64'), enc: 'base64' };
  }
}

async function socketFactory(custom: IotBridgeOptions['createSocket']): Promise<((url: string) => SocketLike) | undefined> {
  if (custom) return custom;
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function') return undefined; // RelayPool 預設
  const ws = (await import('ws')) as unknown as { WebSocket: new (url: string) => SocketLike };
  return (url) => new ws.WebSocket(url);
}

/** 等任一座 relay 連上（或逾時） */
function waitForAnyOpen(pool: RelayPool, timeoutMs: number): Promise<void> {
  if ([...pool.status().values()].includes('open')) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    const off = pool.onStatusChange((_url, status) => {
      if (status === 'open') done();
    });
    function done(): void {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

/** 啟動橋接器：連 relay 與本地 broker、訂閱對照表、啟動閘道 */
export async function startIotBridge(opts: IotBridgeOptions): Promise<IotBridge> {
  const map = compileIotTopicMap(opts.topicMap, opts.queryMap ?? []);
  const connect = opts.mqttConnect ?? (await loadMqttConnect());
  let ownPool: RelayPool | undefined;
  let pool: IotTransport & { close?(): void };
  if (opts.pool) pool = opts.pool;
  else {
    if (!opts.relays || opts.relays.length === 0) throw new Error('橋接器至少要連一座 relay（relays）');
    const createSocket = await socketFactory(opts.createSocket);
    ownPool = new RelayPool({ urls: opts.relays, identity: opts.signer as unknown as Pick<Identity, 'sign'>, ...(createSocket ? { createSocket } : {}) });
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
  const publishMqtt = (topic: string, payload: string | Uint8Array): Promise<IotCommandOutcome> =>
    new Promise((resolve) => {
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
        if (!target) return { status: 'unknown-topic' };
        const payload = req.enc === 'base64' ? Buffer.from(req.payload, 'base64') : req.payload;
        return publishMqtt(target.mqtt, payload);
      },
      query: async (device): Promise<IotQueryDispatch> => {
        if (!map.devices.has(device)) return 'unknown-device';
        const queries = map.queries(device);
        if (queries.length === 0) return 'unsupported';
        const results = await Promise.all(queries.map((q) => publishMqtt(q.mqtt, q.payload ?? '')));
        return results.some((r) => r.status === 'ok') ? 'sent' : 'unsupported';
      },
      deviceOf: (topic) => map.deviceOf(topic),
    },
  });

  mqtt.on('message', (mqttTopic, raw) => {
    const up = map.up(mqttTopic);
    if (!up) return;
    const { payload, enc } = decodePayload(raw);
    const online = up.lwt ? (payload === up.lwt.online ? true : payload === up.lwt.offline ? false : undefined) : undefined;
    void gateway
      .reportState({ topic: up.topic, device: up.device, payload, enc, ...(online !== undefined ? { online, will: !online } : {}) })
      .catch((error: unknown) => opts.onError?.(error));
  });
  mqtt.on('error', (error) => opts.onError?.(error));
  // 每次（重新）連上 broker 都重新訂閱（clean session 時 broker 不會記得）
  const subscribed = new Promise<void>((resolve) => {
    mqtt.on('connect', () => {
      mqtt.subscribe([...map.subscriptions], { qos: 1 }, (error) => {
        if (error) opts.onError?.(error);
        resolve();
      });
    });
  });

  await gateway.start();
  await subscribed;
  let closing: Promise<void> | undefined;
  return {
    gateway,
    pool,
    close: () =>
      (closing ??= (async () => {
        await gateway.stop();
        await new Promise<void>((resolve) => mqtt.end(false, {}, () => resolve()));
        ownPool?.close();
      })()),
  };
}

/** 從解析過的設定檔啟動（CLI `cinderous iot bridge` 用） */
export async function startIotBridgeFromConfig(
  config: ResolvedIotBridgeConfig,
  extra: { aclPath: string; pushPath?: string; onLog?: IotBridgeOptions['onLog']; onError?: IotBridgeOptions['onError'] },
): Promise<IotBridge & { gatewayNpub: string; homeTag: string }> {
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
export async function connectIotClient(config: ResolvedIotClientConfig, opts: { createSocket?: (url: string) => SocketLike } = {}): Promise<{ client: IotClient; close(): void }> {
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
