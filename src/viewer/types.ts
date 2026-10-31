// 画面（SpecViewer）の入力と事前条件、画面ごとのビューモデルの型（SpecViewer 基本設計 6.1〜6.3・6.5）。
// src/types/ と、SpecProjector の表示の型（src/core/m5/view_model.ts）だけを参照する（設計 6.3）。
// 画面ごとのビューモデルの型は、その画面を実装するときにここへ足す。

import type { IssueGroupView, VerificationView } from "../core/m5/view_model.js";
import type { AmbiguityKind, AmbiguityReport, FormalSpecification } from "../types/formal.js";
import type { Glossary, GlossaryLocation, PresentedEntryKind } from "../types/glossary.js";
import type { ConfirmationStatus } from "../types/index.js";
import type { IntentCatalog } from "../types/intent.js";
import type { DomainLedgerCatalog, VerificationOutcome } from "../types/ledger.js";
import type { ImplementationMap, ViewRole } from "../types/projection.js";
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
  /** byKind は IMPLEMENTATION のときだけある。BUSINESS は合計だけを「エンジニアの確認待ち: N 件」と出す。 */
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
  /** 起点の所在。IMPLEMENTATION のときだけある。 */
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
  /** 仕様になったシナリオだけ。タブの中身（設計 3.2・6.6・6.9）。流れ図は全体地図と同じ配置の関数で層に並べる。 */
  tabs: ScenarioTabsView | null;
  /** 曖昧さで止まった・途中で止まったシナリオで、タブの代わりに出す文。仕様になったシナリオは null。 */
  notice: string | null;
  /** 起点の所在。IMPLEMENTATION のときだけある。 */
  inletLocations: GlossaryLocation[] | null;
}

/** シナリオの詳細のタブ（設計 3.2・6.6）。 */
export interface ScenarioTabsView {
  /** 仕様書（spec.md）のブロックの並び。 */
  document: MarkdownBlock[];
  /** 操作の一覧表（matrix.md）のブロックの並び。 */
  matrix: MarkdownBlock[];
  /** 形式仕様のソース（spec.als から `-- @source:` の行を除いたもの）。IMPLEMENTATION のときだけ。 */
  source: string | null;
  /** 操作の流れ図（flow.mmd を層に並べたもの。設計 6.9）。 */
  flow: FlowView;
}

// ---- 流れ図と地図のグラフ（設計 3.2・3.4・6.4・6.9） ----
// ノードは並びの位置（0 から）で指す。flow.mmd のノードの識別子（形式仕様の操作の識別子を含む）は持たない。

/** つながり。from・to はノードの並びの位置。 */
export interface GraphEdge {
  from: number;
  to: number;
}

/** 層に並べた配置（layoutLayers。決定論的）。配列はノードの並び・つながりの並びと同じ長さ。 */
export interface GraphLayout {
  /** ノードごとの層（0 が最も上）。 */
  layerOf: number[];
  /** ノードごとの、層の中の並びの位置（0 が最も左）。 */
  orderOf: number[];
  /** 層ごとの、左から順のノードの並びの位置。 */
  layers: number[][];
  /** つながりごとに、閉路を切るために下から上へ向かうものとしたか。自分へのつながりは false。 */
  reversed: boolean[];
}

/** 流れ図のノードの種類（render_flow.ts の識別子の振り方から決まる）。 */
export type FlowNodeKind = "START" | "OPERATION" | "STEP" | "RESULT";

export interface FlowNode {
  kind: FlowNodeKind;
  /** ノードの文（mermaidLabel の置き換えを戻したもの）。 */
  label: string;
}

/** flow.mmd を読んだ結果（parseFlow）。 */
export type FlowGraphRead =
  | {
      kind: "OK";
      /** 「%%」の注意の行（論点カタログが古いときなど）。 */
      notes: string[];
      nodes: FlowNode[];
      edges: GraphEdge[];
    }
  | { kind: "UNREADABLE"; reason: string };

/** シナリオの詳細の流れ図のタブ（buildFlowView）。 */
export type FlowView =
  | {
      kind: "OK";
      notes: string[];
      nodes: FlowNode[];
      edges: GraphEdge[];
      layout: GraphLayout;
    }
  | { kind: "UNREADABLE"; reason: string };

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

/** 曖昧さ 1 件（IMPLEMENTATION のみ。設計 3.3）。 */
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
  /** BUSINESS は「エンジニアの確認待ち: N 件」、IMPLEMENTATION は「曖昧さ N 件」。 */
  countText: string;
  /** IMPLEMENTATION のときだけ。BUSINESS では null（質問・箇所・原文を出さない）。 */
  items: AmbiguityItemView[] | null;
}

