<!--
  網頁部署設定器（SDK ADR 0142）：只是 src/deploy/config/web.ts 的薄殼。
  🔴 不發任何網路請求（沒有 fetch／XMLHttpRequest／WebSocket／sendBeacon）、選擇不進網址、不收秘密值、不存瀏覽器儲存空間；
  tests/site/web-configurator-page.test.ts 會掃這個檔案確認。
-->
<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import pkg from '../../../package.json';
import licenseText from '../../../LICENSE?raw';
import {
  dangerousChoices,
  type DeployConfig,
  type DeployTarget,
  setWebField,
  validateDeployConfig,
  webEstimate,
  webFieldText,
  webFormGroups,
  webInitialConfig,
  webOutputs,
  webSwitchTarget,
  webUnsupportedFields,
} from '../../../src/deploy/config/index.js';
import { DEPLOY_TARGETS } from '../../../src/deploy/config/types.js';

const props = defineProps<{ locale: 'en' | 'zh-TW' }>();
const zh = props.locale === 'zh-TW';
const t = (a: string, b: string): string => (zh ? a : b);
const sdkVersion: string = pkg.version;

const TARGET_LABELS: Record<DeployTarget, [string, string]> = {
  cloudflare: ['Cloudflare Workers（wrangler）', 'Cloudflare Workers (wrangler)'],
  'cloudflare-api': ['Cloudflare Workers（REST，給外掛／App 一鍵部署）', 'Cloudflare Workers (REST, for one-click deploy from a plugin/app)'],
  docker: ['Docker（VPS 或家中主機）', 'Docker (VPS or home server)'],
  fly: ['Fly.io', 'Fly.io'],
  'home-tunnel': ['家中主機＋Cloudflare Tunnel', 'Home server + Cloudflare Tunnel'],
};

const target = ref<DeployTarget>('cloudflare');
const advanced = ref(false);
const selfContained = ref(false);
const config = ref<Record<string, unknown>>(webInitialConfig(target.value, sdkVersion));
const raw = reactive<Record<string, string>>({});
const fieldError = reactive<Record<string, string>>({});
const confirmWord = reactive<Record<string, string>>({});
const confirmTyped = reactive<Record<string, string>>({});

// 換目標：新目標也有的欄位保留，沒有的丟掉並列出來（SDK ADR 0142；原本整份重來，已填的都會清掉）
const droppedOnSwitch = ref<string[]>([]);
function switchTarget(): void {
  const moved = webSwitchTarget(config.value, target.value, confirmTyped);
  config.value = moved.config;
  droppedOnSwitch.value = moved.dropped;
  for (const r of [raw, fieldError, confirmWord]) for (const k of Object.keys(r)) delete r[k];
  for (const k of moved.dropped) delete confirmTyped[k];
  selfContained.value = false;
}
watch(target, switchTarget);

const groups = computed(() => webFormGroups(target.value, advanced.value));
const unsupported = computed(() => webUnsupportedFields(target.value));
const isWorker = computed(() => target.value === 'cloudflare' || target.value === 'cloudflare-api');

function textOf(path: string): string {
  if (raw[path] !== undefined) return raw[path]!;
  const field = groups.value.flatMap((g) => g.fields).find((f) => f.spec.path === path);
  return field ? webFieldText(config.value, field.spec) : '';
}

function update(path: string, value: string): void {
  const field = groups.value.flatMap((g) => g.fields).find((f) => f.spec.path === path);
  if (!field) return;
  raw[path] = value;
  const r = setWebField(config.value, field.spec, value, confirmTyped[path]);
  if (r.ok) {
    config.value = r.config;
    delete fieldError[path];
    delete confirmWord[path];
  } else {
    fieldError[path] = r.message[props.locale];
    if (r.confirmWord !== undefined) confirmWord[path] = r.confirmWord;
  }
}

function confirm(path: string, typed: string): void {
  confirmTyped[path] = typed;
  if (raw[path] !== undefined) update(path, raw[path]!);
}

const issues = computed(() => validateDeployConfig(config.value, { sdkVersion }).issues);
const errors = computed(() => issues.value.filter((i) => i.severity === 'error'));
const warnings = computed(() => issues.value.filter((i) => i.severity !== 'error'));
const dangers = computed(() => (errors.value.length === 0 ? dangerousChoices(config.value as unknown as DeployConfig) : []));

