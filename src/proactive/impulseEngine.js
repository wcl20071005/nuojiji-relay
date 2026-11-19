// 主动消息「冲动值」引擎 —— 从糯叽机 APP 的 src/utils/proactiveMessagingEngine.js 端口。
//
// ⚠️ 与 nuojiji APP 的 proactiveMessagingEngine.js 保持同步：
//    calculateImpulse / INTENSITY_PRESETS / getIntensityPreset / isQuietHour /
//    timeOfDayScore / calculateScheduleEffect / 安全窗助手。
//    APP 那边改了任意因子/权重，这里要跟着改，否则后端主动决策与手机端不一致。
//
// 🔒 提示词保护：本文件只有**纯数值算法**，无任何提示词/话术。这是有意为之
//    (用户接受数值逻辑公开，但提示词文本/构建逻辑绝不进开源仓库)。

// ===== 主动度档位 =====
export const INTENSITY_PRESETS = {
    low: { streakHardCap: 1, streakPenaltyPerStep: 0.25, chitchatCooldownHours: 3, longSilenceDecay: true },
    normal: { streakHardCap: 2, streakPenaltyPerStep: 0.15, chitchatCooldownHours: 1.5, longSilenceDecay: true },
    high: { streakHardCap: 3, streakPenaltyPerStep: 0.08, chitchatCooldownHours: 0.5, longSilenceDecay: false },
};
export function getIntensityPreset(intensity) {
    return INTENSITY_PRESETS[intensity] || INTENSITY_PRESETS.normal;
}

export const PROACTIVE_WARMUP_MS = 30 * 60 * 1000;
export const PROACTIVE_SAFETY_FLOOR_MS = 6 * 3600 * 1000;

// 缺 profile 时的兜底（normal 档默认值，与 deriveProactiveProfile 的 normal preset 对齐）
const DEFAULT_PROFILE = {
    archetype: 'normal',
    weights: { silence: 0.5, timeOfDay: 0.2, mood: 0.3, pendingQuestion: 0.5, randomLife: 0.4 },
    silenceSaturationHours: 12,
    quietHours: [23, 8],
    threshold: 0.55,
    randomLifeChancePerDay: 3,
};

export function isQuietHour(hour, quietHours) {
    if (!Array.isArray(quietHours) || quietHours.length !== 2) return false;
    const [start, end] = quietHours;
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
}

function timeOfDayScore(hour, quietHours) {
    if (isQuietHour(hour, quietHours)) return 0.05;
    const peak1 = Math.exp(-Math.pow((hour - 13) / 3, 2));
    const peak2 = Math.exp(-Math.pow((hour - 21) / 3, 2));
    return Math.min(1, 0.4 + 0.6 * Math.max(peak1, peak2));
}

function isInSafetyFloor({ lifeState, lastInteractionAt, now, quietHours, hour }) {
    if (isQuietHour(hour, quietHours)) return false;
    const lastImpulseAt = (lifeState && lifeState.lastImpulseAt) || 0;
    const lastSignal = Math.max(lastImpulseAt, lastInteractionAt || 0);
    if (!lastSignal) return true;
    return (now - lastSignal) > PROACTIVE_SAFETY_FLOOR_MS;
}

// 后端无日历/schedule 上下文（设备专属信号）→ scheduleCtx 恒为 null，calculateScheduleEffect 返回中性值。
// 保留函数形态以与手机端对齐；如未来同步 schedule 快照可填充。
function calculateScheduleEffect(actCtx) {
    const factors = {};
    if (!actCtx) return { multiplier: 1, addBonus: 0, factors, hardSkip: false, reason: 'no schedule' };
    // 后端暂不接收 schedule 快照，走中性分支
    return { multiplier: 1, addBonus: 0, factors, hardSkip: false, reason: 'no schedule (backend)' };
}

/**
 * 🕒 算「现在是用户/角色那边几点」。规则同 calculateImpulse 内联版：
 *   异地角色 → 角色当地；否则用户设备时区；两者皆无才不得已用服务器时区。
 *   抽出来给 interval 档（普通后台主动）复用安静时段判定。
 */
