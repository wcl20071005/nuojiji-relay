// 定时任务的「按内容决定要不要推送」—— 通用规则求值（后端零话术，文案模板全由 App 带来）
//
// 有些任务不是每次跑完都该响（论坛：只有用户关注的人发帖、或有人 @ 了用户才弹）。
// App 随任务带一份 notify：
//   {
//     max: 3,                               // 这一次最多推几条
//     rules: [{
//       list: 'posts',                      // 回应 JSON 里的数组路径（点分隔）
//       sub: 'interactions',                // 可选：再往下一层数组（楼层），模板里可用 {parent.xxx}
//       field: 'authorName',                // 拿来比对的字段
//       equalsAny: ['A', 'B'],              // 字段等于其中之一（忽略大小写 / 前后空白）
//       containsAny: ['@A'],                // 或：字段包含其中之一
//       skipIfTrue: 'isAnon',               // 可选：这个字段为真就跳过（匿名帖不算关注的人）
//       title: '{authorName} …', body: '{title}',
//     }],
//   }
// 同一个项目只推一次（第一条命中的规则）。
// ⚠️ 与 App 端 src/utils/forumNotifyRules.js 的 evaluateNotify 必须一致（两边各一份，改一边要同步另一边）。

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** 从 AI 回应里抠出 JSON（容忍前后废话 / ```json 包裹） */
export function extractJson(content) {
    const s = String(content || '');
    try { return JSON.parse(s); } catch { /* 往下 */ }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* 往下 */ } }
    const c = s.indexOf('['), d = s.lastIndexOf(']');
    if (c >= 0 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch { /* 往下 */ } }
    return null;
}

const getPath = (obj, path) => {
    if (!path) return obj;
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
};

const fill = (tpl, item, parent) => String(tpl || '').replace(/\{(parent\.)?([A-Za-z0-9_]+)\}/g, (_, isParent, k) => {
    const v = isParent ? parent?.[k] : item?.[k];
    return v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
});

const matches = (rule, item) => {
    if (!item || typeof item !== 'object') return false;
    if (rule.skipIfTrue && item[rule.skipIfTrue]) return false;
    const v = item[rule.field];
    if (v == null) return false;
    const val = norm(v);
    if (!val) return false;
    if (Array.isArray(rule.equalsAny) && rule.equalsAny.some(x => norm(x) && norm(x) === val)) return true;
    if (Array.isArray(rule.containsAny) && rule.containsAny.some(x => norm(x) && val.includes(norm(x)))) return true;
    return false;
};

/**
 * @returns {Array<{ title:string, body:string }>}
 */
export function evaluateNotify(parsedOrContent, notify) {
    if (!notify || !Array.isArray(notify.rules) || notify.rules.length === 0) return [];
    const data = typeof parsedOrContent === 'string' ? extractJson(parsedOrContent) : parsedOrContent;
    if (!data) return [];
    const max = Math.max(1, Math.min(10, Number(notify.max) || 3));
    const out = [];
    const used = new Set();
    for (const rule of notify.rules) {
        if (!rule || !rule.field) continue;
        const list = getPath(data, rule.list);
        if (!Array.isArray(list)) continue;
        list.forEach((parent, pi) => {
            const items = rule.sub ? (Array.isArray(parent?.[rule.sub]) ? parent[rule.sub] : []) : [parent];
            items.forEach((item, ii) => {
                if (out.length >= max) return;
                const key = rule.sub ? `${pi}.${ii}` : `${pi}`;
                if (used.has(key)) return;
                if (!matches(rule, item)) return;
                used.add(key);
                const title = fill(rule.title, item, parent);
                const body = fill(rule.body, item, parent);
                if (title || body) out.push({ title, body });
            });
        });
        if (out.length >= max) break;
    }
    return out;
}
