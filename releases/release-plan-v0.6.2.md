# 發布規劃 v0.6.2

- 類型：maintenance
- 狀態：draft
- 產品版號：`v0.6.2`（本文件是產品版號的唯一指派點。上一份發布規劃是 `v0.6.1`，這是下一個 patch）
- Milestone：無，維護型發布
- 發布分支：`release/v0.6`，從產品 tag `v0.6.1` 重建，修正用 `git cherry-pick -x` 帶入
- 這次發布的單元：fact-kit-js（npm `fact-kit`）、fact-kit-facts（npm `fact-kit-facts`）。fact-kit-py、fact-kit-rs、fact-kit-go、fact-kit-swift 不入版
- 階段路徑：政策檔 `release-policy.json` 的 fact-kit-js 與 fact-kit-facts 都是 `["alpha", "ga"]`

## 含哪些工作

| PR                                                                    | 單元                        | 狀態              |
| :-------------------------------------------------------------------- | :-------------------------- | :---------------- |
| #92 fix(js): interfaceToJsonSchema 轉得出遞迴型別、方法與函式型別屬性 | fact-kit-js、fact-kit-facts | 已合回（76e280d） |
| #91 fix(release): 產品 GitHub Release 的標題改成直接用 tag            | 發布 workflow               | 已合回（0e78db4） |

fact-kit 0.11.0 的 `interfaceToJsonSchema` 轉含方法、函式型別屬性或遞迴泛型的型別時堆疊溢位，例如 promptex-js 的 `Plugin`，關閉編譯器程序時的錯誤又蓋掉了原本的 RangeError。#92 修正這幾種型別的轉換，fact-kit-facts 的 `fact-kit.converters` 跟著寫出新行為。

#91 只改 `.github/workflows/release-line-finalize.yml`，不碰單元路徑，不升版號。帶入它，產品 Release 的標題才會是 `v0.6.2`。

main 上的 #90（docs，README 說明）不帶入，下一次發布再出去。

## 各單元版號

GA 當下由工具產出後貼入，不手抄。

| 單元    | 實作版號 | tag    |
| :------ | :------- | :----- |
| product | 0.6.2    | v0.6.2 |

## 破壞性變更

無。0.11.0 轉得出的型別，只有含方法或函式型別屬性的輸出會變：方法不再列出（0.11.0 誤寫成方法的回傳型別），函式型別屬性只寫 `$comment`（0.11.0 寫成空物件）。自我引用的型別放進 `$defs`，和 0.4.2 的寫法相同。

## 怎麼退

- 可回退：消費端把 `fact-kit` 與 `fact-kit-facts` 釘回 0.11.0 與 0.6.1。
- 不可回退：已推送的 tag 與已發布到 npm 的版本，補救再發下一個修補版。

## 變更過程

- 0.6 線的 alpha.1：從 `v0.6.1` 重建發布分支，cherry-pick #92 與 #91
- GA
