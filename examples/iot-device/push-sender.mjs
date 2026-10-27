// SPDX-License-Identifier: MIT-0
// Cinderous IoT 設備端推播送出的參考實作（Node 18+，零相依）——規格見同資料夾的 README.md（SDK ADR 0049 §11.1）。
// Reference implementation of the device-side push sender (Node 18+, no dependencies) — spec in README.md next to this file.
//
// 這份程式刻意不引用 @cinderous/client：它是給韌體（ESP32、Tasmota Berry…）照抄的「對照組」，只用 HMAC-SHA256、SHA-256、
// base64url 與 HTTP POST。與 SDK 的相容性由 SDK 的測試（tests/iot/device-example.test.ts）逐位元組比對。
//
// MIT No Attribution — Permission is hereby granted, free of charge, to any person obtaining a copy of this software
// and associated documentation files (the "Software"), to deal in the Software without restriction, including without
// limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
// and to permit persons to whom the Software is furnished to do so. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY
// OF ANY KIND.
import { createHash, createHmac } from 'node:crypto';

/** 規格 §5 的預設上限 */
export const DEFAULTS = Object.freeze({
  standardIntervalMs: 60_000, // 標準：每個端點 60 秒最多 1 次
  standardJitterMs: 30_000, // 標準：0–30 秒抖動
  instantJitterMs: 2_000, // 即時：0–2 秒抖動
  instantPerMinute: 6, // 每個端點每分鐘最多 6 次（含標準）
  maxAttempts: 3,
  deliveryTtlSec: 3_600,
});

/** base64url（無補齊）的前 22 字元 */
const id22 = (bytes) => Buffer.from(bytes).toString('base64url').slice(0, 22);

/** 登記 id：base64url(SHA-256(sealed)) 前 22 字元 */
export function regIdOf(sealed) {
  return id22(createHash('sha256').update(sealed, 'utf8').digest());
}

/** 要簽的字串（規格 §4.2） */
export function wakeMessage(regId, ts, ref) {
  return `cinder-push/v1/wake\n${ts}\n${ref ?? ''}\n${regId}`;
}

/** HMAC-SHA256(hex 密鑰, 字串) → hex */
export function sign(keyHex, message) {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message, 'utf8').digest('hex');
}

