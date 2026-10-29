// Specula の入口。Node.js と Itera（build:itera の bundle）の両方から読む。
// M0〜M5 の公開コマンドは、各モジュールを書き直すときに足す。

export type { JsonValue, LlmRequest, LlmText } from "./types/index.js";

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
export { RecordingLanguageModel, recordKeyOf } from "./adapters/RecordingLanguageModel.js";
export type { LlmRecord } from "./adapters/RecordingLanguageModel.js";

// M0（ScenarioExtractor）
export type {
  Actor,
  BoundedContext,
  Command,
  DomainEvent,
  EventStormingMap,
  ExtractionDiagnostics,
  IntentStatus,
  Policy,
  ReadModel,
  RepositoryArtifacts,
  ScenarioSelection,
  ScenarioTarget,
  SliceResult,
  SourceLocation,
} from "./types/scenario.js";
export { discoverSystemContext, sliceScenarios } from "./core/scenario_extractor.js";

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
export { withRoot } from "./lib/rooted_file_system.js";

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

export { canonicalJson } from "./lib/canonical_json.js";
export { sha256Hex } from "./lib/sha256.js";

export const VERSION = "0.1.0";