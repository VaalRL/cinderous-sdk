// C′ 即時通道的設定（SDK ADR 0049 §9、SDK ADR 0120／0121）：形狀、型別與收集式驗證。
//
// 從 iot-realtime.ts 拆出來，讓部署設定器（`./deploy/config`，不得帶進 `./iot` 的程式）與 relay 共用**同一個**驗證：
// 這裡只有型別引用 `./iot`；角色名單的深度解析（topic 樣式、到期時間…）由呼叫端注入——relay 傳 `parseIotAcl`，
// 部署設定器傳只看形狀的檢查。閘道私鑰的比對只在 relay（設定器手上沒有、也不該有私鑰）。
import type { IotAclInput, IotRole } from '../iot/acl.js';
import type { PubkeyHex } from '../protocol/keys.js';

/** 門鎖類設備必填的本地開啟方式（ADR 0049 §10.5） */
export const IOT_LOCAL_FALLBACKS = ['key', 'keypad', 'lan', 'ble', 'button'] as const;
export type IotLocalFallback = (typeof IOT_LOCAL_FALLBACKS)[number];
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
/** 換金鑰時舊版本的寬限（秒；ADR 0049 §2.6 `keyGraceSec`）：預設一天、最多七天（SDK ADR 0122） */
export const IOT_KEY_GRACE_DEFAULT_SEC = 86_400;
export const IOT_KEY_GRACE_MAX_SEC = 604_800;
/** 盲化 id 的長度（＝`./iot` 的 `IOT_BLIND_LENGTH`；這裡不能引用 `./iot`，測試比對兩者一致） */
export const IOT_REALTIME_BLIND_LENGTH = 22;

export interface IotRealtimeDeviceConfig {
  /** 設備 id（設定裡有；relay 以它核對信封的 kid） */
  readonly id: string;
  /** `blind("dev:" + id)`：URL 與事件的 `d`／`dv`（CLI 以家庭秘密預先算好） */
  readonly blindId: string;
  /** 目前的金鑰版本（kid 的 epoch） */
  readonly epoch: number;
  /** 設備權杖的 SHA-256 hex（relay 只存雜湊） */
  readonly tokenHash: string;
  readonly class?: 'lock' | 'general';
  /** 操作這台設備至少要哪個角色（門鎖常設 `owner`） */
  readonly minRole?: IotRole;
  /** 門鎖類必填：不依賴 relay 的開啟方式（§10.5） */
  readonly localFallback?: readonly IotLocalFallback[];
  /** 輪換寬限：舊 epoch 在 `until`（unix 秒）之前照收（§2.6 `keyGraceSec`） */
  readonly previousEpoch?: { readonly epoch: number; readonly until: number };
}

export interface IotRealtimeHomeConfig {
  readonly homeTag: string;
  /** 全家的 NIP-44 收件者（公開值） */
  readonly homePub: PubkeyHex;
  /** 閘道公鑰（手機以它加密外層、以它過濾 ack／狀態的作者） */
  readonly gatewayPubkey: PubkeyHex;
  readonly acl: IotAclInput;
  readonly devices: readonly IotRealtimeDeviceConfig[];
  /** 設備心跳間隔提示（秒，預設 30）；超過 3 倍沒有心跳視為 `stale` */
  readonly heartbeatSec?: number;
  /** 即時等級的時間窗（秒，預設 60）：外層訊息與信封的 ts 都要在這之內 */
  readonly realtimeTtlMaxSec?: number;
  /**
   * `blind("sys:acl")`（SDK ADR 0121）：給了，relay 就以 31170 公告角色名單（加密給全家），手機的 `myRole()`／`getAcl()` 讀得到。
   * relay 沒有 `topicKey` 算不出來，由 `cinderous iot realtime home` 預先算好。
   */
  readonly aclBlindId?: string;
}

export interface IotRealtimeIssue {
  readonly path: string;
  readonly code:
    | 'shape'
    | 'too-many-homes'
    | 'home-tag'
    | 'home-duplicate'
    | 'pubkey'
    | 'acl'
    | 'too-many-devices'
    | 'device-id'
    | 'blind-id'
    | 'device-duplicate'
    | 'epoch'
    | 'token-hash'
    | 'role'
    | 'lock-local-fallback'
    | 'range'
    | 'gateway-key-missing'
    | 'gateway-key-mismatch';
  readonly message: string;
}

