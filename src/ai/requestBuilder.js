// 请求构建 —— 从糯叽机 APP 的 src/utils/aiApiService.js 端口过来。
// ⚠️ 与 nuojiji APP 的 aiApiService.js 保持同步：
//    buildApiEndpoint / isAnthropicOfficialUrl / buildApiHeaders /
//    normalizeMessagesForAnthropic / buildChatRequestBody / buildChatEndpoint /
//    normalizeTextContent。
//    APP 那边改了任意一处请求格式，这里都要跟着改，否则 openai/gemini/claude/custom
//    四种 apiType 在服务端的行为会和手机本地路径不一致。

import { isPrivateOrBannedHost } from '../util/auth.js';
import { isVertexHost } from './vertexAuth.js';

export function isAnthropicOfficialUrl(apiUrl) {
    if (!apiUrl) return false;
    return /(^|\.)anthropic\.com/i.test(apiUrl);
}

function buildApiEndpoint(apiUrl, suffix) {
    if (!apiUrl) return '';
    let base = apiUrl.replace(/\/+$/, '');
    if (isAnthropicOfficialUrl(base)) {
        if (!/\/v\d+$/.test(base) && !base.includes('/v1')) {
            base = `${base}/v1`;
        }
        return `${base}${suffix}`;
    }
    // Vertex AI：已填到 .../endpoints/openapi 的完整地址直接接后缀；
    // 裸域名照常补 /v1，aiCaller 出口处按服务账号补项目/区域路径（同 APP）
    if (isVertexHost(base) && /\/endpoints\/openapi$/i.test(base)) {
        return `${base}${suffix}`;
    }
    if (base.includes('generativelanguage.googleapis.com')) {
        if (!base.includes('/v1beta/openai')) {
            base = 'https://generativelanguage.googleapis.com/v1beta/openai';
        }
        return `${base}${suffix}`;
    }
    if (base.endsWith('/v1')) {
        return `${base}${suffix}`;
    }
    return `${base}/v1${suffix}`;
}

// 裸反代 Gemini 原生协议（同 APP isGeminiNativeUrl / looksLikeGeminiNativeBase / buildGeminiNativeEndpoint）：
// 端点是 {base}/v1beta/models/{model}:generateContent（流式 :streamGenerateContent?alt=sse），
// 打 /v1/chat/completions 会被这类反代回 404。格式编码进最终 URL，headers/body 都按 URL 反推。
export function isGeminiNativeUrl(apiUrl) {
    if (!apiUrl) return false;
    return /:(stream)?generateContent(\?|$)/i.test(String(apiUrl));
}

function looksLikeGeminiNativeBase(apiUrl) {
    if (!apiUrl) return false;
    return /\/v1beta(\/models)?\/?$/i.test(String(apiUrl).trim());
}

function buildGeminiNativeEndpoint(apiUrl, model, stream) {
    let base = String(apiUrl || '').replace(/\/+$/, '');
    // Vertex AI 裸域名：原生路径是 /v1/publishers/google/models/{模型}:generateContent
    // （服务账号在 aiCaller 出口处再补成 /v1/projects/{项目}/locations/{区域}/...；Express 模式 API Key 直接用）
    if (isVertexHost(base) && !/\/projects\//.test(base)) {
        const origin = (() => { try { return new URL(base).origin; } catch { return base; } })();
        const m = String(model || 'gemini-2.5-pro').replace(/^(models|google)\//i, '');
        return `${origin}/v1/publishers/google/models/${m}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    }
    base = base.replace(/\/models$/i, '');
    if (!/\/v1beta$/i.test(base)) base = `${base}/v1beta`;
    const safeModel = String(model || 'gemini-2.5-pro').replace(/^models\//i, '');
    return `${base}/models/${safeModel}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
}

/**
 * @param {string} apiUrl
 * @param {object} [opts] { forceAnthropicFormat, forceGeminiFormat, model, stream } —— APP「裸反代」两个开关
 */
export const buildChatEndpoint = (apiUrl, opts = {}) => {
    const { forceAnthropicFormat = false, forceGeminiFormat = false, model, stream = false } = opts || {};
    if (forceGeminiFormat || looksLikeGeminiNativeBase(apiUrl) || isGeminiNativeUrl(apiUrl)) {
        return buildGeminiNativeEndpoint(apiUrl, model, stream);
    }
    return buildApiEndpoint(apiUrl, (isAnthropicOfficialUrl(apiUrl) || forceAnthropicFormat) ? '/messages' : '/chat/completions');
};

export function buildApiHeaders(apiUrl, apiKey, extraHeaders = {}) {
    if (isGeminiNativeUrl(apiUrl)) {
        // Vertex AI Express 模式（API Key）：只认 x-goog-api-key，多带一个非 OAuth 的 Bearer 会 401
        //   （服务账号 JSON 的情况由 aiCaller 出口换成真 token）
        if (isVertexHost(apiUrl)) {
            return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, ...extraHeaders };
        }
        // 官方认 x-goog-api-key，第三方反代多用 Bearer 验代理密码 → 两个都带（同 APP）
        return {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
            'Authorization': `Bearer ${apiKey}`,
            ...extraHeaders,
        };
    }
    if (isAnthropicOfficialUrl(apiUrl)) {
        return {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION_LOCAL,
            ...extraHeaders,
        };
    }
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...extraHeaders,
    };
}

