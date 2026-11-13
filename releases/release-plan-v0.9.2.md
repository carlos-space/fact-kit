# 發布規劃 v0.9.2

- 類型：maintenance
- 狀態：draft
- 產品版號：`v0.9.2`（本文件是產品版號的唯一指派點。上一份發布規劃是 `v0.9.1`，這是下一個 patch）
- Milestone：無，維護型發布
- 發布分支：`release/v0.9`，從產品 tag `v0.9.1` 重建，修正用 `git cherry-pick -x` 帶入
- 這次發布的單元：fact-kit-js（npm `fact-kit`）、fact-kit-facts（npm `fact-kit-facts`）、fact-kit-py（PyPI）、fact-kit-rs（crates.io）、fact-kit-go（鏡像到 promptex-ai/fact-kit-go）、fact-kit-swift（鏡像到 promptex-ai/fact-kit-swift）
- 階段路徑：政策檔 `release-policy.json` 的 6 個單元都是 `["alpha", "ga"]`

## 含哪些工作

| PR                                                                           | 單元           | 狀態              |
| :--------------------------------------------------------------------------- | :------------- | :---------------- |
| #126 feat(fact-kit-go)!: 模組路徑改成 github.com/promptex-ai/fact-kit-go     | fact-kit-go    | 已合回（5aa67e5） |
| #127 fix: 倉庫位置改到 promptex-ai，著作權人改成 Promptex-AI                 | 6 個單元       | 已合回（347db32） |
| #128 fix(facts): fact-kit-go 與 fact-kit-swift 的新位置從第一個 alpha 版起算 | fact-kit-facts | 已合回（5c2a621） |

倉庫與兩個鏡像倉庫轉到 promptex-ai 後的第一版。各套件的 repository、Swift 的安裝網址、鏡像腳本的預設 owner 與著作權人改成新位置（#127）。fact-kit-go 的模組路徑改成 `github.com/promptex-ai/fact-kit-go`（#126）。fact-kit-facts 的 fact-kit-go 與 fact-kit-swift 新增新位置的列，從 `0.6.0-alpha.1` 與 `0.5.1-alpha.1` 起算（#127、#128）。npm、PyPI 與 crates.io 的 Trusted Publisher 已改綁 promptex-ai/fact-kit。

main 上 v0.9.1 之後只有這三個 PR，沒有要排除的變更。

## 各單元版號

GA 當下由工具產出後貼入，不手抄。預期 fact-kit-js 0.14.2、fact-kit-facts 0.9.2、fact-kit-py 0.5.1、fact-kit-rs 0.5.1、fact-kit-go 0.6.0、fact-kit-swift 0.5.1，實際以 release-please 的 Release PR 為準。fact-kit-go 有 breaking，`bump-minor-pre-major` 讓 0.x 只升 minor。

| 單元    | 實作版號 | tag    |
| :------ | :------- | :----- |
| product | 0.9.2    | v0.9.2 |

## 破壞性變更

fact-kit-go 的模組路徑改變。使用端要把 import 與 go.mod 的 `github.com/carlos-space/fact-kit-go` 改成 `github.com/promptex-ai/fact-kit-go`，再升到 0.6.0。舊路徑的 0.5.0 以前版本仍可從 Go proxy 取得。其他單元沒有破壞性變更。

## 怎麼退

- 可回退：消費端把各單元釘回 v0.9.1 的版本，Go 使用端留在舊路徑的 v0.5.0。
- 不可回退：已推送的 tag、已發布到 npm、PyPI、crates.io 的版本與鏡像倉庫的 tag，補救再發下一個修補版。

## 變更過程

- 0.9 線的 alpha.1：從 `v0.9.1` 重建發布分支，cherry-pick #126、#127、#128
- GA
