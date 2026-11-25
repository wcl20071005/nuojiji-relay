// 🔢 主动消息次数上限 ——「一段时间内最多主动找你几次」（用户在 App 角色后台活动名单里设）
//
// rec.sendCap   = { count, windowMs } | null       App 注册 / 同步时带来
// rec.appSends  = [ts]                              App 本机记的主动发送时间（含从中继领回的）
// rec.capSends  = [ts]                              中继自己发的（tick 成功生成后追加；注册不覆盖）
// 两份合并、两分钟内算同一次；滚动窗口内满 count 次 → 本轮不发（承诺 / 天气这类也一样挡）。

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 60 * DAY_MS;
const SAME_SEND_MS = 2 * 60 * 1000;

export function normalizeSendCap(cap) {
    if (!cap || typeof cap !== 'object') return null;
    const count = Math.floor(Number(cap.count));
    const windowMs = Number(cap.windowMs);
    if (!(count >= 1) || !(windowMs > 0)) return null;
    return { count, windowMs: Math.min(windowMs, MAX_WINDOW_MS) };
}

export function normalizeSendTimes(list, now = Date.now()) {
    if (!Array.isArray(list)) return [];
    return list.map(Number)
        .filter(ts => Number.isFinite(ts) && ts > 0 && now - ts < MAX_WINDOW_MS)
        .sort((a, b) => a - b)
        .slice(-200);
}

function merged(rec, now) {
    const all = [...normalizeSendTimes(rec.appSends, now), ...normalizeSendTimes(rec.capSends, now)].sort((a, b) => a - b);
    const out = [];
    for (const ts of all) {
        if (out.length && ts - out[out.length - 1] < SAME_SEND_MS) continue;
        out.push(ts);
    }
    return out;
}

/** true = 窗口内已发满，本轮不该再主动 */
export function isSendCapReached(rec, now = Date.now()) {
    const cap = normalizeSendCap(rec?.sendCap);
    if (!cap) return false;
    return merged(rec, now).filter(ts => now - ts < cap.windowMs).length >= cap.count;
}

/** 成功发出一条后要写回的 capSends（没设上限就不记，省 KV 写） */
export function nextCapSends(rec, now = Date.now()) {
    if (!normalizeSendCap(rec?.sendCap)) return undefined;
    return [...normalizeSendTimes(rec.capSends, now), now];
}
