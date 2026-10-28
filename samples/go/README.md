# Go 樣本：讀私有的 -facts 套件

這個專案證明外部 Go 專案能在 CI 用 pnpm 從 GitHub Packages 安裝私有的 `@carlos-space/notchhub-facts`，再用 `github.com/carlos-space/fact-kit-go` 讀到內容。

## 本機執行

1. 準備一個有 `read:packages` 權限的 GitHub token，放進 `NODE_AUTH_TOKEN`。
2. 在這個目錄執行 `PNPM_CONFIG_NPMRC_AUTH_FILE=.npmrc pnpm install --no-frozen-lockfile`。`.npmrc` 只寫 `${NODE_AUTH_TOKEN}`，不含 token 值。
3. 執行 `go test ./...`。

## 為什麼測試只看 id 與筆數

`@carlos-space/notchhub-facts` 是 UNLICENSED，這個倉庫與 CI log 是公開的。所以測試只確認 fact id 存在與筆數大於 0，不斷言、不印出 `title` 或 `content`。
