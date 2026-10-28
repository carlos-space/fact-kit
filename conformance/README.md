# conformance

五種語言的讀取實作共用的規格與測試資料。每種語言讀同一份 `cases/`、`resolve/` 與 `semver.json`，輸出必須和 `expected.json` 相同。五種語言的測試都在 `.github/workflows/conformance.yml` 各自一個 job：JS 是 `packages/fact-kit-js/test/conformance.test.ts`，Python 是 `packages/fact-kit-py/tests/test_conformance.py`，Rust 是 `packages/fact-kit-rs/tests/conformance.rs`，Go 是 `packages/fact-kit-go/conformance_test.go`，Swift 是 `packages/fact-kit-swift/Tests/FactKitTests/ConformanceTests.swift`。各語言的測試先看環境變數 `FACT_KIT_CONFORMANCE` 找這個目錄，沒有時從測試檔的位置往上找，所以新增案例不用改程式。

## 目錄

| 路徑                | 測什麼                                                                                                              |
| :------------------ | :------------------------------------------------------------------------------------------------------------------ |
| `cases/<案例名>/`   | 篩選。輸入 `index.json` 與 `query.json`，輸出和 `expected.json` 比對                                                |
| `resolve/<案例名>/` | 在 `node_modules` 找檔。`root/node_modules/<套件>/` 底下放 `package.json` 與 `dist/...`，`query.json` 多一個 `spec` |
| `semver.json`       | 版號比較與發布線                                                                                                    |

`describes` 和已安裝產品版本的比對只有 JS 做得到，不放進共用樣本。

## index.json 的格式

頂層欄位：

| 欄位          | 型別                          | 說明                                                                                              |
| :------------ | :---------------------------- | :------------------------------------------------------------------------------------------------ |
| `indexFormat` | `"<major>.<minor>"`           | 格式版號。1.1 起建置一律寫入。缺這個欄位時當 `1.0`                                                |
| `package`     | string                        | -facts 套件名                                                                                     |
| `entry`       | string                        | 套件內的子路徑                                                                                    |
| `describes`   | `{ "<component>": "<版號>" }` | 這個 entry 描述的 component 與涵蓋到的最新已發布版本。最多一個 key，`{}` 表示被描述的對象沒有版號 |
| `facts`       | array                         | fact 物件                                                                                         |

讀取實作的規則：

1. 接受所有 `1.x`，major 不是 1（包含 `0.x`、`2.x`、不是 `<數字>.<數字>` 的字串或非字串）時回 `unsupported-index-format`。
2. 同一個 major 裡不認得的欄位一律略過，頂層、fact 與 variant 都一樣。
3. 依序判斷。頂層不是物件，回 `not-an-index`。接著 `indexFormat` 不合格，回 `unsupported-index-format`。最後 `facts` 不是陣列或 `package` 不是字串，回 `not-an-index`。先判斷 `indexFormat`，是因為 major 不同的 index 可以有不同的形狀。

fact 與選列有關的欄位：

| 欄位                                              | 說明                                                                                                          |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------ |
| `id`                                              | 字串                                                                                                          |
| `content`                                         | 沒有 `variants` 時是這筆 fact 的內容。有 `variants` 時是給 1.0 讀取程式用的最新已發布內容，1.1 讀取程式不用它 |
| `variants`                                        | 陣列，每列 `{ since, content, pending?, stability?, platforms?, os? }`                                        |
| `when.since`                                      | 沒有 `variants` 時，整筆 fact 當成一列，這列的 `since`                                                        |
| `when.removeIn`                                   | 讀者到了這個版本，這筆 fact 不出現                                                                            |
| `derivedFrom`、`when.replacement`、`when.movedTo` | 不影響選列。`replacement` 是字串或字串陣列。`derivedFrom` 與 `movedTo` 的寫法是 `<id>` 或 `<spec>:<id>`       |

### since 的三種寫法

