import type { Kind } from './ir.js';
import type { PluginEntry } from './plugin.js';
import { type SelectSpec } from './registry.js';
/**
 * 降級或不支援的一筆記錄，與核心 `adapter::DegradeEntry` 同型（AC-098）：
 * 欄位名與序列化形態逐一對應，`formatReport` 因此可以把整份報告原樣交給
 * 核心格式化。
 */
export interface DegradeItem {
    readonly kind: Kind;
    readonly nodeId: string;
    readonly feature: string;
    /**
     * 降級前後的強制力層級（AC-093 的三段封閉列舉）；純機制缺失（不支援）
     * 而無強制力落差時省略。
     *
     * 第三方適配同樣填得出這兩個欄位，不是內建平台專屬：報告的形態一旦讓
     * 內建適配表達得比第三方多，「官方與第三方使用同一組公開能力」
     * （AC-097）就只剩宣稱。
     */
    readonly from?: Enforcement;
    readonly to?: Enforcement;
    readonly note: string;
}
/** 強制力階梯（AC-093）：機械閘 > 流程閘 > 措辭層，列舉封閉。 */
export type Enforcement = 'mechanical' | 'processGate' | 'wording';
/**
 * 一次第三方投影的安裝報告，與內建平台的 `Report`／`EmitReport` 同一形態
 * （AC-098）：降級與不支援兩類皆進報告，不得靜默丟棄，因此第三方與內建
 * 平台的產物能一併呈現在同一份人讀輸出中，不需要另一套報告格式。
 */
export interface EmitReport {
    readonly platform: string;
    readonly emitted: readonly string[];
    readonly degraded: readonly DegradeItem[];
    readonly unsupported: readonly DegradeItem[];
}
/**
 * 第三方 adapter 的公開介面（AC-097）：官方與第三方適配使用同一組方法。
 * `entries` 讀本平台要產出的節點；`render` 依落點表渲染節點內容；
 * `overrides`／`reserved` 讀本節點的平台覆寫與框架保留鍵；
 * `unsupportedOverride` 記下沒有鍵值面時那筆不支援；`degrade`／`unsupported`
 * 記錄能力落差；`report`／`hasNotes` 取出累積的落差記錄。
 *
 * 兩份累積清單為內部狀態、經 `report` 取出，不另以同名屬性暴露：兩個記錄
 * 方法的名稱（`degrade`／`unsupported`）本身即介面的一部分，把清單也用同名
 * 屬性暴露會與方法名相撞。三個 SDK 的方法集合完全相同，目前沒有自動比對；
 * 少一個方法就是「這個生態的第三方適配做得到的事比另兩個少」。
 */
export interface AdapterContext {
    /**
     * 本平台要產出的節點（省略 kind 即全部）：已套用節點自身宣告的平台限定
     * （`meta.targets`）與配置單元的分發選取（`select`），見
     * `createAdapterContext`。
     */
    entries(kind?: Kind): readonly PluginEntry[];
    /** 依落點表渲染節點內容（AC-100）：第三個參數是落點對照表，不是回呼函式。 */
    render(entry: PluginEntry, selfPath: string, layout: ReadonlyMap<string, string>): string;
    /**
     * 本節點為本平台宣告的平台原生鍵覆寫（`config.platforms.{平台}`），未宣告
     * 或宣告了空物件時回傳 `undefined`（ADR-004「空物件視同未宣告」）。
     *
     * 框架保留鍵（`promptex:` 前綴）已濾掉，回傳的每個鍵都是可原樣併進本平台
     * 產物的原生鍵；保留鍵另由 `reserved` 取出。
     *
     * 這個方法存在的理由是「官方適配也只使用這組公開介面」（ADR-004）此前在
     * 覆寫這一格只是宣稱：內建適配讀的是核心的 `adapter::platform_overrides`，
     * 第三方適配只能自己走 `entry.def.config.platforms[平台]`，於是「空物件視同
     * 未宣告」的判定與保留鍵的過濾各自重造。兩種失效都沒有訊號：判定漂移只在
     * 特定宣告下現形，保留鍵漏濾則直接把框架的指令洩漏成平台不認得的欄位。
     */
    overrides(entry: PluginEntry): Readonly<Record<string, unknown>> | undefined;
    /**
     * 本節點宣告的框架保留鍵（`promptex:` 命名空間），鍵是保留鍵名、值是它的
     * 字串值；未宣告時回傳 `undefined`。
     *
     * 保留鍵是「覆寫的鍵即平台原生鍵」這條形態唯一的例外：它是寫給框架的指令，
     * 由框架消費、不寫進產物（ADR-004）。宣告位置與值形態的錯誤已在投影入口以
     * `E203` 阻斷，本方法回傳的都是合法且可直接使用的值。現行保留鍵只有
     * `promptex:event`（僅 hook 合法）。
     */
    reserved(entry: PluginEntry): Readonly<Record<string, string>> | undefined;
    /**
     * 本節點在本平台的產物沒有承載鍵的位置時，把該筆記進不支援清單；節點未宣告
     * 覆寫時什麼都不做。
     *
     * `form` 由呼叫端寫出本平台該類型的產物形態：哪些類型在本平台沒有鍵值面是
     * 平台知識、住各適配（ADR-009），但「宣告的覆寫沒有落點」這件事對作者的意義
     * 每個平台相同，訊息模板因此共用核心那一份。
     */
    unsupportedOverride(entry: PluginEntry, form: string): void;
    /** 記錄能力降級，進安裝報告。 */
    degrade(item: DegradeItem): void;
    /** 記錄平台不支援而未產出的節點，進安裝報告。 */
    unsupported(item: DegradeItem): void;
    /**
     * 把本次累積的降級與不支援併成安裝報告；`emitted` 由呼叫端依實際寫出的
     * 產物決定，不在本介面判斷。
     */
    report(platform: string, emitted: readonly string[]): EmitReport;
    /**
     * 是否累積了任何降級或不支援記錄：擴充路徑據此決定要不要印報告（無落差時
     * 多印一份空報告只是噪音）。
     */
    hasNotes(): boolean;
}
export type AdapterEmit = (ctx: AdapterContext) => Map<string, string>;
/**
 * 第三方適配的 target：與內建 `claude()`／`codex()` 回傳同一種 `{ platform
 * }` 形狀，多帶一個 `emit` 實作（AC-099）。`defineConfig` 的 `targets`
 * 陣列因此可與內建平台原樣並列宣告，schema 不因擴充而改變。
 */
