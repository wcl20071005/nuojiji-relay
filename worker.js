// Cloudflare Workers 入口。
// 部署：wrangler deploy（需在 wrangler.toml 绑定 KV namespace "OUTBOX"，
//      并 `wrangler secret put RELAY_SECRET` / VAPID_* 等）。

import { createApp } from './src/app.js';
import { runProactiveTick, shouldRunTickNow } from './src/proactive/tick.js';

// 微信橋接的 Durable Object 類（wrangler.toml 的 [[durable_objects.bindings]] 指向它）
export { WechatBridge } from './src/wechat/wechatDO.js';

const app = createApp();

export default {
    fetch: app.fetch,
    // Phase 2：定时主动生成。wrangler.toml [triggers] crons 配置触发频率。
    async scheduled(event, env, ctx) {
        // 检测间隔（App 设置 / PROACTIVE_TICK_MINUTES，默认 5 分钟）没到就直接返回（省 KV 额度）。
        ctx.waitUntil((async () => {
            if (!(await shouldRunTickNow(env, event?.scheduledTime))) return;
            await runProactiveTick(env);
        })().catch((e) => console.error('[scheduled] proactive tick failed:', e?.message)));
    },
};
