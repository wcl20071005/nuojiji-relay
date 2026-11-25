// Node / VPS：每個 inbox 每種渠道一份核心（微信 / iMessage），存儲走 kvStore（memory / sqlite），排程走 setTimeout。
// 進程重啟後從索引把綁定過的重新拉起來。

import { WechatBridgeCore } from './bridgeCore.js';
import { ImessageBridgeCore } from '../imessage/imessageCore.js';
import { createKvStore } from '../store/kvStore.js';

const INDEX_KEY = 'wx:inboxes'; // 元素：'<inboxId>'（舊版，微信）或 'imessage|<inboxId>'
const bridges = new Map();      // `${kind}|${inboxId}` → slot

async function kvJson(kv, key) {
    const raw = await kv.get(key);
    if (raw == null) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
}

async function addToIndex(kv, entry) {
    const idx = (await kvJson(kv, INDEX_KEY)) || [];
    if (!idx.includes(entry)) { idx.push(entry); await kv.put(INDEX_KEY, JSON.stringify(idx)); }
}

export async function getNodeBridge(inboxId, kind = 'wechat') {
    const key = `${kind}|${inboxId}`;
    if (bridges.has(key)) return bridges.get(key).core;
    const kv = await createKvStore({});
    const prefix = kind === 'imessage' ? `im:${inboxId}:` : `wx:${inboxId}:`;
    const storage = {
        get: (k) => kvJson(kv, prefix + k),
        put: (k, v) => kv.put(prefix + k, JSON.stringify(v)),
        delete: (k) => kv.delete(prefix + k),
    };
    const slot = { core: null, timer: null, running: false, rerun: null };
    const schedule = (ms) => {
        clearTimeout(slot.timer);
        slot.timer = null;
        if (ms == null) return;
        slot.timer = setTimeout(async () => {
            slot.timer = null;
            // 上一輪還在跑（例如 AI 生成中又來了新訊息）→ 記下來，跑完立刻再排，不能丟
            if (slot.running) { slot.rerun = ms; return; }
            slot.running = true;
            let next = null;
            try { next = await slot.core.runOnce(); } catch (e) { console.warn(`[${kind}] node loop failed:`, e?.message); next = kind === 'wechat' ? 30000 : null; }
            slot.running = false;
            if (slot.rerun != null) { const r = slot.rerun; slot.rerun = null; schedule(next == null ? r : Math.min(next, r)); }
            else if (!slot.timer) schedule(next); // 跑的期間沒有人另外排過 → 照這輪的結果排下一輪
        }, Math.max(0, ms));
    };
    const Core = kind === 'imessage' ? ImessageBridgeCore : WechatBridgeCore;
    slot.core = new Core(storage, {}, { schedule: async (ms) => schedule(ms) });
    bridges.set(key, slot);
    await addToIndex(kv, kind === 'wechat' ? inboxId : `${kind}|${inboxId}`);
    return slot.core;
}

// 進程啟動時恢復：微信重新開始收訊息；iMessage 有沒回的訊息就補回
export async function resumeNodeBridges() {
    const kv = await createKvStore({});
    const idx = (await kvJson(kv, INDEX_KEY)) || [];
    for (const entry of idx) {
        const [kind, inboxId] = entry.includes('|') ? entry.split('|') : ['wechat', entry];
        const core = await getNodeBridge(inboxId, kind);
        if (kind === 'wechat') {
            const bind = await core.s.get('bind');
            if (bind && !bind.expired) await core.hooks.schedule(0);
        } else if (((await core.s.get('pending')) || []).length) {
            await core.hooks.schedule(0);
        }
    }
    return idx.length;
}
