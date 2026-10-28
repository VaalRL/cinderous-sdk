// 由 scripts/build-relay-worker-bundle.mjs 產生（SDK ADR 0094），不要手改；`npm run build` 會重新產生。
/** 打包這份 Worker 時的 SDK 版號；部署時預設寫進 NIP-11 `version`。 */
export const relayWorkerSdkVersion = "0.83.0";
/** 打包好的 Worker（`relayWorkerSource`）UTF-8 位元組的 SHA-256（十六進位）：部署時才下載 Worker 的外掛拿它比對 */
export const relayWorkerSha256 = "746bbd33bd9332a1a875e68278e5f7207eb0cd21735821d247d7aaeb445e90d8";
//# sourceMappingURL=relay-worker-info.js.map