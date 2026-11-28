// iMessage 第三方平台 adapter：Sendblue / LoopMessage / Linq / Blooio。
//
// 每家實作同一組方法（依各家官方 API 文件，2026-11 讀）：
//   setupWebhook(acc, url)            能用 API 註冊 webhook 的就自動註冊（回傳要存的 { webhookSecret? }）；不能的回 null（用戶到後台貼網址）
//   verify(headers, raw, acc)          驗 webhook 簽章（沒簽章機制的回 true，靠網址裡的隨機 token 防偽）
//   parse(body)                        webhook → [{ handle, text, mediaUrls, id, ts, chatId, voiceText, replyToId, effect, isSticker }]，只回「用戶發來的」
//                                      Tapback 事件回 { kind:'reaction', handle, targetId, emoji, remove, id }
//   sendText(acc, text, opts) / sendMedia(acc, url) / sendVoice(acc, url) / typing(acc, on)
//       opts = { replyTo: 平台訊息 id, fx: 特效（replyToWechat normalizeFx 的名字）, anim: 文字動畫 }
//       發送類都回傳平台的訊息 id（拿不到回 ''），核心記下來好讓用戶回應 / 引用角色的話時對得上
//   可選：react(acc, msgId, emoji, remove)  原生 Tapback；sendSticker(acc, url, mime) 原生貼紙；
//         fetchText(acc, msgId) 查某條訊息的文字（用戶引用了中繼沒記到的舊訊息）
//   caps = { fx:[可用特效], anim, reply, react, sticker } 給提示詞決定教 AI 什麼
// acc = { provider, apiKey, apiSecret, fromNumber, userHandle, chatId, lastMessageId, webhookSecret, lineNumber }
//
// Photon 只能用它的 SDK 長連線收發，沒有 HTTP 發送介面，中繼接不了，故不支援。

import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';

export class ProviderError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

