import { readFileSync } from "node:fs";
import { workerRateLimitsFrom, WORKER_MAX_EVENTS_PER_MINUTE, WORKER_MAX_MESSAGES_PER_MINUTE } from "../../src/relay/host-config.js";
import { TIMESTAMP_JITTER_SECONDS } from "../../src/protocol/index.js";
import { describe, expect, it } from "vitest";
import { FILE_EVENT_MAX_BYTES } from "../../src/relay/message-store.js";
import { ABUSE_GUARD, APP_ADDRESSABLE_PER_AUTHOR, MAX_EVENTS_PER_MINUTE, MAX_MESSAGES_PER_MINUTE, messagesPerMinuteFrom, MAX_PAST_SKEW_SEC, APP_ADDRESSABLE_BYTES_PER_AUTHOR, APP_ADDRESSABLE_MAX_BYTES, DO_ADDRESSABLE_MAX_BYTES, DO_OFFLINE_MAX_BYTES, MAX_POW_DIFFICULTY, PUBLIC_LANE_ADDRESSABLE_BYTES_PER_AUTHOR, PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR, PUBLIC_LANE_RETENTION_SECONDS, STRICT_ADDRESSABLE_BYTES_PER_AUTHOR, TTL_CAP_DAYS, knownLanes, acceptFileEvents, FILE_CHUNK_PLAINTEXT_BYTES, FILE_LANE_OFFLINE_MAX_BYTES, FILE_LANE_QUOTA_SLACK_CHUNKS, fileChunksFor, fileLaneChunksPerRecipient, fileLanes, filePolicyFor, eventsPerMinuteFrom, firstHost, guardFor, inboxAckGraceFor, powForLane, storeOptions, ttlSecondsFromDays } from "../../src/relay/host-config.js";

// 宿主組裝設定（ADR-0235 H1）。H1 的教訓是「組裝層沒人測」——防護在 core 裡寫對了也測了，
// 但 worker 從未把參數傳進去。這裡把常數與衍生邏輯的**不變量**釘死，兩座宿主不可能各走各的。
describe("host-config：濫用防護不變量（ADR-0235 H1）", () => {
  it("🔴 過去時鐘窗必須大於 NIP-59 抖動窗——否則會擋掉幾乎每一則 Gift Wrap", () => {
    // 這是整組設定裡最容易踩、後果最嚴重的一條：對稱或過小的過去窗會讓外層時戳被往前推
    // 將近兩天的正常 Gift Wrap 全部被拒。留白一小時給實際時鐘誤差。
    expect(MAX_PAST_SKEW_SEC).toBeGreaterThan(TIMESTAMP_JITTER_SECONDS);
    expect(MAX_PAST_SKEW_SEC).toBe(TIMESTAMP_JITTER_SECONDS + 3600);
  });

  it("ABUSE_GUARD 帶齊四道防線（速率／訂閱數／時鐘窗／重放）", () => {
    expect(ABUSE_GUARD.maxEventsPerMinute).toBe(MAX_EVENTS_PER_MINUTE);
    expect(ABUSE_GUARD.maxSubscriptions).toBeGreaterThan(0);
    expect(ABUSE_GUARD.maxFutureSkewSec).toBeGreaterThan(0);
    expect(ABUSE_GUARD.maxPastSkewSec).toBe(MAX_PAST_SKEW_SEC);
    expect(ABUSE_GUARD.replayWindowSec).toBeGreaterThan(0);
    expect(ABUSE_GUARD.authMaxAgeSec).toBe(600);
  });
});

describe("host-config：TTL 天數 → 秒（ADR-0160）", () => {
  it("未設／壞值／<1 → undefined（store 用預設 7 天）", () => {
    expect(ttlSecondsFromDays(undefined)).toBeUndefined();
    expect(ttlSecondsFromDays("0")).toBeUndefined();
    expect(ttlSecondsFromDays("abc")).toBeUndefined();
    expect(ttlSecondsFromDays("-5")).toBeUndefined();
  });

  it("正常值換算成秒", () => {
    expect(ttlSecondsFromDays("90")).toBe(90 * 86_400);
    expect(ttlSecondsFromDays("1")).toBe(86_400);
  });

  it("🔴 超大值被 clamp（防 MAX_TTL_DAYS=99999 這類手誤產生實質無界保留）", () => {
    expect(ttlSecondsFromDays("99999")).toBe(TTL_CAP_DAYS * 86_400);
  });

  it("storeOptions 一律帶每收件人上限與每作者可尋址總量；TTL 依 env", () => {
    const base = {
      maxPerRecipient: 500,
      addressableBytesPerAuthor: STRICT_ADDRESSABLE_BYTES_PER_AUTHOR,
      addressableMaxTotalBytes: DO_ADDRESSABLE_MAX_BYTES,
      offlineMaxTotalBytes: DO_OFFLINE_MAX_BYTES,
    };
    expect(storeOptions(undefined)).toEqual(base);
    expect(storeOptions("90")).toEqual({ ...base, maxTtlSeconds: 90 * 86_400 });
  });
});

