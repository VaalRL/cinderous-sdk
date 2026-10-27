// 橋接器的 topic 對照表（SDK ADR 0049 §3 的 `topicMap`／`queryMap`）：本地 MQTT topic ↔ IoT topic。純函式、零 Node。
//
// - `dir: 'up'`：設備 → 手機（`mqtt` 是本地 broker 上要訂閱的 topic 或樣式）；
// - `dir: 'down'`：手機 → 設備（`topic` 是手機下指令的 IoT topic 或樣式，`mqtt` 是要發布到的本地 topic）；
// - 兩邊都可以有萬用字元：來源樣式的 `+`／`#` 依序代入目標樣式的 `+`／`#`（兩邊的萬用字元數量與順序必須相同）。
//   例：`{ mqtt: 'stat/plug1/+', topic: 'home/plug1/+', dir: 'up' }` 把 `stat/plug1/POWER` 轉成 `home/plug1/POWER`。
// - `lwt`：這一條是設備在本地 broker 的遺囑（例如 Tasmota `tele/<dev>/LWT`：`Online`／`Offline`）；轉成狀態並更新 retained 的 `online`。
import { assertIotTopicPattern, isValidIotDeviceId, topicMatches } from '../topic.js';

export interface IotTopicMapEntry {
  readonly mqtt: string;
  readonly topic: string;
  readonly device: string;
  readonly dir: 'up' | 'down';
  /** 只對 `up`：這是設備的遺囑 topic；預設 `Online`／`Offline` */
  readonly lwt?: boolean | { readonly online?: string; readonly offline?: string };
}

export interface IotQueryMapEntry {
  readonly device: string;
  /** 要發布到本地 broker 的原生查詢（例如 Tasmota `cmnd/plug1/STATUS`） */
  readonly mqtt: string;
  /** 預設空字串 */
  readonly payload?: string;
}

export interface IotUpMatch {
  readonly topic: string;
  readonly device: string;
  readonly lwt?: { readonly online: string; readonly offline: string };
}

export interface IotDownMatch {
  readonly mqtt: string;
  readonly device: string;
}

export interface IotTopicMap {
  /** 本地 broker 上要訂閱的樣式 */
  readonly subscriptions: readonly string[];
  /** 本地 MQTT 訊息 → IoT topic；沒有對應回 undefined */
  up(mqttTopic: string): IotUpMatch | undefined;
  /** 手機的 IoT topic → 本地 MQTT topic；沒有對應回 undefined */
  down(topic: string): IotDownMatch | undefined;
  /** IoT topic 屬於哪台設備（角色名單依設備細分時用） */
  deviceOf(topic: string): string | undefined;
  /** 某台設備的原生查詢 */
  queries(device: string): readonly IotQueryMapEntry[];
  /** 對照表裡出現過的設備 */
  readonly devices: ReadonlySet<string>;
}

const wildcards = (pattern: string): string[] => pattern.split('/').filter((level) => level === '+' || level === '#');

/** 以來源樣式比對具體 topic，抓出萬用字元配到的部分（`#` 可以是零或多層） */
function capture(pattern: string, topic: string): string[] | undefined {
  if (!topicMatches(pattern, topic)) return undefined;
  const p = pattern.split('/');
  const t = topic.split('/');
  const out: string[] = [];
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '+') out.push(t[i]!);
    else if (p[i] === '#') out.push(t.slice(i).join('/'));
  }
  return out;
}

/** 把抓到的部分依序代入目標樣式；`#` 配到零層時連同前面的 `/` 一起拿掉 */
function fill(template: string, parts: readonly string[]): string {
  let i = 0;
  const levels: string[] = [];
  for (const level of template.split('/')) {
    if (level === '+' || level === '#') {
      const value = parts[i++] ?? '';
      if (level === '#' && value === '') continue;
      levels.push(value);
    } else levels.push(level);
  }
  return levels.join('/');
}

/** 驗證並編譯對照表；寫錯就丟例外（設定檔錯了不啟動） */
export function compileIotTopicMap(entries: readonly IotTopicMapEntry[], queries: readonly IotQueryMapEntry[] = []): IotTopicMap {
  if (!Array.isArray(entries) || entries.length === 0) throw new RangeError('topicMap 至少要有一筆');
  const ups: (IotTopicMapEntry & { lwtPair?: { online: string; offline: string } })[] = [];
  const downs: IotTopicMapEntry[] = [];
  const devices = new Set<string>();
  entries.forEach((entry, index) => {
    const where = `topicMap[${index}]`;
    if (typeof entry !== 'object' || entry === null) throw new RangeError(`${where} 要是物件`);
    if (entry.dir !== 'up' && entry.dir !== 'down') throw new RangeError(`${where}.dir 只能是 up 或 down`);
    if (!isValidIotDeviceId(entry.device)) throw new RangeError(`${where}.device 不合法：${String(entry.device)}`);
    for (const key of ['mqtt', 'topic'] as const) {
      if (typeof entry[key] !== 'string') throw new RangeError(`${where}.${key} 要是字串`);
      try {
        assertIotTopicPattern(entry[key]);
      } catch (error) {
        throw new RangeError(`${where}.${key}：${(error as Error).message}`);
      }
    }
    if (entry.topic.startsWith('$')) throw new RangeError(`${where}.topic 不能以 $ 開頭（保留給系統 topic）`);
    const [from, to] = entry.dir === 'up' ? [entry.mqtt, entry.topic] : [entry.topic, entry.mqtt];
    if (wildcards(from).join('/') !== wildcards(to).join('/')) throw new RangeError(`${where}：mqtt 與 topic 的萬用字元數量與順序必須相同`);
    devices.add(entry.device);
    if (entry.dir === 'down') {
      if (entry.lwt !== undefined) throw new RangeError(`${where}.lwt 只能用在 dir: up`);
      downs.push(entry);
      return;
    }
    const lwt = entry.lwt === true ? {} : entry.lwt === false || entry.lwt === undefined ? undefined : entry.lwt;
    ups.push(lwt ? { ...entry, lwtPair: { online: lwt.online ?? 'Online', offline: lwt.offline ?? 'Offline' } } : entry);
  });
  queries.forEach((q, index) => {
    const where = `queryMap[${index}]`;
    if (!isValidIotDeviceId(q.device)) throw new RangeError(`${where}.device 不合法：${String(q.device)}`);
    if (typeof q.mqtt !== 'string' || q.mqtt.includes('+') || q.mqtt.includes('#') || q.mqtt.length === 0) throw new RangeError(`${where}.mqtt 要是具體的 topic`);
    if (q.payload !== undefined && typeof q.payload !== 'string') throw new RangeError(`${where}.payload 要是字串`);
  });
  return {
    subscriptions: [...new Set(ups.map((u) => u.mqtt))],
    up(mqttTopic) {
      for (const u of ups) {
        const parts = capture(u.mqtt, mqttTopic);
        if (parts) return { topic: fill(u.topic, parts), device: u.device, ...(u.lwtPair ? { lwt: u.lwtPair } : {}) };
      }
      return undefined;
    },
    down(topic) {
      for (const d of downs) {
        const parts = capture(d.topic, topic);
        if (parts) return { mqtt: fill(d.mqtt, parts), device: d.device };
      }
      return undefined;
    },
    deviceOf(topic) {
      for (const e of [...downs, ...ups]) if (topicMatches(e.topic, topic)) return e.device;
      return undefined;
    },
    queries: (device) => queries.filter((q) => q.device === device),
    devices,
  };
}
