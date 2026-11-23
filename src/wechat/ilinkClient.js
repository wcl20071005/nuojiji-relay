// 微信 ClawBot（iLink Bot API）協議客戶端。
//
// 協議依據：騰訊官方 MIT 插件 @tencent-weixin/openclaw-weixin 2.4.x 原始碼，並經真機實測：
//   - 一個微信號只能綁一個 Bot（新綁會頂掉舊的）
//   - 每條用戶訊息（context_token）最多回 10 條，第 11 條 ret=-2
//   - 語音條發不出去（伺服器回 ok 但用戶收不到）、GIF 只顯示靜態
// 只用 fetch / Uint8Array，Workers 與 Node 共用。

import { createHash } from 'node:crypto';
import { aesEcbEncrypt, aesEcbDecrypt, aesEcbPaddedSize } from './aesEcb.js';

export const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
// 每條用戶訊息可回的上限（實測）
export const REPLY_QUOTA = 10;

const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);
const BASE_INFO = { channel_version: '2.4.10', bot_agent: 'NuojijiRelay/1.0' };

export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
export const UploadType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };

// ---------- 小工具 ----------
export function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
export function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

function randomUin() {
    const v = new DataView(randomBytes(4).buffer).getUint32(0);
    return btoa(String(v));
}

// message_id 等 uint64 欄位先轉字串，避免 JSON.parse 丟精度
const parseJson = (text) => JSON.parse(String(text).replace(/"(message_id|msg_id|svr_id)"\s*:\s*(-?\d+)/g, '"$1":"$2"'));

function headers(token) {
    const h = {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomUin(),
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': CLIENT_VERSION,
    };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
}

function joinUrl(base, endpoint) {
    return new URL(endpoint, base.endsWith('/') ? base : `${base}/`).toString();
}

export class IlinkError extends Error {
    constructor(message, { ret, errcode, status } = {}) {
        super(message);
        this.ret = ret; this.errcode = errcode; this.status = status;
    }
    // errcode -14 = 登入失效（用戶在微信裡解綁 / 被新 Bot 頂掉）
    get sessionExpired() { return this.errcode === -14 || this.ret === -14; }
}

async function post(baseUrl, endpoint, body, token, { timeoutMs = 15000, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
        const res = await fetch(joinUrl(baseUrl, endpoint), {
            method: 'POST', headers: headers(token), signal: ctrl.signal,
            body: JSON.stringify({ ...body, base_info: BASE_INFO }),
        });
        const text = await res.text();
        if (!res.ok) throw new IlinkError(`${endpoint} HTTP ${res.status}: ${text}`, { status: res.status });
        return text ? parseJson(text) : {};
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
    }
}

function assertOk(resp, label) {
    const ret = resp?.ret ?? 0;
    const errcode = resp?.errcode ?? 0;
    if ((ret && ret !== 0) || (errcode && errcode !== 0)) {
        throw new IlinkError(`${label} ret=${ret} errcode=${errcode} ${resp?.errmsg || ''}`.trim(), { ret, errcode });
    }
    return resp;
}

// ---------- 登入 ----------
export async function fetchLoginQr() {
    const r = await post(ILINK_BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] });
    if (!r?.qrcode || !r?.qrcode_img_content) throw new IlinkError('get_bot_qrcode: empty response');
    return { qrcode: r.qrcode, qrcodeUrl: r.qrcode_img_content };
}

// 長輪詢掃碼狀態（伺服器最多掛 ~35s）。回傳原始 status：wait/scaned/need_verifycode/expired/
// verify_code_blocked/binded_redirect/scaned_but_redirect/confirmed
export async function pollLoginStatus(baseUrl, qrcode, verifyCode, { timeoutMs = 30000 } = {}) {
    let ep = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) ep += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(joinUrl(baseUrl, ep), {
            headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION }, signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) return { status: 'wait' }; // 閘道 5xx 等當作繼續等
        return JSON.parse(text);
    } catch (e) {
        if (e?.name === 'AbortError') return { status: 'wait' };
        throw e;
    } finally { clearTimeout(timer); }
}

// ---------- 收發 ----------
export async function getUpdates(bot, cursor, { timeoutMs = 38000, signal } = {}) {
    try {
        const r = await post(bot.baseUrl, 'ilink/bot/getupdates', { get_updates_buf: cursor || '' }, bot.token, { timeoutMs, signal });
        return assertOk(r, 'getupdates');
    } catch (e) {
        // 客戶端逾時 / 主動中止 = 長輪詢正常結束，當作沒有新訊息
        if (e?.name === 'AbortError') return { msgs: [], get_updates_buf: cursor };
        throw e;
    }
}

