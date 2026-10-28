# 發布規劃 v0.6.1

- 類型：maintenance
- 狀態：draft
- 產品版號：`v0.6.1`（本文件是產品版號的唯一指派點。上一份發布規劃是 `v0.6.0`，這是下一個 patch）
- Milestone：無，維護型發布
- 發布分支：`release/v0.6`，從產品 tag `v0.6.0` 重建，修正用 `git cherry-pick -x` 帶入
- 這次發布的單元：fact-kit-facts（npm `fact-kit-facts`）。fact-kit-js、fact-kit-py、fact-kit-rs、fact-kit-go、fact-kit-swift 不入版
- 階段路徑：政策檔 `release-policy.json` 的 fact-kit-facts 是 `["alpha", "ga"]`

## 含哪些工作

| PR                                                     | 單元                     | 狀態   |
| :----------------------------------------------------- | :----------------------- | :----- |
| #85 fix(facts): next 列釘成 0.11.0，發布前擋下 next 列 | fact-kit-facts、發布腳本 | 待合回 |

fact-kit-facts 0.6.0 的 `dist/index.json` 有 4 列 `since: "next"`，預設讀者讀不到 `fact-kit.facts-package-naming`，`fact-kit.aggregate-layout` 也只讀到舊句。#85 把這 4 列釘成 0.11.0，並讓 `publish-units.sh` 在發布前擋下仍以 `next` 起算的列。

## 各單元版號

GA 當下由工具產出後貼入，不手抄。

| 單元    | 實作版號 | tag    |
| :------ | :------- | :----- |
| product | 0.6.1    | v0.6.1 |

## 破壞性變更

無。只把已發布的 fact-kit 0.11.0 行為從 `next` 列改成 0.11.0 列，指定 0.10.0 以前版本的讀者讀到的內容不變。

## 怎麼退

- 可回退：消費端把 `fact-kit-facts` 釘回 0.6.0。
- 不可回退：已推送的 tag 與已發布到 npm 的版本，補救再發下一個修補版。

## 變更過程

- 0.6 線的 alpha.1：從 `v0.6.0` 重建發布分支，cherry-pick #85
- GA
