// iMessage 橋接（透過第三方平台 Sendblue / LoopMessage / Linq / Blooio）。
// 共用邏輯在 chatbridge/baseCore.js，這裡只管：
//   - 平台帳號設定（自動註冊 webhook，能的話）
//   - 收 webhook（網址帶隨機 token；Linq / Blooio 另驗簽章）、只接受用戶本人的號碼
//   - 連發合併：訊息先進 pending，排程器 4 秒後一起回（每來一條就往後推）
//   - 發送通道：文字 / 表情圖（網址）/ 語音（合成 mp3 放在中繼公開網址給平台抓）
//
// iMessage 特有 storage key：
//   acc        { provider, apiKey, apiSecret, fromNumber, userHandle, chatId, lastMessageId, webhookSecret, hookToken, publicBase, createdAt }
//   pending    待回覆的用戶訊息
//   seen       最近處理過的訊息 id
//   pub:<id>   給平台抓的公開音頻（合成語音），一天後清
//   lastUserAt 最後一條用戶訊息時間

import { ChannelBridgeCore, MEDIA_MAX_BYTES, sniffMime, newMediaId, now, replyWaitMs, replyWaitCapMs } from '../chatbridge/baseCore.js';
import { PROVIDERS, normHandle } from './providers.js';
import { bytesToB64, b64ToBytes } from '../wechat/ilinkClient.js';

const DEBOUNCE_MS = 5000;
const SEEN_CAP = 300;
const PUB_TTL_MS = 24 * 3600e3;

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');

export class ImessageBridgeCore extends ChannelBridgeCore {
    constructor(storage, env, hooks) {
        super(storage, env, hooks, { prefix: '/imessage', label: 'iMessage', logPrefix: 'im' });
    }

    async handleChannel(method, path, query, body) {
        switch (`${method} ${path}`) {
            case 'POST /imessage/setup': return this.setup(body || {});
            case 'POST /imessage/unbind': return this.unbind();
            case 'POST /imessage/test': return this.sendTest();
            default: return null;
        }
    }

    _webhookUrl(acc, inboxId) {
        return `${acc.publicBase}/imessage/hook/${encodeURIComponent(inboxId)}/${acc.hookToken}`;
    }

    async channelStatus() {
        const [acc, inboxId, lastUserAt] = await Promise.all([this.s.get('acc'), this.s.get('inbox'), this.s.get('lastUserAt')]);
        return {
            bound: !!acc,
            provider: acc?.provider || null,
            userHandle: acc?.userHandle || '',
            fromNumber: acc?.fromNumber || '',
            webhookUrl: acc && inboxId ? this._webhookUrl(acc, inboxId) : '',
            webhookAuto: !!acc?.webhookAuto,
            lastUserAt: lastUserAt || 0,
        };
    }

    // 手機端填好平台帳號後呼叫：存設定 + 能自動註冊 webhook 的就註冊
    async setup(body) {
        const provider = PROVIDERS[body.provider];
        if (!provider) return { status: 400, json: { error: `unsupported provider: ${body.provider}` } };
        if (!body.apiKey) return { status: 400, json: { error: 'apiKey required' } };
        if (provider.needsSecret && !body.apiSecret) return { status: 400, json: { error: 'apiSecret required' } };
        if (!body.userHandle) return { status: 400, json: { error: 'userHandle required' } };
        if (!body.publicBase) return { status: 400, json: { error: 'publicBase required' } };
        const prev = (await this.s.get('acc')) || {};
        const sameAccount = prev.provider === body.provider && prev.apiKey === body.apiKey;
        const acc = {
            provider: body.provider,
            apiKey: String(body.apiKey).trim(),
            apiSecret: String(body.apiSecret || '').trim(),
            fromNumber: String(body.fromNumber || '').trim(),
            userHandle: String(body.userHandle).trim(),
            // 換平台 / 換帳號 → 換新 token，舊 webhook 網址作廢
            hookToken: sameAccount && prev.hookToken ? prev.hookToken : randomToken(),
            webhookSecret: sameAccount ? (prev.webhookSecret || '') : '',
            chatId: sameAccount && normHandle(prev.userHandle) === normHandle(body.userHandle) ? (prev.chatId || '') : '',
            publicBase: String(body.publicBase).replace(/\/+$/, ''),
            createdAt: prev.createdAt || now(),
        };
        const inboxId = await this.s.get('inbox');
        const url = this._webhookUrl(acc, inboxId);
        let webhookAuto = false, webhookError = '';
        if (body.registerWebhook !== false && !(sameAccount && prev.webhookAuto && prev.hookToken === acc.hookToken)) {
            try {
                const r = await provider.setupWebhook(acc, url);
                if (r) { webhookAuto = true; if (r.webhookSecret) acc.webhookSecret = r.webhookSecret; }
            } catch (e) {
                webhookError = String(e?.message || e);
            }
        } else if (sameAccount) webhookAuto = !!prev.webhookAuto;
        acc.webhookAuto = webhookAuto;
        await this.s.put('acc', acc);
        return { json: { ok: true, webhookUrl: url, webhookAuto, webhookError } };
    }

