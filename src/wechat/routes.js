// 微信橋接的 HTTP 路由（全部要中繼密鑰）+ 後端主動消息轉發到微信的入口。
//   Workers：轉給該 inbox 的 Durable Object（env.WECHAT 綁定）
//   Node：直接呼叫進程內的 WechatBridgeCore

import { requireSecret } from '../util/auth.js';
import { getNodeBridge } from './nodeBridge.js';

function hasDO(env) {
    return !!(env && env.WECHAT && typeof env.WECHAT.idFromName === 'function');
}

async function callBridge(env, inboxId, method, path, query, body) {
    if (hasDO(env)) {
        const stub = env.WECHAT.get(env.WECHAT.idFromName(inboxId));
        const qs = new URLSearchParams({ ...(query || {}), inboxId }).toString();
        const res = await stub.fetch(`https://wechat-bridge${path}?${qs}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'POST' ? JSON.stringify({ ...(body || {}), inboxId }) : undefined,
        });
        return { status: res.status, json: await res.json().catch(() => ({})) };
    }
    if (env && env.OUTBOX) {
        // Workers 但沒綁 Durable Object（舊 fork 的 wrangler.toml）→ 明確告訴手機要更新中繼
        return { status: 501, json: { error: 'wechat bridge needs Durable Object binding WECHAT — please Sync fork to update the relay' } };
    }
    const core = await getNodeBridge(inboxId);
    const r = await core.handle(method, path, { ...(query || {}), inboxId }, { ...(body || {}), inboxId });
    return { status: r.status || 200, json: r.json ?? {} };
}

export function registerWechatRoutes(app) {
    app.use('/wechat/*', requireSecret);
    app.all('/wechat/*', async (c) => {
        const method = c.req.method;
        if (method !== 'GET' && method !== 'POST') return c.json({ error: 'method not allowed' }, 405);
        const query = c.req.query();
        let body = null;
        if (method === 'POST') { try { body = await c.req.json(); } catch { body = {}; } }
        const inboxId = query.inboxId || body?.inboxId;
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const r = await callBridge(c.env, String(inboxId), method, c.req.path, query, body);
        return c.json(r.json, r.status);
    });
}

// 後端主動消息生成後呼叫：微信綁了且該角色在名單、用戶開了「主動消息發到微信」才會真發。
export async function mirrorProactiveToWechat(env, { inboxId, userId, charId, content }) {
    try {
        if (!inboxId || !content) return;
        if (!hasDO(env) && env && env.OUTBOX) return; // 沒有橋接可用
        await callBridge(env, String(inboxId), 'POST', '/wechat/mirror', {}, { userId: String(userId), charId: String(charId), content });
    } catch (e) {
        console.warn('[wechat] mirror proactive failed:', e?.message);
    }
}
