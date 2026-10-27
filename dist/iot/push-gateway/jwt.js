// JWT 簽章（WebCrypto；Workers 與 Node 共用，不加相依）：FCM 的服務帳號 RS256、APNs 的 ES256。
// 🔴 私鑰只在記憶體裡以不可匯出（`extractable: false`）的 CryptoKey 存在；匯入失敗的錯誤不帶任何金鑰內容。
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64, base64urlnopad } from '@scure/base';
/** PEM（PKCS#8）→ DER；格式不對丟出不含內容的錯誤 */
export function pemToDer(pem, what) {
    const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem.replace(/\\n/g, '\n'));
    if (!m)
        throw new Error(`${what} 不是 PKCS#8 PEM 私鑰（-----BEGIN PRIVATE KEY-----）`);
    try {
        return base64.decode(m[1].replace(/\s+/g, ''));
    }
    catch {
        throw new Error(`${what} 的 PEM 內容不是合法的 base64`);
    }
}
const b64url = (bytes) => base64urlnopad.encode(bytes);
const b64urlJson = (value) => b64url(utf8ToBytes(JSON.stringify(value)));
/** 匯入 RS256 私鑰（FCM 服務帳號） */
export async function importRs256Key(pem, what) {
    const der = pemToDer(pem, what);
    try {
        return await crypto.subtle.importKey('pkcs8', new Uint8Array(der), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    }
    catch {
        throw new Error(`${what} 無法匯入為 RSA 私鑰`);
    }
}
/** 匯入 ES256 私鑰（APNs 的 .p8） */
export async function importEs256Key(pem, what) {
    const der = pemToDer(pem, what);
    try {
        return await crypto.subtle.importKey('pkcs8', new Uint8Array(der), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    }
    catch {
        throw new Error(`${what} 無法匯入為 P-256 私鑰`);
    }
}
/** 簽一顆 JWT（RS256 或 ES256；ES256 的 WebCrypto 輸出就是 JWS 要的 r‖s） */
export async function signJwt(key, header, claims) {
    const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const algorithm = header.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
    const signature = new Uint8Array(await crypto.subtle.sign(algorithm, key, utf8ToBytes(input)));
    return `${input}.${b64url(signature)}`;
}
//# sourceMappingURL=jwt.js.map