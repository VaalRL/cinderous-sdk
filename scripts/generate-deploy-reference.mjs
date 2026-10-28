// 重新產生部署設定參考頁（SDK ADR 0116）：`npm run docs:reference`。讀 dist 的描述表（先 npm run build）。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEPLOY_OPTION_SPECS } from '../dist/deploy/config/index.js';
import { DEPLOY_REFERENCE_FILES, renderDeployReference } from '../site/deploy-reference.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const [lang, file] of Object.entries(DEPLOY_REFERENCE_FILES)) {
  writeFileSync(`${root}${file}`, renderDeployReference(DEPLOY_OPTION_SPECS, lang));
  console.log(`wrote ${file}`);
}
