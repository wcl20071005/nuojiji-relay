// 微信橋接核心（每個 inbox 一份）—— 平台無關：
//   Workers 由 Durable Object 承載（wechatDO.js，storage = DO storage，排程 = alarm）
//   Node/VPS 由 nodeBridge.js 承載（storage = kvStore，排程 = setTimeout）
//
// 模式（用戶選定）：一個微信只能綁一個 Bot → 「切換模式」：同一時間跟一個角色聊，
//   在微信裡發 /切换 換人。每個角色的對話各自同步回糯嘰機那個角色的聊天。
//
// 資料（storage key）：
//   bind        { token, botId, baseUrl, wxUserId, boundAt, expired? }
//   login       { qrcode, qrcodeUrl, baseUrl, startedAt, status }
//   cfg         { pairs:[{userId,charId,name}], active:{userId,charId}, proactive, showName }
//   pair:<u>:<c> 手機端組好的回覆模板 + 滑窗 + AI 設定（同後端主動消息那份，換成「回覆」指令）
//   cursor      getupdates 游標
//   ctx         { peer, token, at, sent }  最後一條用戶訊息的 context_token（每條最多回 10 條）
//   seen        最近處理過的 message_id（防重）
//   log         待手機取走的對話輪次（用戶訊息 + 角色回覆），手機 ack 後刪
//   media:<id>  收到的圖片/檔案（base64），手機取走後刪

import {
    ILINK_BASE, REPLY_QUOTA, ItemType, IlinkError,
    fetchLoginQr, pollLoginStatus, getUpdates, notifyStart, notifyStop,
    sendText, sendImage, sendFile, getTypingTicket, sendTyping, downloadMedia, bytesToB64,
} from './ilinkClient.js';
import { synthesizeSpeech, cleanTtsText } from './tts.js';
import { replyToWechatParts, fitToBudget, partsToWindowText } from './replyToWechat.js';
import { runGeneration } from '../ai/aiCaller.js';
import { renderTranscript } from '../proactive/tick.js';
import { renderTimeTokens } from '../util/timeTokens.js';
import { buildMemoryContext } from '../proactive/mcpContext.js';
import { createProactiveStore, PROACTIVE_WINDOW_CAP } from '../store/proactiveStore.js';

const SEEN_CAP = 200;
const LOG_CAP = 500;                       // 手機很久沒開也只留這麼多輪（每輪含完整內容，不截斷）
const LOG_MAX_AGE_MS = 30 * 24 * 3600e3;   // 30 天沒被取走才丟
const MEDIA_MAX_BYTES = 1.5 * 1024 * 1024; // 單個媒體超過就只記「收到一張圖」不存檔（DO 單值上限 2MB）
const DEBOUNCE_POLL_MS = 3500;             // 用戶連發：停手這麼久才開始回
const DEBOUNCE_MAX_MS = 20000;
// context_token 的有效期：第三方 SDK 記錄為 24 小時，留一點餘量
const CTX_TTL_MS = 23.5 * 3600e3;
const LOGIN_QR_TTL_MS = 5 * 60e3;

const pairKey = (u, c) => `pair:${String(u)}:${String(c)}`;
const sameChar = (a, b) => a && b && String(a.userId) === String(b.userId) && String(a.charId) === String(b.charId);
const now = () => Date.now();

function fillTemplate(template, { transcript, memory }) {
    return String(template || '')
        .replaceAll('{{RECENT_MESSAGES}}', transcript)
        .replaceAll('{{IMPULSE_REASON}}', '')
        .replaceAll('{{MEMORY_CONTEXT}}', memory || '');
}

function sniffMime(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
    return 'application/octet-stream';
}

export class WechatBridgeCore {
    /**
     * @param {object} storage  { get(k), put(k,v), delete(k) }（值為可 JSON 化物件）
     * @param {object} env      Workers env（Node 為 {}）
     * @param {object} hooks    { schedule(ms|null) }
     */
    constructor(storage, env, hooks) {
        this.s = storage;
        this.env = env || {};
        this.hooks = hooks;
        this.backoffMs = 0;
        this.lastError = null;
    }

