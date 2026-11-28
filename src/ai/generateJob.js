// 一次「手机提交的生成」的完整收尾：调 AI → 写 outbox → 发推送。
//
// 两处共用：
//   - /generate 内联跑（Node 部署 / 没有 Durable Object 绑定的旧 Workers 部署）
//   - GenRunner（Workers 上挂在 Durable Object 的 alarm 里跑，手机断线也能跑完，见 genRunnerCore.js）
//
// payload：{ requestId, inboxId, settings, messages, maxTokens, meta }

import { createOutboxStore } from '../store/outboxStore.js';
import { createSubStore } from '../store/subStore.js';
import { runGeneration } from './aiCaller.js';
import { dispatchPush } from '../push/pushSender.js';
import { makeMessageId, nowMs, extractPushBodies } from '../util/ids.js';

/** 按 payload 组一条 outbox 结果（成功 / 失败共用口径） */
export function buildOutboxItem(payload, { content = null, reasoning = null, error = null } = {}) {
    const { requestId, meta } = payload || {};
    return {
        id: makeMessageId(requestId),
        requestId,
        charId: meta?.charId ?? null, roundId: meta?.roundId ?? null, userId: meta?.userId ?? null,
        content, reasoning: reasoning || null, error, createdAt: nowMs(),
    };
}

/**
 * 跑完一次生成并写进 outbox。
 * @param {object} env
 * @param {object} payload
 * @param {{ waitUntil?: (p: Promise<any>) => void }} [opts] 推送交给 waitUntil 后台发；不给就就地等推送发完
 * @returns {Promise<{ accepted: true, requestId: string, generated: boolean }>}
 */
export async function runGenerateJob(env, payload, { waitUntil } = {}) {
    const { requestId, inboxId, settings, messages, maxTokens } = payload;
    let item;
    try {
        const { content, reasoning } = await runGeneration(settings, messages, maxTokens);
        item = buildOutboxItem(payload, { content, reasoning });
    } catch (e) {
        item = buildOutboxItem(payload, { error: String(e?.message || e) });
    }
    const outbox = await createOutboxStore(env);
    await outbox.put(inboxId, item);

    const pushWork = sendGeneratePush(env, payload, item);
    if (typeof waitUntil === 'function') {
        try { waitUntil(pushWork); } catch { await pushWork; }
    } else {
        await pushWork;
    }
    return { accepted: true, requestId, generated: !item.error };
}

/** 写一条失败结果进 outbox（生成被中断等）：手机端等待者撈到就会显示错误、不再空等 */
export async function writeGenerateError(env, payload, error) {
    const outbox = await createOutboxStore(env);
    await outbox.put(payload.inboxId, buildOutboxItem(payload, { error: String(error) }));
}

// 发推送（best-effort，丢了靠手机轮询补）。逐条发：把生成内容拆成各条可见消息，每条发一个带内容的通知，
// 模拟真人逐条发消息的体验。拆分是通用 JSON-Lines 文本提取（取 {"t":"text","c":"..."} 的可见文本），
// 不含任何提示词逻辑。标题用角色名（手机随 meta 传来）。
async function sendGeneratePush(env, payload, item) {
    const { inboxId, meta } = payload;
    try {
        // ⚠️ 生成失败（502 等）不发推送：手机端排水对 error item 一律丢弃不写气泡，
        //    若这里仍弹「你有一条新消息」→ 用户点进去聊天里却什么都没有 = 假通知。
        if (item.error) return;
        const sub = await createSubStore(env);
        const subs = await sub.list(inboxId);
        if (!subs.length) return;
        const title = meta?.charName || '糯叽机';
        // 🔒 通知隐私模式（手机端 meta 带来）：正文换「你有一条新消息」，标题/头像保留。
        // 线下剧情（meta.kind === 'tm'）是整段长文，不按气泡拆：只发一条手机端给的提示语
        const bodies = meta?.kind === 'tm'
            ? [meta?.pushText || '线下剧情的回复已生成']
            : meta?.notifPrivacy
                ? extractPushBodies(item.content).map(() => '你有一条新消息')
                : extractPushBodies(item.content);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let i = 0;
        for (const body of bodies) {
            // 逐条之间加真人节奏延迟（按字数估打字时长），第一条立即发。
            if (i > 0) {
                const delay = Math.min(4000, 600 + (body?.length || 0) * 120);
                await sleep(delay);
            }
            const pushPayload = {
                title, body, charId: item.charId, userId: item.userId, kind: 'relay-outbox',
                // 🖼️ iOS 通知扩展：头像 URL + 发信人 + 会话 id（meta 随手机端 submitGeneration 传来）
                avatarUrl: meta?.avatarUrl || null,
                senderName: title,
                conversationId: `${item.userId}_${item.charId}`,
                mutableContent: true,
            };
            for (const s of subs) {
                const res = await dispatchPush(env, s, pushPayload);
                if (res?.gone) await sub.remove(inboxId, s);
            }
            i++;
        }
    } catch (e) {
        console.warn('[generate] push failed:', e?.message);
    }
}