describe("host-config：檔案塊開關（ADR-0162）", () => {
  it("未設／<1／壞值 → false（公共站零儲存風險）", () => {
    expect(acceptFileEvents(undefined)).toBe(false);
    expect(acceptFileEvents("0")).toBe(false);
    expect(acceptFileEvents("abc")).toBe(false);
  });
  it("≥1 → true", () => {
    expect(acceptFileEvents("1")).toBe(true);
    expect(acceptFileEvents("16")).toBe(true);
  });
});

describe("host-config：速率覆寫（node 自架）", () => {
  it("未設 → 預設 120", () => {
    expect(eventsPerMinuteFrom(undefined)).toBe(MAX_EVENTS_PER_MINUTE);
  });
  it("壞值 → 預設 120（不因手誤把限制關掉）", () => {
    expect(eventsPerMinuteFrom("abc")).toBe(MAX_EVENTS_PER_MINUTE);
  });
  it("正整數 → 採用；0／負 → 明確關閉（undefined）", () => {
    expect(eventsPerMinuteFrom("300")).toBe(300);
    expect(eventsPerMinuteFrom("0")).toBeUndefined();
  });
});

describe("host-config：Worker 的速率覆寫（SDK ADR 0129）", () => {
  // ADR 0037：只能調高到上限、不能關掉——Cloudflare 以進站訊息計費，關掉就是把帳單交給任何一個連線
  it("未設 → 與 Node 相同的預設 120／240", () => {
    expect(workerRateLimitsFrom(undefined, undefined)).toEqual({ maxEventsPerMinute: 120, maxMessagesPerMinute: 240 });
  });
  it("調高 → 採用；訊息上限跟著不低於事件的兩倍", () => {
    expect(workerRateLimitsFrom("300", undefined)).toEqual({ maxEventsPerMinute: 300, maxMessagesPerMinute: 600 });
    expect(workerRateLimitsFrom("300", "400")).toEqual({ maxEventsPerMinute: 300, maxMessagesPerMinute: 600 });
    expect(workerRateLimitsFrom(undefined, "1000")).toEqual({ maxEventsPerMinute: 120, maxMessagesPerMinute: 1000 });
  });
  it("🔴 0、負數、低於預設、壞值 → 預設（不能關掉，也不往下調）", () => {
    for (const raw of ["0", "-5", "50", "abc", ""]) {
      expect(workerRateLimitsFrom(raw, raw)).toEqual({ maxEventsPerMinute: 120, maxMessagesPerMinute: 240 });
    }
  });
  it("🔴 超過上限 → 夾到上限", () => {
    expect(workerRateLimitsFrom("99999", "99999")).toEqual({
      maxEventsPerMinute: WORKER_MAX_EVENTS_PER_MINUTE,
      maxMessagesPerMinute: WORKER_MAX_MESSAGES_PER_MINUTE,
    });
    expect(WORKER_MAX_MESSAGES_PER_MINUTE).toBeGreaterThanOrEqual(WORKER_MAX_EVENTS_PER_MINUTE * 2);
  });
});

describe("host-config：主機正規化（ADR-0235 H2）", () => {
  it("小寫、去空白", () => {
    expect(firstHost("Relay.Example.com")).toBe("relay.example.com");
    expect(firstHost("  relay.example.com  ")).toBe("relay.example.com");
  });
  it("X-Forwarded-Host 逗號串取第一個（反向代理疊加）", () => {
    expect(firstHost("relay.example.com, internal:8787")).toBe("relay.example.com");
  });
  it("空／undefined → undefined（不強制 relay tag 檢查）", () => {
    expect(firstHost(undefined)).toBeUndefined();
    expect(firstHost("")).toBeUndefined();
    expect(firstHost("   ")).toBeUndefined();
  });
});

