import { type TokenGuideLocale } from '../cloudflare-api/guide.js';
import { type DeployConfig, type DeploySecrets } from './types.js';
/** 說明的語言（與 Token 指南同一組） */
export type DeployGuideLocale = TokenGuideLocale;
export declare const DEPLOY_GUIDE_LOCALES: readonly DeployGuideLocale[];
/** 部署包裡兩份說明的檔名 */
export declare const DEPLOY_GUIDE_FILES: Readonly<Record<DeployGuideLocale, string>>;
export interface DeployGuideContext {
    /** 產生部署包的 SDK 版號（NIP-11 `version` 會是這個） */
    sdkVersion: string;
    /** SDK 內嵌在 `sdk/`（公開前的預設）；false＝以套件相依安裝 */
    embedSdk?: boolean;
    /** Workers：附預打包的 `src/relay.mjs`，不需要安裝 SDK */
    selfContained?: boolean;
}
/** SDK 的原始碼位置（私有期間對第三方無效，見 SOURCE.md） */
export declare const SDK_SOURCE_REPO = "https://github.com/VaalRL/cinderous-sdk";
/** 秘密的環境變數名稱（設定檔的 `$env`，沒有就用慣用名稱） */
export declare function secretEnvName(config: DeployConfig, key: keyof DeploySecrets): string;
/** 客戶端要連的端點與健康檢查的 http 位址 */
export declare function deployEndpoints(config: DeployConfig): {
    http: string;
    ws: string;
    placeholder: boolean;
};
/**
 * 產生部署說明（Markdown）。段落：前置工具、取得憑證、設定秘密、部署、健康檢查、回滾、升級、成本、安全檢查清單、授權、連上這座中繼。
 * 同一份設定、同一個版號 → 同一份文字（沒有時間戳記），可以提交、可以 diff。
 */
export declare function renderDeployGuide(config: DeployConfig, locale: DeployGuideLocale, ctx: DeployGuideContext): string;
//# sourceMappingURL=guide.d.ts.map