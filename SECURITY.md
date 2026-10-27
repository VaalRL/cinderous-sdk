# Security policy / 安全政策

## Reporting a vulnerability

Please report security problems **privately** through GitHub: on [VaalRL/cinderous-sdk](https://github.com/VaalRL/cinderous-sdk), open **Security → Report a vulnerability**. Do not open a public issue or pull request for an unfixed vulnerability.

Include what you can:
- the affected version (tag) and module (for example `@cinderous/client/sync/vault`, the relay, the crypto engines);
- how to reproduce it, and what an attacker gains;
- whether it is already public.

This is a small project maintained in spare time. There is no bug bounty and no guaranteed response time. We will tell you whether we can reproduce the problem, and credit you in the fix unless you prefer not to be named.

## Supported versions

Only the **latest tag** gets fixes. Upgrade to it before reporting, if you can.

## What to know before relying on this SDK

- The crypto engines are **experimental**. The Double Ratchet is newly written code that has had one internal review and **no external audit**.
- The post-quantum hybrid (ML-KEM-768) protects **encryption only**. Signatures are secp256k1 (Schnorr), so this is not "quantum-safe".
- Relays can see metadata: IP addresses, timing, sizes and recipient public keys. Content is end-to-end encrypted; metadata is not hidden.
- The relay operator is not trusted ([ADR 0064](docs/adr/0064-relay-operator-threat-model-and-bundle-hygiene.md)): security relies on end-to-end encryption and signatures, not on the relay code being secret.
- The SDK is **not published on npm**. The `@cinderous` scope on npm belongs to an unrelated account; install only from this GitHub repository with a tag ([ADR 0110](docs/adr/0110-public-github-repo-not-npm.md)).

---

## 回報漏洞

請**私下**透過 GitHub 回報：在 [VaalRL/cinderous-sdk](https://github.com/VaalRL/cinderous-sdk) 按 **Security → Report a vulnerability**。還沒修好的漏洞，請不要開公開的 issue 或 pull request。

請盡量附上：
- 受影響的版本（tag）與模組（例如 `@cinderous/client/sync/vault`、中繼、加密引擎）；
- 怎麼重現，攻擊者能得到什麼；
- 是否已經公開。

這是業餘時間維護的小專案，沒有漏洞獎金，也不保證回覆時間。我們會告訴你能不能重現；修好時會註明回報者，除非你不想具名。

## 支援的版本

只有**最新的 tag** 會修。回報前請盡量先升到最新版。

## 使用前要知道的

- 加密引擎是**實驗性的**。雙棘輪是新寫的程式碼，做過一次內部審查，**沒有外部審計**。
- 後量子混合（ML-KEM-768）**只保護加密**。簽章是 secp256k1（Schnorr），所以不是「量子安全」。
- 中繼看得到中繼資料：IP、時間、大小、收件人的公鑰。內容是端對端加密，中繼資料沒有隱藏。
- 中繼站主不受信任（[ADR 0064](docs/adr/0064-relay-operator-threat-model-and-bundle-hygiene.md)）：安全靠端對端加密與簽章，不靠中繼的程式碼保密。
- SDK **沒有發布到 npm**。npm 上的 `@cinderous` 範圍是不相關的帳號；只從這個 GitHub repo 以 tag 安裝（[ADR 0110](docs/adr/0110-public-github-repo-not-npm.md)）。
