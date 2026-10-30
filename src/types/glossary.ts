// GlossaryBuilder（ユビキタス言語辞書）の出力の型（GlossaryBuilder の設計 4.1・5.1）。

import type { ConfirmationStatus } from "./index.js";

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
  /**
   * 所属の Bounded Context（GlossaryBuilder の設計 5.1）。PRESENTED のときだけ値があり、RECORDED では null。
   * Bounded Context の項目は自分自身。ポリシーは、反応するイベントの Bounded Context（全体マップのポリシーは所属を持たない）。
   */
  contextId: string | null;
  /** またいでいる先の Bounded Context。起動するコマンドの Bounded Context が所属と違うポリシーだけが持つ。ほかは null。 */
  crossesTo: string | null;
  /** 用語の確定の状態。PRESENTED のときだけ値があり（NOT_GENERATED か CANDIDATE）、RECORDED では null。 */
  termStatus: ConfirmationStatus | null;
  /** 意味（資料の抜粋）。sources の先頭の節から機械的に切り出す。出どころが無いか、節に本文が無ければ null。 */
  excerpt: GlossaryExcerpt | null;
}

/**
 * 意味（資料の抜粋）。text は節の本文にある文字列そのもの（印や省略記号を足さない）。
 * 切り出し方は GlossaryBuilder の設計 5.3。
 */
export interface GlossaryExcerpt {
  text: string;
  /** 抜粋を取った節の識別子（sources の先頭）。 */
  source: string;
  /** 上限で切ったとき true。 */
  truncated: boolean;
  /** 初回は常に CANDIDATE。 */
  status: ConfirmationStatus;
}

export interface GlossaryGaps {
  /** 資料の節が 1 つも選ばれなかった提示する項目。 */
  undocumentedEntries: string[];
  /** 資料のインラインコードのうち、どの項目の実装の名前とも一致しない識別子。 */
  unmatchedDocumentNames: Array<{ name: string; sections: string[] }>;
  /** 同義の候補: 同じ Bounded Context の中で、同じ term が付いた提示する項目（設計 5.2）。 */
  sharedTerms: Array<{ term: string; contextId: string; entryIds: string[] }>;
  /**
   * Bounded Context ごとに意味が違う言葉: 同じ term が 2 つ以上の Bounded Context に出るもの（設計 5.2）。
   * entries は Bounded Context ごとに 1 項目（その Bounded Context の中で識別子の最も小さい項目）。ずれとしては数えない。
   */
  contextHomonyms: Array<{ term: string; entries: Array<{ entryId: string; contextId: string }> }>;
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