/**
 * `@cinderous/client/iot/push-gateway/node`（SDK ADR 0049 §11.1 裁示 5）：推播閘道的 **Node 版**。
 *
 * - FCM 與 Workers 版相同（fetch＋WebCrypto RS256）；**iOS 直連 APNs**（`PUSH_IOS=apns`，v0.48.0 起是預設：`node:http2`＋ES256 provider token），不經 Google。
 *   `PUSH_IOS=fcm` 仍可用但已棄用（啟動時記 `ios-via-fcm-deprecated`；SDK ADR 0062）；`PUSH_IOS=off` 只送 Android。
 *   APNs 的請求、provider token 與回應對照與 Workers 版共用（`./apns.js`），只有傳輸不同（SDK ADR 0061）。
 * - 狀態存在記憶體（單一程序）：重啟後只收啟動之後的時間戳（重放不了重啟前的請求）；撤銷紀錄會遺失（封包仍會到期；App 每次停用都會撤銷）。
 * - 憑證只從環境變數讀（`PUSH_GATEWAY_KEY`、`FCM_SERVICE_ACCOUNT`、`APNS_KEY`…），絕不寫檔、不進日誌。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, constants, type ClientHttp2Session } from 'node:http2';

import { type ApnsTransport } from './apns.js';
import { memoryPushGatewayStore, PUSH_GATEWAY_MAX_BODY_BYTES, pushGatewayIosModeFromEnv, type PushGatewayLogEntry } from './core.js';
import { createPushGatewayFromEnv, type PushGatewayInstance } from './index.js';

/**
 * 以 `node:http2` 送 APNs：每個 origin 一條長連線（Apple 建議重用連線），斷了自動重連。
 * `origin` 可以是 `http://`（測試用的 h2c 伺服器）。
 */
export function http2ApnsTransport(opts: { timeoutMs?: number } = {}): ApnsTransport {
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (origin: string): ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(origin);
    s.on('error', () => sessions.delete(origin));
    s.on('close', () => sessions.delete(origin));
    s.unref();
    sessions.set(origin, s);
    return s;
  };
  return {
    post: (origin, path, headers, body) =>
      new Promise((resolve, reject) => {
        const req = session(origin).request({ [constants.HTTP2_HEADER_METHOD]: 'POST', [constants.HTTP2_HEADER_PATH]: path, ...headers });
        const timer = setTimeout(() => {
          req.close(constants.NGHTTP2_CANCEL);
          reject(new Error('timeout'));
        }, opts.timeoutMs ?? 10_000);
        let status = 0;
        let data = '';
        req.setEncoding('utf8');
        req.on('response', (h) => {
          status = Number(h[constants.HTTP2_HEADER_STATUS] ?? 0);
        });
        req.on('data', (chunk: string) => {
          if (data.length < 4096) data += chunk;
        });
        req.on('end', () => {
          clearTimeout(timer);
          resolve({ status, body: data });
        });
        req.on('error', () => {
          clearTimeout(timer);
          reject(new Error('network'));
        });
        req.end(body);
      }),
    close: () => {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}

export interface NodePushGatewayOptions {
  /** 預設 `PORT` 或 8080 */
  port?: number;
  /** 預設 `0.0.0.0` */
  host?: string;
  fetch?: typeof fetch;
  apnsTransport?: ApnsTransport;
  apnsOrigin?: string;
  now?: () => number;
  /** 預設印出 JSON 一行（只有事件與結果代碼） */
  onLog?: (entry: PushGatewayLogEntry) => void;
}

export interface NodePushGateway {
  readonly server: Server;
  readonly url: string;
  readonly pubkey: string;
  readonly instance: PushGatewayInstance;
  close(): Promise<void>;
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request | 'too-large'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > PUSH_GATEWAY_MAX_BODY_BYTES) return 'too-large';
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
  }
  const method = req.method ?? 'GET';
  return new Request(`${origin}${req.url ?? '/'}`, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** 啟動 Node 版推播閘道（Docker 部署包的 `server.mjs` 用它）。設定錯誤在啟動時就丟出（訊息只有變數名稱） */
export async function startNodePushGateway(env: Readonly<Record<string, string | undefined>>, opts: NodePushGatewayOptions = {}): Promise<NodePushGateway> {
  const apnsTransport = opts.apnsTransport ?? (pushGatewayIosModeFromEnv(env) === 'apns' ? http2ApnsTransport() : undefined);
  const instance = await createPushGatewayFromEnv(env, 'node', {
    store: memoryPushGatewayStore(opts.now ? { now: opts.now } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(apnsTransport ? { apnsTransport } : {}),
    ...(opts.apnsOrigin ? { apnsOrigin: opts.apnsOrigin } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    onLog: opts.onLog ?? ((entry) => console.log(JSON.stringify(entry))),
  });
  const server = createServer((req, res) => {
    void (async () => {
      const request = await toRequest(req, 'http://push-gateway.local');
      if (request === 'too-large') {
        res.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":"too-large"}');
        return;
      }
      await writeResponse(res, await instance.handle(request));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"internal"}');
    });
  });
  const port = opts.port ?? (env.PORT ? Number(env.PORT) : 8080);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host ?? '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    url: `http://127.0.0.1:${actualPort}`,
    pubkey: instance.config.pubkey,
    instance,
    close: () =>
      new Promise<void>((resolve) => {
        apnsTransport?.close?.();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
