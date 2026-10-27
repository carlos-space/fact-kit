# fact-kit

撰寫、檢查、建置與讀取 facts 的工具。一筆 fact 是由工具決定、使用者必須照著做或一定會遇到的事，例如指令、設定欄位、hook 事件與行為。fact 以 JSON 與 JSON Schema 發布，讀取時不需要 fact-kit。

## 內容

每種語言的套件各佔倉庫根的一個目錄，不收進 `packages/`，因為有兩個平台限制把位置定死了。SwiftPM 用倉庫網址加 tag 解析依賴，只讀倉庫根的 `Package.swift`，所以只有 `Package.swift` 與 `Package.resolved` 必須在根，原始碼用 target 的 `path:` 放進 `swift/`。Go 的模組路徑與 tag 前綴都等於目錄 `go/`，搬目錄等於換一個新模組，已發布的版本會留在舊路徑。根目錄的 `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`vitest.config.ts` 是 pnpm workspace 的根設定，管 `js/` 與 `facts/` 這兩個 npm 套件。

| 路徑                                                                                 | 內容                                                                                                                     | 發布到哪                         |
| :----------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------- | :------------------------------- |
| `js/`                                                                                | JS 套件 `fact-kit`：fact 的型別與 meta-schema，以及撰寫、檢查、建置、讀取與比對的工具                                    | npm（公開）                      |
| `facts/`                                                                             | 匯總套件 `fact-kit-facts`，根路徑是 fact-kit 的 facts，子路徑 `./py`、`./rs`、`./go`、`./swift` 是各語言讀取套件的 facts | npm（公開）                      |
| `facts/fact-kit/`                                                                    | fact-kit 自己的 facts 源碼，是它的規格，測試拿它和 `js/` 的實作比對                                                      | 由 `facts/` 匯總發布             |
| `facts/py/`、`facts/rs/`、`facts/go/`、`facts/swift/`                                | 其他語言讀取套件的公開 API 的 facts 源碼，四種語言的讀取測試拿它比對自己的實作                                           | 由 `facts/` 匯總發布             |
| `py/`                                                                                | Python 讀取套件 `fact-kit`（匯入名 `fact_kit`），說明在 `py/README.md`                                                   | PyPI                             |
| `rs/`                                                                                | Rust 讀取套件 `fact-kit`（匯入名 `fact_kit`），說明在 `rs/README.md`                                                     | crates.io                        |
| `go/`                                                                                | Go 讀取套件，模組路徑 `github.com/carlos-space/fact-kit/go`，說明在 `go/README.md`                                       | Go module（tag `go/vX.Y.Z`）     |
| `Package.swift`、`Package.resolved` 在根，`swift/` 放 `Sources/`、`Tests/` 與說明    | Swift 讀取套件 `FactKit`，說明在 `swift/README.md`                                                                       | SwiftPM（不帶前綴的 semver tag） |
| `conformance/`                                                                       | 跨語言共用的 index 格式規格與測試資料，五種語言的一致性測試都跑它                                                        | 不發布                           |
| `consumer/`                                                                          | 各語言的消費端 harness（`py/`、`rs/`、`go/`、`swift/`），安裝驗證用它從 registry 裝套件，說明在 `consumer/README.md`     | 不發布                           |
| `scripts/`                                                                           | 發布腳本（`scripts/release/`）、CI 腳本（`scripts/ci/`）與它們共用的函式（`scripts/lib/`）                               | 不發布                           |
| `.github/workflows/`                                                                 | CI、一致性測試、release-please、發布與安裝驗證的 workflow                                                                | 不發布                           |
| `release-please-config.json`、`.release-please-manifest.json`、`release-policy.json` | 版號設定、各單元目前的版號，以及各單元經過的發布階段                                                                     | 不發布                           |

## 開發

需要 Node.js 24 以上與 pnpm。

```bash
pnpm install
pnpm check
pnpm build
pnpm test
```

`pnpm check` 依序跑型別檢查、prettier，以及 `facts/` 底下五個 component（`fact-kit`、`py`、`rs`、`go`、`swift`）各自的 `fact-kit check`。每個 component 的 `fact-kit.config.json` 的 `allowedDomains` 列出它的 facts 可以引用的網域。

main 只收 PR，以 squash 合併，所以 PR 標題要符合 Conventional Commits，PR 內文就是 main 上的 commit 內文。本機不裝 git hook，規則都由 PR 的 workflow 檢查。內文不能帶 AI 平台署名。

## 發版

發版單元是 `release-please-config.json` 的 `packages` 鍵，共六個。

| 單元（component）            | 路徑          | 發布到                | tag                                  |
| :--------------------------- | :------------ | :-------------------- | :----------------------------------- |
| `fact-kit`                   | `js/`         | npm                   | `fact-kit/vX.Y.Z`                    |
| `fact-kit-facts`（匯總套件） | `facts/`      | npm                   | `fact-kit-facts/vX.Y.Z`              |
| `py`                         | `py/`         | PyPI                  | `py/vX.Y.Z`                          |
| `rs`                         | `rs/`         | crates.io             | `rs/vX.Y.Z`                          |
| `go`                         | `go/`         | Go module（沒有上傳） | `go/vX.Y.Z`                          |
| `swift`                      | `.`（倉庫根） | SwiftPM（沒有上傳）   | 純 `X.Y.Z`，沒有 component、沒有 `v` |

`facts/` 底下的 component 套件是 private，不是發版單元。Go 與 Swift 沒有上傳，合併 Release PR 時 release-please 建的 tag 就是發布。Swift 單元登記在倉庫根，因為 SwiftPM 只讀倉庫根的 `Package.swift`。它的 tag 不帶 `v`，因為 `v` 開頭的根 tag 會被 SwiftPM 當版本。

四個讀取單元第一次發布的版號是切線時的 `<line>.0`（例如 0.3 線是 `0.3.0-alpha.1`），所以 `.release-please-manifest.json` 先寫 `0.0.0`，release-please 看到 `0.0.0` 就當作沒發布過，改用 `initial-version`。`release-policy.json` 的 stages 是 `["alpha", "ga"]`，所以第一版先發 alpha。

**新增一個單元要改的地方**

1. `release-please-config.json`：在 `packages` 加一筆，寫 `component` 與 `release-type`。
2. `.release-please-manifest.json`：加同一個路徑，版號寫 `0.0.0`。
3. `release-policy.json`：以 component 為鍵加一筆，寫 `kind` 與 `stages`。
4. 單元自己的版本檔：Python 是 `pyproject.toml`，Rust 是 `Cargo.toml` 與 `Cargo.lock`，版號要等於 manifest。
5. 單元發布到新種類的註冊中心時：`scripts/lib/release-stages.sh` 的 `unit_registry`、`scripts/release/publish-units.sh` 加一段，`.github/workflows/publish.yml` 加一個 job，`scripts/ci/assembled-check.sh` 加一個 case 並在 `.github/workflows/ci.yml` 的 `assembled` job 裝上該語言的工具鏈，並在 `consumer/` 加該語言的 harness 與 `.github/workflows/verify-install.yml` 的 job。已有的種類只要前四步。
6. `scripts/release/release-config.test.ts` 的 `expected` 加一筆。
7. 在倉庫根新增頂層目錄時：把它加進 swift 單元的 `exclude-paths`（`release-please-config.json`），否則只改那個目錄的 commit 也會讓 Swift 升版。`release-config.test.ts` 會檢查這件事。
8. 要納入 CI 的新目錄：`scripts/ci/ci-scope.conf`。

整個倉庫同一時間最多一條發布分支 `release/vX.Y`（train），用 `--units` 選要入版的單元（用 component 名稱）。入版的單元各自有版號和 tag `<component>/vX.Y.Z`，例如 `fact-kit/v0.7.0`。每次發布另外指派一個產品版號，產品 tag 是 `product/vX.Y.Z`，版號記在 root `package.json` 的 `version`。main 只收 PR，上面不會出現 release-please 開的 commit。版號檔、CHANGELOG、manifest 與產品版號在 GA 之後，隨 `release/vX.Y--to-main` 這個 squash 合回 PR 進 main。

`--line X.Y` 是產品線，用來命名分支，不決定單元版號。單元版號由 release-please 依 commit 算出，這條線上只放 `fix:` commit 時單元只升 patch，放 `feat:` 會升 minor。產品版號由 `--product-version` 指定，每次發布必填。這條線已經有產品 tag `product/vX.Y.Z` 時，切分支必須帶 `--from <最新的產品 tag>`。

預發布版的 npm dist-tag 等於階段名（`alpha`、`beta`、`rc`），只有 GA 進 `latest`，所以 `npm install` 不會裝到預發布版。腳本需要 bash 4 以上（macOS 用 `brew install bash`）、`gh`、`jq`，並且在乾淨的工作區執行。所有腳本都可以加 `--dry-run` 先看會做什麼，不寫遠端也不推送。

`publish.yml` 每個註冊中心一個 job。PyPI 與 crates.io 用 Trusted Publishing，所以不存任何 token，兩個 job 都不放在 GitHub Environment 裡，發布的核准在合併 Release PR 前給一次，之後各註冊中心不再等核准。Trusted Publishing 登記時 environment 留空。PyPI 的版號不在這裡轉換：release-please 照寫 SemVer（`0.3.0-alpha.1`），`uv build` 的後端正規化成 PEP 440（`0.3.0a1`），發布腳本從建出的 wheel 讀回實際版號。crates.io 只能對已存在的 crate 設 Trusted Publishing，所以 crate 第一版由使用者用環境變數 `CARGO_REGISTRY_TOKEN` 手動發，crate 還不存在時 `crates` job 只在 summary 說明並略過。`publish.yml` 的 `dry_run` 輸入會讓所有上傳變成 dry run。

發布後用 `verify-install.yml` 驗證：手動派送，輸入各套件的版號。每個 job 在新的 runner 上只 sparse checkout `conformance/` 與該語言的 `consumer/<語言>/`，從註冊中心（Swift 是這個倉庫的 tag）裝指定版號，跑共用樣本並印出套件從哪裡載入。

以下以產品線 0.1、產品版號 0.1.0 為例。

1. 切分支，預設從 alpha 開始。`--units` 是入版的單元，用逗號分隔，沒有 commit 的單元不會發版。腳本會把相依的單元一併納入。推送後 release-please 在分支上開 Release PR。

   ```bash
   bash scripts/release/cut-release.sh --line 0.1 --units fact-kit [--stage alpha|beta|rc|ga] [--from product/v0.1.0]
   ```

2. 合併分支上的 Release PR。release-please 為每個入版的單元建立 tag，例如 `fact-kit/v0.7.0-alpha.1`，`publish.yml` 以 dist-tag `alpha` 發布到 npm。分支上再有 `fix:` commit 時，每次都再開一次 Release PR，序號加一。

3. 推進階段。順序是 alpha、beta、rc，可以跳過，不能往回。省略 `--to` 時推進到下一階段。每個階段的序號從 `.1` 開始，再重複第 2 步。

   ```bash
   bash scripts/release/advance-release.sh --line 0.1 [--to beta|rc]
   ```

4. GA。`--to ga` 必須帶 `--product-version`。腳本等分支最新 commit 的 ci 通過，寫入各單元的正式版號並離開預發布模式。合併分支上的 Release PR 後，tag 變成 `fact-kit/v0.7.0`，以 dist-tag `latest` 發布。

   ```bash
   bash scripts/release/advance-release.sh --line 0.1 --to ga --product-version 0.1.0
   ```

5. 合回 main。腳本刪掉標記檔，把產品版號寫進發布分支的 root `package.json`，在 main 之上建立 `release/v0.1--to-main` 並開 PR，PR 內文附 Snapshot。等這個 PR 的 ci 通過。

   ```bash
   bash scripts/release/finalize-release.sh --line 0.1 --phase merge-back --product-version 0.1.0
   ```

6. 收尾。腳本以 squash 合併上一步的 PR，在發布分支的最後一個 commit 打產品 tag `product/v0.1.0`，刪掉發布分支與 release-please 暫時分支，並核對 main。產品 tag 會觸發 `release-line-finalize.yml`，核對各單元 tag 並建立附 Snapshot 的 GitHub Release。

   ```bash
   bash scripts/release/finalize-release.sh --line 0.1 --phase close --product-version 0.1.0
   ```

任何一步中途失敗，修好後重跑同一個指令。已經發到 npm 的版本會被略過。發布分支上的 hotfix 從 `hotfix/<issue>-<kebab>` 切出，PR 合回發布分支。已發布的產品線要修補時，用 `cut-release.sh --line 0.1 --units <單元> --from product/v0.1.0` 自產品 tag 重建。

## 授權

MIT。
