// retained 打包（SDK ADR 0049 §2.3、§2.4）：閘道以 31170 保存每台設備**所有 topic** 的最後值，一台一顆；
// 明文超過 {@link IOT_RETAINED_PART_MAX_BYTES} 就拆成多顆（`d` 加序號，`part`／`parts` 記在內容裡）。
// 同一次打包的每一顆有相同的 `ts`；讀回時只合併最新一次的那幾顆。
import { IOT_RETAINED_MAX_PARTS, IOT_RETAINED_PART_MAX_BYTES, newIotMsgId, type IotRetainedBody, type IotTopicValue } from './content.js';

export interface IotRetainedSnapshot {
  readonly device: string;
  readonly topics: Readonly<Record<string, IotTopicValue>>;
  /** 這次打包的時間（毫秒） */
  readonly ts: number;
  readonly online?: boolean;
  /** 最新一次打包的每一顆都讀到了 */
  readonly complete: boolean;
}

const size = (body: IotRetainedBody): number => new TextEncoder().encode(JSON.stringify(body)).length;

/** 把一台設備的所有 topic 打包成一或多顆 retained 內容；超過 {@link IOT_RETAINED_MAX_PARTS} 顆丟例外 */
export function packIotRetained(input: { device: string; topics: Readonly<Record<string, IotTopicValue>>; ts: number; online?: boolean }): IotRetainedBody[] {
  const base = (part: number, topics: Record<string, IotTopicValue>): IotRetainedBody => ({
    v: 1,
    type: 'retained',
    msgId: newIotMsgId(),
    ts: input.ts,
    device: input.device,
    topics,
    ...(input.online !== undefined ? { online: input.online } : {}),
    part,
    parts: 1,
  });
  const groups: Record<string, IotTopicValue>[] = [{}];
  for (const [topic, value] of Object.entries(input.topics).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const current = groups[groups.length - 1]!;
    const trial = { ...current, [topic]: value };
    if (Object.keys(current).length > 0 && size(base(0, trial)) > IOT_RETAINED_PART_MAX_BYTES) groups.push({ [topic]: value });
    else groups[groups.length - 1] = trial;
  }
  if (groups.length > IOT_RETAINED_MAX_PARTS) throw new RangeError(`設備 ${input.device} 的 retained 太大（超過 ${IOT_RETAINED_MAX_PARTS} 顆）`);
  return groups.map((topics, part) => ({ ...base(part, topics), parts: groups.length }));
}

/** 合併同一台設備讀回來的各顆（只取最新一次打包）；沒有任何一顆回 undefined */
export function mergeIotRetained(parts: readonly IotRetainedBody[]): IotRetainedSnapshot | undefined {
  if (parts.length === 0) return undefined;
  const ts = Math.max(...parts.map((p) => p.ts));
  const latest = parts.filter((p) => p.ts === ts);
  const first = latest[0]!;
  const topics: Record<string, IotTopicValue> = {};
  const seen = new Set<number>();
  for (const p of latest) {
    if (p.device !== first.device || seen.has(p.part)) continue;
    seen.add(p.part);
    Object.assign(topics, p.topics);
  }
  const online = latest.find((p) => p.online !== undefined)?.online;
  return { device: first.device, topics, ts, ...(online !== undefined ? { online } : {}), complete: seen.size === first.parts };
}
