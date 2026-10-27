// 送出端保存的推播登記（SDK ADR 0049 §11.1 裁示 3、7）：端點清單只存在送出的一方，帶 TTL（預設 30 天）。
// 純邏輯；持久化由可注入的 `IotPushStore` 負責（橋接器用檔案，`./iot/bridge` 的 `fileIotPushStore`）。
//
// - 一筆登記以端點 id 為鍵；登記者（外層事件的簽章者）才能更新或移除自己的，owner 可以移除任何人的；
// - 每個家庭最多 `maxEndpoints` 筆（預設 32）；
// - 額度預警（`special: 'quota'`）只有 owner 能訂閱（登記時與送出時都檢查）；
// - owner 撤銷成員時，該成員的端點一併清掉（`removeByOwner`）。
import type { PubkeyHex } from '../protocol/keys.js';
import {
  IOT_PUSH_LIMITS,
  iotPushEndpointId,
  iotPushLimits,
  parseIotPushEndpoint,
  parseIotPushSubscriptions,
  type IotPushEndpoint,
  type IotPushLimits,
  type IotPushMode,
  type IotPushRegistration,
  type IotPushSpecial,
  type IotPushSubscription,
} from './push.js';

/** 登記的持久化（只在送出端本地） */
export interface IotPushStore {
  load(): readonly IotPushRegistration[] | undefined | Promise<readonly IotPushRegistration[] | undefined>;
  save(list: readonly IotPushRegistration[]): void | Promise<void>;
}

/** 記憶體版（測試，或不需要跨重開保存時） */
export function memoryIotPushStore(initial?: readonly IotPushRegistration[]): IotPushStore & { current(): readonly IotPushRegistration[] | undefined } {
  let list = initial;
  return {
    load: () => list,
    save: (next) => {
      list = [...next];
    },
    current: () => list,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 驗證存檔（讀回時用；不合法丟例外——存檔壞了就不啟動，不默默丟掉別人的登記） */
export function parseIotPushRegistrations(raw: unknown, opts: { allowPrivateHttp?: boolean } = {}): IotPushRegistration[] {
  if (!Array.isArray(raw)) throw new RangeError('推播登記的存檔要是陣列');
  return raw.map((item) => {
    if (!isObject(item) || typeof item.owner !== 'string' || !/^[0-9a-f]{64}$/.test(item.owner)) throw new RangeError('推播登記缺少 owner');
    if (!Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.expiresAt)) throw new RangeError('推播登記缺少時間');
    const endpoint = parseIotPushEndpoint(item.endpoint, opts);
    const id = iotPushEndpointId(endpoint);
    if (item.id !== id) throw new RangeError('推播登記的 id 與端點不符');
    return { id, owner: item.owner, endpoint, subscriptions: parseIotPushSubscriptions(item.subscriptions), createdAt: item.createdAt as number, expiresAt: item.expiresAt as number };
  });
}

export type IotPushRegisterOutcome = { readonly ok: true; readonly id: string; readonly created: boolean } | { readonly ok: false; readonly reason: string };

/** 某則事件該喚醒誰：每個端點一次，同一端點有多個符合的訂閱時取最急的模式 */
export interface IotPushTarget {
  readonly id: string;
  readonly mode: IotPushMode;
}

export class IotPushRegistry {
  readonly #limits: IotPushLimits;
  readonly #byId = new Map<string, IotPushRegistration>();

  constructor(opts: { limits?: Partial<IotPushLimits> } = {}) {
    this.#limits = iotPushLimits(opts.limits);
  }

  get limits(): IotPushLimits {
    return this.#limits;
  }

  /** 換成存檔裡的清單 */
  load(list: readonly IotPushRegistration[]): void {
    this.#byId.clear();
    for (const reg of list) this.#byId.set(reg.id, reg);
  }

  /** 目前的清單（含已過期但還沒清掉的；要乾淨的先 `prune`） */
  list(): IotPushRegistration[] {
    return [...this.#byId.values()];
  }

  get(id: string): IotPushRegistration | undefined {
    return this.#byId.get(id);
  }

  /** 清掉過期的；回傳被清掉的 id */
  prune(nowSec: number): string[] {
    const gone: string[] = [];
    for (const [id, reg] of this.#byId) {
      if (reg.expiresAt <= nowSec) {
        this.#byId.delete(id);
        gone.push(id);
      }
    }
    return gone;
  }

  /**
   * 登記或更新（以端點 id 為鍵）。`isOwner`＝登記者目前是 owner（額度預警只有 owner 能訂閱）。
   * 別人登記過的同一個端點不能蓋掉（回 `not-yours`）。
   */
  register(
    input: { owner: PubkeyHex; endpoint: IotPushEndpoint; subscriptions: readonly IotPushSubscription[]; ttlSec?: number; isOwner: boolean },
    nowSec: number,
  ): IotPushRegisterOutcome {
    if (!input.isOwner && input.subscriptions.some((s) => 'special' in s)) return { ok: false, reason: 'owner-only' };
    this.prune(nowSec);
    const id = iotPushEndpointId(input.endpoint);
    const existing = this.#byId.get(id);
    if (existing && existing.owner !== input.owner) return { ok: false, reason: 'not-yours' };
    if (!existing && this.#byId.size >= this.#limits.maxEndpoints) return { ok: false, reason: 'push-limit' };
    const spec = IOT_PUSH_LIMITS.registrationTtlSec;
    const ttl = input.ttlSec === undefined ? this.#limits.registrationTtlSec : Math.min(this.#limits.registrationTtlSec, Math.max(spec.min, Math.floor(input.ttlSec)));
    this.#byId.set(id, {
      id,
      owner: input.owner,
      endpoint: input.endpoint,
      subscriptions: [...input.subscriptions],
      createdAt: existing?.createdAt ?? nowSec,
      expiresAt: nowSec + ttl,
    });
    return { ok: true, id, created: !existing };
  }

  /** 移除一筆：登記者本人或 owner；回傳原因（成功回 undefined） */
  remove(id: string, by: PubkeyHex, byOwner: boolean): string | undefined {
    const reg = this.#byId.get(id);
    if (!reg) return 'unknown-endpoint';
    if (reg.owner !== by && !byOwner) return 'not-yours';
    this.#byId.delete(id);
    return undefined;
  }

  /** 撤銷成員：清掉他的所有端點；回傳被清掉的 id */
  removeByOwner(owner: PubkeyHex): string[] {
    const gone: string[] = [];
    for (const [id, reg] of this.#byId) {
      if (reg.owner === owner) {
        this.#byId.delete(id);
        gone.push(id);
      }
    }
    return gone;
  }

  /**
   * 某台設備（盲化 id）或特殊項目有更新：該喚醒的端點。`allowed(owner, special)` 由呼叫端依目前的角色名單判斷
   *（成員已被移除或過期 → 不送；特殊項目只給目前仍是 owner 的人）。
   */
  targets(match: { dv: string } | { special: IotPushSpecial }, nowSec: number, allowed: (owner: PubkeyHex, special: boolean) => boolean): IotPushTarget[] {
    const out: IotPushTarget[] = [];
    for (const reg of this.#byId.values()) {
      if (reg.expiresAt <= nowSec) continue;
      const special = 'special' in match;
      const hits = reg.subscriptions.filter((s) => ('dv' in match ? 'dv' in s && s.dv === match.dv : 'special' in s && s.special === match.special));
      if (hits.length === 0 || !allowed(reg.owner, special)) continue;
      out.push({ id: reg.id, mode: hits.some((s) => s.mode === 'instant') ? 'instant' : 'standard' });
    }
    return out;
  }
}
