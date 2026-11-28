// 定时生成任务（通用）—— 存储
//
// App 先把 prompt 拼好、说好几点跑（每日结算、角色离线互聊…以后的「说到做到」也走这里），
// 中继到点只管：填时间哨兵 → 调 AI → 结果放进待领取列表 → 推送。后端零话术。
//
// 💸 KV 免费额度：不用 list，大小分开存，内容没变不写。
//   jb:idx                      有任务的 inbox 列表
//   jb:list:<inbox>             任务清单（小：id / kind / userId / runAt / 重试次数 / 推送文案 / meta）
//   jb:msg:<inbox>:<id>         该任务的 messages（大）
//   jb:ai:<inbox>:<kind>        该类任务用的 API 设定
//   jb:pend:<inbox>             跑完还没被手机领走的结果（保存 7 天）

export const PENDING_TTL_SEC = 7 * 24 * 60 * 60;

const key = {
    idx: () => 'jb:idx',
    list: (inbox) => `jb:list:${inbox}`,
    msg: (inbox, id) => `jb:msg:${inbox}:${id}`,
    ai: (inbox, kind) => `jb:ai:${inbox}:${kind}`,
    pend: (inbox) => `jb:pend:${inbox}`,
};

const readJson = async (kv, k, fallback) => {
    try {
        const raw = await kv.get(k);
        if (raw == null) return fallback;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { return fallback; }
};
const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
const del = async (kv, k) => { if (typeof kv.delete === 'function') await kv.delete(k); else await kv.put(k, '', { expirationTtl: 60 }); };

export function createJobsStore(kv) {
    const api = {
        async listInboxes() { return readJson(kv, key.idx(), []); },
        async getList(inbox) { return readJson(kv, key.list(inbox), []); },
        async putList(inbox, list) { await kv.put(key.list(inbox), JSON.stringify(list)); },
        async getMessages(inbox, id) { return readJson(kv, key.msg(inbox, id), null); },
        async getAi(inbox, kind) { return readJson(kv, key.ai(inbox, kind), null); },

        /**
         * 用新的一批取代某位用户某一類的全部任務（還沒跑的）。內容沒變的鍵不寫。
         * @param {Array<{id, runAt, messages, push?, meta?}>} jobs
         * @returns {{ written:number, jobs:number }}
         */
        async syncKind(inbox, userId, kind, jobs, aiSettings) {
            let written = 0;
            const uid = String(userId);
            const idx = await api.listInboxes();
            if (!idx.includes(inbox)) { await kv.put(key.idx(), JSON.stringify([...idx, inbox])); written++; }
            if (aiSettings) {
                const prevAi = await api.getAi(inbox, kind);
                if (!same(prevAi, aiSettings)) { await kv.put(key.ai(inbox, kind), JSON.stringify(aiSettings)); written++; }
            }
            const list = await api.getList(inbox);
            const others = list.filter(j => !(j.kind === kind && String(j.userId) === uid));
            const prevMine = new Map(list.filter(j => j.kind === kind && String(j.userId) === uid).map(j => [j.id, j]));
            const nextMine = [];
            for (const j of jobs || []) {
                if (!j?.id || !Number.isFinite(Number(j.runAt)) || !Array.isArray(j.messages)) continue;
                const id = String(j.id);
                const prevMsg = prevMine.has(id) ? await api.getMessages(inbox, id) : null;
                if (!same(prevMsg, j.messages)) { await kv.put(key.msg(inbox, id), JSON.stringify(j.messages)); written++; }
                const old = prevMine.get(id);
                nextMine.push({
                    id, kind, userId: uid, runAt: Number(j.runAt),
                    tries: old?.tries || 0, retryAt: old?.retryAt || 0,
                    push: j.push && typeof j.push === 'object' ? { title: String(j.push.title || ''), body: String(j.push.body || '') } : null,
                    timeSpec: j.timeSpec || null,
                    // 按内容决定推不推（见 jobNotify.js）；没带 = 照 push 推
                    notify: j.notify && typeof j.notify === 'object' && Array.isArray(j.notify.rules) ? j.notify : null,
                    meta: j.meta ?? null,
                });
            }
            // 被拿掉的任務：清 messages
            for (const id of prevMine.keys()) {
                if (!nextMine.some(j => j.id === id)) { await del(kv, key.msg(inbox, id)); written++; }
            }
            const nextList = [...others, ...nextMine];
            if (!same(list, nextList)) { await api.putList(inbox, nextList); written++; }
            return { written, jobs: nextMine.length };
        },

        /** 跑完（或放棄）一個任務：從清單拿掉 + 清 messages */
        async finish(inbox, id) {
            const list = await api.getList(inbox);
            const next = list.filter(j => j.id !== id);
            if (next.length !== list.length) await api.putList(inbox, next);
            await del(kv, key.msg(inbox, id));
        },

        async listPending(inbox) { return readJson(kv, key.pend(inbox), []); },
        async addPending(inbox, item) {
            const list = await api.listPending(inbox);
            const cutoff = Date.now() - PENDING_TTL_SEC * 1000;
            const next = [...list.filter(x => x && x.createdAt > cutoff && x.id !== item.id), item];
            await kv.put(key.pend(inbox), JSON.stringify(next), { expirationTtl: PENDING_TTL_SEC });
        },
        async ackPending(inbox, ids) {
            const list = await api.listPending(inbox);
            const drop = new Set((ids || []).map(String));
            const next = list.filter(x => !drop.has(String(x.id)));
            if (next.length === list.length) return 0;
            if (next.length) await kv.put(key.pend(inbox), JSON.stringify(next), { expirationTtl: PENDING_TTL_SEC });
            else await del(kv, key.pend(inbox));
            return list.length - next.length;
        },
    };
    return api;
}
