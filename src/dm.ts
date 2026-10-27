/**
 * 私訊（SDK ADR 0001；源自《沒當好爸爸》ADR 0025）：標準 NIP-17。kind 14 rumor（不簽）→ kind 13 seal（寄件人簽、NIP-44 加給收件人）
 * → kind 1059 gift wrap（一次性金鑰簽、只有 `p` 標籤）。同一份 rumor 封兩次：給對方、給自己，
 * 回來時以 rumor id 去重——任何支援 NIP-17 的客戶端都讀得到，Relay 只看得到收件人與密文。
 *
 * 不做前向保密與多裝置同步（那是 Cinderous 本體的事）；對話存在本機，Relay 上只留 7 天。
 *
 * 封裝與拆封走 `protocol/nip59`（經 `Identity.sealAndWrap`／`openWrap`）：SDK 裡禮物包只有這一份實作
 * （SDK ADR 0012）。它與 nostr-tools 的 NIP-17 雙向互通，由 `dm.test.ts` 釘住。
 */

import type { Event } from 'nostr-tools/core';

import { StorageSlot, type ChatStorageLike } from './chat-storage.js';
import type { Identity } from './identity.js';
import {
  durabilityShortfall,
  meetsDurability,
  reportPublishRejections,
  type ClassifiedRejection,
  type PublishRejectionReport,
} from './publish-rejections.js';
import type { DurabilityResult, PublishDurability, PublishResult, RelayTransport } from './relay-pool.js';

export const DM_RUMOR_KIND = 14;
export const DM_SEAL_KIND = 13;
export const DM_WRAP_KIND = 1059;
/** 一則私訊的字數上限 */
export const DM_MAX_CHARS = 1_000;
/** 收件匣往回看多久：已知租戶車道上一般事件保存 7 天 */
export const DM_LOOKBACK_SEC = 7 * 24 * 60 * 60;
/** 每位對象在本機保留的則數、最多幾段對話 */
export const DM_HISTORY_PER_PEER = 200;
export const DM_PEERS_LIMIT = 50;

/** 對話在儲存裡的預設鍵；各應用可用 `storageKey` 沿用自己既有的鍵 */
export const DEFAULT_DM_STORAGE_KEY = 'cinderous:dm:threads';

/** 解開的一則私訊 */
export interface ReceivedDm {
  /** rumor id：兩份封裝解出來相同，用來去重 */
  readonly id: string;
  /** 對話的另一方 */
  readonly peer: string;
  readonly text: string;
  /** rumor 的 created_at（秒；真正的發送時間） */
  readonly at: number;
  readonly mine: boolean;
}

export interface DmLine {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly mine: boolean;
}

export interface DmThread {
  readonly peer: string;
  readonly lines: readonly DmLine[];
  readonly lastAt: number;
}

/** localStorage 的子集：測試注入記憶體版。非同步的儲存（IndexedDB 等）用 `AsyncChatStorage`（SDK ADR 0024） */
export interface ChatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WrapDmRequest {
  readonly identity: Identity;
  readonly to: string;
  readonly text: string;
  readonly nowSec: number;
}

/** 封一則私訊：回傳 [給對方的, 給自己的]。空白或超過字數丟例外。 */
export function wrapDm(request: WrapDmRequest): Event[] {
  const { identity, to, nowSec } = request;
  const text = request.text.trim();
  if (text.length === 0 || text.length > DM_MAX_CHARS) {
    throw new Error(`私訊要 1～${DM_MAX_CHARS} 字`);
  }
  // 同一份 rumor（id 由內容決定，兩次相同）各封一次給對方與自己；seal 與 wrap 的時間由 nip59 往前倒填
  const rumor = { kind: DM_RUMOR_KIND, created_at: nowSec, tags: [['p', to]], content: text };
  const recipients = to === identity.pubkey ? [to] : [to, identity.pubkey];
  return recipients.map(
    (recipient) => identity.sealAndWrap(rumor, recipient, { kind: DM_WRAP_KIND, tags: [['p', recipient]] }) as Event,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 解開給我的封裝；不是給我的、被改過、冒名（seal 簽章者≠rumor 作者）、形狀不對一律 `null`。 */
export function unwrapDm(identity: Identity, wrap: Event): ReceivedDm | null {
  try {
    if (wrap.kind !== DM_WRAP_KIND) {
      return null;
    }
    // 驗 seal 簽章、rumor 作者＝seal 簽章者、rumor id 與內容相符，都在 openWrap 裡
    const { sender: sealer, rumor: opened } = identity.openWrap(wrap);
    const rumor: unknown = opened;
    if (
      !isRecord(rumor) ||
      rumor['kind'] !== DM_RUMOR_KIND ||
      typeof rumor['content'] !== 'string' ||
      typeof rumor['created_at'] !== 'number' ||
      !Array.isArray(rumor['tags'])
    ) {
      return null;
    }
    const text = rumor['content'].trim();
    if (text.length === 0 || text.length > DM_MAX_CHARS) {
      return null;
    }
    const mine = sealer === identity.pubkey;
    const tags = rumor['tags'] as unknown[];
    const pTag = tags.find(
      (tag): tag is [string, string] =>
        Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string',
    );
    const peer = mine ? pTag?.[1] : sealer;
    if (peer === undefined) {
      return null;
    }
    return {
      id: opened.id,
      peer,
      text,
      at: rumor['created_at'],
      mine,
    };
  } catch {
    return null;
  }
}

/** 加入一則：同 id 不重複、依時間排序、每段對話與對話數各自封頂。沒變就回原陣列。 */
function withDm(threads: readonly DmThread[], dm: ReceivedDm): readonly DmThread[] {
  const current = threads.find((thread) => thread.peer === dm.peer);
  if (current?.lines.some((line) => line.id === dm.id)) {
    return threads;
  }
  const lines = [...(current?.lines ?? []), { id: dm.id, text: dm.text, at: dm.at, mine: dm.mine }]
    .sort((a, b) => a.at - b.at)
    .slice(-DM_HISTORY_PER_PEER);
  const thread: DmThread = { peer: dm.peer, lines, lastAt: lines.at(-1)?.at ?? dm.at };
  return [thread, ...threads.filter((other) => other.peer !== dm.peer)]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, DM_PEERS_LIMIT);
}

function parseThreads(raw: string | null): readonly DmThread[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // 形狀不對的對話整段丟掉（儲存可能被外部改壞），免得之後合併新訊息時才出錯
    return Array.isArray(parsed)
      ? (parsed as DmThread[]).filter((thread) => isRecord(thread) && typeof thread.peer === 'string' && Array.isArray(thread.lines))
      : [];
  } catch {
    return [];
  }
}

