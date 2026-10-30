// オーケストレーター（runPipeline）の入出力の型（全体設計 2.1）。

import type { SolverPort } from "../ports/SolverPort.js";
import type { FileSystemPort } from "../ports/FileSystemPort.js";
import type { LanguageModelPort } from "../ports/LanguageModelPort.js";
import type { AmbiguityKind, AmbiguityReport, FormalSpecification } from "./formal.js";
import type { Glossary } from "./glossary.js";
import type { IntentCatalog } from "./intent.js";
import type { DomainLedgerCatalog, VerificationOutcome } from "./ledger.js";
import type { ImplementationMap, SpecificationView, ViewRole } from "./projection.js";
import type { Actor, EventStormingMap, ExtractionDiagnostics, ScenarioSelection, ScenarioTarget } from "./scenario.js";
import type { SolverOptions, SolverReport, UnverifiedReason } from "./solver.js";

export interface PipelineDeps {
  /** M1 がソースを読む口。リポジトリのルートを根にしたもの（withRoot）を渡す。 */
  fs: FileSystemPort;
  /** LLM が無いときも、クライアント無しの RecordingLanguageModel を渡す。 */
  llm: LanguageModelPort;
  /** 無ければ M3 は UNVERIFIED（NO_SOLVER）。 */
  solver: SolverPort | null;
}

export interface PipelineOptions {
  selection?: ScenarioSelection;
  solver?: SolverOptions;
  /** 利用者向けの出力の表示の役割（全体設計 2.2）。無ければ "PdM"。 */
  viewRole?: ViewRole;
}

/** 契約のエラーで止まった段。 */
export type StoppedStage = "M1" | "M2" | "M3" | "M4" | "M5";

/** シナリオの行の 3 通りに共通する欄（全体設計 2.1）。起点の種類から下は ScenarioTarget の欄を写したもの。 */
export interface ScenarioRunBase {
  scenarioId: string;
  /** 表示の id（"S-01"。切り出しの順。全体設計 2.2）。 */
  displayId: string;
  boundedContext: string;
  inletType: ScenarioTarget["inletType"];
  actor: Actor;
  /** 画面のルート。画面を持たないシナリオは null。 */
  route: string | null;
  /** 期待イベントの識別子。 */
  expectedEvent: string;
}

export type ScenarioRunResult =
  | (ScenarioRunBase & {
      kind: "COMPLETED";
      outcome: VerificationOutcome;
      /** 未検証の理由の種類。検査済みなら null。 */
      unverifiedReason: UnverifiedReason | null;
      findingCount: number;
      issueCount: number;
    })
  | (ScenarioRunBase & {
      kind: "AMBIGUOUS";
      counts: Record<AmbiguityKind, number>;
    })
  | (ScenarioRunBase & {
      kind: "STOPPED";
      stage: StoppedStage;
      /** エラーの名前（"InletNotFoundError" など）。 */
      error: string;
      /** エラーの reason。reason を持たないエラー（SyntaxExtractionError）は null。 */
      reason: string | null;
      detail: string;
    });

export interface RunReport {
  system: {
    mode: ExtractionDiagnostics["mode"];
    parsedFileCount: number;
    parseFailureCount: number;
    boundedContextCount: number;
    commandCount: number;
    eventCount: number;
  };
  /** 辞書の要約（全体設計 2.1）。 */
  glossary: {
    presentedCount: number;
    recordedCount: number;
    /** 用語が未生成の提示する項目の数（理由の種類ごと）。 */
    notGenerated: { UNREACHABLE: number; INVALID_OUTPUT: number };
    /** 資料の数（読んだもの・先頭だけを読んだもの・読まなかったもの）。 */
    documents: { read: number; truncated: number; omitted: number };
    /**
     * Glossary.gaps の区分ごとの件数。sharedTerms は Bounded Context ごとの組の数。
     * contextHomonyms（Bounded Context ごとに意味が違う言葉）は DDD では正常なので、ずれとしては数えずに別に出す。
     */
    gaps: {
      undocumentedEntries: number;
      unmatchedDocumentNames: number;
      sharedTerms: number;
      contextHomonyms: number;
      multiSourceEntries: number;
    };
  };
  /** 意図の候補の要約（全体設計 2.1）。 */
  intents: {
    /** 候補の欄の数（Bounded Context とシナリオ）。未生成のものも数える。 */
    contextCount: number;
    scenarioCount: number;
    /** 候補が未生成の欄の数（理由の種類ごと。Bounded Context とシナリオの合計）。 */
    notGenerated: { UNREACHABLE: number; INVALID_OUTPUT: number };
  };
  slice: {
    scenarioCount: number;
    rejected: Array<{ inlet: string; reason: string }>;
  };
  /** M0 の切り出しの順。 */
  scenarios: ScenarioRunResult[];
  totals: {
    completed: number;
    ambiguous: number;
    stopped: number;
    ambiguity: Record<AmbiguityKind, number>;
    verification: Record<VerificationOutcome, number>;
  };
  /** 検査の範囲（全体設計 2.1）。 */
  inspectionScope: {
    /** 検査はシナリオごとに行い、シナリオどうしの矛盾は見ていない。 */
    unit: "PER_SCENARIO";
    /** 初回は業務上の不変条件が無いので検査しない（FormalSolver の報告と同じ値）。 */
    invariantChecks: SolverReport["invariantChecks"];
    /** 検証の結果がこの報告に無いシナリオの表示の id（切り出しの順）。未検証・曖昧さで止まった・途中で止まった。 */
    scenariosWithoutVerification: string[];
  };
  /** 元にした辞書の basis をそのまま写す（意図の候補・実装との対応表と同じ）。 */
  basis: Glossary["basis"];
}

/** シナリオ 1 つの成果物。報告の scenarios と同じ順・同じ id。 */
export type ScenarioArtifacts =
  | {
      scenarioId: string;
      displayId: string;
      kind: "COMPLETED";
      spec: FormalSpecification;
      solverReport: SolverReport;
      ledger: DomainLedgerCatalog;
      document: SpecificationView;
      matrix: SpecificationView;
      flow: SpecificationView;
    }
  | {
      scenarioId: string;
      displayId: string;
      kind: "AMBIGUOUS";
      ambiguity: AmbiguityReport;
      /** 曖昧さの一覧（AMBIGUITY_DOCUMENT。SpecProjector の設計 8.4）。 */
      view: SpecificationView;
    }
  | { scenarioId: string; displayId: string; kind: "STOPPED" };

export interface PipelineResult {
  report: RunReport;
  map: EventStormingMap;
  glossary: Glossary;
  intents: IntentCatalog;
  systemViews: { mermaid: SpecificationView; json: SpecificationView };
  scenarios: ScenarioArtifacts[];
  /**
   * 実装との対応表（implementation_map.json。SpecProjector の設計 8.5）。表示の役割に関係なく作る。
   * 状態変数と論点は、最後まで進んだシナリオ（COMPLETED）の分だけ入る。
   */
  implementationMap: ImplementationMap;
}