// 建立 Cloudflare API Token 的步驟說明（SDK ADR 0022）：純資料，外掛設定頁直接渲染。
//
// 這份資料是步驟文字的唯一來源：兩個 Obsidian 外掛的設定頁都從這裡取，README 與
// docs/guides/cloudflare-api-token.md 的內容與它一致。權限標籤、Token 名稱與網址都從
// `REQUIRED_TOKEN_PERMISSIONS`／`DEFAULT_TOKEN_NAME`／`buildTokenCreationUrl()` 帶入，不重複寫死。
// 🔴 這個檔案在 `./deploy/cloudflare-api` 的模組圖裡：不得引用任何 Node 內建模組。
//
// 介面名稱（「Continue to summary」「Create Token」…）照 Cloudflare 英文介面原文；
// 流程依官方文件 https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
import { buildTokenCreationUrl, DEFAULT_TOKEN_NAME, REQUIRED_TOKEN_PERMISSIONS } from './auth.js';
import { CLOUDFLARE_ERROR_KINDS } from './http.js';
export const TOKEN_GUIDE_LOCALES = ['zh-TW', 'en'];
/** 步驟「貼回來並部署」裡的應用名稱預設值：目前的使用者是兩個 Obsidian 外掛（ADR 0022） */
export const DEFAULT_GUIDE_APP_NAME = 'Obsidian';
const SIGN_UP_URL = 'https://dash.cloudflare.com/sign-up';
const API_TOKENS_URL = 'https://dash.cloudflare.com/profile/api-tokens';
const PRICING_URL = 'https://developers.cloudflare.com/workers/platform/pricing/';
function zhTW(appName, tokenName, permissions, links) {
    const permissionList = permissions.join('、');
    return {
        locale: 'zh-TW',
        tokenName,
        links,
        prerequisites: [`一個 Cloudflare 帳號（免費方案即可）。還沒有的話，到 ${links.signUp} 註冊並完成 email 驗證。`],
        steps: [
            {
                id: 'prepare',
                title: '事前準備',
                body: `準備好一個 Cloudflare 帳號（免費方案即可）。還沒有的話，先到 ${links.signUp} 註冊，並完成 email 驗證。`,
            },
            {
                id: 'open-token-page',
                title: '開啟 Cloudflare 的 Token 建立頁',
                body: '按「建立 Cloudflare Token」。瀏覽器會開啟 Cloudflare 的「建立 API Token」頁，權限已預先填好。還沒登入的話會先要求登入，登入後會回到這一頁。',
            },
            {
                id: 'check-permissions',
                title: '確認預填的名稱與權限',
                body: `確認已自動填好：Token 名稱「${tokenName}」；Permissions 兩列：${permissionList}。不要新增其他權限。`,
                permissions,
            },
            {
                id: 'account-resources',
                title: '選擇帳號範圍（Account Resources）',
                body: '預設是「All accounts」。只有一個帳號的話可以不改；有多個帳號時，建議改成「Include → 你要部署的那個帳號」，讓權限範圍最小。Zone Resources 不需要設定：中繼不需要任何網域權限。',
            },
            {
                id: 'ttl',
                title: '（建議）設定到期日',
                body: '在 TTL 設一個很近的到期日（例如明天）。這把 Token 只用來部署這一次，到期會自動失效，比較安全。Client IP Address Filtering 留空。',
            },
            {
                id: 'create',
                title: '檢查摘要並建立',
                body: `按「Continue to summary」，確認摘要裡只有上面兩項權限（${permissionList}），再按「Create Token」。`,
            },
            {
                id: 'copy',
                title: '複製 Token',
                body: '畫面會顯示 Token。它只會顯示這一次，關掉就看不到了。按「Copy」複製。',
            },
            {
                id: 'paste-and-deploy',
                title: '貼回來並部署',
                body: `回到 ${appName}，把 Token 貼到「Cloudflare API Token」欄位，按「部署」。外掛會先驗證 Token，再依序確認 workers.dev 子網域、上傳中繼、開啟 workers.dev 路由、做健康檢查。通常數秒到半分鐘完成，完成後會自動填入 wss://…workers.dev 的中繼網址。如果外掛請你選帳號或取一個子網域名稱，請看下方的常見問題。`,
            },
            {
                id: 'clean-up',
                title: '部署完成後刪除 Token',
                body: `外掛不會保存 Token。建議回到 Cloudflare 的 API Tokens 頁（${links.apiTokens}）把這把 Token 刪除。之後要重新部署時再建立一把新的；重新部署是安全的，不會清掉既有設定。`,
            },
        ],
        troubleshooting: {
            'token-invalid': {
                symptom: '顯示 Token 無效或無法使用。',
                cause: 'Token 沒有複製完整、已經過期，或已經在 Cloudflare 刪除或停用。',
                fix: '按「建立 Cloudflare Token」重新建立一把，完整複製後再貼上。',
            },
            permission: {
                symptom: '顯示權限不足，或 Token 看不到任何帳號。',
                cause: `建立時權限列被改動或刪掉了，或 Account Resources 沒有包含你的帳號。需要的權限是：${permissionList}。`,
                fix: '用外掛的「建立 Cloudflare Token」按鈕重新開啟預填頁，不要改動權限列，確認 Account Resources 包含要部署的帳號，再建立一把新的。',
            },
            'account-ambiguous': {
                symptom: '外掛列出好幾個帳號，請你選擇。',
                cause: '這把 Token 可以使用不只一個 Cloudflare 帳號，外掛不知道要部署到哪一個。',
                fix: '在清單中選擇要部署的帳號後再部署一次。也可以在第 3 步把 Account Resources 限定成單一帳號，重新建立 Token。',
            },
            'subdomain-missing': {
                symptom: '外掛請你輸入 workers.dev 子網域名稱。',
                cause: '這個帳號還沒有 workers.dev 子網域。新帳號第一次使用 Workers 時會發生。',
                fix: '輸入想要的子網域名稱（全球唯一，只能用小寫英文字母、數字與連字號），它會成為中繼網址 <中繼名稱>.<子網域>.workers.dev 的一部分，之後很少需要改。也可以先到 Cloudflare 儀表板的 Workers 頁面設定好再回來部署。',
            },
            'name-conflict': {
                symptom: '顯示名稱衝突。',
                cause: '帳號裡已經有一支同名、但不是 Cinderous 中繼的 Worker；或是你輸入的 workers.dev 子網域已經被別人使用。',
                fix: '換一個中繼名稱（Worker 名稱）再部署；如果是子網域被佔用，換一個子網域名稱。外掛不會覆蓋別的 Worker。',
            },
            quota: {
                symptom: '顯示超過額度或請求太頻繁。',
                cause: '帳號的 Worker 數量或腳本大小到了方案上限，或短時間內呼叫 Cloudflare API 太多次。',
                fix: '等幾分鐘再試。如果是 Worker 數量到上限，到 Cloudflare 儀表板刪掉不用的 Worker，或查看自己的方案。',
            },
            network: {
                symptom: '顯示連不到 Cloudflare。',
                cause: '裝置沒有網路，或網路（公司防火牆、VPN、代理）擋住了 api.cloudflare.com。',
                fix: '確認網路連線後再按一次「部署」。重新部署是安全的。',
            },
            'lane-change': {
                symptom: '重新部署時顯示「已知租戶名單與線上的不同」或「私人路徑與線上的不同」，沒有上傳。',
                cause: '這次部署的應用車道名單（appLanes）或私人路徑（privateLane）和目前線上的不一樣。每條車道各有一個儲存空間（Durable Object），換了就換到新的空間，舊空間裡還沒同步的資料不會搬過去，要等它自然到期；換了私人路徑，舊的中繼網址就不能再寫入（應用程式有設定唯讀寬限期時，到期前還能讀，之後失效）。',
                fix: '通常只要用和上次一樣的名單或私人路徑重新部署即可（例如在已經有這個中繼網址的裝置上部署）。確定要變更時（例如私人網址外洩要換新的），在應用程式裡確認變更（allowLaneChange）後再部署；應用程式支援搬家通知時（例如 CinderSync）其他裝置會自動改用新網址，否則要讓每台裝置改用新網址、重新同步一次。',
            },
            'worker-download': {
                symptom: '部署一開始就顯示下載中繼程式失敗，沒有上傳任何東西。',
                cause: '外掛在部署時才下載中繼程式（不打包在外掛裡），但裝置沒有網路，或網路擋住了下載的網址。',
                fix: '確認網路連線後再按一次「部署」。重新部署是安全的。',
            },
            'worker-integrity': {
                symptom: '顯示下載到的中繼程式跟預期的不一樣，沒有部署。',
                cause: '下載到的檔案跟外掛記錄的指紋（SHA-256）不符：下載被中途改過、網路設備（例如公司代理）改寫了內容，或下載網址上的檔案被換掉了。為了安全，外掛不會部署它。',
                fix: '換一個網路（例如手機熱點）再試一次。一直出現的話，請回報給外掛作者，不要改用其他來源的中繼程式。',
            },
            health: {
                symptom: '上傳完成，但健康檢查沒過。',
                cause: '中繼已經上傳，但還沒在 Cloudflare 的網路上生效。外掛會自動重試約 1 分鐘（預設 20 次、每次間隔 3 秒）；新註冊的 workers.dev 子網域，DNS 可能要幾分鐘才生效。',
                fix: '等幾分鐘後再按一次「部署」。重新部署是安全的，不會清掉既有設定；外掛要等健康檢查通過才會填入中繼網址。',
            },
            api: {
                symptom: '顯示 Cloudflare API 失敗，並附上 Cloudflare 的錯誤碼。',
                cause: 'Cloudflare 回了其他錯誤，例如服務暫時異常或帳號狀態特殊。',
                fix: '稍後再試一次。持續失敗的話，記下錯誤碼與訊息回報問題，或到 Cloudflare 的狀態頁確認服務狀況。',
            },
        },
        notes: [
            'Cloudflare 介面語言是中文時，按鈕會顯示對應的中文譯名。',
            `費用以 Cloudflare 官方方案為準（${links.pricing}）。Workers 與 SQLite 型 Durable Objects 都有免費方案，個人使用的中繼通常在免費額度內。`,
            '重新部署是安全的：已套用的設定不會重送，也不會清掉既有設定。',
            '也可以不部署，直接在設定頁填入既有的中繼網址（wss://…）。',
        ],
    };
}
function en(appName, tokenName, permissions, links) {
    const permissionList = permissions.join(' and ');
    return {
        locale: 'en',
        tokenName,
        links,
        prerequisites: [`A Cloudflare account (the free plan is enough). If you don't have one, sign up at ${links.signUp} and verify your email.`],
        steps: [
            {
                id: 'prepare',
                title: 'Before you start',
                body: `You need a Cloudflare account (the free plan is enough). If you don't have one, sign up at ${links.signUp} and verify your email address.`,
            },
            {
                id: 'open-token-page',
                title: 'Open the Cloudflare token page',
                body: 'Click "Create Cloudflare token". Your browser opens Cloudflare\'s "Create API Token" page with the permissions already filled in. If you are not signed in, Cloudflare asks you to sign in first and then returns to that page.',
            },
            {
                id: 'check-permissions',
                title: 'Check the pre-filled name and permissions',
                body: `Check that these are already filled in: Token name "${tokenName}"; two Permissions rows: ${permissionList}. Do not add any other permissions.`,
                permissions,
            },
            {
                id: 'account-resources',
                title: 'Choose the account scope (Account Resources)',
                body: 'The default is "All accounts". If you have only one account you can leave it. If you have several, we recommend "Include → the account you want to deploy to", so the token can do as little as possible. Leave Zone Resources alone: the relay does not need any zone (domain) permissions.',
            },
            {
                id: 'ttl',
                title: '(Recommended) Set an expiry',
                body: 'Set TTL to a date very soon (for example, tomorrow). The token is only needed for this one deployment, so letting it expire automatically is safer. Leave Client IP Address Filtering empty.',
            },
            {
                id: 'create',
                title: 'Review the summary and create',
                body: `Click "Continue to summary", check that the summary lists only the two permissions above (${permissionList}), then click "Create Token".`,
            },
            {
                id: 'copy',
                title: 'Copy the token',
                body: 'Cloudflare shows the token. It is shown only once; you cannot see it again after leaving the page. Click "Copy".',
            },
            {
                id: 'paste-and-deploy',
                title: 'Paste it back and deploy',
                body: `Back in ${appName}, paste the token into the "Cloudflare API token" field and click "Deploy". The plugin verifies the token, then checks your workers.dev subdomain, uploads the relay, enables the workers.dev route and runs a health check. This usually takes a few seconds to half a minute. When it finishes, the wss://…workers.dev relay URL is filled in for you. If the plugin asks you to pick an account or choose a subdomain name, see Troubleshooting below.`,
            },
            {
                id: 'clean-up',
                title: 'Delete the token afterwards',
                body: `The plugin does not store the token. We recommend deleting it on Cloudflare's API Tokens page (${links.apiTokens}). Create a new one whenever you want to redeploy; redeploying is safe and does not wipe your existing setup.`,
            },
        ],
        troubleshooting: {
            'token-invalid': {
                symptom: 'The token is reported as invalid or unusable.',
                cause: 'The token was not copied completely, has expired, or was deleted or disabled in Cloudflare.',
                fix: 'Click "Create Cloudflare token" to create a new one, copy all of it, and paste it again.',
            },
            permission: {
                symptom: 'Permission denied, or the token cannot see any account.',
                cause: `The permission rows were changed or removed while creating the token, or Account Resources does not include your account. The required permissions are: ${permissionList}.`,
                fix: 'Use the plugin\'s "Create Cloudflare token" button to reopen the pre-filled page, leave the permission rows as they are, make sure Account Resources includes the account you deploy to, and create a new token.',
            },
            'account-ambiguous': {
                symptom: 'The plugin lists several accounts and asks you to choose one.',
                cause: 'The token can use more than one Cloudflare account, so the plugin does not know where to deploy.',
                fix: 'Pick the account from the list and deploy again. Alternatively, limit Account Resources to a single account in step 3 and create a new token.',
            },
            'subdomain-missing': {
                symptom: 'The plugin asks you to enter a workers.dev subdomain name.',
                cause: 'This account has no workers.dev subdomain yet. This happens the first time a new account uses Workers.',
                fix: 'Enter the subdomain you want (globally unique; lowercase letters, digits and hyphens only). It becomes part of the relay URL <relay name>.<subdomain>.workers.dev and rarely needs changing. You can also set it up first on the Workers page of the Cloudflare dashboard and then deploy.',
            },
            'name-conflict': {
                symptom: 'A name conflict is reported.',
                cause: 'The account already has a Worker with the same name that is not a Cinderous relay, or the workers.dev subdomain you entered is already taken.',
                fix: 'Choose a different relay name (Worker name) and deploy again; if the subdomain is taken, choose a different subdomain. The plugin never overwrites another Worker.',
            },
            quota: {
                symptom: 'A quota or rate-limit error is reported.',
                cause: 'The account has reached its plan limit for the number of Workers or the script size, or too many Cloudflare API calls were made in a short time.',
                fix: 'Wait a few minutes and try again. If you hit the Worker limit, delete unused Workers in the Cloudflare dashboard or check your plan.',
            },
            network: {
                symptom: 'Cloudflare cannot be reached.',
                cause: 'The device is offline, or the network (a company firewall, VPN or proxy) blocks api.cloudflare.com.',
                fix: 'Check your connection and click "Deploy" again. Redeploying is safe.',
            },
            'lane-change': {
                symptom: 'Redeploying reports that the known app lanes or the private path differ from the live relay, and nothing is uploaded.',
                cause: 'The app lane list (appLanes) or the private path (privateLane) in this deployment differs from the one that is live. Each lane has its own storage (a Durable Object); changing it moves to new storage, and data still waiting in the old storage is not moved over — it expires on its own. Changing the private path also stops writes to the old relay URL (if the app sets a read-only grace period, the old URL stays readable until it expires, then stops working).',
                fix: 'Usually you just redeploy with the same list or private path as last time (for example, from a device that already has this relay URL). If you really want to change it (say, the private URL leaked), confirm the change in the app (allowLaneChange) and deploy again; apps that send a move notice (such as CinderSync) switch your other devices to the new URL automatically, otherwise switch every device to the new URL and let it sync once more.',
            },
            'worker-download': {
                symptom: 'Deploying stops right away saying the relay program could not be downloaded; nothing was uploaded.',
                cause: 'The plugin downloads the relay program when you deploy (it is not bundled in the plugin), but the device is offline or the network blocks the download address.',
                fix: 'Check your connection and click "Deploy" again. Redeploying is safe.',
            },
            'worker-integrity': {
                symptom: 'Deploying stops saying the downloaded relay program is not the expected one; nothing was deployed.',
                cause: 'The downloaded file does not match the fingerprint (SHA-256) recorded in the plugin: it was altered on the way, a network device (such as a company proxy) rewrote it, or the file at the download address was replaced. For safety the plugin does not deploy it.',
                fix: 'Try again on another network (for example a phone hotspot). If it keeps happening, report it to the plugin author; do not use a relay program from another source.',
            },
            health: {
                symptom: 'The upload finished but the health check did not pass.',
                cause: 'The relay was uploaded but is not live on Cloudflare\'s network yet. The plugin retries automatically for about a minute (20 attempts, 3 seconds apart by default); for a newly registered workers.dev subdomain, DNS can take a few minutes.',
                fix: 'Wait a few minutes and click "Deploy" again. Redeploying is safe and does not wipe your existing setup; the relay URL is filled in only after the health check passes.',
            },
            api: {
                symptom: 'A Cloudflare API error is reported, with Cloudflare\'s error code.',
                cause: 'Cloudflare returned some other error, for example a temporary service problem or an unusual account state.',
                fix: 'Try again later. If it keeps failing, note the error code and message and report the issue, or check Cloudflare\'s status page.',
            },
        },
        notes: [
            'If your Cloudflare dashboard is in another language, the buttons show the translated names.',
            `Pricing is whatever Cloudflare's official plans say (${links.pricing}). Workers and SQLite-backed Durable Objects both have a free plan; a personal relay usually stays within the free allowance.`,
            'Redeploying is safe: settings that are already applied are not re-sent, and your existing setup is not wiped.',
            'You can also skip deployment and enter an existing relay URL (wss://…) in settings.',
        ],
    };
}
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value))
            deepFreeze(child);
    }
    return value;
}
/**
 * 產生步驟說明。只有自訂 Token 名稱（也就是呼叫 `buildTokenCreationUrl({ name })`）或
 * 應用名稱（「回到 ___，把 Token 貼到…」）時才需要；一般直接用 `CLOUDFLARE_TOKEN_SETUP_GUIDE`。
 */
