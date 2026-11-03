# 發布規劃 v0.8.0

- 類型：milestone
- 狀態：draft
- 產品版號：`v0.8.0`（本文件是產品版號的唯一指派點。上一份發布規劃是 `v0.7.1`，這是下一個 minor）
- Milestone：無，這次發布的工作都已合回 main
- 發布分支：`release/v0.8`，從 main 切出
- 這次發布的單元：fact-kit-js（npm `fact-kit`）、fact-kit-facts（npm `fact-kit-facts`）。fact-kit-py、fact-kit-rs、fact-kit-go、fact-kit-swift 不入版
- 階段路徑：政策檔 `release-policy.json` 的 fact-kit-js 與 fact-kit-facts 都是 `["alpha", "ga"]`

## 含哪些工作

| PR                                                | 單元                        | 狀態   |
| :------------------------------------------------ | :-------------------------- | :----- |
| #112 feat: entry 可選填 layer，index 格式升到 2.1 | fact-kit-js、fact-kit-facts | 已合回 |

v0.7.1 之後 main 上只有 #111（v0.7.1 合回，內容已在 tag）與 #112，沒有其他要排除的變更。

#112 讓 `defineFacts` 接受選填 `layer`（`org`、`product`、`implementation`、`tool`），取值不合法時 build 與 check 失敗。build 把它寫進 index 頂層的 `layer`，`readFacts` 與 `loadInstalledIndex` 讀得出它，index 格式從 2.0 升到 2.1。fact-kit-facts 新增 `fact-kit.entry-layer`、`fact-kit.index-format-2-1`，並替 `fact-kit.index`、`fact-kit.entry-module`、`fact-kit.read-facts` 加 `since: 'next'` 的列。conformance 新增 `index-format-2-1-layer` 與 `index-format-2-1-layer-other-value` 兩個案例。

#112 改到的 `conformance/cases/` 與 `facts/_lib/readers-test.ts` 不在 py、rs、go、swift 四個單元的目錄下，release-please 依路徑判斷它們沒有變更，所以不入版。四個讀取端照讀有 `layer` 的 index，只是不回傳 `layer`。

`facts/fact-kit-js/test/fact-kit-spec.test.ts` 拿 fact-kit-facts 的 head fact 對照 fact-kit-js 的實作，只發其中一個單元時這個測試會失敗，所以兩個單元一起發。

## 各單元版號

GA 當下由工具產出後貼入，不手抄。預期 fact-kit-js 0.13.0、fact-kit-facts 0.8.0，實際以 release-please 的 Release PR 為準。

| 單元    | 實作版號 | tag    |
| :------ | :------- | :----- |
| product | 0.8.0    | v0.8.0 |

## 破壞性變更

無。`fact-kit build` 寫出的 index 一律改成格式 2.1，讀取端接受 1.x 與 2.x，所以 py、rs、go、swift 的 0.5.0 讀取端照讀。`layer` 選填，沒宣告時 index 不寫這個鍵。

## 怎麼退

- 可回退：消費端把 `fact-kit` 與 `fact-kit-facts` 釘回 0.12.1 與 0.7.1，重新 build index。
- 不可回退：已推送的 tag 與已發布到 npm 的版本，補救走上線後修補（`release/v0.8` 從 `v0.8.0` 重建）。

## 變更過程

- 0.8 線的 alpha.1：切發布分支，入版單元 fact-kit-js 與 fact-kit-facts
- GA
