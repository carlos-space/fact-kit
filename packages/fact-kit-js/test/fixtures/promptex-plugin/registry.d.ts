import { type MDNode } from './content.js';
import { type Diagnostic } from './diag.js';
import type { Ir, Kind, Piece, Provenance } from './ir.js';
import type { Plugin, PluginEntry } from './plugin.js';
/** 內容欄位可接受的形態：純文字、建構函式結果、引用，或它們的陣列。 */
export type ContentPiece = string | MDNode | Ref;
export type Content = ContentPiece | readonly ContentPiece[];
/**
 * 宣告函式的回傳值：帶來源資源的類型資訊（AC-007）。
 *
 * 它同時是引用函式的回傳值，因此可以直接放進另一個節點的 content 而不需要
 * 再包一層。`kind` 是編譯期可見的字面量類型，讓型別系統知道這個引用指向
 * 哪一種資源。
 */
export interface Ref<K extends Kind = Kind> {
    readonly id: string;
    readonly kind: K;
}
interface Entry {
    id: string;
    name: string;
    kind: Kind;
    /** 這個節點做什麼（ADR-036）：進中介表示，是否寫進產物由平台適配決定。 */
    description?: string;
    config?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    content: Content;
    /** 宣告在源碼中的位置，供重複識別的診斷指出兩處各自在哪（AC-014）。 */
    at: string;
    /**
     * 外部引用的佔位登記（`registerExternal`）：讓 `resolve()` 的斷鏈檢查
     * 視同已定義，但 `toIR()` 產出中介表示時排除，因為它不是本次求值的
     * 產出，只是「這個 id 有地方去」的存在證明（AC-058）。
     */
    isExternal?: boolean;
}
/**
 * 配置單元的分發映射（select，PDR-005）：`tags` 前綴匹配、多個為 OR；
 * `exclude` 優先於 `tags`。與 `defineConfig` 同屬配置層概念，型別放在
 * registry.ts 是因為套用時機在這裡（`toIR` 產出節點清單時），而非因為它是
 * 配置檔本身的一部分。
 */
export interface SelectSpec {
    readonly tags?: readonly string[];
    readonly exclude?: readonly string[];
}
/**
 * 本次投影要產出的節點（`entriesFor`）：對註冊表當下的節點套用兩道作者側
 * 排除，供第三方適配的 `AdapterContext.entries` 使用。
 *
 * 兩道篩選的來源不同軸，因此範圍也不同：`meta.targets` 是節點自身宣告
 * 「我不去那個平台」，能力類型與素材一律適用（與核心 `claude::emit`／
 * `codex::emit` 同時篩 `ir.nodes` 與 `ir.resources` 對齊）；`select` 是配置
 * 單元宣告「這次不需要它」，只篩能力類型節點，素材（resource／asset／dir）
 * 不受影響，理由與 `toIR` 相同：素材該不該進產物取決於是否被納入的節點
 * 引用，那是投影階段的事，不是 `select` 的職責。
 *
 * 未經篩選的註冊表讀取（`engine.entries`）留給 plugin 生命週期：plugin 在
 * 求值期執行，時機早於 `select` 套用，它要看的本來就是全部節點；適配在投影
 * 期執行，時機晚於 `select`，兩者的正確輸入不同。
 */
export declare function entriesFor(platform: string, select: SelectSpec | undefined, kind?: Kind): PluginEntry[];
export declare function register<K extends Kind>(kind: K, entry: Omit<Entry, 'kind' | 'at'>): Ref<K>;
/**
 * 登記一筆外部引用的佔位（AC-056 至 AC-058）：配置單元宣告 `externals` 時，
 * 由呼叫端（命令列的配置求值）在求值本地源碼之後、呼叫 `resolve()` 之前
 * 呼叫本函式，讓引用外部目標的 `useSkill(id)` 等不被判為斷鏈。
 *
 * 本地已定義同一個鍵時略過（本地宣告優先，不覆蓋）：作者理論上不該讓
 * 兩者同時發生，但求值端若真的撞上，靜默略過比覆蓋一份可能仍在使用中的
 * 本地登記更安全。
 */