describe("車道政策（ADR-0366 §決策 5）", () => {
  it("嚴格＝今天的行為：要求 AUTH、不放寬訂閱", () => {
    const strict = guardFor("strict") as Record<string, unknown>;
    expect(strict.requireAuth).toBe(true);
    expect(strict.publicLane).toBeUndefined();
  });

  it("車道＝放寬訂閱、不要求 AUTH", () => {
    const app = guardFor("app") as Record<string, unknown>;
    expect(app.publicLane).toBe(true);
    expect(app.requireAuth).toBe(false);
  });

  it("🔴 兩份 profile **只差在這兩件事**——濫用防護一個數字都不准放寬", () => {
    // 這條不變量是 ADR-0366 §決策 5 的全部：放寬的只有「訂閱形狀」與「認證」。
    // 若哪天有人順手把車道的 maxEventsPerMinute 調高、或把事件大小上限放寬，
    // 這支測試會變紅——那正是它存在的理由。
    const strip = (o: Record<string, unknown>) => {
      const { requireAuth: _a, publicLane: _b, ...rest } = o;
      return rest;
    };
    expect(strip(guardFor("app") as Record<string, unknown>)).toEqual(
      strip(guardFor("strict") as Record<string, unknown>),
    );
    // 而且那份共同部分就是 ABUSE_GUARD 本身（兩座宿主的單一真實來源）。
    expect(strip(guardFor("app") as Record<string, unknown>)).toEqual({ ...ABUSE_GUARD });
  });
});

describe("store 選項依車道（ADR-0366 P1 #7）", () => {
  it("嚴格平面不帶可尋址配額覆寫（維持 ADR-0071 的 5）", () => {
    expect(storeOptions(undefined).addressablePerAuthor).toBeUndefined();
  });

  it("第三方車道放寬可尋址配額，但仍然有界", () => {
    // 名單上的已知租戶拿到量身訂的那個；公用車道的較保守版本見下面的 §裁示 describe。
    const opts = storeOptions(undefined, "app", true);
    expect(opts.addressablePerAuthor).toBe(APP_ADDRESSABLE_PER_AUTHOR);
    expect(opts.addressablePerAuthor).toBeGreaterThan(5);
    expect(Number.isFinite(opts.addressablePerAuthor)).toBe(true);
  });

  it("每收件人上限不因車道改變；TTL 只有公用分片會縮短（ADR-0367 §決策 1）", () => {
    const strict = storeOptions("90");
    const known = storeOptions("90", "app", true);
    expect(known.maxPerRecipient).toBe(strict.maxPerRecipient);
    expect(known.maxTtlSeconds).toBe(strict.maxTtlSeconds);
    // 公用分片（陌生應用）改為見習保存——名單上的車道不受影響
    expect(storeOptions("90", "app", false).maxTtlSeconds).toBe(PUBLIC_LANE_RETENTION_SECONDS);
  });
});

