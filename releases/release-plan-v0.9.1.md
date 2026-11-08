# 發布規劃 v0.9.1

- 類型：maintenance
- 狀態：draft
- 產品版號：`v0.9.1`（本文件是產品版號的唯一指派點。上一份發布規劃是 `v0.9.0`，這是下一個 patch）
- Milestone：無，維護型發布
- 發布分支：`release/v0.9`，從產品 tag `v0.9.0` 重建，修正用 `git cherry-pick -x` 帶入
- 這次發布的單元：fact-kit-js（npm `fact-kit`）、fact-kit-facts（npm `fact-kit-facts`）。fact-kit-py、fact-kit-rs、fact-kit-go、fact-kit-swift 不入版
- 階段路徑：政策檔 `release-policy.json` 的 fact-kit-js 與 fact-kit-facts 都是 `["alpha", "ga"]`

## 含哪些工作

| PR                                                                | 單元                        | 狀態              |
| :---------------------------------------------------------------- | :-------------------------- | :---------------- |
| #122 fix: facts-name 的基底遇到已帶 -facts 的單元名時不再多加後綴 | fact-kit-js、fact-kit-facts | 已合回（af150c1） |

`facts-name` 規則原本一律用 `<單元名>-facts` 當 component 套件的基底。單元名已以 `-facts` 結尾時，例如 `blueprint-facts`，基底變成 `blueprint-facts-facts`，和匯總套件的基底 `blueprint-facts` 不同，重名規則不觸發。#122 讓單元名已以 `-facts` 結尾時直接當基底，`publish.name`、唯一的 describes 鍵與子路徑三種來源都套用。fact-kit-facts 的 `fact-kit.facts-package-naming` 與 `fact-kit.aggregate-layout` 加 `since: 'next'` 的列寫出新算法。

main 上 v0.9.0 之後只有 #122，沒有其他要排除的變更。目前只有 blueprint 的 3 個檔用到 `-facts-facts`，所以新規則只影響 blueprint。

## 各單元版號

GA 當下由工具產出後貼入，不手抄。預期 fact-kit-js 0.14.1、fact-kit-facts 0.9.1，實際以 release-please 的 Release PR 為準。

| 單元    | 實作版號 | tag    |
| :------ | :------- | :----- |
| product | 0.9.1    | v0.9.1 |

## 破壞性變更

無。單元名沒有 `-facts` 後綴的既有結構，名稱要求不變。單元名已以 `-facts` 結尾的套件，check 對名稱的要求改變，這是修正原本讓重名規則失效的行為。

## 怎麼退

- 可回退：消費端把 `fact-kit` 與 `fact-kit-facts` 釘回 0.14.0 與 0.9.0。
- 不可回退：已推送的 tag 與已發布到 npm 的版本，補救再發下一個修補版。

## 變更過程

- 0.9 線的 alpha.1：從 `v0.9.0` 重建發布分支，cherry-pick #122
- GA
