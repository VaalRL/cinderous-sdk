---
title: 中繼設定器
description: 在瀏覽器裡產生自己中繼的 cinderous.config.json 與部署包。
head:
  - - meta
    - http-equiv: Content-Security-Policy
      content: "connect-src 'none'; form-action 'none'; base-uri 'self'"
---

<script setup>
import WebConfigurator from '../.vitepress/components/WebConfigurator.vue';
</script>

# 中繼設定器

選好中繼要部署在哪裡、允許什麼。這一頁用與 `cinderous init`、`cinderous config validate` 同一套規則檢查你的選擇，然後給你設定檔、部署包的 zip（與 `cinderous relay build` 寫出的檔案相同），以及自己產生部署包的一行指令。設計見 [SDK ADR 0142](/docs/adr/0142-web-configurator)。

<ClientOnly>
  <WebConfigurator locale="zh-TW" />
</ClientOnly>
