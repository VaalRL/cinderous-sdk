// 簽章裝置目錄（ADR-0322 S1）：**加密給自己**的可取代事件，列出這個身分現役的裝置公鑰。
//
// ## 為什麼是「加密給自己」而不是公開或扇出給聯絡人
//
// ADR-0303 §7 的四個選項，軸線都是「陌生人／聯絡人能不能讀到」——因為在那份 ADR 的脈絡
// （棘輪）裡，per-device 預金鑰**必須讓對方讀到**才建得起 X3DH。
//
// **撤銷用的目錄讀者只有自己**：聯絡人照舊加密到身分層的 EK（ADR-0245），不需要知道你有幾台；
// 裝置公鑰只被你自己用來決定「這輪 EK 要加密給哪幾把」（S2）。
// ⇒ 故取第三個象限：中繼與公眾只看得到「這個 npub 有一顆 10041」（一個位元），**數不出基數**。
//
// ## 為什麼不能只放在雲端快照裡
//
// 快照合併是 add-biased，而被移除的裝置有 nsec ⇒ 它可以寫一份把自己加回去的快照。
// 專用可取代事件 ＋ **單調版本** ＋ ADR-0099 §2 的決勝規則才站得住。
// ⚠ 它**仍然簽得出 v+1**（ADR-0322〈買不到什麼〉第 1 點）——那要靠 S4 的分歧偵測。

import { verifyEvent } from "./sign.js";
import type { NostrEvent } from "./event.js";
import { pubkeyOf, signWith } from "./key-ops.js";
import type { PubkeyHex } from "./keys.js";
import type { SecretKeyOrSigner } from "./signer.js";
import { decryptDM, encryptDM } from "./nip44.js";

/** 裝置目錄事件 kind（可取代；接續 10037/10038/10039/10040）。 */
export const DEVICE_DIRECTORY_KIND = 10041;

/** 目錄內裝置數上限：防畸形/惡意內容撐爆解析（一個人不會有 32 台）。 */
export const DEVICE_DIRECTORY_MAX = 32;
/** 裝置標籤長度上限（使用者可讀，本機自報）。 */
export const DEVICE_LABEL_MAX_LEN = 40;

const PK_RE = /^[0-9a-f]{64}$/;

export interface DeviceEntry {
  /** 裝置公鑰——該裝置自產，私鑰**永不離開該裝置**。 */
  pk: PubkeyHex;
  /**
   * 該裝置的**可觀測 id**（`getDeviceId()`，即雲端快照 `d` tag 的值）。
   *
   * 為什麼要一起帶：ADR-0321 的觀測清單用的是 deviceId，而目錄用的是裝置公鑰——
   * **兩個不同的識別碼**。少了這一欄，「觀測到但不在目錄內」就算不出來，
   * 而那正是 S1 要補上的那個盲點。
   */
  id?: string;
  /** 使用者可讀標籤（本機自報，如「Windows 桌機」）。 */
  label?: string;
  /** 加入目錄的時間（unix 秒）。 */
  at: number;
}

export interface DeviceDirectory {
  /**
   * 單調版本。**同版本、內容不同＝分歧證據**（S4 據此警示，不自動選邊）；
   * 版本倒退同樣是證據。
   */
  v: number;
  devices: DeviceEntry[];
}

/** 打包裝置目錄：內容 NIP-44 加密給自己、身分金鑰簽章、可取代（無 `d` tag）。 */
export function buildDeviceDirectory(sk: SecretKeyOrSigner, dir: DeviceDirectory, opts: { now?: number } = {}): NostrEvent {
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  return signWith(
    {
      kind: DEVICE_DIRECTORY_KIND,
      created_at: nowSec,
      tags: [],
      content: encryptDM(JSON.stringify(dir), sk, pubkeyOf(sk)),
    },
    sk,
  );
}

/**
 * 解開並驗證自己的裝置目錄。非本 kind／非自己所發／壞簽章／解不開／畸形內容一律回 null
 * ——**不信任網路來源**（同 `readEkAnnounce`）。
 */
