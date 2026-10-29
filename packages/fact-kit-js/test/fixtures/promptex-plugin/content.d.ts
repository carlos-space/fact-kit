import { type Diagnostic } from './diag.js';
import type { Piece } from './ir.js';
import type { Ref } from './registry.js';
/** 建構函式的回傳值。包一層是為了與純字串區分，避免內容陣列的元素型別歧義。 */
export interface MDNode {
    readonly __piece: Piece;
}
/**
 * 章節：可巢狀，子層標題於投影時比父層低一級（AC-031）。
 *
 * 子項收 `ContentChild`（含引用）而非只收字串與建構函式的回傳值：內容陣列
 * 頂層本來就收得下引用，Rust 側的 `section` 也收（`Content` 的元素型別含
 * `ContentItem::Ref`），只有 TS 與 Python 兩側的子項型別把它擋在外面，同一
 * 組宣告因此無法三語言等價（AC-081）。核心的巢狀引用掃描本就支援
 * （`crates/promptex-core/tests/graph.rs` 的
 * `nested_pieces_are_scanned_for_content_refs` 正是建構 section 內含引用的
 * 中介表示），擋著的只有這一層型別。
 */
export declare function section(title: string, ...children: readonly ContentChild[]): MDNode;
/**
 * 表格：表頭與儲存格各收一個內容子項，列長度須與表頭欄數一致（AC-030、AC-540）。
 *
 * 收 `ContentChild` 而非字串，理由與 `bold` 回傳片段同源：字串接不住引用，
 * 而「這一格連到哪一份資源」正是表格最常承載的內容。表頭不另設限制，因為
 * 表頭指向一份資源與儲存格指向一份資源是同一種需求，多一條特例只讓作者
 * 多記一件事。
 *
 * 列長度的約束型別層表達不了（rows 元素的長度與 header 長度的關係無法在
 * readonly ContentChild[][] 上宣告），因此於求值期檢查，不符時記一則診斷、與
 * 其他診斷一次報齊（與 file() 掛載缺檔診斷同一機制，見 contentDiagnostics）。
 */
export declare function table(header: readonly ContentChild[], rows: readonly (readonly ContentChild[])[]): MDNode;
/**
 * 無序清單：每個項目收一個內容子項（純文字、其他建構函式的結果，或一個引用，
 * AC-540）。
 *
 * 項目要由多段併接時以 `inline` 包起，本函式因此不收巢狀陣列：那個形態讓
 * 最常見的純文字清單也得多一層括號，而多段項目有專門的容器承接。
 */
export declare function list(items: readonly ContentChild[]): MDNode;
/** 勾選清單：執行時逐項核對的待辦。項目形態同 `list`。 */
export declare function check(items: readonly ContentChild[]): MDNode;
/** 有序清單：步驟有先後。項目形態同 `list`。 */
export declare function ordered(items: readonly ContentChild[]): MDNode;
/** 外部連結。跨節點的引用一律走 use* 系列，不用本函式。 */
export declare function link(name: string, url: string): MDNode;
export declare function code(lang: string, source: string): MDNode;
export declare function quote(...children: readonly ContentChild[]): MDNode;
export declare function details(summary: string, ...children: readonly ContentChild[]): MDNode;
export declare function image(alt: string, src: string): MDNode;
export declare function divider(): MDNode;
/**
 * 容器型建構函式接受的子項：純文字、其他建構函式的結果，或一個引用。行內
 * 修飾（`bold`／`italic`）與區塊容器（`section`／`quote`／`details`）收的是
 * 同一個集合，與內容陣列頂層的 `ContentPiece` 也一致：同一個值能不能寫，
 * 不該因為它被放在第幾層而不同。
 *
 * 引用的型別以 `import type` 取得，執行期不匯入 registry：型別匯入編譯後
 * 完全消失，兩個模組因此不形成執行期循環（registry 匯入本模組的 `toPiece`）。
 * 執行期辨識改看形狀，`Ref` 是凍結的 `{ id, kind }` 純物件，這個判定與
 * registry 內部的同名判定同構。
 */
export type ContentChild = string | MDNode | Ref;
/**
 * 不帶樣式的行內容器：子項不夾分隔符號併接，不產出任何標記（AC-541）。
 *
 * 補的是「純文字加引用加純文字」這種整句要全部結構化時的缺口：那類句子此前
 * 只能寫成單一字串，而句中的引用受模板字串攔截所限（ADR-003 一度把它登記為
 * 待裁決）。借 `bold` 或 `italic` 來承接會憑空加上樣式，本函式讓整句結構化
 * 不必付這個代價。它同時是清單項目要放多段內容時的承接者（見 `list`）。
 */
export declare function inline(...children: readonly ContentChild[]): MDNode;
/**
 * 粗體：子項不夾分隔符號併接，可包住引用與其他行內修飾。
 *
 * 回傳片段而非字串（原型的形態），因為字串接不住引用：ADR-003 規定引用不可
 * 拼進模板字串、於轉換當下攔截，`bold(useResource('x'))` 只有在片段形態下
 * 才成立。純文字的加粗直接寫 `**` 標記仍然可行，兩者不互斥。
 */
