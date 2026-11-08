# 發布規劃 v0.9.0

- 類型：milestone
- 狀態：draft
- 產品版號：`v0.9.0`（本文件是產品版號的唯一指派點。上一份發布規劃是 `v0.8.0`，這是下一個 minor）
- Milestone：無，這次發布的工作都已合回 main
- 發布分支：`release/v0.9`，從 main 切出
- 這次發布的單元：fact-kit-js（npm `fact-kit`）、fact-kit-facts（npm `fact-kit-facts`）。fact-kit-py、fact-kit-rs、fact-kit-go、fact-kit-swift 不入版
- 階段路徑：政策檔 `release-policy.json` 的 fact-kit-js 與 fact-kit-facts 都是 `["alpha", "ga"]`

## 含哪些工作

| PR                                                  | 單元                        | 狀態   |
| :-------------------------------------------------- | :-------------------------- | :----- |
| #117 feat: check 依另一個套件的 schema 驗證 fact 值 | fact-kit-js、fact-kit-facts | 已合回 |

v0.8.0 之後 main 上只有 #116（v0.8.0 合回，內容已在 tag）與 #117，沒有其他要排除的變更。

#117 讓 fact 頂層接受選填欄位 `validatedBy: '<spec>:<id>'`。`fact-kit check` 取被指 fact 的 `content.schema` 驗這筆 fact 每一列的 `value`，從 cwd 的 `node_modules` 讀被指套件，`--index` 已載入的優先。不符、被指套件沒安裝、id 不存在、被指 fact 不是 schema，都報新問題碼 `validated-by`。`build` 不跑這條規則。fact-kit-facts 新增 `fact-kit.validated-by`，並替 `fact-kit.fact`、`fact-kit.problem-codes`、`fact-kit.check-rules`、`fact-kit.check-index-input` 加 `since: 'next'` 的列。

py、rs、go、swift 四個單元只有讀取實作，#117 沒有碰它們的目錄，release-please 依路徑判斷它們沒有變更，所以不入版。讀取端略過未知欄位，所以照讀帶 `validatedBy` 的 index。

`facts/fact-kit-js/test/fact-kit-spec.test.ts` 拿 fact-kit-facts 的 head fact 對照 fact-kit-js 的實作，只發其中一個單元時這個測試會失敗，所以兩個單元一起發。

## 各單元版號

GA 當下由工具產出後貼入，不手抄。預期 fact-kit-js 0.14.0、fact-kit-facts 0.9.0，實際以 release-please 的 Release PR 為準。

| 單元    | 實作版號 | tag    |
| :------ | :------- | :----- |
| product | 0.9.0    | v0.9.0 |

## 破壞性變更

無。`validatedBy` 選填，沒宣告的 fact 行為不變。index 格式不變。

## 怎麼退

- 可回退：消費端把 `fact-kit` 與 `fact-kit-facts` 釘回 0.13.0 與 0.8.0，移除 `validatedBy` 欄位後重新 build index。
- 不可回退：已推送的 tag 與已發布到 npm 的版本，補救走上線後修補（`release/v0.9` 從 `v0.9.0` 重建）。

## 變更過程

- 0.9 線的 alpha.1：切發布分支，入版單元 fact-kit-js 與 fact-kit-facts
- GA
