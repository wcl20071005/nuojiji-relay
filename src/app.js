// Hono app —— 一份代码，Workers 和 Node 共用。
//
// 路由：
//   GET  /health                 健康检查（设置页测连接用）
//   POST /generate               提交生成（fire-and-forget，202）
//   GET  /outbox?inboxId=&since=  拉取已生成结果
//   POST /ack                    确认并删除
//   GET  /api/push/vapid-key     取 VAPID 公钥（复用 APP 现有订阅流程）
//   POST /api/push/subscribe     注册推送订阅
//   DELETE /api/push/unsubscribe 退订

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireSecret } from './util/auth.js';
import { createOutboxStore } from './store/outboxStore.js';
import { createSubStore, subKey } from './store/subStore.js';
import { createProactiveStore, PROACTIVE_WINDOW_CAP } from './store/proactiveStore.js';
import { createKvStore } from './store/kvStore.js';
import { runGenerateJob } from './ai/generateJob.js';
import { getVapidPublicKey } from './push/webPush.js';
import { nowMs } from './util/ids.js';
import { TICK_CONFIG_KEY, readTickMinutes, hasEnvTickMinutes, rememberTickMinutes } from './proactive/tickConfig.js';
import { registerWechatRoutes } from './wechat/routes.js';
import { registerMomentsRoutes } from './moments/routes.js';
import { registerJobsRoutes } from './jobs/routes.js';
import { registerNoticeRoutes } from './push/noticeRoutes.js';
import { normalizeSendCap, normalizeSendTimes } from './proactive/sendCap.js';
import { mergeIncomingWindow } from './proactive/windowMerge.js';
import { normalizeRandomSlots } from './util/randomSlots.js';

const VERSION = '1.3.1';
// 這版中繼認得的功能模組（App「雲端功能」頁據此提示哪些要更新中繼）
const MODULES = ['proactive', 'commitments', 'occasions', 'weather', 'moments', 'jobs', 'bridgeSchedule', 'qq', 'notices', 'jobNotify', 'bgGenerate'];

// /proactive/register 输入上限：只防 KV 单值 25MiB 写失败，不是内容裁剪。
//   整条注册记录（模板+滑窗+MCP 配置等）存成同一个 KV 值，模板按 UTF-8 字节算给到 20MiB，留 ~5MiB 给其余字段与 JSON 转义。
const PROMPT_TEMPLATE_MAX_BYTES = 20 * 1024 * 1024;
const MCP_SERVERS_MAX_BYTES = 1024 * 1024;
const MCP_SERVERS_MAX_COUNT = 64;

// ⏰ 时间承诺清单：只留结构正确的；数量 / 单条大小封顶防 KV 值撑爆（不改内容）
const COMMITMENTS_MAX = 50;
function normalizeCommitments(list) {
    return list
        .filter(c => c && c.id != null && Number.isFinite(Number(c.triggerAt)) && typeof c.block === 'string' && c.block.length < 20000)
        .slice(0, COMMITMENTS_MAX)
        .map(c => ({
            id: String(c.id), triggerAt: Number(c.triggerAt), block: c.block, reason: typeof c.reason === 'string' ? c.reason : '',
            // 同一組（例如同一個節日）一個 inbox 只讓一位角色開口
            ...(typeof c.group === 'string' && c.group ? { group: c.group } : {}),
        }));
}

// 🌦️ 天氣提醒設定：座標 + 用戶當地 UTC 偏移 + 幾點看 + 各種天氣的提示詞段落（App 給）
function normalizeWeatherWatch(w) {
    if (!w || typeof w !== 'object' || !Number.isFinite(Number(w.lat)) || !Number.isFinite(Number(w.lon)) || !w.blocks || typeof w.blocks !== 'object') return null;
    return {
        lat: Number(w.lat), lon: Number(w.lon),
        utcOffsetSeconds: Number.isFinite(Number(w.utcOffsetSeconds)) ? Number(w.utcOffsetSeconds) : 0,
        atMinutes: Number.isFinite(Number(w.atMinutes)) ? Number(w.atMinutes) : 450,
        reason: typeof w.reason === 'string' ? w.reason : '',
        blocks: Object.fromEntries(Object.entries(w.blocks).filter(([, v]) => typeof v === 'string' && v.length < 5000)),
    };
}

