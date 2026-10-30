// Specula の入口。Node.js と Itera（build:itera の bundle）の両方から読む。
// M0〜M5 の公開コマンドは、各モジュールを書き直すときに足す。
// 補助の関数（記録のキー・受け取りの解釈・正準化 JSON・SHA-256・ルートの付け替え・リポジトリの読み込み）は公開しない。
// 使うときは元のファイルから読む。

export type { ConfirmationStatus, JsonValue, LlmRequest, LlmText } from "./types/index.js";

export type { FileSystemPort } from "./ports/FileSystemPort.js";
export type {
  LanguageModelClient,
  LanguageModelPort,
  LlmCompletion,
  OutputCheck,
} from "./ports/LanguageModelPort.js";
export type {
  EngineInfo,
  RawInstance,
  SolverPort,
  SolverRequest,
  SolverResponse,
} from "./ports/SolverPort.js";

export { NodeFsAdapter } from "./adapters/NodeFsAdapter.js";
export { IteraVfsAdapter } from "./adapters/IteraVfsAdapter.js";
export type { IteraFs } from "./adapters/IteraVfsAdapter.js";
export { RecordingLanguageModel } from "./adapters/RecordingLanguageModel.js";
export type { LlmRecord } from "./adapters/RecordingLanguageModel.js";
export { CliAlloyAdapter } from "./adapters/CliAlloyAdapter.js";
export type { CliAlloyOptions } from "./adapters/CliAlloyAdapter.js";
export { LocalBridgeAlloyAdapter } from "./adapters/LocalBridgeAlloyAdapter.js";
export type { BridgeFetch, BridgeFetchResponse, LocalBridgeAlloyOptions } from "./adapters/LocalBridgeAlloyAdapter.js";
export { IteraLlmAdapter, ITERA_AGENT_MODEL } from "./adapters/IteraLlmAdapter.js";
export type { IteraLlmOptions, IteraLlmRequestFile, PostTask } from "./adapters/IteraLlmAdapter.js";
export { readIteraRepository } from "./adapters/IteraRepositoryReader.js";
export type { RepositorySource } from "./adapters/IteraRepositoryReader.js";

// M0（ScenarioExtractor）
export type {
  Actor,
  BoundedContext,
  Command,
  DomainEvent,
  EventStormingMap,
  ExtractionDiagnostics,
  Policy,
  ReadModel,
  RepositoryArtifacts,
  RepositoryDocument,
  ScenarioSelection,
  ScenarioTarget,
  SliceResult,
  SourceLocation,
} from "./types/scenario.js";
export { discoverSystemContext, sliceScenarios } from "./core/scenario_extractor.js";

// GlossaryBuilder（ユビキタス言語辞書）
export type {
  EntryKind,
  Glossary,
  GlossaryEntry,
  GlossaryGaps,
  GlossaryLocation,
  GlossaryTerm,
  PresentedEntryKind,
} from "./types/glossary.js";
export { buildGlossary } from "./core/glossary_builder.js";

// IntentSynthesizer（意図の候補）
export type { ContextIntent, IntentCatalog, ScenarioIntent } from "./types/intent.js";
export { IntentContractError } from "./types/intent.js";
export { INTENT_PROMPT_VERSION, synthesizeIntents } from "./core/intent_synthesizer.js";

// M1（ContextExtractor）
export type {
  ExtractionCoverage,
  ExtractionLayer,
  ExtractionUnit,
  ExtractionUnitKind,
  OutletKind,
  RawContextModel,
  UnitLocation,
  UseCaseSlice,
} from "./types/context.js";
export { InletNotFoundError, SyntaxExtractionError } from "./types/context.js";
export { extractContext } from "./core/context_extractor.js";

// M2（FormalTranspiler）
export type {
  AmbiguityIssue,
  AmbiguityKind,
  AmbiguityReport,
  FormalSpecification,
  GuardExpr,
  Operation,
  OperationStep,
  Proposition,
  StateDomain,
  StateVariable,
  TranspilerResult,
  WriteChange,
} from "./types/formal.js";
export { TranspileContractError } from "./types/formal.js";
export { M2_PROMPT_VERSION, transpileFormal } from "./core/formal_transpiler.js";

// M3（FormalSolver）
export type {
  CheckKind,
  CheckResult,
  Finding,
  FindingKind,
  SolverConditions,
  SolverOptions,
  SolverReport,
  TraceStep,
  UnverifiedReason,
} from "./types/solver.js";
export { SolverContractError } from "./types/solver.js";
export { SOLVER_DEFAULTS, verifySpecification } from "./core/formal_solver.js";

// M4（LedgerSynthesizer）
export type {
  DomainLedgerCatalog,
  LedgerIssue,
  LedgerOption,
  LedgerOptionId,
  LedgerVerification,
  VerificationOutcome,
} from "./types/ledger.js";
export { LedgerContractError, ROOT_PRIORITY } from "./types/ledger.js";
export { M4_PROMPT_VERSION, synthesizeLedger } from "./core/ledger_synthesizer.js";

// M5（SpecProjector）
export type {
  AmbiguityProjectionRequest,
  ImplementationMap,
  ImplementationMapEntry,
  ImplementationMapEntryKind,
  ImplementationMapInput,
  ProjectionContext,
  ProjectionRequest,
  ScenarioViewFormat,
  SpecificationView,
  SystemMapLevel,
  SystemProjectionRequest,
  SystemViewFormat,
  ViewRole,
} from "./types/projection.js";
export { ProjectionContractError } from "./types/projection.js";
export { projectAmbiguities, projectImplementationMap, projectSpecification, projectSystemMap } from "./core/spec_projector.js";

// オーケストレーター（全体設計 2.1）。src/cli.ts は node: を静的に読むので、ここからは export しない。
export type {
  PipelineDeps,
  PipelineOptions,
  PipelineResult,
  RunReport,
  ScenarioArtifacts,
  ScenarioRunBase,
  ScenarioRunResult,
  StoppedStage,
  SystemMapBundle,
  SystemMapJson,
} from "./types/run.js";
export { runPipeline } from "./core/orchestrator.js";
// 入口（コマンドラインと Itera OS の起動アプリ）が使う共通の関数。
export { withRoot } from "./lib/rooted_file_system.js";
export { writeOutputs, safeName } from "./lib/write_outputs.js";
export { readRunOutputs } from "./lib/read_outputs.js";

// SpecViewer（画面）。ビューモデルを作る部分（src/viewer/）。描く側は起動アプリ（SpecViewer 基本設計 1.1）。
export type {
  AmbiguityItemView,
  FileRead,
  IssueListView,
  RunOutputs,
  RunOutputsCheck,
  RunOutputsProblem,
  RunSummaryView,
  ScenarioAmbiguitiesView,
  ScenarioDetailView,
  ScenarioIssuesView,
  ScenarioKind,
  ScenarioListView,
  ScenarioOutputs,
  ScenarioRowView,
  ScenarioTabsView,
} from "./viewer/types.js";
export { checkRunOutputs } from "./viewer/check.js";
export { buildScenarioDetails, buildScenarioList } from "./viewer/scenarios.js";
export { buildIssueList } from "./viewer/issues.js";
export type { MarkdownBlock } from "./viewer/markdown.js";
export { parseMarkdown, tableCells } from "./viewer/markdown.js";

export const VERSION = "0.1.0";