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

import { ChannelBridgeCore, MEDIA_MAX_BYTES, sniffMime, newMediaId, now, replyWaitMs, replyWaitCapMs, pairKey, userWindowText } from '../chatbridge/baseCore.js';
import { PROVIDERS, normHandle, parseTextTapback } from './providers.js';
import { normalizeFx } from '../wechat/replyToWechat.js';
import { PROACTIVE_WINDOW_CAP } from '../store/proactiveStore.js';
import { bytesToB64, b64ToBytes } from '../wechat/ilinkClient.js';

const DEBOUNCE_MS = 5000;
const SEEN_CAP = 300;
const PUB_TTL_MS = 24 * 3600e3;
// webhook 訂閱版本：2 = Linq 加訂 Tapback 事件（reaction.added / removed）；舊帳號打開面板時自動重訂
const HOOK_REV = 2;
// 訊息 id ↔ 文字對照（用戶回應 / 引用時知道是哪句；角色引用 / 回應時找到平台 id）
const MIDS_CAP = 200;
const MIDS_MAX_CHARS = 90000; // Durable Object 單值上限 128KB，留餘量
const stripTag = (t) => String(t || '').replace(/^【[^】]*】/, '').trim();
const normQ = (t) => stripTag(t).replace(/[\s「」“”"'。，,.!！?？~～…]+/g, '').toLowerCase();
const EXT_MIME = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', apng: 'image/apng' };

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');

export class ImessageBridgeCore extends ChannelBridgeCore {
    // opts 給子類（QQ 也是「平台推網址 → 攢一會兒再回」，沿用這裡的排隊 / 公開檔案 / 收媒體）
    constructor(storage, env, hooks, opts = { prefix: '/imessage', label: 'iMessage', logPrefix: 'im' }) {
        super(storage, env, hooks, opts);
    }

    // 公開檔案網址（合成語音 / 本機表情給平台抓）
    _pubUrl(acc, inboxId, id) {
        return `${acc.publicBase}${this.opts.prefix}/pub/${encodeURIComponent(inboxId)}/${acc.hookToken}/${id}`;
    }

    // 圖 / 影片的參照（"stk:…" / "om:…" / 網址）→ 平台抓得到的網址
    async _mediaUrl(acc, ref) {
        const local = await this.loadSticker(ref);
        if (!local) return ref;
        const sub = local.mime.split('/')[1] || 'bin';
        const ext = sub === 'jpeg' ? 'jpg' : sub === 'quicktime' ? 'mov' : sub.replace(/[^a-z0-9]/gi, '') || 'bin';
        return this._pubUrl(acc, await this.s.get('inbox'), `${local.pubId}.${ext}`);
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
        if (acc && inboxId) await this._upgradeHook(acc, inboxId);
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
        if (body.registerWebhook !== false && !(sameAccount && prev.webhookAuto && prev.hookToken === acc.hookToken && (prev.hookRev || 1) >= HOOK_REV)) {
            try {
                const r = await provider.setupWebhook(acc, url);
                if (r) { webhookAuto = true; if (r.webhookSecret) acc.webhookSecret = r.webhookSecret; }
            } catch (e) {
                webhookError = String(e?.message || e);
            }
        } else if (sameAccount) webhookAuto = !!prev.webhookAuto;
        acc.webhookAuto = webhookAuto;
        acc.hookRev = webhookAuto ? HOOK_REV : (prev.hookRev || 0);
        await this.s.put('acc', acc);
        return { json: { ok: true, webhookUrl: url, webhookAuto, webhookError } };
    }

    // 舊版自動註冊的 webhook 沒訂 Tapback 事件 → 重訂一次（只對自動註冊的；後台手填的不動）
    async _upgradeHook(acc, inboxId) {
        if (!acc.webhookAuto || (acc.hookRev || 1) >= HOOK_REV || !acc.provider) return;
        const provider = PROVIDERS[acc.provider];
        if (!provider) return;
        try {
            const r = await provider.setupWebhook(acc, this._webhookUrl(acc, inboxId));
            const stored = (await this.s.get('acc')) || acc;
            await this.s.put('acc', { ...stored, hookRev: HOOK_REV, ...(r?.webhookSecret ? { webhookSecret: r.webhookSecret } : {}) });
        } catch (e) {
            console.warn('[imessage] webhook upgrade failed:', e?.message);
        }
    }

    // ---------- 訊息 id 對照 ----------
    async _recordMid(id, text, from) {
        if (!id) return;
        const mids = ((await this.s.get('mids')) || []).filter((x) => x.id !== String(id));
        mids.push({ id: String(id), text: stripTag(text), from, at: now() });
        let keep = mids.slice(-MIDS_CAP);
        while (keep.length > 1 && JSON.stringify(keep).length > MIDS_MAX_CHARS) keep = keep.slice(1);
        await this.s.put('mids', keep);
    }

    async _midOf(id) {
        if (!id) return null;
        return ((await this.s.get('mids')) || []).find((x) => x.id === String(id)) || null;
    }

    // 角色說「回 / 引用某句」→ 找最近一條對得上的訊息（先找用戶的話，再找角色自己的）；找不到回 null
    async _findMid(query, { fromOnly } = {}) {
        const q = normQ(query);
        const mids = ((await this.s.get('mids')) || []).slice().reverse();
        const order = fromOnly ? [fromOnly] : ['me', 'char'];
        for (const from of order) {
            const list = mids.filter((x) => x.from === from);
            if (!q) { if (list[0]) return list[0]; continue; }
            const hit = list.find((x) => { const t = normQ(x.text); return t && (t.includes(q) || (t.length >= 2 && q.includes(t))); });
            if (hit) return hit;
        }
        return null;
    }

    // 被引用 / 被回應的那條 → { text, from }（中繼沒記到就問平台）
    async _resolveTarget(acc, id, textHint) {
        if (!id && textHint) {
            const m = await this._findMid(textHint);
            return { text: stripTag(textHint), from: m?.from || 'char' };
        }
        const m = await this._midOf(id);
        if (m) return { text: m.text, from: m.from };
        const p = acc?.provider && PROVIDERS[acc.provider];
        if (p?.fetchText) {
            try {
                const r = await p.fetchText(acc, id);
                if (r?.text) return { text: stripTag(r.text), from: r.fromMe ? 'char' : 'me' };
            } catch (e) { console.warn('[imessage] fetch quoted message failed:', e?.message); }
        }
        return null;
    }

    // ---------- 用戶的 Tapback ----------
    // 不觸發回覆（真人被點了愛心不會特地回一句），記進角色的對話窗口 + 糯嘰機聊天記錄（App 那邊貼到對應氣泡上）
    async _noteReaction(acc, r) {
        const cfg = (await this.s.get('cfg')) || {};
        const active = cfg.active;
        if (!active) return;
        const rec = await this.s.get(pairKey(active.userId, active.charId));
        if (!rec) return;
        const target = await this._resolveTarget(acc, r.targetId, r.targetText);
        const item = {
            type: 'reaction', emoji: r.emoji, remove: !!r.remove, ts: r.ts || now(),
            targetText: target?.text || '', targetFrom: target?.from || 'char',
        };
        // 舊版 App 不認 reaction → 至少顯示成一行文字
        item.text = `[${r.remove ? '取消回应' : '回应'} ${r.emoji}]${item.targetText ? ` ${item.targetText}` : ''}`;
        const line = { sender: 'me', text: userWindowText(item), timestamp: item.ts };
        await this._saveWindow(rec, [...(rec.recentMessages || []), line].slice(-PROACTIVE_WINDOW_CAP));
        await this._appendLog({
            id: `${this.opts.logPrefix}_${now()}_${Math.random().toString(36).slice(2, 6)}`, createdAt: now(),
            userId: rec.userId, charId: rec.charId, userMessages: [item], content: null, reasoning: null, error: null,
        });
    }

    async unbind() {
        await Promise.all(['acc', 'pending', 'pendingSince', 'seen', 'mids'].map((k) => this.s.delete(k)));
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
        // 中繼存的圖 / 影片：stk_<hash>.<ext>（本機表情）、om_<id>.<ext>（手機補發的照片 / 視頻）
        const stored = /^(stk|om)_([A-Za-z0-9_]+?)\.\w+$/.exec(String(id || ''));
        if (stored) {
            const s = await this.loadSticker(`${stored[1]}:${stored[2]}`);
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
        const p = PROVIDERS[acc.provider] || null;
        const caps = p?.caps || {};
        const self = this;
        const keepChat = async () => {
            if (acc._newChatId && acc._newChatId !== acc.chatId) {
                acc.chatId = acc._newChatId;
                const stored = await self.s.get('acc');
                if (stored) await self.s.put('acc', { ...stored, chatId: acc.chatId });
            }
        };
        const sent = async (id, text) => { await keepChat(); await self._recordMid(id, text, 'char'); };
        const chan = {
            budget: Infinity,
            sendText: async (text) => { await sent(await p.sendText(acc, text), text); },
            // 原生引用 / 特效 / 文字動畫：平台拒絕（舊線路 / 不支援）就退回純文字，訊息不會丟
            async sendTextPart(part) {
                const target = part.replyQuote && caps.reply ? await self._findMid(part.replyQuote) : null;
                const text = target ? (part.replyBody || part.text) : part.text;
                const opts = {};
                if (target) opts.replyTo = target.id;
                if (part.fx && (caps.fx || []).includes(part.fx)) opts.fx = part.fx;
                if (part.anim && caps.anim) opts.anim = part.anim;
                let id;
                try {
                    id = await p.sendText(acc, text, opts);
                } catch (e) {
                    if (!Object.keys(opts).length) throw e;
                    console.warn('[imessage] native send failed, plain text:', e?.message);
                    id = await p.sendText(acc, part.text);
                    await sent(id, part.text);
                    return;
                }
                await sent(id, text);
            },
            // 生成期間 webhook 又收進來的訊息 → 交給核心併進這輪重新生成（就不必再單獨回一輪）
            async takeNew() {
                const raw = (await self.s.get('pending')) || [];
                if (!raw.length) return [];
                await self.s.delete('pending');
                await self.s.delete('pendingSince');
                return self._toPending(raw, this);
            },
            async sendSticker(url, meaning, part) {
                // 中繼存的圖（本機表情 / 手機補發的照片）→ 給平台一個中繼上的公開網址去抓
                const local = await self.loadSticker(url);
                const pubUrl = await self._mediaUrl(acc, url);
                // 表情包 → 原生貼紙（小小一張貼在對話裡）；平台不收這個格式就照舊當圖片發
                if (!part?.isMedia && caps.sticker && p.sendSticker) {
                    const ext = String(pubUrl).split('?')[0].split('.').pop().toLowerCase();
                    const mime = local?.mime || EXT_MIME[ext] || '';
                    try { await sent(await p.sendSticker(acc, pubUrl, mime), meaning ? `[sticker: ${meaning}]` : '[sticker]'); return; }
                    catch (e) { console.warn('[imessage] native sticker failed, send as image:', e?.message); }
                }
                await sent(await p.sendMedia(acc, pubUrl), part?.isMedia ? '[图片]' : (meaning ? `[sticker: ${meaning}]` : '[sticker]'));
            },
            sendVideo: async (url) => {
                await sent(await p.sendMedia(acc, await self._mediaUrl(acc, url)), '[视频]');
            },
            async sendVoice(mp3, label, text) {
                const inboxId = await self.s.get('inbox');
                const id = await self._putPublic(mp3, 'audio/mpeg', 'mp3');
                const url = `${acc.publicBase}/imessage/pub/${encodeURIComponent(inboxId)}/${acc.hookToken}/${id}`;
                await sent(await p.sendVoice(acc, url), text ? `[voice] ${text}` : '[voice]');
            },
            _timer: null,
            async typing(on) {
                clearInterval(this._timer);
                try { await p.typing(acc, on); } catch { /* 沒有輸入中提示照樣回 */ }
                if (on) this._timer = setInterval(() => { p.typing(acc, true).catch(() => {}); }, 50000);
            },
            promptHint: (rec) => self._promptHint(caps, rec),
        };
        // 原生 Tapback：貼在用戶最近一條對得上的訊息上（AI 給的 target 是關鍵詞；找不到就貼最後一條）
        if (caps.react && p?.react) {
            chan.react = async (emoji, target) => {
                const m = (await self._findMid(target, { fromOnly: 'me' })) || (target ? await self._findMid('', { fromOnly: 'me' }) : null) || (await self._findMid(''));
                if (!m) throw new Error('no message to react to');
                await p.react(acc, m.id, emoji, false);
            };
        }
        return chan;
    }

    // 告訴 AI 這裡是真的 iMessage、能用哪些原生玩法（英文，和其他提示詞一致）
    _promptHint(caps, rec) {
        if (!caps || !Object.keys(caps).length) return '';
        const tpl = String(rec?.promptTemplate || '');
        const lines = ['## iMessage native touches', "This conversation is happening in real iMessage on the user's iPhone. Besides the usual lines, these native touches are available:"];
        if ((caps.fx || []).length) {
            const bubble = caps.fx.filter((x) => ['slam', 'loud', 'gentle', 'invisible'].includes(x));
            const screen = caps.fx.filter((x) => !bubble.includes(x));
            lines.push(`- Send effect: add "fx" to a text or reply line, e.g. {"t":"text","c":"...","fx":"slam"}. Bubble effects: ${bubble.join(' / ')}. Full-screen effects: ${screen.join(' / ')}. An effect is a gesture people use for moments that carry weight for them — good news, a birthday, a dramatic "slam", a secret hidden in invisible ink, a flirty full screen of love — so reach for one when this persona would genuinely make that gesture right now, and let the rest of the lines stay plain.`);
        }
        if (caps.anim) lines.push('- Animated text: add "anim" to a text line to animate the whole bubble: big / small / shake / nod / explode / ripple / bloom / jitter.');
        if (caps.react && /"t"\s*:\s*"react"/.test(tpl)) lines.push('- {"t":"react",...} lands as a real iMessage tapback on that message. ❤️ 👍 👎 😂 ‼️ ❓ show as the classic tapbacks; any other single emoji shows as an emoji tapback.');
        if (caps.reply) lines.push('- {"t":"reply",...} shows as a native threaded reply attached to the quoted message, so the quote should be words from that message.');
        lines.push('- In the transcript, "[reacted X to: ...]" is a tapback the user placed on that message, "[reply to: ...]" is the user replying to that specific message, "[fx: ...]" means the bubble was sent with that effect, and "[sticker]" is an iMessage sticker. Notice and respond to these the way a person would when seeing them on their phone.');
        return lines.join('\n');
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
        let accChanged = false;
        // 只接受用戶本人的號碼（別人傳訊息到這條線不會花你的 AI 額度）
        const mine = msgs.filter((m) => m.handle && normHandle(m.handle) === me);
        for (const m of mine) {
            if (m.chatId && m.chatId !== acc.chatId) { acc.chatId = m.chatId; accChanged = true; }
            if (m.kind !== 'reaction' && m.id) { acc.lastMessageId = m.id; accChanged = true; }
            // Sendblue 回應要帶線路號碼；用戶沒填就記 webhook 帶來的
            if (m.line && m.line !== acc.lineNumber) { acc.lineNumber = m.line; accChanged = true; }
        }
        if (accChanged) await this.s.put('acc', acc);
        // Tapback：平台給的回應事件，或平台把蘋果的文字版（「Loved “…”」）當普通訊息轉過來
        const reactions = [];
        const texts = [];
        for (const m of mine) {
            if (m.kind === 'reaction') { reactions.push(m); continue; }
            const tb = !m.mediaUrls?.length && parseTextTapback(m.text);
            if (tb) reactions.push({ ...m, kind: 'reaction', emoji: tb.emoji, remove: tb.remove, targetText: tb.targetText, targetId: '' });
            else texts.push(m);
        }
        let noted = 0;
        if (reactions.length) {
            const seen = (await this.s.get('seen')) || [];
            for (const r of reactions) {
                if (r.id && seen.includes(String(r.id))) continue;
                if (r.id) seen.push(String(r.id));
                try { await this._noteReaction(acc, r); noted++; } catch (e) { console.warn('[imessage] reaction note failed:', e?.message); }
            }
            await this.s.put('seen', seen.slice(-SEEN_CAP));
        }
        // 記下用戶每條訊息的 id ↔ 文字（角色要回應 / 引用時找得到）
        for (const m of texts) await this._recordMid(m.id, m.text || (m.mediaUrls?.length ? (m.isSticker ? '[sticker]' : '[图片]') : ''), 'me');
        const added = await this._enqueue(texts);
        return { json: { ok: true, ...(added || noted ? {} : { ignored: true }) } };
    }

    // 收到的用戶訊息（{ id, text, voiceText, mediaUrls, ts }）→ 去重後進 pending，排「停手後再回」
    async _enqueue(msgs) {
        const seen = (await this.s.get('seen')) || [];
        const pending = (await this.s.get('pending')) || [];
        let added = 0;
        for (const m of msgs) {
            if (m.id && seen.includes(String(m.id))) continue;
            if (m.id) seen.push(String(m.id));
            pending.push({
                text: m.text || '', voiceText: m.voiceText || '', mediaUrls: m.mediaUrls || [], ts: m.ts || now(),
                // iMessage：引用了哪條、用了什麼特效、是不是貼紙（QQ 沒有這些，欄位就不帶）
                ...(m.replyToId ? { replyToId: String(m.replyToId) } : {}),
                ...(m.effect ? { effect: String(m.effect) } : {}),
                ...(m.isSticker ? { isSticker: true } : {}),
            });
            added++;
        }
        if (!added) return 0;
        await this.s.put('seen', seen.slice(-SEEN_CAP));
        await this.s.put('pending', pending);
        await this.s.put('lastUserAt', now());
        // 連發合併：每來一條就往後推「停手時間」（App 可設），但從這批第一條算起有封頂
        const waitMs = replyWaitMs(await this.s.get('cfg'), DEBOUNCE_MS);
        let since = await this.s.get('pendingSince');
        if (pending.length === added || !since) { since = now(); await this.s.put('pendingSince', since); }
        await this.hooks.schedule(Math.max(500, Math.min(waitMs, since + replyWaitCapMs(waitMs) - now())));
        return added;
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
        const acc = raw.some((m) => m.replyToId) ? await this.s.get('acc') : null;
        for (const m of raw) {
            const text = String(m.text || '').trim();
            // 指令單獨一條才算
            if (/^[/／]/.test(text) && !m.mediaUrls?.length) {
                await this.runCommand(text.replace(/^[/／]\s*/, ''), (t) => chan.sendText(t).catch(() => {}));
                continue;
            }
            // 原生引用 → 被引用那條的文字；特效 → 統一名字（認不得的原樣留著給 AI 看）
            const replyTo = m.replyToId ? await this._resolveTarget(acc, m.replyToId) : null;
            const effect = m.effect ? (normalizeFx(m.effect) || String(m.effect)) : '';
            const extra = { ...(replyTo?.text ? { replyTo } : {}), ...(effect ? { effect } : {}) };
            const before = pending.length;
            if (m.voiceText) pending.push({ type: 'voice', text: m.voiceText, ts: m.ts });
            else if (text) pending.push({ type: 'text', text, ts: m.ts });
            for (const url of m.mediaUrls || []) {
                const item = await this._fetchMedia(url, m.ts);
                pending.push(m.isSticker && item.type === 'image' ? { ...item, isSticker: true } : item);
            }
            // 引用 / 特效掛在這條的第一段上
            if (pending.length > before && Object.keys(extra).length) pending[before] = { ...pending[before], ...extra };
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