    // ================= HTTP API（手機端呼叫，已過中繼密鑰驗證） =================
    async handle(method, path, query, body) {
        const inboxId = query?.inboxId || body?.inboxId;
        if (inboxId) await this._rememberInbox(inboxId);
        const route = `${method} ${path}`;
        switch (route) {
            case 'GET /wechat/status': return this.status();
            case 'POST /wechat/login/start': return this.loginStart();
            case 'POST /wechat/login/poll': return this.loginPoll(body?.verifyCode);
            case 'POST /wechat/unbind': return this.unbind();
            case 'POST /wechat/config': return this.setConfig(body || {});
            case 'POST /wechat/pair': return this.setPair(body || {});
            case 'POST /wechat/pair/remove': return this.removePair(body || {});
            case 'GET /wechat/log': return this.getLog();
            case 'POST /wechat/ack': return this.ack(body?.ids);
            case 'GET /wechat/media': return this.getMedia(query?.id);
            case 'POST /wechat/mirror': return this.mirrorProactive(body || {});
            case 'POST /wechat/kick': await this.hooks.schedule(0); return { ok: true };
            default: return { status: 404, json: { error: 'not found' } };
        }
    }

    async _rememberInbox(inboxId) {
        if ((await this.s.get('inbox')) !== inboxId) await this.s.put('inbox', inboxId);
    }

