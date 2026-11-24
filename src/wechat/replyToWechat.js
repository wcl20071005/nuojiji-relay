// 把角色回覆（糯嘰機 JSON-Lines）轉成要發到微信的訊息清單。
//
// 只做「可見內容 → 微信能顯示的形態」的通用轉換，不含提示詞邏輯：
//   text        → 文字
//   sticker     → 有可下載網址就發圖片，否則「[表情] 含義」文字
//   voice       → 「[语音] 內容」文字（微信 Bot 發不出語音條，實測）
//   image/video → 「[图片] 描述」文字（生圖在手機排水時才做，微信這邊先給描述）
//   state       → 旁白「（…）」，僅在允許動作描寫時保留
//   其餘可見卡片（轉帳/禮物/位置/轉發…）→ 一行中文說明
//   隱藏類型（xinsheng/memory/note/react/思維鏈…）→ 不發
// 非 JSON-Lines 的純文字整段當一條（不截斷）。

const DESC = {
    transfer: '转账', gift: '礼物', delivery_gift: '外卖', shop_gift: '礼物', location: '位置',
    forward: '聊天记录', file: '文件', song: '歌曲', card_offer: '卡片', share_card: '名片',
    pat: '拍一拍', video_call: '视频通话',
};

function pickStr(...vals) {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
    return '';
}

/**
 * @param {string} content AI 原始回覆
 * @param {object} opts { stickerUrls: {含義: url}, allowState: bool }
 * @returns {Array<{kind:'text', text:string} | {kind:'sticker', url:string, meaning:string}>}
 */
export function replyToWechatParts(content, { stickerUrls = {}, allowState = false } = {}) {
    if (!content || typeof content !== 'string') return [];
    // 思維鏈不外發
    const cleaned = content.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
    const parts = [];
    let sawJson = false;
    const plain = [];
    for (const line of lines) {
        if (!line.startsWith('{')) { plain.push(line); continue; }
        let obj;
        try { obj = JSON.parse(line); } catch { plain.push(line); continue; }
        if (!obj || typeof obj !== 'object') continue;
        sawJson = true;
        const t = obj.t;
        if (t === 'text') {
            const c = pickStr(obj.c, obj.text, obj.content);
            if (c) parts.push({ kind: 'text', text: c });
        } else if (t === 'sticker') {
            const meaning = pickStr(obj.m, obj.meaning, obj.c, obj.text, obj.content, obj.name, obj.sticker);
            const url = meaning ? stickerUrls[meaning] : null;
            if (url) parts.push({ kind: 'sticker', url, meaning });
            else if (meaning) parts.push({ kind: 'text', text: `[表情] ${meaning}` });
        } else if (t === 'voice') {
            const c = pickStr(obj.c, obj.text);
            if (c) parts.push({ kind: 'voice', text: c });
        } else if (t === 'image' || t === 'sim_img' || t === 'simulated_image') {
            parts.push({ kind: 'text', text: `[图片] ${pickStr(obj.d, obj.c, obj.desc) || ''}`.trim() });
        } else if (t === 'video') {
            parts.push({ kind: 'text', text: `[视频] ${pickStr(obj.d, obj.c, obj.desc) || ''}`.trim() });
        } else if (t === 'state') {
            const c = pickStr(obj.c, obj.text);
            if (c && allowState) parts.push({ kind: 'text', text: `（${c}）` });
        } else if (DESC[t]) {
            const extra = pickStr(obj.c, obj.note, obj.name, obj.d, obj.title);
            parts.push({ kind: 'text', text: `[${DESC[t]}]${extra ? ` ${extra}` : ''}` });
        }
        // 其他（隱藏/動作類）不發
    }
    if (!sawJson) {
        const whole = plain.join('\n').trim();
        return whole ? [{ kind: 'text', text: whole }] : [];
    }
    // JSON 輪次裡夾著的裸文字行也照發（AI 偶爾漏包 JSON）
    for (const p of plain) if (!/^[{}[\]]+$/.test(p)) parts.push({ kind: 'text', text: p });
    return parts;
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
    const rest = parts.slice(budget - 1).map((p) => (p.kind === 'sticker' ? `[表情] ${p.meaning}` : p.kind === 'voice' ? `[语音] ${p.text}` : p.text));
    head.push({ kind: 'text', text: rest.join('\n') });
    return head;
}

// 寫進滑窗用的純文字（角色自己這輪說了什麼）
// 發微信時加的「【角色名】」只給用戶分辨是誰，不進滑窗（否則 AI 會看到自己台詞前都有名字而模仿）
export function partsToWindowText(part, name = '') {
    if (part.kind === 'sticker') return `[sticker: ${part.meaning}]`;
    if (part.kind === 'voice') return `[voice] ${part.text}`;
    // 前綴可能是【名字】或【名字·用戶名】
    const text = name && part.text.startsWith(`【${name}`) ? part.text.replace(/^【[^】]*】/, '') : part.text;
    return text.trim() ? text : null;
}
