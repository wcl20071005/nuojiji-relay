// id / 幂等辅助。

// 服务端生成的 message id —— 与 requestId 关联，手机端用它做幂等 putMessage + 替换占位。
export function makeMessageId(requestId) {
    return `relay_${requestId}`;
}

export function nowMs() {
    return Date.now();
}

// 从生成内容里提取「逐条推送文案」——通用 JSON-Lines 解析，只取可见文本，不含任何提示词逻辑。
// 支持：每行一个 {"t":"text","c":"..."}（最常见）；voice/sticker/image 等给占位文案；
// 非 JSON-Lines（纯文本/含未知格式）则整段截断成一条。
export function extractPushBodies(content) {
    if (!content || typeof content !== 'string') return ['有新消息'];
    const trimmed = content.trim();
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    const bodies = [];
    let sawJson = false;
    for (const line of lines) {
        if (!line.startsWith('{')) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        sawJson = true;
        const t = obj.t;
        if (t === 'text' && typeof obj.c === 'string' && obj.c.trim()) {
            bodies.push(obj.c.trim());
        } else if (t === 'voice') {
            bodies.push('[语音消息]');
        } else if (t === 'sticker') {
            bodies.push('[表情]');
        } else if (t === 'image' || t === 'sim_img' || t === 'simulated_image') {
            bodies.push('[图片]');
        } else if (t === 'forward') {
            bodies.push('[聊天记录]');
        } else if (t === 'transfer') {
            bodies.push('[转账]');
        } else if (t === 'gift') {
            bodies.push('[礼物]');
        }
        // 隐藏类型（xinsheng/memory/react/cal/note…）不发推送
    }
    if (bodies.length) return bodies.slice(0, 8); // 防止超长连发刷屏，最多 8 条
    // 非 JSON-Lines：整段当一条（截断）
    if (!sawJson && trimmed) return [trimmed.slice(0, 120)];
    return ['有新消息'];
}
