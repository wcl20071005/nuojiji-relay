// 主动消息状态存储（Phase 2）—— 按 pair 持久化后端代理主动生成所需的全部状态。
//
// pairKey = `${inboxId}:${userId}:${charId}`
// record  = {
//   inboxId, userId, charId,
//   promptTemplate,          // 手机端拼好的完整 system prompt，含 {{RECENT_MESSAGES}} / {{IMPULSE_REASON}} 占位
//   proactiveProfile,        // 纯数值 profile（weights/threshold/quietHours/...）
//   lifeState,               // {moodIntensity, pendingUserQuestion, lastImpulseAt, lastProactiveSentAt, chitchatCooldownUntil, ...}
//   intensity, proactiveBias,
//   recentMessages,          // 滑窗（cap 30），整窗替换
//   aiSettings,              // {mainApiUrl, mainApiKey, mainApiModel, apiType, temperature, maxTokens?}
//   quietHours, charUtcOffsetSeconds,
//   proactiveEnabledAt,
//   lastInteractionAt,
//   lastFiredAt,             // 后端上次 cron 触发发送时间（防重复 + 简单冷却）
//   enabled, updatedAt,
// }
//
// 🔒 promptTemplate 是手机端拼好的文本，后端只 String.replaceAll 占位符，不含任何提示词逻辑。

export const PROACTIVE_WINDOW_CAP = 30;
// 后端 cron 触发后的最小静默（防 1 分钟 cron 连发；与手机端冷却独立）
export const BACKEND_FIRE_COOLDOWN_MS = 20 * 60 * 1000;
// 生成失败后的短冷却：失败不回退到原值（否则下一分钟 cron 就重试 → API 持续报错时每分钟烧钱），
//   也不白占满 20min（否则用户要等很久才收到下一条）。设成「失败那刻起 5min 后可再试」。
export const BACKEND_FAIL_COOLDOWN_MS = 5 * 60 * 1000;

export function makePairKey(inboxId, userId, charId) {
    return `${inboxId}:${String(userId)}:${String(charId)}`;
}

// Node 进程级单例：HTTP 路由和 cron tick 必须共享同一个内存/sqlite 实例，
// 否则各拿各的新实例 → 注册的数据 tick 看不到。Workers 每次 fetch 新 env，KV 本就共享，不缓存。
let _nodeSingleton = null;

export async function createProactiveStore(env) {
    if (env && env.OUTBOX && typeof env.OUTBOX.put === 'function') {
        return new KvProactiveStore(env.OUTBOX);
    }
    if (_nodeSingleton) return _nodeSingleton;
    const storeKind = (typeof process !== 'undefined' && process.env?.RELAY_STORE) || 'memory';
    if (storeKind === 'sqlite') {
        try {
            // 计算式路径：阻止 esbuild/wrangler 把 sqlite store(及其 better-sqlite3 依赖)静态打进 Workers bundle。
            // 该文件只在 Node + RELAY_STORE=sqlite 时才加载。
            const mod = await import(/* @vite-ignore */ './sqliteProactiveStore' + '.js');
            _nodeSingleton = new mod.SqliteProactiveStore(process.env.RELAY_SQLITE_PATH || './outbox.db');
            return _nodeSingleton;
        } catch (e) {
            console.warn('[proactive] sqlite 不可用，回退内存:', e?.message);
        }
    }
    _nodeSingleton = new MemoryProactiveStore();
    return _nodeSingleton;
}

