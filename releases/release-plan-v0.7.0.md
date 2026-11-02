# 發布規劃 v0.7.0

- 類型：milestone
- 狀態：draft
- 產品版號：`v0.7.0`（本文件是產品版號的唯一指派點。上一個產品 tag 是 `v0.6.2`，這是下一個 minor）
- Milestone：無，這次發布的工作都已合回 main
- 發布分支：`release/v0.7`
- 這次發布的單元：fact-kit-js（npm `fact-kit`）、fact-kit-facts（npm `fact-kit-facts`）、fact-kit-py、fact-kit-rs、fact-kit-go、fact-kit-swift
- 階段路徑：政策檔 `release-policy.json` 的六個單元都是 `["alpha", "ga"]`

## 含哪些工作

| PR                                                              | 單元                                                               | 狀態   |
| :-------------------------------------------------------------- | :----------------------------------------------------------------- | :----- |
| #97 feat(facts): 寫出 index 2.0 格式與讀取端判斷規則的 fact     | fact-kit-facts                                                     | 已合回 |
| #98 feat(readers): 五種語言的讀取端讀得懂 index 格式 2.0        | fact-kit-js、fact-kit-py、fact-kit-rs、fact-kit-go、fact-kit-swift | 已合回 |
| #99 feat(facts): 寫出來源收集、檢查規則與擴充點匯出的 fact      | fact-kit-facts                                                     | 已合回 |
| #100 feat(fact-kit-js): build 寫出 index 格式 2.0               | fact-kit-js、fact-kit-facts                                        | 已合回 |
| #101 feat(check): impl-imports-facts 依副檔名與路徑判斷         | fact-kit-js、fact-kit-facts                                        | 已合回 |
| #102 feat(kit): build 自動收集 \*.facts.ts、讀設定檔的 factsDir | fact-kit-js、fact-kit-facts                                        | 已合回 |
| #103 feat(kit): 套件入口匯出擴充點，pin 資料鍵可設定            | fact-kit-js、fact-kit-facts                                        | 已合回 |

## 各單元版號

GA 當下由工具產出後貼入，不手抄。

| 單元    | 實作版號 | tag    |
| :------ | :------- | :----- |
| product | 0.7.0    | v0.7.0 |

## 破壞性變更

`fact-kit build` 寫出的 index 改成格式 2.0。讀取端要用這次發布的版本才讀得了新 index：JS 0.11.x 以前，與 Python、Rust、Go、Swift 0.4.x 以前的讀取端讀不了。消費端升級 `fact-kit` 建出新 index 時，讀取它的各語言套件要一起升到這次的版本。

## 怎麼退

- 可回退：消費端把 `fact-kit`、`fact-kit-facts` 與各語言讀取套件釘回 v0.6.2 的版本，重新 build index。
- 不可回退：已推送的 tag 與已發布到 npm、PyPI、crates.io 的版本，補救走上線後修補（`release/v0.7` 從 `v0.7.0` 重建）。

## 變更過程

- 0.7.0 線的 alpha.1：切發布分支
- GA