const ANTHROPIC_API_VERSION_LOCAL = '2023-06-01';

function normalizeTextContent(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    if (Array.isArray(input)) {
        return input.map((item) => normalizeTextContent(item)).filter(Boolean).join('');
    }
    if (typeof input === 'object') {
        if (typeof input.text === 'string') return input.text;
        if (typeof input.output_text === 'string') return input.output_text;
        if (input.content != null) return normalizeTextContent(input.content);
        if (input.parts != null) return normalizeTextContent(input.parts);
        if (input.message?.content != null) return normalizeTextContent(input.message.content);
    }
    return '';
}

function normalizeMessagesForAnthropic(messages) {
    const normalized = Array.isArray(messages) ? messages : [];
    const systemParts = [];
    const converted = [];

    for (const msg of normalized) {
        if (!msg) continue;
        const role = String(msg.role || '').toLowerCase();

        if (role === 'system') {
            const textContent = normalizeTextContent(msg.content || '');
            if (textContent) systemParts.push(textContent);
            continue;
        }

        let processedContent;
        if (Array.isArray(msg.content)) {
            const anthropicParts = [];
            for (const part of msg.content) {
                if (!part || typeof part !== 'object') continue;
                if (part.type === 'text') {
                    if (part.text) anthropicParts.push({ type: 'text', text: part.text });
                } else if (part.type === 'image_url') {
                    const imageUrl = part.image_url?.url || part.url;
                    if (imageUrl) {
                        if (imageUrl.startsWith('data:')) {
                            const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                            if (matches) {
                                anthropicParts.push({
                                    type: 'image',
                                    source: { type: 'base64', media_type: matches[1], data: matches[2] },
                                });
                            }
                        } else {
                            anthropicParts.push({ type: 'image', source: { type: 'url', url: imageUrl } });
                        }
                    }
                }
            }
            if (anthropicParts.length > 0) processedContent = anthropicParts;
            else continue;
        } else {
            const textContent = normalizeTextContent(msg.content || '');
            if (!textContent) continue;
            processedContent = textContent;
        }

        converted.push({ role: role === 'assistant' ? 'assistant' : 'user', content: processedContent });
    }

    if (converted.length === 0) {
        converted.push({ role: 'user', content: 'Please continue.' });
    }

    return { messages: converted, system: systemParts.join('\n\n').trim() };
}

// OpenAI messages → Gemini 原生 contents/systemInstruction（同 APP normalizeMessagesForGemini）
function normalizeMessagesForGemini(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const systemParts = [];
    const contents = [];
    for (const msg of list) {
        if (!msg) continue;
        const role = String(msg.role || '').toLowerCase();
        if (role === 'system') {
            const text = normalizeTextContent(msg.content || '');
            if (text) systemParts.push(text);
            continue;
        }
        const parts = [];
        if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (!part || typeof part !== 'object') continue;
                if (part.type === 'text') {
                    if (part.text) parts.push({ text: part.text });
                } else if (part.type === 'image_url') {
                    const imageUrl = part.image_url?.url || part.url;
                    if (!imageUrl) continue;
                    const m = String(imageUrl).match(/^data:([^;]+);base64,(.+)$/);
                    parts.push(m ? { inlineData: { mimeType: m[1], data: m[2] } } : { text: `[image: ${imageUrl}]` });
                }
            }
        } else {
            const text = normalizeTextContent(msg.content || '');
            if (text) parts.push({ text });
        }
        if (!parts.length) continue;
        const geminiRole = role === 'assistant' ? 'model' : 'user';
        const last = contents[contents.length - 1];
        if (last && last.role === geminiRole) last.parts.push(...parts);
        else contents.push({ role: geminiRole, parts });
    }
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Please continue.' }] });
    return { contents, systemInstruction: systemParts.join('\n\n').trim() };
}

// Gemini 原生安全过滤默认很严，会把正常角色扮演判违规 → 全关到最松（同 APP）
const GEMINI_SAFETY_SETTINGS = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
    'HARM_CATEGORY_CIVIC_INTEGRITY',
].map(category => ({ category, threshold: 'BLOCK_NONE' }));

// 新版 Claude（4.5+ / Claude 5 系）temperature 与 top_p 只能二选一，同传直接 400（同 APP claudeRejectsBothSamplingParams）
function claudeRejectsBothSamplingParams(model) {
    const name = String(model || '');
    if (!/claude|fable|mythos/i.test(name)) return false;
    if (/fable|mythos/i.test(name)) return true;
    const pair = name.match(/(\d+)[.-](\d{1,2})(?!\d)/);
    if (pair) {
        const major = parseInt(pair[1], 10), minor = parseInt(pair[2], 10);
        if (major > 4) return true;
        return major === 4 && minor >= 5;
    }
    const single = name.match(/claude[^0-9]*(\d+)/i);
    if (single) return parseInt(single[1], 10) >= 5;
    return false;
}

