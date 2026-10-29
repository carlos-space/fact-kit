/** 嚴重度：阻斷級中止建置，非阻斷級列入報告後放行（AC-073）。 */
export type Severity = 'error' | 'warning';
/**
 * 一筆診斷。代碼、訊息、位置三項必含（AC-074）。
 *
 * `at` 是陣列而非單值：ID 重複要同時指出兩處宣告的位置（AC-014），單值會
 * 迫使實作把第二處塞進訊息字串，位置就無法被機械擷取。
 */
export interface Diagnostic {
    code: string;
    message: string;
    at: string[];
    hint?: string;
    severity?: Severity;
}
/** 本批診斷是否含阻斷級項目；建置流程以此決定是否寫出產物（AC-075）。 */
export declare function hasErrors(diags: readonly Diagnostic[]): boolean;
/**
 * 一筆診斷的人讀形態，逐行回傳：嚴重度標記（阻斷級 `✗`、非阻斷級 `※`）、
 * 位置逐一列出、有提示才列提示。
 *
 * 格式住單一函式而非各呼叫點各拼一次：三個生態對同一組宣告必須印出同一段
 * 文字，而在本檔之前，命令列工具的三個呼叫點（版本相容檢查、準備階段、
 * 解析遍）各自拼了一份，其中兩份只印代碼與訊息、不印位置與提示；同一份
 * 源碼在不同階段失敗時，作者看到的訊息詳略不同。與
 * `python/promptex-py/src/promptex/diag.py` 的 `format_diagnostic`、
 * `crates/promptex-core/src/diag/mod.rs` 的 `format_diagnostic` 逐行同構。
 *
 * 格式化留在 SDK 而非委派核心：診斷產生於求值期，印出它的編譯輔助程式
 * （`src/cli/compile-engine.ts`、Python 側的 `scripts/build_ir.py`）不載入原生
 * 綁定，改走綁定會讓 SDK 的裸執行路徑失效（見 docs/testing.md）。三個生態
 * 的逐行同構目前沒有自動核對。
 */
export declare function formatDiagnostic(d: Diagnostic): string[];
/**
 * 捕捉呼叫端在源碼中的位置，形態為 `檔案路徑:行號`。
 *
 * 位置要指向作者寫下宣告或引用的那一行，而不是 SDK 內部的實作位置
 * （AC-090），因此往上找到第一個不屬於本套件的呼叫框架。
 *
 * 副檔名與行號之間容許夾一段 `?query`：配置單元模式對同一批檔案重複求值
 * 時以 `?u={unitName}` 破 ESM 模組快取（見 `cli/main.ts` 的 `compile()`
 * `cacheBust` 說明），這讓 import URL 變成 `resources.ts?u=app:15:20` 這種
 * 形態。若不容許這段查詢字串，正則在副檔名後直接找 `:行:列` 會落空，
 * 使得本該落在作者源碼的位置誤判為下一個湊巧吻合的框架（實際發生過：
 * 誤指向 `cli/main.ts` 自己呼叫 `import()` 的那一行）。
 */
export declare function captureAt(): string;
/**
 * 編輯距離：用於斷鏈時提示相近的既有識別（AC-017）。
 *
 * 斷鏈多半是手誤，指出候選比只說「查無定義」省下作者一次全庫搜尋。
 */
export declare function levenshtein(a: string, b: string): number;
/** 把資源類型名轉為引用函式名，讓斷鏈訊息直接顯示作者寫下的那個函式。 */
export declare function useFnName(kind: string): string;