export declare function bold(...children: readonly ContentChild[]): MDNode;
/** 斜體：形態與 `bold` 相同，只差渲染出的標記。 */
export declare function italic(...children: readonly ContentChild[]): MDNode;
/**
 * 行內程式碼：只收文字，不收子片段。
 *
 * markdown 的程式碼片段內不解析標記，收子片段等於允許作者寫出渲染不出來的
 * 結構（例如程式碼片段裡包一個引用連結）。與區塊級的 `code` 分屬兩件事：
 * 後者是帶語言標籤的圍欄區塊。
 */
export declare function inlineCode(text: string): MDNode;
/**
 * 行內連結：與區塊級的 `link` 渲染出同一段文字，區別是結構意圖。
 *
 * `link` 自成一段，`inlineLink` 是行內容器的子項；分成兩個片段類型，消費端
 * （適配、擴充）才分得出「獨立成段的連結」與「夾在文句中的連結」。
 */
export declare function inlineLink(name: string, url: string): MDNode;
/**
 * 內容建構函式在 register() 呼叫鏈之外自行檢出的診斷，供 `resolve()` 併入
 * 求值期的診斷一次回報：file() 的掛載來源缺檔（AC-035）、table() 的列長度
 * 與表頭欄數不符（AC-030）皆記在此。
 *
 * 掛載為模組級狀態而非回傳值攜帶，理由與 registry.ts 的 `uses`／`defDiags`
 * 相同：file()／table() 都是在 content 陣列字面量中直接被呼叫的一般函式，
 * 執行當下不在任何 register() 的呼叫鏈裡，唯一能讓 `resolve()` 事後彙整的
 * 管道是共用的模組狀態。
 */
export declare const contentDiagnostics: Diagnostic[];
/** 求值宿主於載入聚合檔之前設定本輪的專案根。 */
export declare function setProjectRoot(root: string): void;
/** 清掉本輪的專案根：由 `engine.reset()` 呼叫，與註冊表同一個生命週期。 */
export declare function clearProjectRoot(): void;
/**
 * 讀本輪的專案根，未設定時直接拒絕。
 *
 * 不退回 `process.cwd()`：留一條退路，新的求值宿主就能靜默走回工作目錄，
 * 而那個缺口只在使用者真的從子目錄執行時才暴露。
 *
 * 對外公開是給 plugin 的改寫階段脈絡取用（`TransformContext.projectRoot`）：
 * 擴充自產素材來源檔時，寫入與 `defineDir`／`defineAsset` 宣告的解析必須同
 * 一個基準（ADR-005「擴充產出節點，不產出檔案」）。讓兩者共用這一份儲存值
 * 而非各傳一次，是因為多一條傳遞路徑就多一個兩邊取到不同值的機會，而症狀
 * 只在工作目錄與專案根不相等時才出現。
 */
/**
 * 讀本輪的專案根，未設定時回 `undefined`。
 *
 * 與 `requireProjectRoot()` 分開而非讓它多一個旗標：兩者服務的呼叫端不同。
 * 需要基準才能運作的（素材解析、快取落點）用會拒絕的那一個：沒有基準時它們
 * 算出來的路徑一定是錯的，靜默退回工作目錄只會讓錯誤延後暴露。**只是想把路徑
 * 收得好看一點**的（來源位置的相對化）用這一個：沒有基準時原樣保留仍是正確
 * 的資料，為此拒絕求值反而是把一個可有可無的正規化升級成硬性前置。
 */
export declare function currentProjectRoot(): string | undefined;
export declare function requireProjectRoot(): string;
/**
 * 掛載既有檔案為內容。
 *
 * 求值期（即本函式呼叫當下）讀入來源檔並固化為散文片段：中介表示因此自足，
 * 同一份中介表示兩次投影不需要仰賴檔案系統的當下狀態即可逐字相同
 * （AC-066）。這也是投影階段不做任何檔案讀寫的理由：投影是純計算
 * （見 crates/promptex-core/src/project/mod.rs 模組文件）。
 *
 * 來源檔只被讀取、不被改寫（AC-034）：這是零改寫遷移路徑的入口，作者不必
 * 先把既有文件改成結構化片段才能納入治理。內容於產物中逐字呈現（AC-036），
 * 因此不做任何標題層級調整，含不含 `#` 開頭的標題都原樣帶入。
 *
 * 路徑相對於專案根（見 `setProjectRoot`）。找不到來源檔時記一則診斷、內容
 * 留空，讓 `resolve()` 能把多處缺檔一次報齊而非在此中止建置（AC-035）；
 * 來源檔存在但不是 UTF-8 文字（E106，見 `decodeMounted`）、或存在卻讀不出
 * 內容（E107，見 `readMounted`）時同樣各記一則診斷。三種情形都讓內容留空、
 * 都不中止，來源檔的問題因此一次報齊。
 *
 * 讀進來的來源檔交給監看記錄（見 `sources.ts`）：模組系統的載入清單答不出
 * 這些檔案，漏記的表現是作者改了掛載的 Markdown 而產物沒更新（ADR-010 明文
 * 要避免的「改了沒反應」）。缺檔那一支不記錄，與 Rust 側一致：`fs.watch`
 * 對不存在的路徑直接拋 ENOENT，記了會讓監看在下一次同步監看目標時中斷。
 */
export declare function file(path: string): MDNode;
/** 字串直接視為散文片段，這讓純文字與建構函式能在同一個陣列混用（AC-037）。 */
export declare function toPiece(value: string | MDNode): Piece;
