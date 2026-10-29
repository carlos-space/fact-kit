import type { SelectSpec } from './registry.js';
import type { Kind } from './ir.js';
import type { Plugin } from './plugin.js';
import type { AdapterContext } from './adapter.js';
export type { SelectSpec } from './registry.js';
export type { Plugin, PluginEntry, TransformContext, ValidateContext } from './plugin.js';
/**
 * 平台適配的擴充：對既有投影加工而非取代。`emit` 宣告「我是一個新平台」，
 * `extend` 宣告「我為既有平台補一種產物形態」。
 *
 * `files` 是本次投影已寫入磁碟的產物，鍵為相對於安裝根的路徑。**核心交出的
 * 初始內容一律是位元組**（AC-258），不依內容猜測該不該解成文字：那種猜測
 * 讓「擴充收到什麼型別」取決於檔案內容（含 NUL 位元組的文字檔會被判成二進
 * 位），同一段擴充邏輯因此在不同專案有不同行為。讀出的值要當文字用時自行
 * `new TextDecoder().decode(value)`。
 *
 * 位元組寫成 `Uint8Array` 而非 Node 的 `Buffer`，理由是型別面不得依賴宿主
 * 全域：`Buffer` 是 `@types/node` 提供的全域名字，寫進公開型別就等於要求每個
 * 消費端都裝那份型別套件，否則本套件的 `dist/config.d.ts` 在對方的 `tsc` 下
 * 直接 `TS2580: Cannot find name 'Buffer'`。這個落差在套件內看不到（開發依賴
 * 在場），只有消費端才撞得到，由 `tsconfig.consumer.json` 那道閘重現。實際交
 * 出的物件在 Node 下仍是 `Buffer`（`Buffer` 本身即 `Uint8Array` 的子型別），
 * 要用 Node 的位元組方法時 `Buffer.from(value)` 即可；宣告成 `Uint8Array` 也
 * 讓三個生態的說法一致（Python 是 `bytes`、Rust 是 `Vec<u8>`）。
 *
 * 寫入端仍接受 `string`：同一輪內先跑的擴充可以往表裡塞字串，後跑的讀到的
 * 就是那個字串，值的型別在加工過程中本來就是混合的。核心只保證初始內容的
 * 型別，不保證整輪都是位元組。
 *
 * 擴充函式可加、可改、也可移除既有投影的產出（如自訂類型的落點搬移：核心
 * 不認得 `meta.type`，會把節點當普通資源寫進預設落點，擴充在加上自己的產物
 * 後刪掉這份重複）。與 `AdapterEmit` 共用同一組 `AdapterContext`，讀節點與
 * 記錄降級／不支援的介面不因是否為新平台而不同。
 */
export type AdapterExtension = (ctx: AdapterContext, files: Map<string, string | Uint8Array>) => void;
/**
 * 平台原生設定的鍵值（AC-102、AC-103）：鍵值逐字寫入該平台的設定檔，框架不做
 * 任何中性對映或轉換。
 *
 * 型別只提供已知鍵的提示，並帶 index signature 作為逃生口：框架不維護鍵白名單
 * （AC-103），平台參數的演進速度快於框架，維護白名單只會讓作者等框架跟進才能用
 * 新參數。索引簽名因此是刻意的，與 `CapabilityConfig`「不留索引簽名」的判準不
 * 衝突 ── 後者的鍵由框架解讀、拼錯即行為與宣告不符，這裡的鍵由平台解讀、框架
 * 從頭到尾不看它。
 */
export interface ClaudeSettings {
    model?: string;
    env?: Record<string, string>;
    cleanupPeriodDays?: number;
    [key: string]: unknown;
}
/**
 * claude 的全域設定（`~/.claude.json` 的頂層鍵）：鍵值原樣寫進 `scope: 'user'` 單元的
 * `{安裝根}/.claude.json`，檔內其餘的鍵（平台自己維護的狀態）不動。
 *
 * 型別提示與索引簽名的取捨同 `ClaudeSettings`：鍵由平台解讀，框架不維護白名單。
 * 物件值會整個取代同名的鍵，例如寫 `projects` 會蓋掉 Claude Code 記錄的信任狀態；
 * `mcpServers` 由 mcp 節點產生，宣告它報 E201；專案層單元宣告 globalConfig 報 E220。
 */
