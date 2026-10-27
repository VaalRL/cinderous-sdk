type JsonSchema = Record<string, unknown>;
/** 產生設定檔的 JSON Schema（draft 2020-12）。所有層級都不接受未知的鍵：打錯字要看得見。 */
export declare function deployConfigJsonSchema(): JsonSchema;
/** 提交進 repo 的 schema 檔內容（固定格式，測試比對用）。 */
export declare function renderDeployConfigJsonSchema(): string;
export {};
//# sourceMappingURL=schema.d.ts.map