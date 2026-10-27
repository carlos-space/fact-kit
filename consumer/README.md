# consumer

各語言的消費端 harness。每個 harness 只依賴已安裝的 fact-kit 套件，讀 `conformance/` 的共用樣本（`cases/`、`resolve/`、`semver.json`），輸出必須和 `expected.json` 相同，並印出套件實際從哪裡載入的來源證明。目的是證明「使用者從註冊中心裝到的那個套件」讀得到共用樣本，和倉庫裡測試跑的原始碼無關。

## 目錄

| 目錄     | 內容                                    | 來源證明                                                                         |
| :------- | :-------------------------------------- | :------------------------------------------------------------------------------- |
| `py/`    | `run.py`（harness）、`run.sh`           | `fact_kit` 模組的檔案路徑必須在 `site-packages` 底下，另印安裝的版本與來源       |
| `rs/`    | `src/main.rs`（harness）、`run.sh`      | `cargo metadata` 與 `cargo tree` 印出 `fact-kit` 的版本、來源（registry 或本機） |
| `go/`    | `main.go`（harness）、`run.sh`          | `go list -m -json` 與程式內的 `debug.ReadBuildInfo`（版本、go.sum、replace）     |
| `swift/` | `Sources/consumer/main.swift`、`run.sh` | `swift package show-dependencies` 與 `Package.resolved`                          |

## 用法

每個 `run.sh` 有兩種模式。harness 本身放在這個倉庫，但套件不是：`run.sh` 在暫時目錄建一個新的環境（venv、crate、Go module、Swift package）去依賴套件，所以沒有 workspace 相對路徑。

| 模式           | 寫法                                    | 用途                                               |
| :------------- | :-------------------------------------- | :------------------------------------------------- |
| 註冊中心 / tag | `consumer/<語言>/run.sh <版號>`         | 發布後驗證，`verify-install.yml` 用這個            |
| 本機打包結果   | `consumer/<語言>/run.sh --local <路徑>` | 發布前驗證，`scripts/ci/assembled-check.sh` 用這個 |

`<版號>` 寫 SemVer（例如 `0.3.0-alpha.1`），Python 由 pip 與 uv 正規化成 `0.3.0a1`。`--local` 的路徑：

| 語言  | `--local` 吃什麼                                         | 怎麼做出來                                                |
| :---- | :------------------------------------------------------- | :-------------------------------------------------------- |
| py    | wheel 檔                                                 | `uv build --wheel --out-dir <dir> py`                     |
| rs    | `.crate` 檔或解開後的目錄，用 `[patch.crates-io]` 指過去 | `cargo package --manifest-path rs/Cargo.toml`             |
| go    | 含 `go.mod` 的模組目錄，用 `replace` 指過去              | 複製 `go/`                                                |
| swift | 含 `Package.swift` 與 `Sources/` 的目錄，用 path 依賴    | 複製 `unit_content_paths` 列的檔案，見 assembled-check.sh |

`FACT_KIT_CONFORMANCE` 指定 `conformance/` 目錄，沒設時用 `../../conformance`。乾淨 runner 上只有 `conformance/` 與 `consumer/<語言>/`，這個預設剛好找得到。

樣本數有下限：harness 找到的樣本數不到下限（80 個 case、15 個 resolve、50 個版號比較、5 個發布線）時一律失敗，因為什麼都沒讀到的 harness 什麼也證明不了。