export interface ClaudeGlobalConfig {
    autoConnectIde?: boolean;
    autoInstallIdeExtension?: boolean;
    copyOnSelect?: boolean;
    diffTool?: string;
    [key: string]: unknown;
}
/** codex 的平台原生設定；型別提示與逃生口的取捨見 `ClaudeSettings`。 */
export interface CodexSettings {
    model_reasoning_effort?: string;
    approval_policy?: string;
    [key: string]: unknown;
}
/**
 * 分發目標：投影成什麼平台格式，以及該平台的原生設定。`extend` 對既有平台的
 * 產物加工，`emit`（見 `adapter.ts` 的 `AdapterTarget`）宣告全新平台，兩者
 * 互斥；內建 `claude()`／`codex()` 三者皆可省略，省略時維持既有行為。
 *
 * 平台原生設定住目標而非單元或源碼（ADR-006「落點與選取住單元，平台設定住
 * 目標」）：各平台的設定鍵完全不同、沒有共通形態，因此跟著平台走。住源碼會
 * 直接抵觸同一份 ADR 的「源碼不讀配置」 ── 宣告期沒有「當次單元」這件事，同一
 * 份源碼被多個單元求值時，源碼側的設定宣告因此會外溢到每一個單元。
 */
export interface Target {
    readonly platform: string;
    /**
     * 本適配接受哪些建構參數，標準 JSON Schema（ADR-013）。形態與寫法見
     * `Plugin.configSchema`。
     *
     * 描述的是引數的**資料部分**：外層那一個 `settings` 照實描述、不隱藏（藏起來會讓
     * 宣告與實際引數對不上）。`extend` 與 `emit` 帶函式本體、不進中介表示，因此不得
     * 寫進宣告：寫了會長出一個填了也寫不回去的欄位。
     */
    readonly configSchema?: unknown;
    readonly configSchemaLocales?: Record<string, unknown>;
    readonly extend?: readonly AdapterExtension[];
    /** 該平台的原生設定；鍵值逐字寫入該平台的設定檔。 */
    readonly settings?: Record<string, unknown>;
    /**
     * 該平台的全域設定；鍵值逐字寫進使用者層單元的全域設定檔（claude 為 `.claude.json`）。
     * 只有內建 `claude()` 收這個選項，且只在 `scope: 'user'` 的單元有意義。
     */
    readonly globalConfig?: Record<string, unknown>;
    /**
     * 平台 plugin 的分組（ADR-044），只有內建 `claude()`／`codex()` 收這個選項；
     * 第三方適配（`defineTarget`）不提供它，核心對第三方目標的宣告以 E219 阻斷。
     */
    readonly plugins?: readonly PlatformPlugin[];
}
/**
 * 目標上的一個平台 plugin（ADR-044）：把一組節點打包成平台原生的 plugin。
 *
 * `select` 沿用單元的 `SelectSpec`，但只決定歸屬：它在單元的 `select` 已選出的
 * 節點裡分組，選不到單元沒選的節點。沒被任何 plugin 選到的節點照常各自安裝；
 * 一個節點在同一目標最多屬於一個 plugin。
 *
 * 這和單元的 `plugins`（解析期擴充，`Plugin`）是兩件事：這裡的產物是平台的 plugin
 * 目錄，那裡是解析節點時執行的擴充。
 */
export interface PlatformPlugin {
    /** plugin 名稱：小寫英數加 `-`，長度 1 至 64，不含 `--`，不用 Claude 保留名。 */
    readonly name: string;
    /** 版本字串，不核對格式；省略時不寫進 manifest。 */
    readonly version?: string;
    readonly description?: string;
    readonly select: SelectSpec;
    /** 原樣帶進 manifest 的其他欄位；不得覆寫框架產生的鍵（name、元件路徑等）。 */
    readonly manifest?: Record<string, unknown>;
    /** mod 的 hooks module 路徑，相對 plugin 根目錄，指向同一個 plugin 內 dir 節點的檔案（只屬於 Claude）。 */
    readonly modules?: string;
}
/** codex 目標的平台 plugin：mod 只屬於 Claude，因此沒有 `modules`。 */
export type CodexPlatformPlugin = Omit<PlatformPlugin, 'modules'>;
/** claude target 建構器的選項。 */
export interface ClaudeTargetOptions {
    readonly extend?: readonly AdapterExtension[];
    readonly settings?: ClaudeSettings;
    /** 全域設定（`.claude.json` 的頂層鍵），只在 `scope: 'user'` 的單元有意義。 */
    readonly globalConfig?: ClaudeGlobalConfig;
    /** 打包成 Claude plugin 的節點分組（ADR-044）。 */
    readonly plugins?: readonly PlatformPlugin[];
}
/** codex target 建構器的選項。 */
export interface CodexTargetOptions {
    readonly extend?: readonly AdapterExtension[];
    readonly settings?: CodexSettings;
    /** 打包成 Codex plugin 的節點分組（ADR-044）。 */
    readonly plugins?: readonly CodexPlatformPlugin[];
}
/** claude target 建構器：求值為 `{ platform: 'claude' }`（AC-086），可選帶 `extend` 擴充既有平台的產物形態、`settings` 宣告平台原生設定。 */
export declare const claude: (options?: ClaudeTargetOptions) => Target;
/** codex target 建構器：求值為 `{ platform: 'codex' }`（AC-086），可選帶 `extend` 擴充既有平台的產物形態、`settings` 宣告平台原生設定。 */
export declare const codex: (options?: CodexTargetOptions) => Target;
/**
 * 外部引用的一筆落點條目（AC-056、AC-058、AC-060）：可被引用、但不由本單元
 * 產出的目標。承載的是「那個節點叫什麼、裝在哪」，不是它的內容；引用渲染為
 * 指向該落點的連結，本單元既不複製也不投影它。
 *
 * `path` 相對引用方的安裝根（`outDir`），可用 `../` 跳出安裝根指向 repo 內
 * 任意位置：一般節點的落點由框架依平台規則計算，外部條目的落點則由條目自己
 * 說了算。
 *
 * `version`／`source` 選填，由條目的來源決定填不填（見 `ExternalSpec`）：
 * 手寫登記兩者皆缺，安裝報告據此把它標為無版本可核對。
 */
