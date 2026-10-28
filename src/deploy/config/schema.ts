// 從描述表推出 `cinderous.config.json` 的 JSON Schema（SDK ADR 0050 §3）。
// 產出提交在 schema/cinderous.config.schema.json；測試比對兩者一致（改了描述表要重新產生：`cinderous config schema`）。
import { DEPLOY_CONFIG_VERSION, DEPLOY_TARGETS } from './types.js';
import { DEPLOY_OPTION_SPECS, type DeployOptionSpec } from './specs.js';

type JsonSchema = Record<string, unknown>;

/** 秘密引用的 JSON Schema（`$defs.secretRef`） */
const SECRET_REF_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['$env'],
  properties: { $env: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' } },
  description: '秘密只寫環境變數名稱，值在部署時從環境或 .env 讀。\n\nSecrets reference an environment variable by name; the value is read from the environment or .env at deploy time.',
};

function describe(spec: DeployOptionSpec): string {
  return `${spec.description['zh-TW']}\n\n${spec.description.en}`;
}

function schemaFor(spec: DeployOptionSpec): JsonSchema {
  const pattern = spec.pattern ? { pattern: spec.pattern.source } : {};
  let schema: JsonSchema;
  switch (spec.type) {
    case 'string':
    case 'pubkey':
      schema = { type: 'string', ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}), ...pattern };
      break;
    case 'https-url':
      schema = { type: 'string', format: 'uri', pattern: '^https://', ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}) };
      break;
    case 'integer':
      schema = { type: 'integer', ...(spec.range ? { minimum: spec.range.min, maximum: spec.range.max } : {}) };
      break;
    case 'boolean':
      schema = { type: 'boolean' };
      break;
    case 'enum':
      schema = { type: 'string', enum: [...(spec.enum ?? [])] };
      break;
    case 'string-list':
    case 'pubkey-list':
      schema = { type: 'array', items: { type: 'string', ...pattern }, ...(spec.maxItems !== undefined ? { maxItems: spec.maxItems } : {}) };
      break;
    case 'secret-ref':
      schema = { $ref: '#/$defs/secretRef' };
      break;
    case 'string-or-secret-ref':
      schema = { oneOf: [{ type: 'string', ...pattern }, { $ref: '#/$defs/secretRef' }] };
      break;
    case 'record':
      schema = { ...(spec.schema ?? { type: 'object' }) };
      break;
  }
  if (spec.type === 'integer' && spec.path === 'configVersion') schema = { const: DEPLOY_CONFIG_VERSION };
  return { ...schema, ...(spec.default !== undefined ? { default: spec.default } : {}), description: describe(spec) };
}

/** 產生設定檔的 JSON Schema（draft 2020-12）。所有層級都不接受未知的鍵：打錯字要看得見。 */
export function deployConfigJsonSchema(): JsonSchema {
  const root: JsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    // 公開 repo 裡這份檔案的網址（SDK ADR 0112；之前是 URN，ADR 0050 §8）
    $id: 'https://raw.githubusercontent.com/VaalRL/cinderous-sdk/main/schema/cinderous.config.schema.json',
    title: 'cinderous.config.json',
    description:
      'Cinderous 中繼的部署設定（SDK ADR 0050）：所有選擇的單一真實來源；秘密只以 { "$env": "NAME" } 引用。\n\n' +
      'Deployment settings for a Cinderous relay (SDK ADR 0050): the single source of truth for every choice; secrets are referenced as { "$env": "NAME" } only.',
    type: 'object',
    additionalProperties: false,
    required: ['configVersion', 'target'],
    properties: { $schema: { type: 'string', description: '給編輯器用的 JSON Schema 位置。\n\nJSON Schema location for editors.' } } as Record<string, JsonSchema>,
    // home-tunnel 必填的欄位（其他條件規則由 validateDeployConfig 檢查）
    allOf: [
      {
        if: { properties: { target: { const: 'home-tunnel' } }, required: ['target'] },
        then: {
          required: ['tunnel', 'secrets'],
          properties: { tunnel: { required: ['hostname'] }, secrets: { required: ['tunnelToken'] } },
        },
      },
    ],
    $defs: { secretRef: SECRET_REF_SCHEMA },
  };
  for (const spec of DEPLOY_OPTION_SPECS) {
    const parts = spec.path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const props = node.properties as Record<string, JsonSchema>;
      props[part] ??= { type: 'object', additionalProperties: false, properties: {} };
      node = props[part]!;
    }
    (node.properties as Record<string, JsonSchema>)[parts[parts.length - 1]!] = schemaFor(spec);
  }
  // target 的列舉與型別保持一致
  ((root.properties as Record<string, JsonSchema>).target as JsonSchema).enum = [...DEPLOY_TARGETS];
  return root;
}

/** 提交進 repo 的 schema 檔內容（固定格式，測試比對用）。 */
export function renderDeployConfigJsonSchema(): string {
  return `${JSON.stringify(deployConfigJsonSchema(), null, 2)}\n`;
}