export function buildCloudflareTokenSetupGuide(opts = {}) {
    const tokenName = opts.tokenName ?? DEFAULT_TOKEN_NAME;
    const appName = opts.appName ?? DEFAULT_GUIDE_APP_NAME;
    const permissions = Object.freeze(REQUIRED_TOKEN_PERMISSIONS.map((p) => p.label));
    const links = {
        signUp: SIGN_UP_URL,
        createToken: buildTokenCreationUrl(opts.tokenName === undefined ? {} : { name: tokenName }),
        apiTokens: API_TOKENS_URL,
        pricing: PRICING_URL,
    };
    const guide = { 'zh-TW': zhTW(appName, tokenName, permissions, { ...links }), en: en(appName, tokenName, permissions, { ...links }) };
    for (const locale of TOKEN_GUIDE_LOCALES) {
        const missing = CLOUDFLARE_ERROR_KINDS.filter((kind) => !(kind in guide[locale].troubleshooting));
        if (missing.length > 0)
            throw new Error(`${locale} 缺少疑難排解：${missing.join(', ')}`);
    }
    return deepFreeze(guide);
}
/** 預設 Token 名稱（`DEFAULT_TOKEN_NAME`）的步驟說明，搭配 `buildTokenCreationUrl()`。 */
export const CLOUDFLARE_TOKEN_SETUP_GUIDE = buildCloudflareTokenSetupGuide();
//# sourceMappingURL=guide.js.map