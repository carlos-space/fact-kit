# Rust 樣本：讀私有的 -facts 套件

這個專案證明外部專案能用 pnpm 從 GitHub Packages 安裝私有的 -facts 套件，再用 crates.io 的 `fact-kit` 從 `node_modules` 讀到內容。它讀的是 fact-kit 倉庫自己發的私有樣本套件 `@carlos-space/fact-kit-sample-facts`（源碼在 `samples/sample-facts`）。它自己也有一組 `facts/`，用 npm 的 `fact-kit` 建置，測試讀同一個 commit 的 `facts/dist`。

## 安裝設定

專案根目錄的 `.npmrc` 寫 scope registry 與 `${NODE_AUTH_TOKEN}`，不含 token 值。pnpm 不展開專案 `.npmrc` 裡的環境變數，所以安裝時設 `PNPM_CONFIG_NPMRC_AUTH_FILE=.npmrc` 指定認證檔，pnpm 才會讀到 token。

CI 用 `GITHUB_TOKEN` 加 `permissions: packages: read`。樣本套件的 `repository` 欄連到 fact-kit 倉庫，所以 fact-kit 的 Actions 不需另外授權。讀其他倉庫發的私有套件時，要在那個套件設定的「Manage Actions access」加入讀取的倉庫。

## 本機執行

1. 準備一個有 `read:packages` 權限的 GitHub token，放進 `NODE_AUTH_TOKEN`。
2. 在這個目錄執行 `PNPM_CONFIG_NPMRC_AUTH_FILE=.npmrc pnpm install --no-frozen-lockfile`。
3. 執行 `pnpm -C facts build`，建出 `facts/dist`。
4. 執行 `cargo test`。

只跑自己的 facts（不需要私有套件）：`cargo test --test own_facts`。讀不到私有套件時，`cargo test --test installed_facts` 會失敗並說明要安裝套件。
