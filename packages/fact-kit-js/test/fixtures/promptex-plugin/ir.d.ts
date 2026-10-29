/** 資源類型：集合封閉，不可由擴充新增（PDR-006）。 */
export type Kind = 'skill' | 'rule' | 'agent' | 'hook' | 'mcp' | 'instruction' | 'permission' | 'resource' | 'asset' | 'dir';
/** 引用目標：類型加識別字的複合鍵（ADR-001）。 */
export interface RefTarget {
    kind: Kind;
    id: string;
}
/**
 * 內容片段：以資料結構表達，不含任何平台的渲染結果（AC-067）。
 *
 * 欄位順序即契約：這裡的宣告順序要與 Rust 側一致，否則序列化後的鍵序不同，
 * 跨語言對拍會判不等價（AC-083）。
 */
export type Piece = {
    t: 'prose';
    md: string;
} | {
    t: 'section';
    title: string;
    children: Piece[];
} | {
    t: 'table';
    header: Piece[];
    rows: Piece[][];
} | {
    t: 'list';
    items: Piece[];
} | {
    t: 'check';
    items: Piece[];
} | {
    t: 'link';
    name: string;
    url: string;
} | {
    t: 'code';
    lang: string;
    code: string;
} | {
    t: 'quote';
    children: Piece[];
} | {
    t: 'divider';
} | {
    t: 'ordered';
    items: Piece[];
} | {
    t: 'details';
    summary: string;
    children: Piece[];
} | {
    t: 'image';
    alt: string;
    src: string;
} | {
    t: 'file';
    path: string;
} | {
    t: 'ref';
    target: RefTarget;
} | {
    t: 'inline';
    children: Piece[];
} | {
    t: 'bold';
    children: Piece[];
} | {
    t: 'italic';
    children: Piece[];
} | {
    t: 'inlineCode';
    text: string;
} | {
    t: 'inlineLink';
    name: string;
    url: string;
};
export interface Node {
    id: string;
    name: string;
    /** 這個節點做什麼（ADR-036）。未宣告時不出現。 */
    description?: string;
    kind: Kind;
    config?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    content: Piece[];
}
export interface Provenance {
    sourceCommit: string;
    confHash: string;
    engineVersion: string;
}
export interface Ir {
    version: string;
    provenance: Provenance;
    nodes: Node[];
    resources: Node[];
    /**
     * 節點識別（`分類:識別`）對來源位置（`相對專案根的路徑:行號`）。
     *
     * 獨立於 `nodes` 與 `resources` 兩份語意清單之外（AC-345）：那兩份是三個
     * 生態逐位元組對拍的對象，而來源位置在三個生態必然不同（`nodes.ts` 對
     * `nodes.py` 對 `nodes.rs`），混進節點的語意欄位會讓等價比對永久失敗。
     */
    sources: Record<string, string>;
}
