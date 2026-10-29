export interface BoundedContextDefinition {
  id: string;
  name: string;
  rootPath?: string;
  isDefaultFallback: boolean;
}

export interface DomainEvent {
  id: string;
  name: string;
  label?: string;
  contextId: string;
  aggregate?: string;
}

export interface DomainCommand {
  id: string;
  name: string;
  label?: string;
  contextId: string;
  actorId: string;
  readModelId: string;
  handlerName?: string;
}

export interface DomainPolicy {
  id: string;
  name: string;
  label?: string;
  triggerEventId: string;
  actionCommandId: string;
}

export interface ReadModel {
  id: string;
  name: string;
  route: string;
  componentFile: string;
  screenshotPath?: string;
}

export interface Actor {
  id: string;
  name: string;
}

export interface Aggregate {
  id: string;
  name: string;
  contextId: string;
}

export interface EventStormingMap {
  boundedContexts: BoundedContextDefinition[];
  events: DomainEvent[];
  commands: DomainCommand[];
  policies: DomainPolicy[];
  readModels: ReadModel[];
  actors: Actor[];
  aggregates: Aggregate[];
}

export interface ScenarioTarget {
  id: string;
  boundedContext: string;
  intent: string;
  inletType: "COMMAND" | "POLICY";
  inletTrigger: {
    name: string;
    handlerName?: string;
  };
  actor: {
    id: string;
    name: string;
  };
  readModel: {
    name: string;
    route: string;
    entryFile: string;
    screenshotPath?: string;
  };
  expectedEvent: string;
}

export interface RepositoryFile {
  path: string;
  content: string;
}

export interface RepositoryArtifacts {
  files: RepositoryFile[];
}

export interface ScenarioExtractorResult {
  map: EventStormingMap;
  scenarios: ScenarioTarget[];
}
// -------------------------------------------------------------
// M1: ContextExtractor Types
// -------------------------------------------------------------
export type ExtractionUnitKind =
  | 'STATE'
  | 'OPERATION'
  | 'INTERFACE_TEXT'
  | 'BRANCH_CONDITION'
  | 'API_ENDPOINT'
  | 'DATA_MUTATION'
  | 'SCHEMA_ENTITY'
  | 'ASYNC_CUT';

export interface ExtractionUnit {
  id: string;
  kind: ExtractionUnitKind;
  name: string;
  componentScope?: string;
  layer: 'UI' | 'API' | 'DATABASE' | 'ASYNC_TRIGGER';
  details?: Record<string, unknown>;
}

export interface UseCaseSlice {
  sliceId: string;
  precondition: string;
  outcome: string;
  units: ExtractionUnit[];
}

export interface RawContextModel {
  scenarioId: string;
  intent: string;
  entryPoint: {
    route: string;
    file: string;
    inletTrigger: string;
  };
  units: ExtractionUnit[];
  slices: UseCaseSlice[];
  isAsyncCutEnforced: boolean;
}
// -------------------------------------------------------------
// M2: FormalTranspiler Types
// -------------------------------------------------------------
export interface FormalSignature {
  name: string;
  isVar: boolean;
  isAbstract: boolean;
  extendsName?: string;
  fields: Array<{ name: string; type: string; multiplicity: string }>;
  sourceAnnotation?: string;
}

export interface FormalPredicate {
  name: string;
  params: Array<{ name: string; type: string }>;
  preconditions: string[];
  postconditions: string[];
  invariants: string[];
  sourceAnnotation?: string;
}

export interface FormalSpecification {
  scenarioId: string;
  sourceCode: string; // Alloy 6 spec
  signatures: FormalSignature[];
  predicates: FormalPredicate[];
  assertions: string[];
  isSound: boolean;
}

export interface AmbiguityReport {
  scenarioId: string;
  hasAmbiguity: true;
  issues: Array<{
    target: string;
    description: string;
    domainQuestion: string;
  }>;
}

export type TranspilerResult =
  | { kind: 'SUCCESS'; spec: FormalSpecification }
  | { kind: 'AMBIGUITY'; report: AmbiguityReport };
// -------------------------------------------------------------
// M3: FormalSolver Types
// -------------------------------------------------------------
export interface UnhandledTransition {
  state: string;
  command: string;
  reason: string;
}

export interface CounterexampleTrace {
  assertionName: string;
  steps: Array<{
    step: number;
    state: string;
    operation?: string;
  }>;
}

export interface SolverOptions {
  scope?: number;
  timeSteps?: number;
  engine?: string;
}

export interface SolverReport {
  scenarioId: string;
  isSound: boolean;
  engineInfo: {
    engine: string;
    version: string;
    scope: number;
  };
  unhandledTransitions: UnhandledTransition[];
  deadlocks: string[];
  counterexamples: CounterexampleTrace[];
  isPartitioned: boolean;
  partitionCount?: number;
}

export interface SolverPort {
  execute(sourceCode: string, options: SolverOptions): Promise<{
    rawOutput: string;
    engine: string;
    version: string;
    isEngineAvailable: boolean;
  }>;
}
// -------------------------------------------------------------
// M4: LedgerSynthesizer Types
// -------------------------------------------------------------
export interface DomainLedgerOption {
  key: 'SPECIFY' | 'FIX_BUG' | 'ALLOW_EDGE_CASE';
  label: string;
  description: string;
}

export interface DomainLedger {
  id: string;
  scenarioId: string;
  isRootCause: boolean;
  claim: string;
  observation: string;
  domainQuestion: string;
  options: DomainLedgerOption[];
}

export interface DomainLedgerCatalog {
  scenarioId: string;
  ledgers: DomainLedger[];
  summary: {
    totalIssues: number;
    rootCausesCount: number;
    isSound: boolean;
  };
}