export async function notifyStart(bot) {
    try { await post(bot.baseUrl, 'ilink/bot/msg/notifystart', {}, bot.token, { timeoutMs: 10000 }); } catch { /* 可略 */ }
}
export async function notifyStop(bot) {
    try { await post(bot.baseUrl, 'ilink/bot/msg/notifystop', {}, bot.token, { timeoutMs: 10000 }); } catch { /* 可略 */ }
}

function newClientId() {
    return `nuojiji-${bytesToHex(randomBytes(8))}`;
}

export async function sendItem(bot, toUserId, contextToken, item) {
    const r = await post(bot.baseUrl, 'ilink/bot/sendmessage', {
        msg: {
            from_user_id: '', to_user_id: toUserId, client_id: newClientId(),
            message_type: 2, message_state: 2, item_list: [item], context_token: contextToken || undefined,
        },
    }, bot.token);
    return assertOk(r, 'sendmessage');
}

export const sendText = (bot, to, ctx, text) => sendItem(bot, to, ctx, { type: ItemType.TEXT, text_item: { text } });

export async function getTypingTicket(bot, toUserId, contextToken) {
    const r = await post(bot.baseUrl, 'ilink/bot/getconfig', { ilink_user_id: toUserId, context_token: contextToken }, bot.token, { timeoutMs: 10000 });
    return r?.typing_ticket || '';
}

export async function sendTyping(bot, toUserId, ticket, on) {
    if (!ticket) return;
    try {
        await post(bot.baseUrl, 'ilink/bot/sendtyping', { ilink_user_id: toUserId, typing_ticket: ticket, status: on ? 1 : 2 }, bot.token, { timeoutMs: 10000 });
    } catch { /* 輸入中提示失敗不影響回覆 */ }
}

// ---------- CDN 媒體 ----------
function parseAesKey(b64) {
    const d = b64ToBytes(b64);
    if (d.length === 16) return d;
    const asText = new TextDecoder().decode(d);
    if (d.length === 32 && /^[0-9a-f]{32}$/i.test(asText)) return hexToBytes(asText);
    throw new Error('unrecognized aes_key format');
}

// 下載並解密收到的媒體（圖片 / 語音 / 檔案）。image_item 的金鑰可能放在 aeskey(hex)。
export async function downloadMedia(media, hexKey) {
    if (!media) throw new Error('no media');
    const url = media.full_url || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param || '')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CDN download HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const key = hexKey ? hexToBytes(hexKey) : (media.aes_key ? parseAesKey(media.aes_key) : null);
    return key ? aesEcbDecrypt(buf, key) : buf;
}

async function upload(bot, toUserId, bytes, mediaType) {
    const aeskey = randomBytes(16);
    const filekey = bytesToHex(randomBytes(16));
    const r = await post(bot.baseUrl, 'ilink/bot/getuploadurl', {
        filekey, media_type: mediaType, to_user_id: toUserId,
        rawsize: bytes.length, rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: aesEcbPaddedSize(bytes.length), no_need_thumb: true, aeskey: bytesToHex(aeskey),
    }, bot.token);
    const url = r?.upload_full_url?.trim()
        || (r?.upload_param ? `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(r.upload_param)}&filekey=${encodeURIComponent(filekey)}` : '');
    if (!url) throw new Error('getuploadurl returned no url');
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: aesEcbEncrypt(bytes, aeskey) });
    if (res.status !== 200) throw new Error(`CDN upload HTTP ${res.status} ${res.headers.get('x-error-message') || ''}`);
    const param = res.headers.get('x-encrypted-param');
    if (!param) throw new Error('CDN upload: missing x-encrypted-param');
    return {
        // aes_key 與官方插件一致：base64(hex 字串)
        media: { encrypt_query_param: param, aes_key: btoa(bytesToHex(aeskey)), encrypt_type: 1 },
        cipherSize: aesEcbPaddedSize(bytes.length),
    };
}

export async function sendImage(bot, to, ctx, bytes) {
    const u = await upload(bot, to, bytes, UploadType.IMAGE);
    return sendItem(bot, to, ctx, { type: ItemType.IMAGE, image_item: { media: u.media, mid_size: u.cipherSize } });
}

export async function sendFile(bot, to, ctx, bytes, fileName) {
    const u = await upload(bot, to, bytes, UploadType.FILE);
    return sendItem(bot, to, ctx, { type: ItemType.FILE, file_item: { media: u.media, file_name: fileName, len: String(bytes.length) } });
}