export function readDeviceDirectory(event: NostrEvent, sk: SecretKeyOrSigner): DeviceDirectory | null {
  if (event.kind !== DEVICE_DIRECTORY_KIND) return null;
  if (event.pubkey !== pubkeyOf(sk)) return null;
  if (!verifyEvent(event)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decryptDM(event.content, sk, event.pubkey));
  } catch {
    return null;
  }
  return parseDirectory(raw);
}

/** 逐欄位驗形狀（畸形項整筆丟棄，不做「盡量修好」——那會讓攻擊者塞進半合法內容）。 */
function parseDirectory(raw: unknown): DeviceDirectory | null {
  if (!raw || typeof raw !== "object") return null;
  const { v, devices } = raw as { v?: unknown; devices?: unknown };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
  if (!Array.isArray(devices) || devices.length > DEVICE_DIRECTORY_MAX) return null;
  const out: DeviceEntry[] = [];
  const seen = new Set<string>();
  for (const d of devices) {
    if (!d || typeof d !== "object") return null;
    const { pk, label, at, id } = d as { pk?: unknown; label?: unknown; at?: unknown; id?: unknown };
    if (typeof pk !== "string" || !PK_RE.test(pk) || seen.has(pk)) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if (label !== undefined && (typeof label !== "string" || label.length > DEVICE_LABEL_MAX_LEN)) return null;
    if (id !== undefined && (typeof id !== "string" || id.length > DEVICE_LABEL_MAX_LEN)) return null;
    seen.add(pk);
    out.push({ pk, at, ...(label ? { label } : {}), ...(id ? { id } : {}) });
  }
  return { v, devices: out };
}

/** 目錄內是否有這把裝置公鑰。 */
export function inDirectory(dir: DeviceDirectory | null, pk: PubkeyHex): boolean {
  return !!dir?.devices.some((d) => d.pk === pk);
}

/**
 * 目錄內是否有這個**可觀測 id**（ADR-0321 的觀測清單與目錄的接合點）。
 *
 * 三態，且 `null`＝**無法證明**（不是 false）：
 * - 目錄尚未建立 ⇒ `null`
 * - 找到相符的 id ⇒ `true`
 * - 找不到，**但目錄裡有項目沒帶 `id`** ⇒ `null`——那些項目可能就是它，
 *   把「無法證明」講成「不在目錄內」會誤報一台合法登記過的裝置（`id` 是選填欄位）。
 * - 找不到，且目錄裡每一項都帶了 `id` ⇒ `false`（這才是可證的「不在目錄內」）
 */
export function deviceIdInDirectory(dir: DeviceDirectory | null, id: string): boolean | null {
  if (!dir) return null;
  if (dir.devices.some((d) => d.id === id)) return true;
  return dir.devices.every((d) => d.id !== undefined) ? false : null;
}

/**
 * 把某台裝置移出目錄（純函式；ADR-0322 S3）。不在其中則原樣回傳（冪等，不無謂 bump 版本）。
 *
 * ⚠ 移除**只是簽一份新目錄**——真正讓它讀不到之後的訊息的是「輪替 EK ＋ 只分發給剩下的裝置」，
 * 由呼叫端負責（S3）。單獨改目錄不構成撤銷。
 */
export function withoutDevice(dir: DeviceDirectory | null, pk: PubkeyHex): DeviceDirectory {
  const base = dir ?? { v: 0, devices: [] };
  if (!inDirectory(base, pk)) return base;
  return { v: base.v + 1, devices: base.devices.filter((d) => d.pk !== pk) };
}

/**
 * 把自己加進目錄（純函式）：已在其中則原樣回傳（冪等，不無謂 bump 版本）。
 * 超過上限時**不加**——回原目錄，由呼叫端決定要不要提示。
 */
