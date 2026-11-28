// 聊天橋接共用核心：把糯嘰機的角色接到外部聊天軟體（微信 / iMessage …）。
//
// 各渠道（wechat/bridgeCore.js、imessage/imessageCore.js）繼承這個類，只負責：
//   - 怎麼收到用戶訊息（微信長輪詢 / iMessage webhook）
//   - 一個「發送通道」adapter：怎麼發文字 / 表情 / 語音、輸入中提示、還剩幾條額度
// 其餘全部共用：角色名單（角色 × 用戶）、/切换 指令、回覆模板 + 滑窗、生成回覆、
//   表情 / 語音轉換、帶名字前綴、對話 log 給手機取回、後端主動消息轉發。
//
// 共用 storage key：
//   inbox / cfg / pair:<u>:<c> / log / media:<id>（見各方法註解）

import { synthesizeSpeech, cleanTtsText } from '../wechat/tts.js';
import { replyToWechatParts, fitToBudget, partsToWindowText, withTranslation } from '../wechat/replyToWechat.js';
import { renderForChannel } from './displayRules.js';

// 聊天橋接功能版本：App 面板拿它判斷用戶的中繼是否太舊（沒 Sync fork）→ 提示去更新。每加一項外發相關修正 +1
//   1 = 容錯切分 JSON / 照片視頻補發（19a1f62）  2 = 類型別名對齊 App（d11046d）  3 = 顯示正則 + HTML 卡片轉文字
//   4 = iMessage 原生 Tapback / 引用 / 特效 / 貼紙
export const BRIDGE_REV = 4;
import { runGeneration } from '../ai/aiCaller.js';
import { renderTranscript } from '../proactive/tick.js';
import { renderTimeTokens } from '../util/timeTokens.js';
import { renderRandomSlots, normalizeRandomSlots } from '../util/randomSlots.js';
import { buildMemoryContext } from '../proactive/mcpContext.js';
import { createProactiveStore, PROACTIVE_WINDOW_CAP } from '../store/proactiveStore.js';
import { b64ToBytes } from '../wechat/ilinkClient.js';

export const LOG_CAP = 500;                       // 手機很久沒開也只留這麼多輪（每輪含完整內容，不截斷）
export const LOG_MAX_AGE_MS = 30 * 24 * 3600e3;   // 30 天沒被取走才丟
export const MEDIA_MAX_BYTES = 1.5 * 1024 * 1024; // 單個收到的媒體超過就只記文字不存檔

export const pairKey = (u, c) => `pair:${String(u)}:${String(c)}`;

// 本機表情包圖片：內容雜湊（hex）；單張上限（base64 字元數，約 3MB 圖）
const STICKER_HASH_RE = /^[a-f0-9]{16,64}$/;
const STICKER_MAX_B64 = 4 * 1024 * 1024;
// 手機補發的圖片 / 影片（角色拍的照片、視頻）：單個上限（base64 字元數，約 45MB 檔案），存一天
const OUT_MEDIA_MAX_B64 = 60 * 1024 * 1024;
const OUT_MEDIA_TTL_MS = 24 * 3600e3;

// ⏳ 連發合併：用戶停手多久才回（App 可設，秒）；一直有新訊息時最多等這麼久就先回
export const REPLY_WAIT_MAX_SEC = 300;
export function replyWaitMs(cfg, defMs) {
    const sec = Number(cfg?.replyWaitSec);
    return Number.isFinite(sec) && sec > 0 ? Math.min(REPLY_WAIT_MAX_SEC, sec) * 1000 : defMs;
}
// 總等待封頂：至少 20 秒、或停手時間的 4 倍，不超過 10 分鐘
export const replyWaitCapMs = (waitMs) => Math.min(600000, Math.max(20000, waitMs * 4));

// 🛌 作息一致：角色此刻在睡覺 / 忙 → 先不回，等醒來 / 忙完再回（App 同步來的日程時段 + 提示詞段落，後端零話術）
const AWAY_MIN_LEFT_MS = 5 * 60 * 1000;        // 剩不到 5 分鐘就結束的時段 → 直接回
const BUSY_MAX_WAIT_MS = 3 * 60 * 60 * 1000;   // 忙最多晚 3 小時回（真人也會抽空看手機）
const jitterMin = (lo, hi) => (lo + Math.random() * (hi - lo)) * 60 * 1000;

