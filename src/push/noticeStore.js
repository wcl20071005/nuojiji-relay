// 系统通知留底（notices）—— 给没有推送通道的手机自己来拉
//
// 安卓没有后端推送（FCM 被墙），原生 RelayPoller 只会拉聊天 outbox。朋友圈 / 论坛这类
// 「生成完要弹一下」的通知以前只发 APNs / WebPush，安卓就永远不响。
// 这里把每条推过的通知顺手留一份（标题 / 正文 / 时间），安卓轮询器顺便 GET /notices?since=… 自己弹。
// iOS / 网页已经收到推送，不读这里。
//
//   nt:<inbox>   最近 30 条，3 天过期（只是通知文本，不是内容正本；内容正本仍在各自的待领取列表）

const TTL_SEC = 3 * 24 * 60 * 60;
const MAX_ITEMS = 30;
const key = (inbox) => `nt:${inbox}`;

const readJson = async (kv, k) => {
    try {
        const raw = await kv.get(k);
        if (raw == null || raw === '') return [];
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v : [];
    } catch { return []; }
};

export function createNoticeStore(kv) {
    return {
        async list(inbox, since = 0) {
            const all = await readJson(kv, key(inbox));
            return all.filter(n => n && Number(n.createdAt) > Number(since || 0));
        },
        /** @param {Array<{id,title,body,kind,userId}>} items */
        async add(inbox, items) {
            const add = (items || []).filter(n => n && n.id && (n.title || n.body));
            if (!add.length) return;
            const now = Date.now();
            const cutoff = now - TTL_SEC * 1000;
            const prev = (await readJson(kv, key(inbox))).filter(n => n && n.createdAt > cutoff);
            const ids = new Set(add.map(n => String(n.id)));
            // createdAt 逐条 +1ms：安卓按 since 取，同一毫秒的多条不能被吞
            const next = [...prev.filter(n => !ids.has(String(n.id))), ...add.map((n, i) => ({
                id: String(n.id), title: String(n.title || ''), body: String(n.body || ''),
                kind: String(n.kind || ''), userId: n.userId == null ? null : String(n.userId), createdAt: now + i,
            }))].slice(-MAX_ITEMS);
            await kv.put(key(inbox), JSON.stringify(next), { expirationTtl: TTL_SEC });
        },
    };
}
