// 后台朋友圈 —— 定时发帖（与主动消息共用 cron 与「检测间隔」设置，各自独立预算）
//
// 每个 inbox（= 一台手机的一个用户）一条节律：
//   平均每 intervalMin 分钟发一条（±40% 抖动）、用户当地静默时段不发、每天最多 maxPerDay 条。
//   到点从角色清单里挑一位（尽量不连着同一位），取 App 拼好的发帖 messages，只填时间哨兵 → 调 AI
//   → 结果放进待领取列表（7 天）→ 推送。解析 / 配图 / 存档全在手机端排水时做（和手动生成同一套）。
// 后端零话术：推送标题 / 隐私文案都由 App 随注册带来。

import { createKvStore } from '../store/kvStore.js';
import { createSubStore } from '../store/subStore.js';
import { createMomentsStore } from './momentsStore.js';
import { runGeneration } from '../ai/aiCaller.js';
import { dispatchPush } from '../push/pushSender.js';
import { renderTimeTokens } from '../util/timeTokens.js';

const TICK_BUDGET_MS = 25_000;
const STALE_CONFIG_MS = 3 * 24 * 60 * 60 * 1000;   // 手机 3 天没同步过 → 快照太旧，先不发
const FAIL_RETRY_MS = 15 * 60 * 1000;

const jitterMs = (minutes) => Math.round(minutes * 60_000 * (0.6 + Math.random() * 0.8));

/** 用户当地时间（App 带来的 UTC 偏移秒；没带用服务器时间） */
function localClock(now, offsetSec) {
    const d = new Date(now + (Number.isFinite(offsetSec) ? offsetSec * 1000 : 0));
    const useUtc = Number.isFinite(offsetSec);
    return {
        hour: useUtc ? d.getUTCHours() : d.getHours(),
        minute: useUtc ? d.getUTCMinutes() : d.getMinutes(),
        dayKey: useUtc ? d.toISOString().slice(0, 10) : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`,
    };
}

export function inQuietHours(hour, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
    return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/** 离现在最近的「当地 hh:00」还有多少毫秒（静默结束 / 明天凌晨用） */
function msUntilLocalHour(now, offsetSec, targetHour) {
    const { hour, minute } = localClock(now, offsetSec);
    let hours = targetHour - hour;
    if (hours <= 0) hours += 24;
    return hours * 3600_000 - minute * 60_000;
}

/** 推送正文：取 AI 回的 JSON 数组第一条的 text（解析失败回 App 给的兜底文案） */
export function firstPostText(content) {
    const s = String(content || '');
    const m = s.match(/\[[\s\S]*\]/);
    if (!m) return '';
    try {
        const arr = JSON.parse(m[0]);
        const first = Array.isArray(arr) ? arr.find(x => x && (x.text || x.content)) : null;
        return String(first?.text || first?.content || '').trim();
    } catch { return ''; }
}

export async function runMomentsTick(env) {
    const kv = await createKvStore(env);
    const store = createMomentsStore(kv);
    const inboxes = await store.listInboxes();
    if (!inboxes.length) return { inboxes: 0, posted: 0 };
    const sub = await createSubStore(env);
    const start = Date.now();
    let posted = 0;

    for (const inbox of inboxes) {
        if (Date.now() - start > TICK_BUDGET_MS) break;
        try {
            const cfg = await store.getConfig(inbox);
            if (!cfg?.enabled || !Array.isArray(cfg.chars) || cfg.chars.length === 0) continue;
            const now = Date.now();
            if (now - (cfg.updatedAt || 0) > STALE_CONFIG_MS) continue;
            const interval = Math.max(10, Number(cfg.intervalMin) || 90);
            const st = await store.getState(inbox);

            // 第一次：只排下一次时间（不立刻发，免得一开就刷屏）
            if (!st.nextAt) { await store.putState(inbox, { ...st, nextAt: now + jitterMs(interval) }); continue; }
            if (now < st.nextAt) continue;

            const off = cfg.userUtcOffsetSeconds;
            const { hour, dayKey } = localClock(now, off);
            if (inQuietHours(hour, cfg.quietStart, cfg.quietEnd)) {
                await store.putState(inbox, { ...st, nextAt: now + msUntilLocalHour(now, off, cfg.quietEnd) + jitterMs(20) });
                continue;
            }
            const todayCount = st.dayKey === dayKey ? (st.dayCount || 0) : 0;
            const maxPerDay = Number(cfg.maxPerDay) || 0;
            if (maxPerDay > 0 && todayCount >= maxPerDay) {
                await store.putState(inbox, { ...st, nextAt: now + msUntilLocalHour(now, off, 0) + jitterMs(30) });
                continue;
            }

            // 挑角色：不连着同一位
            const pool = cfg.chars.length > 1 ? cfg.chars.filter(c => String(c.charId) !== String(st.lastCharId)) : cfg.chars;
            const char = pool[Math.floor(Math.random() * pool.length)];
            const tpl = await store.getTemplate(inbox, char.charId);
            if (!Array.isArray(tpl) || tpl.length === 0) {
                await store.putState(inbox, { ...st, nextAt: now + FAIL_RETRY_MS });
                continue;
            }

            // 先占位再生成：同一轮 cron 重叠时不会同一条发两次
            const claimed = { ...st, nextAt: now + jitterMs(interval), lastPostAt: now, lastCharId: char.charId, dayKey, dayCount: todayCount + 1 };
            await store.putState(inbox, claimed);

            const messages = tpl.map(m => (m && m.role === 'system' && typeof m.content === 'string')
                ? { ...m, content: renderTimeTokens(m.content, char.timeSpec || null, now, 0) }
                : m);
            let content = '';
            try {
                ({ content } = await runGeneration(cfg.aiSettings, messages, cfg.aiSettings?.maxTokens || null));
            } catch (e) {
                console.warn('[moments] generation failed:', e?.message);
            }
            if (!content || !String(content).trim()) {
                // 失败：退回今天的计数，15 分钟后再试（不推送、不入列）
                await store.putState(inbox, { ...claimed, dayCount: todayCount, nextAt: now + FAIL_RETRY_MS });
                continue;
            }

            const item = { id: `mo_${cfg.userId}_${char.charId}_${now}`, userId: String(cfg.userId), charId: String(char.charId), content, createdAt: now };
            await store.addPending(inbox, item);
            posted++;

            try {
                const subs = await sub.list(inbox);
                if (subs.length) {
                    const title = String(cfg.pushTitle || '{name}').replaceAll('{name}', char.name || '');
                    const body = cfg.notifPrivacy
                        ? String(cfg.pushPrivacyBody || '')
                        : (firstPostText(content) || String(cfg.pushFallbackBody || ''));
                    const payload = {
                        // 不帶 charId：通知點開會直接跳那位角色的聊天，朋友圈不該這樣；只回到 App，回前台自然排水領取
                        title, body, userId: String(cfg.userId), kind: 'relay-moment',
                        avatarUrl: char.avatarUrl || null, senderName: char.name || '', mutableContent: true,
                    };
                    for (const s of subs) {
                        const res = await dispatchPush(env, s, payload);
                        if (res?.gone) await sub.remove(inbox, s);
                    }
                }
            } catch (e) { console.warn('[moments] push failed:', e?.message); }
        } catch (e) {
            console.warn('[moments] inbox tick failed:', e?.message);
        }
    }
    return { inboxes: inboxes.length, posted };
}
