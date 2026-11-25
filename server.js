// Node / VPS / Docker 入口。
// 部署：npm install && RELAY_SECRET=xxx node server.js（默认端口 8787，可 PORT 覆盖）。

import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { createApp } from './src/app.js';

// 极简 .env 加载（不引 dotenv）：把 .env 里未设置的键注入 process.env。
try {
    const raw = readFileSync(new URL('./.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
            process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
} catch { /* 没有 .env 就用真实环境变量 */ }

const app = createApp();
const port = Number(process.env.PORT || 8787);

serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[nuojiji-relay] listening on http://localhost:${info.port}`);
    if (!process.env.RELAY_SECRET) {
        console.warn('⚠️  RELAY_SECRET 未设置 —— 所有受保护接口会返回 500。请设置后再用。');
    }
    console.log(`    store=${process.env.RELAY_STORE || 'memory'}  vapid=${process.env.VAPID_PUBLIC_KEY ? 'on' : 'off (仅轮询)'}`);
});

// 微信橋接：恢復進程重啟前已綁定的收訊息迴圈
import { resumeNodeBridges } from './src/wechat/nodeBridge.js';
resumeNodeBridges().then((n) => { if (n) console.log(`[wechat] resumed ${n} bridge(s)`); })
    .catch((e) => console.warn('[wechat] resume failed:', e?.message));

// Phase 2：node-cron 定时主动生成（每分钟 tick，与 Workers cron 对齐）
import cron from 'node-cron';
import { runProactiveTick, shouldRunTickNow } from './src/proactive/tick.js';
import { runMomentsTick } from './src/moments/momentsTick.js';
import { runJobsTick } from './src/jobs/jobsTick.js';

let _ticking = false;
cron.schedule('* * * * *', async () => {
    if (_ticking) return; // 防上一轮没跑完又进
    if (!(await shouldRunTickNow({}))) return; // 检测间隔：环境变量 > App 设置 > 默认 5 分钟
    _ticking = true;
    try {
        const r = await runProactiveTick({}); // Node：env 空对象 → store 走 memory/sqlite
        if (r.fired > 0) console.log(`[proactive] tick: ${r.fired}/${r.pairs} fired`);
    } catch (e) {
        console.error('[proactive] node-cron tick failed:', e?.message);
    }
    // 后台朋友圈：同一个检测间隔
    try {
        const m = await runMomentsTick({});
        if (m.posted > 0) console.log(`[moments] tick: ${m.posted} posted`);
    } catch (e) {
        console.error('[moments] node-cron tick failed:', e?.message);
    }
    // 定时生成任务（每日结算 / 角色离线互聊…）
    try {
        const j = await runJobsTick({});
        if (j.ran > 0) console.log(`[jobs] tick: ${j.ran} ran`);
    } catch (e) {
        console.error('[jobs] node-cron tick failed:', e?.message);
    } finally {
        _ticking = false;
    }
});