export interface DirectMessagesOptions {
  readonly transport: RelayTransport;
  readonly identity: Identity;
  /** 毫秒；測試可注入 */
  readonly now?: () => number;
  /**
   * 對話存哪裡；省略就只放記憶體。可以是同步的 `ChatStorage`（例如 `localStorage`），
   * 也可以是非同步的 `AsyncChatStorage`（例如 IndexedDB；SDK ADR 0024）——後者要 `await ready()` 才讀得到舊對話。
   */
  readonly storage?: ChatStorageLike;
  /** 對話存在哪個鍵；預設 `DEFAULT_DM_STORAGE_KEY`。已上線的應用填自己原本的鍵，舊對話才讀得回來 */
  readonly storageKey?: string;
  readonly isBlocked?: (pubkey: string) => boolean;
  /**
   * 有中繼拒收時回報（SDK ADR 0038 P0-C）：兩份封裝（給對方、給自己）各報一次。
   * 成功與否照舊以「至少一座收下」判斷；這裡讓應用看得到「三座裡兩座因為滿了沒收」。
   */
  readonly onPublishRejected?: (report: PublishRejectionReport) => void;
  /**
   * 耐久度要求（SDK ADR 0041）：兩份封裝各自要至少 `minAccepted` 座**耐久收下**（借用不算）才算送出；
   * 不足時只有給了 `standby` 才會延遲連上備援補發。省略＝v0.32 的判斷（至少一座收下）。
   * 建議：`standby` 放對方 NIP-17（kind 10050）公布的收件中繼（`@cinderous/client/durability` 的 `dmRelaysFor`）。
   */
  readonly durability?: PublishDurability;
}

export interface SendOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** 給對方那一份：收下的中繼（v0.32；SDK ADR 0038 P0-C） */
  readonly accepted?: readonly string[];
  /** 給對方那一份：拒收的中繼與分類（不含沒連上的）；部分拒收時 `ok` 仍是 true */
  readonly rejected?: readonly ClassifiedRejection[];
  /** 給對方那一份的耐久度結果（有設定 `durability`、而且傳輸層是 `RelayPool` 時才有；v0.33） */
  readonly durability?: DurabilityResult;
}

/** 私訊收件匣與對話紀錄。收件匣訂閱是 `#p` 自己，車道要先 NIP-42（RelayPool 帶身分時自動處理）。 */
export class DirectMessages {
  readonly #transport: RelayTransport;
  readonly #identity: Identity;
  readonly #now: () => number;
  readonly #slot: StorageSlot;
  readonly #isBlocked: (pubkey: string) => boolean;
  readonly #onPublishRejected: ((report: PublishRejectionReport) => void) | undefined;
  readonly #durability: PublishDurability | undefined;
  readonly #listeners = new Set<(threads: readonly DmThread[]) => void>();
  #threads: readonly DmThread[] = [];
  /** 舊對話讀回來了沒（同步儲存：建構時就讀完） */
  #loaded = false;
  /** 讀回之前被 `forget` 的對象：讀回的舊紀錄裡也要拿掉 */
  readonly #forgottenBeforeLoad = new Set<string>();

  constructor(options: DirectMessagesOptions) {
    this.#transport = options.transport;
    this.#identity = options.identity;
    this.#now = options.now ?? (() => Date.now());
    this.#isBlocked = options.isBlocked ?? (() => false);
    this.#onPublishRejected = options.onPublishRejected;
    this.#durability = options.durability;
    this.#slot = new StorageSlot(options.storage, options.storageKey ?? DEFAULT_DM_STORAGE_KEY);
    this.#slot.load((raw) => this.#onLoaded(raw));
  }