export interface ExternalEntry {
    readonly kind: Kind;
    readonly id: string;
    readonly name: string;
    readonly path: string;
    /** 版本或內容雜湊；手寫登記通常沒有，報告據此區分信任層級。 */
    readonly version?: string;
    /** 條目出處（`unit:{單元名}`、`config:{配置檔路徑}`）；手寫登記為空。 */
    readonly source?: string;
}
/**
 * 另一個可在本地執行的 promptex 專案（AC-232）：不逐筆手寫條目，改指向對方的
 * 配置檔，由命令列工具執行它的查詢指令問出節點清單，落點接上對方的安裝根。
 *
 * 指向配置檔而非目錄：一個 repo 可能有多份配置，指到檔案才不必猜哪一份。
 * 路徑相對本配置檔所在目錄。
 *
 * 查詢的實際執行住命令列工具層而非本套件（POL-001「執行另一個專案的查詢指令
 * 由呼叫端主動授權，框架不隱含發起」）：寫下這一筆即是作者的授權，框架不會
 * 去查任何沒被宣告的專案。
 */
export interface ExternalConfigRef {
    readonly config: string;
}
/**
 * 外部條目的宣告形態。同一份配置的其他單元不在此列：那些由框架自己求值取得
 * （落點依當次目標平台推導，AC-229 至 AC-231），配置只需宣告本配置之外的東西
 * 同一份配置一起提交、一起演化，顯式宣告依賴換不到任何保護。
 *
 * 兩種形態的判準單一：對方能不能在本地跑起來。跑得起來就問它
 * （`ExternalConfigRef`）；跑不起來（非 promptex 資源、只有裝好產物的 repo）
 * 就手寫一筆（`ExternalEntry`），後者的正確性由作者負責。
 *
 * 三種來源產出同一種條目，因此下游的解析、渲染與核對只有一套：條目怎麼來
 * 只影響填入陣列的方式，不影響陣列本身如何被消費。
 */
export type ExternalSpec = ExternalEntry | ExternalConfigRef;
/** 區分兩種宣告形態：`config` 欄位存在即為指向另一個專案的配置檔。 */
export declare function isExternalConfigRef(spec: ExternalSpec): spec is ExternalConfigRef;
/**
 * 配置單元：裝什麼（`srcDir` + `select`）→ 裝到哪（`outDir` + `scope`）→
 * 投影成什麼（`targets`）。
 */
