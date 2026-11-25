// Vertex AI（Google Cloud）—— 从糯叽机 APP 的 src/utils/vertexAuth.js 端口过来。
// ⚠️ 与 APP 保持同步：looksLikeServiceAccountKey / isVertexHost / rewriteVertexUrl / fixModelPrefix。
//
// APP 那边地址填 https://aiplatform.googleapis.com（或 {区域}-aiplatform...），密钥栏直接贴服务账号 JSON。
// 中继要做 APP 出口处做的同一件事，否则打到裸路径 /v1/chat/completions 必 404：
//   1. 服务账号 JSON → 签 RS256 JWT → 换 access token（缓存，到期前 5 分钟重签）
//   2. 裸域名路径补成 /v1/projects/{项目}/locations/{区域}/...
//   3. OpenAI 兼容端点的模型名缺 google/ 前缀时补上
// 私钥只在内存里签名，不进日志、不进请求头。

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const tokenCache = new Map();
const inflight = new Map();
const keyCache = new Map();

/** 密钥栏的内容是不是服务账号 JSON（便宜的前置判断，不 parse） */
export function looksLikeServiceAccountKey(key) {
    const s = String(key || '').trim();
    return s.startsWith('{') && /"service_account"/.test(s) && /"private_key"/.test(s);
}

/** 解析服务账号 JSON → { id, projectId, clientEmail, privateKey, privateKeyId, tokenUri } 或 null */
export function parseServiceAccount(key) {
    if (!looksLikeServiceAccountKey(key)) return null;
    const raw = String(key).trim();
    let obj = null;
    try {
        obj = JSON.parse(raw);
    } catch {
        // 贴进单行输入框时部分输入法会把 private_key 里的 \n 变成真换行
        try { obj = JSON.parse(raw.replace(/\r?\n/g, '\\n')); } catch { obj = null; }
    }
    if (!obj || obj.type !== 'service_account' || !obj.client_email || !obj.private_key) return null;
    return {
        id: `${obj.client_email}#${String(obj.private_key_id || '').slice(0, 12)}`,
        projectId: String(obj.project_id || ''),
        clientEmail: String(obj.client_email),
        privateKey: String(obj.private_key),
        privateKeyId: String(obj.private_key_id || ''),
        tokenUri: String(obj.token_uri || DEFAULT_TOKEN_URI),
    };
}

export function isVertexHost(url) {
    try {
        return /(^|\.|-)aiplatform\.googleapis\.com$/i.test(new URL(String(url)).host);
    } catch {
        return /aiplatform\.googleapis\.com/i.test(String(url || ''));
    }
}

/** 由主机名推区域：us-central1-aiplatform... → us-central1；aiplatform... → global */
function locationFromHost(url) {
    try {
        const m = new URL(String(url)).host.match(/^([a-z0-9-]+)-aiplatform\.googleapis\.com$/i);
        return m ? m[1] : 'global';
    } catch {
        return 'global';
    }
}

// ── JWT 签名（WebCrypto RS256，Node 18+ / Workers 都有全局 crypto.subtle）──

const b64url = (bytes) => {
    let bin = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function importPrivateKey(sa) {
    if (keyCache.has(sa.id)) return keyCache.get(sa.id);
    const body = sa.privateKey
        .replace(/-----[^-]*-----/g, '')
        .replace(/\\n/g, '')
        .replace(/[^A-Za-z0-9+/=]/g, '');
    const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        'pkcs8', der.buffer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign'],
    );
    keyCache.set(sa.id, key);
    return key;
}

async function signJwt(sa) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', ...(sa.privateKeyId ? { kid: sa.privateKeyId } : {}) };
    const claims = { iss: sa.clientEmail, scope: SCOPE, aud: sa.tokenUri, iat: now, exp: now + 3600 };
    const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const key = await importPrivateKey(sa);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
    return `${input}.${b64url(sig)}`;
}

/** 取 access token（有效缓存直接回；同一账号并发只发一次换 token 请求） */
async function getVertexAccessToken(sa) {
    const cached = tokenCache.get(sa.id);
    if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.token;
    if (inflight.has(sa.id)) return inflight.get(sa.id);
    const p = (async () => {
        let jwt;
        try {
            jwt = await signJwt(sa);
        } catch (e) {
            throw new Error(`Vertex AI: cannot read service account private key (${e?.message || e})`);
        }
        const res = await fetch(sa.tokenUri, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
        });
        const text = await res.text().catch(() => '');
        if (!res.ok) {
            const err = new Error(`Vertex AI token HTTP ${res.status}: ${text.slice(0, 500)}`);
            err.status = res.status;
            throw err;
        }
        let data = {};
        try { data = JSON.parse(text); } catch { /* 下方报错 */ }
        if (!data.access_token) throw new Error(`Vertex AI token: ${text.slice(0, 500)}`);
        const expiresIn = Number(data.expires_in) || 3600;
        tokenCache.set(sa.id, { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 });
        return data.access_token;
    })();
    inflight.set(sa.id, p);
    try {
        return await p;
    } finally {
        inflight.delete(sa.id);
    }
}

/**
 * 裸域名 → 带项目/区域的完整路径（同 APP rewriteVertexUrl）：
 *   /v1/chat/completions                → /v1/projects/P/locations/L/endpoints/openapi/chat/completions
 *   /v1/publishers/google/models/x:...  → /v1/projects/P/locations/L/publishers/google/models/x:...
 */
function rewriteVertexUrl(url, sa) {
    let u;
    try { u = new URL(String(url)); } catch { return url; }
    if (/\/projects\/[^/]+\/locations\//.test(u.pathname)) return url;
    const prefix = `/v1/projects/${sa.projectId}/locations/${locationFromHost(url)}`;
    const path = u.pathname.replace(/\/+$/, '');
    let m;
    if ((m = path.match(/\/(?:v1|v1beta1?)\/(?:endpoints\/openapi\/)?(chat\/completions|models|embeddings)$/))) {
        u.pathname = `${prefix}/endpoints/openapi/${m[1]}`;
    } else if ((m = path.match(/\/(?:v1|v1beta1?)\/(?:publishers\/google\/)?models\/([^/]+:[A-Za-z]+)$/))) {
        u.pathname = `${prefix}/publishers/google/models/${m[1]}`;
    } else {
        return url;
    }
    return u.toString();
}

/**
 * 发请求前统一改写（用服务账号 JSON 当密钥时）：真 token、补项目路径、补模型前缀。
 * 不是服务账号密钥 → 原样返回。
 * @returns {Promise<{url:string, headers:object, body:object}>}
 */
export async function resolveVertexRequest({ url, headers, body, apiKey }) {
    const sa = parseServiceAccount(apiKey);
    if (!sa) return { url, headers, body };
    const token = await getVertexAccessToken(sa);
    // 不带 x-goog-user-project：路径已含项目；带了反而要多一个 Service Usage Consumer 权限（同 APP）
    const nextHeaders = { ...headers, Authorization: `Bearer ${token}` };
    delete nextHeaders['x-goog-api-key'];
    const nextUrl = sa.projectId ? rewriteVertexUrl(url, sa) : url;
    let nextBody = body;
    if (/\/endpoints\/openapi\/chat\/completions/.test(nextUrl) && body && typeof body.model === 'string'
        && body.model && !body.model.includes('/')) {
        nextBody = { ...body, model: `google/${body.model}` };
    }
    return { url: nextUrl, headers: nextHeaders, body: nextBody };
}
