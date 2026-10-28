# 私有樣本 -facts 套件

`@carlos-space/fact-kit-sample-facts` 是給 `samples/rust` 與 `samples/go` 讀的私有 -facts 套件，發在 GitHub Packages。內容只有兩筆示範用的 fact，不描述任何產品。

## 為什麼由 fact-kit 自己發

樣本要證明非 JS 專案能用 pnpm 從 GitHub Packages 安裝私有 -facts 並讀到。套件的 `repository` 欄連到 fact-kit 倉庫，所以 fact-kit 的 Actions 用 `GITHUB_TOKEN`（`packages: read`）就讀得到，不必依賴其他倉庫的私有套件，也不必另外授權。

## 發布

1. 改 `facts/` 後，把 `package.json` 的 `version` 加一版。已發過的版本不能覆蓋。
2. 合回 main 後，手動執行 workflow `publish-sample-facts.yml`。它在套件目錄建置並執行 `pnpm publish --ignore-scripts`，版本已存在時略過。
