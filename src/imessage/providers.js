// iMessage 第三方平台 adapter：Sendblue / LoopMessage / Linq / Blooio。
//
// 每家實作同一組方法（依各家官方 API 文件，2026-11 讀）：
//   setupWebhook(acc, url)            能用 API 註冊 webhook 的就自動註冊（回傳要存的 { webhookSecret? }）；不能的回 null（用戶到後台貼網址）
//   verify(headers, raw, acc)          驗 webhook 簽章（沒簽章機制的回 true，靠網址裡的隨機 token 防偽）
//   parse(body)                        webhook → [{ handle, text, mediaUrls, id, ts, chatId, voiceText }]，只回「用戶發來的」
//   sendText(acc, text) / sendMedia(acc, url) / sendVoice(acc, url) / typing(acc, on)
// acc = { provider, apiKey, apiSecret, fromNumber, userHandle, chatId, lastMessageId, webhookSecret }
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

// ======================= Sendblue =======================
const SB = 'https://api.sendblue.com';
const sbHeaders = (acc) => ({ 'sb-api-key-id': acc.apiKey, 'sb-api-secret-key': acc.apiSecret });
const sendblue = {
    label: 'Sendblue',
    needsSecret: true, // API Key ID + API Secret Key 兩組
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
            text: body.content || '',
            mediaUrls: body.media_url ? [body.media_url] : [],
            id: body.message_handle,
            ts: Date.parse(body.date_sent) || Date.now(),
        }];
    },
    sendText: (acc, text) => call(`${SB}/api/send-message`, { headers: sbHeaders(acc), body: { number: acc.userHandle, from_number: acc.fromNumber || undefined, content: text } }),
    sendMedia: (acc, url) => call(`${SB}/api/send-message`, { headers: sbHeaders(acc), body: { number: acc.userHandle, from_number: acc.fromNumber || undefined, media_url: url } }),
    // Sendblue 只有 .caf 會顯示成語音條；雲端轉不了 caf → mp3 以可播放的音頻附件送達
    sendVoice: (acc, url) => sendblue.sendMedia(acc, url),
    async typing(acc, on) {
        await call(`${SB}/api/send-typing-indicator`, { headers: sbHeaders(acc), body: { number: acc.userHandle, from_number: acc.fromNumber || undefined, state: on ? 'start' : 'stop' } });
    },
};

// ======================= LoopMessage =======================
const LOOP = 'https://a.loopmessage.com/api/v1/message';
const loopHeaders = (acc) => ({ Authorization: acc.apiKey });
const loopmessage = {
    label: 'LoopMessage',
    setupWebhook: async () => null, // webhook 在 LoopMessage 後台設定
    verify: () => true,
    parse(body) {
        if (!body || body.event !== 'message_inbound') return [];
        return [{
            handle: body.contact,
            text: body.text || '',
            voiceText: body.message_type === 'audio' ? (body.speech?.text || '') : '',
            mediaUrls: Array.isArray(body.attachments) ? body.attachments : [],
            id: body.message_id || body.webhook_id,
            ts: Date.now(),
        }];
    },
    sendText: (acc, text) => call(`${LOOP}/send/`, { headers: loopHeaders(acc), body: { contact: acc.userHandle, text, ...(acc.fromNumber ? { sender: acc.fromNumber } : {}) } }),
    sendMedia: (acc, url) => call(`${LOOP}/send/`, { headers: loopHeaders(acc), body: { contact: acc.userHandle, text: '', attachments: [url], ...(acc.fromNumber ? { sender: acc.fromNumber } : {}) } }),
    sendVoice: (acc, url) => call(`${LOOP}/send/`, { headers: loopHeaders(acc), body: { contact: acc.userHandle, media_url: url, ...(acc.fromNumber ? { sender: acc.fromNumber } : {}) } }),
    async typing(acc, on) {
        if (!on) return; // 發出訊息時自動消失
        const body = acc.lastMessageId ? { message_id: acc.lastMessageId, typing: 60, read: true } : { contact: acc.userHandle, sender: acc.fromNumber, typing: 60, read: true };
        await call(`${LOOP}/show-typing/`, { headers: loopHeaders(acc), body });
    },
};

