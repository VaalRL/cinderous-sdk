/**
 * `@cinderous/client/iot/push-gateway/worker`（SDK ADR 0049 §11.1 裁示 5）：推播閘道的 **Workers 版**。
 *
 * - 送出：Android＝FCM HTTP v1（`fetch`＋WebCrypto RS256）；**iOS＝直連 APNs**（`PUSH_IOS=apns`：一般 `fetch()`＋ES256 provider token，
 *   Cloudflare 邊緣代為講 HTTP/2——ADR 0049 §11 實測；SDK ADR 0061），不經 Google。本機 `wrangler dev` 連不上 APNs（`Network connection lost`），只能部署後驗證。
 * - v0.48.0 起沒寫 `PUSH_IOS` 就是 `apns`（SDK ADR 0062）：只設 FCM 的舊部署要補 APNs 設定，或明寫 `PUSH_IOS=off`（只送 Android）／
 *   `PUSH_IOS=fcm`（iOS 經 FCM 轉給 APNs，Google 看得到 iOS 的喚醒時間點——**已棄用**，啟動時記一筆 `ios-via-fcm-deprecated`）。
 * - 狀態（防重放、撤銷、每個 token 的上限）：每個 token 一顆 Durable Object（`PUSH_STATE`，SQLite 型，免費方案可用），
 *   每次喚醒＝1 個 Worker 請求＋1 個 DO 請求＋1 個對 Apple 或 1～2 個對 Google 的子請求（APNs provider token 與 OAuth token 都在 isolate 內快取）。
 * - 秘密只從 Worker secret 讀：`PUSH_GATEWAY_KEY`、`APNS_KEY`（直連 APNs）、`FCM_SERVICE_ACCOUNT`（Android 或 iOS 經 FCM）；
 *   上限與選項（含 `APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_TOPIC`、`APNS_ENV`）是一般變數（`[vars]`）。
 *
 * 這個檔不依賴 `@cloudflare/workers-types`（只用到的那一小部分以結構型別宣告），也不碰 `node:*`。
 */
import {
  admitPushWake,
  revokePushRegistration,
  type PushAdmitRequest,
  type PushAdmitVerdict,
  type PushGatewayLimits,
  type PushGatewayStore,
  type PushTokenState,
} from './core.js';
import { createPushGatewayFromEnv, type PushGatewayInstance } from './index.js';

/** Durable Object 命名空間（只用到的部分） */
export interface PushStateNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** Durable Object 的儲存（只用到的部分） */
export interface PushStateStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface PushGatewayWorkerEnv {
  PUSH_STATE: PushStateNamespaceLike;
  PUSH_GATEWAY_KEY?: string;
  FCM_SERVICE_ACCOUNT?: string;
  /** 直連 APNs：.p8 的內容（secret） */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  APNS_ENV?: string;
  [name: string]: unknown;
}

/** DO 的綁定名稱與類別名稱（wrangler.toml 的 `[[durable_objects.bindings]]`） */
export const PUSH_STATE_BINDING = { name: 'PUSH_STATE', className: 'PushGatewayState' } as const;
/** DO 的遷移（只能附加） */
export const PUSH_STATE_MIGRATIONS: readonly { tag: string; newSqliteClasses: readonly string[] }[] = [{ tag: 'push-v1', newSqliteClasses: ['PushGatewayState'] }];

/** 以 DO 保存狀態：每個 token 一顆（`idFromName(tokenKey)`），DO 內部的處理是一次一個 */
export function durableObjectPushStore(namespace: PushStateNamespaceLike): PushGatewayStore {
  const call = async <T>(op: 'admit' | 'revoke', req: PushAdmitRequest, limits?: PushGatewayLimits): Promise<T> => {
    const stub = namespace.get(namespace.idFromName(req.tokenKey));
    const res = await stub.fetch('https://push-state/op', { method: 'POST', body: JSON.stringify({ op, req, limits }) });
    if (!res.ok) throw new Error(`push-state-${res.status}`);
    return (await res.json()) as T;
  };
  return {
    admit: (req, limits) => call<PushAdmitVerdict>('admit', req, limits),
    revoke: (req) => call<'ok' | 'replay' | 'busy'>('revoke', req),
  };
}

/** 一個 token 的狀態（Durable Object）。只收 Worker 自己的內部呼叫（DO 沒有對外路由） */
export class PushGatewayState {
  readonly #storage: PushStateStorageLike;
  #state: PushTokenState | undefined;

  constructor(ctx: { storage: PushStateStorageLike }, _env?: unknown) {
    this.#storage = ctx.storage;
  }

  async fetch(request: Request): Promise<Response> {
    let input: { op?: unknown; req?: PushAdmitRequest; limits?: PushGatewayLimits };
    try {
      input = (await request.json()) as typeof input;
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const req = input.req;
    if (!req || typeof req.regId !== 'string' || !Number.isSafeInteger(req.ts) || !Number.isSafeInteger(req.now) || !Number.isSafeInteger(req.exp)) {
      return new Response('bad request', { status: 400 });
    }
    // 輸入閘（input gate）讓「讀 → 算 → 寫」在這顆 DO 裡不會交錯
    this.#state ??= (await this.#storage.get<PushTokenState>('s')) ?? { hits: [], regs: {} };
    let out: unknown;
    if (input.op === 'admit' && input.limits) out = admitPushWake(this.#state, req, input.limits);
    else if (input.op === 'revoke') out = revokePushRegistration(this.#state, req);
    else return new Response('bad request', { status: 400 });
    await this.#storage.put('s', this.#state);
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  }
}

/** isolate 內的快取：同一份 env 只組一次（含 OAuth token 與 APNs provider token 的快取）；設定壞掉就回 503，錯誤訊息只有變數名稱 */
const instances = new WeakMap<object, Promise<PushGatewayInstance>>();

function envStrings(env: PushGatewayWorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

export default {
  async fetch(request: Request, env: PushGatewayWorkerEnv): Promise<Response> {
    let pending = instances.get(env);
    if (!pending) {
      pending = createPushGatewayFromEnv(envStrings(env), 'worker', {
        store: durableObjectPushStore(env.PUSH_STATE),
        onLog: (entry) => console.log(JSON.stringify(entry)),
      });
      instances.set(env, pending);
    }
    let instance: PushGatewayInstance;
    try {
      instance = await pending;
    } catch (error) {
      instances.delete(env);
      console.error(JSON.stringify({ event: 'config', result: error instanceof Error ? error.message : 'invalid' }));
      return new Response(JSON.stringify({ error: 'not-configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    return instance.handle(request);
  },
};
