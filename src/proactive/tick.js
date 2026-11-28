// Cron tick：遍历已启用的 pair，重算 impulse，命中则实时调 AI 生成主动消息 → outbox + 推送。
// worker.js 的 scheduled 和 server.js 的 node-cron 都调 runProactiveTick(env)。

import { isSendCapReached, nextCapSends } from './sendCap.js';
import { createProactiveStore, BACKEND_FAIL_COOLDOWN_MS, PROACTIVE_WINDOW_CAP } from '../store/proactiveStore.js';
import { createOutboxStore } from '../store/outboxStore.js';
import { createSubStore } from '../store/subStore.js';
import { shouldFire, shouldFireInterval, resolveLocalHour, intervalToMs } from './impulseEngine.js';
import { runGeneration } from '../ai/aiCaller.js';
import { dispatchPush } from '../push/pushSender.js';
import { nowMs, extractPushBodies } from '../util/ids.js';
import { renderTimeTokens, messageStamp } from '../util/timeTokens.js';
import { buildMemoryContext } from './mcpContext.js';
import { runProactiveToolLoop } from './proactiveToolPrefetch.js';
import { createKvStore } from '../store/kvStore.js';
import { readTickMinutes, DEFAULT_TICK_MINUTES } from './tickConfig.js';
import { weatherOccasion } from './weatherWatch.js';
import { renderRandomSlots } from '../util/randomSlots.js';

// 把滑窗消息渲染成转录文本（喂进 promptTemplate 的 {{RECENT_MESSAGES}}）
// 🧭 誰 / 何時：用真名（角色標 (you)）+ 時間章（關閉時間感知不帶；自定義時間帶劇情時間）。
//    過去只有「User: / Char:」且無時間 → 角色分不清誰說的、哪天說的。舊手機端沒帶名字 → 退回 User / Char。
//    旁白 / 通話回顧等特殊氣泡標出來，別被當成某一方的台詞。
export function renderTranscript(recentMessages, timeSpec = null) {
    if (!Array.isArray(recentMessages) || recentMessages.length === 0) return '(no recent messages)';
    const userName = timeSpec?.userName || 'User';
    const charName = timeSpec?.charName ? `${timeSpec.charName}(you)` : 'Char';
    return recentMessages.map((m) => {
        const isUser = m.sender === 'me' || m.role === 'user';
        const who = isUser ? userName : charName;
        let text = m.text || m.content || m.voiceText || '';
        if (m.type === 'state') text = `〈narration — a description, not a spoken line〉${text}`;
        const stamp = messageStamp(m, timeSpec);
        return `${stamp}${who}: ${text}`;
    }).join('\n');
}

// 滑窗里最新一条带时间戳的消息（ms）。后端自己追加的气泡没有时间戳，不计入。
export function windowLatestAt(recentMessages) {
    let latest = 0;
    for (const m of (Array.isArray(recentMessages) ? recentMessages : [])) {
        const raw = m?.timestamp;
        const ts = typeof raw === 'number' ? raw : (raw ? Date.parse(String(raw)) : 0);
        if (Number.isFinite(ts) && ts > latest) latest = ts;
    }
    return latest;
}

// 占位替换：后端唯一接触 prompt 的地方，只做字符串替换，无任何话术。
function fillTemplate(template, { transcript, reason, memory }) {
    return String(template || '')
        .replaceAll('{{RECENT_MESSAGES}}', transcript)
        .replaceAll('{{IMPULSE_REASON}}', reason || '')
        .replaceAll('{{MEMORY_CONTEXT}}', memory || '');
}