export interface ConfigUnit {
    /** 供報告與診斷辨識；也是登記依單元分目錄的目錄名（AC-121）。 */
    readonly name?: string;
    /** 提示詞源碼目錄。 */
    readonly srcDir: string;
    /** 資源到目標的分發映射；省略即全部節點。 */
    readonly select?: SelectSpec;
    /** 省略時依 `scope` 取預設（`user` 為 `~`、`project` 為 `.`）。 */
    readonly outDir?: string;
    /** 省略時由 `outDir` 是否為家目錄相對路徑推導，兩者皆缺省時取 `project`。 */
    readonly scope?: 'user' | 'project';
    /** 至少一個；`claude()`／`codex()` 等平台。 */
    readonly targets: readonly Target[];
    /** 本單元專屬，不必全域共用。 */
    readonly plugins?: readonly Plugin[];
    /** 引用不由本單元產出的目標時，提供它們的落點條目或對方的配置檔位置。 */
    readonly externals?: readonly ExternalSpec[];
}
/**
 * 收一個單元或一組單元，一律整理為陣列（AC-085）。沒有 `install`／
 * `workspaces` 之類的中介層：單一專案傳一個單元物件、monorepo 傳一組。
 *
 * 本函式不推導任何預設值：`name`／`outDir`／`scope` 的預設值屬多單元編排，
 * 由核心一份實作產出（ADR-008 界線二、AC-240），命令列工具把
 * `configToIR()` 的結果交給核心的編排入口時才發生。作者側的宣告介面因此
 * 維持零原生依賴，純語言匯入的單元測試不必先建置綁定。
 */
export declare function defineConfig(unit: ConfigUnit | readonly ConfigUnit[]): ConfigUnit[];
/**
 * config IR 中一個已求值的單元：函式呼叫全部化為純資料（AC-086、AC-088）。
 *
 * `name`／`outDir`／`scope` 為選填：它們的預設值由核心推導，未宣告時這份
 * 中介表示就不帶該欄位，核心據此補上（AC-240）。
 */
/** 中介表示裡的一個適配：平台名、平台原生設定，加上它的參數宣告（ADR-013） */
export interface TargetIR {
    readonly platform: string;
    readonly settings?: Record<string, unknown>;
    readonly globalConfig?: Record<string, unknown>;
    readonly configSchema?: unknown;
    readonly configSchemaLocales?: Record<string, unknown>;
    readonly plugins?: readonly PlatformPluginIR[];
}
/** 中介表示裡的一個平台 plugin：欄位順序與核心的 `PluginDecl` 相同，三語言逐字一致。 */
export interface PlatformPluginIR {
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
    readonly select: SelectSpec;
    readonly manifest?: Record<string, unknown>;
    readonly modules?: string;
}
/** 中介表示裡的一個擴充：求值期的名字，加上它的參數宣告（ADR-013） */
export interface PluginIR {
    readonly name: string;
    readonly configSchema?: unknown;
    readonly configSchemaLocales?: Record<string, unknown>;
}
export interface ConfigUnitIR {
    readonly name?: string;
    readonly srcDir: string;
    readonly select?: SelectSpec;
    readonly outDir?: string;
    readonly scope?: 'user' | 'project';
    readonly targets: readonly TargetIR[];
    readonly plugins: readonly PluginIR[];
    readonly externals: readonly ExternalSpec[];
}
export interface ConfigIr {
    readonly version: string;
    readonly units: readonly ConfigUnitIR[];
}
/**
 * 命令列工具交給核心編排入口的配置形態（ADR-008 協作形態第 1 步）。
 *
 * 與 config IR 同構但不推導任何預設值：`name`／`outDir`／`scope` 未宣告時
 * 就不帶該欄位，由核心補上（AC-240）。這是本套件對「配置正規化歸核心」的
 * 落實點：命令列工具實際消費的單元名、範圍與落點目錄全部由核心算出，本檔
 * 不參與。
 *
 * `extend`／`emit` 這類帶函式本體的欄位不序列化：命令列工具收到核心的編排
 * 計畫後，依單元在陣列中的位置取回它們。
 *
 * 路徑與其他欄位在呼叫本函式前已由 JS 求值完成（AC-087）：`join(here, …)`
 * 這類運算式的結果本來就是一個字串，本函式不做任何額外的路徑運算，只是把
 * 已經求值好的單元陣列原樣序列化。
 */
export declare function configToOrchestrationIR(units: readonly ConfigUnit[]): ConfigIr;
/**
 * 配置經求值產出中介表示（AC-086）：形態與節點的中介表示同構（`version`
 * 欄位加求值後陣列），但這是獨立的一份中介表示，不併入 `engine.toIR()`
 * 的節點 IR：配置描述的是「分發到哪」，節點 IR 描述的是「分發什麼」，
 * 兩者的求值時機、消費端都不同。
 *
 * 與 `configToOrchestrationIR` 已收斂為同一份實作：本函式此前補上 `name`／
 * `outDir`／`scope` 的預設值，那份推導已歸核心一份（ADR-008 界線二、
 * AC-240），兩者因此不再有任何差別。保留這個既有名稱供產出 config IR 的
 * 呼叫端使用（三語言逐字比對的契約面），但不再有第二份推導可漂移。
 */
export declare const configToIR: typeof configToOrchestrationIR;