    async unbind() {
        await Promise.all(['acc', 'pending', 'pendingSince', 'seen'].map((k) => this.s.delete(k)));
        await this.hooks.schedule(null);
        return { json: { ok: true } };
    }

    // 「發一條測試」：確認 API Key / 號碼對不對
    async sendTest() {
        const opened = await this.openChannel();
        if (!opened?.chan) return { status: 400, json: { ok: false, error: opened?.reason || 'not set up' } };
        try {
            await opened.chan.sendText('糯叽机已连接 iMessage。直接回这条消息就能和角色聊天，发「/切换」换角色。');
            return { json: { ok: true } };
        } catch (e) {
            return { status: 502, json: { ok: false, error: String(e?.message || e) } };
        }
    }

    // ---------- 公開音頻（給平台抓合成語音） ----------
    async getPublic(token, id) {
        const acc = await this.s.get('acc');
        if (!acc || token !== acc.hookToken) return null;
        // 本機表情：stk_<hash>.<ext>
        const stk = /^stk_([a-f0-9]+)\.\w+$/.exec(String(id || ''));
        if (stk) {
            const s = await this.loadSticker(`stk:${stk[1]}`);
            return s ? { mime: s.mime, bytes: s.bytes } : null;
        }
        const rec = await this.s.get(`pub:${id}`);
        if (!rec) return null;
        return { mime: rec.mime, bytes: b64ToBytes(rec.b64) };
    }

    async _putPublic(bytes, mime, ext) {
        const id = `${newMediaId()}.${ext}`;
        await this.s.put(`pub:${id}`, { mime, b64: bytesToB64(bytes), at: now() });
        // 清掉過期的
        const idx = ((await this.s.get('pubIdx')) || []).filter((x) => now() - x.at < PUB_TTL_MS);
        const expired = ((await this.s.get('pubIdx')) || []).filter((x) => now() - x.at >= PUB_TTL_MS);
        for (const x of expired) await this.s.delete(`pub:${x.id}`);
        idx.push({ id, at: now() });
        await this.s.put('pubIdx', idx);
        return id;
    }

