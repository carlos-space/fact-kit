# FactKit

fact-kit 的 Swift 讀取套件。它讀 `-facts` 套件建好的 `index.json`，依讀者的版號、平台與作業系統選出該讀的 fact。行為規格在倉庫的 [`conformance/README.md`](../conformance/README.md)，五種語言共用同一份樣本。

## 安裝

用 SwiftPM 依賴 `https://github.com/carlos-space/fact-kit`。版號是純 semver tag，例如 `0.3.0`，沒有 `v` 前綴也沒有 component 前綴。

```swift
// Package.swift
dependencies: [
  .package(url: "https://github.com/carlos-space/fact-kit", from: "0.3.0")
],
targets: [
  .target(name: "MyApp", dependencies: [.product(name: "FactKit", package: "fact-kit")])
]
```

需要 `swift-tools-version: 6.0`。最低平台是 macOS 13、iOS 16、tvOS 16、watchOS 9，因為依賴的 SemanticVersion 套件要求這個版本。

## 用法

```swift
import FactKit

let reader = try readFacts(
  "fact-kit-facts/fact-kit-swift",
  root: URL(fileURLWithPath: "/path/to/project"),
  version: "0.3.0"  // 省略時讀最新已發布，"head" 讀還沒發布的狀態
)

reader.has("fact-kit-swift.package")
let fact = try reader.get("fact-kit-swift.package")  // SelectedFact：id、content、since、stability
let value = try reader.value("fact-kit-swift.package")  // content.value，型別是 JSONValue
```

`readFacts` 從 `root` 開始，照 Node 的 `require.resolve` 規則找 `<套件>/<路徑>/index.json`。支援 self-reference、往上層找 `node_modules`、符號連結，以及 `exports` 的字串、陣列、條件物件、巢狀條件、`*` 與 `null`。條件集合是 `node-addons`、`node`、`require`、`module-sync`、`default`。`NODE_PATH` 與全域資料夾不支援。

只有 index 的內容時，用純函式 `selectFacts(_ index: Data, version:include:platform:os:)`。

參數 `version`、`include`、`platform`、`os` 的意義見 [`conformance/README.md`](../conformance/README.md) 的「讀者與查詢」。

## 錯誤代碼

所有讀取錯誤都是 `FactReadError`，`error.code` 回傳和其他語言相同的代碼字串。`get` 與 `value` 找不到 fact 時丟 `FactLookupError`，它不屬於這四個代碼。

| `code`                     | Swift                                  | 何時回                                                                                              |
| :------------------------- | :------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| `not-an-index`             | `FactReadError.notAnIndex`             | 檔案不是 JSON，頂層不是物件，`facts` 不是陣列，或 `package` 不是字串                                |
| `unsupported-index-format` | `FactReadError.unsupportedIndexFormat` | `indexFormat` 的 major 不是 1，或不是 `<數字>.<數字>` 的字串                                        |
| `not-found`                | `FactReadError.notFound`               | 在 `node_modules` 找不到套件，套件沒有 export 那個 `index.json`，檔案不存在，或 `spec` 的寫法不合格 |
| `invalid-version`          | `FactReadError.invalidVersion`         | 查詢的 `version` 不是 `"head"` 也不是完整的 `X.Y.Z`，或 index 裡的 `since` 不是版號                 |

## 和 JS 版的差異

- **`root` 必填。** JS 版預設用目前的工作目錄。Swift 版不這樣做，因為工作目錄在 Xcode 與測試主機下不固定，容易讀到錯的地方。
- **不比對 `describes`。** JS 版在沒給 `version` 時，會拿 `describes` 和已安裝的產品版本比對。Swift 版不做，`reader.describes` 只是原樣回傳。
- **不提供 `onRead`。**
- JSON 用套件自己的解析器。物件保留 key 順序，重複的 key 取最後一個值，位置留在第一次出現的地方。落單的 UTF-16 代理字元會變成 U+FFFD。

## 開發

```sh
swift test
```

測試讀倉庫的 `conformance/`。找不到時設環境變數 `FACT_KIT_CONFORMANCE` 指向該目錄。新增樣本不用改測試程式。
