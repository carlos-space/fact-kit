# fact-kit（Python）

讀取 fact-kit 建出來的 `-facts` 套件。行為規格是倉庫裡的 `conformance/README.md`，五種語言的讀取實作共用同一份樣本。

## 安裝

```sh
uv add fact-kit
# 或
pip install fact-kit
```

需要 Python 3.11 以上。依賴 `orjson`（讀 JSON）與 `semver`（比較版號）。PyPI 套件名是 `fact-kit`，匯入名是 `fact_kit`。

## 用法

```python
from fact_kit import FactReadError, read_facts

try:
    reader = read_facts("demo-facts/sdk", root="/path/to/hub", version="0.50.0", platform="claude-code")
except FactReadError as error:
    print(error.code)  # not-an-index、unsupported-index-format、not-found 或 invalid-version
    raise

limit = reader.value("demo.limit")  # 取 content["value"]
fact = reader.get("demo.limit")  # 整筆 fact，帶 content、since，有的話還有 stability
for item in reader.facts:  # 這個讀者看得到的所有 fact，順序同 index
    print(item["id"], item["since"])
```

`read_facts(spec, *, root=None, version=None, include=(), platform=None, os=None) -> FactReader`

| 參數       | 說明                                                                   |
| :--------- | :--------------------------------------------------------------------- |
| `spec`     | `<套件>` 或 `<套件>/<路徑>`，套件名可以帶 scope                        |
| `root`     | 從這個目錄開始找套件，預設是目前的工作目錄。工作目錄不固定時請明確傳入 |
| `version`  | 讀者正在跑的版號，或 `"head"`。沒給時讀最新已發布的內容                |
| `include`  | `head` 讀者額外要讀的 `pending` 標籤                                   |
| `platform` | 讀者的平台，例如 `"claude-code"`                                       |
| `os`       | `"macos"`、`"linux"` 或 `"windows"`                                    |

`FactReader` 有 `package`、`version`（已安裝 fact 套件的版號）、`entry`、`describes`、`facts`、`has(id)`、`get(id)` 與 `value(id)`。`get` 找不到 id 時丟 `KeyError`，`value` 遇到沒有 `value` 的 content 時丟 `ValueError`。

只想篩選已經讀進來的 index 時，用 `select_facts(index, *, version=None, include=(), platform=None, os=None) -> list[dict]`。`compare_versions(a, b)` 與 `release_line(version)` 是版號比較與發布線的公開函式。

## 套件解析

照 Node 的 `require.resolve` 規則，以 `root` 為起點：

1. self-reference：最近的 `package.json` 名稱等於被讀的套件，而且有 `exports` 時，用它解析。
2. 往上層找第一個有 `node_modules/<套件>` 的目錄，並跟著符號連結。
3. `exports` 支援字串、陣列、條件物件（條件集合是 `node-addons`、`node`、`require`、`module-sync`、`default`，依寫的順序）、巢狀條件、`*` 萬用字元與 `null`。
4. 沒有 `exports` 時，退回檔案路徑 `<套件目錄>/<路徑>/index.json`。檔案不存在時，往上一層的 `node_modules` 繼續找。

已知差異：不讀 `NODE_PATH`，也不找全域資料夾。

## 錯誤代碼

所有錯誤都是 `FactReadError`（繼承 `Exception`），用 `.code` 判斷。訊息給人看，之後可能改。

| `.code`                    | 何時                                                                              |
| :------------------------- | :-------------------------------------------------------------------------------- |
| `not-an-index`             | 檔案不是 JSON，頂層不是物件，`facts` 不是陣列，或 `package` 不是字串              |
| `unsupported-index-format` | `indexFormat` 的 major 不是 1，或不是 `<數字>.<數字>` 的字串                      |
| `not-found`                | 找不到套件，套件沒有 export 那個 `index.json`，檔案不存在，或 `spec` 的寫法不合格 |
| `invalid-version`          | `version` 不是 `"head"` 也不是完整的 `X.Y.Z`，或 index 裡的 `since` 不是版號      |

## 和 JS 版的差異

- 不比對 `describes` 與已安裝產品的版本。`reader.describes` 會原樣回傳，但不會因為已安裝的產品比較新而丟錯，也不會用已安裝的版本當預設的 `version`。
- 不提供 `onRead`。

## 開發

```sh
cd py
uv run pytest
```

測試讀倉庫的 `conformance/`。位置不在往上找得到的地方時，設環境變數 `FACT_KIT_CONFORMANCE`。讀自己 facts 的測試用 `FACT_KIT_FACTS` 指到 `facts/` 目錄。