    async status() {
        const [bind, cfg, ctx] = await Promise.all([this.s.get('bind'), this.s.get('cfg'), this.s.get('ctx')]);
        const pairs = [];
        for (const p of cfg?.pairs || []) {
            const rec = await this.s.get(pairKey(p.userId, p.charId));
            pairs.push({ ...p, ready: !!rec?.promptTemplate, updatedAt: rec?.updatedAt || 0 });
        }
        return {
            json: {
                ok: true,
                bound: !!bind && !bind.expired,
                expired: !!bind?.expired,
                botId: bind?.botId || null,
                boundAt: bind?.boundAt || 0,
                config: { ...(cfg || {}), pairs },
                lastUserAt: ctx?.at || 0,
                sentThisRound: ctx?.sent || 0,
                lastError: this.lastError,
                lastWarn: this.lastWarn || null,
            },
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
                // wait / scaned / need_verifycode / verify_code_blocked 原樣回給手機
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

    // ---------- 設定 / 角色模板 ----------
    async setConfig(body) {
        const prev = (await this.s.get('cfg')) || {};
        const next = { ...prev };
        if (Array.isArray(body.pairs)) {
            next.pairs = body.pairs
                .filter((p) => p && p.userId != null && p.charId != null)
                .map((p) => ({ userId: String(p.userId), charId: String(p.charId), name: String(p.name || '') }));
        }
        if (body.active) next.active = { userId: String(body.active.userId), charId: String(body.active.charId) };
        for (const k of ['proactive', 'showName']) if (typeof body[k] === 'boolean') next[k] = body[k];
        // 角色語音：'text' 以文字發 / 'audio' 合成音頻檔發（需該角色有雲端可用的 TTS）
        if (body.voiceMode === 'text' || body.voiceMode === 'audio') next.voiceMode = body.voiceMode;
        // 當前角色不在名單裡 → 落到第一個
        if (!next.pairs?.some((p) => sameChar(p, next.active))) {
            next.active = next.pairs?.[0] ? { userId: next.pairs[0].userId, charId: next.pairs[0].charId } : null;
        }
        // 名單外的模板清掉
        for (const p of prev.pairs || []) {
            if (!next.pairs?.some((q) => sameChar(p, q))) await this.s.delete(pairKey(p.userId, p.charId));
        }
        await this.s.put('cfg', next);
        return { json: { ok: true, config: next } };
    }

    async setPair(body) {
        const { userId, charId, promptTemplate, aiSettings } = body;
        if (userId == null || charId == null || !promptTemplate || !aiSettings) {
            return { status: 400, json: { error: 'userId / charId / promptTemplate / aiSettings required' } };
        }
        const prev = (await this.s.get(pairKey(userId, charId))) || {};
        await this.s.put(pairKey(userId, charId), {
            ...prev,
            userId: String(userId), charId: String(charId),
            name: body.name || prev.name || '',
            promptTemplate,
            aiSettings,
            timeSpec: body.timeSpec || prev.timeSpec || null,
            recentMessages: Array.isArray(body.recentMessages) ? body.recentMessages.slice(-PROACTIVE_WINDOW_CAP) : (prev.recentMessages || []),
            lastInteractionAt: typeof body.lastInteractionAt === 'number' ? body.lastInteractionAt : (prev.lastInteractionAt || 0),
            mcpContextServers: Array.isArray(body.mcpContextServers) ? body.mcpContextServers : (prev.mcpContextServers || []),
            stickerUrls: body.stickerUrls && typeof body.stickerUrls === 'object' ? body.stickerUrls : (prev.stickerUrls || {}),
            allowState: typeof body.allowState === 'boolean' ? body.allowState : !!prev.allowState,
            // 手機端整理好的 TTS 設定（null = 這個角色沒有雲端能用的語音）
            ttsSpec: body.ttsSpec !== undefined ? (body.ttsSpec || null) : (prev.ttsSpec || null),
            updatedAt: now(),
        });
        return { json: { ok: true } };
    }

    async removePair({ userId, charId }) {
        await this.s.delete(pairKey(userId, charId));
        return { json: { ok: true } };
    }

    // ---------- 手機取對話 ----------
    async getLog() {
        const log = (await this.s.get('log')) || [];
        return { json: { ok: true, items: log, now: now() } };
    }

    async ack(ids) {
        if (!Array.isArray(ids) || !ids.length) return { json: { ok: true, acked: 0 } };
        const set = new Set(ids.map(String));
        const log = (await this.s.get('log')) || [];
        const keep = [];
        for (const it of log) {
            if (!set.has(String(it.id))) { keep.push(it); continue; }
            for (const m of it.userMessages || []) if (m.mediaId) await this.s.delete(`media:${m.mediaId}`);
        }
        if (keep.length !== log.length) await this.s.put('log', keep);
        return { json: { ok: true, acked: log.length - keep.length } };
    }

    async getMedia(id) {
        if (!id) return { status: 400, json: { error: 'id required' } };
        const rec = await this.s.get(`media:${id}`);
        if (!rec) return { status: 404, json: { error: 'not found' } };
        return { json: { ok: true, mime: rec.mime, b64: rec.b64, name: rec.name || null } };
    }

    async _appendLog(entry) {
        const log = (await this.s.get('log')) || [];
        log.push(entry);
        const cutoff = now() - LOG_MAX_AGE_MS;
        let pruned = log.filter((it) => (it.createdAt || 0) >= cutoff);
        if (pruned.length > LOG_CAP) pruned = pruned.slice(pruned.length - LOG_CAP);
        await this.s.put('log', pruned);
    }

    // ================= 收訊息迴圈（排程器每輪呼叫一次，回傳下一輪延遲 ms；null = 停） =================
    async runOnce() {
        const bind = await this.s.get('bind');
        if (!bind || bind.expired) return null;
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
            const startedAt = now();
            while (pending.length && now() - startedAt < DEBOUNCE_MAX_MS) {
                resp = await getUpdates(bind, cursor, { timeoutMs: DEBOUNCE_POLL_MS });
                batch = resp.msgs || [];
                if (resp.get_updates_buf && resp.get_updates_buf !== cursor) {
                    cursor = resp.get_updates_buf;
                    await this.s.put('cursor', cursor);
                }
                if (!batch.length) break;
                await this._collect(bind, batch, pending);
            }
            if (pending.length) await this._replyRound(bind, pending);
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
            await this.s.put('ctx', { peer: m.from_user_id, token: m.context_token, at: now(), sent: 0 });
            const items = m.item_list || [];
            const firstText = items.find((it) => it.type === ItemType.TEXT)?.text_item?.text?.trim() || '';
            if (items.length === 1 && /^[/／]/.test(firstText)) {
                await this._command(bind, firstText.replace(/^[/／]\s*/, ''));
                continue;
            }
            const ts = Number(m.create_time_ms) || now();
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
                    const id = `${ts}_${Math.random().toString(36).slice(2, 8)}`;
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
                    const id = `${ts}_${Math.random().toString(36).slice(2, 8)}`;
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

    // ---------- 指令：/切换 /谁 /帮助 ----------
    async _command(bind, raw) {
        const ctx = await this.s.get('ctx');
        const reply = (text) => sendText(bind, ctx.peer, ctx.token, text).then(() => this._bumpSent(1)).catch(() => {});
        const cfg = (await this.s.get('cfg')) || {};
        const pairs = cfg.pairs || [];
        const [cmd, ...rest] = raw.split(/\s+/);
        const arg = rest.join(' ').trim();
        const listText = () => pairs.map((p, i) => `${i + 1}. ${p.name || p.charId}${sameChar(p, cfg.active) ? '（当前）' : ''}`).join('\n');
        if (/^(切换|切換|换|換|switch)$/i.test(cmd)) {
            if (!pairs.length) return reply('还没有可以聊的角色。请在糯叽机「连接微信」里选择角色。');
            if (!arg) return reply(`可以聊的角色：\n${listText()}\n\n发送「/切换 编号」或「/切换 名字」换人。`);
            const idx = /^\d+$/.test(arg) ? Number(arg) - 1 : pairs.findIndex((p) => (p.name || '').toLowerCase() === arg.toLowerCase());
            const hit = pairs[idx] || pairs.find((p) => (p.name || '').includes(arg));
            if (!hit) return reply(`没有找到「${arg}」。\n${listText()}`);
            await this.s.put('cfg', { ...cfg, active: { userId: hit.userId, charId: hit.charId } });
            return reply(`已切换到 ${hit.name || hit.charId}。`);
        }
        if (/^(谁|誰|当前|當前|who)$/i.test(cmd)) {
            const cur = pairs.find((p) => sameChar(p, cfg.active));
            return reply(cur ? `正在和 ${cur.name || cur.charId} 聊天。` : '还没有选择角色。');
        }
        return reply('指令：\n/切换 —— 列出角色\n/切换 编号或名字 —— 换人\n/谁 —— 现在在和谁聊');
    }

    async _bumpSent(n) {
        const ctx = await this.s.get('ctx');
        if (ctx) await this.s.put('ctx', { ...ctx, sent: (ctx.sent || 0) + n });
    }

    // ---------- 一輪回覆 ----------
    async _replyRound(bind, pending) {
        const cfg = (await this.s.get('cfg')) || {};
        const active = cfg.active;
        const rec = active ? await this.s.get(pairKey(active.userId, active.charId)) : null;
        let ctx = await this.s.get('ctx');
        const logUserMsgs = pending.map(({ dataUrl, ...rest }) => rest);
        const entryBase = { id: `wx_${now()}_${Math.random().toString(36).slice(2, 6)}`, createdAt: now() };

        if (!rec?.promptTemplate) {
            await sendText(bind, ctx.peer, ctx.token,
                active ? '这个角色还没同步到云端。请打开一次糯叽机，再在「连接微信」里点保存。' : '还没选择聊天的角色。请在糯叽机「连接微信」里选择角色。').catch(() => {});
            await this._bumpSent(1);
            if (active) await this._appendLog({ ...entryBase, userId: active.userId, charId: active.charId, userMessages: logUserMsgs, content: null, error: 'pair not ready' });
            return;
        }

        // 這輪用戶訊息先進滑窗，再組 prompt
        const userWindowMsgs = pending.map((m) => ({
            sender: 'me',
            text: m.type === 'voice' ? `[voice] ${m.text}` : m.type === 'image' ? '[image]' : m.type === 'file' ? `[file: ${m.fileName}]` : m.text,
            timestamp: m.ts,
        }));
        const window = [...(rec.recentMessages || []), ...userWindowMsgs].slice(-PROACTIVE_WINDOW_CAP);
        const transcript = renderTranscript(window, rec.timeSpec);
        let memory = '';
        try { memory = await buildMemoryContext(rec.mcpContextServers, window, { userId: rec.userId, characterId: rec.charId }); } catch { /* 無記憶 MCP */ }
        const system = fillTemplate(renderTimeTokens(rec.promptTemplate, rec.timeSpec, now(), rec.lastInteractionAt || 0), { transcript, memory });
        const images = pending.filter((m) => m.dataUrl).map((m) => ({ type: 'image_url', image_url: { url: m.dataUrl } }));
        const userTurn = images.length
            ? [{ type: 'text', text: '请开始回复。（用户这轮发来的图片附在下面）' }, ...images]
            : '请开始回复。';

        // 輸入中提示：生成期間每 5 秒續一次
        let ticket = '';
        try { ticket = await getTypingTicket(bind, ctx.peer, ctx.token); } catch { /* 無提示照樣回 */ }
        await sendTyping(bind, ctx.peer, ticket, true);
        const keepTyping = setInterval(() => { sendTyping(bind, ctx.peer, ticket, true); }, 5000);

        let content = null, reasoning = null, error = null;
        try {
            try {
                ({ content, reasoning } = await runGeneration(rec.aiSettings, [{ role: 'system', content: system }, { role: 'user', content: userTurn }], rec.aiSettings?.maxTokens || null));
            } catch (e) {
                // 模型不支援看圖 → 拿掉圖片再試一次
                if (!images.length) throw e;
                ({ content, reasoning } = await runGeneration(rec.aiSettings, [{ role: 'system', content: system }, { role: 'user', content: '请开始回复。' }], rec.aiSettings?.maxTokens || null));
            }
        } catch (e) {
            error = String(e?.message || e);
        } finally {
            clearInterval(keepTyping);
            await sendTyping(bind, ctx.peer, ticket, false);
        }

        const entry = { ...entryBase, userId: rec.userId, charId: rec.charId, userMessages: logUserMsgs, content, reasoning: reasoning || null, error };
        if (error) {
            await this._appendLog(entry);
            await sendText(bind, ctx.peer, ctx.token, `（${rec.name || '角色'}这次没能回复：${error}）`).catch(() => {});
            await this._bumpSent(1);
            await this._saveWindow(rec, window);
            return;
        }

        // 用戶在生成期間又發了新訊息 → ctx 已換新 token，用最新的發
        ctx = await this.s.get('ctx');
        const sentParts = await this._deliver(bind, ctx, rec, content, { isActive: true, cfg });
        await this._appendLog(entry);
        const charWindowMsgs = sentParts.map((p) => partsToWindowText(p, rec.name)).filter(Boolean).map((text) => ({ sender: 'char', text, timestamp: now() }));
        await this._saveWindow(rec, [...window, ...charWindowMsgs].slice(-PROACTIVE_WINDOW_CAP));
    }

    // 把角色回覆拆成微信訊息逐條發出；回傳實際發出的部分
    async _deliver(bind, ctx, rec, content, { isActive, cfg }) {
        const audioVoice = cfg.voiceMode === 'audio' && !!rec.ttsSpec;
        let parts = replyToWechatParts(content, { stickerUrls: rec.stickerUrls || {}, allowState: !!rec.allowState })
            .map((p) => (p.kind === 'voice' && !audioVoice ? { ...p, kind: 'text', text: `[语音] ${p.text}` } : p));
        if (!parts.length) return [];
        // 多個角色共用一個 Bot：頭像只有一個 → 回覆前帶名字分辨是誰
        const multi = (cfg.pairs || []).length > 1;
        if (rec.name && (!isActive || (cfg.showName !== false && multi))) {
            if (parts[0].kind === 'text') parts[0] = { ...parts[0], text: `【${rec.name}】${parts[0].text}` };
            else parts.unshift({ kind: 'text', text: `【${rec.name}】` });
        }
        parts = fitToBudget(parts, REPLY_QUOTA - (ctx.sent || 0));
        const sent = [];
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (i > 0) await new Promise((r) => setTimeout(r, Math.min(2500, 500 + (p.text?.length || 4) * 60)));
            try {
                if (p.kind === 'sticker') {
                    const res = await fetch(p.url);
                    if (!res.ok) throw new Error(`sticker HTTP ${res.status}`);
                    await sendImage(bind, ctx.peer, ctx.token, new Uint8Array(await res.arrayBuffer()));
                } else if (p.kind === 'voice') {
                    // 語音條發不出去 → 合成 mp3 當檔案發；檔名用台詞開頭，不點開也看得到說了什麼
                    try {
                        const mp3 = await synthesizeSpeech(rec.ttsSpec, p.text);
                        const label = cleanTtsText(p.text).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 24) || 'voice';
                        await sendFile(bind, ctx.peer, ctx.token, mp3, `${label}.mp3`);
                    } catch (e) {
                        console.warn('[wechat] tts failed, fallback text:', e?.message);
                        this.lastWarn = { at: now(), text: `语音合成失败：${e?.message || e}` };
                        await sendText(bind, ctx.peer, ctx.token, `[语音] ${p.text}`);
                    }
                } else {
                    await sendText(bind, ctx.peer, ctx.token, p.text);
                }
                sent.push(p);
            } catch (e) {
                // 表情圖抓不到 → 改發文字說明
                if (p.kind === 'sticker') {
                    try { await sendText(bind, ctx.peer, ctx.token, `[表情] ${p.meaning}`); sent.push(p); } catch { /* 跳過 */ }
                } else {
                    console.warn('[wechat] send failed:', e?.message);
                    if (e instanceof IlinkError && e.ret === -2) break; // 額度用完
                }
            }
        }
        await this._bumpSent(sent.length);
        return sent;
    }

    async _saveWindow(rec, window) {
        const t = now();
        await this.s.put(pairKey(rec.userId, rec.charId), { ...rec, recentMessages: window, lastInteractionAt: t });
        // 同步給後端主動消息的同一對：否則沒開 App 時，主動消息看不到微信裡剛聊過的內容
        try {
            const inboxId = await this.s.get('inbox');
            if (inboxId) {
                const proactive = await createProactiveStore(this.env);
                await proactive.patch(inboxId, rec.userId, rec.charId, { recentMessages: window, lastInteractionAt: t });
            }
        } catch (e) { console.warn('[wechat] proactive window patch failed:', e?.message); }
    }

    // ---------- 後端主動消息 → 也發到微信 ----------
    async mirrorProactive({ userId, charId, content }) {
        const [bind, cfg, ctx] = await Promise.all([this.s.get('bind'), this.s.get('cfg'), this.s.get('ctx')]);
        if (!bind || bind.expired || !cfg?.proactive || !content) return { json: { ok: false, reason: 'off' } };
        if (!(cfg.pairs || []).some((p) => sameChar(p, { userId, charId }))) return { json: { ok: false, reason: 'not linked' } };
        // 微信規定：要用戶先開口，且一天內才能回
        if (!ctx?.token || now() - (ctx.at || 0) > CTX_TTL_MS) return { json: { ok: false, reason: 'window closed' } };
        if ((ctx.sent || 0) >= REPLY_QUOTA) return { json: { ok: false, reason: 'quota used' } };
        const rec = await this.s.get(pairKey(userId, charId));
        if (!rec) return { json: { ok: false, reason: 'pair not ready' } };
        const sent = await this._deliver(bind, ctx, rec, content, { isActive: sameChar(cfg.active, { userId, charId }), cfg });
        if (sent.length) {
            const charWindowMsgs = sent.map((p) => partsToWindowText(p, rec.name)).filter(Boolean).map((text) => ({ sender: 'char', text, timestamp: now() }));
            const t = now();
            await this.s.put(pairKey(userId, charId), { ...rec, recentMessages: [...(rec.recentMessages || []), ...charWindowMsgs].slice(-PROACTIVE_WINDOW_CAP), lastInteractionAt: t });
        }
        return { json: { ok: true, sent: sent.length } };
    }
}
