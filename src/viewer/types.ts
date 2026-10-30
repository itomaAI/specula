// 画面（SpecViewer）の入力と事前条件、画面ごとのビューモデルの型（SpecViewer 基本設計 6.1〜6.3・6.5）。
// src/types/ と、SpecProjector の表示の型（src/core/m5/view_model.ts）だけを参照する（設計 6.3）。
// 画面ごとのビューモデルの型は、その画面を実装するときにここへ足す。

import type { IssueGroupView, VerificationView } from "../core/m5/view_model.js";
import type { AmbiguityKind, AmbiguityReport, FormalSpecification } from "../types/formal.js";
import type { Glossary, GlossaryLocation, PresentedEntryKind } from "../types/glossary.js";
import type { ConfirmationStatus } from "../types/index.js";
import type { IntentCatalog } from "../types/intent.js";
import type { DomainLedgerCatalog, VerificationOutcome } from "../types/ledger.js";
import type { ImplementationMap } from "../types/projection.js";
import type { RunReport, SystemMapBundle } from "../types/run.js";
import type { MarkdownBlock } from "./markdown.js";

/**
 * 1 つのファイルを読んだ結果（設計 6.1）。無いのか壊れているのかで表示する理由が違うので、3 通りに分ける。
 * JSON は JSON.parse の結果をそのまま value に置く。形は検査しないので、型は書き出した側の型を当てているだけである。
 * 書き出した実行が同じものかは checkRunOutputs が basis で確かめる。
 */
export type FileRead<T> =
  | { kind: "OK"; value: T }
  | { kind: "MISSING" }
  // JSON としてパースできない。reason はパースのエラーの文
  | { kind: "INVALID"; reason: string };

/** シナリオ 1 つのファイル。読むファイルは run_report.json のシナリオの kind で決まる（設計 6.1）。 */
export type ScenarioOutputs =
  | {
      scenarioId: string;
      displayId: string;
      kind: "COMPLETED";
      /** spec.json。論点と検証の状態の文を SpecProjector と同じにするために読む（設計 6.5）。 */
      spec: FileRead<FormalSpecification>;
      /** spec.md */
      document: FileRead<string>;
      /** matrix.md */
      matrix: FileRead<string>;
      /** flow.mmd */
      flow: FileRead<string>;
      /** spec.als */
      source: FileRead<string>;
      /** ledger.json */
      ledger: FileRead<DomainLedgerCatalog>;
    }
  | {
      scenarioId: string;
      displayId: string;
      kind: "AMBIGUOUS";
      /** ambiguity.json */
      ambiguity: FileRead<AmbiguityReport>;
    }
  | { scenarioId: string; displayId: string; kind: "STOPPED" };

/** 出力先から読んだファイルの中身（設計 2 節・6.1）。 */
export interface RunOutputs {
  /** run_report.json */
  report: FileRead<RunReport>;
  /** system_map.json */
  systemMap: FileRead<SystemMapBundle>;
  /** glossary.json */
  glossary: FileRead<Glossary>;
  /** intents.json */
  intents: FileRead<IntentCatalog>;
  /** implementation_map.json */
  implementationMap: FileRead<ImplementationMap>;
  /** run_report.json の scenarios の順。run_report.json が読めなければ空。 */
  scenarios: ScenarioOutputs[];
}

/** 画面を作れない理由（設計 6.2）。 */
export interface RunOutputsProblem {
  reason:
    // run_report.json が無い
    | "REPORT_MISSING"
    // JSON のファイルがパースできない
    | "INVALID_JSON"
    // basis を持たない（basis を足す前の古い出力）
    | "NO_BASIS"
    // basis が run_report.json のものと違う（別の実行の出力が混ざっている）
    | "BASIS_MISMATCH"
    // run_report.json のシナリオの kind から決まるファイルが無い
    | "SCENARIO_FILE_MISSING";
  /** 出力先の直下のファイルの名前（"glossary.json"）か、シナリオのディレクトリの中のファイルの名前（"spec.md"）。 */
  file: string;
  /** シナリオのファイルなら、そのシナリオの表示の id。内部の識別子は出さない（仕様 2.3）。 */
  scenario: string | null;
  detail: string;
}

