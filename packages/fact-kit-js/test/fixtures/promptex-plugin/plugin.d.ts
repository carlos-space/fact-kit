import type { Diagnostic } from './diag.js';
import type { Kind } from './ir.js';
import type { ContentPiece } from './registry.js';
/**
 * plugin 生命週期看到的節點視圖。
 *
 * `def` 與登記表內部儲存的是同一份物件參照（非複製）：`appendContent`／
 * `patchConfig` 透過它直接改寫註冊表，plugin 讀 `def` 的其餘欄位（如
 * `description`、`meta`）永遠看到最新狀態，不需要另一條同步機制。
 */
export interface PluginEntry<K extends Kind = Kind> {
    readonly id: string;
    readonly kind: K;
    readonly name: string;
    /** 宣告在源碼中的位置，供診斷指出節點定義於何處。 */
    readonly at: string;
    readonly def: {
        id: string;
        name: string;
        kind: Kind;
        description?: string;
        config?: Record<string, unknown>;
        meta?: Record<string, unknown>;
        content: unknown;
    };
}
export interface ValidateContext {
    /** 當下註冊表的全部節點（不含外部引用佔位），依 id 排序。 */
    readonly entries: readonly PluginEntry[];
    /**
     * 限定某個 kind 的節點清單，避免呼叫端自己再過濾一次。
     *
     * 三個 SDK 都有這一支，且與 `AdapterContext.entries(kind)` 同一種形態：介面
     * 集合在三個 SDK 完全相同，任一邊多一個或少一個都是介面分岔（AC-268 對適配
     * 脈絡的同一條判準，擴充脈絡是同一類「框架交給第三方程式碼的協助」）。此前
     * 只有 Rust SDK 有它，另兩邊的 plugin 作者得自己 filter 一次。
     */
    entriesOf(kind: Kind): readonly PluginEntry[];
    /**
     * 本輪求值的專案根，與 `PrepareContext.projectRoot` 同一個值。
     *
     * 節點宣告裡的來源路徑一律以專案根為基準解析（AC-242），擴充要碰同一批
     * 路徑時因此只能取這個值：`transform` 自產素材來源檔時以它組出寫入的絕對
     * 路徑（宣告端與寫入端同基準，兩者才指向同一個位置），`validate` 檢查宣告
     * 的來源檔存不存在時以它組出待檢查的絕對路徑（AC-243）。取行程的工作目錄
     * 會在工作目錄與專案根不相等時整組錯位，而那正是既有情境永遠碰不到的環境。
     *
     * 為什麼準備階段那一份不夠：這兩件事都要先有節點才做得了，而準備階段的
     * 註冊表為空（AC-225），這類擴充因此連 `prepare` 都不需要宣告，沒有地方
     * 可以先把基準存進閉包。
     */
    readonly projectRoot: string;
    /** 讀本 plugin 的自訂參數（`meta.plugins[pluginName]`）；未宣告回傳 undefined。 */
    params(entry: PluginEntry): unknown;
}
export interface TransformContext extends ValidateContext {
    /**
     * 對節點的 content 追加一段內容（疊加型改寫）。多個 plugin 對同一節點
     * 呼叫本函式時兩者皆生效、順序即呼叫順序，但第二個起的 plugin 會觸發
     * P900 warning（06-extensions__09-multi-plugin-conflict）。
     *
     * 接受純文字、結構化片段（`section`／`table`／`list` 等建構函式的回傳
     * 值）或 `Ref`：擴充在改寫階段以 `define*` 產生的節點沒有平台可落地的
     * 「無條件產出」旗標（ADR-005「擴充只能產出節點，代表『產出一個不對應
     * 任何資源類型的檔案』無法直接表達，須包裝為素材節點並確保它被引用」），
     * 因此產生節點後若要讓它進產物，一律經本函式把回傳的 `Ref` 追加進某個
     * 既有節點的 content，與作者手寫引用完全同構。
     */
    appendContent(entry: PluginEntry, content: ContentPiece): void;
    /**
     * 合併進節點的 config（覆寫型改寫）。衝突偵測到鍵的層級：兩個 plugin
     * 改到同一個 config 鍵才算衝突，觸發 P900 error 並阻斷建置；改不同鍵
     * 不算衝突（06-extensions__09-multi-plugin-conflict）。
     */
    patchConfig(entry: PluginEntry, patch: Record<string, unknown>): void;
}
/**
 * 外部依賴的一筆鎖定記錄（AC 無對應條款，依 promptex-prototype 原型行為
 * 實作）：`ctx.writeLock` 呼叫時整批覆寫，框架合併各 plugin 的區段為單一
 * `promptex.lock.json`（06-extensions__11-github-skills）。
 */
