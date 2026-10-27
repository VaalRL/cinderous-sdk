// 推播介面（SDK ADR 0011 §6；PRD 2.5.2、2.5.3）：預設關閉，只准送「空的喚醒訊號」。
//
// SDK 不實作 APNs／FCM 的註冊：那需要 App 自己的開發者帳號與原生程式碼。
// SDK 守住的是那條紅線——推播經過 Apple／Google 的伺服器，內容一律不得帶任何東西，
// 手機被喚醒後自己去中繼拉密文、在本機解開。

export type PushProviderType = 'disabled' | 'apns' | 'fcm' | 'unifiedpush';

export interface PushNotificationConfig {
  readonly provider: PushProviderType;
  /** 只做背景喚醒、不跳系統通知 */
  readonly silentWakeupOnly: boolean;
  readonly gatewayEndpoint?: string;
  readonly appBundleId?: string;
}

export interface IPushNotificationAdapter {
  readonly provider: PushProviderType;
  registerDevice(token: string): Promise<void>;
  unregisterDevice(): Promise<void>;
  onNotificationReceived(callback: (payload: unknown) => void): void;
}

/** 預設：不推播。完全靠 App 回到前景時的秒級水化（`FastHydrator`），零元資料外洩。 */
export class DisabledPushAdapter implements IPushNotificationAdapter {
  readonly provider = 'disabled' as const;

  async registerDevice(_token: string): Promise<void> {}

  async unregisterDevice(): Promise<void> {}

  onNotificationReceived(): void {}
}

/** 各廠商的喚醒訊號：只有「醒來」這個意思，沒有任何內容。 */
export function silentTicklePayload(provider: Exclude<PushProviderType, 'disabled'> | 'disabled'): Record<string, unknown> {
  switch (provider) {
    case 'apns':
      return { aps: { 'content-available': 1 } };
    case 'fcm':
      return { data: {} };
    case 'unifiedpush':
      return {};
    default:
      throw new Error('推播已關閉，沒有喚醒訊號');
  }
}

function sameShape(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b;
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * 零知識推播檢查（PRD 2.5.3）：推播內容必須**完全等於**該廠商的喚醒訊號。
 * 多一個欄位（標題、內文、寄件人、群組名）就丟例外——這些都會經過 Apple／Google 的伺服器。
 */
export function assertZeroKnowledgePush(provider: Exclude<PushProviderType, 'disabled'>, payload: unknown): void {
  if (!sameShape(payload, silentTicklePayload(provider))) {
    throw new Error('推播內容只能是空的喚醒訊號：不得帶標題、內文、寄件人或任何其他欄位');
  }
}
