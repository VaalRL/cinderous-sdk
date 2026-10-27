// 公共 TURN 短期憑證抓取（ADR-0243）：一般使用者的 WebRTC TURN 保底。
//
// Cloudflare TURN 用**短期憑證**（非靜態帳密）——由 relay Worker 的 `/turn` 端點以 secret
// 換發（見 relay/src/worker.ts），餵進 `buildRtcConfig` 既有的 `turnServers`
// （沿用企業 TURN 的注入點，Fix-First 不另闢路徑）。
//
// ## ⓪ 刷新排程必須跟著 TTL（ADR-0342 §2）
//
// 🔴 這個檔頭原本寫「到期前刷新」，但**呼叫端是寫死 6 小時**的，而且回應根本沒有 ttl 欄位
// ——客戶端無從得知憑證多久過期。站方把 TTL 縮短（ADR-0336 §3.1）之後，憑證在客戶端
// 不知情的情況下過期，TURN 形同失效。⇒ Worker 現在會回傳 `ttl`，呼叫端依它排程。
//
// ## 需要簽章（ADR-0342 §3.2）
//
// `/turn` 現在要求 NIP-98 風格的授權標頭，未帶回 **401**。所以這裡要拿到身分金鑰才能抓。
//
// **未設定即 no-op**：Worker 未配 secret 時 `/turn` 回 204 → 這裡回 `[]` → 退回純 STUN，
// 不壞任何東西。任何網路/解析失敗同樣回 `[]`——TURN 只是保底，抓不到不能拖垮通話建立。

import type { EventTemplate, NostrEvent } from "./event.js";
import { buildHttpAuthEvent, httpAuthHeader, httpAuthTemplate } from "./http-auth.js";
import type { SecretKey } from "./keys.js";

/**
 * ICE 伺服器（SDK ADR 0017）：與 DOM 的 `RTCIceServer` 相容，但不依賴 DOM 型別
 * ——這個檔也會被 Worker 與 Node 的型別檢查讀到，那兩個環境沒有 DOM。
 */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * 簽 NIP-98 授權的人（SDK ADR 0017）：可以直接給私鑰（Cinderous 原本的呼叫方式），
 * 也可以給任何會簽章的物件（SDK 的 `Identity` 不交出私鑰）。
 */
export type TurnSigner = SecretKey | { sign(template: EventTemplate): NostrEvent };

function signHttpAuth(url: string, signer: TurnSigner): NostrEvent {
  return signer instanceof Uint8Array ? buildHttpAuthEvent(url, "GET", signer) : signer.sign(httpAuthTemplate(url, "GET"));
}

/** ICE URL 合法 scheme（防端點回應被竄改注入 http/js 之類）。 */
const ICE_SCHEME = /^(stun|turn|turns):/i;

/** 注入用的最小 fetch 介面（避開 DOM/node fetch 型別差異，測試好替身）。 */
export interface TurnHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type TurnFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<TurnHttpResponse>;

/** 抓取結果：伺服器清單＋憑證有效秒數（供呼叫端排程刷新）。 */
export interface TurnResult {
  servers: IceServer[];
  /** Worker 回報的憑證有效秒數；缺席＝舊版 Worker（見 `TURN_TTL_FALLBACK_SEC`）。 */
  ttlSeconds?: number;
}

/**
 * `ttl` 缺席時的退路（ADR-0342 §2）。
 *
 * 舊版 Worker 用的是 86400（1 天），1 小時對它非常安全。**刻意不用更短的值**
 * ——那會在正常情況下浪費請求並吃掉速率限制配額。
 */
export const TURN_TTL_FALLBACK_SEC = 3600;

const defaultFetch: TurnFetch = (url, init) =>
  (globalThis.fetch as unknown as TurnFetch)(url, init);

/**
 * 正規化 Cloudflare `/turn` 回應為 `IceServer[]`。回應的 `iceServers` 可能是單一物件
 * 或陣列；只保留 urls 為合法 ICE scheme 的條目，帳密原樣帶過。任何畸形 → `[]`。
 */
export function parseTurnResponse(json: unknown): IceServer[] {
  if (!json || typeof json !== "object") return [];
  const ice = (json as { iceServers?: unknown }).iceServers;
  const list = Array.isArray(ice) ? ice : ice && typeof ice === "object" ? [ice] : [];
  const out: IceServer[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const rawUrls = (entry as { urls?: unknown }).urls;
    const urls = (Array.isArray(rawUrls) ? rawUrls : [rawUrls]).filter(
      (u): u is string => typeof u === "string" && ICE_SCHEME.test(u),
    );
    if (urls.length === 0) continue;
    const server: IceServer = { urls };
    const username = (entry as { username?: unknown }).username;
    const credential = (entry as { credential?: unknown }).credential;
    if (typeof username === "string") server.username = username;
    if (typeof credential === "string") server.credential = credential;
    out.push(server);
  }
  return out;
}

/** 取出 Worker 回報的憑證有效秒數（ADR-0342 §2）；缺席或畸形 → undefined。 */
export function parseTurnTtl(json: unknown): number | undefined {
  if (!json || typeof json !== "object") return undefined;
  const ttl = (json as { ttl?: unknown }).ttl;
  return typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : undefined;
}

/**
 * 從 relay 的 `/turn` 端點抓短期 TURN 憑證。任何失敗/未設定 → 空清單（no-op，退回純 STUN）。
 *
 * ⚠ **401 也是空清單**：那代表本端沒帶或帶錯授權（ADR-0342 §3.2）。仍然不報錯——
 * TURN 是保底，拿不到就純 STUN，不該拖垮通話建立。
 */