export declare function registerExternal(kind: Kind, id: string): void;
export declare function makeUse<K extends Kind>(kind: K): (id: string) => Ref<K>;
/**
 * `toPieces` 的公開別名：供第三方 adapter（`adapter.ts`）把 `PluginEntry.
 * def.content`（原始 `Content` 形態）正規化為 `Piece[]` 後自行渲染
 * （AC-100）。與 `toNode` 內部使用同一份正規化邏輯，兩者不會因各自另寫
 * 一份而分歧。
 */
export declare function contentToPieces(content: Content): Piece[];
export declare const engine: {
    /**
     * 重置註冊表。每輪求值前呼叫，讓單次編譯的節點集合不受上一輪影響。
     *
     * 一併清掉求值期的專案根：它是本輪求值的脈絡而非長駐設定，留著會讓下一輪
     * 宿主忘了設定時沿用上一輪的值而不自知。宿主因此在 `reset()` 之後、載入
     * 聚合檔之前呼叫 `setProjectRoot()`。
     */
    reset(): void;
    /**
     * 準備階段（06-extensions__10-prepare-stage）：唯一允許 async 的 plugin
     * 生命週期，於收集遍（載入聚合檔）之前執行。逐一 `await` 每個 plugin 的
     * `prepare`，任一個拋錯即收斂為 `plugin-prepare-failed` 診斷（不直接讓
     * 例外中斷整個 process），繼續處理其餘 plugin 讓診斷一次報齊
     * （AC-072 同型延伸）；呼叫端看到非空診斷即應中止、不進入 `transform`。
     *
     * 無 plugin 宣告 `prepare` 時完全不涉及非同步等待：核心無網路的承諾維持
     * 不變，引入帶 `prepare` 的 plugin 是專案自己的選擇。
     *
     * `projectRoot` 是快取目錄與鎖定檔的落點基準，由呼叫端明確傳入而非在此讀
     * `process.cwd()`：ADR-005 要這兩者「一個專案一份」，取工作目錄會讓從專案
     * 根之外呼叫時各長出一份。收必填參數而非可選值，是為了讓任何新的呼叫點都
     * 無法沉默地退回工作目錄。
     */
    prepare(plugins: readonly Plugin[], projectRoot: string): Promise<Diagnostic[]>;
    /**
     * 改寫遍：依宣告順序逐一呼叫每個 plugin 的 `transform`（未宣告則略過）。
     * 順序敏感：後宣告的 plugin 能看到先宣告者於 transform 中新增的節點
     * （`ctx.entries` 每次讀取都是註冊表當下狀態，非呼叫前的快照）。
     *
     * 排在 `resolve()` 之前執行（06-extensions__01-plugin-lifecycle 的順序
     * 契約）：plugin 新增的節點才會一併經過 `resolve()` 的 ID 驗證、斷鏈
     * 檢查與各 plugin 的 `validate`。
     */
    transform(plugins?: readonly Plugin[]): void;
    /**
     * 解析遍：核心檢查（載入宣告衝突、斷鏈引用）先行，各 plugin 的 `validate`
     * 隨後依宣告順序執行（06-extensions__09-multi-plugin-conflict「改寫先於
     * 驗證」：plugin 於 transform 階段產生的節點必須受驗證，因此 validate 排在
     * transform 之後而非之前）。改寫遍產生的衝突診斷（P900）與 plugin
     * validate 回傳的診斷一併併入，診斷一次報齊、不於第一個錯誤處中止
     * （AC-072、AC-035 同型延伸）。
     */
    resolve(plugins?: readonly Plugin[]): Diagnostic[];
    /**
     * 查詢註冊表當下狀態（不含外部引用佔位），依 id 排序；供 plugin 生命週期
     * 之外的呼叫端（如建置腳本讀取 plugin 產生的節點清單）使用，與
     * `livePluginEntries()` 共用同一段實作。
     */
    entries(kind?: Kind): PluginEntry[];
    /**
     * 本次求值實際引用到、但不由本次求值產出的目標（AC-229、AC-232）：
     * `uses` 中命中外部引用佔位的那些鍵，依 `kind:id` 排序去重。
     *
     * 供命令列工具決定哪些落點條目該交給投影階段：多單元配置會把全部兄弟單元
     * 的節點都登記為佔位（條目免宣告是它的前提），但其中絕大多數沒有被本單元
     * 引用，全數寫進旁置的落點表只是讓每個安裝根多出一份與本單元無關的清單。
     * 作者手寫的登記不走這個過濾（那是顯式宣告，即使沒被引用也該進安裝期核對），
     * 過濾的對象只有框架自己推導出來的條目。
     *
     * 呼叫時機在 `resolve()` 之後、下一次 `reset()` 之前：註冊表此時已完整。
     */
    usedExternals(): Array<{
        kind: Kind;
        id: string;
    }>;
    /**
     * 產出中介表示。
     *
     * 節點依識別排序而非依宣告順序：AC-062 要求調換聚合檔的載入順序後註冊表
     * 的內容不變，而 AC-066 要求中介表示逐字相同，兩者合起來意味著輸出的順序
     * 不能取決於作者怎麼排列 import。
     */
    /**
     * `select`（PDR-005）：配置單元的分發映射，只篩掉能力類型節點，素材
     * （resource／asset／dir）不受影響：它們該不該進產物取決於是否被納入的
     * 節點引用，那是 `resolve()` 與投影階段的事，不是 `select` 的職責。
     * 省略 `select` 時行為與既有呼叫端完全相同（單一專案不使用配置單元）。
     */
    toIR(provenance?: Provenance, select?: SelectSpec): Ir;
    /**
     * 節點識別對來源位置的對映：`kind:id` → `檔案路徑:行號`。
     *
     * **與中介表示分開承載，不加進節點的語意欄位**：中介表示的序列化形態本身
     * 即契約（AC-083、AC-084），三個語言逐位元組對拍，多一個鍵會讓全部既有專案
     * 的中介表示指紋改變。來源位置回答的又是另一個問題：「作者在哪裡寫下這個
     * 宣告」，與節點的語意無關，本來就不該混進去。
     *
     * 位置在登記當下即由 `captureAt()` 抓下（`diag.ts`），此前只用於 ID 重複的
     * 診斷（AC-014、AC-090）。消費端需要它的場景有三：把降級與診斷歸屬到來源
     * 檔（AC-509）、依來源檔或資料夾分群、以及表單編輯要定位到那一行。
     *
     * `select` 的處理與 `toIR` 相同（只篩能力類型、素材不受影響），故兩者的鍵
     * 集合逐項對得上；不一致的話消費端會查到一個不在圖上的節點，或反過來。
     *
     * 外部引用佔位排除，理由同 `toIR`：它不是本次求值的產出，其 `at` 是
     * `'external'` 這個佔位字串而非真實位置。
     */
    toSources(select?: SelectSpec): Record<string, string>;
    /**
     * 分類檢索（ADR-009「標籤是三種用途共用的基礎」）：讀 `meta.tags`，以
     * 相等或前綴匹配 `prefix`，回傳命中節點的 id（依 id 排序，決定性與
     * `toIR` 一致）。與 `matchesSelect`（分發選取）、擴充自訂的到場判斷共用
     * 同一段 `matchesTagPrefix` 比對邏輯與同一個欄位，不各自另立一份分類
     * 資料（AC-191）；核心不解讀 `prefix` 或標籤字串的語意，換一套命名空間
     * 行為不變（AC-196、AC-198）。
     *
     * 涵蓋全部登記的資源類型（不限素材外的能力類型），因為「這個資源屬於
     * 哪個範疇」這件事本身不分類型；外部引用佔位（`isExternal`）排除，理由
     * 與 `toIR` 相同：它不是本次求值的產出，只是斷鏈檢查的存在證明。
     */
    byTags(prefix: string): string[];
    /**
     * 供變更前的影響分析（ADR-009「變更某個標籤前可經影響分析得知受波及的
     * 用途與資源」，AC-194）：與 `toIR` 分開的一份輕量節點圖，只答「有哪些
     * 節點、各自標了什麼標籤」，不含引用邊：影響分析要的是「改這個標籤前
     * 誰會被波及」，不需要走訪引用關係；引用邊的完整關係圖是核心投影階段的
     * 編譯產物（`graph.json`，PDR-009），兩者是不同時機、不同消費端的問題。
     *
     * 與 `toIR` 同樣排除外部引用佔位；`tags` 缺省時回傳空陣列而非
     * `undefined`，讓呼叫端不必逐一判斷欄位是否存在即可用 `includes` 掃描。
     */
    toGraph(): {
        nodes: Array<{
            id: string;
            kind: Kind;
            name: string;
            tags: readonly string[];
        }>;
    };
};
export {};
