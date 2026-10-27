import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "../../src/protocol/keys.js";
import { openWrap } from "../../src/protocol/nip59.js";
import {
  FILE_CHUNK_BYTES,
  FILE_CHUNK_KIND,
  FILE_CHUNK_MAX_TOTAL,
  FILE_WRAP_KIND,
  parseFileChunk,
  splitFileChunks,
  wrapFileChunk,
} from "../../src/sync/file-relay.js";

const aliceSk = generateSecretKey();
const alicePk = getPublicKey(aliceSk);
const bobSk = generateSecretKey();
const bobPk = getPublicKey(bobSk);

describe("relay 檔案分塊（ADR-0162）", () => {
  it("splitFileChunks：等分＋殘塊；空檔一塊", () => {
    const bytes = new Uint8Array(FILE_CHUNK_BYTES + 10);
    const parts = splitFileChunks(bytes);
    expect(parts.length).toBe(2);
    expect(parts[0]!.length).toBe(FILE_CHUNK_BYTES);
    expect(parts[1]!.length).toBe(10);
    expect(splitFileChunks(new Uint8Array(0)).length).toBe(1);
  });

  it("wrap/parse round-trip：外層 FILE_WRAP＋#p＋過期章；內層原樣還原；第三者不可解", () => {
    const data = new Uint8Array([1, 2, 3, 255, 0]);
    const wrap = wrapFileChunk(
      { tid: "t1", seq: 0, total: 2, name: "報表.xlsx", mime: "application/x", data },
      aliceSk,
      bobPk,
      { now: 1_700_000_000, expiration: 1_700_086_400 },
    );
    expect(wrap.kind).toBe(FILE_WRAP_KIND);
    expect(wrap.tags).toContainEqual(["p", bobPk]);
    expect(wrap.tags).toContainEqual(["expiration", "1700086400"]);
    const opened = openWrap(wrap, bobSk);
    expect(opened.sender).toBe(alicePk);
    const chunk = parseFileChunk(opened.rumor);
    expect(chunk).toMatchObject({ tid: "t1", seq: 0, total: 2, name: "報表.xlsx" });
    expect([...chunk!.data]).toEqual([1, 2, 3, 255, 0]);
    expect(() => openWrap(wrap, generateSecretKey())).toThrow();
  });

  it("parse 防禦：kind 不符、壞 JSON、seq/total 非法、超大塊、超長名 → null", () => {
    const mk = (content: string, kind: number = FILE_CHUNK_KIND) => ({ kind, tags: [], content, created_at: 0, id: "x", pubkey: "p" });
    const ok = { tid: "t", seq: 0, total: 1, name: "a", mime: "m", data: "" };
    expect(parseFileChunk(mk(JSON.stringify(ok), 14 /* Cinderous 的聊天訊息 kind：不是檔案塊 */))).toBeNull();
    expect(parseFileChunk(mk("not json"))).toBeNull();
    expect(parseFileChunk(mk(JSON.stringify({ ...ok, seq: 1 })))).toBeNull(); // seq >= total
    expect(parseFileChunk(mk(JSON.stringify({ ...ok, total: FILE_CHUNK_MAX_TOTAL + 1 })))).toBeNull();
    expect(parseFileChunk(mk(JSON.stringify({ ...ok, total: 0 })))).toBeNull();
    expect(parseFileChunk(mk(JSON.stringify({ ...ok, name: "n".repeat(300) })))).toBeNull();
    expect(parseFileChunk(mk(JSON.stringify({ ...ok, data: "!!!不是base64!!!" })))).toBeNull();
    expect(parseFileChunk(mk(JSON.stringify(ok)))).not.toBeNull();
  });
});
