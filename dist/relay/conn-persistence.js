/**
 * 連線狀態的休眠持久化（ADR-0059 → Cinderous ADR-0373）。
 *
 * ## 為什麼不能只靠 WebSocket attachment
 *
 * Cloudflare 規定 `serializeAttachment` 序列化後最多 **16,384 bytes**。一把 pubkey 在 filter 裡約
 * 67 bytes ⇒ 同一條連線的 `authors` 合計約 240 把就超過，`serializeAttachment` 直接拋例外——
 * 在 `webSocketMessage` 裡那是**未捕捉例外**：客戶端什麼都收不到，訂閱只留在記憶體，
 * DO 休眠喚醒後消失。而 App 的心跳訂閱正是 `{kinds:[20000], authors:[全部聯絡人]}`。
 *
 * ## 混合策略
 *
 * - **小的訂閱照舊放 attachment**（讀寫免費、喚醒時不必讀 storage——ADR-0059 選 attachment 的理由不變）。
 * - 放不下的訂閱**溢位到 DO SQLite 的 `ws_subs` 表**（鍵＝連線 id ＋訂閱 id），attachment 只記它們的訂閱 id。
 * - 放置規則與插入順序無關（由小到大塞滿預算），所以喚醒還原後再存一次**不會**搬來搬去。
 * - 只有內容真的變了才寫：心跳 EVENT 之類不改訂閱的訊息**零寫入**，也不重做 `serializeAttachment`。
 * - 每連線訂閱合計上限 {@link MAX_CONN_SUB_BYTES}：超過的（新／改的那幾條）由呼叫方回 `CLOSED`，不靜默。
 */
/** Cloudflare 的 attachment 上限（序列化後位元組）。 */
export const ATTACHMENT_MAX_BYTES = 16_384;
/**
 * 放進 attachment 的訂閱 JSON 預算。刻意比 16KB 低一截：attachment 是 structured clone 不是 JSON，
 * 實測兩者只差幾十 bytes（260 把 authors：JSON 17,462、attachment 17,435），但連線 id、挑戰、
 * pubkey、主機與溢位清單也要放進去——留 4KB 餘裕，寧可多溢位一條也不要撞上限。
 */
export const INLINE_BUDGET_BYTES = 12 * 1024;
/**
 * 每連線可持久化的訂閱合計上限（filter JSON 位元組）。
 *
 * 1024 把 authors（ADR-0123 的上限）一條約 70KB；512KiB 可容 7 條那樣的訂閱，遠超真實用量。
 * 沒有這一道的話，一條連線 16 條訂閱 × 384KB 訊息上限 ≈ 6MB 會落進 DO storage。
 */