// ===== 内存实现（Node 默认）=====
export class MemoryProactiveStore {
    constructor() { this.kind = 'memory'; this.map = new Map(); this.pauseMap = new Map(); this.fireMap = new Map(); this._tickLockUntil = 0; this._tickCursor = 0; }
    // inbox 级暂停：走线下剧情时手机端调 /proactive/pause，tick 跳过该 inbox 的所有 pair。
    // 存到点时间戳（pausedUntil），到点自动失效，防手机没发 resume 就永久哑火。
    async setPause(inboxId, pausedUntil) {
        if (pausedUntil && pausedUntil > Date.now()) this.pauseMap.set(inboxId, pausedUntil);
        else this.pauseMap.delete(inboxId);
    }
    async getPausedUntil(inboxId) {
        const until = this.pauseMap.get(inboxId) || 0;
        if (until && until <= Date.now()) { this.pauseMap.delete(inboxId); return 0; }
        return until;
    }
    async upsert(rec) {
        const key = makePairKey(rec.inboxId, rec.userId, rec.charId);
        const prev = this.map.get(key) || {};
        this.map.set(key, { ...prev, ...rec, updatedAt: rec.updatedAt || Date.now() });
    }
    async patch(inboxId, userId, charId, patch) {
        const key = makePairKey(inboxId, userId, charId);
        const prev = this.map.get(key);
        if (!prev) return false;
        this.map.set(key, { ...prev, ...patch, updatedAt: Date.now() });
        return true;
    }
    async remove(inboxId, userId, charId) {
        const k = makePairKey(inboxId, userId, charId);
        this.map.delete(k); this.fireMap.delete(k);
    }
    // 🔒 lastFiredAt 独立存（与 patch 的整条记录写分开），同 KV 实现：防 sync-messages 覆盖 cron 抢槽。
    async claimFire(inboxId, userId, charId, now) {
        this.fireMap.set(makePairKey(inboxId, userId, charId), now || Date.now());
        return true;
    }
    // 🔒 条件抢占（CAS 语义）：只有当前 lastFiredAt 仍在冷却外才抢，返回 true=抢到。
    //    防「两轮重叠 cron 各拍 tick 开头快照都过冷却闸→同一对双发」：抢槽前【新读】一次,别人刚抢则跳过。
    async claimFireIfStale(inboxId, userId, charId, now, cooldownMs) {
        const k = makePairKey(inboxId, userId, charId);
        const prev = this.fireMap.get(k) || 0;
        if (prev && (now - prev) < cooldownMs) return false;
        this.fireMap.set(k, now || Date.now());
        return true;
    }
    async getLastFired(inboxId, userId, charId) {
        return this.fireMap.get(makePairKey(inboxId, userId, charId)) || 0;
    }
    // 🔒 tick 重入锁（单进程，node-cron 已有 _ticking 兜底，这里多一层与 KV 接口对齐）
    async acquireTickLock(ttlMs = 120000) {
        if (this._tickLockUntil > Date.now()) return false;
        this._tickLockUntil = Date.now() + ttlMs;
        return true;
    }
    async releaseTickLock() { this._tickLockUntil = 0; }
    async getTickCursor() { return this._tickCursor || 0; }
    async setTickCursor(n) { this._tickCursor = Number(n) || 0; }
    _withFire(r) { const lf = this.fireMap.get(makePairKey(r.inboxId, r.userId, r.charId)); return lf != null ? { ...r, lastFiredAt: lf } : r; }
    async listEnabled() { return [...this.map.values()].filter(r => r.enabled).map(r => this._withFire(r)); }
    async listByInbox(inboxId) { return [...this.map.values()].filter(r => r.inboxId === inboxId).map(r => this._withFire(r)); }
    async get(inboxId, userId, charId) {
        const r = this.map.get(makePairKey(inboxId, userId, charId));
        return r ? this._withFire(r) : null;
    }
}