- 版號：正式版或預發布版，例如 `"0.49.0"`、`"0.49.0-alpha.1"`。
- `"next"`：還沒發布的下一版。
- 陣列：每條發布線一個版號，例如 `["0.48.1", "0.49.1", "0.50.0"]`。可以用 `"next"` 結尾，例如 `["0.48.1", "next"]`。同一條線在陣列裡只能有一個版號。

## 版號比較規則

- 版號照 semver 2.0.0 的優先序比較。`X.Y.Z` 逐段比數值。有預發布段的版號小於同一個 `X.Y.Z` 的正式版。預發布段逐個識別字比較：數字比數值，數字小於英數字，英數字比 ASCII 順序，前面都相同時識別字少的小。`+` 之後的 build metadata 不參與比較。
- 版號必須是完整的 `X.Y.Z`，不接受 `1.0`、`v1.0.0`、`01.0.0` 這類寫法。不合格時回 `invalid-version`。
- 發布線是版號的 `X.Y`。`0.49.0-alpha.1` 屬於 `0.49` 線，小於 `0.49.0`。
- 兩條發布線比較時只比 `X` 與 `Y`。
- `conformance/semver.json` 是以上規則的案例。每筆 `{ "a", "b", "expected": -1 | 0 | 1 }` 驗比較，每筆 `{ "version", "line" }` 驗發布線。

## 讀者與查詢

`query.json` 的欄位都可省略：

| 欄位       | 說明                                                                               |
| :--------- | :--------------------------------------------------------------------------------- |
| `version`  | 讀者正在跑的 component 版號，或 `"head"`（還沒發布的狀態）。沒給時讀「最新已發布」 |
| `include`  | 字串陣列，`head` 讀者額外要讀的 `pending` 標籤                                     |
| `platform` | 讀者的平台，例如 `"claude-code"`                                                   |
| `os`       | `"macos"`、`"linux"` 或 `"windows"`                                                |
| `spec`     | 只有 `resolve/` 用。`<套件>` 或 `<套件>/<路徑>`，路徑可以有多段                    |

讀者分三種：

- 具體版號 R：`version` 是版號。
- `head`：`version` 是 `"head"`。比所有版號都新，而且包含 `"next"`。
- 最新已發布：`version` 沒給。比所有版號都新，但不包含 `"next"` 與 `pending` 的列。

## 選列規則

一筆 fact 有一個或多個「列」。有 `variants` 時每個 variant 是一列。沒有時整筆 fact 是一列，`since` 取 `when.since`，沒有 `when.since` 時這列一律適用，界線是最小值，條件取 `when.platforms` 與 `when.os`，和 variant 列用同一套規則。

對一個讀者，一列要同時符合以下條件才適用：

1. **pending**：列帶 `pending` 時，只有 `head` 讀者而且標籤在 `include` 裡才適用。
2. **平台條件**：列帶 `platforms` 時，讀者必須有給 `platform` 而且列表含它。列帶 `os` 時，讀者必須有給 `os` 而且列表含它。讀者沒給的條件，帶那個條件的列不適用。不帶條件的列不受影響。
3. **since**：算出界線，算不出界線就不適用。

界線的算法（S 是列裡的版號，R 是具體版號讀者）：

| since        | 具體版號 R             | `head`                                             | 最新已發布             |
| :----------- | :--------------------- | :------------------------------------------------- | :--------------------- |
| 沒有 `since` | 適用，界線是最小值     | 同左                                               | 同左                   |
| 版號 S       | R ≥ S 時適用，界線是 S | 適用，界線是 S                                     | 適用，界線是 S         |
| `"next"`     | 不適用                 | 適用，界線是無限大                                 | 不適用                 |
| 陣列         | 見下                   | 有 `"next"` 時界線是無限大，否則是陣列裡最大的版號 | 界線是陣列裡最大的版號 |

陣列對具體版號 R：

- R 所在的發布線在陣列裡有版號 S 時，R ≥ S 才適用，界線是 S。
- 沒有時，R 的發布線比陣列裡所有版號的發布線都新才適用，界線是陣列裡最大的版號。
- 陣列裡的 `"next"` 對具體版號不算數。

