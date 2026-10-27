// 分框（SDK ADR 0009 §2）：任意大小的資料切成 16 KB 框，另一端依 (訊息 id, 序號) 組回。
import { describe, expect, it } from 'vitest';

import {
  decodeFrame,
  encodeFrames,
  FRAME_HEADER_BYTES,
  FRAME_PAYLOAD_BYTES,
  FrameAssembler,
  RELAY_FRAME_PAYLOAD_BYTES,
} from '../../src/peer/frames.js';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

describe('encodeFrames／decodeFrame', () => {
  it('每框承載 16 KB；最後一框放剩下的', () => {
    const frames = encodeFrames(bytes(FRAME_PAYLOAD_BYTES * 2 + 5));
    expect(frames).toHaveLength(3);
    expect(frames[0]!.length).toBe(FRAME_HEADER_BYTES + FRAME_PAYLOAD_BYTES);
    expect(frames[2]!.length).toBe(FRAME_HEADER_BYTES + 5);
    const decoded = frames.map((f) => decodeFrame(f)!);
    expect(decoded.map((d) => [d.seq, d.total])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(new Set(decoded.map((d) => d.id)).size).toBe(1); // 同一則訊息共用 id
  });

  it('空資料也是一框（對方才收得到「空訊息」）', () => {
    const frames = encodeFrames(new Uint8Array(0));
    expect(frames).toHaveLength(1);
    expect(decodeFrame(frames[0]!)).toMatchObject({ seq: 0, total: 1 });
  });

  it('壞框 → null：太短、版本不對、序號超出總數、總數為 0', () => {
    const good = encodeFrames(bytes(10))[0]!;
    expect(decodeFrame(good.slice(0, 5))).toBeNull();
    const badVersion = good.slice();
    badVersion[0] = 99;
    expect(decodeFrame(badVersion)).toBeNull();
    const view = (f: Uint8Array) => new DataView(f.buffer, f.byteOffset, f.byteLength);
    const badSeq = good.slice();
    view(badSeq).setUint32(9, 7);
    expect(decodeFrame(badSeq)).toBeNull();
    const zeroTotal = good.slice();
    view(zeroTotal).setUint32(13, 0);
    expect(decodeFrame(zeroTotal)).toBeNull();
  });
});

describe('FrameAssembler', () => {
  it('亂序到達也組得回原本的資料', () => {
    const data = bytes(FRAME_PAYLOAD_BYTES * 3 + 100);
    const frames = encodeFrames(data);
    const assembler = new FrameAssembler();
    const results = [frames[2]!, frames[0]!, frames[3]!, frames[1]!].map((f) => assembler.push(f));
    expect(results.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(results[3]).toEqual(data);
  });

  it('🔴 重複的框（多座中繼各送一次）不會讓訊息交出兩次', () => {
    const [frame] = encodeFrames(bytes(10));
    const assembler = new FrameAssembler();
    expect(assembler.push(frame!)).toEqual(bytes(10));
    expect(assembler.push(frame!)).toBeUndefined();
  });

  it('組到一半逾時就丟掉，之後補來的框不會拼出殘缺資料', () => {
    let now = 0;
    const assembler = new FrameAssembler({ timeoutMs: 1_000, now: () => now });
    const frames = encodeFrames(bytes(FRAME_PAYLOAD_BYTES + 1));
    assembler.push(frames[0]!);
    now = 5_000;
    assembler.push(encodeFrames(bytes(1))[0]!); // 任何一次 push 都會順手清掉過期的
    expect(assembler.pendingCount).toBe(0);
    expect(assembler.push(frames[1]!)).toBeUndefined();
  });

  it('每框大小可指定（中繼軌 48,000 B）；組回來一樣', () => {
    const data = bytes(RELAY_FRAME_PAYLOAD_BYTES + 3);
    const frames = encodeFrames(data, RELAY_FRAME_PAYLOAD_BYTES);
    expect(frames).toHaveLength(2);
    const assembler = new FrameAssembler();
    assembler.push(frames[0]!);
    expect(assembler.push(frames[1]!)).toEqual(data);
  });

  it('單框超過最大承載 → 不收', () => {
    const [frame] = encodeFrames(bytes(RELAY_FRAME_PAYLOAD_BYTES + 1), RELAY_FRAME_PAYLOAD_BYTES + 1);
    expect(new FrameAssembler().push(frame!)).toBeUndefined();
  });

  it('宣稱的大小超過上限 → 整則不收（防對方用總數把記憶體撐爆）', () => {
    const assembler = new FrameAssembler({ maxMessageBytes: FRAME_PAYLOAD_BYTES });
    const frames = encodeFrames(bytes(FRAME_PAYLOAD_BYTES * 2));
    expect(assembler.push(frames[0]!)).toBeUndefined();
    expect(assembler.push(frames[1]!)).toBeUndefined();
    expect(assembler.pendingCount).toBe(0);
  });
});
