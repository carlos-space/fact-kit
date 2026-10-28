# Go 樣本：讀 pnpm 安裝的 -facts 套件

這個專案證明外部 Go 專案用 pnpm 安裝 -facts 套件後，`github.com/carlos-space/fact-kit-go` 能從 `node_modules` 讀到內容。它讀 npm 上公開的 `fact-kit-facts` 的 `fact-kit-go` 子路徑。

## 本機執行

1. 在這個目錄執行 `pnpm install --frozen-lockfile`。
2. 執行 `go test ./...`。

## 讀私有的 -facts 套件

讀取方式和公開套件相同，只有安裝要另外設定。私有套件放在 GitHub Packages 時，在專案根目錄放一份 `.npmrc`：

```ini
@<scope>:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

安裝時設 `PNPM_CONFIG_NPMRC_AUTH_FILE=.npmrc`，`NODE_AUTH_TOKEN` 放有 `read:packages` 權限的 token。因為 pnpm 不展開專案 `.npmrc` 裡的環境變數，要用這個變數指定認證檔才會讀到 token。CI 可以用 `GITHUB_TOKEN` 加 `permissions: packages: read`，並在套件設定的「Manage Actions access」加入讀取的倉庫。
