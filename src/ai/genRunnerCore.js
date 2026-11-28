// 手机提交的生成，在 Workers 上挂进 Durable Object 的 alarm 里跑（一次请求一个 DO 实例，名称 gen:<requestId>）。
//
// 为什么：/generate 内联跑时生成绑在手机那条连线上。Workers 的规矩是客户端一断线，
//   waitUntil 最多再给 30 秒 —— 而线下剧情 + 思考模型动辄几分钟。手机切后台 / iOS fetch
//   中途 Load failed → 连线断 → 30 秒后生成被系统掐掉、结果永远写不进 outbox；
//   但 AI 站点早已收下请求、照样生成扣费。手机换通道重交同一 requestId 又被幂等 409 挡回，
//   只能空等 =「站点显示输出完了、App 一直生成中、没报错」。
//   alarm 处理器有自己的 15 分钟墙钟，与手机连线无关 → 断线也能跑完、写进 outbox。
//
// ⚠️ alarm 抛错 / 被驱逐时 Cloudflare 会自动重跑 alarm。重跑生成 = 同一轮再扣一次费，
//   所以状态先落盘成 running；重跑时见到 running 就只写一条「生成被中断」的失败结果
//   让手机停止等待，绝不再调一次 AI。

import { runGenerateJob, writeGenerateError } from './generateJob.js';

const KEEP_MS = 6 * 60 * 60 * 1000; // 状态保留 6 小时（与 outbox TTL 同口径）后清掉整个实例

export class GenRunnerCore {
    constructor(storage, env, hooks, rawStorage) {
        this.storage = storage; // 自动切块的包装（payload 可能远超单值上限）
        this.env = env;
        this.hooks = hooks;
        this.raw = rawStorage;
    }

    async handle(method, path, _query, body) {
        if (method === 'POST' && path === '/gen/start') {
            const st = await this.storage.get('st');
            if (st) return { json: { ok: true, state: st.state } }; // 同一 requestId 已交过：不重跑
            if (!body?.requestId || !body?.inboxId) return { status: 400, json: { error: 'payload required' } };
            await this.storage.put('job', body);
            await this.storage.put('st', { state: 'queued', queuedAt: Date.now() });
            await this.hooks.schedule(0);
            return { json: { ok: true, state: 'queued' } };
        }
        if (method === 'GET' && path === '/gen/status') {
            const st = await this.storage.get('st');
            return { json: st ? { state: st.state, generated: !!st.generated } : { state: 'unknown' } };
        }
        return { status: 404, json: { error: 'not found' } };
    }

    // alarm 回调：回传下一次 alarm 的毫秒数（null = 不再排）
    async runOnce() {
        const st = await this.storage.get('st');
        if (!st) return null;
        if (st.state === 'done' || st.state === 'failed') {
            // 收尾那次 alarm：清掉整个实例
            if (Date.now() - (st.finishedAt || 0) >= KEEP_MS - 60_000) {
                await this.raw.deleteAll();
                return null;
            }
            return KEEP_MS;
        }
        const job = await this.storage.get('job');
        if (!job) {
            await this.storage.put('st', { ...st, state: 'failed', finishedAt: Date.now() });
            return KEEP_MS;
        }
        if (st.state === 'running') {
            // 上一次 alarm 跑到一半没了（超时 / 被驱逐）：不再调 AI，写失败结果让手机停等
            try { await writeGenerateError(this.env, job, 'relay generation interrupted'); } catch (e) { console.warn('[genRunner] write error item failed:', e?.message); }
            await this.storage.put('st', { ...st, state: 'failed', finishedAt: Date.now() });
            await this.storage.delete('job');
            return KEEP_MS;
        }
        await this.storage.put('st', { ...st, state: 'running', startedAt: Date.now() });
        let generated = false;
        try {
            const r = await runGenerateJob(this.env, job);
            generated = !!r?.generated;
        } catch (e) {
            // 写 outbox 本身失败（KV 额度用尽等）：尽力再写一条失败结果
            console.warn('[genRunner] job failed:', e?.message);
            try { await writeGenerateError(this.env, job, String(e?.message || e)); } catch { /* ignore */ }
        }
        await this.storage.put('st', { state: generated ? 'done' : 'failed', generated, finishedAt: Date.now() });
        await this.storage.delete('job');
        return KEEP_MS;
    }
}
