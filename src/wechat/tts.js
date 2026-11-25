// 微信橋接用的語音合成：角色的語音訊息合成音頻檔發進微信（微信 Bot 發不出語音條，實測）。
//
// 手機端把該角色的 TTS 設定整理成 ttsSpec（網址已規整好、音色已按供應商選好）推上來，
// 這裡只照各家 API 格式發請求，回 mp3 位元組。支援 MiniMax / OpenAI 兼容 / ElevenLabs / Fish Audio；
// GPT-SoVITS 多半跑在用戶自己電腦上，雲端連不到 → 手機端不產 spec，微信退回文字。

const TIMEOUT_MS = 120_000;

// 去掉舞台動作（括號 / 星號），配對才去，避免把台詞一起吞掉（與手機端 TTS 一致）
export function cleanTtsText(text) {
    let s = String(text || '');
    const opens = (s.match(/[（(]/g) || []).length;
    const closes = (s.match(/[）)]/g) || []).length;
    if (opens === closes) s = s.replace(/[（(][^）)]*[）)]/g, '');
    if (((s.match(/\*/g) || []).length % 2) === 0) s = s.replace(/\*\*[^*]*\*\*/g, '').replace(/\*[^*]+\*/g, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s || String(text || '').trim();
}

async function postFor(url, headers, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } finally { clearTimeout(timer); }
}

async function binaryOrThrow(res, label) {
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return new Uint8Array(await res.arrayBuffer());
}

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

async function minimax(spec, text) {
    let lastErr = null;
    const queue = [...(spec.endpoints || [])];
    while (queue.length) {
        const url = queue.shift();
        try {
            const res = await postFor(url, { 'Content-Type': 'application/json', Authorization: `Bearer ${spec.key}` }, {
                model: spec.model || 'speech-2.8-hd',
                text,
                stream: false,
                voice_setting: {
                    voice_id: spec.voiceId, speed: spec.speed ?? 1.0, vol: 1.0, pitch: 0,
                    ...(spec.emotion ? { emotion: spec.emotion } : {}),
                },
                audio_setting: { format: 'mp3' },
                english_normalization: true,
                language_boost: spec.languageBoost || 'auto',
            });
            if (!res.ok) throw new Error(`MiniMax HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
            const data = await res.json();
            const code = data?.base_resp?.status_code;
            if (code && code !== 0) {
                // GroupId 與密鑰不匹配 → 同端點去掉 GroupId 再試（與手機端一致）
                if (code === 1004 && /[?&]GroupId=/i.test(url)) {
                    queue.unshift(url.replace(/([?&])GroupId=[^&]*&?/i, '$1').replace(/[?&]$/, ''));
                    continue;
                }
                throw new Error(`MiniMax ${code}: ${data.base_resp.status_msg}`);
            }
            if (!data?.data?.audio) throw new Error('MiniMax: no audio');
            return hexToBytes(data.data.audio);
        } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('MiniMax: no endpoint');
}

async function openaiTts(spec, text) {
    const body = { model: spec.model || 'tts-1', input: text, voice: spec.voiceId || 'alloy', response_format: 'mp3' };
    if (Number.isFinite(spec.speed) && spec.speed !== 1) body.speed = Math.min(4, Math.max(0.25, spec.speed));
    const res = await postFor(spec.url, { 'Content-Type': 'application/json', Authorization: `Bearer ${spec.key}` }, body);
    return binaryOrThrow(res, 'OpenAI TTS');
}

async function elevenlabs(spec, text) {
    const res = await postFor(spec.url, { 'Content-Type': 'application/json', 'xi-api-key': spec.key, Accept: 'audio/mpeg' }, {
        text, model_id: spec.model || 'eleven_multilingual_v2', voice_settings: spec.voiceSettings || { stability: 0.5, similarity_boost: 0.75 },
        ...(spec.languageCode ? { language_code: spec.languageCode } : {}),
    });
    return binaryOrThrow(res, 'ElevenLabs');
}

async function fishaudio(spec, text) {
    const body = { text, format: 'mp3', mp3_bitrate: 128, normalize: true, latency: spec.latency || 'normal' };
    if (spec.voiceId) body.reference_id = spec.voiceId;
    if (spec.prosody) body.prosody = spec.prosody;
    const res = await postFor(spec.url, { 'Content-Type': 'application/json', Authorization: `Bearer ${spec.key}`, model: spec.model || 's2.1-pro-free' }, body);
    return binaryOrThrow(res, 'Fish Audio');
}

const PROVIDERS = { minimax, openaitts: openaiTts, elevenlabs, fishaudio };

/** @returns {Promise<Uint8Array>} mp3 */
export async function synthesizeSpeech(spec, text) {
    const fn = spec && PROVIDERS[spec.provider];
    if (!fn) throw new Error(`unsupported tts provider: ${spec?.provider}`);
    if (!spec.key) throw new Error('tts key missing');
    return fn(spec, cleanTtsText(text));
}

