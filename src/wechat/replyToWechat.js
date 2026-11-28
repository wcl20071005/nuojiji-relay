// 把角色回覆（糯嘰機 JSON-Lines）轉成要發到微信的訊息清單。
//
// 只做「可見內容 → 微信能顯示的形態」的通用轉換，不含提示詞邏輯：
//   text        → 文字
//   reply       → 文字 + 下一行「被引用的那句」
//   sticker     → 有可下載網址就發圖片，否則「[表情] 含義」文字
//   voice       → 「[语音] 內容」文字（微信 Bot 發不出語音條，實測）
//   image/video → 「[图片] 描述」文字（生圖在手機排水時才做，微信這邊先給描述）
//   state       → 旁白「（…）」，僅在允許動作描寫時保留
//   其餘可見卡片（轉帳/禮物/位置/轉發…）→ 一行中文說明
//   react       → { kind:'react' }：支援原生回應的渠道（iMessage Tapback）發回應，其餘渠道丟掉
//   text 帶 fx / anim → 原生特效（iMessage 氣泡 / 全屏特效、文字動畫），不支援的渠道照發文字
//   隱藏類型（xinsheng/memory/note/思維鏈…）→ 不發
// 非 JSON-Lines 的純文字整段當一條（不截斷）。

const DESC = {
    transfer: '转账', gift: '礼物', delivery_gift: '外卖', shop_gift: '礼物', location: '位置',
    forward: '聊天记录', file: '文件', song: '歌曲', card_offer: '卡片', share_card: '名片',
    pat: '拍一拍', video_call: '视频通话',
};

