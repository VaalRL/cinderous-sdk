/** 預設上限（含自己）。理由見 SDK ADR 0141 的頻寬估算：4 人視訊時每人上傳 3 份 */
export const GROUP_CALL_DEFAULT_MAX = 4;
/** 硬上限（含自己）：網狀拓撲每人上傳 N−1 份，6 人以上連標準畫質也要 3 Mbps 上傳，行動網路撐不住 */
export const GROUP_CALL_HARD_MAX = 6;
/** 群組信令版本 */
export const GROUP_CALL_VERSION = 1;
/** 這一對裡由誰發 offer：字典序較小的 pubkey */
export function groupCallOfferer(a, b) {
    return a < b ? a : b;
}
const HEX64 = /^[0-9a-f]{64}$/;
const GROUP_ID = /^[0-9a-f]{32,64}$/;
const MAX_SDP = 64 * 1024;
function members(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > GROUP_CALL_HARD_MAX)
        throw new Error('群組通話成員名單非法');
    for (const m of value)
        if (typeof m !== 'string' || !HEX64.test(m))
            throw new Error('群組通話成員不是 64 個小寫 hex');
    if (new Set(value).size !== value.length)
        throw new Error('群組通話成員重複');
    return [...value];
}
function media(value) {
    if (value !== 'audio' && value !== 'video')
        throw new Error('群組通話 media 非法');
    return value;
}
function sdp(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SDP)
        throw new Error('群組通話 sdp 非法');
    return value;
}
/** 解析並驗證群組通話信令（信任邊界）。不是群組信令、版本不對或欄位非法一律丟例外。 */
export function parseGroupCallSignal(content) {
    const value = JSON.parse(content);
    if (typeof value !== 'object' || value === null)
        throw new Error('群組通話信令格式錯誤：非物件');
    const s = value;
    if (s.v !== GROUP_CALL_VERSION)
        throw new Error('群組通話信令版本不支援');
    if (typeof s.groupId !== 'string' || !GROUP_ID.test(s.groupId))
        throw new Error('群組通話信令 groupId 非法');
    const base = { v: 1, groupId: s.groupId };
    switch (s.type) {
        case 'group-invite':
            return { ...base, type: 'group-invite', media: media(s.media), members: members(s.members) };
        case 'group-join':
            return { ...base, type: 'group-join', members: members(s.members), ...(s.ack === true ? { ack: true } : {}) };
        case 'group-decline':
            if (s.reason !== 'declined' && s.reason !== 'busy' && s.reason !== 'full')
                throw new Error('group-decline reason 非法');
            return { ...base, type: 'group-decline', reason: s.reason };
        case 'group-leave':
            return { ...base, type: 'group-leave' };
        case 'group-members':
            return { ...base, type: 'group-members', members: members(s.members) };
        case 'group-offer':
            return { ...base, type: 'group-offer', sdp: sdp(s.sdp), media: media(s.media) };
        case 'group-answer':
            return { ...base, type: 'group-answer', sdp: sdp(s.sdp), media: media(s.media) };
        case 'group-candidate': {
            if (typeof s.candidate !== 'string' || s.candidate.length > 4096)
                throw new Error('group-candidate 缺少 candidate');
            const out = { ...base, type: 'group-candidate', candidate: s.candidate };
            if (typeof s.sdpMid === 'string')
                out.sdpMid = s.sdpMid;
            if (typeof s.sdpMLineIndex === 'number')
                out.sdpMLineIndex = s.sdpMLineIndex;
            return out;
        }
        case 'group-media':
            return { ...base, type: 'group-media', media: media(s.media) };
        default:
            throw new Error(`未知群組通話信令類型：${String(s.type)}`);
    }
}
//# sourceMappingURL=group-call.js.map