// 微信橋接（ClawBot / iLink）—— 共用邏輯在 chatbridge/baseCore.js，這裡只管微信特有的部分：
//   掃碼綁定、長輪詢收訊息（連發合併）、微信發送通道（context_token / 每條最多 10 條 / 輸入中）
//
// 承載：Workers 由 Durable Object（wechatDO.js）、Node/VPS 由 nodeBridge.js。
//
// 微信特有 storage key：
//   bind    { token, botId, baseUrl, wxUserId, boundAt, expired? }
//   login   { qrcode, qrcodeUrl, baseUrl, startedAt, status }
//   cursor  getupdates 游標
//   ctx     { peer, token, at, sent }  最後一條用戶訊息的 context_token（每條最多回 10 條）
//   seen    最近處理過的 message_id（防重）

import {
    ILINK_BASE, REPLY_QUOTA, ItemType, IlinkError,
    fetchLoginQr, pollLoginStatus, getUpdates, notifyStart, notifyStop,
    sendItem, sendText, sendImage, sendFile, getTypingTicket, sendTyping, downloadMedia, bytesToB64,
} from './ilinkClient.js';
import { ChannelBridgeCore, MEDIA_MAX_BYTES, sniffMime, newMediaId, now, replyWaitMs, replyWaitCapMs } from '../chatbridge/baseCore.js';

const SEEN_CAP = 200;
const DEBOUNCE_POLL_MS = 3500;             // 用戶連發：停手這麼久才開始回（預設；App 可改）
// context_token 的有效期：第三方 SDK 記錄為 24 小時，留一點餘量
const CTX_TTL_MS = 23.5 * 3600e3;
const LOGIN_QR_TTL_MS = 5 * 60e3;

export class WechatBridgeCore extends ChannelBridgeCore {
    constructor(storage, env, hooks) {
        super(storage, env, hooks, { prefix: '/wechat', label: '微信', logPrefix: 'wx' });
        this.backoffMs = 0;
    }

    async handleChannel(method, path, query, body) {
        switch (`${method} ${path}`) {
            case 'POST /wechat/login/start': return this.loginStart();
            case 'POST /wechat/login/poll': return this.loginPoll(body?.verifyCode);
            case 'POST /wechat/unbind': return this.unbind();
            default: return null;
        }
    }

    async channelStatus() {
        const [bind, ctx] = await Promise.all([this.s.get('bind'), this.s.get('ctx')]);
        return {
            bound: !!bind && !bind.expired,
            expired: !!bind?.expired,
            botId: bind?.botId || null,
            boundAt: bind?.boundAt || 0,
            lastUserAt: ctx?.at || 0,
            sentThisRound: ctx?.sent || 0,
        };
    }

    // ---------- 綁定 ----------
    async loginStart() {
        const { qrcode, qrcodeUrl } = await fetchLoginQr();
        await this.s.put('login', { qrcode, qrcodeUrl, baseUrl: ILINK_BASE, startedAt: now(), status: 'wait' });
        return { json: { ok: true, qrcodeUrl, status: 'wait' } };
    }

