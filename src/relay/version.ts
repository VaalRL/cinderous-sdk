/**
 * 中繼寫進 NIP-11 `version` 欄位的版號（Cinderous ADR-0260／0356；SDK ADR 0007）。
 *
 * 這是**部署者的版號**，不是 SDK 的：Cinderous App 的「一鍵更新節點」比的是 App 自己的版本。
 * 所以由宿主在載入時注入（Worker 跑在沒有檔案系統的 runtime，版號得在打包時就固定在程式碼裡）。
 */
let current = '0.0.0';

export function relayVersion(): string {
  return current;
}

/** 宿主在載入時呼叫一次（例如 Cinderous 的 Worker 進入點帶入 App 版號）。 */
export function setRelayVersion(version: string): void {
  current = version;
}