/** 事前条件の検査の結果（仕様 3.1、設計 6.2）。problems はすべて画面を作れない理由なので、ok は problems が空のときだけ true。 */
export interface RunOutputsCheck {
  ok: boolean;
  problems: RunOutputsProblem[];
}

// ---- シナリオ一覧とシナリオの詳細（設計 3.1・3.2・6.5） ----
// 文は SpecProjector と同じく、確定の状態の印を後ろに足した文字列で持つ（設計 6.5）。
// ビューモデルには内部の識別子を入れない。シナリオは表示の id（"S-01"）で指す（設計 4 節）。

export type ScenarioKind = "COMPLETED" | "AMBIGUOUS" | "STOPPED";

/** シナリオ一覧の上部の、実行の概要（設計 3.1）。 */
export interface RunSummaryView {
  parsedFileCount: number;
  parseFailureCount: number;
  boundedContextCount: number;
  commandCount: number;
  eventCount: number;
  scenarioCounts: Record<ScenarioKind, number>;
  /** byKind は Eng のときだけある。PdM は合計だけを「エンジニアの確認待ち: N 件」と出す。 */
  ambiguity: { total: number; text: string; byKind: Array<{ kind: AmbiguityKind; text: string; count: number }> | null };
  verification: Array<{ outcome: VerificationOutcome; text: string; count: number }>;
  /** 検査の範囲の文（実行の報告の inspectionScope から）。 */
  inspectionScope: string[];
  /** 未生成の数（辞書の用語と意図の候補）。0 件でなければ目立たせる。 */
  notGenerated: { glossary: number; intents: number };
  documents: { read: number; truncated: number; omitted: number };
}

/** シナリオの表の 1 行（設計 3.1）。 */
export interface ScenarioRowView {
  displayId: string;
  /** 「S-01 〈表示名〉〈印〉」。名前を出せないときは理由（設計 6.5）。 */
  title: string;
  kind: ScenarioKind;
  /** 「仕様になった」「曖昧さで止まった」「途中で止まった」。 */
  kindText: string;
  /** 仕様になったシナリオだけ。未検証なら理由を含む。 */
  verificationText: string | null;
  /** 論点の件数、または曖昧さの件数の文。途中で止まったシナリオは null。 */
  countText: string | null;
  /** 意図の候補の文（印付き）。無ければ「意図の候補が無い」。 */
  intentText: string;
  /** Bounded Context の表示名（印付き）。 */
  boundedContext: string;
  /** 起点の所在。Eng のときだけある。 */
  inletLocations: GlossaryLocation[] | null;
}

/** シナリオ一覧（設計 3.1）。 */
export interface ScenarioListView {
  summary: RunSummaryView;
  /** Bounded Context が 1 つだけなら false（列を出さない）。 */
  showContextColumn: boolean;
  /** 実行の報告の順（表示の id の順）。 */
  rows: ScenarioRowView[];
}

/** シナリオの詳細の冒頭と、検証の状態・論点（設計 3.2）。タブの中身（仕様書・一覧表・流れ図）は別に足す。 */
export interface ScenarioDetailView {
  displayId: string;
  title: string;
  kind: ScenarioKind;
  kindText: string;
  boundedContext: string;
  intentText: string;
  /** 利用者が書いた目的。無ければ null。 */
  userIntent: string | null;
  /** 「操作」「反応」。 */
  inletTypeText: string;
  actor: string;
  /** 画面を持たないシナリオは null（出さない）。 */
  route: string | null;
  /** 期待イベントの表示名（印付き）。 */
  expectedEvent: string;
  /** 仕様になったシナリオだけ。SpecProjector の仕様書と同じ文。検査の範囲の文（設計 3.2）も lines に入っている。 */
  verification: VerificationView | null;
  /** 仕様になったシナリオだけ。 */
  issueCount: number | null;
  /** 仕様になったシナリオだけ。論点の id は表示の id（"S-01-L-001"）。 */
  issueGroups: IssueGroupView[] | null;
  /** 仕様になったシナリオだけ。タブの中身（設計 3.2・6.6）。流れ図は全体地図と同じ配置の関数で別に作る。 */
  tabs: ScenarioTabsView | null;
  /** 曖昧さで止まった・途中で止まったシナリオで、タブの代わりに出す文。仕様になったシナリオは null。 */
  notice: string | null;
  /** 起点の所在。Eng のときだけある。 */
  inletLocations: GlossaryLocation[] | null;
}

