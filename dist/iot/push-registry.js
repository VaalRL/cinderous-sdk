import { IOT_PUSH_LIMITS, iotPushEndpointId, iotPushLimits, parseIotPushEndpoint, parseIotPushSubscriptions, } from './push.js';
/** 記憶體版（測試，或不需要跨重開保存時） */
export function memoryIotPushStore(initial) {
    let list = initial;
    return {
        load: () => list,
        save: (next) => {
            list = [...next];
        },
        current: () => list,
    };
}
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 驗證存檔（讀回時用；不合法丟例外——存檔壞了就不啟動，不默默丟掉別人的登記） */
export function parseIotPushRegistrations(raw, opts = {}) {
    if (!Array.isArray(raw))
        throw new RangeError('推播登記的存檔要是陣列');
    return raw.map((item) => {
        if (!isObject(item) || typeof item.owner !== 'string' || !/^[0-9a-f]{64}$/.test(item.owner))
            throw new RangeError('推播登記缺少 owner');
        if (!Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.expiresAt))
            throw new RangeError('推播登記缺少時間');
        const endpoint = parseIotPushEndpoint(item.endpoint, opts);
        const id = iotPushEndpointId(endpoint);
        if (item.id !== id)
            throw new RangeError('推播登記的 id 與端點不符');
        return { id, owner: item.owner, endpoint, subscriptions: parseIotPushSubscriptions(item.subscriptions), createdAt: item.createdAt, expiresAt: item.expiresAt };
    });
}
export class IotPushRegistry {
    #limits;
    #byId = new Map();
    constructor(opts = {}) {
        this.#limits = iotPushLimits(opts.limits);
    }
    get limits() {
        return this.#limits;
    }
    /** 換成存檔裡的清單 */
    load(list) {
        this.#byId.clear();
        for (const reg of list)
            this.#byId.set(reg.id, reg);
    }
    /** 目前的清單（含已過期但還沒清掉的；要乾淨的先 `prune`） */
    list() {
        return [...this.#byId.values()];
    }
    get(id) {
        return this.#byId.get(id);
    }
    /** 清掉過期的；回傳被清掉的 id */
    prune(nowSec) {
        const gone = [];
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
    register(input, nowSec) {
        if (!input.isOwner && input.subscriptions.some((s) => 'special' in s))
            return { ok: false, reason: 'owner-only' };
        this.prune(nowSec);
        const id = iotPushEndpointId(input.endpoint);
        const existing = this.#byId.get(id);
        if (existing && existing.owner !== input.owner)
            return { ok: false, reason: 'not-yours' };
        if (!existing && this.#byId.size >= this.#limits.maxEndpoints)
            return { ok: false, reason: 'push-limit' };
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
    remove(id, by, byOwner) {
        const reg = this.#byId.get(id);
        if (!reg)
            return 'unknown-endpoint';
        if (reg.owner !== by && !byOwner)
            return 'not-yours';
        this.#byId.delete(id);
        return undefined;
    }
    /** 撤銷成員：清掉他的所有端點；回傳被清掉的 id */
    removeByOwner(owner) {
        const gone = [];
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
    targets(match, nowSec, allowed) {
        const out = [];
        for (const reg of this.#byId.values()) {
            if (reg.expiresAt <= nowSec)
                continue;
            const special = 'special' in match;
            const hits = reg.subscriptions.filter((s) => ('dv' in match ? 'dv' in s && s.dv === match.dv : 'special' in s && s.special === match.special));
            if (hits.length === 0 || !allowed(reg.owner, special))
                continue;
            out.push({ id: reg.id, mode: hits.some((s) => s.mode === 'instant') ? 'instant' : 'standard' });
        }
        return out;
    }
}
//# sourceMappingURL=push-registry.js.map