// ======================= Linq =======================
const LINQ = 'https://api.linqapp.com/api/partner/v3';
const linqHeaders = (acc) => ({ Authorization: `Bearer ${acc.apiKey}` });
const linq = {
    label: 'Linq',
    async setupWebhook(acc, url) {
        const r = await call(`${LINQ}/webhook-subscriptions`, { headers: linqHeaders(acc), body: { subscribed_events: ['message.received'], target_url: url } });
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
        if (!body || (body.event_type || body.type) !== 'message.received') return [];
        const d = body.data || {};
        // 兩種 webhook 版本：2026-02-03（chat/sender_handle/parts）與 2025-01-01（chat_id/from/message）
        const fromMe = d.direction ? d.direction !== 'inbound' : !!d.is_from_me;
        if (fromMe) return [];
        const parts = d.parts || d.message?.parts || [];
        return [{
            handle: d.sender_handle?.handle || d.from || d.from_handle?.handle,
            chatId: d.chat?.id || d.chat_id,
            text: parts.filter((p) => p.type === 'text').map((p) => p.value).join('\n'),
            mediaUrls: parts.filter((p) => p.type === 'media' && p.url).map((p) => p.url),
            id: d.id || d.message?.id || body.event_id,
            ts: Date.parse(d.sent_at || d.message?.sent_at || body.created_at) || Date.now(),
        }];
    },
    async _send(acc, parts) {
        if (acc.chatId) return call(`${LINQ}/chats/${acc.chatId}/messages`, { headers: linqHeaders(acc), body: { message: { parts } } });
        const r = await call(`${LINQ}/messages`, { headers: linqHeaders(acc), body: { to: [acc.userHandle], message: { parts } } });
        if (r?.chat_id) acc._newChatId = r.chat_id; // 核心存起來，之後都發同一個對話
        return r;
    },
    sendText: (acc, text) => linq._send(acc, [{ type: 'text', value: text }]),
    sendMedia: (acc, url) => linq._send(acc, [{ type: 'media', url }]),
    // 專用語音備忘錄介面：iMessage 顯示原生語音條
    async sendVoice(acc, url) {
        if (!acc.chatId) return linq.sendMedia(acc, url);
        return call(`${LINQ}/chats/${acc.chatId}/voicememo`, { headers: linqHeaders(acc), body: { voice_memo_url: url } });
    },
    async typing(acc, on) {
        if (!acc.chatId) return;
        await call(`${LINQ}/chats/${acc.chatId}/typing`, { method: on ? 'POST' : 'DELETE', headers: linqHeaders(acc) });
    },
};

// ======================= Blooio =======================
const BLOO = 'https://api.blooio.com/v4';
const blooHeaders = (acc) => ({ Authorization: `Bearer ${acc.apiKey}` });
const blooio = {
    label: 'Blooio',
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
        if (!body || body.type !== 'message.received') return [];
        const d = body.data || {};
        if (d.direction && d.direction !== 'inbound') return [];
        const sender = typeof d.sender === 'string' ? d.sender : (d.sender?.identifier || d.sender?.id);
        return [{
            handle: d.contact?.identifier || sender,
            chatId: d.chat_id,
            text: d.text || '',
            mediaUrls: (d.attachments || []).map((a) => a?.url).filter(Boolean),
            id: d.message_id || body.id,
            ts: Number(body.created_at) || Date.now(),
        }];
    },
    sendText: (acc, text) => call(`${BLOO}/messages`, { headers: blooHeaders(acc), body: { to: acc.userHandle, text, ...(acc.fromNumber ? { from: acc.fromNumber } : {}) } }),
    sendMedia: (acc, url) => call(`${BLOO}/messages`, { headers: blooHeaders(acc), body: { to: acc.userHandle, attachments: [url], ...(acc.fromNumber ? { from: acc.fromNumber } : {}) } }),
    // 單獨一個音頻附件 → Blooio 自動發成語音條
    sendVoice: (acc, url) => blooio.sendMedia(acc, url),
    async typing(acc, on) {
        if (!acc.chatId) return;
        await call(`${BLOO}/chats/${acc.chatId}/typing`, { headers: blooHeaders(acc), body: { state: on ? 'started' : 'stopped' } });
    },
};

export const PROVIDERS = { sendblue, loopmessage, linq, blooio };
