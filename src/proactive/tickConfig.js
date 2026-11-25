// 主动消息检测间隔（分钟）的解析。
//
// Workers 的 cron 表达式写死每分钟触发（不能读环境变量 / KV），实际几分钟真跑一轮由这里决定，
// 其余分钟 scheduled 直接返回（零写入）。来源优先级：
//   1. 环境变量 PROACTIVE_TICK_MINUTES（部署者手动锁定，App 改不动）
//   2. KV `cfg:tickMinutes`（App 设置页「云端检查频率」经 POST /config 写入）
//   3. 默认 DEFAULT_TICK_MINUTES
//
// 💸 KV 读结果在 isolate 内缓存 10 分钟：cron 每分钟都要判断一次，不缓存就是每天 1440 次读。

export const TICK_CONFIG_KEY = 'cfg:tickMinutes';
// 后端冷却本来就 20 分钟、inbox 级节流 25 分钟，5 分钟检测一次体感无差，比每分钟省得多。
export const DEFAULT_TICK_MINUTES = 5;
const CACHE_MS = 10 * 60 * 1000;

let _cache = { value: null, at: 0 };

function clampMinutes(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.min(60, n);
}

function envTickMinutes(env) {
    const raw = env?.PROACTIVE_TICK_MINUTES
        ?? (typeof process !== 'undefined' ? process.env?.PROACTIVE_TICK_MINUTES : undefined);
    return clampMinutes(raw);
}

export function hasEnvTickMinutes(env) {
    return envTickMinutes(env) != null;
}

// kv：createKvStore 返回的实例（Workers KV / 内存 / sqlite 三种接口一致）
export async function readTickMinutes(env, kv, { useCache = false } = {}) {
    const fromEnv = envTickMinutes(env);
    if (fromEnv != null) return fromEnv;
    if (useCache && _cache.value != null && Date.now() - _cache.at < CACHE_MS) return _cache.value;
    let v = null;
    try { v = clampMinutes(await kv?.get(TICK_CONFIG_KEY)); } catch { v = null; }
    const out = v ?? DEFAULT_TICK_MINUTES;
    _cache = { value: out, at: Date.now() };
    return out;
}

// POST /config 写完顺手刷新本 isolate 的缓存（其他 isolate 最迟 10 分钟后读到新值）
export function rememberTickMinutes(n) {
    const v = clampMinutes(n);
    if (v != null) _cache = { value: v, at: Date.now() };
}
