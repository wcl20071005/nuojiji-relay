// 聊天橋接的 HTTP 路由 + 後端主動消息轉發入口。
//   /wechat/*                微信（全部要中繼密鑰）
//   /imessage/*              iMessage 管理介面（要中繼密鑰）
//   /imessage/hook/:i/:t     iMessage 平台的 webhook（公開；網址裡的隨機 token 驗證，Linq / Blooio 另驗簽章）
//   /imessage/pub/:i/:t/:id  合成語音的公開網址（平台要能直接抓；同一個 token）
//   Workers：轉給該 inbox 的 Durable Object（env.WECHAT；iMessage 用另一個名稱的實例）
//   Node：直接呼叫進程內的核心

import { requireSecret } from '../util/auth.js';
import { getNodeBridge } from './nodeBridge.js';

function hasDO(env) {
    return !!(env && env.WECHAT && typeof env.WECHAT.idFromName === 'function');
}

const doName = (kind, inboxId) => (kind === 'imessage' ? `imessage:${inboxId}` : inboxId);

function stubFor(env, kind, inboxId) {
    return env.WECHAT.get(env.WECHAT.idFromName(doName(kind, inboxId)));
}

const OUTDATED = { status: 501, json: { error: 'chat bridge needs Durable Object binding WECHAT — please Sync fork to update the relay' } };

async function callBridge(env, kind, inboxId, method, path, query, body) {
    if (hasDO(env)) {
        const qs = new URLSearchParams({ ...(query || {}), inboxId }).toString();
        const res = await stubFor(env, kind, inboxId).fetch(`https://chat-bridge${path}?${qs}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'POST' ? JSON.stringify({ ...(body || {}), inboxId }) : undefined,
        });
        return { status: res.status, json: await res.json().catch(() => ({})) };
    }
    if (env && env.OUTBOX) return OUTDATED; // Workers 但舊 fork 沒綁 Durable Object
    const core = await getNodeBridge(inboxId, kind);
    const r = await core.handle(method, path, { ...(query || {}), inboxId }, { ...(body || {}), inboxId });
    return { status: r.status || 200, json: r.json ?? {} };
}

// 中繼對外的網址（平台回呼 / 抓語音用）：環境變數優先，否則取這次請求的來源（反代時看 X-Forwarded-*）
function publicBaseOf(c) {
    const env = c.env?.RELAY_PUBLIC_URL || (typeof process !== 'undefined' ? process.env?.RELAY_PUBLIC_URL : '');
    if (env) return String(env).replace(/\/+$/, '');
    const u = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto') || u.protocol.replace(':', '');
    const host = c.req.header('x-forwarded-host') || u.host;
    return `${proto}://${host}`;
}

function registerManaged(app, kind) {
    const prefix = `/${kind}`;
    app.use(`${prefix}/*`, requireSecret);
    app.all(`${prefix}/*`, async (c) => {
        const method = c.req.method;
        if (method !== 'GET' && method !== 'POST') return c.json({ error: 'method not allowed' }, 405);
        const query = c.req.query();
        let body = null;
        if (method === 'POST') { try { body = await c.req.json(); } catch { body = {}; } }
        const inboxId = query.inboxId || body?.inboxId;
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        if (kind === 'imessage' && c.req.path === '/imessage/setup') body = { ...body, publicBase: publicBaseOf(c) };
        const r = await callBridge(c.env, kind, String(inboxId), method, c.req.path, query, body);
        return c.json(r.json, r.status);
    });
}

export function registerWechatRoutes(app) {
    // ---- iMessage 公開端點（必須註冊在密鑰中介層之前）----
    app.post('/imessage/hook/:inbox/:token', async (c) => {
        const inboxId = c.req.param('inbox');
        const token = c.req.param('token');
        const raw = await c.req.text();
        const headers = Object.fromEntries(c.req.raw.headers);
        if (hasDO(c.env)) {
            const res = await stubFor(c.env, 'imessage', inboxId).fetch(
                `https://chat-bridge/imessage/hook?${new URLSearchParams({ token, inboxId })}`,
                { method: 'POST', headers, body: raw },
            );
            return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
        }
        if (c.env && c.env.OUTBOX) return c.json(OUTDATED.json, OUTDATED.status);
        const core = await getNodeBridge(inboxId, 'imessage');
        const r = await core.webhook(token, headers, raw);
        return c.json(r.json ?? {}, r.status || 200);
    });
    app.get('/imessage/pub/:inbox/:token/:id', async (c) => {
        const inboxId = c.req.param('inbox');
        const token = c.req.param('token');
        const id = c.req.param('id');
        if (hasDO(c.env)) {
            const res = await stubFor(c.env, 'imessage', inboxId).fetch(`https://chat-bridge/imessage/pub?${new URLSearchParams({ token, id, inboxId })}`);
            return new Response(res.body, { status: res.status, headers: res.headers });
        }
        if (c.env && c.env.OUTBOX) return c.text('not found', 404);
        const core = await getNodeBridge(inboxId, 'imessage');
        const f = await core.getPublic(token, id);
        if (!f) return c.text('not found', 404);
        return new Response(f.bytes, { headers: { 'content-type': f.mime, 'cache-control': 'public, max-age=86400' } });
    });

    registerManaged(app, 'wechat');
    registerManaged(app, 'imessage');
}

// 後端主動消息生成後呼叫：微信 / iMessage 綁了且該角色在名單、用戶開了「主動消息也發過去」才會真發。
export async function mirrorProactiveToWechat(env, { inboxId, userId, charId, content }) {
    if (!inboxId || !content) return;
    if (!hasDO(env) && env && env.OUTBOX) return; // 沒有橋接可用
    for (const kind of ['wechat', 'imessage']) {
        try {
            await callBridge(env, kind, String(inboxId), 'POST', `/${kind}/mirror`, {}, { userId: String(userId), charId: String(charId), content });
        } catch (e) {
            console.warn(`[${kind}] mirror proactive failed:`, e?.message);
        }
    }
}
