# 0137. 一次性秘密寫進 `.secrets/`：`--save-secrets`／`--secrets-dir`；隱藏輸入不做

- 狀態：**已接受（Accepted，2026-11-18）**——使用者 2026-11-18：「還沒做的功能 可以先做」（ADR 0050 P1 剩下的項目）
- 日期：2026-11-18
- 對應：SDK ADR 0050（部署設定器 §4「IoT 設備權杖……原文只印一次或寫進 `.secrets/`」、P1 清單）、0117（精靈；它的〈不做（這次）〉列了本 ADR 處理的項目）、0118（已做掉 `config migrate` 與 REST `secret_text`）、0121／0122／0123（`iot realtime` 的指令）、0049 §11.1（推播閘道私鑰）

## Context

ADR 0117〈不做（這次）〉列了 ADR 0050 P1 還沒做的四件事：`config migrate`、`cloudflareApiOptionsFromConfig`＋REST `secret_text`、隱藏輸入、`.secrets/`。盤點後：

- **`config migrate`、`cloudflareApiOptionsFromConfig`＋`secret_text`：ADR 0118（v0.79.0）已經做完**，只是 0117 的那段沒回寫，看起來像還沒做。
- **`.secrets/`：沒做。** ADR 0050 §4 的設計是一次性秘密「原文只印一次**或**寫進 `.secrets/`」，實作只有「印」這條路。會印出秘密的指令有七個：`iot keygen`（家庭秘密、閘道私鑰）、`iot push-keygen`（推播閘道私鑰）、`iot realtime home`（新家庭、`--rotate-gateway`、`--rotate-secret`：閘道私鑰整份、operator 秘密、新家庭秘密、每台設備的金鑰）、`iot realtime device`（新設備、`--rotate`、`--new-token`：權杖、設備金鑰、門鎖的 down 金鑰）。印在終端的秘密會留在捲動紀錄、終端機記錄檔、CI 日誌與螢幕分享裡；README 的範例 `npx cinderous iot keygen > .env` 是使用者自己重導，但重導會把說明行一起寫進 `.env`，而且 `>` 會覆寫既有的 `.env`。
- **隱藏輸入：仍然不需要。** 見 Decision 2。

## Decision

### 1. `--save-secrets`／`--secrets-dir <目錄>`

上面七種情況的指令都多兩個旗標：`--save-secrets`（寫到 `cwd/.secrets/`）與 `--secrets-dir <目錄>`（相對路徑以 cwd 為準；給了就等於開了 `--save-secrets`）。

- **哪些行是秘密**：`NAME=value` 且 `NAME` 在 `SECRET_ENV_NAMES`（`IOT_HOME_SECRET`、`IOT_GATEWAY_KEY`、`IOT_GATEWAY_KEYS`、`IOT_OPERATOR_SECRET`、`IOT_DEVICE_TOKEN`、`IOT_DEVICE_KEY`、`IOT_DEVICE_KEY_DOWN`、`PUSH_GATEWAY_KEY`）。這些行不印在終端。說明行與公開值（設備 id、blindId、kid、手機端的 `IOT_PHONE_DEVICES`、閘道公鑰）照舊印。
- **檔案內容**：整段輸出（說明、公開值、秘密）＝一份完整的 `.env`，燒錄設備時要一起用的值都在同一個檔裡。開頭一行註明產生時間與「只有這一份，不要提交」。
- **檔名**：`<指令>[-<homeTag 或設備 id>].<UTC 時間 YYYYMMDDTHHMMSSZ>.env`，只含公開值；非 `[0-9A-Za-z_-]` 的字元換成 `_`。
- **落盤**（`writeSecretFileToDisk`，`src/cli/secret-file.ts`）：資料夾不存在就建立（POSIX 700）；資料夾裡放一個只有 `*` 的 `.gitignore`（已經有就不動）——不靠使用者專案根目錄的 `.gitignore` 有沒有寫 `.secrets/`。檔案 600、以 `wx` 開：🔴 **絕不覆寫**，同名就改 `-2`、`-3`…（換金鑰的寬限期內，舊的那份可能還要用）。Windows 沒有 POSIX 權限位元，沿用使用者資料夾的 ACL。
- 🔴 **寫檔失敗就退回印在終端並在 stderr 警告**。寫檔發生在最後；那時 `iot-realtime.json` 多半已經改了（權杖雜湊、閘道公鑰），秘密若跟著消失，設備就得重新產生。
- **一開始就檢查**：環境沒有 `CliDeps.writeSecretFile`（不能寫秘密檔）時，兩個旗標在改任何檔案之前就是用法錯誤（回 2）。
- 不給旗標：輸出與以前逐字相同。`iot keygen`／`push-keygen` 原本是「不吃任何參數」，現在改用 `parseArgs` 嚴格解析，未知旗標仍是用法錯誤。

### 2. 隱藏輸入不做

ADR 0050 P1 的「隱藏輸入」是給精靈收秘密值用的。但精靈（ADR 0117）的設計是**只問環境變數的名稱、不收秘密值**，設定檔只寫 `{"$env": …}`，CLI 部署時從環境或設定檔旁邊的 `.env` 讀。整條路徑上沒有任何一處要使用者在 CLI 裡打秘密值，所以沒有東西需要遮住。若之後真的要讓精靈代寫 `.env`，再以那個需求開 ADR——屆時隱藏輸入與寫 `.env` 的權限一起設計。

## Consequences

- ＋ 一次性秘密可以不經過終端：不進捲動紀錄、終端記錄、CI 日誌、螢幕分享。
- ＋ 不再需要 `> .env` 重導（會覆寫、會混進說明行）；秘密檔自帶 `.gitignore`，誤提交的機會降低。
- ＋ 不覆寫：換金鑰時舊的那份還在，寬限期內需要時找得到。
- － 秘密留在磁碟上，要使用者自己移到安全的地方或刪除（檔案開頭寫明）。這是使用者明確選的（加了旗標）；預設行為不變。
- － Windows 上檔案權限不是 600，靠使用者資料夾的 ACL。
- 驗證：`tests/cli/cli-secrets-dir.test.ts`（7 個：keygen／push-keygen／realtime home／device／`--new-token` 的秘密只在檔案、公開值照舊印、設定檔的雜湊對得上檔案裡的權杖、`--secrets-dir` 相對路徑、沒旗標時輸出不變、寫檔失敗退回終端、環境不能寫時一開始就是用法錯誤且沒改任何檔）、`tests/cli/secret-file.test.ts`（6 個：建立資料夾、自帶 `.gitignore`、既有 `.gitignore` 不動、絕不覆寫、POSIX 600／700〔Windows 略過〕、檔名不能帶路徑）。
