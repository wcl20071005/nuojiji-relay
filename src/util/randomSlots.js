// 隨機槽：手機端在 promptTemplate 裡用 <!--rs:key-->…<!--/rs:key--> 包住「一段每次生成都要隨機換」的內容
//（隨機心聲預設 / 自定義預設的隨機頭部），並在 randomSlots[key].variants 帶上所有候選全文（措辭全由手機端給）。
// 後端每次生成：每個槽抽一段替換進去；沒帶候選（舊手機端）→ 保留模板裡原本那段、只拿掉標記。
// 回傳 picks（key → 抽中的候選 id），隨 outbox / 對話記錄帶回手機，讓手機把心聲美化切到同一套。
//
// ⚠️ 只做字串替換與隨機，不含任何提示詞邏輯。

const RS_RE = /<!--rs:([\w-]+)-->([\s\S]*?)<!--\/rs:\1-->/g;
const MAX_SLOTS = 8;
const MAX_VARIANTS = 200;
const MAX_SLOTS_BYTES = 2 * 1024 * 1024;

/** 整理手機端帶來的 randomSlots（外來輸入容錯 + 封頂防 KV 膨脹）；不合法 → null */
export function normalizeRandomSlots(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const [key, slot] of Object.entries(raw).slice(0, MAX_SLOTS)) {
        if (!/^[\w-]{1,40}$/.test(key) || !slot || typeof slot !== 'object') continue;
        const variants = (Array.isArray(slot.variants) ? slot.variants : [])
            .filter(v => v && typeof v === 'object' && typeof v.text === 'string')
            .slice(0, MAX_VARIANTS)
            .map(v => ({ id: String(v.id ?? ''), text: v.text }));
        if (variants.length < 2) continue; // 只有一段就沒什麼好抽，模板裡那段就是它
        out[key] = { variants, noRepeat: slot.noRepeat !== false };
    }
    if (!Object.keys(out).length) return null;
    let size = 0;
    try { size = JSON.stringify(out).length; } catch { return null; }
    return size > MAX_SLOTS_BYTES ? null : out;
}

/**
 * 每個槽抽一段替換進模板。
 * @param {string} template
 * @param {object|null} slots   rec.randomSlots
 * @param {object|null} lastPicks rec.lastRandomPicks（noRepeat：不連著抽到同一段）
 * @returns {{ text: string, picks: object }}
 */
export function renderRandomSlots(template, slots, lastPicks = null, rand = Math.random) {
    const picks = {};
    const text = String(template || '').replace(RS_RE, (_m, key, inner) => {
        const slot = slots?.[key];
        const pool = Array.isArray(slot?.variants) ? slot.variants : [];
        if (pool.length < 2) return inner;
        const last = lastPicks?.[key];
        const cand = (slot.noRepeat !== false && last != null) ? pool.filter(v => v.id !== String(last)) : pool;
        const list = cand.length ? cand : pool;
        const pick = list[Math.floor(rand() * list.length)] || list[0];
        picks[key] = pick.id;
        return pick.text;
    });
    return { text, picks };
}
