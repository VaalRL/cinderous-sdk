// 部署設定參考頁（SDK ADR 0116）：從 `DEPLOY_OPTION_SPECS` 產生 docs/reference/ 的中英兩份 Markdown。
// 純函式、不讀檔：測試拿 src 的描述表比對已提交的檔案，`npm run docs:reference`（scripts/generate-deploy-reference.mjs）拿 dist 的寫檔。

/** 產生的檔案（相對 repo 根目錄） */
export const DEPLOY_REFERENCE_FILES = {
  en: 'docs/reference/deploy-options.md',
  'zh-TW': 'docs/reference/deploy-options.zh-TW.md',
};

const GROUP_ORDER = ['basic', 'access', 'vault', 'nip11', 'limits', 'lanes', 'capacity', 'host', 'secrets', 'push'];

const TEXT = {
  en: {
    title: 'Deploy configuration reference',
    generated: 'Generated from `DEPLOY_OPTION_SPECS` (`src/deploy/config/specs.ts`) by `npm run docs:reference`. Do not edit by hand.',
    other: '[繁體中文](deploy-options.zh-TW.md)',
    intro: [
      'Every option of `cinderous.config.json`, the file that holds all choices for one deployment ([ADR 0050](../adr/0050-deploy-configurator.md)). The same rules are in the JSON Schema, [`schema/cinderous.config.schema.json`](../../schema/cinderous.config.schema.json), exported as `@cinderous/client/config.schema.json`.',
      '```sh\nnpx cinderous init\nnpx cinderous config validate cinderous.config.json\nnpx cinderous relay build --config cinderous.config.json --out deploy/\nnpx cinderous relay deploy --config deploy/cinderous.config.json\n```',
      '- Options under `site.` are relay settings, the same as `RelaySiteOptions`.\n- **Flag** is the matching `cinderous relay deploy` flag; options without one can only be set in the config file.\n- **Environment variable** is what the relay itself reads, for when you run it without the CLI.\n- Secrets are never written into the config file, only as a reference: `{ "$env": "NAME" }`.',
    ],
    overview: 'Overview',
    cols: ['Option', 'Flag', 'Environment variable'],
    type: 'Type',
    values: 'Values',
    default: 'Default',
    flag: 'Flag',
    env: 'Environment variable',
    secret: 'Secret: only `{ "$env": "NAME" }` in the config file',
    defaultEnv: 'read from',
    hosts: 'Relay host',
    targets: 'Targets',
    services: 'Service',
    required: 'Required for',
    dangerous: '⚠️ **Dangerous**: `cinderous init` turns it on only after you type the option name, and the deploy guide lists it in the security checklist. Read the description above first.',
    sep: ': ',
    list: ', ',
    host: { worker: 'Cloudflare (Worker)', node: 'Node host' },
    types: {
      string: 'string',
      integer: 'integer',
      boolean: 'boolean',
      enum: 'one of',
      'string-list': 'list of strings',
      pubkey: 'public key (npub or hex)',
      'pubkey-list': 'list of public keys (npub or hex)',
      'https-url': 'https URL',
      'secret-ref': 'secret reference `{ "$env": "NAME" }`',
      'string-or-secret-ref': 'string, or `{ "$env": "NAME" }`',
      record: 'object (see the JSON Schema)',
    },
    atLeast: (n) => `at least ${n}`,
    maxLength: (n) => `at most ${n} characters`,
    maxItems: (n) => `at most ${n} items`,
    pattern: 'Format',
    groups: {
      basic: 'Basics',
      access: 'Access',
      vault: 'Vault sync',
      nip11: 'NIP-11 relay information',
      limits: 'Limits',
      lanes: 'App lanes (Cloudflare)',
      capacity: 'Storage capacity',
      host: 'Hosting',
      secrets: 'Secrets',
      push: 'Push gateway',
    },
  },
  'zh-TW': {
    title: '部署設定參考',
    generated: '由 `npm run docs:reference` 從 `DEPLOY_OPTION_SPECS`（`src/deploy/config/specs.ts`）產生，請勿手動修改。',
    other: '[English](deploy-options.md)',
    intro: [
      '`cinderous.config.json` 的每一個欄位。這個檔案記下一次部署的所有選擇（[ADR 0050](../adr/0050-deploy-configurator.md)）；同樣的規則也寫在 JSON Schema [`schema/cinderous.config.schema.json`](../../schema/cinderous.config.schema.json)（匯出為 `@cinderous/client/config.schema.json`）。',
      '```sh\nnpx cinderous init\nnpx cinderous config validate cinderous.config.json\nnpx cinderous relay build --config cinderous.config.json --out deploy/\nnpx cinderous relay deploy --config deploy/cinderous.config.json\n```',
      '- `site.` 底下是中繼的站台參數，與 `RelaySiteOptions` 相同。\n- **旗標**是 `cinderous relay deploy` 對應的旗標；沒有旗標的只能寫在設定檔。\n- **環境變數**是中繼自己讀的，不經過 CLI 直接跑中繼時用。\n- 秘密不寫進設定檔，只能寫參照：`{ "$env": "NAME" }`。',
    ],
    overview: '總覽',
    cols: ['欄位', '旗標', '環境變數'],
    type: '型別',
    values: '可用的值',
    default: '預設',
    flag: '旗標',
    env: '環境變數',
    secret: '秘密：設定檔只能寫 `{ "$env": "NAME" }`',
    defaultEnv: '沒給時讀',
    hosts: '中繼宿主',
    targets: '部署目標',
    services: '服務',
    required: '必填於',
    dangerous: '⚠️ **危險選項**：`cinderous init` 要打出選項名稱才會開，部署說明也會把它列進安全檢查清單。開之前先讀完上面的說明。',
    sep: '：',
    list: '，',
    host: { worker: 'Cloudflare（Worker）', node: 'Node 主機' },
    types: {
      string: '字串',
      integer: '整數',
      boolean: '布林值',
      enum: '其中之一',
      'string-list': '字串清單',
      pubkey: '公鑰（npub 或 hex）',
      'pubkey-list': '公鑰清單（npub 或 hex）',
      'https-url': 'https 網址',
      'secret-ref': '秘密參照 `{ "$env": "NAME" }`',
      'string-or-secret-ref': '字串，或 `{ "$env": "NAME" }`',
      record: '物件（見 JSON Schema）',
    },
    atLeast: (n) => `至少 ${n}`,
    maxLength: (n) => `最長 ${n} 字`,
    maxItems: (n) => `最多 ${n} 項`,
    pattern: '格式',
    groups: {
      basic: '基本',
      access: '存取',
      vault: 'Vault 同步',
      nip11: 'NIP-11 站台資訊',
      limits: '上限',
      lanes: '車道（Cloudflare）',
      capacity: '儲存容量',
      host: '宿主',
      secrets: '秘密',
      push: '推播閘道',
    },
  },
};