export const IOT_REALTIME_BLIND_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${IOT_REALTIME_BLIND_LENGTH}}$`);
const HEX64 = /^[0-9a-f]{64}$/;
const ROLES: readonly IotRole[] = ['viewer', 'operator', 'owner'];

/**
 * 檢查 C′ 的設定（收集式：一次列出所有問題）。回傳每個家庭（以 index 對應）各自的問題數，給 relay 決定哪些家庭不啟用。
 * `checkAcl` 丟例外＝名單不合法（訊息會放進問題）。
 */
export function checkIotRealtimeConfig(
  raw: unknown,
  checkAcl: (acl: unknown) => void,
): { readonly issues: IotRealtimeIssue[]; readonly homes: { readonly index: number; readonly home: Record<string, unknown>; readonly ok: boolean }[] } {
  const issues: IotRealtimeIssue[] = [];
  const homes: { index: number; home: Record<string, unknown>; ok: boolean }[] = [];
  const add = (path: string, code: IotRealtimeIssue['code'], message: string): void => void issues.push({ path, code, message });
  const list = (raw as { homes?: unknown } | null)?.homes;
  if (!Array.isArray(list)) {
    add('homes', 'shape', '需要 { "homes": [ … ] }');
    return { issues, homes };
  }
  if (list.length > IOT_REALTIME_MAX_HOMES) add('homes', 'too-many-homes', `一座 relay 最多 ${IOT_REALTIME_MAX_HOMES} 個家庭`);
  const tags = new Set<string>();
  list.forEach((h: unknown, i: number) => {
    const at = `homes[${i}]`;
    const before = issues.length;
    const home = (h !== null && typeof h === 'object' && !Array.isArray(h) ? h : {}) as Record<string, unknown>;
    const homeTag = home.homeTag;
    if (typeof homeTag !== 'string' || !IOT_REALTIME_BLIND_PATTERN.test(homeTag)) add(`${at}.homeTag`, 'home-tag', `homeTag 必須是 ${IOT_REALTIME_BLIND_LENGTH} 個 base64url 字元`);
    else if (tags.has(homeTag)) add(`${at}.homeTag`, 'home-duplicate', '同一個 homeTag 出現兩次');
    else tags.add(homeTag);
    for (const key of ['homePub', 'gatewayPubkey'] as const) {
      if (typeof home[key] !== 'string' || !HEX64.test(home[key] as string)) add(`${at}.${key}`, 'pubkey', `${key} 必須是 64 位小寫 hex`);
    }
    if (home.aclBlindId !== undefined && (typeof home.aclBlindId !== 'string' || !IOT_REALTIME_BLIND_PATTERN.test(home.aclBlindId))) {
      add(`${at}.aclBlindId`, 'blind-id', `aclBlindId 必須是 ${IOT_REALTIME_BLIND_LENGTH} 個 base64url 字元（blind("sys:acl")）`);
    }
    for (const [key, min, max] of [['heartbeatSec', 5, 300], ['realtimeTtlMaxSec', 5, 300]] as const) {
      const v = home[key];
      if (v !== undefined && (!Number.isInteger(v) || (v as number) < min || (v as number) > max)) add(`${at}.${key}`, 'range', `${key} 必須是 ${min}–${max} 的整數`);
    }
    try {
      checkAcl(home.acl ?? []);
    } catch (error) {
      add(`${at}.acl`, 'acl', String(error instanceof Error ? error.message : error));
    }
    const devices = Array.isArray(home.devices) ? (home.devices as unknown[]) : [];
    if (!Array.isArray(home.devices)) add(`${at}.devices`, 'shape', 'devices 必須是陣列');
    if (devices.length > IOT_REALTIME_MAX_DEVICES) add(`${at}.devices`, 'too-many-devices', `每個家庭最多 ${IOT_REALTIME_MAX_DEVICES} 台設備`);
    const ids = new Set<string>();
    const blinds = new Set<string>();
    devices.forEach((d: unknown, j: number) => {
      const p = `${at}.devices[${j}]`;
      const dev = (d ?? {}) as Record<string, unknown>;
      if (typeof dev.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(dev.id)) add(`${p}.id`, 'device-id', '設備 id 只能用英數、點、底線、連字號（1–64 字）');
      if (typeof dev.blindId !== 'string' || !IOT_REALTIME_BLIND_PATTERN.test(dev.blindId)) add(`${p}.blindId`, 'blind-id', `blindId 必須是 ${IOT_REALTIME_BLIND_LENGTH} 個 base64url 字元`);
      if (typeof dev.id === 'string' && typeof dev.blindId === 'string' && (ids.has(dev.id) || blinds.has(dev.blindId))) add(p, 'device-duplicate', '設備 id 或 blindId 重複');
      if (typeof dev.id === 'string') ids.add(dev.id);
      if (typeof dev.blindId === 'string') blinds.add(dev.blindId);
      if (!Number.isSafeInteger(dev.epoch) || (dev.epoch as number) < 0) add(`${p}.epoch`, 'epoch', 'epoch 必須是非負整數');
      if (typeof dev.tokenHash !== 'string' || !HEX64.test(dev.tokenHash)) add(`${p}.tokenHash`, 'token-hash', 'tokenHash 必須是權杖的 SHA-256（64 位小寫 hex）——不要把權杖本身寫進設定');
      if (dev.minRole !== undefined && !ROLES.includes(dev.minRole as IotRole)) add(`${p}.minRole`, 'role', 'minRole 必須是 viewer／operator／owner');
      if (dev.class !== undefined && dev.class !== 'lock' && dev.class !== 'general') add(`${p}.class`, 'shape', 'class 必須是 lock 或 general');
      if (dev.class === 'lock') {
        const fb = dev.localFallback;
        if (!Array.isArray(fb) || fb.length === 0 || !fb.every((x) => (IOT_LOCAL_FALLBACKS as readonly unknown[]).includes(x))) {
          add(`${p}.localFallback`, 'lock-local-fallback', `門鎖類設備必須列出不依賴 relay 的開啟方式（${IOT_LOCAL_FALLBACKS.join('／')}），ADR 0049 §10.5`);
        }
      }
      const prev = dev.previousEpoch as { epoch?: unknown; until?: unknown } | undefined;
      if (prev !== undefined && (!Number.isSafeInteger(prev.epoch) || !Number.isSafeInteger(prev.until))) add(`${p}.previousEpoch`, 'epoch', 'previousEpoch 需要整數 epoch 與 until（unix 秒）');
      else if (prev !== undefined && Number.isSafeInteger(dev.epoch) && ((prev.epoch as number) < 0 || (prev.epoch as number) >= (dev.epoch as number))) add(`${p}.previousEpoch`, 'epoch', 'previousEpoch.epoch 要比 epoch 小（舊的版本）');
    });
    homes.push({ index: i, home, ok: issues.length === before });
  });
  return { issues, homes };
}

/**
 * 部署設定器用的名單形狀檢查（不帶進 `./iot`）：陣列、每項有 pubkey（npub 或 64 位 hex）與合法角色。
 * topic 樣式、到期時間等細節由 relay 啟動時的 `parseIotAcl` 再驗一次。
 */
export function checkIotRealtimeAclShape(acl: unknown): void {
  if (!Array.isArray(acl)) throw new Error('acl 必須是陣列');
  acl.forEach((e: unknown, i: number) => {
    const entry = (e ?? {}) as Record<string, unknown>;
    if (typeof entry.pubkey !== 'string' || !(HEX64.test(entry.pubkey) || /^npub1[02-9ac-hj-np-z]{58}$/.test(entry.pubkey))) throw new Error(`acl[${i}].pubkey 必須是 npub 或 64 位小寫 hex`);
    if (!ROLES.includes(entry.role as IotRole)) throw new Error(`acl[${i}].role 必須是 viewer／operator／owner`);
  });
}