  threads(): readonly DmThread[] {
    return this.#threads;
  }

  /** 舊對話讀回來之後完成。同步儲存（或沒有儲存）立刻完成。 */
  ready(): Promise<void> {
    return this.#slot.ready();
  }

  /** 到目前為止的變更都寫進儲存之後完成。同步儲存（或沒有儲存）立刻完成。 */
  flush(): Promise<void> {
    return this.#slot.flush();
  }

  /** 開收件匣；立刻回呼一次目前的對話，之後每次變動都回呼。 */
  watch(listener: (threads: readonly DmThread[]) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#threads);
    const subscription = this.#transport.subscribe(
      [
        {
          kinds: [DM_WRAP_KIND],
          '#p': [this.#identity.pubkey],
          since: Math.floor(this.#now() / 1000) - DM_LOOKBACK_SEC,
        },
      ],
      {
        onEvent: (event) => {
          const dm = unwrapDm(this.#identity, event);
          if (dm !== null) {
            this.#add(dm);
          }
        },
      },
    );
    return () => {
      this.#listeners.delete(listener);
      subscription.close();
    };
  }

  /** 送一則：本機先記下，兩份封裝都發；全部 Relay 拒收就回失敗（訊息仍留在本機紀錄）。 */
  async send(to: string, text: string): Promise<SendOutcome> {
    let wraps: Event[];
    try {
      wraps = wrapDm({
        identity: this.#identity,
        to,
        text,
        nowSec: Math.floor(this.#now() / 1000),
      });
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    const own = unwrapDm(this.#identity, wraps.at(-1)!);
    if (own !== null) {
      this.#add(own);
    }
    const durability = this.#durability;
    const results = await Promise.all(
      wraps.map((wrap) =>
        // 沒設定耐久度時照舊只傳一個參數（v0.32 的呼叫形狀）
        (durability === undefined ? this.#transport.publish(wrap) : this.#transport.publish(wrap, { durability })).catch(
          (): PublishResult => ({ accepted: [], rejected: [] }),
        ),
      ),
    );
    const rejections = results.map((result, i) => reportPublishRejections(wraps[i]!.id, result, this.#onPublishRejected));
    // 第一份是給對方的（`wrapDm` 最後一份才是給自己的）
    const first = results[0];
    const delivery = {
      accepted: [...(first?.accepted ?? [])],
      rejected: rejections[0] ?? [],
      ...(first?.durability !== undefined ? { durability: first.durability } : {}),
    };
    const failed = results.find((result) => !meetsDurability(result, durability));
    if (failed === undefined) return { ok: true, message: '', ...delivery };
    const reasons = failed.rejected.map((entry) => entry.reason).join('；');
    const message =
      durability !== undefined && (failed.accepted.length > 0 || failed.durability?.relaysFull === true) ? durabilityShortfall(failed, durability) : reasons || '沒有中繼站收下';
    return { ok: false, message, ...delivery };
  }

  /** 拿掉和某人的整段對話（封鎖時用） */
  forget(peer: string): void {
    if (!this.#loaded) this.#forgottenBeforeLoad.add(peer);
    this.#save(this.#threads.filter((thread) => thread.peer !== peer));
  }

  /**
   * 讀回舊對話。同步儲存在建構時就走到這裡（那時記憶體裡還沒有東西，結果與以前相同、也不寫回）。
   * 非同步儲存讀回之前可能已經收到新訊息或被 `forget`：把它們疊在讀回的紀錄上，再寫回一次。
   */
  #onLoaded(raw: string | null): void {
    this.#loaded = true;
    let next: readonly DmThread[] = parseThreads(raw).filter(
      (thread) => !this.#isBlocked(thread.peer) && !this.#forgottenBeforeLoad.has(thread.peer),
    );
    const changedBeforeLoad = this.#threads.length > 0 || this.#forgottenBeforeLoad.size > 0;
    for (const thread of this.#threads) {
      for (const line of thread.lines) next = withDm(next, { ...line, peer: thread.peer });
    }
    this.#forgottenBeforeLoad.clear();
    if (changedBeforeLoad) {
      this.#save(next);
    } else if (next.length > 0 || this.#listeners.size > 0) {
      this.#threads = next;
      for (const listener of this.#listeners) listener(next);
    }
  }

  #add(dm: ReceivedDm): void {
    if (this.#isBlocked(dm.peer)) {
      return;
    }
    const next = withDm(this.#threads, dm);
    if (next !== this.#threads) {
      this.#save(next);
    }
  }

  #save(next: readonly DmThread[]): void {
    this.#threads = next;
    // 存不進去（配額、隱私模式）就只留在記憶體。非同步儲存：排隊，輪到時寫當下最新的狀態
    this.#slot.save(() => JSON.stringify(this.#threads));
    for (const listener of this.#listeners) {
      listener(next);
    }
  }
}