/** 一則喚醒請求（規格 §4）：UnifiedPush 是空的 POST；推播閘道是 {v, sealed, ts, sig, ref?} */
export function buildRequest(endpoint, ts, ref) {
  if (endpoint.type === 'unifiedpush') {
    return { url: endpoint.url, method: 'POST', headers: { TTL: String(DEFAULTS.deliveryTtlSec), Urgency: 'high' }, body: '' };
  }
  const okRef = typeof ref === 'string' && /^[0-9a-f]{64}$/.test(ref) ? ref : undefined;
  const body = { v: 1, sealed: endpoint.sealed, ts, sig: sign(endpoint.key, wakeMessage(regIdOf(endpoint.sealed), ts, okRef)), ...(okRef ? { ref: okRef } : {}) };
  return { url: `${endpoint.url.replace(/\/+$/, '')}/v1/wake`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** HTTP 狀態 → 結果（規格 §4.3） */
export function resultOf(status, retryAfter) {
  if (status >= 200 && status < 300) return { status: 'ok' };
  if (status === 404 || status === 410) return { status: 'gone' };
  if (status === 429 || status === 503) {
    const sec = retryAfter && /^\d{1,9}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : 60;
    return { status: 'retry', retryAfterMs: sec * 1000 };
  }
  return { status: 'error', reason: `http-${status}` };
}

/**
 * 設備端送出器。
 * @param {object} opts
 * @param {Array<{id: string, endpoint: object, subscriptions: Array<{dv?: string, special?: string, mode?: 'standard'|'instant'}>, expiresAt: number}>} opts.registrations 送出端保存的登記（規格 §2）
 * @param {() => number} [opts.now] 毫秒
 * @param {() => number} [opts.random] [0, 1)
 * @param {(fn: () => void, ms: number) => unknown} [opts.setTimer]
 * @param {(handle: unknown) => void} [opts.clearTimer]
 * @param {typeof fetch} [opts.fetch]
 * @param {(id: string) => void} [opts.onGone] 端點失效（從保存的清單刪掉）
 */
export function createPushSender(opts) {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  const doFetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
  const regs = new Map(opts.registrations.map((r) => [r.id, r]));
  /** id → { sent: number[], pending?: {at, handle, ref, attempts}, blockedUntil?: number, lastTs: number } */
  const state = new Map();
  const get = (id) => {
    let s = state.get(id);
    if (!s) state.set(id, (s = { sent: [], lastTs: 0 }));
    return s;
  };

  function earliest(s, mode) {
    const t = now();
    s.sent = s.sent.filter((x) => x > t - 60_000);
    let at = Math.max(t, s.blockedUntil ?? 0);
    const last = s.sent[s.sent.length - 1];
    if (mode === 'standard' && last !== undefined) at = Math.max(at, last + DEFAULTS.standardIntervalMs);
    if (s.sent.length >= DEFAULTS.instantPerMinute) at = Math.max(at, s.sent[s.sent.length - DEFAULTS.instantPerMinute] + 60_000);
    return at + Math.floor(random() * (mode === 'standard' ? DEFAULTS.standardJitterMs : DEFAULTS.instantJitterMs));
  }

  function schedule(id, s, at, ref, attempts) {
    if (s.pending) clearTimer(s.pending.handle);
    const handle = setTimer(() => void fire(id), Math.max(0, at - now()));
    s.pending = { at, handle, ref, attempts };
  }

  async function fire(id) {
    const s = state.get(id);
    const p = s?.pending;
    const reg = regs.get(id);
    if (!s || !p) return;
    s.pending = undefined;
    if (!reg || reg.expiresAt <= Math.floor(now() / 1000)) return;
    const sentAt = now();
    s.sent.push(sentAt);
    s.lastTs = Math.max(sentAt, s.lastTs + 1); // 同一端點的時間戳嚴格遞增
    const req = buildRequest(reg.endpoint, s.lastTs, p.ref);
    let result;
    try {
      const res = await doFetch(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: 'manual' });
      result = resultOf(res.status, res.headers.get('retry-after'));
    } catch {
      result = { status: 'error', reason: 'network' }; // 🔴 不記網址：UnifiedPush 網址本身就是能力
    }
    if (result.status === 'ok') return;
    if (result.status === 'gone') {
      regs.delete(id);
      state.delete(id);
      opts.onGone?.(id);
      return;
    }
    if (result.status === 'retry') s.blockedUntil = now() + result.retryAfterMs;
    if (p.attempts + 1 >= DEFAULTS.maxAttempts || s.pending) return;
    const base = result.status === 'retry' ? s.blockedUntil : sentAt + DEFAULTS.standardIntervalMs;
    schedule(id, s, Math.max(base, now()) + Math.floor(random() * DEFAULTS.standardJitterMs), p.ref, p.attempts + 1);
  }

  return {
    /** 某台設備（盲化 id）的狀態有變化：喚醒訂閱它的端點（規格 §3） */
    notifyDevice(dv, ref) {
      const t = Math.floor(now() / 1000);
      for (const reg of regs.values()) {
        if (reg.expiresAt <= t) continue;
        const hits = reg.subscriptions.filter((sub) => sub.dv === dv);
        if (hits.length === 0) continue;
        const mode = hits.some((sub) => sub.mode === 'instant') ? 'instant' : 'standard';
        const s = get(reg.id);
        if (s.pending) {
          if (ref !== undefined) s.pending.ref = ref;
          if (mode === 'instant') {
            const at = earliest(s, 'instant');
            if (at < s.pending.at) schedule(reg.id, s, at, s.pending.ref, s.pending.attempts);
          }
          continue;
        }
        schedule(reg.id, s, earliest(s, mode), ref, 0);
      }
    },
    /** 測試與除錯：等待中的喚醒 */
    pending(id) {
      const p = state.get(id)?.pending;
      return p ? { at: p.at } : undefined;
    },
    stop() {
      for (const s of state.values()) if (s.pending) clearTimer(s.pending.handle);
      state.clear();
    },
  };
}