const code = (s) => `\`${s}\``;

/** 反引號以外的 `<`、`>` 跳脫：說明裡的 `<id>` 這類佔位符在 GitHub 會被當成 HTML 吃掉 */
function prose(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replaceAll('<', '&lt;').replaceAll('>', '&gt;')))
    .join('');
}

function typeLine(spec, t) {
  const parts = [t.types[spec.type] ?? spec.type];
  const { range } = spec;
  if (range) parts.push(range.max === Number.MAX_SAFE_INTEGER ? t.atLeast(range.min) : range.min === range.max ? String(range.min) : `${range.min}–${range.max}`);
  if (spec.maxLength !== undefined) parts.push(t.maxLength(spec.maxLength));
  if (spec.maxItems !== undefined) parts.push(t.maxItems(spec.maxItems));
  return parts.join(t.list);
}

function section(spec, t) {
  const lines = [`### ${code(spec.path)}`, '', prose(spec.description[t === TEXT.en ? 'en' : 'zh-TW']), ''];
  const item = (label, value) => lines.push(`- ${label}${t.sep}${value}`);
  item(t.type, typeLine(spec, t));
  if (spec.enum) item(t.values, spec.enum.map(code).join(', '));
  if (spec.pattern) item(t.pattern, code(spec.pattern.source));
  if (spec.default !== undefined) item(t.default, code(String(spec.default)));
  if (spec.flag) item(t.flag, code(`--${spec.flag}`));
  if (spec.env) item(t.env, code(spec.env));
  if (spec.secret) lines.push(`- ${t.secret}${spec.defaultEnv ? `; ${t.defaultEnv} ${code(spec.defaultEnv)}` : ''}`);
  else if (spec.defaultEnv) item(t.defaultEnv, code(spec.defaultEnv));
  if (spec.hosts) item(t.hosts, spec.hosts.map((h) => t.host[h]).join(', '));
  if (spec.targets) item(t.targets, spec.targets.map(code).join(', '));
  if (spec.services) item(t.services, spec.services.map(code).join(', '));
  if (spec.requiredFor) item(t.required, spec.requiredFor.map(code).join(', '));
  if (spec.dangerous) lines.push('', t.dangerous);
  lines.push('');
  return lines.join('\n');
}

/** 整頁 Markdown（`lang`：`en` 或 `zh-TW`） */
export function renderDeployReference(specs, lang) {
  const t = TEXT[lang];
  const groups = [...new Set([...GROUP_ORDER, ...specs.map((s) => s.group)])].filter((g) => specs.some((s) => s.group === g));
  const out = [`# ${t.title}`, '', `> ${t.generated}`, '', t.other, '', ...t.intro.flatMap((p) => [p, '']), `## ${t.overview}`, ''];
  out.push(`| ${t.cols.join(' | ')} |`, '| --- | --- | --- |');
  for (const s of specs) out.push(`| ${code(s.path)} | ${s.flag ? code(`--${s.flag}`) : '—'} | ${s.env ? code(s.env) : '—'} |`);
  out.push('');
  for (const g of groups) {
    out.push(`## ${t.groups[g] ?? g}`, '');
    for (const s of specs.filter((x) => x.group === g)) out.push(section(s, t));
  }
  return `${out.join('\n').trimEnd()}\n`;
}