export interface LockEntry {
    readonly id: string;
    readonly source: string;
    readonly version: string;
}
/**
 * 準備階段看到的框架協助（AC 無對應條款，依原型行為實作）：快取落點與
 * 鎖定檔由框架統一提供，不讓各 plugin 自訂路徑：路徑分散時，移除與清理
 * 無從得知該刪哪些目錄，統一路徑是所有權治理的一部分。
 */
export interface PrepareContext {
    /** `{專案根}/.promptex/cache/{pluginName}/`，呼叫 `prepare` 前已確保存在。 */
    readonly cacheDir: string;
    /**
     * 本輪求值的專案根：宣告中的相對來源路徑一律以它為基準解析（AC-242），
     * plugin 要把快取內的絕對路徑換算成可宣告的相對路徑時取這個值。
     *
     * 給的是專案根本身而非換算函式：值在建構這份脈絡時已在手邊，傳遞不帶
     * 任何新邏輯；而換算的使用點在改寫階段，函式要掛就得掛到另一份脈絡上，
     * 契約面反而擴得更大。不給的話 plugin 只能從 `cacheDir` 的形態倒推專案
     * 根，等於把框架的落點實作細節升格為 plugin 必須依賴的契約。
     */
    readonly projectRoot: string;
    /** 寫入本 plugin 的鎖定區段；框架依 plugin 名與 id 雙重排序合併寫檔。 */
    writeLock(entries: readonly LockEntry[]): void;
}
export interface Plugin {
    readonly name: string;
    /** 這個擴充作用在哪幾種節點類型；未宣告即不限。 */
    readonly kinds?: readonly Kind[];
    /**
     * 本擴充接受哪些建構參數，標準 JSON Schema（ADR-013）。
     *
     * 由擴充自己 import 進來、隨中介表示交給讀取端，不由套件描述檔指路：路徑經語言的
     * 模組系統解析，本機開發與發布之後是同一個運算式，作者不必在發布時改自己的程式碼。
     * 讀取端因此也不必知道三個生態的套件裝在哪裡。
     *
     * ```ts
     * import configSchema from './promptex.config.schema.json' with { type: 'json' }
     * export const lint: Plugin = { name: 'lint', configSchema }
     * ```
     *
     * 純資料，因此穿得過中介表示的邊界。未宣告時讀取端退為手寫引數原文，因為「有宣告」與
     * 「沒宣告」的差別只該是欄位多寡，不是兩套介面。
     */
    readonly configSchema?: unknown;
    /**
     * 各語系的覆蓋層：語系標籤 → 「JSON Pointer → 替換值」的對照（ADR-013）。
     *
     * 與基底一起帶進中介表示，因為挑哪一個語系是**讀取端**的事：它才知道使用者要看哪一種
     * 語言，而求值期不知道。基底寫實際文字、覆蓋層只指到要換掉的那幾段，缺的自然退回基底。
     *
     * ```ts
     * import zhTW from './promptex.config.schema.zh-TW.json' with { type: 'json' }
     * export const lint: Plugin = { name: 'lint', configSchema, configSchemaLocales: { 'zh-TW': zhTW } }
     * ```
     */
    readonly configSchemaLocales?: Record<string, unknown>;
    /**
     * 本擴充相容的框架版本範圍，caret 前綴形態（如 `'^2.0.0'`，ADR-005「版本
     * 範圍宣告與編譯期檢查」）：框架直接從此欄位讀出宣告，不需要另一份獨立
     * 維護的相容性清單（AC-217）。省略時視為不限版本、不受檢查（既有擴充在
     * 本機制加入前皆未宣告此欄位，向下相容）。已安裝框架版本落在範圍之外時，
     * 框架於編譯開始前（收集遍之前）即報錯並指出應升級的一方（AC-218）；
     * 範圍語法與比對規則見 `version.ts`。
     */
    readonly version?: string;
    /**
     * 唯一允許 async 的生命週期，於收集遍（載入聚合檔）之前執行。取得的
     * 外部資料經 plugin 自身閉包傳遞給 transform，源碼完全不知道這個階段
     * 存在（06-extensions__10-prepare-stage）。`ctx` 提供快取目錄與鎖定檔
     * 寫入，不需要皆使用；未取用 `ctx` 的既有 plugin 行為不變。
     */
    prepare?(ctx: PrepareContext): Promise<void>;
    /** 解析遍：對註冊表做結構驗證，回傳診斷（空陣列即通過）。 */
    validate?(ctx: ValidateContext): Diagnostic[];
    /** 改寫遍：改寫既有節點、以 define* 新增節點。 */
    transform?(ctx: TransformContext): void;
}
