import { type CloudflareErrorKind } from './http.js';
export declare const TOKEN_GUIDE_LOCALES: readonly ["zh-TW", "en"];
export type TokenGuideLocale = (typeof TOKEN_GUIDE_LOCALES)[number];
/** 步驟的穩定識別碼：UI 可以用它決定按鈕放在哪一步之後（例如「建立 Cloudflare Token」按鈕放在 `open-token-page`）。 */
export type TokenGuideStepId = 'prepare' | 'open-token-page' | 'check-permissions' | 'account-resources' | 'ttl' | 'create' | 'copy' | 'paste-and-deploy' | 'clean-up';
export interface TokenGuideStep {
    id: TokenGuideStepId;
    /** 短標題 */
    title: string;
    /** 說明（純文字，可能有多句） */
    body: string;
    /** 只有「確認權限」那一步有：要看到的權限列，與 `REQUIRED_TOKEN_PERMISSIONS` 的標籤相同 */
    permissions?: readonly string[];
}
export interface TokenGuideTroubleshooting {
    /** 使用者看到什麼 */
    symptom: string;
    /** 原因 */
    cause: string;
    /** 怎麼做 */
    fix: string;
}
export interface TokenSetupGuide {
    locale: TokenGuideLocale;
    /** 預填的 Token 名稱 */
    tokenName: string;
    links: {
        /** Cloudflare 註冊頁 */
        signUp: string;
        /** 預填權限的 Token 建立頁，等於 `buildTokenCreationUrl({ name: tokenName })` */
        createToken: string;
        /** 個人的 API Tokens 清單（部署完刪除 Token 用） */
        apiTokens: string;
        /** Workers 官方價格頁 */
        pricing: string;
    };
    prerequisites: readonly string[];
    /** 有序步驟，第 0 步是事前準備 */
    steps: readonly TokenGuideStep[];
    /** 以 `CloudflareApiError.kind` 為鍵 */
    troubleshooting: Readonly<Record<CloudflareErrorKind, TokenGuideTroubleshooting>>;
    /** 補充說明：介面語言、費用、重新部署 */
    notes: readonly string[];
}
/** 步驟「貼回來並部署」裡的應用名稱預設值：目前的使用者是兩個 Obsidian 外掛（ADR 0022） */
export declare const DEFAULT_GUIDE_APP_NAME = "Obsidian";
/**
 * 產生步驟說明。只有自訂 Token 名稱（也就是呼叫 `buildTokenCreationUrl({ name })`）或
 * 應用名稱（「回到 ___，把 Token 貼到…」）時才需要；一般直接用 `CLOUDFLARE_TOKEN_SETUP_GUIDE`。
 */
export declare function buildCloudflareTokenSetupGuide(opts?: {
    tokenName?: string;
    appName?: string;
}): Readonly<Record<TokenGuideLocale, TokenSetupGuide>>;
/** 預設 Token 名稱（`DEFAULT_TOKEN_NAME`）的步驟說明，搭配 `buildTokenCreationUrl()`。 */
export declare const CLOUDFLARE_TOKEN_SETUP_GUIDE: Readonly<Record<"en" | "zh-TW", TokenSetupGuide>>;
//# sourceMappingURL=guide.d.ts.map