export async function fetchTurnServers(
  endpoint: string,
  sk: TurnSigner,
  fetchFn: TurnFetch = defaultFetch,
): Promise<TurnResult> {
  try {
    const auth = httpAuthHeader(signHttpAuth(endpoint, sk));
    const res = await fetchFn(endpoint, { method: "GET", headers: { Authorization: auth } });
    if (res.status === 204 || !res.ok) return { servers: [] }; // 204＝未配 secret；401＝授權問題；其餘＝故障
    const json = await res.json();
    const ttl = parseTurnTtl(json);
    return { servers: parseTurnResponse(json), ...(ttl !== undefined ? { ttlSeconds: ttl } : {}) };
  } catch {
    return { servers: [] }; // 離線/DNS/解析失敗——TURN 是保底，抓不到不拖垮通話
  }
}

/**
 * 下次刷新要等多久（毫秒）。**半個 TTL**，夾在 [60s, 6h]。
 *
 * 下限防止極短 TTL 把客戶端變成打樁機（也會撞上速率限制）；
 * 上限維持舊行為的節奏，避免憑證長效時無謂地常刷。
 */
export function turnRefreshDelayMs(ttlSeconds: number | undefined): number {
  const ttl = ttlSeconds ?? TURN_TTL_FALLBACK_SEC;
  return Math.min(6 * 3600_000, Math.max(60_000, Math.floor((ttl / 2) * 1000)));
}

/** 由 relay URL（`wss://host`）推導其 `/turn` 端點（`https://host/turn`）。非 ws(s) → undefined。 */
export function turnEndpointFromRelay(relayUrl: string | undefined): string | undefined {
  const u = relayUrl?.trim();
  if (!u || !/^wss?:\/\//i.test(u)) return undefined;
  try {
    const parsed = new URL(u);
    const scheme = parsed.protocol.toLowerCase() === "wss:" ? "https:" : "http:";
    return `${scheme}//${parsed.host.toLowerCase()}/turn`;
  } catch {
    return undefined;
  }
}

/**
 * TURN 端點的候選序列（ADR-0356 §6）。
 *
 * ## 🔴 為什麼需要「後備」而不是單一端點
 *
 * `/turn` 端點原本**只從 home 推導**。ADR-0356 讓使用者能一鍵部署自己的 relay，而自架的
 * 節點**不帶 TURN 設定**（那是官方站的 key，不該跟著別人的節點跑）⇒ 它的 `/turn` 恆回 204
 * ⇒ 客戶端退回純 STUN ⇒ **部署自有節點會順手把通話保底關掉**。
 *
 * 使用者不會把這兩件事連起來。他只會發現「自從我建了自己的節點，某些人就打不通了」。
 * 這是 ADR-0342 §3.4「加一個功能、順手弄壞另一個」的同款形狀，所以修在同一份 ADR 裡。
 *
 * ## 順序的意思
 *
 * home 先試——那是他自己的站，用它最不需要解釋。home 給不出來才依序問錨點。
 *
 * ⚠ `explicit`（企業 `turnEndpoint`）存在時**只用它、不後備**：那是站方明確指定的端點，
 * 自作主張去問錨點等於把企業流量送給第三方。
 */
export function turnEndpointCandidates(
  homeUrl: string | undefined,
  anchors: readonly string[] = [],
  explicit?: string,
  opts: { enterprise?: boolean } = {},
): string[] {
  if (explicit) return [explicit];
  // 🔴 企業身分**不後備到公共錨點**。自架封閉節點的意義就是流量不出自己的基礎設施；
  // 為了通話保底去問公共錨點要憑證，等於把「這台裝置在講話」告訴第三方。
  //
  // 今天這條在實務上不會被踩到，因為兩個 app 都只在非企業分支傳 `anchors`
  // （`App.tsx` 與 `apps/mobile/src/backend.ts`）。但那是**兩個檔案剛好沒傳**，
  // 不是做決定的這一層在擋——哪天有人為了開機韌性替企業分支補上 anchors，
  // 企業客戶端就會靜默開始跟公共錨點講話，而且不會有任何測試變紅。
  if (opts.enterprise) {
    const own = turnEndpointFromRelay(homeUrl);
    return own ? [own] : [];
  }
  const out: string[] = [];
  for (const url of [homeUrl, ...anchors]) {
    const ep = turnEndpointFromRelay(url);
    if (ep && !out.includes(ep)) out.push(ep);
  }
  return out;
}

/** 後備抓取的結果：多帶一個「是誰給的」供診斷。 */
export interface TurnFallbackResult extends TurnResult {
  /** 真正給出憑證的端點；全部沒給就是 undefined。 */
  endpoint?: string;
}

/**
 * 依序問每個候選端點，**第一個給得出伺服器的就用它**。
 *
 * 全部都給不出來時回空清單——與過去單一端點抓不到時的行為相同（退回純 STUN），
 * 所以這個改動對「home 本來就有 TURN」的使用者是零變化。
 */
export async function fetchTurnWithFallback(
  endpoints: readonly string[],
  sk: TurnSigner,
  fetchFn: TurnFetch = defaultFetch,
): Promise<TurnFallbackResult> {
  for (const endpoint of endpoints) {
    // eslint-disable-next-line no-await-in-loop -- 刻意序列：第一個成功就停，不對每個錨點都發請求
    const got = await fetchTurnServers(endpoint, sk, fetchFn);
    if (got.servers.length > 0) return { ...got, endpoint };
  }
  return { servers: [] };
}