/** シナリオの詳細のタブ（設計 3.2・6.6）。 */
export interface ScenarioTabsView {
  /** 仕様書（spec.md）のブロックの並び。 */
  document: MarkdownBlock[];
  /** 操作の一覧表（matrix.md）のブロックの並び。 */
  matrix: MarkdownBlock[];
  /** 形式仕様のソース（spec.als から `-- @source:` の行を除いたもの）。Eng のときだけ。 */
  source: string | null;
}

// ---- 仕様不備一覧（設計 3.3・6.7） ----
// 論点は SpecProjector の IssueView（issueGroupsOf）をそのまま使う。曖昧さの文は SpecProjector の曖昧さの一覧と同じ。
// 画面どうしのリンクは表示の id（"S-01"・"S-01-L-001"）で指す（設計 6.7）。

/** 仕様になったシナリオ 1 つの論点（設計 3.3）。論点が 1 件以上あるシナリオだけ。 */
export interface ScenarioIssuesView {
  displayId: string;
  /** シナリオ一覧と同じ題。 */
  title: string;
  issueCount: number;
  /** 見出しごとの組（SpecProjector の仕様書と同じ）。 */
  groups: IssueGroupView[];
  /**
   * 論点の表示の id → 操作の一覧表の行の位置（0 から。一覧表の行は形式仕様の操作の順）。
   * 論点から一覧表の該当する行へリンクするために使う（設計 4 節）。
   */
  operationRows: Record<string, number[]>;
}

/** 曖昧さ 1 件（Eng のみ。設計 3.3）。 */
export interface AmbiguityItemView {
  /** "S-02-A-001"。 */
  id: string;
  kind: AmbiguityKind;
  /** 「値が決まらない」など。 */
  kindText: string;
  /** 質問の文と確定の状態の印。未生成ならその理由。 */
  question: string;
  /** 最初のユニットの所在（SpecProjector の曖昧さの一覧と同じく、ファイルと行）。 */
  location: { file: string; line: number };
  /** 式や呼び出しの原文。末尾の改行は除く。 */
  detail: string;
}

/** 曖昧さで止まったシナリオ 1 つ（設計 3.3）。 */
export interface ScenarioAmbiguitiesView {
  displayId: string;
  title: string;
  total: number;
  /** PdM は「エンジニアの確認待ち: N 件」、Eng は「曖昧さ N 件」。 */
  countText: string;
  /** Eng のときだけ。PdM では null（質問・箇所・原文を出さない）。 */
  items: AmbiguityItemView[] | null;
}

/** 仕様不備一覧（設計 3.3）。どちらも実行の報告の順。 */
export interface IssueListView {
  issueTotal: number;
  scenarios: ScenarioIssuesView[];
  ambiguityTotal: number;
  /** PdM ではシナリオ別の件数の表として、Eng では質問の一覧として描く。 */
  ambiguities: ScenarioAmbiguitiesView[];
}

// ---- 用語辞典（設計 3.5・6.8） ----
// 表示の id（"c1"・"n1"）は implementation_map.json の行の glossaryEntryId で引く（俯瞰図と同じ番号）。
// ビューモデルには地図の識別子（内部の識別子）を入れない。ずれのタブの項目も、表示の id と用語の文に直して持つ。