// Workers 上每个 requestId 一个生成实例（借用 WECHAT 这个 Durable Object 绑定，免加新迁移）；Node 回 null
function genRunnerStub(env, requestId) {
    if (!env || !env.WECHAT || typeof env.WECHAT.idFromName !== 'function') return null;
    return env.WECHAT.get(env.WECHAT.idFromName(`gen:${requestId}`));
}

export function createApp() {
    const app = new Hono();

    // 中继是用户自己的后端，APP 从套壳 (https://localhost / capacitor://localhost) 或
    // 网页 (https://*.pages.dev) 跨域请求 → 放开 CORS（鉴权靠 Bearer secret，不靠 origin）。
    app.use('*', cors({
        origin: (o) => o || '*',
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
    }));

    // 每个请求懒初始化 store（Workers 每次 fetch 都新 env；Node 进程级缓存见下）
    const stores = { outbox: null, sub: null, proactive: null, kv: null };
    async function getStores(env) {
        if (env && env.OUTBOX) {
            // Workers：KV 绑定每次都现取，store 实例无状态可重建
            return {
                outbox: await createOutboxStore(env),
                sub: await createSubStore(env),
                proactive: await createProactiveStore(env),
                kv: await createKvStore(env),
            };
        }
        // Node：进程级单例
        if (!stores.outbox) stores.outbox = await createOutboxStore(env);
        if (!stores.sub) stores.sub = await createSubStore(env);
        if (!stores.proactive) stores.proactive = await createProactiveStore(env);
        if (!stores.kv) stores.kv = await createKvStore(env);
        return stores;
    }

    app.get('/health', async (c) => {
        const { outbox } = await getStores(c.env);
        return c.json({ ok: true, store: outbox.kind || 'unknown', version: VERSION, modules: MODULES });
    });

    // 🖼️ 角色头像公开读取（无鉴权）——iOS 通知扩展(独立进程,App 没运行)要能直接 GET 下载，
    //    附到 Communication Notification 显示在通知左侧。头像只是公开可见的角色头像，无敏感信息。
    //    存在 KV（OUTBOX namespace 的 av: 前缀），由 POST /avatar 写入。
    app.get('/avatar/:key', async (c) => {
        const key = c.req.param('key');
        if (!key || !/^[\w.-]{1,128}$/.test(key)) return c.json({ error: 'bad key' }, 400);
        const { kv } = await getStores(c.env);
        if (!kv) return c.json({ error: 'no store' }, 503);
        const rec = await kv.get(`av:${key}`, { type: 'json' }).catch(() => null);
        if (!rec || !rec.b64) return c.json({ error: 'not found' }, 404);
        try {
            const bin = Uint8Array.from(atob(rec.b64), (ch) => ch.charCodeAt(0));
            return new Response(bin, {
                status: 200,
                headers: {
                    'content-type': rec.mime || 'image/png',
                    'cache-control': 'public, max-age=86400',
                    'access-control-allow-origin': '*',
                },
            });
        } catch {
            return c.json({ error: 'decode failed' }, 500);
        }
    });

    // 未捕获异常（多为存储层：Workers KV 免费版每日写入 1000 次额度用尽 / KV 写入失败 / sqlite 出错）
    //   Hono 默认只回一句「Internal Server Error」，手机端看不出原因 → 回 JSON 带真实报错。
    app.onError((err, c) => {
        const msg = String(err?.message || err);
        console.error('[relay] unhandled error:', c.req.method, c.req.path, msg);
        return c.json({ error: `relay error: ${msg}` }, 500);
    });

    // 以下全部要鉴权
    app.use('/avatar', requireSecret); // POST /avatar 写入要鉴权（GET /avatar/:key 上面已公开放行）
    app.use('/generate', requireSecret);
    app.use('/outbox', requireSecret);
    app.use('/ack', requireSecret);
    app.use('/api/push/subscribe', requireSecret);
    app.use('/api/push/unsubscribe', requireSecret);
    app.use('/api/push/diag', requireSecret);
    app.use('/proactive/*', requireSecret);

    app.post('/generate', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { requestId, inboxId, messages, settings, maxTokens, meta } = body || {};
        if (!requestId || !inboxId || !Array.isArray(messages) || !settings) {
            return c.json({ error: 'requestId / inboxId / messages / settings required' }, 400);
        }

        const { outbox, sub } = await getStores(c.env);

        // 幂等：同 requestId 在 TTL 内只处理一次。
        //   H4 修：命中幂等时，若 outbox 里那条结果还在（未被 ack 删）→ 直接【返回它】，让手机端拿到内容；
        //   只有结果已被取走删除时才回 409。否则旧码一律 409 无内容 → 手机重提交（网络抖/重启）就永久
        //   拿不到这条回复（6h 内）= 数据丢失。
        if (await outbox.seenRequest(requestId)) {
            try {
                const existing = (await outbox.list(inboxId, 0, { scan: true })).find(it => it && String(it.requestId) === String(requestId));
                if (existing && !existing.error && existing.content) {
                    return c.json({ accepted: true, requestId, generated: true, replayed: true }, 202);
                }
            } catch { /* 查不到就照旧 409 */ }
            return c.json({ duplicate: true, requestId }, 409);
        }
        await outbox.markRequest(requestId);

        // ⚠️ 生成期间手机连线保持开着（等生成完才回 JSON），长思考模型可以好几分钟不产生一个字节 →
        //    iOS WKWebView fetch 空闲断开（Load failed）。故用流式响应：先吐一个空格、生成期间每 15s
        //    再吐一个空格保活，最后吐 JSON 结果。JSON 允许前导空白，旧版手机 res.json() 照样能解析。
        const payload = { requestId, inboxId, settings, messages, maxTokens, meta };
        const runInline = () => {
            // Node（或没有 Durable Object 绑定的旧部署）：内联跑。Node 进程不随客户端断线中止。
            // Hono 在 Node 下讀 c.executionCtx 會直接拋錯 → 包 try
            let waitUntil = null;
            try { if (typeof c.executionCtx?.waitUntil === 'function') waitUntil = (p) => c.executionCtx.waitUntil(p); } catch { /* Node */ }
            const p = runGenerateJob(c.env, payload, { waitUntil }).catch((e) => {
                console.warn('[generate] work failed:', e?.message);
                return { accepted: true, requestId, generated: false };
            });
            try { if (waitUntil) waitUntil(p); } catch { /* Node 无 executionCtx */ }
            return p;
        };
        let done;
        const runner = genRunnerStub(c.env, requestId);
        if (runner) {
            // Workers：交给 Durable Object 的 alarm 跑（手机断线也能跑完，见 genRunnerCore.js），
            //   这里只轮询它的状态、跑完再回手机。手机中途断了也无所谓 —— 结果照样进 outbox。
            done = (async () => {
                let started = false;
                try {
                    const startRes = await runner.fetch('https://gen/gen/start', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
                    });
                    started = startRes.ok;
                } catch (e) { console.warn('[generate] gen runner start failed:', e?.message); }
                // 交不进 Durable Object（还没交出去 = 没调过 AI）→ 退回内联跑，不丢这一轮
                if (!started) return runInline();
                for (;;) {
                    await new Promise((r) => setTimeout(r, 3000));
                    const st = await runner.fetch('https://gen/gen/status').then((r) => r.json()).catch(() => null);
                    if (st?.state === 'done' || st?.state === 'failed') return { accepted: true, requestId, generated: st.state === 'done' };
                }
            })().catch((e) => {
                console.warn('[generate] gen runner failed:', e?.message);
                return { accepted: true, requestId, generated: false };
            });
            // 手机一送出就断线时，也要保证这一笔交进 Durable Object（之后的轮询被掐无所谓）
            try { if (typeof c.executionCtx?.waitUntil === 'function') c.executionCtx.waitUntil(done); } catch { /* Node */ }
        } else {
            done = runInline();
        }
        const enc = new TextEncoder();
        let keepAlive = null;
        const stream = new ReadableStream({
            start(ctrl) {
                const write = (str) => { try { ctrl.enqueue(enc.encode(str)); } catch { /* 客户端已断 */ } };
                write(' ');
                keepAlive = setInterval(() => write(' '), 15_000);
                done.then((result) => {
                    clearInterval(keepAlive);
                    write(JSON.stringify(result));
                    try { ctrl.close(); } catch { /* ignore */ }
                });
            },
            cancel() { clearInterval(keepAlive); },
        });
        // 走 c.body 而非裸 new Response：保留 cors 等中间件已设的响应头
        return c.body(stream, 202, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no', // 反代（nginx 等）别缓冲，空格要即时到手机
        });
    });

    app.get('/outbox', async (c) => {
        const inboxId = c.req.query('inboxId');
        const since = Number(c.req.query('since') || 0);
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { outbox } = await getStores(c.env);
        // scan=1 → 额外做 KV 前缀扫描兜底（只在手机启动/回前台时带）；scan=0 → 只走索引，不吃 list 额度；
        // 不带（旧版手机）→ store 内部节流。
        const scanQ = c.req.query('scan');
        const scan = scanQ === '1' ? true : scanQ === '0' ? false : undefined;
        const items = await outbox.list(inboxId, since, { scan });
        return c.json({ items, now: nowMs() });
    });

    // 手机查一次生成还在不在跑（Workers + Durable Object 才有；App 据此判断要不要继续等 outbox）
    app.use('/gen-status', requireSecret);
    app.get('/gen-status', async (c) => {
        const requestId = c.req.query('requestId');
        if (!requestId) return c.json({ error: 'requestId required' }, 400);
        const runner = genRunnerStub(c.env, requestId);
        if (!runner) return c.json({ supported: false, state: 'unknown' });
        const st = await runner.fetch('https://gen/gen/status').then((r) => r.json()).catch(() => null);
        return c.json({ supported: true, state: st?.state || 'unknown' });
    });

    // ⏱️ 检测间隔设置：App 设置页「云端检查频率」写这里，cron 据此决定几分钟真跑一轮主动检测。
    //    存在 KV（全局一份，中继是用户自己的后端，只服务自己）。环境变量 PROACTIVE_TICK_MINUTES 优先。
    app.use('/config', requireSecret);
    app.get('/config', async (c) => {
        const { kv } = await getStores(c.env);
        return c.json({ ok: true, tickMinutes: await readTickMinutes(c.env, kv), envLocked: hasEnvTickMinutes(c.env) });
    });
    app.post('/config', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const n = Math.floor(Number(body?.tickMinutes));
        if (!Number.isFinite(n) || n < 1 || n > 60) return c.json({ error: 'tickMinutes must be 1-60' }, 400);
        const { kv } = await getStores(c.env);
        // 💸 没变就不写
        const prev = await kv.get(TICK_CONFIG_KEY);
        if (String(prev) !== String(n)) await kv.put(TICK_CONFIG_KEY, String(n));
        rememberTickMinutes(n);
        return c.json({ ok: true, tickMinutes: n, envLocked: hasEnvTickMinutes(c.env) });
    });

    app.post('/ack', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, ids } = body || {};
        if (!inboxId || !Array.isArray(ids)) return c.json({ error: 'inboxId / ids required' }, 400);
        const { outbox } = await getStores(c.env);
        const acked = await outbox.ack(inboxId, ids);
        return c.json({ acked });
    });

    app.get('/api/push/vapid-key', async (c) => {
        const publicKey = await getVapidPublicKey(c.env);
        if (!publicKey) return c.json({ error: 'VAPID not configured' }, 503);
        return c.json({ publicKey });
    });

    app.post('/api/push/subscribe', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, subscription, channel } = body || {};
        if (!inboxId || !subscription) return c.json({ error: 'inboxId / subscription required' }, 400);
        // 默认 web 通道（PWA）；apns/fcm 由套壳显式带 channel
        const entry = subscription.channel ? subscription : { channel: channel || 'web', sub: subscription };
        try {
            const { sub } = await getStores(c.env);
            await sub.add(inboxId, entry);
            // apns/fcm 每设备单 token：token 轮换会留下旧行，每条推送/自检都会发两遍。
            // 注册成功后清掉同 inbox 同 channel 的旧订阅，只保留这条最新的。web 多端共存不清。
            const ch = entry.channel || 'web';
            if ((ch === 'apns' || ch === 'fcm') && typeof sub.pruneChannel === 'function') {
                await sub.pruneChannel(inboxId, ch, subKey(entry));
            }
        } catch (e) {
            // 把真实异常返回（而非裸 500），便于手机端「检查推送」直接显示后端报错（如 KV 未绑定 / put 失败）。
            return c.json({ error: 'subscribe failed', detail: String(e?.message || e), hasKV: !!(c.env && c.env.OUTBOX) }, 500);
        }
        return c.json({ ok: true });
    });

    // 🩺 推送链路自检（设置页「检查推送」按钮调）：
    //   - 列出本 inbox 当前注册了哪些推送订阅通道（web/apns/fcm），不回 token 全文（脱敏）。
    //   - test:true 时对每条订阅真发一条测试推送，回每条的投递结果（含中转/APNs 的 reason）。
    //   一眼能看出：没有 apns 订阅 = 客户端没注册成功；有订阅但 dispatch 失败 = 中转/凭据问题。
    app.post('/api/push/diag', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { body = {}; }
        const { inboxId, test } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { sub } = await getStores(c.env);
        const subs = await sub.list(inboxId);
        const mask = (s) => {
            const t = s?.token || s?.sub?.token || s?.sub?.endpoint || '';
            const tail = String(t).slice(-6);
            return { channel: s?.channel || 'web', idTail: tail ? `…${tail}` : null };
        };
        const channels = subs.map(mask);
        const result = { inboxId, count: subs.length, channels };

        // 🔬 头像链路诊断：查这个 inbox 注册过的 pair 里有没有存 avatarUrl，
        //    以及该 URL 指向的头像在 KV 里是否真的存在（避免「上传失败/过期」却不自知）。
        try {
            const { proactive, kv } = await getStores(c.env);
            const recs = (proactive?.listByInbox ? await proactive.listByInbox(inboxId) : []) || [];
            result.avatars = [];
            for (const r of recs) {
                const url = r?.avatarUrl || null;
                let stored = null;
                if (url && kv) {
                    const m = String(url).match(/\/avatar\/([\w.-]+)$/);
                    if (m) {
                        const raw = await kv.get(`av:${m[1]}`).catch(() => null);
                        stored = raw ? `present(${raw.length}b)` : 'MISSING-in-KV';
                    } else stored = 'unparseable-url';
                }
                result.avatars.push({
                    charId: r?.charId ?? null, charName: r?.timeSpec?.charName ?? null,
                    avatarUrl: url, kvStatus: url ? stored : 'NO-avatarUrl-registered',
                });
            }
        } catch (e) {
            result.avatarsError = String(e?.message || e);
        }

        // ⚠️ test:true「真发测试推送」已停用。
        //    现象：有客户端(疑似旧版本/后台保活循环)每 5~10 分钟反复调本端点 test:true，
        //    每次对每条订阅各发一条「推送链路自检(带头像)」→ 用户被自检通知轰炸。
        //    诊断本身只需「查订阅是否存在 + 头像 KV 是否在」，不必真发通知。
        //    故无条件不再 dispatch，只回订阅清单 + 头像状态；UI 拿不到 dispatch 时显示「已停用真发」。
        if (test && subs.length) {
            result.dispatch = subs.map((s) => ({
                channel: s?.channel || 'web', ok: null, gone: false,
                reason: '测试推送已停用(防自检通知轰炸)，本项仅列出订阅是否存在',
            }));
        }
        return c.json(result);
    });

    // 🖼️ 写入角色头像（鉴权）：客户端注册 proactive 时上传角色头像 base64，存 KV 供推送/扩展使用。
    //    body: { key, dataUrl }（dataUrl = "data:image/png;base64,xxx"）。返回公开读取路径 { url }。
    app.post('/avatar', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { key, dataUrl } = body || {};
        if (!key || !/^[\w.-]{1,128}$/.test(key)) return c.json({ error: 'bad key' }, 400);
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return c.json({ error: 'dataUrl required' }, 400);
        const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return c.json({ error: 'bad dataUrl' }, 400);
        const mime = m[1], b64 = m[2];
        // 限大小：通知头像几十 KB 足够，封顶 ~512KB base64 防滥用 KV。
        if (b64.length > 512 * 1024) return c.json({ error: 'avatar too large' }, 413);
        const { kv } = await getStores(c.env);
        if (!kv) return c.json({ error: 'no store' }, 503);
        try {
            await kv.put(`av:${key}`, JSON.stringify({ mime, b64 }), { expirationTtl: 60 * 60 * 24 * 60 }); // 60 天
        } catch (e) {
            return c.json({ error: 'put failed', detail: String(e?.message || e) }, 500);
        }
        return c.json({ ok: true, url: `/avatar/${key}` });
    });

    app.delete('/api/push/unsubscribe', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, subscription, endpoint } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { sub } = await getStores(c.env);
        await sub.remove(inboxId, subscription || { endpoint });
        return c.json({ ok: true });
    });

    // ===== Phase 2：后端代理主动消息 =====

    // 注册/更新一对的全量配置（含手机端拼好的 promptTemplate）
    app.post('/proactive/register', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const {
            inboxId, userId, charId, promptTemplate, proactiveProfile, lifeState,
            intensity, proactiveBias, recentMessages, aiSettings, quietHours,
            charUtcOffsetSeconds, proactiveEnabledAt, lastInteractionAt, enabled,
            mode, interval, intervalUnit, probability, timeSpec, mcpContextServers, avatarUrl, notifPrivacy,
            mcpToolServers, mcpProactiveToolUse, commitments, weatherWatch, sendCap, appSends, randomSlots,
        } = body || {};
        if (!inboxId || userId == null || charId == null || !promptTemplate || !aiSettings) {
            return c.json({ error: 'inboxId / userId / charId / promptTemplate / aiSettings required' }, 400);
        }
        // M6：输入大小封顶，只防 KV 值过大(25MB 限制)写失败。promptTemplate 含人设+世界书+记忆+总结，
        //   大世界书 / 长期记忆的用户轻易超过几百 KB（旧 256KB 上限曾让这类用户注册全 413）——
        //   上限贴近 KV 硬限制（按 UTF-8 字节算，中文一字 3 字节），只拦真正写不进去的输入；内容本身不在任何一端截断。
        if (typeof promptTemplate === 'string') {
            const tplBytes = new TextEncoder().encode(promptTemplate).length;
            if (tplBytes > PROMPT_TEMPLATE_MAX_BYTES) {
                return c.json({ error: `promptTemplate too large (${(tplBytes / 1024 / 1024).toFixed(1)}MB > ${PROMPT_TEMPLATE_MAX_BYTES / 1024 / 1024}MB, Cloudflare KV 单值上限 25MB)` }, 413);
            }
        }
        // D：mcpToolServers/mcpContextServers 也封顶（含 cachedTools 的 inputSchema 可能很大），防 KV bloat。
        for (const [field, val] of [['mcpToolServers', mcpToolServers], ['mcpContextServers', mcpContextServers]]) {
            if (val != null) {
                if (Array.isArray(val) && val.length > MCP_SERVERS_MAX_COUNT) return c.json({ error: `${field} too many (${val.length} > ${MCP_SERVERS_MAX_COUNT})` }, 413);
                let sz = 0; try { sz = JSON.stringify(val).length; } catch { /* ignore */ }
                if (sz > MCP_SERVERS_MAX_BYTES) return c.json({ error: `${field} too large (${Math.round(sz / 1024)}KB > ${MCP_SERVERS_MAX_BYTES / 1024 / 1024}MB)` }, 413);
            }
        }
        const { proactive } = await getStores(c.env);
        // 重新註冊也一樣：保住微信 / iMessage 剛聊的那段
        const prevRec = await proactive.get(inboxId, String(userId), String(charId)).catch(() => null);
        const merged = mergeIncomingWindow(
            prevRec,
            Array.isArray(recentMessages) ? recentMessages : [], lastInteractionAt || 0);
        await proactive.upsert({
            inboxId, userId: String(userId), charId: String(charId),
            mode: mode === 'interval' ? 'interval' : 'impulse',
            interval: interval ?? 60, intervalUnit: intervalUnit || 'minutes', probability: probability || 'medium',
            promptTemplate, proactiveProfile: proactiveProfile || null, lifeState: lifeState || {},
            intensity: intensity || 'normal', proactiveBias: proactiveBias || 0,
            recentMessages: merged.recentMessages,
            aiSettings, quietHours: quietHours || null,
            charUtcOffsetSeconds: charUtcOffsetSeconds ?? null,
            // ⏱️ 同一档位重新注册保住原本的开启时间：旧版 App 前台每分钟都重新注册一次、每次都发「现在」
            //    → 计时档基线永远等不满一个间隔、真人模式永远卡在 30 分钟暖机期。换了档位（开 / 关真人模式）才用新值。
            proactiveEnabledAt: (prevRec && prevRec.mode === (mode === 'interval' ? 'interval' : 'impulse') && Number(prevRec.proactiveEnabledAt))
                || proactiveEnabledAt || Date.now(),
            lastInteractionAt: merged.lastInteractionAt,
            enabled: enabled !== false,
            timeSpec: timeSpec || null, // 🕒 时间穿透：tick 时用它把 §NOW_*§ 哨兵填成即时真时间
            mcpContextServers: Array.isArray(mcpContextServers) ? mcpContextServers : [], // 🧠 第三方记忆 MCP 直连配置
            // 🛠️ 主动用工具：action-mode MCP server 规格（含 cachedTools）+ 全局开关，tick 时跑 tool-loop。
            mcpToolServers: Array.isArray(mcpToolServers) ? mcpToolServers : [],
            mcpProactiveToolUse: !!mcpProactiveToolUse,
            avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null, // 🖼️ 角色头像公开 URL，推送时带给 iOS 通知扩展显示在左侧
            notifPrivacy: !!notifPrivacy, // 🔒 通知隐私模式：推送时正文换「你有一条新消息」，标题/头像保留
            // ⏰ 时间承诺（「三点再聊」「明早叫你」）：到点优先触发，不看冲动值 / 冷却（措辞全由手机端带来）
            ...(Array.isArray(commitments) ? { commitments: normalizeCommitments(commitments) } : {}),
            ...(weatherWatch !== undefined ? { weatherWatch: normalizeWeatherWatch(weatherWatch) } : {}),
            // 🔢 用户设的「一段时间内最多主动几次」（null = 不限）；appSends = 手机本机发过的时间，与中继自己记的 capSends 合并计数
            ...(sendCap !== undefined ? { sendCap: normalizeSendCap(sendCap), appSends: normalizeSendTimes(appSends) } : {}),
            // 🎲 隨機槽（隨機心聲預設 / 預設隨機頭部）：每次生成各抽一段；保住上次抽中的，換模板也不連抽同一段
            randomSlots: normalizeRandomSlots(randomSlots),
            lastRandomPicks: prevRec?.lastRandomPicks || null,
        });
        return c.json({ ok: true });
    });

    // 🔒 即时刷新本 inbox 所有 pair 的通知隐私标志（用户切开关时调，无需重跑整个注册）。
    app.post('/proactive/privacy', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, notifPrivacy } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { proactive } = await getStores(c.env);
        const recs = (proactive?.listByInbox ? await proactive.listByInbox(inboxId) : []) || [];
        let updated = 0;
        for (const r of recs) {
            if (await proactive.patch(inboxId, String(r.userId), String(r.charId), { notifPrivacy: !!notifPrivacy })) updated++;
        }
        return c.json({ ok: true, updated });
    });

    // 增量同步滑窗消息 + lifeState + lastInteractionAt（整窗替换，无 delta）
    app.post('/proactive/sync-messages', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, charId, recentMessages, lifeState, lastInteractionAt, promptTemplate, timeSpec, commitments, weatherWatch, sendCap, appSends, randomSlots } = body || {};
        if (!inboxId || userId == null || charId == null) {
            return c.json({ error: 'inboxId / userId / charId required' }, 400);
        }
        const { proactive } = await getStores(c.env);
        const patch = {};
        // 💬 微信 / iMessage 聊天直接寫進後端滑窗；手機若還沒拉回那段就推舊窗口 → 合併，不讓它被蓋掉、互動時間也不倒退
        const existing = (Array.isArray(recentMessages) || typeof lastInteractionAt === 'number')
            ? await proactive.get(inboxId, String(userId), String(charId)).catch(() => null) : null;
        if (Array.isArray(recentMessages)) {
            const merged = mergeIncomingWindow(existing, recentMessages, lastInteractionAt);
            patch.recentMessages = merged.recentMessages;
            patch.lastInteractionAt = merged.lastInteractionAt;
        } else if (typeof lastInteractionAt === 'number') {
            patch.lastInteractionAt = Math.max(lastInteractionAt, Number(existing?.bridgeInteractionAt) || 0);
        }
        if (lifeState) patch.lifeState = lifeState;
        // 🧠 手机端每次往来重建的「与前台同质量」prompt（含最新记忆/总结/世界书/日历）→ patch 覆盖旧模板，
        //    根治后端代理主动消息上下文不即时。timeSpec 同步刷新（角色名/时段表/异地 offset 可能变）。
        if (typeof promptTemplate === 'string' && promptTemplate) {
            patch.promptTemplate = promptTemplate;
            // 隨機槽跟著模板走（新 App 每次都帶，null = 這份模板沒有隨機段）；舊 App 不帶 → 不動
            if (randomSlots !== undefined) patch.randomSlots = normalizeRandomSlots(randomSlots);
        }
        if (timeSpec) patch.timeSpec = timeSpec;
        if (Array.isArray(commitments)) patch.commitments = normalizeCommitments(commitments);
        if (weatherWatch !== undefined) patch.weatherWatch = normalizeWeatherWatch(weatherWatch);
        if (sendCap !== undefined) { patch.sendCap = normalizeSendCap(sendCap); patch.appSends = normalizeSendTimes(appSends); }
        const ok = await proactive.patch(inboxId, String(userId), String(charId), patch);
        if (!ok) return c.json({ error: 'pair not registered' }, 404);
        return c.json({ ok: true });
    });

    // 🖼️ 单独回写一对的角色头像 URL（不重跑整个注册）。
    //   手机端「检查推送」发现 NO-avatarUrl-registered 时调，补传头像后回写，无需关开主动消息开关。
    app.post('/proactive/set-avatar', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, charId, avatarUrl } = body || {};
        if (!inboxId || userId == null || charId == null) return c.json({ error: 'inboxId / userId / charId required' }, 400);
        if (typeof avatarUrl !== 'string' || !avatarUrl) return c.json({ error: 'avatarUrl required' }, 400);
        const { proactive } = await getStores(c.env);
        const ok = await proactive.patch(inboxId, String(userId), String(charId), { avatarUrl });
        if (!ok) return c.json({ error: 'pair not registered' }, 404);
        return c.json({ ok: true });
    });

    // 📋 列出本 inbox 上所有已注册的主动对（手机端「孤儿对账」用）。
    //   手机端拿到后与本地「角色后台活动」名单求差集，把不该在的注销掉——清理旧版本
    //   「聊一句就自动注册」留下的僵尸对（用户报「没开开关的角色也反复发消息」）。
    app.get('/proactive/list', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { proactive } = await getStores(c.env);
        const recs = (proactive?.listByInbox ? await proactive.listByInbox(inboxId) : []) || [];
        return c.json({
            ok: true,
            pairs: recs.map(r => ({
                userId: String(r.userId), charId: String(r.charId),
                mode: r.mode, enabled: !!r.enabled,
                updatedAt: r.updatedAt || 0, lastFiredAt: r.lastFiredAt || 0,
            })),
        });
    });

    app.post('/proactive/unregister', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, userId, charId } = body || {};
        if (!inboxId || userId == null || charId == null) return c.json({ error: 'inboxId / userId / charId required' }, 400);
        const { proactive } = await getStores(c.env);
        await proactive.remove(inboxId, String(userId), String(charId));
        return c.json({ ok: true });
    });

    // 走线下剧情：暂停/恢复该 inbox 的所有主动生成。
    // 手机端走线下时心跳式 pause（带 durationMs 自动过期，防没发 resume 永久哑火），退出时 resume。
    app.post('/proactive/pause', async (c) => {
        let body;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
        const { inboxId, paused, durationMs } = body || {};
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { proactive } = await getStores(c.env);
        if (paused === false) {
            await proactive.setPause(inboxId, 0);
            return c.json({ ok: true, paused: false });
        }
        // 默认 10 分钟，手机端每隔几分钟续期；上限 1 小时防异常长暂停。
        const dur = Math.min(60 * 60 * 1000, Math.max(60 * 1000, Number(durationMs) || 10 * 60 * 1000));
        const until = nowMs() + dur;
        await proactive.setPause(inboxId, until);
        return c.json({ ok: true, paused: true, pausedUntil: until });
    });

    app.get('/proactive/status', async (c) => {
        const inboxId = c.req.query('inboxId');
        if (!inboxId) return c.json({ error: 'inboxId required' }, 400);
        const { proactive } = await getStores(c.env);
        const rows = await proactive.listByInbox(inboxId);
        // 不回 promptTemplate/key 等敏感内容，只回状态
        return c.json({
            pairs: rows.map(r => ({
                userId: r.userId, charId: r.charId, enabled: r.enabled,
                windowSize: (r.recentMessages || []).length,
                lastFiredAt: r.lastFiredAt || 0, updatedAt: r.updatedAt,
            })),
        });
    });

    // ===== 微信 ClawBot 橋接（線上聊天接進微信）=====
    registerWechatRoutes(app);
    // 后台朋友圈：注册 / 领取 / 确认（见 src/moments/）
    registerMomentsRoutes(app);
    // 定时生成任务：每日结算 / 角色离线互聊…（见 src/jobs/）
    registerJobsRoutes(app);
    // 系统通知留底：安卓没有推送通道，轮询器自己来拉（见 src/push/noticeStore.js）
    registerNoticeRoutes(app);

    return app;
}
