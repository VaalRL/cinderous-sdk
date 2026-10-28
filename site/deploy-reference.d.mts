// deploy-reference.mjs 的型別（給測試與 tsc 用）
import type { DeployOptionSpec } from '../src/deploy/config/index.js';

export declare const DEPLOY_REFERENCE_FILES: { readonly en: string; readonly 'zh-TW': string };
export declare function renderDeployReference(specs: readonly DeployOptionSpec[], lang: 'en' | 'zh-TW'): string;
