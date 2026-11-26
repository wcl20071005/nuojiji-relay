// 外發前的「顯示加工」：對齊糯嘰機 App 氣泡渲染前做的事，讓微信 / iMessage / QQ 看到的和 App 裡一致。
//
// App 顯示角色訊息前會套用戶的「顯示時正則」（文本煉金術全局規則 + 綁定預設的正則）——
// 把 <status>…</status>、狀態欄代碼、JSON 之類換成卡片或乾脆藏起來；HTML 卡片則直接渲染。
// 中繼拿到的是 AI 原始輸出，以前不做這一步 → 外面看到一堆代碼 / JSON。
//
// 規則由 App 同步配對時算好帶上來（rec.displayRules，已按角色 / 用戶 / 場景篩過、巨集已展開）：
//   { p: pattern, f: flags, r: 替換字串或陣列, trim: [要刪的子串], t: 1=套完 trim, tmpl: 1=HTML 模板規則 }
// HTML 模板規則的模板不帶上來（外面渲染不了卡片）：配上的那段直接拿掉。
// 套完若帶 HTML → 轉成純文字（只留看得到的字）；變成空的 → 這條不發。

export function stripHtml(h) {
    return String(h || '')
        .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<!--[\s\S]*?-->/gi, '')
        .replace(/<br\s*\/?>|<\/?(?:p|div|li|h\d|tr|section|article|header|footer)\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        // 卡片裡的排版換行（標籤之間的縮排換行 + </p> 換行）壓成一行一句，不留大片空行
        .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
        .trim();
}

// 看起來是 HTML（真標籤），而不是「我<3你」這種文字
const HTML_TAG_RE = /<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/;
export const looksLikeHtml = (s) => typeof s === 'string' && (s.trimStart().startsWith('[HTML]') || HTML_TAG_RE.test(s));

function compile(rule) {
    try {
        const flags = String(rule.f || 'g');
        return new RegExp(String(rule.p || ''), flags.includes('g') ? flags : `${flags}g`);
    } catch { return null; }
}

/** 一段角色台詞套顯示規則（同 App regexEngine.applyRules 的替換語法：$1 / $<name> / {{match}} / 陣列隨機 / trimStrings） */
export function applyDisplayRules(text, rules) {
    let out = String(text ?? '');
    if (!out || !Array.isArray(rules) || !rules.length) return out;
    for (const rule of rules) {
        if (!rule?.p) continue;
        const re = compile(rule);
        if (!re) continue;
        // 跨行區塊：規則常寫成 <tag>(.*?)</tag>（. 不吃換行）→ 原文配不上時把換行壓成空格再試（App 也這樣兼容）
        if (out.includes('\n')) {
            re.lastIndex = 0;
            if (!re.test(out)) {
                const collapsed = out.replace(/\s*\n\s*/g, ' ');
                re.lastIndex = 0;
                if (re.test(collapsed)) out = collapsed;
            }
            re.lastIndex = 0;
        }
        try {
            if (rule.tmpl) {
                out = out.replace(re, '');
            } else {
                const opts = Array.isArray(rule.r) ? rule.r : [rule.r || ''];
                const trims = Array.isArray(rule.trim) ? rule.trim.filter((s) => typeof s === 'string' && s) : [];
                out = out.replace(re, (...args) => {
                    let tail = args.slice(1);
                    let named = {};
                    if (tail.length && typeof tail[tail.length - 1] === 'object' && tail[tail.length - 1] !== null) named = tail.pop();
                    tail.pop(); tail.pop(); // string, offset
                    const groups = [args[0], ...tail];
                    let res = String(opts[Math.floor(Math.random() * opts.length)] ?? '');
                    res = res.replace(/\$(\d+)/g, (w, n) => (groups[Number(n)] != null ? String(groups[Number(n)]) : w));
                    res = res.replace(/\$<(\w+)>/g, (w, k) => (named[k] != null ? String(named[k]) : w));
                    res = res.replace(/\{\{match\}\}/gi, String(args[0] ?? ''));
                    for (const s of trims) res = res.split(s).join('');
                    return res;
                });
            }
        } catch { /* 這條規則套不上就跳過 */ }
        if (rule.t) out = out.trim();
    }
    return out;
}

/** 外發前的最後加工：顯示規則 → HTML 轉純文字。回傳空字串 = 這條不用發 */
export function renderForChannel(text, rules) {
    let out = applyDisplayRules(text, rules);
    if (looksLikeHtml(out)) out = stripHtml(out.replace(/^\s*\[HTML\]/, ''));
    return out.trim();
}