/** 這一刻落在哪個「睡覺 / 忙」時段（沒有 → null） */
export function awaySlot(rec, t = Date.now()) {
    const slots = Array.isArray(rec?.schedule) ? rec.schedule : [];
    return slots.find((x) => x && (x.level === 'sleep' || x.level === 'busy')
        && Number(x.start) <= t && t < Number(x.end) && Number(x.end) - t > AWAY_MIN_LEFT_MS) || null;
}
export function awayDueAt(slot, t = Date.now()) {
    if (slot.level === 'sleep') return Number(slot.end) + jitterMin(3, 15);
    return Math.min(Number(slot.end), t + BUSY_MAX_WAIT_MS) + jitterMin(1, 8);
}
// 用戶這輪的訊息 → 滑窗文字（AI 看到的寫法和角色自己的 [reply to: …] 一致）
export function userWindowText(m) {
    if (m.type === 'reaction') return `[${m.remove ? 'removed reaction' : 'reacted'} ${m.emoji}${m.targetText ? ` to: ${m.targetText}` : ''}]`;
    let t = m.type === 'voice' ? `[voice] ${m.text}`
        : m.type === 'image' ? (m.isSticker ? '[sticker]' : '[image]')
            : m.type === 'file' ? `[file: ${m.fileName}]` : m.text;
    if (m.replyTo?.text) t = `[reply to: ${m.replyTo.text}] ${t}`;
    if (m.effect) t = `${t} [fx: ${m.effect}]`;
    return t;
}

export const sameChar = (a, b) => !!(a && b && String(a.userId) === String(b.userId) && String(a.charId) === String(b.charId));
export const now = () => Date.now();

function fillTemplate(template, { transcript, memory }) {
    return String(template || '')
        .replaceAll('{{RECENT_MESSAGES}}', transcript)
        .replaceAll('{{IMPULSE_REASON}}', '')
        .replaceAll('{{MEMORY_CONTEXT}}', memory || '');
}

export function sniffMime(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
    return 'application/octet-stream';
}