/** 仕様不備一覧（設計 3.3）。どちらも実行の報告の順。 */
export interface IssueListView {
  issueTotal: number;
  scenarios: ScenarioIssuesView[];
  ambiguityTotal: number;
  /** BUSINESS ではシナリオ別の件数の表として、IMPLEMENTATION では質問の一覧として描く。 */
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
  /** 実装の名前と所在。IMPLEMENTATION のときだけある。 */
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

// ---- 全体地図（設計 3.4・6.10） ----
// 元は system_map.json（SpecProjector の俯瞰図の JSON を束ねたもの）。要素は俯瞰図の表示の id（"c1"・"n1"）で指す。
// 地図の識別子（内部の識別子）は JSON にも無く、ビューモデルにも入れない。

/** 地図の要素の種類（俯瞰図の JSON の kind）。 */
export type MapNodeKind = "BOUNDED_CONTEXT" | "EVENT" | "COMMAND" | "POLICY" | "ACTOR" | "READ_MODEL" | "AGGREGATE";

/** 地図のつながりの種類。地図 1 は "POLICY"（またぐポリシー）だけ、地図 2 はそれ以外（俯瞰図の JSON の kind）。 */
export type MapEdgeKind = "POLICY" | "EMITS" | "AFTER" | "TRIGGERS" | "INVOKES" | "EXECUTES" | "VIEWED_FROM" | "RAISES";

/** 要素を選んだときのポップアップ（設計 3.4・6.10）。持たないものは null。 */
export interface MapPopupView {
  /**
   * 用語・確定の状態・意味。用語辞典の項目（buildGlossaryView）を表示の id で引いたもの。
   * またぎの文は要素の crossing で持つので、ここでは null にしてある。
   * アクター・リードモデル・アグリゲートは辞書の項目を持たないので null。
   */
  entry: GlossaryEntryView | null;
  /** 辞書の項目を持つ種類なのに entry を引けなかったときの理由。ほかは null。 */
  entryNote: string | null;
  /** Bounded Context だけ: 意図の候補の文と確定の状態の印。候補が無ければ「意図の候補が無い」。 */
  intent: string | null;
  /** Bounded Context だけ: 属するシナリオの数。 */
  scenarioCount: number | null;
  /** コマンドとポリシーだけ: その要素を起点にしたシナリオの表示の id（"S-01"）。 */
  scenarios: string[] | null;
  /** intent・scenarioCount・scenarios を引けなかったときの理由（実装との対応表が無いとき）。ほかは null。 */
  lookupNote: string | null;
}

/** 地図の要素 1 つ。 */
export interface MapNodeView {
  /** 俯瞰図の表示の id（"c1"・"n1"）。 */
  displayId: string;
  kind: MapNodeKind;
  /** 俯瞰図の JSON の label（種類の前置きが入った文。未生成なら「（名前は未生成）」）。 */
  label: string;
  /** 地図 2 のまたぐポリシーだけ: またいでいる 2 つの Bounded Context の表示の id。ほかは null。 */
  crossing: { from: string; to: string } | null;
  /** 壊れた印（JSON の broken が null でなければ true）。初回は常に false。 */
  broken: boolean;
  /** 実装の名前と所在。画面の役割が IMPLEMENTATION で、JSON にあるときだけ。 */
  implementation: { names: string[]; locations: GlossaryLocation[] } | null;
  popup: MapPopupView;
}

/** 地図のつながり 1 つ。from・to は同じ地図の nodes の並びの位置。 */
export interface MapEdgeView extends GraphEdge {
  kind: MapEdgeKind;
  /** 地図 2 は「発生させる」など（俯瞰図と同じ文）。地図 1 はまたぐポリシーの文（JSON の label）。 */
  text: string;
  /** 地図 1 だけ: またぐポリシーの表示の id（地図 2 の要素を指す）。地図 2 は null。 */
  policy: string | null;
  broken: boolean;
}

/** 地図 1 枚。layout は nodes と edges を layoutLayers で層に並べたもの。 */
export interface MapGraphView {
  nodes: MapNodeView[];
  edges: MapEdgeView[];
  layout: GraphLayout;
}

/** 1 つの Bounded Context の地図 2。core と supporting は描く側が切り替える（設計 3.4）。 */
export interface ContextDetailMapView {
  /** 箱の題にする Bounded Context（JSON の先頭のノード）。層には入れない。 */
  context: MapNodeView;
  /** 足す要素なし。 */
  core: MapGraphView;
  /** アクター・リードモデル・アグリゲートを足したもの。 */
  supporting: MapGraphView;
}

/** 全体地図（設計 3.4・6.10）。俯瞰図が無いか形が違えば、理由だけを持つ（画面全体は止めない）。 */
export type MapView =
  | {
      kind: "OK";
      /** Bounded Context が 1 つだけなら true（描く側は地図 2 から開く）。 */
      startWithDetail: boolean;
      contextMap: MapGraphView;
      /** 地図 1 の Bounded Context の順。 */
      details: ContextDetailMapView[];
    }
  | { kind: "UNAVAILABLE"; reason: string };

/**
 * 1 回の実行の画面すべてのビューモデル（設計 1.2・6.11）。buildRunView が 4 つの画面とシナリオの詳細を束ねる。
 * 画面どうしのリンクは、各ビューモデルが持つ表示の id（"S-01"・"S-01-L-001"・"c1"・"n1"）で張る（設計 4 節・6.7）。
 * そのため、別のリンクの表は持たない。
 */
export interface RunView {
  /** 画面の表示の役割（起動アプリの引数）。 */
  viewRole: ViewRole;
  /** シナリオ一覧（設計 3.1）。Global Menu の先頭。 */
  scenarioList: ScenarioListView;
  /** シナリオの詳細（設計 3.2）。scenarioList.rows と同じ順・同じ数。 */
  scenarioDetails: ScenarioDetailView[];
  /** 仕様不備一覧（設計 3.3）。 */
  issues: IssueListView;
  /** 用語辞典（設計 3.5）。 */
  glossary: GlossaryView;
  /** 全体地図（設計 3.4）。俯瞰図が無いか形が違えば理由だけを持つ。 */
  map: MapView;
}