// ⏰ 时间承诺：到点后这么久之内都补发（和手机端本地后台同一个宽限）
export const COMMITMENT_GRACE_MS = 30 * 60 * 1000;
// 一条承诺只触发一次：用合成的「角色 id」占一个独立的 lastFired 槽（CAS），重叠的两轮 cron / 手机重送清单都不会让它发第二次
const COMMITMENT_ONCE_MS = 3 * 24 * 60 * 60 * 1000;
const commitmentSlot = (charId, id) => `${charId}#commit:${id}`;
// 模型判定「已取消 / 已完成」的静默标记（宽松比对，同手机端 commitmentExtractor 的 SKIP_RE）
const SKIP_COMMITMENT_RE = /\[\s*SKIP[\s_-]*COMMITMENT|^\s*SKIP[_-]COMMITMENT/i;

/** 这一对此刻到期、还在宽限内的承诺（最早的那条） */
export function dueCommitment(rec, now) {
    const list = Array.isArray(rec?.commitments) ? rec.commitments : [];
    return list
        .filter(c => c && Number(c.triggerAt) <= now && now - Number(c.triggerAt) < COMMITMENT_GRACE_MS)
        .sort((a, b) => a.triggerAt - b.triggerAt)[0] || null;
}

// 单轮 tick 的墙钟预算：Workers scheduled 有 CPU/时长上限，串行遍历所有 pair 同步调 AI
//   （每个最长 180s）必然超时被杀 → 排后面的 pair 永不触发。给一个保守预算，超了就停，
//   靠轮转游标下轮接着处理（pairsCursor）。Cloudflare 免费版 CPU 上限较紧，取 25s。
const TICK_WALL_BUDGET_MS = 25_000;

// ⏱️ 云端主动的节奏必须和「糯叽机开着时」一模一样，中继不准自己再加限制：
//    - 计时档：单对冷却 = 用户设的间隔
//    - 真人模式：只看冲动值引擎（与手机端同一套，暖机期 / 刚发过的衰减都在引擎里），不另加冷却
//    旧码不管用户怎么设都硬卡 20 分钟（单对）+ 25 分钟（整台手机），已全部拿掉。
//    只留 1 分钟下限：手机端后台循环本来就每分钟评估一次，同时防重叠 tick 对同一对双发。
//    想少收由用户自己的「一段时间内最多几次」上限管。
const PAIR_MIN_GAP_MS = 60 * 1000;
function pairCooldownMs(rec) {
    if (rec?.mode === 'interval') return Math.max(PAIR_MIN_GAP_MS, intervalToMs(rec.interval, rec.intervalUnit));
    return PAIR_MIN_GAP_MS;
}
// 复用 pair 级的 lastFired 存储（合成 key），避免改三套 store 实现。
const INBOX_SLOT_USER = '_';
const INBOX_SLOT_CHAR = 'inbox';

// 🕰️ 陈旧注册保护：超过这么久没被手机端刷新过（updatedAt）的对，跳过生成。
//    滑窗/人设/记忆全是一周前的快照，硬生成出来必然「前文不搭」；且多半是用户早已不用的僵尸对。
const STALE_RECORD_MS = 7 * 24 * 60 * 60 * 1000;

// ⏱️ 可调检测间隔：cron 表达式固定每分钟触发（Workers 的 crons 不能读环境变量），
//    实际几分钟检测一次见 tickConfig.js（环境变量 > App 设置页写的 KV > 默认 5 分钟），
//    其余分钟直接跳过（只读一次缓存过的配置，零写入）。
export async function shouldRunTickNow(env, scheduledTime = Date.now()) {
    let n = DEFAULT_TICK_MINUTES;
    try { n = await readTickMinutes(env, await createKvStore(env), { useCache: true }); } catch { /* 用默认 */ }
    if (n <= 1) return true;
    const minuteOfEpoch = Math.floor(Number(scheduledTime) / 60_000);
    return minuteOfEpoch % n === 0;
}

export async function runProactiveTick(env) {
    // 本轮代表几分钟（随机「突然想到你」的每轮概率要按检测间隔放大，否则间隔调大后主动频率跟着变低）
    let tickMinutes = DEFAULT_TICK_MINUTES;
    try { tickMinutes = await readTickMinutes(env, await createKvStore(env), { useCache: true }); } catch { /* 用默认 */ }
    const proactive = await createProactiveStore(env);
    const outbox = await createOutboxStore(env);
    const sub = await createSubStore(env);
    const now = nowMs();
    const tickStart = Date.now();

    // 🔒 重入锁：Workers scheduled 无重入守卫，tick 超 60s 时下一轮 cron 会并发 → 同一 pair 双发双扣费。
    //    锁带 TTL，tick 崩溃也会自动释放。
    //    ⚠️ TTL 必须 ≥ 单 pair 最长耗时：tool-loop(≤25s 预算) + runGeneration(≤180s) + 余量 → 取 300s。
    //    （CAS claimFireIfStale 仍兜底防同一对双发，长锁是第二道防线 + 防多 pair 重叠空耗。）
    //
    // 💸 KV 写入额度：锁改成【懒抢】——只在真的要为某个 pair 生成之前才抢，空转轮次一次写都不发。
    //    旧版每轮开头 put 锁 + 结尾 delete 锁 + put 游标 = 3 次写/分钟 = 4320 次/天，
    //    直接吃穿 Cloudflare KV 免费版每天 1000 次写入额度，用户反馈「什么都没发额度就没了」。
    //    空转轮次（全部 pair 都在冷却 / 未命中）只读不写，读额度（10 万/天）绰绰有余。
    const TICK_LOCK_TTL_MS = 300_000;
    let lockHeld = false;      // 本轮是否已持有锁
    let lockDenied = false;    // 抢锁失败（别的 tick 正在生成）→ 本轮不再生成
    async function ensureTickLock() {
        if (lockHeld || lockDenied) return lockHeld;
        try {
            const got = await proactive.acquireTickLock?.(TICK_LOCK_TTL_MS);
            if (got === false) { lockDenied = true; return false; }
            lockHeld = true;
        } catch { lockHeld = true; /* 不支持锁的实现照旧跑 */ }
        return lockHeld;
    }

    try {

    const allPairs = await proactive.listEnabled();
    // 🔄 轮转游标：从上轮停下的位置接着处理，保证规模化时每个 pair 最终都轮到（防永远只处理前缀）。
    let startIdx = 0;
    try {
        const cur = await proactive.getTickCursor?.();
        if (typeof cur === 'number' && cur > 0) startIdx = cur % Math.max(1, allPairs.length);
    } catch { /* 不支持游标：从 0 开始 */ }
    const pairs = startIdx > 0 ? [...allPairs.slice(startIdx), ...allPairs.slice(0, startIdx)] : allPairs;
    let fired = 0;
    let processed = 0;

    // inbox 级暂停缓存：用户走线下剧情时手机端调 /proactive/pause，该 inbox 整个跳过本轮生成。
    // 同一 inbox 多对只查一次。
    const pauseCache = new Map();
    async function isInboxPaused(inboxId) {
        if (pauseCache.has(inboxId)) return pauseCache.get(inboxId);
        let paused = false;
        try { paused = (await proactive.getPausedUntil(inboxId)) > now; } catch { paused = false; }
        pauseCache.set(inboxId, paused);
        return paused;
    }

    for (const rec of pairs) {
        // ⏱️ 墙钟预算：超了就停，剩余 pair 留到下轮（游标已记到 processed 位置）。
        if (Date.now() - tickStart > TICK_WALL_BUDGET_MS) {
            console.warn(`[proactive] tick 墙钟预算用尽，本轮处理 ${processed}/${pairs.length}，剩余下轮继续`);
            break;
        }
        processed++;
        try {
            // 走线下剧情中：跳过该 inbox 的所有主动生成（用户在前台沉浸剧情，不该被线上消息打断）
            if (await isInboxPaused(rec.inboxId)) continue;

            // 🕰️ 陈旧对：手机端已很久没刷新过它（换机/卸载/关了开关但注销请求丢了）→ 不拿老上下文硬发。
            if (rec.updatedAt && (now - rec.updatedAt) > STALE_RECORD_MS) {
                console.warn(`[proactive] 跳过陈旧注册 ${rec.userId}/${rec.charId}（${Math.round((now - rec.updatedAt) / 86400000)} 天未刷新）`);
                continue;
            }

            // 后端冷却（快照早跳过，省掉后面 verdict/记忆/工具的开销）：用 listEnabled 拍的快照先粗筛。
            //    ⚠️ 这只是早跳过，不是权威判定——快照可能过期（两轮重叠 cron 都拍到旧值），
            //    权威判定在生成前用 claimFireIfStale 做 CAS（见下）。
            // ⏰ 承诺到点：最高优先，不看冷却 / 冲动值 / inbox 节流（答应好的事必须兑现）
            let commit = dueCommitment(rec, now);
            // 🌦️ 天氣突變：早上到點查一次預報，有特別的天氣才算一條（同一 inbox 一天一位角色）
            if (!commit && rec.weatherWatch) {
                try { commit = await weatherOccasion(rec, now); } catch { commit = null; }
            }
            const cooldownMs = pairCooldownMs(rec);
            if (!commit && rec.lastFiredAt && (now - rec.lastFiredAt) < cooldownMs) continue;
            // 🔢 用户设的「一段时间内最多主动几次」：窗口内已发满 → 不管冲动值 / 承诺，先憋着
            if (isSendCapReached(rec, now)) continue;

            // 两种触发档：'impulse'(真人模式) / 'interval'(普通后台主动，计时+概率高中低)
            let verdict;
            if (commit) {
                verdict = { fire: true, reason: commit.reason || 'commitment due' };
            } else if (rec.mode === 'interval') {
                verdict = shouldFireInterval({
                    now, lastFiredAt: rec.lastFiredAt || 0,
                    interval: rec.interval, intervalUnit: rec.intervalUnit, probability: rec.probability,
                    // 从未触发过时的基线（防「一注册就开火」）
                    enabledAt: rec.proactiveEnabledAt || rec.updatedAt || 0,
                    // 最后一条对话时间：正在聊天时不按计时开火（见 shouldFireInterval）
                    lastInteractionAt: rec.lastInteractionAt || 0,
                    // 安静时段（与 impulse 档同一份 quietHours；小时按用户/角色时区算，绝不用服务器时区）
                    quietHours: rec.quietHours || rec.proactiveProfile?.quietHours || null,
                    hour: resolveLocalHour({
                        now,
                        charUtcOffsetSeconds: rec.charUtcOffsetSeconds ?? null,
                        userUtcOffsetSeconds: (typeof rec.timeSpec?.userUtcOffsetSeconds === 'number')
                            ? rec.timeSpec.userUtcOffsetSeconds : null,
                    }),
                });
            } else {
                verdict = shouldFire({
                    profile: rec.proactiveProfile,
                    lifeState: rec.lifeState,
                    now,
                    lastInteractionAt: rec.lastInteractionAt || 0,
                    scheduleCtx: null, // 设备专属，后端无
                    intensity: rec.intensity || 'normal',
                    unansweredStreak: (rec.lifeState && rec.lifeState.unansweredStreak) || 0,
                    proactiveEnabledAt: rec.proactiveEnabledAt || 0,
                    proactiveBias: rec.proactiveBias || 0,
                    tickMs: tickMinutes * 60_000,
                    userActiveAt: 0, // 设备专属信号，后端默认 0
                    charUtcOffsetSeconds: rec.charUtcOffsetSeconds ?? null,
                    // 🕒 用户设备时区(秒)：非异地时用它算小时，绝不退回服务器时区。
                    userUtcOffsetSeconds: (typeof rec.timeSpec?.userUtcOffsetSeconds === 'number')
                        ? rec.timeSpec.userUtcOffsetSeconds : null,
                });
            }

            if (!verdict.fire) continue;

            // 🔒 权威条件抢占（CAS）：在【生成之前】新读一次 lastFiredAt，仍在冷却外才抢。
            //    防三种重复:①旧码生成后才写→慢生成期间下轮重发(claimFire 生成前写已解决)
            //    ②sync-messages 整条 patch 覆盖抢槽(拆独立 pf: key 已解决)
            //    ③两轮重叠 cron 各拍 tick 开头快照都过冷却闸→同一对双发(本 CAS 解决:第二轮新读到
            //      第一轮刚抢的值→claimFireIfStale 返回 false→跳过)。
            //    写独立 key，不走 patch(整条 blob)，否则会被 sync 覆盖。
            // 🔒 真要生成了才抢重入锁（懒抢，见上）。抢不到=别的 tick 在跑 → 本轮到此为止，交给它。
            if (!(await ensureTickLock())) {
                console.warn('[proactive] 另一轮 tick 正在生成，本轮跳过剩余 pair');
                break;
            }
            if (commit) {
                const once = await proactive.claimFireIfStale(
                    rec.inboxId, rec.userId, commitmentSlot(rec.charId, commit.id), now, COMMITMENT_ONCE_MS
                );
                if (!once) continue; // 这条承诺已经触发过
                // 同一组（同一个节日 / 同一天的天气）：这个 inbox 只让第一位角色开口，其他人这条直接作废
                if (commit.group) {
                    const groupOnce = await proactive.claimFireIfStale(
                        rec.inboxId, INBOX_SLOT_USER, `grp:${commit.group}`, now, COMMITMENT_ONCE_MS
                    );
                    if (!groupOnce) {
                        await proactive.patch(rec.inboxId, rec.userId, rec.charId, {
                            commitments: (rec.commitments || []).filter(c => c.id !== commit.id),
                        });
                        continue;
                    }
                }
                try { await proactive.claimFire(rec.inboxId, rec.userId, rec.charId, now); } catch { /* ignore */ }
            } else {
                const claimed = await proactive.claimFireIfStale(
                    rec.inboxId, rec.userId, rec.charId, now, cooldownMs
                );
                if (!claimed) continue; // 别的 tick 刚抢了这一对 → 跳过，绝不双发
            }

            // 命中 → 实时生成。messages 只有一条 system（手机端拼好的完整 prompt + 填充滑窗）
            let transcript = renderTranscript(rec.recentMessages, rec.timeSpec);
            // 🧠 直连第三方记忆 MCP 检索（关软件也能用最新记忆）；失败/无配置 → 空串不阻断生成。
            let memory = '';
            try {
                memory = await buildMemoryContext(
                    rec.mcpContextServers,
                    rec.recentMessages,
                    { userId: rec.userId, characterId: rec.charId }
                );
            } catch (e) {
                console.warn('[proactive] memory context failed:', e?.message);
            }
            // 🛠️ 主动用工具（action-mode MCP tool-loop）：用户开了 mcpProactiveToolUse 时，角色主动开口前
            //    先决策是否调工具（搜热搜/新闻等），把素材拼进转录。受 tick 墙钟预算约束（deadline 到点即停），
            //    失败静默降级不挡生成。与手机端 prefetchMcpToolResults(proactiveMode) 同语义。
            if (rec.mcpProactiveToolUse && Array.isArray(rec.mcpToolServers) && rec.mcpToolServers.length) {
                try {
                    const enrichment = await runProactiveToolLoop(
                        rec.mcpToolServers, rec.recentMessages, rec.aiSettings,
                        { userId: rec.userId, characterId: rec.charId, deadline: tickStart + TICK_WALL_BUDGET_MS }
                    );
                    if (enrichment) transcript = transcript + enrichment;
                } catch (e) {
                    console.warn('[proactive] tool loop failed:', e?.message);
                }
            }
            // 先填即时真时间哨兵（§NOW_*§），再填滑窗/理由/记忆占位符。
            const timedTemplate = renderTimeTokens(rec.promptTemplate, rec.timeSpec, now, rec.lastInteractionAt || 0);
            // 🎲 隨機槽（隨機心聲預設 / 預設隨機頭部）：每次生成各抽一段，抽中哪段隨 outbox 帶回手機
            const { text: slotted, picks: randomPicks } = renderRandomSlots(timedTemplate, rec.randomSlots, rec.lastRandomPicks);
            let systemContent = fillTemplate(slotted, { transcript, reason: verdict.reason, memory });
            // ⏰ 承诺到点：追加手机端拼好的「到点兑现」指令段（与本地后台主动同一份措辞）
            if (commit?.block) systemContent += `\n\n${renderTimeTokens(commit.block, rec.timeSpec, now, rec.lastInteractionAt || 0)}`;
            // ⚠️ 必须追加一条 user 占位（与 APP 本地路径 useAIRespond.js 的「请开始回复。」对齐）：
            //    只有 system 一条时，OpenAI/Claude 能跑，但走 gemini 反代（OpenAI→Gemini 转译）时
            //    system 会被塞进 systemInstruction、不进 contents，导致 contents 为空 → 代理报
            //    「contents is required」500。补一条 user 让 contents 非空，四种 apiType 行为一致。
            const messages = [
                { role: 'system', content: systemContent },
                { role: 'user', content: '请开始回复。' },
            ];

            let content = null, reasoning = null, error = null;
            try {
                ({ content, reasoning } = await runGeneration(rec.aiSettings, messages, rec.aiSettings?.maxTokens || null));
            } catch (e) {
                error = String(e?.message || e);
            }

            // 生成失败：设「短冷却」——还剩 min(5 分钟, 该对冷却) 就放行，
            //    API 持续报错时不会每轮都重试烧钱，也不让用户白等一整个间隔。
            //    失败不入 outbox（手机端对 error item 一律丢弃）、不发推送、不推进 lifeState/streak。
            if (error) {
                const failMark = now - (cooldownMs - Math.min(BACKEND_FAIL_COOLDOWN_MS, cooldownMs));
                await proactive.claimFire(rec.inboxId, rec.userId, rec.charId, failMark);
                console.warn('[proactive] generation failed, short cooldown 5min:', error);
                continue;
            }

            const requestId = `proactive_${rec.userId}_${rec.charId}_${now}`;
            const item = {
                id: `relay_${requestId}`, requestId,
                charId: rec.charId, userId: rec.userId,
                roundId: requestId, content, reasoning: reasoning || null, error, createdAt: nowMs(),
                proactive: true,
                // 生成时滑窗里最新一条消息的时间：手机排水时若本地已有比这更新的对话
                //（滑窗同步节流没赶上），说明这条是拿旧上下文写的，会和前台回复重复 → 手机端丢弃。
                basisAt: windowLatestAt(rec.recentMessages) || null,
                ...(commit ? { commitmentId: commit.id } : {}),
                ...(Object.keys(randomPicks).length ? { randomPicks } : {}),
            };
            // 模型判定承诺已取消 / 已完成 → 仍入 outbox（手机据此把承诺标掉），但不推送、不转发、不进滑窗
            const skippedCommit = !!commit && SKIP_COMMITMENT_RE.test(String(content || ''));
            // 💬 连了微信 / iMessage 且开了「主动消息也发过去」→ 同一条也发过去。
            //    先发再入 outbox 并标 mirroredTo：手机排水看到「用户在微信已经收到了」就照写不丢
            //   （否则手机判定上下文过时丢弃 → 微信有、糯叽机没有）。
            //    动态载入：聊天桥接核心会用到本文件的 renderTranscript，静态 import 会形成循环依赖
            let mirroredTo = [];
            if (!skippedCommit) {
                try {
                    const { mirrorProactiveToWechat } = await import('../wechat/routes.js');
                    mirroredTo = (await mirrorProactiveToWechat(env, { inboxId: rec.inboxId, userId: rec.userId, charId: rec.charId, content })) || [];
                } catch (e) { console.warn('[proactive] chat bridge mirror failed:', e?.message); }
            }
            await outbox.put(rec.inboxId, mirroredTo.length ? { ...item, mirroredTo } : item);
            if (skippedCommit) {
                await proactive.patch(rec.inboxId, rec.userId, rec.charId, {
                    commitments: (rec.commitments || []).filter(c => c.id !== commit.id),
                });
                continue;
            }

            // 🔑 把 char 自己刚发的消息追加进后端滑窗，否则 user 一直不回复时，下次 tick 用的
            //    还是同一份旧上下文 → AI 看不到自己发过什么 → 反复说类似的话 = 重复消息。
            //    手机端排水后会异步 sync 覆盖这份（带完整字段），这里只是保证「自己发的」立刻进上下文。
            //    用 extractPushBodies 拆成每个气泡一条（与推送/手机端入库口径一致，过滤隐藏类型）。
            let nextWindow = Array.isArray(rec.recentMessages) ? rec.recentMessages : [];
            if (content) {
                const selfBubbles = extractPushBodies(content)
                    .filter(b => b && b !== '有新消息' && b !== '有新消息，点开查看')
                    .map(text => ({ sender: 'char', text }));
                if (selfBubbles.length) {
                    nextWindow = [...nextWindow, ...selfBubbles].slice(-PROACTIVE_WINDOW_CAP);
                }
            }

            // 简单更新后端 lifeState（完整 evolve 仍在手机端，下次 sync 覆盖）
            // lastFiredAt 已在生成前抢占落库，这里不再重复设。
            const ls = rec.lifeState || {};
            // 📈 自增「连续未回复」：后端自己发了一条而 user 没回（user 回了的话手机端 sync 会把
            //    streak 清 0 并覆盖整份 lifeState）。streak 是真人模式防轰炸的核心闸门
            //    （>=streakHardCap 硬跳过 + 每级降低 impulse 分），后端不自增 → 闸门永远失效 →
            //    user 一直不回时反复主动 = 重复消息。仅 impulse 模式自增（interval 模式不看 streak）。
            const prevStreak = (ls.unansweredStreak || 0);
            const nextStreak = (rec.mode === 'interval') ? prevStreak : prevStreak + 1;
            await proactive.patch(rec.inboxId, rec.userId, rec.charId, {
                ...(commit ? { commitments: (rec.commitments || []).filter(c => c.id !== commit.id) } : {}),
                lifeState: { ...ls, lastImpulseAt: now, lastProactiveSentAt: now, unansweredStreak: nextStreak },
                recentMessages: nextWindow,
                // 🕒 自己刚发完 → lastInteractionAt 也推进到现在，否则「距上次多久」一直从旧时间算，
                //    下次 tick 会以为隔了很久（其实自己刚发过）→ 误触发频繁主动 / since 文本失真。
                lastInteractionAt: now,
                ...(nextCapSends(rec, now) ? { capSends: nextCapSends(rec, now) } : {}),
                ...(Object.keys(randomPicks).length ? { lastRandomPicks: { ...(rec.lastRandomPicks || {}), ...randomPicks } } : {}),
            });

            // 发推送叫醒——像微信那样【逐条气泡分开弹 + 带消息内容 + 角色名标题】，
            // 与 /generate 路径一致（extractPushBodies 把 AI 的 JSON-Lines 拆成每个气泡一条文本）。
            // ⚠️ 生成失败（502 等）不发推送：手机端排水对 error item 一律丢弃不写气泡，
            //    若仍弹通知 → 用户点进聊天却没有消息 = 假通知。失败静默，等下次 tick 重试。
            if (!error) try {
                const subs = await sub.list(rec.inboxId);
                if (subs.length) {
                    const title = rec.timeSpec?.charName || '糯叽机';
                    // 🔒 通知隐私模式：正文换「你有一条新消息」，标题(角色名)/头像保留。仍逐气泡发以保持节奏一致。
                    // H5：封顶推送条数。气泡数 × 订阅数 = 子请求数，超 Workers 上限(50/1000)后 fetch 抛错
                    //   被吞 → 静默丢推送。封顶最多 8 条气泡（消息正文不受影响，已全在 outbox），防超限。
                    const rawBodies = rec.notifPrivacy
                        ? extractPushBodies(content).map(() => '你有一条新消息')
                        : extractPushBodies(content);
                    const bodies = rawBodies.slice(0, 8);
                    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                    let i = 0;
                    for (const body of bodies) {
                        // 逐条之间加真人节奏延迟（按字数估打字时长），第一条立即发。封顶防 Worker 超时。
                        if (i > 0) {
                            const delay = Math.min(4000, 600 + (body?.length || 0) * 120);
                            await sleep(delay);
                        }
                        const payload = {
                            title, body, charId: rec.charId, userId: rec.userId, kind: 'relay-outbox',
                            // 🖼️ iOS 通知扩展用：头像 URL + 发信人名 + 会话 id → Communication Notification 左侧头像
                            avatarUrl: rec.avatarUrl || null,
                            senderName: title,
                            conversationId: `${rec.userId}_${rec.charId}`,
                            mutableContent: true,
                        };
                        for (const s of subs) {
                            const res = await dispatchPush(env, s, payload);
                            if (res?.gone) await sub.remove(rec.inboxId, s);
                        }
                        i++;
                    }
                }
            } catch (e) { console.warn('[proactive] push failed:', e?.message); }

            fired++;
        } catch (e) {
            console.warn('[proactive] pair tick failed:', e?.message);
        }
    }

    // 🔄 保存轮转游标到「本轮处理到的绝对位置」，下轮从这接着扫（防总处理前缀、后面 pair 饿死）。
    // 💸 只在游标真的变了才写：整轮跑完（processed === 全部）时 nextCursor === startIdx，不写，省 KV 写额度。
    try {
        const nextCursor = allPairs.length ? (startIdx + processed) % allPairs.length : 0;
        if (nextCursor !== startIdx) await proactive.setTickCursor?.(nextCursor);
    } catch { /* 不支持游标：忽略 */ }

    return { pairs: pairs.length, processed, fired };

    } finally {
        // 释放重入锁（即使中途抛错也释放，避免锁残留挡住后续 tick；TTL 是二重保险）。
        // 没抢过锁（空转轮）就不 delete —— delete 也算一次 KV 写入。
        if (lockHeld) { try { await proactive.releaseTickLock?.(); } catch { /* ignore */ } }
    }
}