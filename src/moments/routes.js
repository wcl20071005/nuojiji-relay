// 后台朋友圈 —— 路由（都要 Bearer secret）
//   POST /moments/register    App 同步设定 + 每个角色拼好的发帖 messages
//   POST /moments/unregister  关掉
//   GET  /moments/pending     手机排水：领取还没拿走的贴文
//   POST /moments/ack         手机写进朋友圈后确认删除
//   GET  /moments/status      设置页看状态（下次发帖时间、今天发了几条、待领取几条）

import { requireSecret } from '../util/auth.js';
import { createKvStore } from '../store/kvStore.js';
import { createMomentsStore } from './momentsStore.js';

// 只防单值过大写不进 KV（25MB），不裁内容
const TEMPLATE_MAX_BYTES = 20 * 1024 * 1024;

const storeOf = async (c) => createMomentsStore(await createKvStore(c.env));

export function registerMomentsRoutes(app) {
    app.use('/moments/*', requireSecret);

    app.post('/moments/register', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, chars, aiSettings } = body || {};
        if (!inboxId || userId == null || !Array.isArray(chars) || !aiSettings) {
            return c.json({ error: 'inboxId / userId / chars / aiSettings required' }, 400);
        }
        const templates = {};
        const charList = [];
        for (const ch of chars) {
            if (!ch || ch.charId == null || !Array.isArray(ch.messages)) continue;
            const bytes = new TextEncoder().encode(JSON.stringify(ch.messages)).length;
            if (bytes > TEMPLATE_MAX_BYTES) return c.json({ error: `template too large for ${ch.name || ch.charId}` }, 413);
            templates[String(ch.charId)] = ch.messages;
            charList.push({ charId: String(ch.charId), name: ch.name || '', avatarUrl: ch.avatarUrl || null, timeSpec: ch.timeSpec || null });
        }
        const cfg = {
            inboxId, userId: String(userId),
            enabled: body.enabled !== false,
            intervalMin: Number(body.intervalMin) || 90,
            quietStart: Number.isFinite(Number(body.quietStart)) ? Number(body.quietStart) : 1,
            quietEnd: Number.isFinite(Number(body.quietEnd)) ? Number(body.quietEnd) : 7,
            maxPerDay: Number(body.maxPerDay) || 0,
            userUtcOffsetSeconds: Number.isFinite(Number(body.userUtcOffsetSeconds)) ? Number(body.userUtcOffsetSeconds) : null,
            notifPrivacy: !!body.notifPrivacy,
            pushTitle: typeof body.pushTitle === 'string' ? body.pushTitle : '{name}',
            pushPrivacyBody: typeof body.pushPrivacyBody === 'string' ? body.pushPrivacyBody : '',
            pushFallbackBody: typeof body.pushFallbackBody === 'string' ? body.pushFallbackBody : '',
            chars: charList,
            aiSettings,
            updatedAt: Date.now(),
        };
        const store = await storeOf(c);
        const { written } = await store.register(inboxId, cfg, templates);
        return c.json({ ok: true, chars: charList.length, written });
    });

    app.post('/moments/unregister', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        if (!body?.inboxId) return c.json({ error: 'inboxId required' }, 400);
        await (await storeOf(c)).unregister(body.inboxId);
        return c.json({ ok: true });
    });

    app.get('/moments/pending', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const items = await (await storeOf(c)).listPending(inboxId);
        return c.json({ items });
    });

    app.post('/moments/ack', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        if (!body?.inboxId || !Array.isArray(body.ids)) return c.json({ error: 'inboxId / ids required' }, 400);
        const acked = await (await storeOf(c)).ackPending(body.inboxId, body.ids);
        return c.json({ acked });
    });

    app.get('/moments/status', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const store = await storeOf(c);
        const [cfg, st, pending] = await Promise.all([store.getConfig(inboxId), store.getState(inboxId), store.listPending(inboxId)]);
        return c.json({
            ok: true,
            enabled: !!cfg?.enabled,
            chars: (cfg?.chars || []).length,
            nextAt: st?.nextAt || null,
            lastPostAt: st?.lastPostAt || null,
            todayCount: st?.dayCount || 0,
            pending: pending.length,
            updatedAt: cfg?.updatedAt || null,
        });
    });
}
