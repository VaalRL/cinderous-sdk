---
layout: home
title: Cinderous SDK
hero:
  name: Cinderous SDK
  text: 建立在 Nostr 上的私密、本地優先同步
  tagline: AGPL-3.0 的 TypeScript 用戶端，加上你自己部署的中繼——用在自己的裝置之間與小團隊。
  image:
    src: /logo.svg
    alt: Cinderous
  actions:
    - theme: brand
      text: 閱讀說明
      link: /README.zh-TW
    - theme: alt
      text: 自架中繼
      link: /docs/guides/self-host-vps
    - theme: alt
      text: API 參考
      link: /api/
      target: _self
    - theme: alt
      text: GitHub
      link: https://github.com/VaalRL/cinderous-sdk
features:
  - title: 線上格式就是 Nostr
    details: 事件是一般的 NIP-01。用戶端使用 NIP-17、42、44、59、98；中繼宣告 NIP-01、11、13、40、42、62。
  - title: 每台裝置一把金鑰
    details: 裝置以 SAS 比對配對進名單，可以單獨移除一台。
  - title: 像 Git 的同步
    details: 版本圖、三方合併、衝突標示、墓碑、離線佇列，以及本機歷史與檢查點。
  - title: WebRTC，連不上就走中繼
    details: 大檔走點對點（TURN、可續傳），連不上時自動改走中繼。
  - title: 你自己的中繼
    details: 一鍵部署到你的 Cloudflare 免費方案，或 Docker、Fly、家用通道、VPS。中繼被視為不可信任。
  - title: 精確的加密用語
    details: NIP-44／NIP-59，另有兩個可選引擎，金鑰交換是 ML-KEM-768 混合。簽章仍是 secp256k1，所以不是「抗量子」。實驗性質，尚未經外部審計。
---

## 安裝

SDK 不在 npm 上。請從 GitHub 安裝並釘住 tag——最新的版本在[版本紀錄](/CHANGELOG)最上面：

```sh
npm install github:VaalRL/cinderous-sdk#vX.Y.Z
```

npm 上的 `@cinderous` 是別人的帳號（[ADR 0110](/docs/adr/0110-public-github-repo-not-npm)）。

## 使用前要知道

- 中繼看得到中繼資料：IP、時間、大小與收件人公鑰。內容是端對端加密，中繼資料沒有隱藏。
- 安全問題請照[安全政策](/SECURITY)私下回報。
- 歡迎貢獻（DCO 簽署），見[貢獻指南](/CONTRIBUTING)。
