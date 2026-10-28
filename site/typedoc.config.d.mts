// typedoc.config.mjs 的型別（給測試與 tsc 用）
import type { TypeDocOptions } from 'typedoc';

export declare function apiEntryPoints(exports: Record<string, unknown>): string[];
export declare function importPath(moduleName: string): string;
export declare const API_OUT: string;
declare const options: TypeDocOptions;
export default options;