    // 手機端反覆呼叫（每次最多掛 ~25s 等狀態變化）
    async loginPoll(verifyCode) {
        const login = await this.s.get('login');
        if (!login) return { json: { ok: false, status: 'none' } };
        if (now() - login.startedAt > LOGIN_QR_TTL_MS * 3) {
            await this.s.delete('login');
            return { json: { ok: false, status: 'timeout' } };
        }
        const st = await pollLoginStatus(login.baseUrl, login.qrcode, verifyCode, { timeoutMs: 25000 });
        const status = st?.status || 'wait';
        switch (status) {
            case 'scaned_but_redirect':
                if (st.redirect_host) { login.baseUrl = `https://${st.redirect_host}`; await this.s.put('login', login); }
                return { json: { ok: true, status: 'scaned' } };
            case 'expired': {
                // 二維碼約 2 分鐘過期 → 自動換一張新的給手機
                const fresh = await fetchLoginQr();
                await this.s.put('login', { ...login, qrcode: fresh.qrcode, qrcodeUrl: fresh.qrcodeUrl, status: 'wait' });
                return { json: { ok: true, status: 'refreshed', qrcodeUrl: fresh.qrcodeUrl } };
            }
            case 'confirmed': {
                if (!st.bot_token || !st.ilink_bot_id) return { json: { ok: false, status: 'error', error: 'missing bot_token' } };
                const bind = {
                    token: st.bot_token, botId: st.ilink_bot_id, baseUrl: st.baseurl || ILINK_BASE,
                    wxUserId: st.ilink_user_id || null, boundAt: now(),
                };
                await this.s.put('bind', bind);
                await this.s.delete('login');
                // 新 Bot 從頭收訊息
                await this.s.delete('cursor');
                await this.s.delete('ctx');
                await notifyStart(bind);
                this.lastError = null;
                await this.hooks.schedule(0);
                return { json: { ok: true, status: 'confirmed', botId: bind.botId } };
            }
            case 'binded_redirect':
                return { json: { ok: true, status: 'already_bound' } };
            default:
                return { json: { ok: true, status } };
        }
    }

    async unbind() {
        const bind = await this.s.get('bind');
        if (bind) await notifyStop(bind);
        await Promise.all(['bind', 'login', 'cursor', 'ctx', 'seen'].map((k) => this.s.delete(k)));
        await this.hooks.schedule(null);
        return { json: { ok: true } };
    }

