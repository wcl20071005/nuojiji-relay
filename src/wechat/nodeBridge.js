// Node / VPS：每個 inbox 一份 WechatBridgeCore，存儲走 kvStore（memory / sqlite），排程走 setTimeout。
// 進程重啟後從 wx:inboxes 索引把綁定過的 inbox 迴圈重新拉起來。

import { WechatBridgeCore } from './bridgeCore.js';
import { createKvStore } from '../store/kvStore.js';

const INDEX_KEY = 'wx:inboxes';
const bridges = new Map(); // inboxId → { core, timer, running }

async function kvJson(kv, key) {
    const raw = await kv.get(key);
    if (raw == null) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
}

async function addToIndex(kv, inboxId) {
    const idx = (await kvJson(kv, INDEX_KEY)) || [];
    if (!idx.includes(inboxId)) { idx.push(inboxId); await kv.put(INDEX_KEY, JSON.stringify(idx)); }
}

export async function getNodeBridge(inboxId) {
    if (bridges.has(inboxId)) return bridges.get(inboxId).core;
    const kv = await createKvStore({});
    const prefix = `wx:${inboxId}:`;
    const storage = {
        get: (k) => kvJson(kv, prefix + k),
        put: (k, v) => kv.put(prefix + k, JSON.stringify(v)),
        delete: (k) => kv.delete(prefix + k),
    };
    const slot = { core: null, timer: null, running: false };
    const schedule = (ms) => {
        clearTimeout(slot.timer);
        slot.timer = null;
        if (ms == null) return;
        slot.timer = setTimeout(async () => {
            if (slot.running) return;
            slot.running = true;
            let next = null;
            try { next = await slot.core.runOnce(); } catch (e) { console.warn('[wechat] node loop failed:', e?.message); next = 30000; }
            slot.running = false;
            schedule(next);
        }, Math.max(0, ms));
    };
    slot.core = new WechatBridgeCore(storage, {}, { schedule: async (ms) => schedule(ms) });
    bridges.set(inboxId, slot);
    await addToIndex(kv, inboxId);
    return slot.core;
}

// 進程啟動時恢復所有已綁定的迴圈
export async function resumeNodeBridges() {
    const kv = await createKvStore({});
    const idx = (await kvJson(kv, INDEX_KEY)) || [];
    for (const inboxId of idx) {
        const core = await getNodeBridge(inboxId);
        const bind = await core.s.get('bind');
        if (bind && !bind.expired) await core.hooks.schedule(0);
    }
    return idx.length;
}
