// 主動消息滑窗合併：手機推來的對話窗口可能比後端手上的舊。
//
// 典型情況：用戶在微信 / iMessage 和角色聊（聊天橋接直接寫進後端滑窗 + 推進 lastInteractionAt），
// 手機之後打開，還沒把那段對話拉回本地，就先把本地（舊）窗口推上來 → 整段覆蓋掉
// → 下一條主動消息看不到剛在微信聊的內容，而且「最後互動時間」倒退，聊天中途就開火。
//
// 規則：手機窗口為主；後端手上「比手機窗口最新一條還新、且帶時間戳」的訊息接在後面；
//       lastInteractionAt 不退到微信 / iMessage 最後一次對話之前。

import { PROACTIVE_WINDOW_CAP } from '../store/proactiveStore.js';

export function msgTs(m) {
    const t = m?.timestamp;
    if (typeof t === 'number' && Number.isFinite(t)) return t;
    const p = Date.parse(t || '');
    return Number.isFinite(p) ? p : 0;
}

const sameMsg = (a, b) => String(a?.sender) === String(b?.sender) && String(a?.text || '') === String(b?.text || '');

/**
 * @param {object|null} existing 後端現有記錄（可為空）
 * @param {Array} incoming 手機推來的窗口
 * @param {number} incomingLast 手機推來的 lastInteractionAt
 * @returns {{ recentMessages: Array, lastInteractionAt: number }}
 */
export function mergeIncomingWindow(existing, incoming, incomingLast) {
    const inc = Array.isArray(incoming) ? incoming : [];
    const prev = Array.isArray(existing?.recentMessages) ? existing.recentMessages : [];
    const incLatest = inc.reduce((mx, m) => Math.max(mx, msgTs(m)), 0);
    // 手機窗口裡完全沒有時間戳 → 無從比較，照舊以手機為準
    const newer = incLatest
        ? prev.filter((m) => msgTs(m) > incLatest && !inc.some((x) => sameMsg(x, m) && Math.abs(msgTs(x) - msgTs(m)) < 120000))
        : [];
    return {
        recentMessages: [...inc, ...newer].slice(-PROACTIVE_WINDOW_CAP),
        // 只保護聊天橋接記下的時間（bridgeInteractionAt）；後端自己發主動消息推進的那個照舊讓手機校正
        lastInteractionAt: Math.max(Number(incomingLast) || 0, Number(existing?.bridgeInteractionAt) || 0),
    };
}