export function buildChatRequestBody({ apiUrl, model, messages, temperature, topP, frequencyPenalty, presencePenalty, reasoningEffort, stream, maxTokens, forceAnthropicFormat = false }) {
    const numOk = (v) => typeof v === 'number' && isFinite(v);
    if (numOk(topP) && typeof temperature === 'number' && claudeRejectsBothSamplingParams(model)) {
        topP = null;
    }
    // apiUrl 传最终端点：Gemini 原生由 URL 判（流式与否也在 URL 里，body 不带 stream）
    if (isGeminiNativeUrl(apiUrl)) {
        const { contents, systemInstruction } = normalizeMessagesForGemini(messages);
        const generationConfig = {
            ...(typeof temperature === 'number' ? { temperature } : {}),
            ...(numOk(topP) ? { topP } : {}),
            ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        };
        return {
            contents,
            ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
            ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
            safetySettings: GEMINI_SAFETY_SETTINGS,
        };
    }
    const isAnthropic = isAnthropicOfficialUrl(apiUrl) || forceAnthropicFormat;
    if (isAnthropic) {
        const { messages: anthropicMessages, system } = normalizeMessagesForAnthropic(messages);
        const anthropicLimit = /claude-3-5|claude-3\.5/i.test(model) ? 8192
            : /claude-3/i.test(model) ? 4096
            : 16384;
        const safeMax = maxTokens ? Math.min(maxTokens, anthropicLimit) : anthropicLimit;
        return {
            model,
            messages: anthropicMessages,
            max_tokens: safeMax,
            ...(typeof temperature === 'number' ? { temperature } : {}),
            // Anthropic 支持 top_p；不支持 frequency/presence penalty（传了会 400）
            ...(numOk(topP) ? { top_p: topP } : {}),
            ...(system ? { system } : {}),
            ...(stream ? { stream: true } : {}),
        };
    }

    // 兜底：若只有 system（或空）消息，补一条 user 占位。走 gemini 反代时 system 不进 contents，
    //    contents 为空会被代理拒（contents is required）。与 Anthropic 分支的同款保护对齐。
    const hasNonSystem = Array.isArray(messages)
        && messages.some((m) => m && String(m.role || '').toLowerCase() !== 'system');
    const safeMessages = hasNonSystem
        ? messages
        : [...(Array.isArray(messages) ? messages : []), { role: 'user', content: '请开始回复。' }];
    const isO = /\b(o1|o3|o4)/i.test(model);
    // Gemini 官方 OpenAI 兼容层 / 中转站 Gemini 模型带了 penalty（哪怕 0）就整包 400 → 不放（同 APP）
    const isGoogleGeminiCompat = /generativelanguage\.googleapis\.com/i.test(String(apiUrl || ''))
        || /gemini|gemma/i.test(String(model || ''));
    const allowPenalty = !isO && !isGoogleGeminiCompat;
    const safeMaxTokens = maxTokens ? Math.min(maxTokens, isO ? 100_000 : 65_536) : null;
    const tokenPayload = safeMaxTokens
        ? (isO ? { max_completion_tokens: safeMaxTokens } : { max_tokens: safeMaxTokens })
        : {};
    return {
        model,
        messages: safeMessages,
        ...(!isO ? { temperature } : {}),
        ...(!isO && numOk(topP) ? { top_p: topP } : {}),
        ...(allowPenalty && numOk(frequencyPenalty) ? { frequency_penalty: frequencyPenalty } : {}),
        ...(allowPenalty && numOk(presencePenalty) ? { presence_penalty: presencePenalty } : {}),
        ...(typeof stream === 'boolean' ? { stream } : {}),
        ...tokenPayload,
        ...(isO && reasoningEffort && reasoningEffort !== 'none' ? { reasoning_effort: reasoningEffort } : {}),
    };
}

// SSRF 防护：用户的 messages/key 由用户自己掌控，但仍校验目标 URL host 不是内网/元数据地址，
// 防止有人借中继实例探测部署环境内网。isPrivateOrBannedHost 见 util/auth.js。
export function assertSafeApiUrl(apiUrl) {
    let host;
    try {
        host = new URL(apiUrl).hostname;
    } catch {
        throw new Error('Invalid apiUrl');
    }
    // 本地调试 / 把 AI 服务跑在同机时，设 RELAY_ALLOW_PRIVATE_HOST=1 放行内网地址。
    const allowPrivate = typeof process !== 'undefined' && process.env?.RELAY_ALLOW_PRIVATE_HOST === '1';
    if (!allowPrivate && isPrivateOrBannedHost(host)) {
        throw new Error(`Refusing to call private/banned host: ${host}`);
    }
}