export function resolveLocalHour({ now, charUtcOffsetSeconds = null, userUtcOffsetSeconds = null }) {
    const charOff = (typeof charUtcOffsetSeconds === 'number') ? charUtcOffsetSeconds : null;
    const userOff = (typeof userUtcOffsetSeconds === 'number') ? userUtcOffsetSeconds : null;
    const off = charOff != null ? charOff : userOff;
    return (off != null) ? new Date(now + off * 1000).getUTCHours() : new Date(now).getHours();
}

/**
 * 算某对「想主动找用户」的冲动值（0..1）。纯函数，不打 API。
 * 与 proactiveMessagingEngine.calculateImpulse 同签名同算法。
 */
export function calculateImpulse({
    profile, lifeState, now, lastInteractionAt, scheduleCtx, intensity,
    unansweredStreak = 0, proactiveEnabledAt = 0, proactiveBias = 0,
    userActiveAt = 0, charUtcOffsetSeconds = null, userUtcOffsetSeconds = null,
    tickMs = 60 * 1000,
}) {
    const p = profile || DEFAULT_PROFILE;
    const w = p.weights || {};
    const intensityPreset = getIntensityPreset(intensity);
    const factors = {};
    let score = 0;

    // 🕒 算「现在几点」永远以用户手机时区为基准，绝不退回服务器时区：
    //   · 异地角色(charOff 有) → 用 charOff 算角色当地小时。
    //   · 非异地(charOff=null) → 用 userOff(用户设备时区)。
    //   · 两者都没有(极旧手机端没传) 才不得已用服务器时区(尽力兜底)。
    //   中继服务器跑在外地/UTC，用服务器时区会把安静时段/该不该发判全乱。
    const charOff = (typeof charUtcOffsetSeconds === 'number') ? charUtcOffsetSeconds : null;
    const userOff = (typeof userUtcOffsetSeconds === 'number') ? userUtcOffsetSeconds : null;
    const effectiveOff = charOff != null ? charOff : userOff;
    const hour = (effectiveOff != null)
        ? new Date(now + effectiveOff * 1000).getUTCHours()
        : new Date(now).getHours();
    const safetyFloorActive = isInSafetyFloor({ lifeState, lastInteractionAt, now, quietHours: p.quietHours, hour });

    const sched = calculateScheduleEffect(scheduleCtx);
    if (sched.hardSkip && !safetyFloorActive) {
        return {
            score: 0, factors: { ...sched.factors, scheduleReason: sched.reason },
            reason: `[schedule hard skip] ${sched.reason}`,
            threshold: (typeof p.threshold === 'number') ? p.threshold : 0.55, hardSkip: true,
        };
    }

    if (unansweredStreak >= intensityPreset.streakHardCap && !safetyFloorActive) {
        return {
            score: 0, factors: { unansweredStreak, streakHardCap: intensityPreset.streakHardCap },
            reason: `[streak hard skip] ${unansweredStreak} unanswered (cap ${intensityPreset.streakHardCap})`,
            threshold: (typeof p.threshold === 'number') ? p.threshold : 0.55, hardSkip: true,
        };
    }

    // 1. 沉默时长（倒 U）
    const silenceHours = lastInteractionAt ? (now - lastInteractionAt) / 3600000 : 24;
    const sat = Math.max(0.5, p.silenceSaturationHours || 12);
    const ratio = silenceHours / sat;
    let silence;
    if (ratio <= 1) silence = ratio;
    else if (ratio <= 2) silence = 1;
    else if (intensityPreset.longSilenceDecay) silence = Math.max(0.2, 1 - (ratio - 2) * 0.2);
    else silence = 1;
    factors.silence = silence;
    score += silence * (w.silence || 0);

    // 2. 时段适宜度
    const tod = timeOfDayScore(hour, p.quietHours);
    factors.timeOfDay = tod;
    score += tod * (w.timeOfDay || 0);

    // 3. 心情强度
    const moodIntensity = (lifeState && typeof lifeState.moodIntensity === 'number') ? lifeState.moodIntensity : 0.3;
    factors.mood = moodIntensity;
    score += moodIntensity * (w.mood || 0);

    // 3.5 用户在线但没理（userActiveAt 是注册快照，可能为 0 → 不触发，可接受）
    let userActiveButQuiet = 0;
    if (userActiveAt > 0 && lastInteractionAt > 0) {
        const userIdleMin = (now - userActiveAt) / 60000;
        const charIdleMin = (now - lastInteractionAt) / 60000;
        if (userIdleMin >= 0 && userIdleMin < 5 && charIdleMin >= 30) {
            userActiveButQuiet = Math.max(0, 1 - userIdleMin / 5);
        }
    }
    factors.userActiveButQuiet = userActiveButQuiet;
    if (userActiveButQuiet > 0) score += userActiveButQuiet * (w.silence || 0) * 0.4;

    // 4. 未回问题
    const pendingQuestion = !!(lifeState && lifeState.pendingUserQuestion);
    factors.pendingQuestion = pendingQuestion ? 1 : 0;
    if (pendingQuestion) score += (w.pendingQuestion || 0);

    // 5. 随机「突然想到你」—— 每轮概率按本轮代表的时长（检测间隔，默认 60s）估算
    const rndChancePerDay = p.randomLifeChancePerDay || 0;
    const TICK_MS = Number(tickMs) > 0 ? Number(tickMs) : 60 * 1000;
    const WAKING_MS_PER_DAY = 16 * 3600 * 1000;
    if (rndChancePerDay > 0 && !isQuietHour(hour, p.quietHours)) {
        const pTick = rndChancePerDay * TICK_MS / WAKING_MS_PER_DAY;
        if (Math.random() < pTick) { factors.randomLife = 1; score += (w.randomLife || 0); }
        else factors.randomLife = 0;
    } else {
        factors.randomLife = 0;
    }

    // 6. 上次 skip 衰减
    if (lifeState && lifeState.lastSkipAt) {
        const skipAgeHours = (now - lifeState.lastSkipAt) / 3600000;
        if (skipAgeHours < 6) {
            const decay = 1 - (skipAgeHours / 6);
            factors.recentSkipDecay = -decay * 0.25;
            score -= decay * 0.25;
        }
    }

    // 7. 刚发过的 soft damping
    if (lifeState && lifeState.lastProactiveSentAt) {
        const sentAgoMin = (now - lifeState.lastProactiveSentAt) / 60000;
        let damp = 0;
        if (sentAgoMin < 5) damp = -0.4;
        else if (sentAgoMin < 15) damp = -0.25;
        else if (sentAgoMin < 30) damp = -0.12;
        if (damp !== 0) { factors.recentSendDamping = damp; score += damp; }
    }

    // schedule 乘数/加成（后端中性）
    if (sched.multiplier !== 1) score *= sched.multiplier;
    score += sched.addBonus;
    Object.assign(factors, sched.factors);
    factors.scheduleReason = sched.reason;

    // 8. 连发惩罚
    if (unansweredStreak > 0) {
        const penalty = unansweredStreak * intensityPreset.streakPenaltyPerStep;
        factors.streakPenalty = -penalty;
        factors.unansweredStreak = unansweredStreak;
        score -= penalty;
    }

    score = Math.max(0, Math.min(1, score));
    let threshold = (typeof p.threshold === 'number') ? p.threshold : 0.55;

    if (typeof proactiveBias === 'number' && proactiveBias !== 0) {
        threshold = Math.max(0.15, Math.min(0.95, threshold - proactiveBias));
        factors.userBias = proactiveBias;
    }

    if (safetyFloorActive) {
        threshold = Math.max(0.3, threshold - 0.2);
        factors.safetyFloor = true;
    }

    if (proactiveEnabledAt && (now - proactiveEnabledAt) < PROACTIVE_WARMUP_MS) {
        threshold = Math.min(0.95, threshold + 0.25);
        factors.warmupActive = true;
    }

    const cooldownUntil = lifeState && lifeState.chitchatCooldownUntil;
    if (cooldownUntil && now < cooldownUntil) {
        const hasBypassSignal =
            (factors.mood >= 0.6) || (factors.randomLife === 1) ||
            (factors.justFinished && factors.justFinished > 0) || (factors.pendingQuestion === 1);
        factors.chitchatCooldownActive = true;
        if (!hasBypassSignal) {
            threshold = Math.min(0.95, threshold + 0.2);
            factors.chitchatCooldownThresholdBump = 0.2;
        } else {
            factors.chitchatCooldownBypassed = true;
        }
    }

    return { score, factors, reason: `score=${score.toFixed(2)} thr=${threshold.toFixed(2)}`, threshold };
}

