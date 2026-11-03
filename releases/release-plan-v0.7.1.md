# 發布規劃 v0.7.1

- 類型：maintenance
- 狀態：draft
- 產品版號：`v0.7.1`（本文件是產品版號的唯一指派點。上一份發布規劃是 `v0.7.0`，這是下一個 patch）
- Milestone：無，維護型發布
- 發布分支：`release/v0.7`，從產品 tag `v0.7.0` 重建，修正用 `git cherry-pick -x` 帶入
- 這次發布的單元：fact-kit-js（npm `fact-kit`）、fact-kit-facts（npm `fact-kit-facts`）。fact-kit-py、fact-kit-rs、fact-kit-go、fact-kit-swift 不入版
- 階段路徑：政策檔 `release-policy.json` 的 fact-kit-js 與 fact-kit-facts 都是 `["alpha", "ga"]`

## 含哪些工作

| PR                                           | 單元                        | 狀態              |
| :------------------------------------------- | :-------------------------- | :---------------- |
| #108 fix: pin 也釘 when 裡的 next            | fact-kit-js、fact-kit-facts | 已合回（c59b39b） |

`fact-kit pin` 原本只釘 `since` 的 `next`。fact 寫 `when: { deprecatedIn: 'next', removeIn: 'next' }` 時，pin 輸出 0 pinned，`when` 裡的 `next` 原樣留著，發版後以該版讀仍讀得到該退場的 fact。#108 讓 pin 也釘 `when.deprecatedIn` 與 `when.removeIn` 的 `next`，筆數算進輸出，`check --train` 對這兩欄的 `next` 報 `train-next`。fact-kit-facts 的 fact 跟著寫出新行為。

main 上 v0.7.0 之後只有 #107（v0.7.0 合回，內容已在 tag）與 #108，沒有其他要排除的變更。

## 各單元版號

GA 當下由工具產出後貼入，不手抄。預期 fact-kit-js 0.12.1、fact-kit-facts 0.7.1，實際以 release-please 的 Release PR 為準。

| 單元    | 實作版號 | tag    |
| :------ | :------- | :----- |
| product | 0.7.1    | v0.7.1 |

## 破壞性變更

無。行為差異有三處：pin 多釘 `when` 裡的 `next`，`check --train` 多報 `when` 裡的 `next`，發布前檢查因此多擋這兩欄。已經用具體版號寫 `when` 的 fact 與沒有 `when` 的 fact 不受影響。

## 怎麼退

- 可回退：消費端把 `fact-kit` 與 `fact-kit-facts` 釘回 0.12.0 與 0.7.0。
- 不可回退：已推送的 tag 與已發布到 npm 的版本，補救再發下一個修補版。

## 變更過程

- 0.7 線的 alpha.1：從 `v0.7.0` 重建發布分支，cherry-pick #108
- GA
