# fact-kit（Rust）

讀取 fact-kit 建出的 `index.json`。這是 [fact-kit](https://github.com/carlos-space/fact-kit) 的 Rust 讀取套件，行為和 JS 版一致，共用 `conformance/` 的樣本驗證。

## 安裝

```toml
[dependencies]
fact-kit = "0.1"
```

需要 Rust 1.95 以上，edition 2024。

## 用法

```rust
use fact_kit::{ReadFactsOptions, read_facts};

let options = ReadFactsOptions {
    version: Some("0.49.0".into()), // 讀者正在跑的版本，或 "head"。不給時讀最新已發布的內容
    ..ReadFactsOptions::default()
};
let reader = read_facts("demo-facts/sdk", &options)?;

for fact in &reader.facts {
    println!("{} since {}", fact.id, fact.since);
}
if let Some(value) = reader.value("demo.limit") {
    println!("{value}");
}
# Ok::<(), fact_kit::FactReadError>(())
```

`read_facts` 照 Node 的 `require` 規則找 `<套件>/index.json` 或 `<套件>/<路徑>/index.json`，包含 self-reference、往上層找 `node_modules`、符號連結，以及 `exports` 的字串、陣列、條件物件（`node-addons`、`node`、`require`、`module-sync`、`default`）、巢狀條件、`*` 與 `null`。不實作 `NODE_PATH` 與全域資料夾。

`ReadFactsOptions` 的欄位：

| 欄位       | 型別              | 預設         | 說明                                 |
| :--------- | :---------------- | :----------- | :----------------------------------- |
| `root`     | `Option<PathBuf>` | 目前工作目錄 | 解析套件的起點                       |
| `version`  | `Option<String>`  | `None`       | 讀者的版號，或 `"head"`              |
| `include`  | `Vec<String>`     | 空           | `head` 讀者額外要讀的 `pending` 標籤 |
| `platform` | `Option<String>`  | `None`       | 讀者的平台，例如 `"claude-code"`     |
| `os`       | `Option<String>`  | `None`       | `"macos"`、`"linux"` 或 `"windows"`  |

`FactReader` 的成員：`package`、`version`（已安裝 -facts 套件的版號）、`entry`、`describes`、`facts`，以及 `has(id)`、`get(id)`、`value(id)`。`get` 與 `value` 找不到時回 `None`，不丟例外。`value` 在那筆 fact 沒有 `content.value` 時也回 `None`。

只要篩選、不要讀檔，可以呼叫 `select_facts(&index, &SelectOptions)`，`index` 是解析過的 `serde_json::Value`。

## 錯誤代碼

所有函式回 `Result<_, FactReadError>`。`FactReadError` 實作 `std::error::Error`，`code()` 回下表的代碼字串。訊息是給人看的，可能改變，程式請比對代碼。

| 代碼                       | 變體                                    | 意思                                                                              |
| :------------------------- | :-------------------------------------- | :-------------------------------------------------------------------------------- |
| `not-an-index`             | `FactReadError::NotAnIndex`             | 檔案不是 JSON，頂層不是物件，`facts` 不是陣列，或 `package` 不是字串              |
| `unsupported-index-format` | `FactReadError::UnsupportedIndexFormat` | `indexFormat` 的 major 不是 1，或不是 `<數字>.<數字>` 的字串                      |
| `not-found`                | `FactReadError::NotFound`               | 找不到套件、套件沒有 export 那個 `index.json`、檔案不存在，或 `spec` 的寫法不合格 |
| `invalid-version`          | `FactReadError::InvalidVersion`         | 查詢的 `version` 不是 `"head"` 也不是 semver 版號，或 index 裡的 `since` 不是版號 |

所有解析失敗都歸為 `not-found`，不分原因。

## 和 JS 版的差異

- 不比對 `describes` 和已安裝的產品版本。`describes` 只原樣回傳。
- 不提供 `onRead`。
- `root` 預設是目前工作目錄，和 JS 的 `process.cwd()` 相同。

## 開發

```sh
cargo test -- --nocapture
```

測試讀 `conformance/` 的樣本。環境變數 `FACT_KIT_CONFORMANCE` 可以指定它的位置，沒設時從 `rs/` 往上找。`tests/own_facts.rs` 讀本倉庫建好的 `facts/dist`，所以要先在 `facts/` 建置。
