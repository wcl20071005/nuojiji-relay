// 天气突变提醒（外部世界触发）—— 中继自己查天气（open-meteo，免费、免 key，不花 AI 的钱），
// 用户当地早上到点后看今天的预报：大雨 / 下雪 / 雷暴 / 酷热 / 寒冷 / 比昨天骤降温 → 才让一位角色来提醒。
// 文字全由手机端带来（weatherWatch.blocks，{max}{min}{pop}{sum}{drop} 由这里换成数字），后端零话术。

const CACHE_MS = 60 * 60 * 1000;
const _cache = new Map(); // `${lat},${lon}` → { at, data }

async function fetchForecast(lat, lon) {
    const key = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max'
        + '&past_days=1&forecast_days=1&timezone=auto';
    const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
    const data = await res.json();
    _cache.set(key, { at: Date.now(), data });
    return data;
}

/** 今天该提醒哪一种（没有特别的天气 → null）。daily 两天：[0]=昨天 [1]=今天 */
export function classifyWeather(daily) {
    if (!daily || !Array.isArray(daily.weather_code) || daily.weather_code.length < 2) return null;
    const code = Number(daily.weather_code[1]);
    const max = Number(daily.temperature_2m_max[1]);
    const min = Number(daily.temperature_2m_min[1]);
    const pop = Number(daily.precipitation_probability_max?.[1] ?? 0);
    const sum = Number(daily.precipitation_sum?.[1] ?? 0);
    const drop = Number(daily.temperature_2m_max[0]) - max;
    const vals = { max: Math.round(max), min: Math.round(min), pop: Math.round(pop), sum: Math.round(sum * 10) / 10, drop: Math.round(drop) };
    if (code >= 95) return { kind: 'storm', vals };
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { kind: 'snow', vals };
    if ((pop >= 70 && sum >= 5) || sum >= 15) return { kind: 'rain', vals };
    if (max >= 35) return { kind: 'hot', vals };
    if (min <= 0) return { kind: 'cold', vals };
    if (drop >= 8) return { kind: 'drop', vals };
    return null;
}

const fill = (tpl, vals) => String(tpl || '').replace(/\{(max|min|pop|sum|drop)\}/g, (_, k) => String(vals[k]));

/**
 * 这一对此刻要不要发天气提醒（当作一条「到点承诺」交给 tick 同一条路径）
 * @returns {Promise<null|{ id, group, triggerAt, block, reason }>}
 */
export async function weatherOccasion(rec, now) {
    const w = rec?.weatherWatch;
    if (!w || !Number.isFinite(Number(w.lat)) || !Number.isFinite(Number(w.lon)) || !w.blocks) return null;
    const off = Number.isFinite(Number(w.utcOffsetSeconds)) ? Number(w.utcOffsetSeconds) : 0;
    const local = new Date(now + off * 1000);
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    const atMin = Number.isFinite(Number(w.atMinutes)) ? Number(w.atMinutes) : 7 * 60 + 30;
    // 早上到点后两小时内才看（错过就算了，不在下午补一条「今天要下雨」）
    if (minutes < atMin || minutes > atMin + 120) return null;
    let data;
    try { data = await fetchForecast(w.lat, w.lon); } catch (e) { console.warn('[weather] fetch failed:', e?.message); return null; }
    const hit = classifyWeather(data?.daily);
    if (!hit || !w.blocks[hit.kind]) return null;
    const dateKey = local.toISOString().slice(0, 10);
    return {
        id: `weather:${dateKey}`,
        group: `weather:${dateKey}`,   // 同一个 inbox 一天只让一位角色来提醒
        triggerAt: now,
        reason: String(w.reason || ''),
        block: fill(w.blocks[hit.kind], hit.vals),
    };
}