export const newMediaId = (ts) => `${ts || now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * 發送通道 adapter（子類 openChannel() 回傳）：
 *   budget          這次還能發幾條（微信每條用戶訊息 10 條；iMessage 不限 → Infinity）
 *   sendText(text)
 *   sendSticker(url, meaning)        失敗會丟錯，核心自動改發「[表情] 含義」
 *   sendVoice(mp3, label, text)      合成好的 mp3；沒有這個方法 = 這個渠道只能發文字
 *   typing(on)                       可選
 *   isQuotaError(e)                  可選：額度用完的錯誤 → 停止這輪後面的訊息
 *   afterSend(n)                     可選：記帳
 */
export class ChannelBridgeCore {
    /**
     * @param {object} storage { get, put, delete }
     * @param {object} env     Workers env（Node 為 {}）
     * @param {object} hooks   { schedule(ms|null) }
     * @param {object} opts    { prefix:'/wechat', label:'微信', logPrefix:'wx' }
     */
    constructor(storage, env, hooks, opts) {
        this.s = storage;
        this.env = env || {};
        this.hooks = hooks;
        this.opts = opts;
        this.lastError = null;
        this.lastWarn = null;
    }

    // ---------- HTTP API ----------
    async handle(method, path, query, body) {
        const inboxId = query?.inboxId || body?.inboxId;
        if (inboxId) await this._rememberInbox(inboxId);
        const p = this.opts.prefix;
        switch (`${method} ${path}`) {
            case `GET ${p}/status`: return { json: { ok: true, ...(await this.commonStatus()), ...(await this.channelStatus()) } };
            case `POST ${p}/config`: return this.setConfig(body || {});
            case `POST ${p}/pair`: return this.setPair(body || {});
            case `POST ${p}/pair/remove`: return this.removePair(body || {});
            case `GET ${p}/log`: return this.getLog();
            case `POST ${p}/ack`: return this.ack(body?.ids);
            case `GET ${p}/media`: return this.getMedia(query?.id);
            case `POST ${p}/stickers/have`: return this.stickersHave(body?.hashes);
            case `POST ${p}/sticker`: return this.putSticker(body || {});
            case `POST ${p}/outmedia`: return this.putOutMedia(body || {});
            case `POST ${p}/mirror`: return this.mirrorProactive(body || {});
            case `POST ${p}/forward`: return this.forwardFromApp(body || {});
            case `POST ${p}/kick`: await this.hooks.schedule(0); return { json: { ok: true } };
            default: {
                const r = await this.handleChannel(method, path, query, body);
                return r || { status: 404, json: { error: 'not found' } };
            }
        }
    }

    // 子類覆寫
    async handleChannel() { return null; }
    async channelStatus() { return {}; }
    async openChannel() { return null; }

    async _rememberInbox(inboxId) {
        if ((await this.s.get('inbox')) !== inboxId) await this.s.put('inbox', inboxId);
    }

    async commonStatus() {
        const cfg = await this.s.get('cfg');
        const pairs = [];
        for (const p of cfg?.pairs || []) {
            const rec = await this.s.get(pairKey(p.userId, p.charId));
            pairs.push({ ...p, ready: !!rec?.promptTemplate, updatedAt: rec?.updatedAt || 0 });
        }
        return { config: { ...(cfg || {}), pairs }, lastError: this.lastError, lastWarn: this.lastWarn, rev: BRIDGE_REV };
    }

    // ---------- 名單 / 角色模板 ----------
    async setConfig(body) {
        const prev = (await this.s.get('cfg')) || {};
        const next = { ...prev };
        if (Array.isArray(body.pairs)) {
            next.pairs = body.pairs
                .filter((p) => p && p.userId != null && p.charId != null)
                .map((p) => ({ userId: String(p.userId), charId: String(p.charId), name: String(p.name || ''), userName: String(p.userName || '') }));
        }
        if (body.active) next.active = { userId: String(body.active.userId), charId: String(body.active.charId) };
        for (const k of ['proactive', 'showName', 'followSchedule', 'forwardApp']) if (typeof body[k] === 'boolean') next[k] = body[k];
        // 角色語音：'text' 以文字發 / 'audio' 合成音頻發（需該角色有雲端可用的 TTS）
        if (body.voiceMode === 'text' || body.voiceMode === 'audio') next.voiceMode = body.voiceMode;
        // 回覆前等用戶停手幾秒（連發好幾條時才不會說一句就回）
        if (Number.isFinite(Number(body.replyWaitSec)) && body.replyWaitSec !== null && body.replyWaitSec !== '') {
            next.replyWaitSec = Math.min(REPLY_WAIT_MAX_SEC, Math.max(1, Number(body.replyWaitSec)));
        }
        if (!next.pairs?.some((p) => sameChar(p, next.active))) {
            next.active = next.pairs?.[0] ? { userId: next.pairs[0].userId, charId: next.pairs[0].charId } : null;
        }
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
            ttsSpec: body.ttsSpec !== undefined ? (body.ttsSpec || null) : (prev.ttsSpec || null),
            // 🛌 作息一致：角色這幾天「睡覺 / 忙」的時段（絕對時間 ms）+ 醒來 / 忙完才看到訊息時追加的提示詞段落
            schedule: Array.isArray(body.schedule) ? body.schedule.slice(0, 200) : (prev.schedule || []),
            awayBlocks: body.awayBlocks && typeof body.awayBlocks === 'object' ? body.awayBlocks : (prev.awayBlocks || null),
            // App 顯示前套的正則（外發前照樣套，見 displayRules.js）；舊 App 不帶 → 保留上次的
            displayRules: Array.isArray(body.displayRules) ? body.displayRules : (prev.displayRules || []),
            // 🎲 隨機槽（隨機心聲預設 / 預設隨機頭部）跟著模板走；舊 App 不帶 → 保留上次的
            randomSlots: body.randomSlots !== undefined ? normalizeRandomSlots(body.randomSlots) : (prev.randomSlots || null),
            updatedAt: now(),
        });
        // 換掉 / 刪掉的本機表情圖順手清掉（只在這個角色有用過本機表情時才需要）
        if (Object.values(prev.stickerUrls || {}).some((v) => String(v).startsWith('stk:'))) await this._gcStickers();
        return { json: { ok: true } };
    }

    async removePair({ userId, charId }) {
        await this.s.delete(pairKey(userId, charId));
        await this._gcStickers();
        return { json: { ok: true } };
    }

    // ---------- 本機表情包圖片 ----------
    // 用戶上傳到糯嘰機的表情沒有網址 → 手機把圖片傳上來，按內容雜湊存 stk:<hash>；
    //   角色模板裡的 stickerUrls 對應寫成 "stk:<hash>"，發送時從這裡取圖
    async stickersHave(hashes) {
        const list = Array.isArray(hashes) ? hashes.map(String).filter((h) => STICKER_HASH_RE.test(h)) : [];
        const missing = [];
        for (const h of list) if (!(await this.s.get(`stk:${h}`))) missing.push(h);
        return { json: { ok: true, missing } };
    }

    async putSticker({ hash, mime, b64 }) {
        if (!STICKER_HASH_RE.test(String(hash || '')) || typeof b64 !== 'string' || !b64) return { status: 400, json: { error: 'hash / b64 required' } };
        if (b64.length > STICKER_MAX_B64) return { status: 413, json: { error: 'sticker too large' } };
        await this.s.put(`stk:${hash}`, { mime: /^image\//.test(mime || '') ? mime : 'image/png', b64, at: now() });
        const idx = (await this.s.get('stkIdx')) || [];
        if (!idx.includes(hash)) { idx.push(hash); await this.s.put('stkIdx', idx); }
        return { json: { ok: true } };
    }

    /**
     * 中繼上存的圖片 / 影片 → { mime, bytes, hash, pubId }；不是中繼存的（普通網址）→ null
     *   "stk:<hash>"  本機表情包
     *   "om:<id>"     手機生成好補發過來的圖片 / 影片（角色拍的照片、視頻）
     */
    async loadSticker(ref) {
        const s = String(ref || '');
        let m = /^stk:([a-f0-9]+)$/.exec(s);
        if (m) {
            const rec = await this.s.get(`stk:${m[1]}`);
            return rec ? { mime: rec.mime, bytes: b64ToBytes(rec.b64), hash: m[1], pubId: `stk_${m[1]}` } : null;
        }
        m = /^om:([A-Za-z0-9_]+)$/.exec(s);
        if (m) {
            const rec = await this.s.get(`om:${m[1]}`);
            return rec ? { mime: rec.mime, bytes: b64ToBytes(rec.b64), hash: m[1], pubId: `om_${m[1]}` } : null;
        }
        return null;
    }

    // 手機補發的圖片 / 影片：存一天就清（發出去之後就沒用了）
    async putOutMedia({ mime, b64 }) {
        if (typeof b64 !== 'string' || !b64) return { status: 400, json: { error: 'b64 required' } };
        if (b64.length > OUT_MEDIA_MAX_B64) return { status: 413, json: { error: 'media too large' } };
        if (!/^(?:image|video)\//.test(mime || '')) return { status: 400, json: { error: 'image / video only' } };
        const id = `${now()}_${Math.random().toString(36).slice(2, 10)}`;
        await this.s.put(`om:${id}`, { mime, b64, at: now() });
        const idx = ((await this.s.get('omIdx')) || []);
        const keep = [];
        for (const x of idx) {
            if (now() - x.at < OUT_MEDIA_TTL_MS) keep.push(x);
            else await this.s.delete(`om:${x.id}`);
        }
        keep.push({ id, at: now() });
        await this.s.put('omIdx', keep);
        return { json: { ok: true, ref: `om:${id}` } };
    }

    // 沒有任何角色再用到的表情圖刪掉
    async _gcStickers() {
        const idx = (await this.s.get('stkIdx')) || [];
        if (!idx.length) return;
        const cfg = (await this.s.get('cfg')) || {};
        const used = new Set();
        for (const p of cfg.pairs || []) {
            const rec = await this.s.get(pairKey(p.userId, p.charId));
            for (const v of Object.values(rec?.stickerUrls || {})) {
                const m = /^stk:([a-f0-9]+)$/.exec(String(v));
                if (m) used.add(m[1]);
            }
        }
        const keep = [];
        for (const h of idx) {
            if (used.has(h)) keep.push(h);
            else await this.s.delete(`stk:${h}`);
        }
        if (keep.length !== idx.length) await this.s.put('stkIdx', keep);
    }

    // ---------- 手機取對話 ----------
    async getLog() {
        return { json: { ok: true, items: (await this.s.get('log')) || [], now: now() } };
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

    // ---------- 指令：/切换 /谁 ----------
    // reply(text) 由子類給（發回同一個對話）
    async runCommand(raw, reply) {
        const cfg = (await this.s.get('cfg')) || {};
        const pairs = cfg.pairs || [];
        const [cmd, ...rest] = raw.split(/\s+/);
        const arg = rest.join(' ').trim();
        // 紀錄是「角色 × 用戶」一對：名單跨多個用戶時標出是哪個用戶的那一份
        const multiUser = new Set(pairs.map((p) => p.userId)).size > 1;
        const label = (p) => `${p.name || p.charId}${multiUser && p.userName ? `（${p.userName}）` : ''}`;
        const listText = () => pairs.map((p, i) => `${i + 1}. ${label(p)}${sameChar(p, cfg.active) ? '（当前）' : ''}`).join('\n');
        const where = this.opts.label;
        if (/^(切换|切換|换|換|switch)$/i.test(cmd)) {
            if (!pairs.length) return reply(`还没有可以聊的角色。请在糯叽机「连接${where}」里选择角色。`);
            if (!arg) return reply(`可以聊的角色：\n${listText()}\n\n发送「/切换 编号」或「/切换 名字」换人。`);
            const idx = /^\d+$/.test(arg) ? Number(arg) - 1 : pairs.findIndex((p) => (p.name || '').toLowerCase() === arg.toLowerCase());
            const hit = pairs[idx] || pairs.find((p) => (p.name || '').includes(arg));
            if (!hit) return reply(`没有找到「${arg}」。\n${listText()}`);
            await this.s.put('cfg', { ...cfg, active: { userId: hit.userId, charId: hit.charId } });
            return reply(`已切换到 ${label(hit)}。`);
        }
        if (/^(谁|誰|当前|當前|who)$/i.test(cmd)) {
            const cur = pairs.find((p) => sameChar(p, cfg.active));
            return reply(cur ? `正在和 ${label(cur)} 聊天。` : '还没有选择角色。');
        }
        return reply('指令：\n/切换 —— 列出角色\n/切换 编号或名字 —— 换人\n/谁 —— 现在在和谁聊');
    }

    // ---------- 一輪回覆 ----------
    // pending: [{ type:'text'|'voice'|'image'|'file', text, ts, mediaId?, dataUrl?, fileName?, durationMs? }]
    /** 渠道的收訊迴圈每輪先呼叫：延後的那輪到點了 → 回 */
    async runDeferred(chan) {
        const d = await this.s.get('deferred');
        if (!d || !chan || d.dueAt > now()) return false;
        await this.s.delete('deferred');
        await this.replyRound(chan, d.pending || [], { deferred: d });
        return true;
    }

    async replyRound(chan, pending, opts = {}) {
        const cfg = (await this.s.get('cfg')) || {};
        const deferred = opts.deferred || null;
        const active = deferred ? { userId: deferred.userId, charId: deferred.charId } : cfg.active;
        const rec = active ? await this.s.get(pairKey(active.userId, active.charId)) : null;
        const logUserMsgs = pending.map(({ dataUrl, ...rest }) => rest);
        const entryBase = { id: `${this.opts.logPrefix}_${now()}_${Math.random().toString(36).slice(2, 6)}`, createdAt: now() };
        const where = this.opts.label;

        if (!rec?.promptTemplate) {
            await chan.sendText(active
                ? `这个角色还没同步到云端。请打开一次糯叽机，再在「连接${where}」里点保存。`
                : `还没选择聊天的角色。请在糯叽机「连接${where}」里选择角色。`).catch(() => {});
            await chan.afterSend?.(1);
            if (active) await this._appendLog({ ...entryBase, userId: active.userId, charId: active.charId, userMessages: logUserMsgs, content: null, error: 'pair not ready' });
            return;
        }

        // 🛌 作息一致：這一刻 TA 在睡覺 / 忙 → 先存著不回，到醒來 / 忙完再一起回（之間再發的也併進來）
        if (!deferred && cfg.followSchedule !== false) {
            const prevDeferred = await this.s.get('deferred');
            const samePair = prevDeferred && String(prevDeferred.userId) === String(rec.userId) && String(prevDeferred.charId) === String(rec.charId);
            const slot = awaySlot(rec);
            if (slot || samePair) {
                // 存起來的訊息不帶圖片本體（Durable Object 單值上限 128KB），回的時候以 [image] 文字帶過
                const keep = pending.map(({ dataUrl, ...rest }) => rest);
                const next = samePair
                    ? { ...prevDeferred, pending: [...(prevDeferred.pending || []), ...keep] }
                    : { userId: rec.userId, charId: rec.charId, pending: keep, level: slot.level, title: slot.title || '', dueAt: awayDueAt(slot) };
                await this.s.put('deferred', next);
                await this.hooks.schedule?.(Math.max(1000, next.dueAt - now()));
                return;
            }
        }

        // 生成完、發出去之前用戶又發了 → 併進來重新生成一次（像真人看到新訊息會一起回），最多重來 2 次
        let window, content = null, reasoning = null, error = null, randomPicks = {};
        for (let attempt = 0; ; attempt++) {
            const userWindowMsgs = pending.map((m) => ({ sender: 'me', text: userWindowText(m), timestamp: m.ts }));
            window = [...(rec.recentMessages || []), ...userWindowMsgs].slice(-PROACTIVE_WINDOW_CAP);
            const transcript = renderTranscript(window, rec.timeSpec);
            let memory = '';
            try { memory = await buildMemoryContext(rec.mcpContextServers, window, { userId: rec.userId, characterId: rec.charId }); } catch { /* 無記憶 MCP */ }
            // 🎲 隨機槽：每次生成各抽一段，抽中哪段寫進對話記錄，App 拉回時把心聲美化切到同一套
            const slotted = renderRandomSlots(renderTimeTokens(rec.promptTemplate, rec.timeSpec, now(), rec.lastInteractionAt || 0), rec.randomSlots, rec.lastRandomPicks);
            randomPicks = slotted.picks;
            let system = fillTemplate(slotted.text, { transcript, memory });
            // 🛌 延後的這輪：追加 App 給的「剛醒 / 剛忙完才看到」段落
            const awayBlock = deferred && rec.awayBlocks?.[deferred.level];
            if (awayBlock) system += `\n\n${String(awayBlock).replaceAll('{title}', deferred.title || '')}`;
            // 渠道原生玩法（iMessage 特效 / Tapback / 引用）：渠道自己給一段說明
            const channelHint = chan.promptHint?.(rec);
            if (channelHint) system += `\n\n${channelHint}`;
            const images = pending.filter((m) => m.dataUrl).map((m) => ({ type: 'image_url', image_url: { url: m.dataUrl } }));
            const userTurn = images.length
                ? [{ type: 'text', text: '请开始回复。（用户这轮发来的图片附在下面）' }, ...images]
                : '请开始回复。';

            await chan.typing?.(true);
            content = null; reasoning = null; error = null;
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
            }
            const more = !error && attempt < 2 ? ((await chan.takeNew?.().catch(() => null)) || []) : [];
            if (!more.length) { await chan.typing?.(false); break; }
            pending = [...pending, ...more];
        }
        const logUserMsgsAll = pending.map(({ dataUrl, ...rest }) => rest);

        const entry = { ...entryBase, userId: rec.userId, charId: rec.charId, userMessages: logUserMsgsAll, content, reasoning: reasoning || null, error, ...(Object.keys(randomPicks).length ? { randomPicks } : {}) };
        if (!error && Object.keys(randomPicks).length) rec.lastRandomPicks = { ...(rec.lastRandomPicks || {}), ...randomPicks };
        if (error) {
            await this._appendLog(entry);
            await chan.sendText(`（${rec.name || '角色'}这次没能回复：${error}）`).catch(() => {});
            await chan.afterSend?.(1);
            await this._saveWindow(rec, window);
            return;
        }
        // 生成期間用戶又發了訊息 → 通道可能要換新的回覆憑證（微信 context_token）
        const fresh = (await chan.refresh?.()) || chan;
        const sentParts = await this.deliver(fresh, rec, content, { isActive: !deferred || sameChar(cfg.active, rec), cfg });
        await this._appendLog(entry);
        const charWindowMsgs = sentParts.map((p) => partsToWindowText(p, rec.name)).filter(Boolean).map((text) => ({ sender: 'char', text, timestamp: now() }));
        await this._saveWindow(rec, [...window, ...charWindowMsgs].slice(-PROACTIVE_WINDOW_CAP));
    }

    // 角色回覆拆成一條條訊息發出；回傳實際發出的部分
    async deliver(chan, rec, content, { isActive, cfg }) {
        const parts = replyToWechatParts(content, { stickerUrls: rec.stickerUrls || {}, allowState: !!rec.allowState });
        // 有回覆、卻拆不出一條能發的 → 以前靜默什麼都不發（App 裡看得到、外面收不到），至少在面板留個提示
        if (!parts.length && String(content || '').trim()) {
            console.warn(`[${this.opts.logPrefix}] reply had nothing sendable:`, String(content).slice(0, 200));
            this.lastWarn = { at: now(), text: `角色这次的回复里没有能发到${this.opts.label}的内容（可能全是隐藏指令或旁白），糯叽机里能看到原文。` };
        }
        return this.sendParts(chan, rec, parts, { isActive, cfg });
    }

    // 已拆好的一條條（text / sticker / voice）發出去：語音能不能發、名字前綴、額度裁剪都在這裡
    async sendParts(chan, rec, rawParts, { isActive, cfg, prefix = [] }) {
        const audioVoice = cfg.voiceMode !== 'text' && !!rec.ttsSpec && typeof chan.sendVoice === 'function';
        // 和 App 氣泡顯示一致：套用戶的顯示正則、HTML 卡片轉純文字（代碼 / JSON 不外發）；滑窗仍記原文
        const rules = Array.isArray(rec.displayRules) ? rec.displayRules : [];
        rawParts = rawParts.flatMap((p) => {
            if (p.kind !== 'text') return [p];
            const text = renderForChannel(p.text, rules);
            if (!text) return [];
            return text === p.text ? [p] : [{ ...p, text, windowText: p.windowText ?? p.text }];
        });
        // 語音：能發音頻 → 音頻（原文）+ 有翻譯再跟一條翻譯文字；發不了 → 「[语音] 原文」+ 翻譯
        let parts = rawParts.flatMap((p) => {
            if (p.kind !== 'voice') return [p];
            if (!audioVoice) return [{ ...p, kind: 'text', text: withTranslation(`[语音] ${p.text}`, p.tr), windowText: `[voice] ${p.text}` }];
            return p.tr ? [p, { kind: 'text', text: p.tr, noWindow: true }] : [p];
        });
        // 回應（Tapback）：渠道有原生回應才發，先貼回應再打字（像真人先點愛心再回）；沒有就丟掉（和以前一樣不外發）
        const reacts = typeof chan.react === 'function' ? parts.filter((p) => p.kind === 'react') : [];
        parts = parts.filter((p) => p.kind !== 'react');
        if (!parts.length && !reacts.length) return [];
        // 多個角色共用一個帳號：頭像只有一個 → 回覆前帶名字分辨是誰
        const multi = (cfg.pairs || []).length > 1;
        if (parts.length && rec.name && (!isActive || (cfg.showName !== false && multi))) {
            const pairInfo = (cfg.pairs || []).find((p) => sameChar(p, rec));
            const multiUser = new Set((cfg.pairs || []).map((p) => p.userId)).size > 1;
            const tag = `【${rec.name}${multiUser && pairInfo?.userName ? `·${pairInfo.userName}` : ''}】`;
            if (parts[0].kind === 'text') parts[0] = { ...parts[0], text: `${tag}${parts[0].text}`, ...(parts[0].replyBody ? { replyBody: `${tag}${parts[0].replyBody}` } : {}) };
            else parts.unshift({ kind: 'text', text: tag });
        }
        // 前置段（例：App 裡用戶說的那句引用）放最前面，不帶名字
        parts = [...prefix, ...parts];
        if (Number.isFinite(chan.budget)) parts = fitToBudget(parts, chan.budget);
        const sent = [];
        for (const r of reacts) {
            try { await chan.react(r.emoji, r.target); sent.push(r); }
            catch (e) { console.warn(`[${this.opts.logPrefix}] reaction failed:`, e?.message); }
        }
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (i > 0) await new Promise((r) => setTimeout(r, Math.min(2500, 500 + (p.text?.length || 4) * 60)));
            try {
                if (p.kind === 'sticker') {
                    await chan.sendSticker(p.url, p.meaning, p);
                } else if (p.kind === 'video') {
                    // 角色拍的視頻（手機生成好補發過來的）；渠道發不了影片就以文字說明
                    if (typeof chan.sendVideo === 'function') await chan.sendVideo(p.url, p.meaning);
                    else await chan.sendText(`[视频] ${p.meaning || ''}`.trim());
                } else if (p.kind === 'voice') {
                    try {
                        const mp3 = await synthesizeSpeech(rec.ttsSpec, p.text);
                        const label = cleanTtsText(p.text).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 24) || 'voice';
                        await chan.sendVoice(mp3, label, p.text);
                    } catch (e) {
                        console.warn(`[${this.opts.logPrefix}] voice failed, fallback text:`, e?.message);
                        this.lastWarn = { at: now(), text: `语音发送失败：${e?.message || e}` };
                        await chan.sendText(`[语音] ${p.text}`);
                    }
                } else if (typeof chan.sendTextPart === 'function') {
                    // 渠道自己處理原生引用 / 特效（失敗會退回純文字）
                    await chan.sendTextPart(p);
                } else {
                    await chan.sendText(p.text);
                }
                sent.push(p);
            } catch (e) {
                if (p.kind === 'sticker' || p.kind === 'video') {
                    // 圖 / 影片發不出去 → 改發文字說明
                    console.warn(`[${this.opts.logPrefix}] media failed:`, e?.message);
                    if (p.isMedia || p.kind === 'video') this.lastWarn = { at: now(), text: `${p.kind === 'video' ? '视频' : '图片'}发送失败：${e?.message || e}` };
                    const label = p.kind === 'video' ? '视频' : p.isMedia ? '图片' : '表情';
                    try { await chan.sendText(`[${label}] ${p.meaning || ''}`.trim()); sent.push(p); } catch { /* 跳過 */ }
                } else {
                    console.warn(`[${this.opts.logPrefix}] send failed:`, e?.message);
                    this.lastWarn = { at: now(), text: `发送失败：${e?.message || e}` };
                    if (chan.isQuotaError?.(e)) break;
                }
            }
        }
        await chan.afterSend?.(sent.length);
        return sent;
    }

    async _saveWindow(rec, window) {
        const t = now();
        await this.s.put(pairKey(rec.userId, rec.charId), { ...rec, recentMessages: window, lastInteractionAt: t });
        // 同步給後端主動消息的同一對：否則沒開 App 時，主動消息看不到剛聊過的內容
        try {
            const inboxId = await this.s.get('inbox');
            if (inboxId) {
                const proactive = await createProactiveStore(this.env);
                await proactive.patch(inboxId, rec.userId, rec.charId, { recentMessages: window, lastInteractionAt: t, bridgeInteractionAt: t });
            }
        } catch (e) { console.warn(`[${this.opts.logPrefix}] proactive window patch failed:`, e?.message); }
    }

    // ---------- 後端主動消息 → 也發到這個渠道 ----------
    async mirrorProactive({ userId, charId, content }) {
        const cfg = await this.s.get('cfg');
        if (!cfg?.proactive || !content) return { json: { ok: false, reason: 'off' } };
        if (!(cfg.pairs || []).some((p) => sameChar(p, { userId, charId }))) return { json: { ok: false, reason: 'not linked' } };
        const rec = await this.s.get(pairKey(userId, charId));
        if (!rec) return { json: { ok: false, reason: 'pair not ready' } };
        const opened = await this.openChannel({ proactive: true });
        if (!opened?.chan) return { json: { ok: false, reason: opened?.reason || 'channel closed' } };
        const sent = await this.deliver(opened.chan, rec, content, { isActive: sameChar(cfg.active, { userId, charId }), cfg });
        if (sent.length) {
            const charWindowMsgs = sent.map((p) => partsToWindowText(p, rec.name)).filter(Boolean).map((text) => ({ sender: 'char', text, timestamp: now() }));
            await this.s.put(pairKey(userId, charId), { ...rec, recentMessages: [...(rec.recentMessages || []), ...charWindowMsgs].slice(-PROACTIVE_WINDOW_CAP), lastInteractionAt: now() });
        }
        return { json: { ok: true, sent: sent.length } };
    }

    // ---------- 糯嘰機 App 裡聊的 → 也發到這個渠道 ----------
    // body: { userId, charId, messages:[{ sender:'me'|'char', type:'text'|'sticker'|'voice'|'image', text, url?, meaning? }] }
    //   角色那幾條照常發；用戶在 App 說的話合成一條引用放最前面（外部聊天軟體裡只有 Bot 能說話）
    async forwardFromApp({ userId, charId, messages }) {
        const cfg = (await this.s.get('cfg')) || {};
        if (cfg.forwardApp === false) return { json: { ok: false, reason: 'off' } };
        if (!(cfg.pairs || []).some((p) => sameChar(p, { userId, charId }))) return { json: { ok: false, reason: 'not linked' } };
        const rec = await this.s.get(pairKey(userId, charId));
        if (!rec) return { json: { ok: false, reason: 'pair not ready' } };
        const list = Array.isArray(messages) ? messages : [];
        const mine = list.filter((m) => m?.sender === 'me').map((m) => (m.type === 'image' ? '[图片]' : m.type === 'voice' ? `[语音] ${m.text || ''}` : String(m.text || ''))).filter((x) => x.trim());
        const charParts = [];
        for (const m of list) {
            if (m?.sender !== 'char') continue;
            if (m.type === 'sticker' && /^https?:\/\//i.test(m.url || '')) charParts.push({ kind: 'sticker', url: m.url, meaning: m.meaning || m.text || '' });
            else if (m.type === 'sticker') {
                // 本機表情（App 那邊沒網址）→ 按含義找這個角色傳上來的同一張
                const meaning = m.meaning || m.text || '';
                const ref = meaning && rec.stickerUrls?.[meaning];
                charParts.push(ref ? { kind: 'sticker', url: ref, meaning } : { kind: 'text', text: `[表情] ${meaning}` });
            }
            else if (m.type === 'voice' && m.text) charParts.push({ kind: 'voice', text: String(m.text), ...(m.tr ? { tr: String(m.tr) } : {}) });
            // 角色拍的照片 / 視頻：手機生成好、傳到中繼（ref = "om:<id>"）或本來就是網址
            else if (m.type === 'image' && (/^https?:\/\//i.test(m.url || '') || /^om:/.test(m.ref || ''))) charParts.push({ kind: 'sticker', isMedia: true, url: m.ref || m.url, meaning: m.text || '图片' });
            else if (m.type === 'image') charParts.push({ kind: 'text', text: `[图片] ${m.text || ''}`.trim() });
            else if (m.type === 'video' && (/^https?:\/\//i.test(m.url || '') || /^om:/.test(m.ref || ''))) charParts.push({ kind: 'video', url: m.ref || m.url, meaning: m.text || '' });
            else if (m.type === 'video') charParts.push({ kind: 'text', text: `[视频] ${m.text || ''}`.trim() });
            else if (String(m.text || '').trim()) charParts.push({ kind: 'text', text: String(m.text) });
        }
        if (!charParts.length && !mine.length) return { json: { ok: true, sent: 0 } };
        const opened = await this.openChannel({ proactive: true });
        if (!opened?.chan) {
            const reason = opened?.reason || 'channel closed';
            const why = { 'window closed': `超过 24 小时没在${this.opts.label}里说话`, 'quota used': `这轮 10 条回复额度用完了` }[reason] || reason;
            this.lastWarn = { at: now(), text: `糯叽机里的聊天没能发到${this.opts.label}：${why}，在${this.opts.label}里给 Bot 发一句就恢复。` };
            return { json: { ok: false, reason } };
        }
        const prefix = mine.length ? [{ kind: 'text', text: `（你在糯叽机说）${mine.join('\n')}` }] : [];
        const sent = await this.sendParts(opened.chan, rec, charParts, { isActive: sameChar(cfg.active, { userId, charId }), cfg, prefix });
        return { json: { ok: true, sent: sent.length, total: charParts.length + prefix.length } };
    }
}
