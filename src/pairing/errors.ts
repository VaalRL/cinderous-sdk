// 配對的錯誤分類（SDK ADR 0028）。外掛依 `reason` 顯示對應的提示。
export type PairingFailure =
  /** QR 字串格式不對 */
  | 'bad-uri'
  /** QR 的協定版本比這版 SDK 新 */
  | 'unsupported-version'
  /** QR 已過期（請重新產生） */
  | 'expired'
  /** 握手或使用者確認逾時 */
  | 'timeout'
  /** 握手逾時，而配對用的每一座主要中繼都暫時不能用（1013：額度用完等；SDK ADR 0108）——不是另一台沒回應 */
  | 'relay-unavailable'
  /** 有第二台裝置拿同一個 QR 來配對（QR 可能被別人拍到）；這次配對作廢，請重新產生 */
  | 'contested'
  /** 本機使用者按了「不符／取消」 */
  | 'rejected'
  /** 對方取消或拒絕 */
  | 'peer-rejected'
  /** 收到驗證不過的訊息（可能被竄改） */
  | 'bad-message'
  /** 這把公鑰已被撤銷，不能再加入（請在那台裝置重設身分） */
  | 'revoked-device'
  /** 裝置識別碼和 Vault 裡另一台裝置相同 */
  | 'device-id-conflict'
  /** 這一側的角色不對（例如 invite QR 被已經是成員的一方拿來當新裝置、或缺少 membership） */
  | 'wrong-role'
  /** 應用呼叫了 `cancel()` */
  | 'cancelled';

export class PairingError extends Error {
  readonly reason: PairingFailure;

  constructor(reason: PairingFailure, message?: string) {
    super(message ?? reason);
    this.name = 'PairingError';
    this.reason = reason;
  }
}

export function isPairingError(error: unknown): error is PairingError {
  return error instanceof Error && error.name === 'PairingError' && typeof (error as PairingError).reason === 'string';
}
