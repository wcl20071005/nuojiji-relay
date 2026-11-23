// AES-128-ECB + PKCS7（微信 CDN 媒體加解密用）。
//
// 為何自己寫：WebCrypto 不支援 ECB，Workers 的 node:crypto 相容層也不保證有 aes-128-ecb，
// 而中繼要同時跑在 Workers 與 Node 上 → 用純 JS 實作，兩邊行為一致。只用於媒體檔，量不大。

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(() => {
    // 由 GF(2^8) 乘法逆元 + 仿射變換生成 S 盒（免得手抄 256 個常數抄錯）
    let p = 1, q = 1;
    do {
        p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
        q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
        if (q & 0x80) q ^= 0x09;
        const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
        SBOX[p] = (x ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

const xtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
function mul(a, b) {
    let r = 0;
    while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; }
    return r;
}

function expandKey(key) {
    if (key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
    const w = new Uint8Array(176);
    w.set(key);
    let rcon = 1;
    for (let i = 16; i < 176; i += 4) {
        let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
        if (i % 16 === 0) {
            const tmp = t0;
            t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[tmp];
            rcon = xtime(rcon);
        }
        w[i] = w[i - 16] ^ t0; w[i + 1] = w[i - 15] ^ t1; w[i + 2] = w[i - 14] ^ t2; w[i + 3] = w[i - 13] ^ t3;
    }
    return w;
}

function encryptBlock(s, w) {
    for (let i = 0; i < 16; i++) s[i] ^= w[i];
    for (let round = 1; round <= 10; round++) {
        for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
        // ShiftRows（狀態按列存：s[col*4+row]）
        let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
        t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
        t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
        if (round !== 10) {
            for (let c = 0; c < 16; c += 4) {
                const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
                const all = a0 ^ a1 ^ a2 ^ a3;
                s[c] ^= all ^ xtime(a0 ^ a1); s[c + 1] ^= all ^ xtime(a1 ^ a2);
                s[c + 2] ^= all ^ xtime(a2 ^ a3); s[c + 3] ^= all ^ xtime(a3 ^ a0);
            }
        }
        const k = round * 16;
        for (let i = 0; i < 16; i++) s[i] ^= w[k + i];
    }
}

function decryptBlock(s, w) {
    for (let i = 0; i < 16; i++) s[i] ^= w[160 + i];
    for (let round = 9; round >= 0; round--) {
        // InvShiftRows
        let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
        t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
        t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
        for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
        const k = round * 16;
        for (let i = 0; i < 16; i++) s[i] ^= w[k + i];
        if (round !== 0) {
            for (let c = 0; c < 16; c += 4) {
                const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
                s[c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
                s[c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
                s[c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
                s[c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
            }
        }
    }
}

export function aesEcbEncrypt(plain, key) {
    const w = expandKey(key);
    const pad = 16 - (plain.length % 16);
    const out = new Uint8Array(plain.length + pad);
    out.set(plain);
    out.fill(pad, plain.length);
    for (let i = 0; i < out.length; i += 16) encryptBlock(out.subarray(i, i + 16), w);
    return out;
}

export function aesEcbDecrypt(cipher, key) {
    if (cipher.length % 16 !== 0) throw new Error('ciphertext length not multiple of 16');
    const w = expandKey(key);
    const out = new Uint8Array(cipher);
    for (let i = 0; i < out.length; i += 16) decryptBlock(out.subarray(i, i + 16), w);
    const pad = out[out.length - 1];
    if (pad < 1 || pad > 16) throw new Error('bad PKCS7 padding');
    return out.subarray(0, out.length - pad);
}

export const aesEcbPaddedSize = (n) => Math.ceil((n + 1) / 16) * 16;
