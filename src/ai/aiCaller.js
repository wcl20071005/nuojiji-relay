// 服务端 AI 调用 —— 复刻 APP 本地路径的非流式行为（含主→副 fallback、429 退避）。
// 永远 stream:false（中继不需要流式，结果整条进 outbox）。

import { getApiConfig, extractStreamReasoning, extractReasoning, API_TYPES } from './apiConfigs.js';
import { buildChatEndpoint, buildApiHeaders, buildChatRequestBody, assertSafeApiUrl, isGeminiNativeUrl } from './requestBuilder.js';
import { resolveVertexRequest } from './vertexAuth.js';

// 空闲超时（不是总时长）：连续这么久一个字节都没收到才判定连接挂死。
//   早期是 180s 总超时 → GLM 等长思考模型推理超过 3 分钟就被后端自己掐断，token 已扣却拿不到结果，
//   手机端再回退本地 = 同一轮扣两次费。流式下思考期间 reasoning delta 持续到达，不会误触。
const IDLE_TIMEOUT_MS = 600_000;
// 原生推理可能很长（数万字），outbox 存储有体积上限 → 封顶；手机端只用于思维链面板展示
const REASONING_CAP = 20_000;

function capReasoning(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!t) return null;
    return t.length > REASONING_CAP ? t.slice(0, REASONING_CAP) + '…' : t;
}

// Gemini 原生回包：candidates[0].content.parts[]，跳过 thought:true 的思考段（流式每块同形）
function extractGeminiNativeText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return null;
    const text = parts.filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    return text || null;
}

async function callOnce({ apiUrl, apiKey, model, apiType, messages, temperature, topP, frequencyPenalty, presencePenalty, reasoningEffort, maxTokens, forceAnthropicFormat = false, forceGeminiFormat = false }) {
    assertSafeApiUrl(apiUrl);
    // APP「裸反代」开关：格式编码进最终端点，headers / body 都按端点判
    const endpoint = buildChatEndpoint(apiUrl, { forceAnthropicFormat, forceGeminiFormat, model, stream: true });
    const geminiNative = isGeminiNativeUrl(endpoint);
    const baseHeaders = buildApiHeaders(endpoint, apiKey);
    // ⚠️ 用流式调 AI（stream:true）：部分 AI 代理（如 gemini 反代）对「非流式 + 图片」会 500，
    //    流式正常。后端在请求内读完整个 SSE 流、把 delta 拼成完整 content 再返回 —— 对手机端
    //    仍是「整条结果进 outbox」的非流式交付，只是后端内部走流式绕开代理的非流式限制。
    const baseBody = buildChatRequestBody({
        apiUrl: endpoint, model, messages, temperature, topP, frequencyPenalty, presencePenalty, reasoningEffort, stream: true, maxTokens,
        forceAnthropicFormat,
    });
    // Vertex AI 服务账号 JSON 当密钥：换真 token + 补项目/区域路径 + 补 google/ 模型前缀（同 APP 出口处）
    //   不是服务账号 → 原样返回
    const { url: reqUrl, headers, body } = await resolveVertexRequest({ url: endpoint, headers: baseHeaders, body: baseBody, apiKey });

    const controller = new AbortController();
    let timer = null;
    const kick = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };
    kick();
    let res;
    try {
        res = await fetch(reqUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            const err = new Error(`AI HTTP ${res.status}: ${errText.slice(0, 500)}`);
            err.status = res.status;
            throw err;
        }

        // 回包形状按实际协议取：Gemini 原生 → candidates/parts；裸反代 Anthropic → content[] / delta.text
        //   （用户 apiType 多半留在 openai，按 apiType 取会判空回）
        const config = geminiNative
            ? { extractContent: extractGeminiNativeText, extractStreamDelta: extractGeminiNativeText }
            : getApiConfig(forceAnthropicFormat ? API_TYPES.CLAUDE : apiType);
        const ct = res.headers.get('content-type') || '';

        // 非 SSE（代理忽略了 stream，直接返回完整 JSON）→ 按非流式解析兜底
        if (!ct.includes('text/event-stream')) {
            const rawText = await res.text();
            let data;
            try { data = JSON.parse(rawText); } catch { data = rawText; }
            const content = config.extractContent(data);
            if (content == null || content === '') {
                const err = new Error('AI returned empty content (non-stream fallback)');
                err.status = res.status;
                err.detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
                throw err;
            }
            return { content, reasoning: capReasoning(extractReasoning(data)) };
        }

        // SSE 流式：逐行读 data:，累积 delta（正文 + 原生推理分开累积）
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        let reasoning = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            kick(); // 收到数据 → 重置空闲计时
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 末行可能不完整，留到下次
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') continue;
                let json;
                try { json = JSON.parse(payload); } catch { continue; }
                const delta = config.extractStreamDelta(json);
                if (delta) content += delta;
                const rDelta = extractStreamReasoning(json);
                if (rDelta) reasoning += rDelta;
            }
        }
        if (!content || !content.trim()) {
            const err = new Error('AI returned empty content (stream)');
            err.status = res.status;
            throw err;
        }
        return { content, reasoning: capReasoning(reasoning) };
    } finally {
        clearTimeout(timer);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一次完整生成：主 API（带 429 退避重试）→ 失败且开了副 API fallback → 副 API。
 * @returns {Promise<{content:string, reasoning:string|null}>} 原始模型文本（含 tag，手机端解析）+ 原生推理
 */
export async function runGeneration(settings, messages, maxTokens) {
    const {
        mainApiUrl, mainApiKey, mainApiModel, apiType = 'openai',
        temperature, reasoningEffort,
        // 提示词预设的采样参数（APP 有填才带；没带 = undefined，请求体不放，行为同旧版）
        topP, frequencyPenalty, presencePenalty,
        autoRetryEnabled = true, maxRetries = 1, secondaryFallbackEnabled = true,
        secondaryApiUrl, secondaryApiKey, secondaryApiModel,
        // APP「裸反代」开关（旧 APP 不带 = false，行为同旧版）；副 API 没带时沿用主 API
        forceAnthropicFormat = false, forceGeminiFormat = false,
        secondaryForceAnthropicFormat = forceAnthropicFormat, secondaryForceGeminiFormat = forceGeminiFormat,
    } = settings || {};

    if (!mainApiUrl || !mainApiKey) throw new Error('settings.mainApiUrl / mainApiKey missing');

    const retries = autoRetryEnabled ? Math.max(0, Math.min(3, Number(maxRetries) || 0)) : 0;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000));
        try {
            return await callOnce({
                apiUrl: mainApiUrl, apiKey: mainApiKey, model: mainApiModel, apiType,
                messages, temperature, topP, frequencyPenalty, presencePenalty, reasoningEffort, maxTokens,
                forceAnthropicFormat, forceGeminiFormat,
            });
        } catch (e) {
            lastErr = e;
            // 只对 429 退避重试，其余错误立即跳出（避免重复扣费）
            if (e.status !== 429) break;
        }
    }

    // 主 API 失败 → 副 API fallback
    if (secondaryFallbackEnabled && secondaryApiUrl && secondaryApiKey) {
        try {
            return await callOnce({
                apiUrl: secondaryApiUrl, apiKey: secondaryApiKey, model: secondaryApiModel || mainApiModel, apiType,
                messages, temperature, topP, frequencyPenalty, presencePenalty, reasoningEffort, maxTokens,
                forceAnthropicFormat: secondaryForceAnthropicFormat, forceGeminiFormat: secondaryForceGeminiFormat,
            });
        } catch (e) {
            lastErr = e;
        }
    }

    throw lastErr || new Error('AI generation failed');
}