/** 用語の出どころ 1 つ。節の識別子「<資料のパス>#<見出しの並び>」を資料と見出しに分けたもの（GlossaryBuilder 設計 2 節）。 */
export interface GlossarySourceView {
  document: string;
  /** 見出しの並び（" > " でつないだもの）。見出しの無い節は空文字。 */
  heading: string;
}

/** 用語辞典の 1 項目（設計 3.5）。地図の要素（Bounded Context・コマンド・イベント・ポリシー）だけ。 */
export interface GlossaryEntryView {
  /** 俯瞰図と同じ表示の id。実装との対応表が無いか、対応表に行が無ければ null。 */
  displayId: string | null;
  kind: PresentedEntryKind;
  /** 「Bounded Context」「コマンド」「イベント」「ポリシー」（俯瞰図と同じ文）。 */
  kindText: string;
  /** 表示名と確定の状態の印。未生成なら「（名前は未生成）」。 */
  term: string;
  /** 用語の確定の状態。絞り込みに使う。 */
  termStatus: ConfirmationStatus;
  /** 意味（資料の抜粋）と確定の状態の印。抜粋が無ければ「資料に記述が無い」。 */
  meaning: string;
  /** 抜粋を上限で切ったとき true。 */
  meaningTruncated: boolean;
  /** 用語の手がかりにした節（選んだ順）。 */
  sources: GlossarySourceView[];
  /** またぐポリシーだけ。「〈Bounded Context〉へまたぐ」または「〈Bounded Context〉からまたいでくる」。ほかは null。 */
  crossing: string | null;
  /** 実装の名前と所在。Eng のときだけある。 */
  implementation: { names: string[]; locations: GlossaryLocation[] } | null;
}

/** Bounded Context 1 つの区切り。所属の無い項目（全体マップのポリシー）は context が null の区切りに入る。 */
export interface GlossaryContextSectionView {
  /** Bounded Context の表示の id。所属の無い区切りか、引けなければ null。 */
  displayId: string | null;
  /** Bounded Context の用語の文。所属の無い区切りは「所属する Bounded Context が無い」。 */
  title: string;
  entries: GlossaryEntryView[];
}

/** 資料とコードのずれのタブ（設計 3.5）。項目は用語の文と表示の id で指す。 */
export interface GlossaryGapsView {
  /** 資料に記述が無い要素。 */
  undocumented: Array<{ displayId: string | null; term: string }>;
  /** 同義の候補（同じ Bounded Context の中で同じ用語）。 */
  sharedTerms: Array<{ term: string; context: string; entries: Array<{ displayId: string | null; term: string }> }>;
  /** Bounded Context ごとに意味が違う言葉。ずれではなく別の区分。 */
  contextHomonyms: Array<{ term: string; entries: Array<{ displayId: string | null; term: string; context: string }> }>;
  /** 2 つ以上の資料から節が選ばれた項目。 */
  multiSource: Array<{ displayId: string | null; term: string; documents: string[] }>;
  /** 項目に対応しない資料の名前。件数と、開いたときの一覧。 */
  unmatchedDocumentNames: { count: number; items: Array<{ name: string; sources: GlossarySourceView[] }> };
}

/** 用語辞典（設計 3.5）。辞書が無ければ unavailable に理由を入れ、ほかは空にする。 */
export interface GlossaryView {
  /** 辞書が無いときの理由。辞書があれば null。 */
  unavailable: string | null;
  /** 確定の状態の説明の文（候補には印を付けないため、一覧の上に 1 回だけ出す）。辞書が無ければ null。 */
  statusNote: string | null;
  /** 実装との対応表が無く、表示の id を引けないときの文。引けるときは null。 */
  displayIdNote: string | null;
  /** Bounded Context が 1 つだけなら false（区切りを出さない）。 */
  showContextSections: boolean;
  /** Bounded Context の順は俯瞰図と同じ（c1 の順）。所属の無い区切りは最後。 */
  sections: GlossaryContextSectionView[];
  gaps: GlossaryGapsView | null;
}