async function call(url, { method = 'POST', headers = {}, body } = {}) {
    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) throw new ProviderError(`HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
    return data;
}

// 電話號碼 / Apple ID 正規化成可比較的形式
export function normHandle(h) {
    const s = String(h || '').trim().toLowerCase();
    if (!s) return '';
    if (s.includes('@')) return s;
    const digits = s.replace(/[^\d]/g, '');
    return digits;
}

const header = (headers, name) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase());
    return k ? headers[k] : '';
};

function timingSafeEq(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}

// 平台回應裡的訊息 id（各家欄位名不同，拿不到就空字串）
export function extractId(r) {
    if (!r || typeof r !== 'object') return '';
    const v = r.message_handle || r.message_id || r.message?.id || r.id || r.data?.id || r.data?.message_id || r.data?.message?.id;
    return v ? String(v) : '';
}

// 經典 Tapback ↔ emoji（其餘 emoji 走各家的「emoji 回應」）
const TAPBACK_OF = { '❤️': 'love', '❤': 'love', '♥️': 'love', '👍': 'like', '👎': 'dislike', '😂': 'laugh', '🤣': 'laugh', '‼️': 'emphasize', '‼': 'emphasize', '❗': 'emphasize', '❗️': 'emphasize', '❓': 'question', '❔': 'question' };
const EMOJI_OF = { love: '❤️', like: '👍', dislike: '👎', laugh: '😂', emphasize: '‼️', question: '❓' };
export function tapbackOf(emoji) {
    const e = String(emoji || '').trim();
    if (TAPBACK_OF[e]) return TAPBACK_OF[e];
    return EMOJI_OF[e.toLowerCase()] ? e.toLowerCase() : '';
}
export const emojiOfTapback = (name) => EMOJI_OF[String(name || '').toLowerCase()] || '';

// 取第一個 emoji（AI 偶爾寫「❤️❤️」或夾文字）
export function pickReactionEmoji(s) {
    const str = String(s || '').trim();
    if (EMOJI_OF[str.toLowerCase()]) return str.toLowerCase();
    try {
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        for (const { segment } of seg.segment(str)) if (/\p{Extended_Pictographic}|\p{Emoji_Presentation}|[‼❓❔❗]/u.test(segment)) return segment;
    } catch { /* 沒有 Segmenter */ }
    return str;
}

// 平台不轉 Tapback、只轉蘋果的文字版（「Loved “…”」）→ 認回成回應
const TEXT_TAPBACK_RE = /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned)\s+[“"「](.*)[”"」]\s*$/s;
const TEXT_TAPBACK_NAME = { Loved: 'love', Liked: 'like', Disliked: 'dislike', 'Laughed at': 'laugh', Emphasized: 'emphasize', Questioned: 'question' };
const TEXT_UNTAPBACK_RE = /^Removed an? (heart|like|dislike|laugh|exclamation|question mark) from\s+[“"「](.*)[”"」]\s*$/s;
const TEXT_UNTAPBACK_NAME = { heart: 'love', like: 'like', dislike: 'dislike', laugh: 'laugh', exclamation: 'emphasize', 'question mark': 'question' };
const TEXT_EMOJI_TAPBACK_RE = /^(Reacted|Removed)\s+(\S+)\s+(?:to|from)\s+[“"「](.*)[”"」]\s*$/s;
export function parseTextTapback(text) {
    const s = String(text || '').trim();
    let m = TEXT_TAPBACK_RE.exec(s);
    if (m) return { emoji: emojiOfTapback(TEXT_TAPBACK_NAME[m[1]]), remove: false, targetText: m[2] };
    m = TEXT_UNTAPBACK_RE.exec(s);
    if (m) return { emoji: emojiOfTapback(TEXT_UNTAPBACK_NAME[m[1]]), remove: true, targetText: m[2] };
    m = TEXT_EMOJI_TAPBACK_RE.exec(s);
    if (m) return { emoji: m[2], remove: m[1] === 'Removed', targetText: m[3] };
    return null;
}

// 共用特效名（replyToWechat FX_NAMES）；氣泡特效與全屏特效
export const FX_ALL = ['slam', 'loud', 'gentle', 'invisible', 'confetti', 'fireworks', 'lasers', 'balloons', 'love', 'celebration', 'echo', 'spotlight', 'shooting_star'];
const BUBBLE_FX = new Set(['slam', 'loud', 'gentle', 'invisible']);

// ======================= Sendblue =======================
const SB = 'https://api.sendblue.com';
const sbHeaders = (acc) => ({ 'sb-api-key-id': acc.apiKey, 'sb-api-secret-key': acc.apiSecret });
const sbFrom = (acc) => acc.fromNumber || acc.lineNumber || undefined;
const sendblue = {
    label: 'Sendblue',
    needsSecret: true, // API Key ID + API Secret Key 兩組
    // 收到的 Tapback 文件沒寫（不轉 / 轉成蘋果文字版，核心會認文字版）；沒有貼紙
    caps: { fx: FX_ALL, anim: false, reply: true, react: true, sticker: false },
    async setupWebhook(acc, url) {
        await call(`${SB}/api/account/webhooks`, { headers: sbHeaders(acc), body: { webhooks: [url], type: 'receive' } });
        return {};
    },
    verify: () => true, // 官方文件沒寫簽章 header 名，靠網址 token
    parse(body) {
        if (!body || body.is_outbound) return [];
        if (body.status && String(body.status).toUpperCase() !== 'RECEIVED') return [];
        return [{
            handle: body.number || body.from_number,
            line: body.sendblue_number || body.to_number || '',
            text: body.content || '',
            mediaUrls: body.media_url ? [body.media_url] : [],
            id: body.message_handle,
            replyToId: body.reply_to?.message_handle || '',
            effect: body.send_style || '',
            ts: Date.parse(body.date_sent) || Date.now(),
        }];
    },
    async sendText(acc, text, opts = {}) {
        const body = { number: acc.userHandle, from_number: sbFrom(acc), content: text };
        if (opts.replyTo) body.reply_to = { message_handle: opts.replyTo };
        if (opts.fx) body.send_style = opts.fx;
        return extractId(await call(`${SB}/api/send-message`, { headers: sbHeaders(acc), body }));
    },
    sendMedia: async (acc, url) => extractId(await call(`${SB}/api/send-message`, { headers: sbHeaders(acc), body: { number: acc.userHandle, from_number: sbFrom(acc), media_url: url } })),
    // Sendblue 只有 .caf 會顯示成語音條；雲端轉不了 caf → mp3 以可播放的音頻附件送達
    sendVoice: (acc, url) => sendblue.sendMedia(acc, url),
    // 只能回應「收到的」訊息；from_number 必填（沒填就用 webhook 帶來的線路號碼）
    async react(acc, msgId, emoji, remove) {
        const from = sbFrom(acc);
        if (!from) throw new ProviderError('Sendblue reaction needs from_number');
        const v = tapbackOf(emoji) || pickReactionEmoji(emoji);
        await call(`${SB}/api/send-reaction`, { headers: sbHeaders(acc), body: { from_number: from, message_handle: msgId, reaction: `${remove ? '-' : ''}${v}` } });
    },
    async typing(acc, on) {
        await call(`${SB}/api/send-typing-indicator`, { headers: sbHeaders(acc), body: { number: acc.userHandle, from_number: sbFrom(acc), state: on ? 'start' : 'stop' } });
    },
};

// ======================= LoopMessage =======================
const LOOP = 'https://a.loopmessage.com/api/v1/message';
const loopHeaders = (acc) => ({ Authorization: acc.apiKey });
const loopFrom = (acc) => (acc.fromNumber ? { sender: acc.fromNumber } : {});
const LOOP_FX = { invisible: 'invisibleInk', shooting_star: 'shootingStar' };
const loopmessage = {
    label: 'LoopMessage',
    caps: { fx: FX_ALL, anim: true, reply: true, react: true, sticker: false },
    setupWebhook: async () => null, // webhook 在 LoopMessage 後台設定
    verify: () => true,
    parse(body) {
        if (!body) return [];
        if (body.event === 'message_reaction') {
            const r = String(body.reaction || '');
            const v = r.replace(/^-/, '');
            return [{ kind: 'reaction', handle: body.contact, targetId: body.message_id, emoji: emojiOfTapback(v) || v, remove: r.startsWith('-'), id: body.webhook_id || `${body.message_id}:${r}` }];
        }
        if (body.event !== 'message_inbound') return [];
        return [{
            handle: body.contact,
            text: body.text || '',
            voiceText: body.message_type === 'audio' ? (body.speech?.text || '') : '',
            mediaUrls: Array.isArray(body.attachments) ? body.attachments : [],
            id: body.message_id || body.webhook_id,
            // LoopMessage 只給「回覆串的第一條」；用戶引用的多半就是那條
            replyToId: body.thread?.initial_message_id || '',
            isSticker: body.message_type === 'sticker',
            ts: Date.now(),
        }];
    },
    async sendText(acc, text, opts = {}) {
        // 文字動畫用 LoopMessage 的標記：[shake]…[/shake]
        const body = { contact: acc.userHandle, text: opts.anim ? `[${opts.anim}]${text}[/${opts.anim}]` : text, ...loopFrom(acc) };
        if (opts.replyTo) body.reply_to_id = opts.replyTo;
        if (opts.fx) body.effect = LOOP_FX[opts.fx] || opts.fx;
        return extractId(await call(`${LOOP}/send/`, { headers: loopHeaders(acc), body }));
    },
    sendMedia: async (acc, url) => extractId(await call(`${LOOP}/send/`, { headers: loopHeaders(acc), body: { contact: acc.userHandle, text: '', attachments: [url], ...loopFrom(acc) } })),
    sendVoice: async (acc, url) => extractId(await call(`${LOOP}/send/`, { headers: loopHeaders(acc), body: { contact: acc.userHandle, media_url: url, ...loopFrom(acc) } })),
    async react(acc, msgId, emoji, remove) {
        const v = tapbackOf(emoji) || pickReactionEmoji(emoji);
        await call(`${LOOP}/send/`, { headers: loopHeaders(acc), body: { contact: acc.userHandle, message_id: msgId, reaction: `${remove ? '-' : ''}${v}`, ...loopFrom(acc) } });
    },
    async typing(acc, on) {
        if (!on) return; // 發出訊息時自動消失
        const body = acc.lastMessageId ? { message_id: acc.lastMessageId, typing: 60, read: true } : { contact: acc.userHandle, sender: acc.fromNumber, typing: 60, read: true };
        await call(`${LOOP}/show-typing/`, { headers: loopHeaders(acc), body });
    },
};

// ======================= Linq =======================
const LINQ = 'https://api.linqapp.com/api/partner/v3';
const linqHeaders = (acc) => ({ Authorization: `Bearer ${acc.apiKey}` });
const LINQ_EVENTS = ['message.received', 'reaction.added', 'reaction.removed'];
// Linq 沒有流星；最接近的是 sparkles
const LINQ_SCREEN = { shooting_star: 'sparkles' };
const linqText = (parts) => (parts || []).filter((p) => p.type === 'text').map((p) => p.value).join('\n');
const linq = {
    label: 'Linq',
    caps: { fx: FX_ALL, anim: true, reply: true, react: true, sticker: true },
    async setupWebhook(acc, url) {
        // 以前註冊過同一個網址（舊版只訂了 message.received）→ 先刪掉，免得同一事件收兩次
        try {
            const list = await call(`${LINQ}/webhook-subscriptions`, { method: 'GET', headers: linqHeaders(acc) });
            const arr = Array.isArray(list) ? list : (list?.data || list?.webhook_subscriptions || list?.subscriptions || []);
            for (const w of Array.isArray(arr) ? arr : []) {
                if (w?.id && String(w.target_url || '').split('?')[0] === url) {
                    await call(`${LINQ}/webhook-subscriptions/${w.id}`, { method: 'DELETE', headers: linqHeaders(acc) }).catch(() => {});
                }
            }
        } catch { /* 列不出來就直接建 */ }
        const r = await call(`${LINQ}/webhook-subscriptions`, { headers: linqHeaders(acc), body: { subscribed_events: LINQ_EVENTS, target_url: url } });
        return { webhookSecret: r?.signing_secret || '' };
    },
    // Standard Webhooks：HMAC-SHA256(base64 解碼的 whsec_ 金鑰, "{id}.{timestamp}.{body}")，header 可帶多個簽名
    verify(headers, raw, acc) {
        if (!acc.webhookSecret) return true;
        const id = header(headers, 'webhook-id');
        const ts = header(headers, 'webhook-timestamp');
        const sigs = header(headers, 'webhook-signature');
        if (!id || !ts || !sigs) return false;
        if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
        const key = Buffer.from(String(acc.webhookSecret).replace(/^whsec_/, ''), 'base64');
        const expected = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
        return String(sigs).split(' ').some((s) => timingSafeEq(s.split(',')[1] || '', expected));
    },
    parse(body) {
        if (!body) return [];
        const type = body.event_type || body.type;
        const d = body.data || {};
        if (type === 'reaction.added' || type === 'reaction.removed') {
            if (d.is_from_me) return [];
            const rt = String(d.reaction_type || '');
            const emoji = rt === 'custom' ? (d.custom_emoji || '[image]') : rt === 'sticker' ? (d.custom_emoji || '[sticker]') : (emojiOfTapback(rt) || rt);
            return [{
                kind: 'reaction',
                handle: d.from_handle?.handle || d.from,
                targetId: d.message_id,
                emoji,
                remove: type === 'reaction.removed',
                id: body.event_id || `${d.reaction_id}:${type}`,
                chatId: d.chat_id,
            }];
        }
        if (type !== 'message.received') return [];
        // 兩種 webhook 版本：2026-02-03（chat/sender_handle/parts）與 2025-01-01（chat_id/from/message）
        const fromMe = d.direction ? d.direction !== 'inbound' : !!d.is_from_me;
        if (fromMe) return [];
        const parts = d.parts || d.message?.parts || [];
        const effect = d.effect || d.message?.effect;
        const reply = d.reply_to || d.message?.reply_to;
        const media = parts.filter((p) => p.type === 'media' && p.url);
        return [{
            handle: d.sender_handle?.handle || d.from || d.from_handle?.handle,
            chatId: d.chat?.id || d.chat_id,
            text: linqText(parts),
            mediaUrls: media.map((p) => p.url),
            isSticker: media.length > 0 && media.every((p) => p.sticker),
            id: d.id || d.message?.id || body.event_id,
            replyToId: reply?.message_id || '',
            effect: effect?.name || '',
            ts: Date.parse(d.sent_at || d.message?.sent_at || body.created_at) || Date.now(),
        }];
    },
    async _send(acc, parts, extra = {}) {
        const message = { parts, ...extra };
        if (acc.chatId) return extractId(await call(`${LINQ}/chats/${acc.chatId}/messages`, { headers: linqHeaders(acc), body: { message } }));
        const r = await call(`${LINQ}/messages`, { headers: linqHeaders(acc), body: { to: [acc.userHandle], message } });
        if (r?.chat_id) acc._newChatId = r.chat_id; // 核心存起來，之後都發同一個對話
        return extractId(r);
    },
    sendText(acc, text, opts = {}) {
        const part = { type: 'text', value: text };
        // 文字動畫套整句（range 以 UTF-16 計，正好是 JS 字串長度）
        if (opts.anim) part.text_decorations = [{ range: [0, text.length], animation: opts.anim }];
        const extra = {};
        if (opts.replyTo) extra.reply_to = { message_id: opts.replyTo };
        if (opts.fx) extra.effect = BUBBLE_FX.has(opts.fx) ? { type: 'bubble', name: opts.fx } : { type: 'screen', name: LINQ_SCREEN[opts.fx] || opts.fx };
        return linq._send(acc, [part], extra);
    },
    sendMedia: (acc, url) => linq._send(acc, [{ type: 'media', url }]),
    // 原生貼紙：media part 帶 sticker:true（不是一大張圖片）
    sendSticker: (acc, url) => linq._send(acc, [{ type: 'media', url, sticker: true }]),
    // 專用語音備忘錄介面：iMessage 顯示原生語音條
    async sendVoice(acc, url) {
        if (!acc.chatId) return linq.sendMedia(acc, url);
        return extractId(await call(`${LINQ}/chats/${acc.chatId}/voicememo`, { headers: linqHeaders(acc), body: { voice_memo_url: url } }));
    },
    async react(acc, msgId, emoji, remove) {
        const tb = tapbackOf(emoji);
        const operation = remove ? 'remove' : 'add';
        const body = tb ? { operation, type: tb } : { operation, type: 'custom', custom_emoji: pickReactionEmoji(emoji) };
        await call(`${LINQ}/messages/${msgId}/reactions`, { headers: linqHeaders(acc), body });
    },
    async fetchText(acc, msgId) {
        const r = await call(`${LINQ}/messages/${msgId}`, { method: 'GET', headers: linqHeaders(acc) });
        const m = r?.data || r?.message || r || {};
        const text = linqText(m.parts);
        return { text: text || ((m.parts || []).some((p) => p.type === 'media') ? '[图片]' : ''), fromMe: !!m.is_from_me };
    },
    async typing(acc, on) {
        if (!acc.chatId) return;
        await call(`${LINQ}/chats/${acc.chatId}/typing`, { method: on ? 'POST' : 'DELETE', headers: linqHeaders(acc) });
    },
};

// ======================= Blooio =======================
const BLOO = 'https://api.blooio.com/v4';
const blooHeaders = (acc) => ({ Authorization: `Bearer ${acc.apiKey}` });
const blooFrom = (acc) => (acc.fromNumber ? { from: acc.fromNumber } : {});
// Blooio 貼紙只收 PNG / APNG / GIF / HEIC
const BLOO_STICKER_MIME = /^image\/(png|apng|gif|heic|heif)$/i;
const blooio = {
    label: 'Blooio',
    // 特效名 Blooio 文件沒列，先用通用名字試；被拒絕時核心會改發不帶特效的
    caps: { fx: FX_ALL, anim: false, reply: true, react: true, sticker: true },
    async setupWebhook(acc, url) {
        const r = await call(`${BLOO}/webhooks`, { headers: blooHeaders(acc), body: { url } });
        return { webhookSecret: r?.signing_secret || r?.data?.signing_secret || '' };
    },
    // X-Blooio-Signature: t=<秒>,v1=<hex>，HMAC-SHA256("{t}.{raw}")
    verify(headers, raw, acc) {
        if (!acc.webhookSecret) return true;
        const sig = header(headers, 'x-blooio-signature');
        const m = /t=(\d+),\s*v1=([0-9a-f]+)/i.exec(sig || '');
        if (!m) return false;
        if (Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
        const expected = createHmac('sha256', acc.webhookSecret).update(`${m[1]}.${raw}`).digest('hex');
        return timingSafeEq(m[2].toLowerCase(), expected);
    },
    parse(body) {
        if (!body) return [];
        const d = body.data || {};
        if (d.direction && d.direction !== 'inbound') return [];
        const sender = typeof d.sender === 'string' ? d.sender : (d.sender?.identifier || d.sender?.id);
        if (body.type === 'message.reaction') {
            const r = String(d.reaction || '');
            const remove = d.action === 'remove' || r.startsWith('-');
            const v = r.replace(/^[+-]/, '');
            return [{
                kind: 'reaction',
                handle: sender || d.contact?.identifier,
                targetId: d.message_id,
                emoji: v === 'sticker' ? '[sticker]' : (emojiOfTapback(v) || v),
                remove,
                id: body.id || `${d.message_id}:${r}:${body.created_at}`,
                chatId: d.chat_id,
            }];
        }
        if (body.type !== 'message.received') return [];
        return [{
            handle: d.contact?.identifier || sender,
            chatId: d.chat_id,
            text: d.text || '',
            mediaUrls: (d.attachments || []).map((a) => a?.url).filter(Boolean),
            isSticker: d.message_type === 'sticker',
            id: d.message_id || body.id,
            replyToId: d.reply_to_message_id || '',
            effect: typeof d.effect === 'string' ? d.effect : (d.effect?.name || ''),
            ts: Number(body.created_at) || Date.now(),
        }];
    },
    async sendText(acc, text, opts = {}) {
        const body = { to: acc.userHandle, text, ...blooFrom(acc) };
        if (opts.replyTo) body.reply_to = opts.replyTo;
        if (opts.fx) body.effect = opts.fx;
        return extractId(await call(`${BLOO}/messages`, { headers: blooHeaders(acc), body }));
    },
    sendMedia: async (acc, url) => extractId(await call(`${BLOO}/messages`, { headers: blooHeaders(acc), body: { to: acc.userHandle, attachments: [url], ...blooFrom(acc) } })),
    async sendSticker(acc, url, mime) {
        if (mime && !BLOO_STICKER_MIME.test(mime)) throw new ProviderError(`sticker format ${mime} not supported`);
        return extractId(await call(`${BLOO}/messages`, { headers: blooHeaders(acc), body: { to: acc.userHandle, sticker: { url }, ...blooFrom(acc) } }));
    },
    // 單獨一個音頻附件 → Blooio 自動發成語音條
    sendVoice: (acc, url) => blooio.sendMedia(acc, url),
    async react(acc, msgId, emoji, remove) {
        if (!acc.chatId) throw new ProviderError('no chat yet');
        const v = tapbackOf(emoji) || pickReactionEmoji(emoji);
        await call(`${BLOO}/chats/${acc.chatId}/messages/${msgId}/reactions`, { headers: blooHeaders(acc), body: { reaction: `${remove ? '-' : '+'}${v}` } });
    },
    async fetchText(acc, msgId) {
        if (!acc.chatId) return null;
        const r = await call(`${BLOO}/chats/${acc.chatId}/messages/${msgId}`, { method: 'GET', headers: blooHeaders(acc) });
        const m = r?.data || r || {};
        return { text: m.text || ((m.attachments || []).length ? '[图片]' : ''), fromMe: m.direction === 'outbound' };
    },
    async typing(acc, on) {
        if (!acc.chatId) return;
        await call(`${BLOO}/chats/${acc.chatId}/typing`, { headers: blooHeaders(acc), body: { state: on ? 'started' : 'stopped' } });
    },
};

export const PROVIDERS = { sendblue, loopmessage, linq, blooio };
