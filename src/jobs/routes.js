// 定时生成任务 —— 路由（都要 Bearer secret）
//   POST /jobs/sync      用新的一批取代某用户某一类的全部任务（jobs 为空 = 清掉这一类）
//   GET  /jobs/pending   手机领取跑完的结果
//   POST /jobs/ack       手机落地后确认删除
//   GET  /jobs/status    设置页看状态（各类排了几个、最近一个几点、待领取几条）

import { requireSecret } from '../util/auth.js';
import { createKvStore } from '../store/kvStore.js';
import { createJobsStore } from './jobsStore.js';

const MESSAGES_MAX_BYTES = 20 * 1024 * 1024; // 只防 KV 单值写不进去，不裁内容
const storeOf = async (c) => createJobsStore(await createKvStore(c.env));

export function registerJobsRoutes(app) {
    app.use('/jobs/*', requireSecret);

    app.post('/jobs/sync', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, kind, jobs, aiSettings } = body || {};
        if (!inboxId || userId == null || !kind || !Array.isArray(jobs)) {
            return c.json({ error: 'inboxId / userId / kind / jobs required' }, 400);
        }
        for (const j of jobs) {
            const bytes = new TextEncoder().encode(JSON.stringify(j?.messages || [])).length;
            if (bytes > MESSAGES_MAX_BYTES) return c.json({ error: `job ${j?.id} too large` }, 413);
        }
        const r = await (await storeOf(c)).syncKind(inboxId, userId, String(kind), jobs, aiSettings || null);
        return c.json({ ok: true, ...r });
    });

    app.get('/jobs/pending', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        return c.json({ items: await (await storeOf(c)).listPending(inboxId) });
    });

    app.post('/jobs/ack', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        if (!body?.inboxId || !Array.isArray(body.ids)) return c.json({ error: 'inboxId / ids required' }, 400);
        return c.json({ acked: await (await storeOf(c)).ackPending(body.inboxId, body.ids) });
    });

    app.get('/jobs/status', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const store = await storeOf(c);
        const [list, pending] = await Promise.all([store.getList(inboxId), store.listPending(inboxId)]);
        const kinds = {};
        for (const j of list) {
            const k = (kinds[j.kind] ||= { count: 0, nextAt: null });
            k.count++;
            if (!k.nextAt || j.runAt < k.nextAt) k.nextAt = j.runAt;
        }
        return c.json({ ok: true, kinds, pending: pending.length });
    });
}
