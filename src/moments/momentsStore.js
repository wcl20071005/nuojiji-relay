// 后台朋友圈 —— 存储（走通用 KV：Workers = env.OUTBOX，Node = 内存 / sqlite）
//
// 💸 Cloudflare KV 免费额度：写 / 列出 每天各 1000 次。这里刻意【不用 list】，也把大小数据分开存：
//   mo:idx                 注册过的 inbox 列表（只在新 inbox 注册 / 注销时写）
//   mo:cfg:<inbox>         设定 + 角色清单（小；App 同步时内容没变就不写）
//   mo:tpl:<inbox>:<char>  该角色的发帖 messages（大：人设+世界书+记忆…，App 拼好的，后端只填时间哨兵）
//   mo:st:<inbox>          节律状态（上次发帖、下次时间、今天发了几条）—— 每发一条写一次
//   mo:pend:<inbox>        还没被手机领走的贴文（App 排水领取后 ack 删除）
// 待领取的贴文保存 7 天：朋友圈离线隔天回来也要看得到（outbox 默认只留 6 小时）。

export const PENDING_TTL_SEC = 7 * 24 * 60 * 60;

const k = {
    idx: () => 'mo:idx',
    cfg: (inbox) => `mo:cfg:${inbox}`,
    tpl: (inbox, charId) => `mo:tpl:${inbox}:${charId}`,
    st: (inbox) => `mo:st:${inbox}`,
    pend: (inbox) => `mo:pend:${inbox}`,
};

const readJson = async (kv, key, fallback) => {
    try {
        const raw = await kv.get(key);
        if (raw == null) return fallback;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { return fallback; }
};
const sameJson = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };

export function createMomentsStore(kv) {
    return {
        async listInboxes() { return readJson(kv, k.idx(), []); },

        async getConfig(inbox) { return readJson(kv, k.cfg(inbox), null); },
        async getTemplate(inbox, charId) { return readJson(kv, k.tpl(inbox, charId), null); },
        async getState(inbox) { return readJson(kv, k.st(inbox), {}); },
        async putState(inbox, st) { await kv.put(k.st(inbox), JSON.stringify(st)); },

        /**
         * 注册 / 更新。templates: { [charId]: messages }；内容没变的键不写（省写额度）。
         * @returns {{ written: number }}
         */
        async register(inbox, cfg, templates) {
            let written = 0;
            const idx = await this.listInboxes();
            if (!idx.includes(inbox)) { await kv.put(k.idx(), JSON.stringify([...idx, inbox])); written++; }
            for (const [charId, messages] of Object.entries(templates || {})) {
                const prev = await this.getTemplate(inbox, charId);
                if (!sameJson(prev, messages)) { await kv.put(k.tpl(inbox, charId), JSON.stringify(messages)); written++; }
            }
            const prevCfg = await this.getConfig(inbox);
            const { updatedAt: _a, ...prevBody } = prevCfg || {};
            const { updatedAt: _b, ...nextBody } = cfg;
            // 设定没变也每 24 小时刷新一次 updatedAt（tick 靠它判断这份快照是不是太旧）
            if (!sameJson(prevBody, nextBody) || !prevCfg || (cfg.updatedAt - (prevCfg.updatedAt || 0)) > 24 * 3600 * 1000) {
                await kv.put(k.cfg(inbox), JSON.stringify(cfg)); written++;
            }
            return { written };
        },

        async unregister(inbox) {
            const idx = await this.listInboxes();
            if (idx.includes(inbox)) await kv.put(k.idx(), JSON.stringify(idx.filter(x => x !== inbox)));
            const cfg = await this.getConfig(inbox);
            if (cfg) await kv.put(k.cfg(inbox), JSON.stringify({ ...cfg, enabled: false, updatedAt: Date.now() }));
        },

        async listPending(inbox) { return readJson(kv, k.pend(inbox), []); },
        async addPending(inbox, item) {
            const list = await this.listPending(inbox);
            const cutoff = Date.now() - PENDING_TTL_SEC * 1000;
            const next = [...list.filter(x => x && x.createdAt > cutoff && x.id !== item.id), item];
            await kv.put(k.pend(inbox), JSON.stringify(next), { expirationTtl: PENDING_TTL_SEC });
        },
        async ackPending(inbox, ids) {
            const list = await this.listPending(inbox);
            const drop = new Set((ids || []).map(String));
            const next = list.filter(x => !drop.has(String(x.id)));
            if (next.length === list.length) return 0; // 💸 没变不写
            if (next.length) await kv.put(k.pend(inbox), JSON.stringify(next), { expirationTtl: PENDING_TTL_SEC });
            else if (typeof kv.delete === 'function') await kv.delete(k.pend(inbox));
            else await kv.put(k.pend(inbox), '[]', { expirationTtl: 60 });
            return list.length - next.length;
        },
    };
}
