// 系统通知留底 —— 路由（Bearer secret）
//   GET /notices?inboxId=…&since=<ms>   安卓轮询器拉「推过但它收不到」的通知自己弹（见 noticeStore.js）

import { requireSecret } from '../util/auth.js';
import { createKvStore } from '../store/kvStore.js';
import { createNoticeStore } from './noticeStore.js';

export function registerNoticeRoutes(app) {
    app.use('/notices', requireSecret);
    app.get('/notices', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const since = Number(c.req.query('since')) || 0;
        const store = createNoticeStore(await createKvStore(c.env));
        return c.json({ items: await store.list(inboxId, since) });
    });
}