    // ---------- 發送通道 ----------
    _chanFor(acc) {
        const p = PROVIDERS[acc.provider];
        const self = this;
        const keepChat = async () => {
            if (acc._newChatId && acc._newChatId !== acc.chatId) {
                acc.chatId = acc._newChatId;
                const stored = await self.s.get('acc');
                if (stored) await self.s.put('acc', { ...stored, chatId: acc.chatId });
            }
        };
        return {
            budget: Infinity,
            sendText: async (text) => { await p.sendText(acc, text); await keepChat(); },
            // 生成期間 webhook 又收進來的訊息 → 交給核心併進這輪重新生成（就不必再單獨回一輪）
            async takeNew() {
                const raw = (await self.s.get('pending')) || [];
                if (!raw.length) return [];
                await self.s.delete('pending');
                await self.s.delete('pendingSince');
                return self._toPending(raw, this);
            },
            sendSticker: async (url) => {
                // 本機表情（手機傳上來存在中繼的）→ 給平台一個中繼上的公開網址去抓
                const local = await self.loadSticker(url);
                if (local) {
                    const inboxId = await self.s.get('inbox');
                    const ext = (local.mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
                    url = `${acc.publicBase}/imessage/pub/${encodeURIComponent(inboxId)}/${acc.hookToken}/stk_${local.hash}.${ext}`;
                }
                await p.sendMedia(acc, url);
                await keepChat();
            },
            async sendVoice(mp3) {
                const inboxId = await self.s.get('inbox');
                const id = await self._putPublic(mp3, 'audio/mpeg', 'mp3');
                const url = `${acc.publicBase}/imessage/pub/${encodeURIComponent(inboxId)}/${acc.hookToken}/${id}`;
                await p.sendVoice(acc, url);
                await keepChat();
            },
            _timer: null,
            async typing(on) {
                clearInterval(this._timer);
                try { await p.typing(acc, on); } catch { /* 沒有輸入中提示照樣回 */ }
                if (on) this._timer = setInterval(() => { p.typing(acc, true).catch(() => {}); }, 50000);
            },
        };
    }

    async openChannel() {
        const acc = await this.s.get('acc');
        if (!acc) return { reason: 'not set up' };
        return { chan: this._chanFor(acc) };
    }

    // ---------- webhook ----------
    // 回傳 { status, json }；平台要求很快回 2xx，真正的回覆排到 4 秒後的排程裡做
    async webhook(token, headers, raw) {
        const acc = await this.s.get('acc');
        if (!acc || token !== acc.hookToken) return { status: 404, json: { error: 'not found' } };
        const provider = PROVIDERS[acc.provider];
        if (!provider.verify(headers, raw, acc)) return { status: 401, json: { error: 'bad signature' } };
        let body;
        try { body = JSON.parse(raw); } catch { return { status: 400, json: { error: 'invalid json' } }; }
        const msgs = provider.parse(body);
        if (!msgs.length) return { json: { ok: true, ignored: true } };
        const me = normHandle(acc.userHandle);
        const seen = (await this.s.get('seen')) || [];
        const pending = (await this.s.get('pending')) || [];
        let accChanged = false, added = 0;
        for (const m of msgs) {
            // 只接受用戶本人的號碼（別人傳訊息到這條線不會花你的 AI 額度）
            if (!m.handle || normHandle(m.handle) !== me) continue;
            if (m.id && seen.includes(String(m.id))) continue;
            if (m.id) seen.push(String(m.id));
            if (m.chatId && m.chatId !== acc.chatId) { acc.chatId = m.chatId; accChanged = true; }
            if (m.id) { acc.lastMessageId = m.id; accChanged = true; }
            pending.push({ text: m.text || '', voiceText: m.voiceText || '', mediaUrls: m.mediaUrls || [], ts: m.ts || now() });
            added++;
        }
        if (accChanged) await this.s.put('acc', acc);
        if (!added) return { json: { ok: true, ignored: true } };
        await this.s.put('seen', seen.slice(-SEEN_CAP));
        await this.s.put('pending', pending);
        await this.s.put('lastUserAt', now());
        // 連發合併：每來一條就往後推「停手時間」（App 可設），但從這批第一條算起有封頂
        const waitMs = replyWaitMs(await this.s.get('cfg'), DEBOUNCE_MS);
        let since = await this.s.get('pendingSince');
        if (pending.length === added || !since) { since = now(); await this.s.put('pendingSince', since); }
        await this.hooks.schedule(Math.max(500, Math.min(waitMs, since + replyWaitCapMs(waitMs) - now())));
        return { json: { ok: true } };
    }

    // 排程器呼叫：把這段時間累積的訊息一起回
    async runOnce() {
        const acc = await this.s.get('acc');
        // 🛌 作息一致：睡醒 / 忙完了 → 先把延後的那輪回掉
        if (acc) {
            try { await this.runDeferred(this._chanFor(acc)); } catch (e) { console.warn('[imessage] deferred reply failed:', e?.message); }
        }
        const raw = (await this.s.get('pending')) || [];
        if (!acc || !raw.length) {
            // 還有延後的那輪沒到點 → 排到那時再叫醒
            const d = await this.s.get('deferred');
            if (d) return Math.max(1000, d.dueAt - now());
            return null;
        }
        await this.s.delete('pending');
        await this.s.delete('pendingSince');
        const chan = this._chanFor(acc);
        const pending = await this._toPending(raw, chan);
        try {
            if (pending.length) await this.replyRound(chan, pending);
            this.lastError = null;
        } catch (e) {
            this.lastError = String(e?.message || e);
            console.warn('[imessage] reply failed:', this.lastError);
        }
        return null;
    }

    // webhook 收下的原始訊息 → 這輪的用戶訊息（指令當場處理）
    async _toPending(raw, chan) {
        const pending = [];
        for (const m of raw) {
            const text = String(m.text || '').trim();
            // 指令單獨一條才算
            if (/^[/／]/.test(text) && !m.mediaUrls?.length) {
                await this.runCommand(text.replace(/^[/／]\s*/, ''), (t) => chan.sendText(t).catch(() => {}));
                continue;
            }
            if (m.voiceText) pending.push({ type: 'voice', text: m.voiceText, ts: m.ts });
            else if (text) pending.push({ type: 'text', text, ts: m.ts });
            for (const url of m.mediaUrls || []) pending.push(await this._fetchMedia(url, m.ts));
        }
        return pending;
    }

    async _fetchMedia(url, ts) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            let mime = (res.headers.get('content-type') || '').split(';')[0] || sniffMime(bytes);
            if (mime === 'application/octet-stream') mime = sniffMime(bytes);
            const isImage = mime.startsWith('image/');
            const isAudio = mime.startsWith('audio/');
            const name = decodeURIComponent((url.split('?')[0].split('/').pop()) || 'file');
            if (bytes.length > MEDIA_MAX_BYTES) return { type: isImage ? 'image' : 'file', text: isImage ? '' : name, fileName: name, ts };
            const id = newMediaId(ts);
            const b64 = bytesToB64(bytes);
            await this.s.put(`media:${id}`, { mime, b64, name });
            if (isImage) return { type: 'image', text: '', ts, mediaId: id, dataUrl: `data:${mime};base64,${b64}` };
            if (isAudio) return { type: 'voice', text: '', ts, mediaId: id };
            return { type: 'file', text: name, fileName: name, ts, mediaId: id };
        } catch (e) {
            console.warn('[imessage] media fetch failed:', e?.message);
            return { type: 'text', text: '[附件]', ts };
        }
    }
}