    // ---------- 發送通道 ----------
    _chanFor(bind, ctx) {
        const self = this;
        return {
            budget: REPLY_QUOTA - (ctx.sent || 0),
            sendText: (text) => sendText(bind, ctx.peer, ctx.token, text),
            async sendSticker(url) {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`sticker HTTP ${res.status}`);
                await sendImage(bind, ctx.peer, ctx.token, new Uint8Array(await res.arrayBuffer()));
            },
            // 微信 Bot 發不出語音條（實測）→ mp3 當檔案發；檔名用台詞開頭，不點開也看得到說了什麼
            sendVoice: (mp3, label) => sendFile(bind, ctx.peer, ctx.token, mp3, `${label}.mp3`),
            _ticket: null,
            async typing(on) {
                if (this._ticket == null) {
                    try { this._ticket = await getTypingTicket(bind, ctx.peer, ctx.token); } catch { this._ticket = ''; }
                }
                clearInterval(this._timer);
                await sendTyping(bind, ctx.peer, this._ticket, on);
                if (on) this._timer = setInterval(() => sendTyping(bind, ctx.peer, this._ticket, true), 5000);
            },
            isQuotaError: (e) => e instanceof IlinkError && e.ret === -2,
            afterSend: (n) => self._bumpSent(n),
            // 生成期間用戶又發了訊息 → 用最新的 context_token 發
            async refresh() {
                const latest = await self.s.get('ctx');
                return latest ? self._chanFor(bind, latest) : null;
            },
        };
    }

    async openChannel({ proactive } = {}) {
        const [bind, ctx] = await Promise.all([this.s.get('bind'), this.s.get('ctx')]);
        if (!bind || bind.expired) return { reason: 'not bound' };
        // 微信規定：要用戶先開口，且一天內才能回
        if (!ctx?.token || now() - (ctx.at || 0) > CTX_TTL_MS) return { reason: 'window closed' };
        if (proactive && (ctx.sent || 0) >= REPLY_QUOTA) return { reason: 'quota used' };
        return { chan: this._chanFor(bind, ctx) };
    }

    async _bumpSent(n) {
        if (!n) return;
        const ctx = await this.s.get('ctx');
        if (ctx) await this.s.put('ctx', { ...ctx, sent: (ctx.sent || 0) + n });
    }

    // ================= 收訊息迴圈（排程器每輪呼叫一次，回傳下一輪延遲 ms；null = 停） =================
    async runOnce() {
        const bind = await this.s.get('bind');
        if (!bind || bind.expired) return null;
        // 🛌 作息一致：睡醒 / 忙完了 → 先把延後的那輪回掉
        try { await this.runDeferred(this._chanFor(bind, await this.s.get('ctx'))); } catch (e) { console.warn('[wechat] deferred reply failed:', e?.message); }
        let cursor = (await this.s.get('cursor')) || '';
        try {
            let resp = await getUpdates(bind, cursor);
            let batch = resp.msgs || [];
            if (resp.get_updates_buf && resp.get_updates_buf !== cursor) {
                cursor = resp.get_updates_buf;
                await this.s.put('cursor', cursor);
            }
            const pending = [];
            await this._collect(bind, batch, pending);
            // 連發合併：還有新訊息就再等一下，直到用戶停手（或封頂）
            //   停手多久：App 可設（replyWaitSec），預設 3.5 秒；長輪詢單次最多 35 秒，所以按剩餘時間分段等
            const waitMs = replyWaitMs(await this.s.get('cfg'), DEBOUNCE_POLL_MS);
            const capMs = replyWaitCapMs(waitMs);
            const startedAt = now();
            let lastMsgAt = now();
            while (pending.length && now() - startedAt < capMs) {
                const remain = Math.min(waitMs - (now() - lastMsgAt), capMs - (now() - startedAt));
                if (remain <= 0) break;
                resp = await getUpdates(bind, cursor, { timeoutMs: Math.min(remain, 35000) });
                batch = resp.msgs || [];
                if (resp.get_updates_buf && resp.get_updates_buf !== cursor) {
                    cursor = resp.get_updates_buf;
                    await this.s.put('cursor', cursor);
                }
                if (!batch.length) continue;
                await this._collect(bind, batch, pending);
                lastMsgAt = now();
            }
            if (pending.length) {
                const ctx = await this.s.get('ctx');
                await this.replyRound(this._chanFor(bind, ctx), pending);
            }
            this.backoffMs = 0;
            this.lastError = null;
            return 0;
        } catch (e) {
            if (e instanceof IlinkError && e.sessionExpired) {
                // 用戶在微信裡解綁 / 被別的 Bot 頂掉 → 停下，等手機端重新綁定
                await this.s.put('bind', { ...bind, expired: true });
                this.lastError = 'session expired';
                return null;
            }
            this.lastError = String(e?.message || e);
            this.backoffMs = Math.min(60000, Math.max(2000, this.backoffMs * 2 || 2000));
            console.warn('[wechat] loop error:', this.lastError);
            return this.backoffMs;
        }
    }

    // 🧪 試微信原生引用：官方插件只「收」引用、從不「發」，介面欄位 ref_msg 是同一個結構但沒文件。
    //   用戶在微信發「/引用测试」→ 用他上一句話發三種寫法，看哪條在微信裡出現引用框。
    async _quoteProbe(bind, ctx) {
        const last = await this.s.get('lastUserText');
        const send = (item) => sendItem(bind, ctx.peer, ctx.token, item).catch((e) => console.warn('[wechat] quote probe:', e?.message));
        if (!last?.text) {
            await send({ type: ItemType.TEXT, text_item: { text: '先随便发一句话，再发「/引用测试」。' } });
            await this._bumpSent(1);
            return;
        }
        const quoted = { type: ItemType.TEXT, text_item: { text: last.text }, create_time_ms: last.ts };
        const variants = [
            ['A', { title: last.text, message_item: quoted }],
            ['B', { svr_id: last.svrId, message_item: { ...quoted, msg_id: last.msgId } }],
            ['C', { title: last.text, svr_id: last.svrId, message_item: { ...quoted, msg_id: last.msgId } }],
        ];
        await send({ type: ItemType.TEXT, text_item: { text: `引用测试：下面三条都想引用你刚才那句「${last.text}」。看看哪条带着微信自己的引用框，记下字母。` } });
        for (const [name, ref] of variants) await send({ type: ItemType.TEXT, text_item: { text: `测试 ${name}` }, ref_msg: ref });
        await this._bumpSent(1 + variants.length);
    }

    // 把一批原始訊息整理成「這輪用戶說了什麼」；指令當場處理
    async _collect(bind, msgs, pending) {
        if (!msgs.length) return;
        const seen = (await this.s.get('seen')) || [];
        let seenChanged = false;
        for (const m of msgs) {
            if (m.message_type === 2) continue; // Bot 自己發的回顯
            const mid = String(m.message_id || m.client_id || '');
            if (mid && seen.includes(mid)) continue;
            if (mid) { seen.push(mid); seenChanged = true; }
            // 每條用戶訊息帶一個新的 context_token，回覆額度重新算
            const ctx = { peer: m.from_user_id, token: m.context_token, at: now(), sent: 0 };
            await this.s.put('ctx', ctx);
            const items = m.item_list || [];
            const firstText = items.find((it) => it.type === ItemType.TEXT)?.text_item?.text?.trim() || '';
            if (items.length === 1 && /^[/／]/.test(firstText)) {
                const chan = this._chanFor(bind, ctx);
                if (/^[/／]\s*引用测试/.test(firstText)) { await this._quoteProbe(bind, ctx); continue; }
                await this.runCommand(firstText.replace(/^[/／]\s*/, ''), (text) => chan.sendText(text).then(() => this._bumpSent(1)).catch(() => {}));
                continue;
            }
            const ts = Number(m.create_time_ms) || now();
            // 記下最近一條文字（/引用测试 用：試 Bot 能不能用微信原生引用框）
            const textItem = items.find((it) => it.type === ItemType.TEXT);
            if (firstText && textItem) await this.s.put('lastUserText', { text: firstText, svrId: String(m.message_id || ''), msgId: String(textItem.msg_id || ''), ts });
            for (const it of items) {
                const um = await this._toUserMessage(it, ts);
                if (um) pending.push(um);
            }
        }
        if (seenChanged) await this.s.put('seen', seen.slice(-SEEN_CAP));
    }

    async _toUserMessage(it, ts) {
        try {
            if (it.type === ItemType.TEXT) {
                const text = it.text_item?.text || '';
                return text ? { type: 'text', text, ts, quoted: !!it.ref_msg } : null;
            }
            if (it.type === ItemType.VOICE) {
                // 微信自帶語音轉文字
                return { type: 'voice', text: it.voice_item?.text || '', durationMs: it.voice_item?.playtime || 0, ts };
            }
            if (it.type === ItemType.IMAGE) {
                const bytes = await downloadMedia(it.image_item?.media, it.image_item?.aeskey);
                const msg = { type: 'image', text: '', ts };
                if (bytes.length <= MEDIA_MAX_BYTES) {
                    const id = newMediaId(ts);
                    const mime = sniffMime(bytes);
                    const b64 = bytesToB64(bytes);
                    await this.s.put(`media:${id}`, { mime, b64 });
                    msg.mediaId = id;
                    msg.dataUrl = `data:${mime};base64,${b64}`; // 只用於這輪送 AI，不進 log
                }
                return msg;
            }
            if (it.type === ItemType.FILE) {
                const name = it.file_item?.file_name || 'file';
                const msg = { type: 'file', text: name, fileName: name, ts };
                const len = Number(it.file_item?.len) || 0;
                if (len && len <= MEDIA_MAX_BYTES) {
                    const bytes = await downloadMedia(it.file_item?.media);
                    const id = newMediaId(ts);
                    await this.s.put(`media:${id}`, { mime: 'application/octet-stream', b64: bytesToB64(bytes), name });
                    msg.mediaId = id;
                }
                return msg;
            }
            if (it.type === ItemType.VIDEO) return { type: 'text', text: '[视频]', ts };
        } catch (e) {
            console.warn('[wechat] media download failed:', e?.message);
            return { type: 'text', text: it.type === ItemType.IMAGE ? '[图片]' : '[文件]', ts };
        }
        return null;
    }
}