// 類型別名（對齊 App messageTagParser 的歸一表）：模型寫成 "Text" / "photo" / "narration" 之類，
// App 照樣顯示，中繼若認不得就整條靜默丟掉 → App 裡看得到回覆、微信一條都收不到
const TYPE_ALIAS = {
    msg: 'text', message: 'text', txt: 'text', chat: 'text', say: 'text', speech: 'text', dialogue: 'text', dialog: 'text', line: 'text',
    simimg: 'image', sim_img: 'image', sim_image: 'image', simg: 'image', simulated_image: 'image', selfie: 'image', photo: 'image', picture: 'image', pic: 'image',
    clip: 'video', video_clip: 'video', vid: 'video',
    sticker_message: 'sticker', stickermsg: 'sticker', emoji_sticker: 'sticker',
    narration: 'state', narrative: 'state', action: 'state', act: 'state', scene: 'state',
    描述: 'state', 旁白: 'state', 动描: 'state', 動描: 'state', 动作: 'state', 動作: 'state', 动作描写: 'state', 動作描寫: 'state',
    htm: 'html', raw_html: 'html', rawhtml: 'html',
    videocallopening: 'video_call', video_call_opening: 'video_call', videocall_opening: 'video_call',
    think: 'thinking', thought: 'thinking', thoughts: 'thinking', reasoning: 'thinking', reason: 'thinking', 思考: 'thinking', 思維: 'thinking', 思维: 'thinking',
    calendar: 'cal', calender: 'cal', 日曆: 'cal', 日历: 'cal',
};
export function normalizeType(t) {
    const n = String(t || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return TYPE_ALIAS[n] || n;
}
// 不外發的類型（隱藏 / App 內部動作 / 卡片操作）；不在這裡、也不在上面認得的可見類型 → 像 App 一樣當文字發
const HIDDEN_TYPES = new Set([
    'thinking', 'memory', 'cal_update', 'cal', 'health', 'xinsheng', 'note', 'reply_note', 'npc_trigger', 'npc_msg', 'dm_from',
    'group_msg', 'pair_msg', 'theater', 'auto_reply', 'commitment', 'plan', 'recall', 'reject_transfer', 'accept_transfer',
    'spend', 'ledger', 'shop_ask', 'lifeup', 'image_edit', 'post_moment', 'post_forum', 'comment_moment', 'reply_comment', 'like_moment',
    'bond_card', 'bond_design', 'bond_task', 'bond_pact', 'bond_grand', 'tempo', 'meta', 'plan_line', 'mood', 'status',
]);
const stripHtml = (h) => String(h || '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// 文字特效（iMessage）：AI 寫在 text / reply 行上的 "fx" / "anim"，各家平台的寫法在 providers 裡換
export const FX_NAMES = ['slam', 'loud', 'gentle', 'invisible', 'confetti', 'fireworks', 'lasers', 'balloons', 'love', 'celebration', 'echo', 'spotlight', 'shooting_star'];
export const ANIM_NAMES = ['big', 'small', 'shake', 'nod', 'explode', 'ripple', 'bloom', 'jitter'];
const FX_ALIAS = { invisible_ink: 'invisible', invisibleink: 'invisible', ink: 'invisible', hearts: 'love', heart: 'love', shootingstar: 'shooting_star', star: 'shooting_star', sparkles: 'shooting_star', party: 'celebration', happy_birthday: 'balloons', birthday: 'balloons', balloon: 'balloons', laser: 'lasers', firework: 'fireworks' };
// 蘋果原生特效 id（平台原樣轉過來時）：com.apple.MobileSMS.expressivesend.impact / com.apple.messages.effect.CKConfettiEffect
const APPLE_FX = { impact: 'slam', loud: 'loud', gentle: 'gentle', invisibleink: 'invisible', confetti: 'confetti', fireworks: 'fireworks', lasers: 'lasers', happybirthday: 'balloons', heart: 'love', celebration: 'celebration', echo: 'echo', spotlight: 'spotlight', shootingstar: 'shooting_star', sparkles: 'shooting_star' };
export function normalizeFx(v) {
    const raw = String(v || '').trim();
    const apple = /expressivesend\.(\w+)$/i.exec(raw) || /CK(\w+?)Effect$/i.exec(raw);
    if (apple) return APPLE_FX[apple[1].toLowerCase()] || '';
    const n = raw.toLowerCase().replace(/[\s-]+/g, '_');
    const k = FX_ALIAS[n] || FX_ALIAS[n.replace(/_/g, '')] || n;
    return FX_NAMES.includes(k) ? k : '';
}
export function normalizeAnim(v) {
    const n = String(v || '').trim().toLowerCase();
    return ANIM_NAMES.includes(n) ? n : '';
}
const fxOf = (obj) => {
    const fx = normalizeFx(obj?.fx ?? obj?.effect ?? obj?.send_style);
    const anim = normalizeAnim(obj?.anim ?? obj?.animation);
    return { ...(fx ? { fx } : {}), ...(anim ? { anim } : {}) };
};

function pickStr(...vals) {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
    return '';
}

// 角色開了翻譯：翻譯在 tr（或 translation / trans… 別名），舊寫法是「原文||翻譯」
const TR_SEP = '||';
export function splitTranslation(obj, text) {
    const tr = pickStr(obj?.tr, obj?.translation, obj?.trans, obj?.tr_text, obj?.tran);
    if (tr) return { orig: text, tr };
    const i = typeof text === 'string' ? text.lastIndexOf(TR_SEP) : -1;
    if (i > 0) return { orig: text.slice(0, i).trim(), tr: text.slice(i + TR_SEP.length).trim() };
    return { orig: text, tr: '' };
}
// 發出去的樣子：原文，空一行，翻譯（和 App 氣泡下方的翻譯一樣）
export const withTranslation = (orig, tr) => (tr ? `${orig}\n\n${tr}` : orig);

/**
 * @param {string} content AI 原始回覆
 * @param {object} opts { stickerUrls: {含義: url}, allowState: bool }
 * @returns {Array<{kind:'text', text:string} | {kind:'sticker', url:string, meaning:string}>}
 */
export function replyToWechatParts(content, { stickerUrls = {}, allowState = false } = {}) {
    if (!content || typeof content !== 'string') return [];
    const tokens = tokenizeReply(content);
    const parts = [];
    let sawJson = false;
    const plain = [];
    for (const tk of tokens) {
        // 裸文字按出現位置佔位（以前一律排到最後 → 狀態欄 / 卡片跑到整輪末尾）
        if (tk.text != null) { plain.push(tk.text); parts.push({ kind: 'text', text: tk.text, _plain: true }); continue; }
        const obj = tk.obj;
        sawJson = true;
        const t = normalizeType(obj.t ?? obj.type);
        if (t === 'text') {
            const { orig: c, tr } = splitTranslation(obj, pickStr(obj.c, obj.text, obj.content));
            // 滑窗只記原文（App 送 AI 的窗口也只有原文）
            if (c) parts.push({ kind: 'text', text: withTranslation(c, tr), ...(tr ? { windowText: c } : {}), ...fxOf(obj) });
        } else if (t === 'reply') {
            // 引用回覆：正文照發，被引用的那句放在下面（和 App 裡氣泡下方的引用框一樣）
            const { orig: c, tr } = splitTranslation(obj, pickStr(obj.c, obj.text, obj.content));
            const quote = pickStr(obj.quote, obj.q, obj.target);
            if (c || quote) {
                parts.push({
                    kind: 'text',
                    text: [withTranslation(c, tr), quote ? `「${quote}」` : ''].filter(Boolean).join('\n'),
                    // 滑窗裡記成 AI 自己的寫法，不學外發的排版
                    windowText: quote ? `[reply to: ${quote}] ${c}` : c,
                    // 支援原生引用的渠道（iMessage）：正文單獨發、掛在被引用那條下面；找不到那條才用上面的合成文字
                    ...(quote && c ? { replyQuote: quote, replyBody: withTranslation(c, tr) } : {}),
                    ...fxOf(obj),
                });
            }
        } else if (t === 'react') {
            // 給某條訊息貼回應（App 裡是氣泡角上的 emoji）
            const emoji = pickStr(obj.emoji, obj.e, obj.c, obj.reaction);
            if (emoji) parts.push({ kind: 'react', emoji, target: pickStr(obj.target, obj.quote, obj.q) });
        } else if (t === 'sticker') {
            const meaning = pickStr(obj.m, obj.meaning, obj.c, obj.text, obj.content, obj.name, obj.sticker);
            const url = meaning ? stickerUrls[meaning] : null;
            if (url) parts.push({ kind: 'sticker', url, meaning });
            else if (meaning) parts.push({ kind: 'text', text: `[表情] ${meaning}` });
        } else if (t === 'voice') {
            const { orig: c, tr } = splitTranslation(obj, pickStr(obj.c, obj.text));
            if (c) parts.push({ kind: 'voice', text: c, ...(tr ? { tr } : {}) });
        } else if (t === 'image' || t === 'sim_img' || t === 'simulated_image') {
            parts.push({ kind: 'text', text: `[图片] ${pickStr(obj.d, obj.c, obj.desc) || ''}`.trim() });
        } else if (t === 'video') {
            parts.push({ kind: 'text', text: `[视频] ${pickStr(obj.d, obj.c, obj.desc) || ''}`.trim() });
        } else if (t === 'state') {
            const { orig: c, tr } = splitTranslation(obj, pickStr(obj.c, obj.text));
            if (c && allowState) parts.push({ kind: 'text', text: withTranslation(`（${c}）`, tr ? `（${tr}）` : ''), ...(tr ? { windowText: `（${c}）` } : {}) });
        } else if (DESC[t]) {
            const extra = pickStr(obj.c, obj.note, obj.name, obj.d, obj.title);
            parts.push({ kind: 'text', text: `[${DESC[t]}]${extra ? ` ${extra}` : ''}` });
        }
        else if (t === 'html') {
            const c = stripHtml(pickStr(obj.c, obj.html, obj.content));
            if (c) parts.push({ kind: 'text', text: c });
        } else if (t && !HIDDEN_TYPES.has(t)) {
            // App 的未知類型會當文字顯示 → 這裡也照發，免得 App 裡有、微信裡沒有
            const { orig: c, tr } = splitTranslation(obj, pickStr(obj.c, obj.text, obj.content));
            if (c) parts.push({ kind: 'text', text: withTranslation(c, tr), ...(tr ? { windowText: c } : {}) });
        }
        // 其他（隱藏/動作類）不發
    }
    if (!sawJson) {
        const whole = plain.join('\n').trim();
        if (!whole) return [];
        const { orig, tr } = splitTranslation(null, whole);
        return [{ kind: 'text', text: withTranslation(orig, tr), ...(tr ? { windowText: orig } : {}) }];
    }
    // JSON 輪次裡夾著的裸文字行也照發（AI 偶爾漏包 JSON）；開場白（「我會以角色身份回覆…」）不發
    return parts
        .filter((p) => !p._plain || (!/^[{}[\]]+$/.test(p.text) && !isMetaChatter(p.text)))
        .map(({ _plain, ...p }) => p);
}

// ---------- 容錯切分（對齊 App messageTagParser 的 mergeIncompleteJsonLines / parseJsonLine） ----------
// 模型常見的不規範輸出：
//   - 整段包進 ```json … ``` 圍欄，或單獨一行「json」
//   - 一個 JSON 物件跨好幾行（字串值裡吐了真換行，如 {"t":"thinking","c":"…\n…"}）
//   - 開頭一句英文開場白「I'll reply as X in character, following all the rules…」
// 原本逐行 JSON.parse → 這些全失敗、原樣當文字發出去（思維鏈整段洩漏到微信）。

// 從 start（指向 '{'）做字串感知的大括號配對，回傳對應 '}' 的索引，-1 = 未閉合
function scanObjectEnd(str, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function parseLoose(s) {
    try { return JSON.parse(s); } catch { /* 字串裡有真換行 → 轉義後再試 */ }
    try { return JSON.parse(s.replace(/\r/g, '\\r').replace(/\n/g, '\\n')); } catch { return null; }
}

// 隱藏類型：殘缺（被截斷）時整段丟掉，不當文字發
const HIDDEN_TYPE_RE = /^\s*\{\s*"t"\s*:\s*"(?:thinking|think|thoughts?|reasoning|reason|react|memory|cal_update|cal|health|xinsheng|note|npc_trigger|npc_msg|dm_from|group_msg|pair_msg|video_call|videocallopening|theater|auto_reply|commitment|plan)"/i;

/** 整段回覆 → [{ obj } | { text }]（按出現順序） */
export function tokenizeReply(content) {
    const src = String(content)
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '') // 思維鏈不外發
        .replace(/\r\n?/g, '\n');
    const out = [];
    const pushText = (chunk) => {
        for (const raw of chunk.split('\n')) {
            const line = raw.trim();
            if (!line || /^(?:```|~~~)/.test(line) || /^(?:json|jsonl)$/i.test(line)) continue; // 圍欄 / 語言標記
            out.push({ text: line });
        }
    };
    let i = 0;
    let afterObj = false;
    while (i < src.length) {
        // 物件之間的整塊內容（```html 圍欄 / [HTML] 卡片 / 跨行的 <tag>…</tag>）：整塊當一條，
        // 不逐行拆（逐行拆會讓 CSS / 標籤碎片一行行發出去，用戶的顯示正則也配不上）
        const blk = findBlock(src, i);
        if (blk) {
            pushText(src.slice(i, blk.start));
            out.push({ text: blk.text });
            i = blk.end;
            afterObj = false;
            continue;
        }
        // 找下一個「行首」的 {（行內的 { 是文字的一部分）；緊接在上一個物件後面的也算（一行塞了兩個）
        const isStart = (k) => (afterObj && /^\s*$/.test(src.slice(i, k)))
            || src.slice(src.lastIndexOf('\n', k - 1) + 1, k).replace(/^\s*(?:```\w*)?\s*/, '') === '';
        let j = src.indexOf('{', i);
        while (j !== -1 && j > 0 && !isStart(j)) j = src.indexOf('{', j + 1);
        if (j === -1) { pushText(src.slice(i)); break; }
        pushText(src.slice(i, j));
        const end = scanObjectEnd(src, j);
        if (end === -1) {
            // 未閉合（被截斷）：文字類撈 c 出來，隱藏類整段丟
            const rest = src.slice(j);
            if (!HIDDEN_TYPE_RE.test(rest)) {
                const m = rest.match(/"c"\s*:\s*"((?:[^"\\]|\\.)*)/);
                if (m && /^\s*\{\s*"t"\s*:\s*"(?:text|state|reply|voice)"/.test(rest)) {
                    const c = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
                    if (c) out.push({ text: c });
                }
            }
            break;
        }
        const raw = src.slice(j, end + 1);
        const obj = parseLoose(raw);
        afterObj = !!(obj && typeof obj === 'object' && !Array.isArray(obj));
        if (afterObj) out.push({ obj });
        else if (!HIDDEN_TYPE_RE.test(raw)) pushText(raw); // 真的不是 JSON（例如角色說了句帶大括號的話）
        i = end + 1;
    }
    return out;
}

// 從 i 起、下一個 JSON 物件之前，有沒有「整塊」內容；有就回 { start, end, text }
const NEXT_OBJ_RE = /^[ \t]*\{/m;
const BLOCK_OPEN_RE = /^[ \t]*(?:```(?:html|HTML)[ \t]*$|\[HTML\]|<([A-Za-z一-鿿][\w一-鿿-]*)(?:\s[^<>\n]*)?>)/m;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function findBlock(src, i) {
    const rest = src.slice(i);
    const objAt = rest.search(NEXT_OBJ_RE);
    const re = new RegExp(BLOCK_OPEN_RE.source, 'gm');
    let mo;
    while ((mo = re.exec(rest))) {
        if (objAt !== -1 && objAt < mo.index) return null; // 先遇到 JSON 物件 → 交給物件那邊
        const blk = blockAt(src, i + mo.index, mo);
        if (blk) return blk;
        if (mo[0].length === 0) re.lastIndex++;
    }
    return null;
}
function blockAt(src, start, mo) {
    const head = mo[0].trim();
    let end;
    let text;
    if (head.startsWith('```')) {
        // ```html 圍欄 → 到下一個 ``` 行
        const close = /^[ \t]*```[ \t]*$/m;
        const after = src.slice(start + mo[0].length);
        const mc = close.exec(after);
        if (!mc) return null;
        end = start + mo[0].length + mc.index + mc[0].length;
        // CSS 起頭（AI 常漏 <style> 包裹）→ 第一個標籤之前的 CSS 補上 <style>，轉文字時整段丟掉（App 同款判定）
        let body = after.slice(0, mc.index).trim();
        if (body && !body.startsWith('<') && /^(?:[:.#*@]|\/\*|[a-z-]+\s*\{)/i.test(body)) {
            const k = body.indexOf('<');
            body = k === -1 ? `<style>${body}</style>` : `<style>${body.slice(0, k)}</style>${body.slice(k)}`;
        }
        text = `[HTML]${body}`;
    } else if (head.startsWith('[HTML]')) {
        // 裸 [HTML] 卡片 → 到下一個 JSON 物件行或結尾
        const fromHere = src.slice(start);
        const nextObj = fromHere.slice(1).search(NEXT_OBJ_RE);
        end = nextObj === -1 ? src.length : start + 1 + nextObj;
        text = src.slice(start, end).trim();
    } else {
        // 行首的 <tag>：同一行就閉合的不算整塊（照常逐行）；跨行的找 </tag>
        const tag = mo[1];
        const lineEnd = src.indexOf('\n', start);
        const firstLine = src.slice(start, lineEnd === -1 ? src.length : lineEnd);
        const closeRe = new RegExp(`</${escRe(tag)}\\s*>`, 'i');
        if (closeRe.test(firstLine) || lineEnd === -1) return null;
        const mc = closeRe.exec(src.slice(lineEnd));
        if (!mc) return null;
        end = lineEnd + mc.index + mc[0].length;
        text = src.slice(start, end).trim();
    }
    return { start, end, text };
}

// 模型的開場白 / 自我說明（不是角色台詞）：只在這輪有 JSON 時才丟
const META_RE = /^(?:(?:ok(?:ay)?|sure|alright|understood|got it)[,.!\s]+)?(?:i(?:'ll| will| am going to)|let me|here(?:'s| is))\s+(?:now\s+)?(?:reply|respond|answer|continue|write|stay|be|output|generate|the (?:reply|response))\b.*(?:in[- ]character|role ?play|as \S+|following|rules|guidelines|format|json)/i;
function isMetaChatter(line) {
    return META_RE.test(line) || /^(?:好的|明白)[，,。！!]?\s*(?:我(?:会|將|将)|下面)(?:以|用).{0,20}(?:身份|口吻|角色).{0,20}(?:回复|回覆|输出|輸出)/.test(line);
}

/**
 * 每條用戶訊息最多能回 REPLY_QUOTA 條：超出的文字併進最後一條，表情改成文字說明。
 * @param {Array} parts
 * @param {number} budget 剩餘可發條數
 */
export function fitToBudget(parts, budget) {
    if (budget <= 0) return [];
    if (parts.length <= budget) return parts;
    const head = parts.slice(0, budget - 1);
    const rest = parts.slice(budget - 1).map((p) => (p.kind === 'sticker' ? `[${p.isMedia ? '图片' : '表情'}] ${p.meaning || ''}`.trim()
        : p.kind === 'video' ? `[视频] ${p.meaning || ''}`.trim()
            : p.kind === 'voice' ? withTranslation(`[语音] ${p.text}`, p.tr) : p.text));
    head.push({ kind: 'text', text: rest.join('\n') });
    return head;
}

// 寫進滑窗用的純文字（角色自己這輪說了什麼）
// 發微信時加的「【角色名】」只給用戶分辨是誰，不進滑窗（否則 AI 會看到自己台詞前都有名字而模仿）
export function partsToWindowText(part, name = '') {
    if (part.kind === 'react') return `[reacted ${part.emoji}${part.target ? ` to: ${part.target}` : ''}]`;
    if (part.kind === 'sticker') return part.isMedia ? `[image] ${part.meaning || ''}`.trim() : `[sticker: ${part.meaning}]`;
    if (part.kind === 'video') return `[video] ${part.meaning || ''}`.trim();
    if (part.kind === 'voice') return `[voice] ${part.text}`;
    if (part.noWindow) return null;
    // 帶了特效 → 滑窗記一筆，AI 才知道自己剛用過（不會每條都放）
    const withFx = (t) => (t && part.fx ? `${t} [fx: ${part.fx}]` : t);
    if (part.windowText) return withFx(part.windowText.trim()) || null;
    // 前綴可能是【名字】或【名字·用戶名】
    const text = name && part.text.startsWith(`【${name}`) ? part.text.replace(/^【[^】]*】/, '') : part.text;
    return text.trim() ? withFx(text) : null;
}
