/**
 * `@cinderous/client/iot`（SDK ADR 0049 P0）：IoT 的共用協定、手機端 `IotClient` 與閘道核心 `IotGateway`。
 *
 * 平台無關（零 Node 內建模組、不含任何 MQTT 程式；守門測試 tests/iot/subpath.test.ts）。連到 MQTT broker 的家中橋接器在
 * `@cinderous/client/iot/bridge`（Node，mqtt.js 為選用 peer 相依）。
 *
 * - 協定：家庭秘密以 HKDF 衍生 `homeKey`／`homePub`（NIP-44 收件者）、`topicKey`（HMAC 盲化）、`homeTag`；kind 25170 操作、
 *   25171 ack、25172 即時狀態、25173 查詢、31170 retained、31171 心跳；去重與重放保護、指令存活（NIP-40）、retained 打包、
 *   MQTT 樣式比對（`+`、`#`）。
 * - 角色權限：viewer／operator／owner，依設備／topic 細分、`minRole`、`confirm`；名單只以閘道本地為準，只有 owner 能經 `$sys/acl` 修改。
 * - 推播（§11.1）：端點登記格式（UnifiedPush 網址，或推播閘道網址＋token 封包）、`$sys/push`、訂閱（盲化設備 id＋標準／即時）、
 *   送出端的「合併＋抖動」排程器、空的喚醒請求與簽章。參考推播閘道在 `@cinderous/client/iot/push-gateway`（不在這裡）。
 */
export * from './kinds.js';
export * from './keys.js';
export * from './topic.js';
export * from './content.js';
export * from './acl.js';
export * from './replay.js';
export * from './envelope.js';
export * from './device-frame.js';
export * from './retained.js';
export * from './push.js';
export * from './push-registry.js';
export * from './push-scheduler.js';
export { iotQuery, iotPublish, iotVerified, type IotTransport, type IotPublishOutcome } from './transport.js';
export * from './gateway.js';
export * from './client.js';
export { RelayEventBudget, relayEventsPerMinute, sharedRelayEventBudget, type RelayEventBudgetOptions } from '../relay-budget.js';
export type { NostrSigner } from '../protocol/signer.js';