例子，`since: ["0.48.1", "0.49.1", "0.50.0"]`：

| R      | 結果   | 原因                                   |
| :----- | :----- | :------------------------------------- |
| 0.49.0 | 讀不到 | 0.49 線的版號是 0.49.1，R 小於它       |
| 0.48.5 | 讀得到 | 0.48 線的版號是 0.48.1，R 大於或等於它 |
| 0.51.0 | 讀得到 | 0.51 線比陣列裡所有線都新              |
| 0.49.1 | 讀得到 | 0.49 線的版號是 0.49.1，R 等於它       |
| 0.47.9 | 讀不到 | 0.47 線沒有版號，而且不比所有線都新    |

在適用的列裡選一列：

1. 界線最大的優先。
2. 界線相同時，條件較多的優先，`platforms` 與 `os` 各算一個條件。
3. 仍相同時是作者寫重了，`fact-kit check` 在建置時擋下。讀取實作不依賴列的排列順序，要挑一列時用固定的規則，結果就不會隨順序改變。

結果：

- 一列都不適用的 fact 不出現在結果裡。
- `when.removeIn` 是版號時，具體版號讀者 R ≥ `removeIn` 不出現，`head` 讀者一律不出現。最新已發布的讀者，等於 index 裡所有未帶 `pending` 的 `since` 版號中最大的那個（沒有時不套用 `removeIn`），比較方式和具體版號讀者相同。`removeIn` 寫 `"next"` 時只對 `head` 讀者生效。
- `stability: "experimental"` 的列預設讀得到，結果帶 `stability`。
- `since` 或查詢的 `version` 不是版號時回 `invalid-version`。`when.removeIn` 不是版號時當作沒有寫。

## expected.json

```json
{ "facts": [{ "id": "demo.limit", "content": { "value": 20 }, "since": "0.49.0" }] }
```

- `facts` 依 `id` 的字串順序排列。一列都沒有時是空陣列。
- 每筆是 `{ "id", "content", "since", "stability"? }`。`content` 是選到的那列的內容，`since` 是選到的那列的 `since` 原樣（版號、陣列或 `"next"`），選到的列沒有 `since` 時是 `"0.0.0"`。有 `stability` 時才帶。
- 出錯的案例寫 `{ "error": "<錯誤代碼>" }`。只比代碼，不比訊息，因為各語言的例外不同。

## 錯誤代碼

| 代碼                       | 何時回                                                                                              |
| :------------------------- | :-------------------------------------------------------------------------------------------------- |
| `not-an-index`             | 檔案不是 JSON，頂層不是物件，`facts` 不是陣列，或 `package` 不是字串                                |
| `unsupported-index-format` | `indexFormat` 的 major 不是 1，或不是 `<數字>.<數字>` 的字串                                        |
| `not-found`                | 在 `node_modules` 找不到套件，套件沒有 export 那個 `index.json`，檔案不存在，或 `spec` 的寫法不合格 |
| `invalid-version`          | 查詢的 `version` 不是 `"head"` 也不是 semver 版號，或 index 裡的 `since` 不是版號                   |

## resolve 案例

`resolve/<案例名>/root/` 是讀取的 `root`，底下的 `node_modules/<套件>/package.json` 用 `exports` 指到 `dist/.../index.json`。`query.json` 的 `spec` 是 `<套件>` 或 `<套件>/<路徑>`：

- 只寫套件名時讀 `<套件>/index.json`，要有 `"./index.json"` 的 export。
- 有路徑時讀 `<套件>/<路徑>/index.json`，要有 `"./<路徑>/index.json"` 的 export。路徑可以有多段，套件名可以帶 scope。
- 套件的解析方式和 Node 的 `require.resolve` 相同，以 `root` 為起點。以下是各語言必須一致的規則，樣本在 `resolve/` 底下。

解析順序：

