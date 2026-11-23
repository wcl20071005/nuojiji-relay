// Cloudflare Workers：每個 inbox 一個 Durable Object 承載微信橋接。
//
// 為何用 Durable Object 而不是 cron：
//   - 微信收訊息是長輪詢（一次掛 ~35s），要有一個常駐的單一持有者（同一 Bot 只能一個連線在拉）
//   - DO 的 storage 強一致、不吃 KV 每日 1000 次寫入額度
//   - alarm 讓迴圈在 Worker 閒置時也能持續（每輪結束立刻排下一輪）

import { WechatBridgeCore } from './bridgeCore.js';

export class WechatBridge {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        // DO 單個值上限 2MB，而角色模板（大世界書 / 長記憶）可能更大 → 超過就切塊存，讀時拼回。
        //   內容一字不截。
        const CHUNK = 1_000_000;
        const storage = {
            get: async (k) => {
                const v = await state.storage.get(k);
                if (v && typeof v === 'object' && v.__chunks) {
                    const keys = Array.from({ length: v.__chunks }, (_, i) => `${k}#${i}`);
                    const parts = await state.storage.get(keys);
                    return JSON.parse(keys.map((key) => parts.get(key) || '').join(''));
                }
                return v;
            },
            put: async (k, v) => {
                const prev = await state.storage.get(k);
                const json = JSON.stringify(v);
                if (json.length <= CHUNK) {
                    await state.storage.put(k, v);
                } else {
                    const n = Math.ceil(json.length / CHUNK);
                    const entries = {};
                    for (let i = 0; i < n; i++) entries[`${k}#${i}`] = json.slice(i * CHUNK, (i + 1) * CHUNK);
                    await state.storage.put(entries);
                    await state.storage.put(k, { __chunks: n });
                }
                // 舊的多餘切塊清掉
                const prevN = prev && typeof prev === 'object' && prev.__chunks ? prev.__chunks : 0;
                const newN = json.length > CHUNK ? Math.ceil(json.length / CHUNK) : 0;
                for (let i = newN; i < prevN; i++) await state.storage.delete(`${k}#${i}`);
            },
            delete: async (k) => {
                const prev = await state.storage.get(k);
                if (prev && typeof prev === 'object' && prev.__chunks) {
                    await state.storage.delete(Array.from({ length: prev.__chunks }, (_, i) => `${k}#${i}`));
                }
                await state.storage.delete(k);
            },
        };
        this.core = new WechatBridgeCore(storage, env, {
            schedule: async (ms) => {
                if (ms == null) await state.storage.deleteAlarm();
                else await state.storage.setAlarm(Date.now() + Math.max(0, ms));
            },
        });
    }

    async fetch(request) {
        const url = new URL(request.url);
        const query = Object.fromEntries(url.searchParams);
        let body = null;
        if (request.method === 'POST') { try { body = await request.json(); } catch { body = {}; } }
        try {
            const r = await this.core.handle(request.method, url.pathname, query, body);
            // 有綁定但沒有排程（例如部署更新後）→ 補排一次
            if (!(await this.state.storage.getAlarm()) && (await this.state.storage.get('bind'))) {
                await this.state.storage.setAlarm(Date.now() + 100);
            }
            return Response.json(r.json ?? {}, { status: r.status || 200 });
        } catch (e) {
            return Response.json({ error: String(e?.message || e) }, { status: 500 });
        }
    }

    async alarm() {
        const next = await this.core.runOnce();
        if (next != null) await this.state.storage.setAlarm(Date.now() + next);
    }
}
