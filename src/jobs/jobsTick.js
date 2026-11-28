// 定时生成任务 —— 到点执行（与主动消息共用 cron / 检测间隔，独立预算）
//
// 每轮：扫有任务的 inbox，挑出 runAt 已到、也过了重试时间的任务，先在清单上占位（tries+1、retryAt 往后推）
// 再生成，防同一任务被重叠的两轮各跑一次。成功 → 结果进待领取列表 + 推送 + 从清单拿掉；
// 失败 → 15 分钟后再试，最多 3 次，之后放弃（放一条 error 结果让手机知道）。

import { createKvStore } from '../store/kvStore.js';
import { createSubStore } from '../store/subStore.js';
import { createJobsStore } from './jobsStore.js';
import { runGeneration } from '../ai/aiCaller.js';
import { dispatchPush } from '../push/pushSender.js';
import { renderTimeTokens } from '../util/timeTokens.js';
import { evaluateNotify } from './jobNotify.js';
import { createNoticeStore } from '../push/noticeStore.js';

const TICK_BUDGET_MS = 25_000;
const RETRY_MS = 15 * 60 * 1000;
const MAX_TRIES = 3;
// 錯過太久的任務（手機很久沒同步、中繼停機）不再補跑：快照太舊，跑出來也對不上
const MAX_LATE_MS = 2 * 24 * 60 * 60 * 1000;

export async function runJobsTick(env) {
    const kv = await createKvStore(env);
    const store = createJobsStore(kv);
    const inboxes = await store.listInboxes();
    if (!inboxes.length) return { inboxes: 0, ran: 0 };
    const sub = await createSubStore(env);
    const notices = createNoticeStore(kv);
    const start = Date.now();
    let ran = 0;

    for (const inbox of inboxes) {
        let list = await store.getList(inbox);
        const due = list
            .filter(j => j.runAt <= Date.now() && (!j.retryAt || j.retryAt <= Date.now()))
            .sort((a, b) => a.runAt - b.runAt);
        for (const job of due) {
            if (Date.now() - start > TICK_BUDGET_MS) return { inboxes: inboxes.length, ran };
            const now = Date.now();
            if (now - job.runAt > MAX_LATE_MS) { await store.finish(inbox, job.id); continue; }

            // 占位
            list = await store.getList(inbox);
            const cur = list.find(j => j.id === job.id);
            if (!cur || (cur.retryAt && cur.retryAt > now)) continue;
            const tries = (cur.tries || 0) + 1;
            await store.putList(inbox, list.map(j => (j.id === job.id ? { ...j, tries, retryAt: now + RETRY_MS } : j)));

            const messages = await store.getMessages(inbox, job.id);
            const aiSettings = await store.getAi(inbox, job.kind);
            if (!Array.isArray(messages) || !aiSettings) { await store.finish(inbox, job.id); continue; }
            const filled = messages.map(m => (m && typeof m.content === 'string')
                ? { ...m, content: renderTimeTokens(m.content, job.timeSpec || null, now, 0) }
                : m);

            let content = '', error = '';
            try {
                ({ content } = await runGeneration(aiSettings, filled, aiSettings?.maxTokens || null));
                if (!content || !String(content).trim()) error = 'empty response';
            } catch (e) {
                error = String(e?.message || e);
            }
            if (error) {
                console.warn(`[jobs] ${job.kind} ${job.id} failed (try ${tries}):`, error);
                if (tries >= MAX_TRIES) {
                    await store.addPending(inbox, { id: `jr_${job.id}`, jobId: job.id, kind: job.kind, userId: job.userId, meta: job.meta, error, createdAt: now });
                    await store.finish(inbox, job.id);
                }
                continue;
            }

            await store.addPending(inbox, { id: `jr_${job.id}`, jobId: job.id, kind: job.kind, userId: job.userId, meta: job.meta, content, createdAt: now });
            await store.finish(inbox, job.id);
            ran++;

            // 推什么：带了 notify 规则 → 只推命中的（可能一条都没有）；否则照 push 文案推一条
            const toSend = job.notify
                ? evaluateNotify(content, job.notify)
                : ((job.push?.title || job.push?.body) ? [{ title: job.push.title || '', body: job.push.body || '' }] : []);
            if (toSend.length) {
                try {
                    // 先留底给安卓轮询器（它收不到推送）
                    await notices.add(inbox, toSend.map((n, i) => ({ id: `nt_${job.id}_${now}_${i}`, ...n, kind: job.kind, userId: job.userId })));
                } catch (e) { console.warn('[jobs] notice store failed:', e?.message); }
                try {
                    const subs = await sub.list(inbox);
                    for (const s of subs) {
                        let gone = false;
                        for (const n of toSend) {
                            const res = await dispatchPush(env, s, {
                                title: n.title, body: n.body,
                                userId: job.userId, kind: 'relay-job', mutableContent: true,
                            });
                            if (res?.gone) { gone = true; break; }
                        }
                        if (gone) await sub.remove(inbox, s);
                    }
                } catch (e) { console.warn('[jobs] push failed:', e?.message); }
            }
        }
    }
    return { inboxes: inboxes.length, ran };
}
