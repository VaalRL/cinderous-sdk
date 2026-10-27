/**
 * `@cinderous/client/iot/push-gateway`（SDK ADR 0049 §11.1 裁示 3、5、7）：App 開發者的**參考推播閘道**——中立的核心與送出層。
 *
 * - FCM／APNs 憑證只在推播閘道（設備、IoT 閘道、中繼都不持有）；送出端拿到的只有「token 封包＋每次登記獨有密鑰」。
 * - 驗證：解封 token、HMAC 簽章（常數時間比較）、時間戳視窗＋同一登記嚴格遞增（防重放）、到期與撤銷拒絕、每個 token 每分鐘／每小時上限。
 * - 送出：Android＝FCM 高優先**空**資料訊息；iOS＝一般推播＋`mutable-content`，payload 只帶在地化鍵與不透明事件 id（給 NSE 回中繼取）。
 *   送出前一律經 `assertContentlessPushPayload` 守門（SDK ADR 0011 §6 `assertZeroKnowledgePush` 的延伸）。
 * - 兩種部署：Workers 版（`./iot/push-gateway/worker`）與 Node 版（`./iot/push-gateway/node`），**iOS 都直連 APNs**（`PUSH_IOS=apns`，不經 Google；
 *   SDK ADR 0061）。兩版共用請求、provider token 與回應對照，只有傳輸不同：Workers 用 `fetch()`（`fetchApnsTransport`），Node 用 `node:http2`。
 *   v0.48.0 起沒寫 `PUSH_IOS` 就是 `apns`（SDK ADR 0062）；明寫 `PUSH_IOS=fcm`（經 FCM 轉給 APNs）仍可用但兩版都已棄用；只要 Android 設 `PUSH_IOS=off`。
 *
 * 不碰 `node:*`、不含 MQTT；主入口與 `./iot` 不會帶進這裡（守門測試 tests/iot/push-gateway-subpath.test.ts）。
 */
import { apnsCredentialsFromEnv, ApnsSender, fetchApnsTransport, type ApnsTransport } from './apns.js';
import {
  createPushGatewayHandler,
  PUSH_GATEWAY_ENV,
  pushGatewayConfigFromEnv,
  type PushGatewayConfig,
  type PushGatewayLogEntry,
  type PushGatewayStore,
  type PushSender,
} from './core.js';
import { FcmSender, parseFcmServiceAccount } from './fcm.js';

export * from './core.js';
export * from './payload.js';
export * from './fcm.js';
export * from './apns.js';
export { importEs256Key, importRs256Key, pemToDer, signJwt } from './jwt.js';

export interface PushGatewayFromEnvOptions {
  store: PushGatewayStore;
  /** FCM 用的 fetch，Workers 版也拿它直連 APNs（預設全域；測試注入 mock） */
  fetch?: typeof fetch;
  /** 直連 APNs 的傳輸（Node 版注入 `http2ApnsTransport()`；Workers 版沒給就用 `fetchApnsTransport(fetch)`） */
  apnsTransport?: ApnsTransport;
  /** 測試用：換掉 APNs 的位址 */
  apnsOrigin?: string;
  now?: () => number;
  onLog?: (entry: PushGatewayLogEntry) => void;
}

export interface PushGatewayInstance {
  readonly config: PushGatewayConfig;
  readonly handle: (request: Request) => Promise<Response>;
}

/**
 * 從環境變數組出推播閘道：設定、FCM（Android 開著、或 iOS 經 FCM 時需要 `FCM_SERVICE_ACCOUNT`）、APNs（`PUSH_IOS=apns` 時需要 `APNS_*`）。
 * 先匯入私鑰（壞掉就在啟動時失敗）。iOS 仍經 FCM（明寫 `PUSH_IOS=fcm`）時兩版都記一筆 `{ event: 'config', result: 'ios-via-fcm-deprecated' }`（SDK ADR 0062）。
 * 🔴 錯誤訊息與日誌只有變數名稱與代碼。
 */
export async function createPushGatewayFromEnv(env: Readonly<Record<string, string | undefined>>, host: 'worker' | 'node', opts: PushGatewayFromEnvOptions): Promise<PushGatewayInstance> {
  const config = pushGatewayConfigFromEnv(env, host);
  const senders: { fcm?: PushSender; apns?: PushSender } = {};
  if (config.android || config.ios === 'fcm') {
    const raw = env[PUSH_GATEWAY_ENV.fcmServiceAccount];
    if (!raw) throw new Error(`缺少 ${PUSH_GATEWAY_ENV.fcmServiceAccount}（Firebase 服務帳號 JSON；Android 或 iOS 經 FCM 需要）`);
    const fcm = new FcmSender({ account: parseFcmServiceAccount(raw), iosLocKey: config.iosLocKey, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.now ? { now: opts.now } : {}) });
    await fcm.ready();
    senders.fcm = fcm;
  }
  if (config.ios === 'apns') {
    let credentials: ReturnType<typeof apnsCredentialsFromEnv>;
    try {
      credentials = apnsCredentialsFromEnv(env);
    } catch (error) {
      // SDK ADR 0062：沒寫 PUSH_IOS 的舊設定（只設 FCM）升到 v0.48.0 會在這裡失敗——訊息寫明預設值與三種改法（只有變數名稱）
      if (env[PUSH_GATEWAY_ENV.ios]?.trim()) throw error;
      throw new Error(
        `${(error as Error).message}——${PUSH_GATEWAY_ENV.ios} 沒寫時預設是 apns（v0.48.0 起，iOS 直連 APNs）：` +
          `請設 APNS_KEY、APNS_KEY_ID、APNS_TEAM_ID、APNS_TOPIC；只支援 Android 就設 ${PUSH_GATEWAY_ENV.ios}=off；` +
          `仍要經 FCM 就明寫 ${PUSH_GATEWAY_ENV.ios}=fcm（已棄用，Google 看得到 iOS 的喚醒時間點）`,
      );
    }
    const transport = opts.apnsTransport ?? (host === 'worker' ? fetchApnsTransport(opts.fetch ? { fetch: opts.fetch } : {}) : undefined);
    if (!transport) throw new Error('Node 版直連 APNs 需要 HTTP/2 傳輸（http2ApnsTransport；Node 的 fetch 不講 HTTP/2）');
    const apns = new ApnsSender({
      credentials,
      transport,
      iosLocKey: config.iosLocKey,
      ...(opts.apnsOrigin ? { origin: opts.apnsOrigin } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    await apns.ready();
    senders.apns = apns;
  }
  if (config.ios === 'fcm') {
    try {
      opts.onLog?.({ event: 'config', result: 'ios-via-fcm-deprecated' });
    } catch {
      // 日誌失敗不影響啟動
    }
  }
  const handle = createPushGatewayHandler({ config, senders, store: opts.store, ...(opts.now ? { now: opts.now } : {}), ...(opts.onLog ? { onLog: opts.onLog } : {}) });
  return { config, handle };
}