export function withDevice(dir: DeviceDirectory | null, entry: DeviceEntry): DeviceDirectory {
  const base = dir ?? { v: 0, devices: [] };
  if (inDirectory(base, entry.pk)) return base;
  if (base.devices.length >= DEVICE_DIRECTORY_MAX) return base;
  return { v: base.v + 1, devices: [...base.devices, entry] };
}

/**
 * 兩份目錄的分歧分類（ADR-0322 S4）。
 *
 * 🔴 **同版本的分歧無法判斷是「加了一台」還是「拿掉一台」。**
 * 我有 {A,B}、收到 {A,C}：可能是對方加了 C（而它還沒看到我的 B），
 * 也可能是對方拿掉了 B 又加了 C。**兩者在資料上完全一樣**——沒有因果歷史
 * （vector clock／父雜湊）就分不出來，而那是另一個量級的機制。
 *
 * ⇒ 故只把**版本倒退**歸為 conflict（那不含糊：較低的版本只可能來自重放或倒退）。
 *
 * 同版本分歧**不合併**（S5 修正，2026-08-04）：原本以聯集收斂，理由是「不把合法裝置鎖在門外」。
 * 但 S5 拿掉自我登記之後，**聯集等於讓自我登記從另一扇門回來**——兩台各自創世，合併後兩台都在，
 * 授權形同虛設（實測抓到）。
 *
 * 改為由呼叫端以 **ADR-0099 §2 的既有決勝規則**（`created_at` 較新者勝、相同則事件 id 字典序小者勝）
 * 選出唯一勝方，兩邊必然收斂到同一份。**輸的那台不會失聯**——它照舊走舊路徑（快照帶 EK），
 * 且 `revocationState()` 會回報 dual-track；使用者在勝方按一次「授權」就把它加回來。
 * ⇒ 不鎖住合法裝置的目的仍然達成，只是改由**授權**達成，而不是由自動合併。
 */
export type DirectoryDivergence =
  | { kind: "none" }
  | { kind: "concurrent" }
  | { kind: "conflict"; reason: "rollback" };

export function classifyDirectory(mine: DeviceDirectory | null, incoming: DeviceDirectory): DirectoryDivergence {
  if (!mine) return { kind: "none" };
  if (incoming.v < mine.v) return { kind: "conflict", reason: "rollback" };
  if (incoming.v > mine.v) return { kind: "none" };
  if (canonical(mine) === canonical(incoming)) return { kind: "none" };
  return { kind: "concurrent" };
}

/**
 * 同版本分歧的決勝（ADR-0099 §2 的既有規則，不另發明）：`created_at` 較新者勝；
 * 相同則事件 id 字典序**較小**者勝。回 true 代表**收到的那份勝出**。
 */
export function incomingWins(
  mine: { created_at: number; id: string } | null,
  incoming: { created_at: number; id: string },
): boolean {
  if (!mine) return true;
  if (incoming.created_at !== mine.created_at) return incoming.created_at > mine.created_at;
  return incoming.id < mine.id;
}

export function directoryConflict(mine: DeviceDirectory | null, incoming: DeviceDirectory): boolean {
  return classifyDirectory(mine, incoming).kind === "conflict";
}

/**
 * 內容的正規化字串（比較用）。
 *
 * 🔴 **不能用 `JSON.stringify`**：它保留**屬性插入順序**，而同一份目錄在記憶體裡（`withDevice`
 * 建的 `{pk,id,at}`）與從事件解回來（`parseDirectory` 建的 `{pk,at,id}`）**欄位順序不同**
 * ⇒ 內容相同卻算成不同 ⇒ **自己發的目錄回流時會被誤判為分歧**，每次開機都喊一次狼來了。
 * （這個 bug 在 S1 的整合測試中被抓到。）
 */
function canonical(d: DeviceDirectory): string {
  return [...d.devices]
    .sort((a, b) => a.pk.localeCompare(b.pk))
    .map((x) => `${x.pk}|${x.at}|${x.id ?? ""}|${x.label ?? ""}`)
    .join(",");
}
