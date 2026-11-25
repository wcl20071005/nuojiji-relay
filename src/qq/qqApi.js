// QQ 官方機器人（QQ 開放平台 API v2）：單聊（C2C）收發。
//
// 文件：https://bot.q.qq.com/wiki/develop/api-v2/
//   - access_token：POST https://api.bot.qq.com/app/getAppAccessToken { appId, clientSecret } → { access_token, expires_in }
//     （業務錯誤放在 body.code，HTTP 仍是 200）；呼叫 API 帶 Authorization: QQBot <token>
//   - 收訊息走 HTTP 回調（webhook）：簽名 Ed25519，種子 = Bot Secret 重複到 ≥32 字節再取前 32
//       一般事件：簽 X-Signature-Timestamp + 原始 body，簽名 hex 放 X-Signature-Ed25519
//       回調地址驗證（op 13）：簽 event_ts + plain_token，回 { plain_token, signature }
//   - 單聊回覆：POST /v2/users/{openid}/messages；帶 msg_id = 被動回覆（每條用戶訊息有限次數 / 時效），
//     不帶 = 主動消息（個人 Bot 每用戶每日上限 1000；用戶可在 QQ 裡關「允許主動發送」）
//   - 富媒體：先 POST /v2/users/{openid}/files { file_type, url } 拿 file_info，再發 msg_type 7

export const QQ_API = 'https://api.sgroup.qq.com';
export const QQ_TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';

// 被動回覆：文件寫「單聊 60 分鐘內、每條最多回 4 次」（另一處寫 msg_id 5 分鐘有效 → 失敗就改主動發）
export const PASSIVE_WINDOW_MS = 60 * 60 * 1000;
export const PASSIVE_MAX = 4;
// 過期 / 超次數的錯誤碼 → 改用主動消息重發
const PASSIVE_EXPIRED_CODES = new Set([40034128, 304103, 40034024, 22009]);

export const FileType = { IMAGE: 1, VIDEO: 2, VOICE: 3, FILE: 4 };

export class QqError extends Error {
    constructor(message, { code, status } = {}) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytesOfHex = (hex) => {
    if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
};
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };

// ---------- Ed25519（WebCrypto；Workers 與 Node 都有） ----------
function seedOf(secret) {
    let s = utf8(String(secret || ''));
    if (!s.length) throw new Error('empty secret');
    while (s.length < 32) s = concat(s, s);
    return s.slice(0, 32);
}
// PKCS#8 包一個 Ed25519 種子
const PKCS8_PREFIX = bytesOfHex('302e020100300506032b657004220420');

const _keyCache = new Map();
export async function qqKeys(secret) {
    if (_keyCache.has(secret)) return _keyCache.get(secret);
    const p = (async () => {
        const priv = await crypto.subtle.importKey('pkcs8', concat(PKCS8_PREFIX, seedOf(secret)), { name: 'Ed25519' }, true, ['sign']);
        const jwk = await crypto.subtle.exportKey('jwk', priv);
        const pub = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
        return { priv, pub };
    })();
    _keyCache.set(secret, p);
    p.catch(() => _keyCache.delete(secret));
    return p;
}

export async function qqSign(secret, message) {
    const { priv } = await qqKeys(secret);
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, typeof message === 'string' ? utf8(message) : message);
    return hexOf(new Uint8Array(sig));
}

/** 驗一般事件：簽名 = Ed25519(timestamp + 原始 body) */
export async function qqVerify(secret, headers, raw) {
    const h = (k) => headers?.[k] ?? headers?.[k.toLowerCase()];
    const sig = bytesOfHex(String(h('X-Signature-Ed25519') || ''));
    const ts = String(h('X-Signature-Timestamp') || '');
    if (!sig || sig.length !== 64 || (sig[63] & 224) !== 0 || !ts) return false;
    try {
        const { pub } = await qqKeys(secret);
        return await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, concat(utf8(ts), utf8(raw)));
    } catch { return false; }
}

/** 回調地址驗證（op 13）的回應 */
export async function qqValidationReply(secret, d) {
    const plainToken = String(d?.plain_token || '');
    return { plain_token: plainToken, signature: await qqSign(secret, `${d?.event_ts || ''}${plainToken}`) };
}

// ---------- HTTP ----------
async function readJson(res) {
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

export async function fetchAccessToken(appId, appSecret) {
    const res = await fetch(QQ_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: String(appId), clientSecret: String(appSecret) }),
    });
    const j = await readJson(res);
    if (!res.ok || !j.access_token) throw new QqError(`QQ token: ${j.message || j.msg || j.raw || `HTTP ${res.status}`}`, { code: j.code, status: res.status });
    return { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 7200) * 1000 };
}

export async function qqCall(token, method, path, body) {
    const res = await fetch(`${QQ_API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const j = await readJson(res);
    if (!res.ok || (typeof j.code === 'number' && j.code !== 0)) {
        throw new QqError(`QQ ${path.split('/').slice(-1)[0]}: ${j.message || j.msg || j.raw || `HTTP ${res.status}`}${j.code != null ? ` (${j.code})` : ''}`, { code: j.code ?? j.err_code, status: res.status });
    }
    return j;
}

export const isPassiveExpired = (e) => PASSIVE_EXPIRED_CODES.has(Number(e?.code));

/** C2C 事件 → { id, openid, text, voiceText, mediaUrls, ts } */
export function parseC2c(d) {
    const atts = Array.isArray(d?.attachments) ? d.attachments : [];
    const fix = (u) => (typeof u === 'string' && u.startsWith('//') ? `https:${u}` : u);
    let voiceText = '';
    const mediaUrls = [];
    for (const a of atts) {
        const ct = String(a?.content_type || '');
        if (ct === 'voice' || ct.startsWith('audio')) {
            // 語音：有 ASR 文字就當語音訊息的內容；原檔是 SILK，抓 wav 版本存檔
            if (a.asr_refer_text) voiceText = String(a.asr_refer_text);
            if (a.voice_wav_url) mediaUrls.push(fix(a.voice_wav_url));
            else if (!a.asr_refer_text && a.url) mediaUrls.push(fix(a.url));
        } else if (a?.url) {
            mediaUrls.push(fix(a.url));
        }
    }
    const ts = Date.parse(d?.timestamp || '') || Date.now();
    return {
        id: String(d?.id || ''),
        openid: String(d?.author?.user_openid || d?.author?.id || ''),
        text: String(d?.content || '').trim(),
        voiceText,
        mediaUrls,
        ts,
    };
}