export interface AdapterTarget {
    readonly platform: string;
    readonly emit: AdapterEmit;
    /**
     * 本適配接受哪些建構參數，標準 JSON Schema（ADR-013）。形態與寫法見
     * `Plugin.configSchema`；`emit` 帶函式本體、不進中介表示，不得寫進宣告。
     */
    readonly configSchema?: unknown;
    /** 各語系的覆蓋層，形態見 `Plugin.configSchemaLocales`。 */
    readonly configSchemaLocales?: Record<string, unknown>;
}
/** 第三方套件用本函式建構 target。 */
export declare function defineTarget(platform: string, emit: AdapterEmit, options?: {
    readonly configSchema?: unknown;
    readonly configSchemaLocales?: Record<string, unknown>;
}): AdapterTarget;
/**
 * 格式化為人讀文字：委派核心 `adapter::Report::format`（經
 * `promptex-js-binding` 的 `formatReport` 匯出，ADR-008），不在 SDK 側重寫。
 *
 * 這裡原本是一份 TypeScript 對等實作。它與核心那份已經分岔：核心會印強制力
 * 階梯（`，強制力 {from} → {to}`），SDK 這份沒有，因為當時的 `DegradeItem`
 * 連 `from`／`to` 兩個欄位都沒有。改為委派之後，第三方適配與內建平台的報告
 * 是同一份機器碼產出的，不再有「寫的當下對得上、核心改了才分岔」的缺口。
 */
export declare function formatReport(report: EmitReport): string;
/**
 * 建立一份 `AdapterContext` 供命令列呼叫第三方 `emit` 或 `extend` 函式。
 *
 * 收平台名與配置單元的 `select`，兩者一起決定 `entries` 回傳哪些節點
 * （見 `registry.ts` 的 `entriesFor`）：節點過濾在內建平台由核心的投影承擔
 * （`meta.targets` 走 `adapter::is_distributed_to`、`select` 走 `toIR`），
 * 第三方適配不經核心投影，同樣兩道排除因此必須在建構脈絡時就帶進來。
 * 少了它們，宣告 `targets: ['claude']` 的節點會被第三方適配照樣產出，多個
 * 配置單元共用同一個 `srcDir` 時每個落點還會收到全庫節點。
 *
 * 累積的落差經 `ctx.report(platform, emitted)` 取出，不再回傳兩個裸陣列：
 * 裸陣列讓呼叫端能繞過介面直接組裝報告，作者的 `emit` 實作卻拿不到同一條
 * 路徑，Python／Rust 兩側則是兩者都走 `report()`。同一件事在三個生態有兩種
 * 形態，就是「這個生態的第三方適配做得到的事比另兩個少」。
 */
export declare function createAdapterContext(platform: string, select?: SelectSpec): AdapterContext;
