// Cloudflare Workers：每個 inbox 每種渠道一個 Durable Object（微信橋接 / iMessage 橋接）。
//
// 為何用 Durable Object 而不是 cron：
//   - 微信收訊息是長輪詢（一次掛 ~35s），要有一個常駐的單一持有者（同一 Bot 只能一個連線在拉）
//   - DO 的 storage 強一致、不吃 KV 每日 1000 次寫入額度
//   - alarm 讓迴圈在 Worker 閒置時也能持續（每輪結束立刻排下一輪）

import { WechatBridgeCore } from './bridgeCore.js';
import { ImessageBridgeCore } from '../imessage/imessageCore.js';

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
        const hooks = {
            schedule: async (ms) => {
                if (ms == null) await state.storage.deleteAlarm();
                else await state.storage.setAlarm(Date.now() + Math.max(0, ms));
            },
        };
        // 同一個類承載兩種渠道（各自獨立的 DO 實例，名稱不同）：第一次被呼叫時記下是哪種
        this.storage = storage;
        this.cores = {
            wechat: () => (this._wx ||= new WechatBridgeCore(storage, env, hooks)),
            imessage: () => (this._im ||= new ImessageBridgeCore(storage, env, hooks)),
        };
    }

    async _core(kindHint) {
        let kind = await this.state.storage.get('kind');
        if (!kind && kindHint) { kind = kindHint; await this.state.storage.put('kind', kind); }
        return this.cores[kind || 'wechat']();
    }

    async fetch(request) {
        const url = new URL(request.url);
        const query = Object.fromEntries(url.searchParams);
        const kindHint = url.pathname.startsWith('/imessage') ? 'imessage' : 'wechat';
        try {
            const core = await this._core(kindHint);
            // iMessage 平台的 webhook（原始 body 要拿來驗簽）與公開音頻
            if (url.pathname === '/imessage/hook') {
                const raw = await request.text();
                const r = await core.webhook(query.token, Object.fromEntries(request.headers), raw);
                return Response.json(r.json ?? {}, { status: r.status || 200 });
            }
            if (url.pathname === '/imessage/pub') {
                const f = await core.getPublic(query.token, query.id);
                if (!f) return new Response('not found', { status: 404 });
                return new Response(f.bytes, { headers: { 'content-type': f.mime, 'cache-control': 'public, max-age=86400' } });
            }
            let body = null;
            if (request.method === 'POST') { try { body = await request.json(); } catch { body = {}; } }
            const r = await core.handle(request.method, url.pathname, query, body);
            // 微信有綁定但沒有排程（例如部署更新後）→ 補排一次
            if (kindHint === 'wechat' && !(await this.state.storage.getAlarm()) && (await this.state.storage.get('bind'))) {
                await this.state.storage.setAlarm(Date.now() + 100);
            }
            return Response.json(r.json ?? {}, { status: r.status || 200 });
        } catch (e) {
            return Response.json({ error: String(e?.message || e) }, { status: 500 });
        }
    }

    async alarm() {
        const core = await this._core(null);
        const next = await core.runOnce();
        if (next != null) await this.state.storage.setAlarm(Date.now() + next);
    }
}