describe("node-relay 是單一 profile 且恆為嚴格（ADR-0366 §決策 8 ／ P1 #10）", () => {
  /**
   * node-relay 的原始碼，**去掉註解**。
   *
   * 註解要查得出這條規則的理由（那份說明本身就會提到 `APP_LANE_GUARD`），
   * 所以比對的必須是程式碼——不然這支測試會被自己要求寫的那段說明咬到。
   */
  const SRC = readFileSync(new URL("../../src/relay/node-relay.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("🔴 程式碼不得帶進車道政策——自架站升版不該默默變成公共站", () => {
    // 這條的症狀是「沒有症狀」：站照常跑，只是訂閱規則悄悄放寬了。
    // 與 `wrangler-vars.test.ts` 同一種做法——把「已知風險」變成會變紅的東西。
    expect(SRC).not.toContain("APP_LANE_GUARD");
    expect(SRC).not.toContain("publicLane");
    expect(SRC).not.toMatch(/guardFor\((?!"strict")/);
  });

  it("政策取自 host-config 的 SSOT，而不是另抄一份常數", () => {
    expect(SRC).toContain('guardFor("strict")');
    expect(SRC).not.toContain("...ABUSE_GUARD");
  });

  it("🔴 檔案政策走同一個 filePolicyFor（Cinderous ADR-0371）：沒有車道 ⇒ 設了 FILE_LANES 就整站不收", () => {
    // node 主機沒有路徑路由，所以永遠以「不是任何車道」去問——車道模式下答案必然是拒收，
    // 與 Cloudflare 版的主訊息平面一致。直接讀 MAX_FILE_MB 就會繞過 FILE_LANES。
    expect(SRC).toContain("filePolicyFor(env)");
    expect(SRC).not.toMatch(/acceptFileEvents\(/);
  });
});

describe("PoW 難度依車道（ADR-0366 P2 #11）", () => {
  it("🔴 嚴格平面恆為 0——那不是設定，是事實（本專案的現有安裝不會挖礦）", () => {
    expect(powForLane("strict", "20")).toBe(0);
    expect(powForLane("strict", undefined)).toBe(0);
  });

  it("🔴 第三方車道**預設也是 0**——《元素使》已有能跑的客戶端，今天打開會弄壞它", () => {
    expect(powForLane("app", undefined)).toBe(0);
    expect(powForLane("app", "")).toBe(0);
    expect(powForLane("app", "0")).toBe(0);
  });

  it("設定後生效，且夾在可挖得動的範圍內", () => {
    expect(powForLane("app", "16")).toBe(16);
    expect(powForLane("app", "999")).toBe(MAX_POW_DIFFICULTY);
    expect(powForLane("app", "8.9")).toBe(8);
  });

  it("壞值當成不要求，而不是當成很高（fail-open 在這裡才是對的）", () => {
    // 設錯一個字就把整條車道鎖死，比「防護沒開」難查得多——而防護沒開是看得出來的。
    expect(powForLane("app", "abc")).toBe(0);
    expect(powForLane("app", "-5")).toBe(0);
  });

  it("guardFor 本身不帶 PoW——env 的讀取留在宿主（同 eventsPerMinuteFrom 的做法）", () => {
    expect((guardFor("app") as Record<string, unknown>).minPowDifficulty).toBeUndefined();
    expect((guardFor("strict") as Record<string, unknown>).minPowDifficulty).toBeUndefined();
  });
});

describe("訊息速率上限（ADR-0366 §容量）", () => {
  it("🔴 必須大於事件上限，否則等於偷偷把事件上限改小", () => {
    // 檔案分塊上傳是連續的 EVENT（ADR-0162）；訊息上限若低於事件上限，
    // 發事件的人會先撞到訊息上限並被關線——而那條的訊息會寫「rate-limited」，
    // 與「事件太多」是兩種完全不同的診斷。
    expect(MAX_MESSAGES_PER_MINUTE).toBeGreaterThan(MAX_EVENTS_PER_MINUTE);
  });

  it("自架站把事件上限調高時，訊息上限跟著抬——否則等於沒調到", () => {
    // `MAX_EVENTS_PER_MINUTE=1000` 的自架者如果還被 240 則訊息夾住，
    // 他調的那個數字就是假的，而且症狀是「事件被擋，訊息卻說 rate-limited」。
    expect(messagesPerMinuteFrom(undefined, 1000)).toBeGreaterThanOrEqual(1000);
    expect(messagesPerMinuteFrom(undefined, undefined)).toBe(MAX_MESSAGES_PER_MINUTE);
    expect(messagesPerMinuteFrom(undefined, MAX_EVENTS_PER_MINUTE)).toBe(MAX_MESSAGES_PER_MINUTE);
    // 明示覆寫仍受同一條規則約束
    expect(messagesPerMinuteFrom("300", 1000)).toBeGreaterThanOrEqual(1000);
    expect(messagesPerMinuteFrom("600", undefined)).toBe(600);
    // <1＝關掉（與事件上限同一套語意）
    expect(messagesPerMinuteFrom("0", 1000)).toBeUndefined();
    expect(messagesPerMinuteFrom("亂寫", undefined)).toBe(MAX_MESSAGES_PER_MINUTE);
  });

  it("兩種 profile 都吃同一個上限——它是濫用防護，不是車道政策", () => {
    for (const profile of ["strict", "app"] as const) {
      expect(guardFor(profile).maxMessagesPerMinute, profile).toBe(MAX_MESSAGES_PER_MINUTE);
    }
  });
});

describe("已知租戶名單（ADR-0366 §裁示）", () => {
  it("逗號分隔、去空白、小寫；未設或空字串＝沒有已知租戶", () => {
    expect([...knownLanes("lwd, Elementalist ,, nagd")]).toEqual(["lwd", "elementalist", "nagd"]);
    expect(knownLanes(undefined).size).toBe(0);
    expect(knownLanes("   ").size).toBe(0);
  });

  it("名單上的車道拿到量身訂的配額，公用車道拿到較保守的那個", () => {
    expect(storeOptions(undefined, "app", true).addressablePerAuthor).toBe(
      APP_ADDRESSABLE_PER_AUTHOR,
    );
    expect(storeOptions(undefined, "app", false).addressablePerAuthor).toBe(
      PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR,
    );
    // 🔴 預設是公用配額：漏傳參數時給出的是**比較小**的那個，而不是把 64 送給陌生人
    expect(storeOptions(undefined, "app").addressablePerAuthor).toBe(
      PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR,
    );
  });

  it("公用配額必須小於已知租戶配額，且仍大於嚴格平面的裝置數配額", () => {
    expect(PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR).toBeLessThan(APP_ADDRESSABLE_PER_AUTHOR);
    // 嚴格平面不設此選項（沿用 message-store 的 5）——公用車道不該比它還緊，
    // 否則「車道比較寬鬆」這個前提在儲存面就不成立了。
    expect(PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR).toBeGreaterThan(5);
  });

  it("嚴格平面不受名單影響", () => {
    for (const known of [true, false]) {
      expect(storeOptions(undefined, "strict", known).addressablePerAuthor).toBeUndefined();
    }
  });
});

describe("可尋址的兩道容量閘（ADR-0366 §容量二）", () => {
  it("車道的單顆上限縮小；嚴格平面維持 256KB（那是雲端快照的尺寸）", () => {
    expect(storeOptions(undefined, "app", true).addressableMaxBytes).toBe(APP_ADDRESSABLE_MAX_BYTES);
    expect(storeOptions(undefined, "app", false).addressableMaxBytes).toBe(
      APP_ADDRESSABLE_MAX_BYTES,
    );
    // 嚴格平面不設＝沿用 message-store 的 256KB，ADR-0071 的快照照舊放得下
    expect(storeOptions(undefined, "strict").addressableMaxBytes).toBeUndefined();
  });

  it("🔴 三種情境都有每作者總量上限——沒有它，位址配額實際上是無界的", () => {
    expect(storeOptions(undefined, "strict").addressableBytesPerAuthor).toBe(
      STRICT_ADDRESSABLE_BYTES_PER_AUTHOR,
    );
    expect(storeOptions(undefined, "app", true).addressableBytesPerAuthor).toBe(
      APP_ADDRESSABLE_BYTES_PER_AUTHOR,
    );
    expect(storeOptions(undefined, "app", false).addressableBytesPerAuthor).toBe(
      PUBLIC_LANE_ADDRESSABLE_BYTES_PER_AUTHOR,
    );
  });

  it("總量預算必須容得下該情境「位址數 × 單顆上限」的一個 kind，否則計數配額形同虛設", () => {
    // 若預算比「一個 kind 塞滿」還小，玩家會在第一個 kind 就撞牆，而錯誤訊息會指向
    // 總量——那是兩種完全不同的診斷。
    expect(APP_ADDRESSABLE_BYTES_PER_AUTHOR).toBeGreaterThanOrEqual(
      APP_ADDRESSABLE_PER_AUTHOR * APP_ADDRESSABLE_MAX_BYTES,
    );
    expect(PUBLIC_LANE_ADDRESSABLE_BYTES_PER_AUTHOR).toBeGreaterThanOrEqual(
      PUBLIC_LANE_ADDRESSABLE_PER_AUTHOR * APP_ADDRESSABLE_MAX_BYTES,
    );
    // 嚴格平面：ADR-0071 的 5 台裝置 × 256KB 必須放得下
    expect(STRICT_ADDRESSABLE_BYTES_PER_AUTHOR).toBeGreaterThan(5 * 262_144);
  });
});

describe("公用分片的短保存（ADR-0367 §決策 1）", () => {
  it("🔴 只有公用分片縮短：名單上的車道與嚴格平面一個字都不動", () => {
    const publicLane = storeOptions(undefined, "app", false);
    expect(publicLane.addressableTtlSeconds).toBe(PUBLIC_LANE_RETENTION_SECONDS);
    expect(publicLane.maxTtlSeconds).toBe(PUBLIC_LANE_RETENTION_SECONDS);

    // 名單上的車道：維持預設（可尋址 30 天由 message-store 預設、留言由 env）
    const known = storeOptions(undefined, "app", true);
    expect(known.addressableTtlSeconds).toBeUndefined();
    expect(known.maxTtlSeconds).toBeUndefined();

    // 嚴格平面：ADR-0071 的契約不動
    const strict = storeOptions("90", "strict");
    expect(strict.addressableTtlSeconds).toBeUndefined();
    expect(strict.maxTtlSeconds).toBe(90 * 86_400);
  });

  it("站方把 TTL 設得比見習期還短時，取比較短的那個——站方上限恆為權威", () => {
    // `MAX_TTL_DAYS` 不可能小於一天，用秒數直接驗邏輯：公用分片取 min(站方, 見習期)
    expect(storeOptions("1", "app", false).maxTtlSeconds).toBe(
      Math.min(86_400, PUBLIC_LANE_RETENTION_SECONDS),
    );
  });

  it("見習期要短到讓穩態水位有界，但不要短到正常瀏覽都來不及", () => {
    expect(PUBLIC_LANE_RETENTION_SECONDS).toBe(2 * 60 * 60);
    // 穩態 ≈ 寫入速率 × 見習期。以車道單顆 32KB × 每連線 240 則/分計：
    const bytesPerMinute = MAX_MESSAGES_PER_MINUTE * APP_ADDRESSABLE_MAX_BYTES;
    const steadyState = (bytesPerMinute * PUBLIC_LANE_RETENTION_SECONDS) / 60;
    expect(steadyState).toBeLessThan(1024 ** 3); // 一條連線的穩態水位 < 1GB
  });
});

describe("DO 容量天花板（ADR-0367 §決策 2）", () => {
  it("三種情境都有天花板，但只有車道會淘汰", () => {
    for (const opts of [
      storeOptions(undefined, "app", true),
      storeOptions(undefined, "app", false),
      storeOptions(undefined, "strict"),
    ]) {
      expect(opts.addressableMaxTotalBytes).toBe(DO_ADDRESSABLE_MAX_BYTES);
    }
    expect(storeOptions(undefined, "app", true).ceilingEvicts).toBe(true);
    expect(storeOptions(undefined, "app", false).ceilingEvicts).toBe(true);
    // 🔴 嚴格平面不淘汰：刪別人的加密備份不可逆，拒收看得見
    expect(storeOptions(undefined, "strict").ceilingEvicts).toBeUndefined();
  });

  it("離線留言也有天花板——`p`-less 事件那個桶原本連 FIFO 都沒有", () => {
    for (const opts of [
      storeOptions(undefined, "app", true),
      storeOptions(undefined, "app", false),
      storeOptions(undefined, "strict"),
    ]) {
      expect(opts.offlineMaxTotalBytes).toBe(DO_OFFLINE_MAX_BYTES);
    }
  });

  it("天花板必須遠大於單一作者的總量預算，否則一個人就能佔滿整顆 DO", () => {
    expect(DO_ADDRESSABLE_MAX_BYTES).toBeGreaterThanOrEqual(8 * STRICT_ADDRESSABLE_BYTES_PER_AUTHOR);
  });
});

describe("檔案車道（FILE_LANES，ADR-0371）", () => {
  const LANES = "lwd,cindersync,cinder-coffice";

  it("30MB ≈ 656 塊（48,000 B 明文／塊）；配額＝兩個最大檔＋餘裕", () => {
    expect(FILE_CHUNK_PLAINTEXT_BYTES).toBe(48_000);
    expect(fileChunksFor(30)).toBe(656);
    expect(fileLaneChunksPerRecipient(30)).toBe(2 * 656 + FILE_LANE_QUOTA_SLACK_CHUNKS);
    expect(fileLaneChunksPerRecipient(30)).toBe(1440);
    // 🔴 至少容得下一個上限檔——否則上傳到一半，FIFO 就把自己的第一塊擠掉了
    expect(fileLaneChunksPerRecipient(30)).toBeGreaterThanOrEqual(fileChunksFor(30));
  });

  it("🔴 沒設 FILE_LANES＝與過去完全相同：MAX_FILE_MB 是全站開關，不宣告單檔上限", () => {
    const env = { MAX_FILE_MB: "30", APP_LANES: LANES };
    expect(filePolicyFor(env)).toEqual({ accept: true }); // 嚴格平面／共用分片
    expect(filePolicyFor(env, "cindersync")).toEqual({ accept: true });
    expect(filePolicyFor({ APP_LANES: LANES }, "cindersync")).toEqual({ accept: false });
    // 空白字串視同未設（wrangler var 寫成空字串是常見的「關掉」寫法）
    expect(filePolicyFor({ ...env, FILE_LANES: "  " })).toEqual({ accept: true });
  });

  it("設了 FILE_LANES：只有名單上的車道收，且宣告單檔上限", () => {
    const env = { MAX_FILE_MB: "30", APP_LANES: LANES, FILE_LANES: "cindersync, Cinder-Coffice" };
    expect(filePolicyFor(env, "cindersync")).toEqual({ accept: true, maxFileMb: 30 });
    expect(filePolicyFor(env, "cinder-coffice")).toEqual({ accept: true, maxFileMb: 30 });
    // 🔴 主訊息平面（嚴格平面、共用分片都傳 undefined）與其他車道一律整類拒收
    expect(filePolicyFor(env)).toEqual({ accept: false });
    expect(filePolicyFor(env, "lwd")).toEqual({ accept: false });
  });

  it("FILE_LANES 有設但 MAX_FILE_MB 沒設 → 哪裡都不收（MAX_FILE_MB 仍是總開關）", () => {
    expect(filePolicyFor({ APP_LANES: LANES, FILE_LANES: "cindersync" }, "cindersync")).toEqual({
      accept: false,
    });
  });

  it("🔴 不在 APP_LANES 上的 id 被忽略並回報——它沒有自己的 DO，開了就等於開給共用分片", () => {
    const env = { MAX_FILE_MB: "30", APP_LANES: "lwd", FILE_LANES: "cindersync,lwd" };
    expect(fileLanes(env)).toEqual({ active: new Set(["lwd"]), ignored: ["cindersync"] });
    expect(filePolicyFor(env, "cindersync")).toEqual({ accept: false });
    expect(filePolicyFor(env, "lwd")).toEqual({ accept: true, maxFileMb: 30 });
  });

  it("全部 id 都無效 → 仍是車道模式（fail-closed），不會退回全站開放", () => {
    const env = { MAX_FILE_MB: "30", APP_LANES: "lwd", FILE_LANES: "nope" };
    expect(filePolicyFor(env)).toEqual({ accept: false });
    expect(filePolicyFor(env, "lwd")).toEqual({ accept: false });
  });

  it("store 選項：檔案車道用自己的檔案配額與 DO 天花板；沒給就與過去相同", () => {
    const lane = storeOptions(undefined, "app", true, 30);
    expect(lane.filePerRecipient).toBe(1440);
    expect(lane.offlineMaxTotalBytes).toBe(FILE_LANE_OFFLINE_MAX_BYTES);
    // 保存期不變（7 天）：Vault 同步的離線容忍度與聊天一致
    expect(lane.maxTtlSeconds).toBeUndefined();
    expect(storeOptions(undefined, "app", true)).toEqual(storeOptions(undefined, "app", true, undefined));
    expect(storeOptions(undefined, "app", true).filePerRecipient).toBeUndefined();
  });

  it("DO 天花板至少容得下幾位收件人的整份配額（否則一個人的同步就會把別人淘汰）", () => {
    // 每顆塊事件約 131KB（48,000 B 包兩層 NIP-44）；以 FILE_EVENT_MAX_BYTES 當最壞情況。
    const perRecipientWorst = fileLaneChunksPerRecipient(30) * FILE_EVENT_MAX_BYTES;
    expect(FILE_LANE_OFFLINE_MAX_BYTES).toBeGreaterThanOrEqual(3 * perRecipientWorst);
    // 🔴 兩條檔案車道的天花板加起來必須遠低於 DO SQLite 免費額度（5GB，帳號層級共用）
    expect(2 * FILE_LANE_OFFLINE_MAX_BYTES).toBeLessThanOrEqual(2.5 * 1024 ** 3);
  });
});

describe("收件確認的寬限（SDK ADR 0067）", () => {
  it("比照未註冊應用的保存期（SSOT：同一個常數）", () => {
    expect(inboxAckGraceFor(storeOptions(undefined))).toBe(PUBLIC_LANE_RETENTION_SECONDS);
    expect(inboxAckGraceFor(storeOptions("90"))).toBe(PUBLIC_LANE_RETENTION_SECONDS);
  });

  it("站方保存上限更短時取站方上限（ADR-0160：站方上限恆為權威）", () => {
    expect(inboxAckGraceFor({ maxTtlSeconds: 600 })).toBe(600);
  });
});
