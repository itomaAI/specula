// GlossaryBuilder（ユビキタス言語辞書）の出力の型（GlossaryBuilder の設計 4.1）。

/** 提示する項目（地図の要素）と、記録だけの項目（機械的に拾える実装の名前）の種類。 */
export type EntryKind =
  | "BOUNDED_CONTEXT"
  | "COMMAND"
  | "EVENT"
  | "POLICY"
  | "ACTOR"
  | "READ_MODEL"
  | "DB_TARGET"
  | "EMITTED_EVENT_NAME"
  | "SCHEMA_ENTITY"
  | "SCHEMA_FIELD";

export type PresentedEntryKind = "BOUNDED_CONTEXT" | "COMMAND" | "EVENT" | "POLICY";

/**
 * 用語。LlmText の JSON の出力を term と label に分けて持つ形。
 * - term: 英字で始まる PascalCase の 1 語（識別子として使える形）
 * - label: 利用者向けの表示名（資料の言語。改行なし、40 字以内）
 */
export type GlossaryTerm =
  | { status: "GENERATED"; term: string; label: string; recordKey: string }
  | { status: "NOT_GENERATED"; reason: "UNREACHABLE" | "INVALID_OUTPUT"; detail: string };

export interface GlossaryLocation {
  file: string;
  symbol?: string;
  line?: number;
}

export interface GlossaryEntry {
  /** 提示する項目と ACTOR・READ_MODEL は地図の識別子。それ以外は "<種類>:<実装の名前>"。 */
  id: string;
  kind: EntryKind;
  scope: "PRESENTED" | "RECORDED";
  /** PRESENTED のときだけある。 */
  term?: GlossaryTerm;
  implementation: {
    /** 実装の名前（辞書順）。 */
    names: string[];
    /** ファイル・行の順。 */
    locations: GlossaryLocation[];
  };
  /** 用語の手がかりにした節の識別子（選んだ順）。RECORDED では空。 */
  sources: string[];
}

export interface GlossaryGaps {
  /** 資料の節が 1 つも選ばれなかった提示する項目。 */
  undocumentedEntries: string[];
  /** 資料のインラインコードのうち、どの項目の実装の名前とも一致しない識別子。 */
  unmatchedDocumentNames: Array<{ name: string; sections: string[] }>;
  /** 同じ term が付いた提示する項目。 */
  sharedTerms: Array<{ term: string; entryIds: string[] }>;
  /** 2 つ以上の資料から節が選ばれた提示する項目。 */
  multiSourceEntries: Array<{ entryId: string; documents: string[] }>;
}

export interface Glossary {
  /** id の辞書順。 */
  entries: GlossaryEntry[];
  gaps: GlossaryGaps;
  documents: {
    read: string[];
    truncated: string[];
    omitted: string[];
  };
  /** 元にした全体マップと資料の SHA-256。 */
  basis: { mapHash: string; documentsHash: string };
}