// 預打包的中繼 Worker（約 190 KB）：只有勾了「自帶中繼」才載入（同網站的程式檔，不是對外請求）
const relayWorkerSource = shallowRef<string | undefined>(undefined);
watch(selfContained, async (on) => {
  if (on && relayWorkerSource.value === undefined) {
    relayWorkerSource.value = (await import('../../../src/deploy/cloudflare-api/relay-worker-bundle.js')).relayWorkerSource;
  }
});

const outputs = computed(() => {
  if (errors.value.length > 0) return undefined;
  if (selfContained.value && relayWorkerSource.value === undefined) return undefined;
  try {
    return webOutputs(config.value as unknown as DeployConfig, {
      sdkVersion,
      licenseText,
      ...(isWorker.value && selfContained.value ? { selfContained: true, relayWorkerSource: relayWorkerSource.value } : {}),
    });
  } catch {
    return undefined;
  }
});

function download(name: string, data: Uint8Array | string, type: string): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const copied = ref(false);
async function copyCommand(): Promise<void> {
  if (!outputs.value) return;
  await navigator.clipboard.writeText(outputs.value.command);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

// 成本試算（SDK ./estimator，只在本機算）
const est = reactive({ devicesCount: 2, collaboratorsCount: 3, dailyActionsCount: 200, averagePayloadBytes: 2000 });
const estimate = computed(() => webEstimate(target.value, { ...est }));
const fmt = (n: number): string => n.toLocaleString(props.locale);
</script>

<template>
  <div class="cwc">
    <p class="cwc-note">
      {{
        t(
          `這一頁在你的瀏覽器裡產生設定檔與部署包（SDK v${sdkVersion}）：不部署、不收秘密值、不送出任何資料（頁面不發網路請求，選擇也不會出現在網址裡）。秘密欄位只填環境變數的名稱，值之後放進 .env 或平台的 secret。`,
          `This page builds the config file and deployment package in your browser (SDK v${sdkVersion}). It does not deploy, does not take secret values, and sends nothing anywhere: the page makes no network requests and your choices never go into the URL. Secret fields take only an environment variable name; put the value in .env or the platform's secrets later.`,
        )
      }}
    </p>

    <section class="cwc-section">
      <h2>{{ t('1. 部署目標', '1. Where to deploy') }}</h2>
      <select v-model="target" data-field="target">
        <option v-for="d in DEPLOY_TARGETS" :key="d" :value="d">{{ zh ? TARGET_LABELS[d][0] : TARGET_LABELS[d][1] }}</option>
      </select>
      <p v-if="droppedOnSwitch.length > 0" class="cwc-desc" data-testid="dropped-on-switch">
        {{ t('這個目標沒有、或要重新確認的欄位已拿掉：', 'Removed (not available for this target, or needs confirming again):') }}
        <code v-for="p in droppedOnSwitch" :key="p" class="cwc-chip">{{ p }}</code>
      </p>
      <label class="cwc-inline"><input v-model="advanced" type="checkbox" /> {{ t('顯示進階選項', 'Show advanced options') }}</label>
      <label v-if="isWorker" class="cwc-inline">
        <input v-model="selfContained" type="checkbox" />
        {{ t('自帶中繼（附預打包的 Worker，不必安裝 SDK）', 'Self-contained (include the pre-bundled Worker; no SDK install)') }}
      </label>
    </section>

    <section class="cwc-section">
      <h2>{{ t('2. 選項', '2. Options') }}</h2>
      <details v-for="g in groups" :key="g.group" class="cwc-group" :open="!g.advanced">
        <summary>{{ g.label[locale] }}</summary>
        <div v-for="f in g.fields" :key="f.spec.path" class="cwc-field" :class="{ 'cwc-danger': f.dangerous }">
          <label :for="`cwc-${f.spec.path}`">
            <code>{{ f.spec.path }}</code>
            <span v-if="f.required" class="cwc-req">{{ t('必填', 'required') }}</span>
            <span v-if="f.dangerous" class="cwc-req">🔴 {{ t('危險', 'dangerous') }}</span>
          </label>
          <p class="cwc-desc">{{ f.spec.description[locale] }}</p>
          <input
            v-if="f.kind === 'checkbox'"
            :id="`cwc-${f.spec.path}`"
            type="checkbox"
            :checked="textOf(f.spec.path) === 'true'"
            @change="update(f.spec.path, ($event.target as HTMLInputElement).checked ? 'true' : 'false')"
          />
          <select
            v-else-if="f.kind === 'select'"
            :id="`cwc-${f.spec.path}`"
            :value="textOf(f.spec.path)"
            @change="update(f.spec.path, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('（預設）', '(default)') }}</option>
            <option v-for="o in f.spec.enum ?? []" :key="o" :value="o">{{ o }}</option>
          </select>
          <input
            v-else
            :id="`cwc-${f.spec.path}`"
            :type="f.kind === 'number' ? 'number' : 'text'"
            autocomplete="off"
            spellcheck="false"
            :value="textOf(f.spec.path)"
            :placeholder="
              f.kind === 'env-name'
                ? t('環境變數名稱，例如 MY_TOKEN', 'Environment variable name, e.g. MY_TOKEN')
                : f.kind === 'text-or-env'
                  ? t('值，或 $env:變數名稱', 'value, or $env:NAME')
                  : f.kind === 'list'
                    ? t('逗號分隔', 'comma-separated')
                    : f.spec.default !== undefined
                      ? t(`預設 ${f.spec.default}`, `default ${f.spec.default}`)
                      : ''
            "
            @change="update(f.spec.path, ($event.target as HTMLInputElement).value)"
          />
          <div v-if="confirmWord[f.spec.path]" class="cwc-confirm">
            {{ t(`要開的話輸入「${confirmWord[f.spec.path]}」：`, `Type "${confirmWord[f.spec.path]}" to turn it on:`) }}
            <input type="text" autocomplete="off" @change="confirm(f.spec.path, ($event.target as HTMLInputElement).value)" />
          </div>
          <p v-if="fieldError[f.spec.path]" class="cwc-error">✖ {{ fieldError[f.spec.path] }}</p>
        </div>
      </details>
      <p v-if="unsupported.length > 0" class="cwc-desc">
        {{ t('表單沒有的欄位（物件型別），要下載設定檔後直接改：', 'Not in this form (object-valued; edit the downloaded config file directly):') }}
        <code v-for="s in unsupported" :key="s.path" class="cwc-chip">{{ s.path }}</code>
      </p>
    </section>

    <section class="cwc-section">
      <h2>{{ t('3. 檢查', '3. Check') }}</h2>
      <p v-if="errors.length === 0" class="cwc-ok">✔ {{ t('設定沒有錯誤。', 'No errors.') }}</p>
      <ul>
        <li v-for="(i, n) in errors" :key="`e${n}`" class="cwc-error">✖ <code>{{ i.path }}</code> {{ i.message[locale] }}</li>
        <li v-for="(i, n) in warnings" :key="`w${n}`">⚠ <code>{{ i.path }}</code> {{ i.message[locale] }}</li>
      </ul>
      <div v-if="dangers.length > 0" class="cwc-danger-list">
        <strong>🔴 {{ t('開了這些危險選項（部署說明的安全檢查清單也會列出）：', 'Dangerous options turned on (also listed in the deployment guide checklist):') }}</strong>
        <code v-for="d in dangers" :key="d.path" class="cwc-chip">{{ d.path }}</code>
      </div>
    </section>

    <section class="cwc-section">
      <h2>{{ t('4. 下載', '4. Download') }}</h2>
      <template v-if="outputs">
        <div class="cwc-buttons">
          <button type="button" @click="download('cinderous.config.json', outputs.configText, 'application/json')">cinderous.config.json</button>
          <button type="button" @click="download(outputs.zipName, outputs.zip, 'application/zip')">
            {{ outputs.zipName }}{{ t(`（${outputs.files.length} 個檔案）`, ` (${outputs.files.length} files)`) }}
          </button>
        </div>
        <p class="cwc-desc">
          {{
            t(
              '或者把設定檔放在目前資料夾，用這一行在自己電腦上產生同一份部署包（之後照部署包裡的 README-DEPLOY.md 部署）：',
              'Or put the config file in the current folder and build the same package on your own machine (then follow README-DEPLOY.md in the package):',
            )
          }}
        </p>
        <pre class="cwc-cmd"><code>{{ outputs.command }}</code></pre>
        <button type="button" @click="copyCommand">{{ copied ? t('已複製', 'Copied') : t('複製指令', 'Copy command') }}</button>
      </template>
      <p v-else class="cwc-desc">{{ t('先修好上面的錯誤才能下載。', 'Fix the errors above to download.') }}</p>
    </section>

    <section class="cwc-section">
      <h2>{{ t('5. 成本試算（只在你的瀏覽器裡算）', '5. Cost estimate (computed in your browser)') }}</h2>
      <div class="cwc-est">
        <label>{{ t('每人裝置數', 'Devices per person') }} <input v-model.number="est.devicesCount" type="number" min="1" /></label>
        <label>{{ t('人數（含自己）', 'People (incl. you)') }} <input v-model.number="est.collaboratorsCount" type="number" min="1" /></label>
        <label>{{ t('每人每天動作數', 'Actions per person per day') }} <input v-model.number="est.dailyActionsCount" type="number" min="0" /></label>
        <label>{{ t('每次平均位元組', 'Average bytes per action') }} <input v-model.number="est.averagePayloadBytes" type="number" min="0" /></label>
      </div>
      <p v-if="estimate.error" class="cwc-error">✖ {{ estimate.error }}</p>
      <ul v-else-if="estimate.report">
        <li>{{ t('中繼月流量', 'Relay traffic per month') }}：{{ fmt(estimate.report.network.monthlyRelayBandwidthMB) }} MB</li>
        <template v-if="isWorker">
          <li>{{ t('Cloudflare 每日請求', 'Cloudflare requests per day') }}：{{ fmt(estimate.report.infrastructure.cloudflareDailyRequests) }}（{{ t('免費額度的', 'of the free tier:') }} {{ fmt(estimate.report.infrastructure.cloudflareFreeTierUsagePercent) }}%）</li>
          <li>{{ t('估計月費', 'Estimated monthly cost') }}：US$ {{ fmt(estimate.report.infrastructure.estimatedMonthlyCostUSD) }}</li>
        </template>
        <li v-for="(a, n) in estimate.report.architecturalAdvice" :key="n">💡 {{ a }}</li>
      </ul>
      <p class="cwc-desc">{{ t('試算只是決策參考，不是帳單（SDK ADR 0002）。', 'An estimate for planning, not a bill (SDK ADR 0002).') }}</p>
    </section>
  </div>
</template>

<style scoped>
.cwc-section { margin: 1.5rem 0; }
.cwc-note, .cwc-desc { font-size: 0.9em; color: var(--vp-c-text-2); }
.cwc-inline { display: block; margin-top: 0.5rem; }
.cwc-group { border: 1px solid var(--vp-c-divider); border-radius: 8px; padding: 0.5rem 1rem; margin: 0.75rem 0; }
.cwc-group summary { cursor: pointer; font-weight: 600; }
.cwc-field { margin: 1rem 0; }
.cwc-field input[type='text'], .cwc-field input[type='number'], .cwc-field select, .cwc-section > select {
  width: 100%; max-width: 32rem; padding: 0.3rem 0.5rem; border: 1px solid var(--vp-c-divider); border-radius: 6px; background: var(--vp-c-bg-soft);
}
.cwc-req { margin-left: 0.5rem; font-size: 0.8em; color: var(--vp-c-text-2); }
.cwc-danger { border-left: 3px solid var(--vp-c-danger-1); padding-left: 0.75rem; }
.cwc-confirm { margin-top: 0.4rem; font-size: 0.9em; }
.cwc-error { color: var(--vp-c-danger-1); }
.cwc-ok { color: var(--vp-c-green-1, var(--vp-c-brand-1)); }
.cwc-chip { margin: 0 0.25rem; }
.cwc-buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.cwc-section button { padding: 0.35rem 0.9rem; border: 1px solid var(--vp-c-brand-1); border-radius: 6px; color: var(--vp-c-brand-1); }
.cwc-cmd { overflow-x: auto; }
.cwc-est { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 0.5rem; }
.cwc-est input { width: 100%; padding: 0.25rem 0.4rem; border: 1px solid var(--vp-c-divider); border-radius: 6px; }
</style>
