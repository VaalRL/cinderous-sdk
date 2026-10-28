# Contributing / 貢獻指南

## How contributions are accepted

This public repository is an **export** of a private development repository ([ADR 0110](docs/adr/0110-public-github-repo-not-npm.md)). Each release is copied here as one commit. Pull requests are therefore not merged directly: the maintainer applies an accepted change to the development repository, keeps you as the author (`Co-authored-by`) together with your sign-off, and it appears here in the next release.

Before larger changes, please open an issue first so we can agree on the design. Security problems go through [SECURITY.md](SECURITY.md), never through a public issue or pull request.

## Developer Certificate of Origin (DCO)

Every commit must be signed off. By signing off you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change, or otherwise have the right to submit it under this project's license.

```
git commit -s -m "fix(relay): ..."
```

This adds a line with your real name and an email address you can be reached at:

```
Signed-off-by: Your Name <you@example.com>
```

Contributions are accepted under the project's license, [AGPL-3.0-only](LICENSE). There is no CLA and no copyright assignment: you keep the copyright to your contribution.

## What a change needs

- **Tests first.** Every behaviour change comes with a test (`tests/` mirrors `src/`).
- **`npm run check` passes.** It runs the type check, the tests and the build, and fails if the committed `dist/` or the relay Worker bundle no longer matches the source. Commit `dist/` too: consumers install the SDK from a git tag and no build runs at install time ([ADR 0001](docs/adr/0001-v0-1-client-scope-agpl-and-git-distribution.md)).
- **An ADR for design decisions.** Module boundaries, protocol or event formats, crypto, privacy trade-offs and new dependencies get a record in `docs/adr/` (copy the format of an existing one) and a row in [docs/adr/README.md](docs/adr/README.md).
- **Relay messages stay compatible.** Reject reasons and `NOTICE` texts are matched by released apps; change them only together with a test that shows the old clients still understand them.

Issues, commit messages and pull requests can be written in English or Traditional Chinese.

---

## 貢獻怎麼被收進來

這個公開 repo 是私有開發 repo 的**匯出**（[ADR 0110](docs/adr/0110-public-github-repo-not-npm.md)），每次發版複製成一個 commit。所以 pull request 不會直接合併：維護者把接受的改動套到開發 repo，保留你為作者（`Co-authored-by`）與你的簽署，下一版就會出現在這裡。

較大的改動請先開 issue 討論設計。安全問題請照 [SECURITY.md](SECURITY.md) 私下回報，不要開公開的 issue 或 pull request。

## 開發者原創聲明（DCO）

每個 commit 都要簽署。簽署代表你同意 [Developer Certificate of Origin 1.1](https://developercertificate.org/)：改動是你寫的，或你有權以本專案的授權提交它。

```
git commit -s -m "fix(relay): ..."
```

這會加上一行你的真實姓名與聯絡得到的 email：

```
Signed-off-by: Your Name <you@example.com>
```

貢獻以本專案的授權 [AGPL-3.0-only](LICENSE) 接受。沒有 CLA，也不轉讓著作權：你的貢獻著作權仍屬於你。

## 一個改動需要什麼

- **先寫測試**。每個行為改動都附測試（`tests/` 對應 `src/`）。
- **`npm run check` 要過**。它跑型別檢查、測試與打包；提交的 `dist/` 或中繼 Worker 打包與原始碼不一致就會失敗。`dist/` 也要提交：使用方是用 git tag 安裝的，安裝時不會打包（[ADR 0001](docs/adr/0001-v0-1-client-scope-agpl-and-git-distribution.md)）。
- **設計決策要寫 ADR**。模組邊界、協定與事件格式、加密、隱私取捨、新的相依，都在 `docs/adr/` 新增一份（照現有的格式），並在 [docs/adr/README.md](docs/adr/README.md) 加一列。
- **中繼的句子要相容**。拒收原因與 `NOTICE` 的文字會被已發行的應用比對；要改，必須附上「舊版用戶端仍看得懂」的測試。

issue、commit 訊息與 pull request 用英文或繁體中文都可以。
