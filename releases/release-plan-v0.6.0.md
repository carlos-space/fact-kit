# 發布規劃 v0.6.0

- 類型：milestone
- 狀態：draft
- 產品版號：`v0.6.0`（本文件是產品版號的唯一指派點。上一個產品 tag 是 `v0.5.0`，這是下一個 minor）
- Milestone：無，這次發布的工作只有一個 PR
- 發布分支：`release/v0.6`
- 這次發布的單元：fact-kit-js（npm `fact-kit`）、fact-kit-facts（npm `fact-kit-facts`）。fact-kit-py、fact-kit-rs、fact-kit-go、fact-kit-swift 不入版
- 階段路徑：發布線的起始階段與各單元的階段由政策檔 `release-policy.json` 決定，兩個單元都是 `["alpha", "ga"]`

## 含哪些工作

| PR                                                               | 單元                        | 狀態   |
| :--------------------------------------------------------------- | :-------------------------- | :----- |
| #80 feat(js): check 依政策檔核對 facts 套件名與 scope            | fact-kit-js、fact-kit-facts | 待合回 |
| #79 docs(js): README 列出轉換共用的匯出與 prettier optional peer | fact-kit-js                 | 已合回 |

## 各單元版號

GA 當下由工具產出後貼入，不手抄。

| 單元    | 實作版號 | tag    |
| :------ | :------- | :----- |
| product | 0.6.0    | v0.6.0 |

## 破壞性變更

無。`fact-kit check` 新增 `facts-name` 與 `policy-scope` 兩個問題代碼，只在倉庫有 `release-policy.json` 時核對，沒有政策檔的倉庫行為不變。已發布的 fact 列不改，新規則寫在 `next` 列。

## 怎麼退

- 可回退：消費端把 `fact-kit` 與 `fact-kit-facts` 釘回 0.10.0 與 0.5.0。
- 不可回退：已推送的 tag 與已發布到 npm 的版本，補救走上線後修補（`release/v0.6` 從 `v0.6.0` 重建）。

## 變更過程

- 0.6.0 線的 alpha.1：切發布分支（#80）
- GA