export const MAX_CONN_SUB_BYTES = 512 * 1024;
export class ConnPersistence {
    sql;
    persisted = new Map();
    constructor(sql) {
        this.sql = sql;
        this.sql(`CREATE TABLE IF NOT EXISTS ws_subs (
        conn_id TEXT NOT NULL,
        sub_id  TEXT NOT NULL,
        filters TEXT NOT NULL,
        PRIMARY KEY (conn_id, sub_id)
      )`);
    }
    /**
     * 把某連線的最新狀態存起來；沒變就什麼都不做。
     *
     * 不拋例外：任何失敗都轉成 `rejected`，由呼叫方關掉那些訂閱並告訴客戶端。
     */
    save(ws, snap) {
        const prev = this.persisted.get(snap.connId);
        const sized = snap.subs.map((s) => ({ ...s, json: JSON.stringify(s.filters) }));
        const changed = (s) => prev?.subs.get(s.subId) !== s.json;
        const rejected = [];
        // ① 合計上限：只砍「這次新增或改過」的，由大到小——沒變過的之前已經存好了，不該被新來的擠掉。
        let total = sized.reduce((n, s) => n + s.json.length, 0);
        if (total > MAX_CONN_SUB_BYTES) {
            for (const c of sized.filter(changed).sort((a, b) => b.json.length - a.json.length)) {
                if (total <= MAX_CONN_SUB_BYTES)
                    break;
                rejected.push({ subId: c.subId, reason: "too-large" });
                total -= c.json.length;
            }
        }
        const dropped = new Set(rejected.map((r) => r.subId));
        const kept = sized.filter((s) => !dropped.has(s.subId));
        try {
            this.write(ws, snap, kept, prev);
        }
        catch (err) {
            // 🔴 不可以吞掉：訂閱還在記憶體裡、看起來能用，休眠一次就消失——正是本 ADR 要消滅的那種靜默失敗。
            // 「已持久化」維持上一次成功的狀態；呼叫方關掉這些訂閱後會再存一次。
            console.error(`ws 訂閱持久化失敗 conn=${snap.connId}（Cinderous ADR-0373）`, err);
            for (const s of kept.filter(changed))
                rejected.push({ subId: s.subId, reason: "persist-failed" });
        }
        return { rejected };
    }
    write(ws, snap, subs, prev) {
        // ② 放置：由小到大塞進 attachment 預算，其餘溢位。與插入順序無關 ⇒ 還原後重存不會搬家。
        const head = JSON.stringify({ ...snap, subs: [] }).length;
        let budget = INLINE_BUDGET_BYTES - head;
        const inline = [];
        const spill = new Map();
        const bySize = [...subs].sort((a, b) => a.json.length - b.json.length || (a.subId < b.subId ? -1 : 1));
        for (const s of bySize) {
            // subId 本身也佔空間；每條再算 32 bytes 的 JSON 框架。
            const cost = s.json.length + s.subId.length + 32;
            if (cost <= budget) {
                inline.push({ subId: s.subId, filters: s.filters });
                budget -= cost;
            }
            else {
                spill.set(s.subId, s.json);
            }
        }
        const attachment = {
            ...snap,
            subs: inline,
            ...(spill.size > 0 ? { spilled: [...spill.keys()].sort() } : {}),
        };
        const attachmentJson = JSON.stringify(attachment);
        // ③ 先寫溢位列，再寫 attachment，最後刪不再溢位的列：中途失敗最多留下孤兒列（喚醒時清），
        //    不會出現「attachment 指著一條不存在的列」。
        for (const [subId, json] of spill) {
            if (prev?.spilled.has(subId) && prev.subs.get(subId) === json)
                continue;
            this.sql(`INSERT INTO ws_subs (conn_id, sub_id, filters) VALUES (?, ?, ?)
         ON CONFLICT(conn_id, sub_id) DO UPDATE SET filters = excluded.filters`, snap.connId, subId, json);
        }
        if (prev?.attachment !== attachmentJson)
            ws.serializeAttachment(attachment);
        for (const subId of prev?.spilled ?? []) {
            if (!spill.has(subId))
                this.sql(`DELETE FROM ws_subs WHERE conn_id = ? AND sub_id = ?`, snap.connId, subId);
        }
        this.persisted.set(snap.connId, {
            attachment: attachmentJson,
            subs: new Map(subs.map((s) => [s.subId, s.json])),
            spilled: new Set(spill.keys()),
        });
    }
    /** 連線結束：清掉它的溢位列（有才刪——刪除也計入寫入列數）。 */
    remove(connId) {
        const prev = this.persisted.get(connId);
        this.persisted.delete(connId);
        if (prev && prev.spilled.size > 0) {
            try {
                this.sql(`DELETE FROM ws_subs WHERE conn_id = ?`, connId);
            }
            catch (err) {
                // 留下的是孤兒列，下次喚醒還原時會被清掉；不值得讓 close handler 拋出去。
                console.error(`ws 訂閱溢位列清除失敗 conn=${connId}（Cinderous ADR-0373）`, err);
            }
        }
    }
    /**
     * 喚醒還原：讀所有存活連線的 attachment，補回溢位的訂閱，並**清掉孤兒列**
     *（連線已不在——例如部署重啟時 `webSocketClose` 沒被呼叫——或 attachment 已不再指著它）。
     *
     * 只有 attachment 記著溢位時才碰 storage：一般情況（沒有大訂閱）喚醒仍然零讀取（ADR-0059）。
     */
    load(sockets) {
        this.persisted.clear();
        const atts = [];
        for (const ws of sockets) {
            const att = ws.deserializeAttachment();
            if (att?.connId)
                atts.push(att);
        }
        const rows = this.readRows(atts);
        const snapshots = [];
        const lost = [];
        const referenced = new Set();
        for (const att of atts) {
            const { spilled: spilledIds, ...rest } = att;
            const subs = [...att.subs];
            const spill = new Map();
            const lostHere = lost.length;
            for (const subId of spilledIds ?? []) {
                const key = rowKey(att.connId, subId);
                const json = rows.get(key);
                if (json === undefined) {
                    lost.push({ connId: att.connId, subId });
                    continue;
                }
                referenced.add(key);
                spill.set(subId, json);
                subs.push({ subId, filters: JSON.parse(json) });
            }
            snapshots.push({ ...rest, subs });
            this.persisted.set(att.connId, {
                // 有遺失的 ⇒ 記成空字串，逼下一次 save 重寫 attachment，把溢位清單更正過來。
                attachment: lost.length > lostHere ? "" : JSON.stringify(att),
                subs: new Map([
                    ...att.subs.map((s) => [s.subId, JSON.stringify(s.filters)]),
                    ...spill,
                ]),
                spilled: new Set(spill.keys()),
            });
        }
        for (const key of rows.keys()) {
            if (referenced.has(key))
                continue;
            const [connId, subId] = JSON.parse(key);
            try {
                this.sql(`DELETE FROM ws_subs WHERE conn_id = ? AND sub_id = ?`, connId, subId);
            }
            catch (err) {
                console.error(`ws 訂閱孤兒列清除失敗（Cinderous ADR-0373）`, err);
            }
        }
        return { snapshots, lost };
    }
    /**
     * 讀溢位列。有任何 attachment 記著溢位就讀整張表（順便找出孤兒）；
     * 否則只問「表裡有沒有東西」——有就代表有孤兒要清，沒有就到此為止。
     */
    readRows(atts) {
        const out = new Map();
        try {
            const anySpilled = atts.some((a) => (a.spilled?.length ?? 0) > 0);
            if (!anySpilled && this.sql(`SELECT 1 AS x FROM ws_subs LIMIT 1`).length === 0)
                return out;
            for (const r of this.sql(`SELECT conn_id, sub_id, filters FROM ws_subs`)) {
                out.set(rowKey(String(r.conn_id), String(r.sub_id)), String(r.filters));
            }
        }
        catch (err) {
            console.error(`ws 訂閱溢位列讀取失敗（Cinderous ADR-0373）`, err);
        }
        return out;
    }
}
function rowKey(connId, subId) {
    return JSON.stringify([connId, subId]);
}
//# sourceMappingURL=conn-persistence.js.map