/**
 * 便捷判定（真人模式 impulse 档）：是否应该发。返回 { fire:boolean, score, threshold, reason }。
 */
export function shouldFire(ctx) {
    const r = calculateImpulse(ctx);
    return { fire: !r.hardSkip && r.score >= r.threshold, ...r };
}

// ===== 普通后台主动档（interval + 概率高/中/低）=====
// 与 APP 的 backgroundActivityLogic.js 的 shouldCheckActivity + shouldCharacterAct 对齐。

const PROB_MAP = { high: 0.99, medium: 0.7, low: 0.4 };

function intervalToMs(interval, unit) {
    const n = Number(interval) || 60;
    switch (unit) {
        case 'seconds': return n * 1000;
        case 'hours': return n * 60 * 60 * 1000;
        case 'minutes': default: return n * 60 * 1000;
    }
}

/**
 * 普通档触发判定：距上次触发 >= interval 且概率 roll 通过。
 * @param {object} ctx { now, lastFiredAt, interval, intervalUnit, probability }
 * @returns {{fire:boolean, reason:string}}
 */
export function shouldFireInterval({
    now, lastFiredAt = 0, interval = 60, intervalUnit = 'minutes', probability = 'medium',
    enabledAt = 0, quietHours = null, hour = null, lastInteractionAt = 0,
}) {
    const intervalMs = intervalToMs(interval, intervalUnit);
    // ⏱️ 基线：优先上次触发；【从未触发过则用注册时间】。
    //    旧码 lastFiredAt=0 时直接跳到概率 roll → 注册那一刻（开总开关 / BAM 首轮刷新）就有
    //    70% 概率立刻开火，多个角色同时注册 = 一开开关就被一串主动消息刷屏（用户报「频率不正常」）。
    //    改成也要等满一个 interval，与手机端「上次检查后隔 interval 才 roll」语义一致。
    // 💬 再与「最后一条对话」取较晚者：旧码只看 lastFiredAt，用户正聊着天、计时一到照样开火，
    //    而手机端滑窗同步有 15s 节流，后端常常还没看到 char 刚回的那几条 → 生成内容和前台回复
    //    一模一样（用户报「聊着聊着到点主动消息又重发一遍」）。与手机端 legacy 档
    //    「用户/角色沉默满 interval 才发」同口径。
    const base = Math.max(lastFiredAt || enabledAt || 0, Number(lastInteractionAt) || 0);
    if (base && (now - base) < intervalMs) {
        return { fire: false, reason: `interval not elapsed (${Math.round((now - base) / 60000)}m < ${Math.round(intervalMs / 60000)}m)` };
    }
    // 🌙 安静时段：impulse 档一直有（timeOfDayScore/isQuietHour），interval 档旧码完全没有
    //    → 半夜照发。补上，与 impulse 档同一份 quietHours。
    if (hour != null && isQuietHour(hour, quietHours)) {
        return { fire: false, reason: `quiet hours (h=${hour})` };
    }
    const threshold = PROB_MAP[probability] ?? 0.3;
    const roll = Math.random();
    return { fire: roll < threshold, reason: `interval roll ${roll.toFixed(2)} vs ${threshold} (${probability})` };
}