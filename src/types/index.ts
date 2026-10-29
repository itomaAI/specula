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