// ===== Cloudflare KV 实现 =====
// key 前缀 `p:`；listEnabled 扫全前缀（pair 数量有限，可接受）
// ⚠️ 不用 kv.list(最终一致,刚注册的对 cron 可能扫不到)，改维护全局索引 key `pidx`(强一致 get)。
class KvProactiveStore {
    constructor(kv) { this.kv = kv; this.kind = 'kv'; }
    // inbox 级暂停（同 Memory 实现说明）。用 KV 原生 TTL 兜底，pausedUntil 也写进 value 双保险。
    async setPause(inboxId, pausedUntil) {
        const key = `pause:${inboxId}`;
        if (pausedUntil && pausedUntil > Date.now()) {
            const ttlSec = Math.max(60, Math.ceil((pausedUntil - Date.now()) / 1000));
            await this.kv.put(key, String(pausedUntil), { expirationTtl: ttlSec });
        } else {
            await this.kv.delete(key);
        }
    }
    async getPausedUntil(inboxId) {
        const raw = await this.kv.get(`pause:${inboxId}`);
        const until = raw ? Number(raw) : 0;
        return (until && until > Date.now()) ? until : 0;
    }
    async _getIdx() {
        const raw = await this.kv.get('pidx');
        if (!raw) return [];
        try { return JSON.parse(raw); } catch { return []; }
    }
    async _putIdx(keys) { await this.kv.put('pidx', JSON.stringify(keys)); }
    async _addToIdx(pairKey) {
        const idx = await this._getIdx();
        if (!idx.includes(pairKey)) { idx.push(pairKey); await this._putIdx(idx); }
    }
    async _removeFromIdx(pairKey) {
        const idx = await this._getIdx();
        const next = idx.filter((k) => k !== pairKey);
        if (next.length !== idx.length) await this._putIdx(next);
    }
    async upsert(rec) {
        const pairKey = makePairKey(rec.inboxId, rec.userId, rec.charId);
        const key = `p:${pairKey}`;
        const prevRaw = await this.kv.get(key);
        const prev = prevRaw ? JSON.parse(prevRaw) : {};
        await this.kv.put(key, JSON.stringify({ ...prev, ...rec, updatedAt: rec.updatedAt || Date.now() }));
        await this._addToIdx(pairKey);
    }
    async patch(inboxId, userId, charId, patch) {
        const key = `p:${makePairKey(inboxId, userId, charId)}`;
        const prevRaw = await this.kv.get(key);
        if (!prevRaw) return false;
        const prev = JSON.parse(prevRaw);
        // 💸 内容完全没变（手机回前台补课 / 重复同步同一份滑窗）就不写：KV 免费版每天只有 1000 次写入。
        //    ⚠️ updatedAt 也不刷新——但「陈旧注册」判定看 updatedAt，内容不变超过一天仍要刷一次，免得被误判僵尸对。
        const unchanged = Object.keys(patch).every((k) => JSON.stringify(prev[k]) === JSON.stringify(patch[k]));
        if (unchanged && prev.updatedAt && (Date.now() - prev.updatedAt) < 24 * 60 * 60 * 1000) return true;
        await this.kv.put(key, JSON.stringify({ ...prev, ...patch, updatedAt: Date.now() }));
        return true;
    }
    async remove(inboxId, userId, charId) {
        const pairKey = makePairKey(inboxId, userId, charId);
        await this.kv.delete(`p:${pairKey}`);
        await this.kv.delete(`pf:${pairKey}`); // 同步删独立 lastFiredAt key，防残留
        await this._removeFromIdx(pairKey);
    }
    // 🔒 cron tick 重入锁：Workers scheduled 无重入守卫，tick 超 60s 时下一轮 cron 会并发，
    //    两轮对同一 pair 在各自抢槽前都读到旧 lastFiredAt → 双发双扣费。开头抢锁，持有则跳过本轮。
    //    用短 TTL 防 tick 崩溃后锁永久残留。返回 true=抢到锁，false=已有别的 tick 在跑。
    async acquireTickLock(ttlMs = 120000) {
        const existing = await this.kv.get('tick:lock');
        if (existing && Number(existing) > Date.now()) return false;
        await this.kv.put('tick:lock', String(Date.now() + ttlMs), { expirationTtl: Math.ceil(ttlMs / 1000) });
        return true;
    }
    async releaseTickLock() { await this.kv.delete('tick:lock'); }
    async getTickCursor() { const raw = await this.kv.get('tick:cursor'); return raw ? Number(raw) || 0 : 0; }
    async setTickCursor(n) { await this.kv.put('tick:cursor', String(Number(n) || 0)); }
    // 🔒 lastFiredAt 拆成【独立 key】`pf:<pairKey>`，与手机 sync-messages 会 patch 的主 blob `p:` 分开。
    //    根因：主 blob 的 patch 是整条 read-modify-write，cron 抢槽(写 lastFiredAt)与手机 sync(写
    //    recentMessages/promptTemplate)并发时，sync 用抢槽前的快照覆写 → 抹掉 cron 的 lastFiredAt 抢槽
    //    → 下轮 cron 冷却闸放行 → 重复主动消息。拆开后两个写者各写各的 key，互不覆盖。
    async claimFire(inboxId, userId, charId, now) {
        await this.kv.put(`pf:${makePairKey(inboxId, userId, charId)}`, String(now || Date.now()));
        return true;
    }
    // 🔒 条件抢占（CAS 语义，防两轮重叠 cron 同一对双发）：抢槽前【新读】pf: key，
    //    仍在冷却外才写。KV 非完全原子(get-then-put)，但窗口从整个 tick 缩到一次读写间，配合长锁趋近零。
    async claimFireIfStale(inboxId, userId, charId, now, cooldownMs) {
        const key = `pf:${makePairKey(inboxId, userId, charId)}`;
        const raw = await this.kv.get(key);
        const prev = raw ? Number(raw) || 0 : 0;
        if (prev && (now - prev) < cooldownMs) return false;
        await this.kv.put(key, String(now || Date.now()));
        return true;
    }
    async getLastFired(inboxId, userId, charId) {
        const raw = await this.kv.get(`pf:${makePairKey(inboxId, userId, charId)}`);
        return raw ? Number(raw) || 0 : 0;
    }
    async _all() {
        const idx = await this._getIdx();
        const out = [];
        for (const pairKey of idx) {
            const raw = await this.kv.get(`p:${pairKey}`);
            if (!raw) continue;
            let rec;
            try { rec = JSON.parse(raw); } catch { continue; }
            // 用独立 key 的 lastFiredAt 覆盖 blob 里可能过期的值（blob 的 lastFiredAt 已弃用，只留兼容）
            const pf = await this.kv.get(`pf:${pairKey}`);
            if (pf != null) rec.lastFiredAt = Number(pf) || 0;
            out.push(rec);
        }
        return out;
    }
    async listEnabled() { return (await this._all()).filter(r => r.enabled); }
    async listByInbox(inboxId) { return (await this._all()).filter(r => r.inboxId === inboxId); }
    async get(inboxId, userId, charId) {
        const raw = await this.kv.get(`p:${makePairKey(inboxId, userId, charId)}`);
        return raw ? JSON.parse(raw) : null;
    }
}