1. **self-reference**：從 `root` 往上找最近的 `package.json`。它的 `name` 等於被讀的套件名，而且有 `exports` 時，用它解析，不再找 `node_modules`。只看最近的一個 `package.json`，更上層的不看。名稱不符或沒有 `exports` 時，繼續下一步。
2. **往上層找**：從 `root` 往上，找第一個有 `node_modules/<套件>` 的目錄。近的優先。找到最近的套件後就用它，它沒有 export 那個檔案時回 `not-found`，不會再往更遠的層找。
3. **跟著符號連結**：`node_modules/<套件>` 可以是符號連結，指到 `root` 之外的目錄，像 pnpm 那樣。解析以連結指向的真實目錄為準。
4. **沒有 `exports` 欄位**：套件的 `package.json` 沒有 `exports` 時，退回檔案路徑解析，直接找 `<套件目錄>/<路徑>/index.json`（只寫套件名時是 `<套件目錄>/index.json`）。檔案不存在時，照 Node 的規則往上一層的 `node_modules` 繼續找，都找不到才回 `not-found`。這和有 `exports` 的套件不同，有 `exports` 但沒 export 那個檔案時直接回 `not-found`，不再往上找。

`exports` 的條件與目標：

- 條件集合是 `node-addons`、`node`、`require`、`module-sync`、`default`。其他條件，例如 `import`、`browser`，一律不符合。
- 條件物件照 key 的寫法順序，由上往下，第一個符合集合的條件勝出，後面的不看。`default` 排在前面時，它先勝出。
- 條件的值可以是另一個條件物件，照同樣的規則往內找。內層一個都不符合時，回到外層繼續看下一個 key。
- 目標是陣列時，由前往後取第一個能解析出結果的項目。無效目標與沒有符合條件的項目都略過。
- 目標是 `null` 時回 `not-found`。
- 目標是字串時，必須以 `./` 開頭，路徑段裡不能有 `..` 或 `node_modules`。不合格的目標回 `not-found`。陣列裡的無效目標例外，照上一條略過。
- 所有解析失敗一律回 `not-found`，不分原因。

## 平手規則

選列規則的第 3 條，兩列在同一個讀者下界線與條件都相同時，取 canonical 字串較小的那一列，字串用 UTF-16 code unit 順序比較。canonical 字串是把那一列的 JSON 的 key 排序後，不留空白的輸出。例如 `{"content":{"value":"a"},"since":"0.49.0"}` 比 `{"content":{"value":"b"},"since":"0.49.0"}` 小。

這條只保證值是 ASCII 字串與整數時，各語言的結果一致。其他型別的 canonical 寫法（浮點數、非 ASCII 字元的跳脫）各語言可能不同，共用樣本不涵蓋。整數按文字比較，所以 `10` 的 canonical 字串小於 `9`。樣本在 `cases/tie-*`。

## 加一種語言

1. 實作 `selectFacts` 對應的純函式和 `readFacts` 對應的讀取函式，其中 `readFacts` 建在 `selectFacts` 上。函式名照該語言慣例，參數和 JS 的 `readFacts(spec, options)` 一一對應，寫進 `facts/<語言>/` 的 facts。
2. 寫一個測試，逐一讀 `cases/`、`resolve/` 與 `semver.json`，輸出和 `expected.json` 逐欄相同。
3. 在 `.github/workflows/conformance.yml` 加一個 job，名稱是語言名，步驟是安裝該語言的工具鏈後跑那個測試。不改 `conformance/` 以外的規格。

新增案例時，`expected.json` 一律照本文件的規則手寫，不拿實作的輸出直接存成期望值，否則實作的錯會被當成規格。

## 共用樣本不涵蓋的差異

- JS 的物件會把整數式 key（例如 `"0"`）排到最前，其他語言保留檔案裡的順序。所以共用樣本不放整數式 key，讀取結果的 key 順序遇到整數式 key 時各語言可能不同。
- 單獨的 UTF-16 代理字元（例如 `"\ud800"`）JS 接受，其他語言的 JSON 解析多半報錯。建置產出的 index 不會出現這種字元，所以不做成樣本。
- 開頭有 BOM 的 index 五種語言都回 `not-an-index`，樣本是 `resolve/file-has-bom`。
