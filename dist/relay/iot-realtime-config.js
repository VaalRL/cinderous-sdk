/** 門鎖類設備必填的本地開啟方式（ADR 0049 §10.5） */
export const IOT_LOCAL_FALLBACKS = ['key', 'keypad', 'lan', 'ble', 'button'];
/** 每個家庭最多幾台設備（§9.6 `maxDevicesPerHome`） */
export const IOT_REALTIME_MAX_DEVICES = 64;
/** 一座 relay 最多服務幾個家庭（每個家庭一顆 DO；自架站的上界，防止設定錯誤時建一大堆 DO） */
export const IOT_REALTIME_MAX_HOMES = 32;
/**
 * 家庭那顆儲存的可尋址上限（每個作者每個 kind）：閘道公鑰替每台設備存一顆 31170 retained，另加一顆名單公告。
 * 沿用嚴格平面的 5 會讓第 5 台以後的 retained 被悄悄拒掉（SDK ADR 0121 發現）。
 */
export const IOT_REALTIME_ADDRESSABLE_PER_AUTHOR = IOT_REALTIME_MAX_DEVICES + 1;
export const IOT_REALTIME_DEFAULT_HEARTBEAT_SEC = 30;
export const IOT_REALTIME_DEFAULT_TTL_MAX_SEC = 60;
/** 盲化 id 的長度（＝`./iot` 的 `IOT_BLIND_LENGTH`；這裡不能引用 `./iot`，測試比對兩者一致） */
export const IOT_REALTIME_BLIND_LENGTH = 22;
export const IOT_REALTIME_BLIND_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${IOT_REALTIME_BLIND_LENGTH}}$`);
const HEX64 = /^[0-9a-f]{64}$/;
const ROLES = ['viewer', 'operator', 'owner'];
/**
 * 檢查 C′ 的設定（收集式：一次列出所有問題）。回傳每個家庭（以 index 對應）各自的問題數，給 relay 決定哪些家庭不啟用。
 * `checkAcl` 丟例外＝名單不合法（訊息會放進問題）。
 */
export function checkIotRealtimeConfig(raw, checkAcl) {
    const issues = [];
    const homes = [];
    const add = (path, code, message) => void issues.push({ path, code, message });
    const list = raw?.homes;
    if (!Array.isArray(list)) {
        add('homes', 'shape', '需要 { "homes": [ … ] }');
        return { issues, homes };
    }
    if (list.length > IOT_REALTIME_MAX_HOMES)
        add('homes', 'too-many-homes', `一座 relay 最多 ${IOT_REALTIME_MAX_HOMES} 個家庭`);
    const tags = new Set();
    list.forEach((h, i) => {
        const at = `homes[${i}]`;
        const before = issues.length;
        const home = (h !== null && typeof h === 'object' && !Array.isArray(h) ? h : {});
        const homeTag = home.homeTag;
        if (typeof homeTag !== 'string' || !IOT_REALTIME_BLIND_PATTERN.test(homeTag))
            add(`${at}.homeTag`, 'home-tag', `homeTag 必須是 ${IOT_REALTIME_BLIND_LENGTH} 個 base64url 字元`);
        else if (tags.has(homeTag))
            add(`${at}.homeTag`, 'home-duplicate', '同一個 homeTag 出現兩次');
        else
            tags.add(homeTag);
        for (const key of ['homePub', 'gatewayPubkey']) {
            if (typeof home[key] !== 'string' || !HEX64.test(home[key]))
                add(`${at}.${key}`, 'pubkey', `${key} 必須是 64 位小寫 hex`);
        }
        if (home.aclBlindId !== undefined && (typeof home.aclBlindId !== 'string' || !IOT_REALTIME_BLIND_PATTERN.test(home.aclBlindId))) {
            add(`${at}.aclBlindId`, 'blind-id', `aclBlindId 必須是 ${IOT_REALTIME_BLIND_LENGTH} 個 base64url 字元（blind("sys:acl")）`);
        }
        for (const [key, min, max] of [['heartbeatSec', 5, 300], ['realtimeTtlMaxSec', 5, 300]]) {
            const v = home[key];
            if (v !== undefined && (!Number.isInteger(v) || v < min || v > max))
                add(`${at}.${key}`, 'range', `${key} 必須是 ${min}–${max} 的整數`);
        }
        try {
            checkAcl(home.acl ?? []);
        }
        catch (error) {
            add(`${at}.acl`, 'acl', String(error instanceof Error ? error.message : error));
        }
        const devices = Array.isArray(home.devices) ? home.devices : [];
        if (!Array.isArray(home.devices))
            add(`${at}.devices`, 'shape', 'devices 必須是陣列');
        if (devices.length > IOT_REALTIME_MAX_DEVICES)
            add(`${at}.devices`, 'too-many-devices', `每個家庭最多 ${IOT_REALTIME_MAX_DEVICES} 台設備`);
        const ids = new Set();
        const blinds = new Set();
        devices.forEach((d, j) => {
            const p = `${at}.devices[${j}]`;
            const dev = (d ?? {});
            if (typeof dev.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(dev.id))
                add(`${p}.id`, 'device-id', '設備 id 只能用英數、點、底線、連字號（1–64 字）');
            if (typeof dev.blindId !== 'string' || !IOT_REALTIME_BLIND_PATTERN.test(dev.blindId))
                add(`${p}.blindId`, 'blind-id', `blindId 必須是 ${IOT_REALTIME_BLIND_LENGTH} 個 base64url 字元`);
            if (typeof dev.id === 'string' && typeof dev.blindId === 'string' && (ids.has(dev.id) || blinds.has(dev.blindId)))
                add(p, 'device-duplicate', '設備 id 或 blindId 重複');
            if (typeof dev.id === 'string')
                ids.add(dev.id);
            if (typeof dev.blindId === 'string')
                blinds.add(dev.blindId);
            if (!Number.isSafeInteger(dev.epoch) || dev.epoch < 0)
                add(`${p}.epoch`, 'epoch', 'epoch 必須是非負整數');
            if (typeof dev.tokenHash !== 'string' || !HEX64.test(dev.tokenHash))
                add(`${p}.tokenHash`, 'token-hash', 'tokenHash 必須是權杖的 SHA-256（64 位小寫 hex）——不要把權杖本身寫進設定');
            if (dev.minRole !== undefined && !ROLES.includes(dev.minRole))
                add(`${p}.minRole`, 'role', 'minRole 必須是 viewer／operator／owner');
            if (dev.class !== undefined && dev.class !== 'lock' && dev.class !== 'general')
                add(`${p}.class`, 'shape', 'class 必須是 lock 或 general');
            if (dev.class === 'lock') {
                const fb = dev.localFallback;
                if (!Array.isArray(fb) || fb.length === 0 || !fb.every((x) => IOT_LOCAL_FALLBACKS.includes(x))) {
                    add(`${p}.localFallback`, 'lock-local-fallback', `門鎖類設備必須列出不依賴 relay 的開啟方式（${IOT_LOCAL_FALLBACKS.join('／')}），ADR 0049 §10.5`);
                }
            }
            const prev = dev.previousEpoch;
            if (prev !== undefined && (!Number.isSafeInteger(prev.epoch) || !Number.isSafeInteger(prev.until)))
                add(`${p}.previousEpoch`, 'epoch', 'previousEpoch 需要整數 epoch 與 until（unix 秒）');
        });
        homes.push({ index: i, home, ok: issues.length === before });
    });
    return { issues, homes };
}
/**
 * 部署設定器用的名單形狀檢查（不帶進 `./iot`）：陣列、每項有 pubkey（npub 或 64 位 hex）與合法角色。
 * topic 樣式、到期時間等細節由 relay 啟動時的 `parseIotAcl` 再驗一次。
 */
export function checkIotRealtimeAclShape(acl) {
    if (!Array.isArray(acl))
        throw new Error('acl 必須是陣列');
    acl.forEach((e, i) => {
        const entry = (e ?? {});
        if (typeof entry.pubkey !== 'string' || !(HEX64.test(entry.pubkey) || /^npub1[02-9ac-hj-np-z]{58}$/.test(entry.pubkey)))
            throw new Error(`acl[${i}].pubkey 必須是 npub 或 64 位小寫 hex`);
        if (!ROLES.includes(entry.role))
            throw new Error(`acl[${i}].role 必須是 viewer／operator／owner`);
    });
}
//# sourceMappingURL=iot-realtime-config.js.map