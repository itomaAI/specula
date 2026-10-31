// オーケストレーター（全体設計 2・2.1）。M0〜M5 をつなぎ、コマンドごとの結果を実行の報告にまとめる。
// コアに属するので、ファイルには書かない（成果物と報告を値で返す。書き込みは入口が行う）。
//
// - コマンドは M0 の切り出しの順に 1 つずつ進める。表示の id（C-01 …）もこの順に振る（全体設計 2.2）。
// - 各段の入力の契約のエラーだけを「その段で止まった」として残し、次のコマンドへ進む。
//   それ以外の例外（環境の故障）は投げ直して、実行全体を止める。

import type { AmbiguityKind } from "../types/formal.js";
import { TranspileContractError } from "../types/formal.js";
import { InletNotFoundError, SyntaxExtractionError } from "../types/context.js";
import { SolverContractError } from "../types/solver.js";
import type { VerificationOutcome } from "../types/ledger.js";
import { LedgerContractError } from "../types/ledger.js";
import {
  ProjectionContractError,
  VIEW_ROLES,
  type ProjectionContext,
  type SystemProjectionRequest,
  type ViewRole,
} from "../types/projection.js";
import type { Glossary } from "../types/glossary.js";
import type { IntentCatalog } from "../types/intent.js";
import type { EventStormingMap, RepositoryArtifacts, CommandTarget } from "../types/command.js";
import type {
  PipelineDeps,
  PipelineOptions,
  PipelineResult,
  RunReport,
  CommandArtifacts,
  CommandRunBase,
  CommandRunResult,
  CommandViews,
  RoleViews,
  StoppedStage,
  SystemMapBundle,
  SystemMapJson,
} from "../types/run.js";
import { discoverSystemContext, sliceCommands } from "./command_extractor.js";
import { buildGlossary } from "./glossary_builder.js";
import { synthesizeIntents } from "./intent_synthesizer.js";
import { extractContext } from "./context_extractor.js";
import { transpileFormal } from "./formal_transpiler.js";
import { verifySpecification } from "./formal_solver.js";
import { synthesizeLedger } from "./ledger_synthesizer.js";
import { projectAmbiguities, projectImplementationMap, projectSpecification, projectSystemMap } from "./spec_projector.js";

const AMBIGUITY_KINDS: readonly AmbiguityKind[] = ["UNDETERMINED_VALUE", "EXTERNAL_EFFECT", "CONFLICTING_SLICES"];
const OUTCOMES: readonly VerificationOutcome[] = ["FOUND", "NONE_FOUND_WITHIN_SCOPE", "UNVERIFIED"];

/** 段ごとに、止めてよい契約のエラーの型。 */
const CONTRACT_ERRORS: Record<StoppedStage, ReadonlyArray<new (...args: never[]) => Error>> = {
  M1: [InletNotFoundError, SyntaxExtractionError],
  M2: [TranspileContractError],
  M3: [SolverContractError],
  M4: [LedgerContractError],
  M5: [ProjectionContractError],
};

class Stopped {
  constructor(
    readonly stage: StoppedStage,
    readonly error: Error,
  ) {}
}

/** 段を 1 つ走らせる。その段の契約のエラーなら Stopped を投げ、それ以外は投げ直す。 */
async function stage<T>(name: StoppedStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && CONTRACT_ERRORS[name].some((type) => error instanceof type)) {
      throw new Stopped(name, error);
    }
    throw error;
  }
}

/**
 * 表示の id（全体設計 2.2）。切り出しの順に C-01、C-02 … と振る。
 * 桁は 2 桁を最小にし、コマンドが 100 件以上なら全体を件数の桁にそろえる（文字列で並べても順が崩れないように）。
 */
export function displayIdsOf(count: number): string[] {
  const width = Math.max(2, String(count).length);
  return Array.from({ length: count }, (_, index) => `C-${String(index + 1).padStart(width, "0")}`);
}

/** 1 回の実行で共有する、コマンドの射影の入力。 */
interface ProjectionInputs {
  glossary: Glossary;
  intents: IntentCatalog;
}

export async function runPipeline(
  repo: RepositoryArtifacts,
  deps: PipelineDeps,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const map = discoverSystemContext(repo);
  // 1 回の実行に 1 回だけ動く段。契約のエラーは止めずに投げ直す（全体設計 2.1）。
  const glossary = await buildGlossary(map, repo, { llm: deps.llm });
  const sliced = sliceCommands(map, options.selection);
  const intents = await synthesizeIntents(map, sliced, glossary, repo, { llm: deps.llm });
  // 利用者向けの出力は両方の役割で作る（全体設計 4.1）。SpecProjector は LLM を呼ばないので、役割の数だけ射影しても LLM の依頼は増えない。
  // system_map.mmd は level を省いた 1 枚の図、system_map.json は地図 1・地図 2 を束ねたもの。
  const views: RoleViews[] = [];
  for (const viewRole of VIEW_ROLES) {
    views.push({
      viewRole,
      system: {
        mermaid: await projectSystemMap(map, glossary, intents, { format: "SYSTEM_MERMAID", viewRole }),
        json: await bundleSystemMaps(map, glossary, intents, viewRole),
      },
      commands: [],
    });
  }

  const inputs: ProjectionInputs = { glossary, intents };
  const displayIds = displayIdsOf(sliced.commands.length);
  const results: CommandRunResult[] = [];
  const artifacts: CommandArtifacts[] = [];
  for (const [index, target] of sliced.commands.entries()) {
    const displayId = displayIds[index]!;
    try {
      const [result, artifact, commandViews] = await runCommand(target, displayId, inputs, deps, options);
      results.push(result);
      artifacts.push(artifact);
      // 役割の順は views と同じ（VIEW_ROLES）。
      for (const [roleIndex, item] of commandViews.entries()) views[roleIndex]!.commands.push(item);
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      results.push(stoppedResult(target, displayId, error));
      artifacts.push({ commandId: target.id, displayId, kind: "STOPPED" });
    }
  }

  // 実装との対応表は、俯瞰図と同じくコマンドごとの段の外で 1 回だけ作る。契約のエラーは実行全体を止める。
  const implementationMap = await projectImplementationMap(
    map,
    glossary,
    sliced.commands.map((target, index) => {
      const artifact = artifacts[index]!;
      return {
        displayId: artifact.displayId,
        commandTarget: target,
        spec: artifact.kind === "COMPLETED" ? artifact.spec : null,
        ambiguity: artifact.kind === "AMBIGUOUS" ? artifact.ambiguity : null,
        ledger: artifact.kind === "COMPLETED" ? artifact.ledger : null,
      };
    }),
  );

  const report: RunReport = {
    system: {
      mode: map.diagnostics.mode,
      parsedFileCount: map.diagnostics.parsedFileCount,
      parseFailureCount: map.diagnostics.parseFailures.length,
      boundedContextCount: map.boundedContexts.length,
      commandCount: map.commands.length,
      eventCount: map.events.length,
    },
    glossary: glossarySummaryOf(glossary),
    intents: intentsSummaryOf(intents),
    slice: { commandTargetCount: sliced.commands.length, rejected: sliced.rejected.map((item) => ({ ...item })) },
    commands: results,
    totals: totalsOf(results),
    inspectionScope: inspectionScopeOf(results),
    basis: { ...glossary.basis },
  };
  return { report, map, glossary, intents, commands: artifacts, views, implementationMap };
}

/**
 * 検査の範囲（全体設計 2.1）。検査はコマンドごと。初回は不変条件の検査をしない。
 * 検証の結果が報告に無いコマンド（未検証・曖昧さで止まった・途中で止まった）の表示の id を、切り出しの順に並べる。
 */
function inspectionScopeOf(results: readonly CommandRunResult[]): RunReport["inspectionScope"] {
  return {
    unit: "PER_COMMAND",
    invariantChecks: { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" },
    commandsWithoutVerification: results
      .filter((result) => result.kind !== "COMPLETED" || result.outcome === "UNVERIFIED")
      .map((result) => result.displayId),
  };
}

function intentsSummaryOf(intents: IntentCatalog): RunReport["intents"] {
  const notGenerated = { UNREACHABLE: 0, INVALID_OUTPUT: 0 };
  for (const item of [...intents.contexts, ...intents.commands]) {
    if (item.intent.status === "NOT_GENERATED") notGenerated[item.intent.reason] += 1;
  }
  return { contextCount: intents.contexts.length, commandTargetCount: intents.commands.length, notGenerated };
}

function glossarySummaryOf(glossary: Glossary): RunReport["glossary"] {
  const notGenerated = { UNREACHABLE: 0, INVALID_OUTPUT: 0 };
  let presentedCount = 0;
  for (const entry of glossary.entries) {
    if (entry.scope !== "PRESENTED") continue;
    presentedCount += 1;
    if (entry.term !== undefined && entry.term.status === "NOT_GENERATED") notGenerated[entry.term.reason] += 1;
  }
  return {
    presentedCount,
    recordedCount: glossary.entries.length - presentedCount,
    notGenerated,
    documents: {
      read: glossary.documents.read.length,
      truncated: glossary.documents.truncated.length,
      omitted: glossary.documents.omitted.length,
    },
    gaps: {
      undocumentedEntries: glossary.gaps.undocumentedEntries.length,
      unmatchedDocumentNames: glossary.gaps.unmatchedDocumentNames.length,
      sharedTerms: glossary.gaps.sharedTerms.length,
      contextHomonyms: glossary.gaps.contextHomonyms.length,
      multiSourceEntries: glossary.gaps.multiSourceEntries.length,
    },
  };
}

/** コマンドの単位の行の 3 通りに共通する欄（全体設計 2.1）。アクターから下は CommandTarget の欄を写す。 */
function rowBaseOf(target: CommandTarget, displayId: string): CommandRunBase {
  return {
    commandId: target.id,
    displayId,
    boundedContext: target.boundedContext,
    actor: { id: target.actor.id, name: target.actor.name },
    route: target.readModel?.route ?? null,
    expectedEvents: [...target.expectedEvents],
    invokedBy: target.invokedBy.map((policy) => policy.policyId),
  };
}

async function runCommand(
  target: CommandTarget,
  displayId: string,
  inputs: ProjectionInputs,
  deps: PipelineDeps,
  options: PipelineOptions,
): Promise<[CommandRunResult, CommandArtifacts, CommandViews[]]> {
  const base = rowBaseOf(target, displayId);

  const facts = await stage("M1", () => extractContext(target, { fs: deps.fs }));
  const transpiled = await stage("M2", () => transpileFormal(facts, { llm: deps.llm }, null));
  const context: ProjectionContext = { commandTarget: target, glossary: inputs.glossary, intents: inputs.intents };
  // 利用者向けの出力は VIEW_ROLES の順に、両方の役割で作る（全体設計 4.1）。どちらかの射影が契約のエラーなら、コマンドは M5 で止まる。
  const commandViews: CommandViews[] = [];
  if (transpiled.kind === "AMBIGUITY") {
    const report = transpiled.report;
    for (const viewRole of VIEW_ROLES) {
      const view = await stage("M5", () =>
        projectAmbiguities(report, context, { format: "AMBIGUITY_DOCUMENT", viewRole, displayId }),
      );
      commandViews.push({ commandId: target.id, displayId, kind: "AMBIGUOUS", view });
    }
    return [
      { ...base, kind: "AMBIGUOUS", counts: { ...report.counts } },
      { commandId: target.id, displayId, kind: "AMBIGUOUS", ambiguity: report },
      commandViews,
    ];
  }
  const spec = transpiled.spec;
  const solverReport = await stage("M3", () => verifySpecification(spec, { solver: deps.solver }, options.solver));
  const ledger = await stage("M4", () => synthesizeLedger(solverReport, spec, { llm: deps.llm }));
  for (const viewRole of VIEW_ROLES) {
    const request = (format: "DOCUMENT" | "MATRIX" | "FLOW") => ({ format, viewRole, displayId });
    const document = await stage("M5", () => projectSpecification(spec, ledger, context, request("DOCUMENT")));
    const matrix = await stage("M5", () => projectSpecification(spec, ledger, context, request("MATRIX")));
    const flow = await stage("M5", () => projectSpecification(spec, ledger, context, request("FLOW")));
    commandViews.push({ commandId: target.id, displayId, kind: "COMPLETED", document, matrix, flow });
  }

  return [
    {
      ...base,
      kind: "COMPLETED",
      outcome: ledger.verification.outcome,
      unverifiedReason: solverReport.reason === null ? null : solverReport.reason.kind,
      findingCount: solverReport.findings.length,
      issueCount: ledger.issues.length,
    },
    { commandId: target.id, displayId, kind: "COMPLETED", spec, solverReport, ledger },
    commandViews,
  ];
}

function stoppedResult(target: CommandTarget, displayId: string, stopped: Stopped): CommandRunResult {
  const error = stopped.error;
  const reason = "reason" in error && typeof error.reason === "string" ? error.reason : null;
  const detail = "detail" in error && typeof error.detail === "string" ? error.detail : error.message;
  return {
    ...rowBaseOf(target, displayId),
    kind: "STOPPED",
    stage: stopped.stage,
    error: error.name,
    reason,
    detail,
  };
}

function totalsOf(results: readonly CommandRunResult[]): RunReport["totals"] {
  const ambiguity = Object.fromEntries(AMBIGUITY_KINDS.map((kind) => [kind, 0])) as Record<AmbiguityKind, number>;
  const verification = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<VerificationOutcome, number>;
  let completed = 0;
  let ambiguous = 0;
  let stopped = 0;
  for (const result of results) {
    if (result.kind === "COMPLETED") {
      completed += 1;
      verification[result.outcome] += 1;
    } else if (result.kind === "AMBIGUOUS") {
      ambiguous += 1;
      for (const kind of AMBIGUITY_KINDS) ambiguity[kind] += result.counts[kind];
    } else {
      stopped += 1;
    }
  }
  return { completed, ambiguous, stopped, ambiguity, verification };
}

/**
 * 俯瞰図の JSON を束ねる（全体設計 4.1）。地図 1 と、全体マップの Bounded Context の順に地図 2（足す要素なし・あり）。
 * basis は辞書の basis を写す。SpecProjector の俯瞰図の JSON は元にした全体マップと資料のハッシュを持たないため。
 * Bounded Context の表示の id は地図 2 の Bounded Context のノードから取り、番号の振り方を SpecProjector の 1 箇所に保つ。
 */
async function bundleSystemMaps(
  map: EventStormingMap,
  glossary: Glossary,
  intents: IntentCatalog,
  viewRole: ViewRole,
): Promise<SystemMapBundle> {
  const project = async (request: Omit<SystemProjectionRequest, "format" | "viewRole">): Promise<SystemMapJson> => {
    const view = await projectSystemMap(map, glossary, intents, { format: "SYSTEM_JSON", viewRole, ...request });
    return JSON.parse(view.content) as SystemMapJson;
  };
  const contextMap = await project({ level: "CONTEXT_MAP" });
  const details: SystemMapBundle["details"] = [];
  for (const boundedContext of map.boundedContexts) {
    const core = await project({ level: "CONTEXT_DETAIL", contextId: boundedContext.id });
    const supporting = await project({ level: "CONTEXT_DETAIL", contextId: boundedContext.id, includeSupporting: true });
    const id = core.nodes.find((node) => node["kind"] === "BOUNDED_CONTEXT")?.["id"];
    if (typeof id !== "string") throw new Error("地図 2 に Bounded Context のノードが無い");
    details.push({ context: id, core, supporting });
  }
  return { viewRole, basis: glossary.basis, contextMap, details };
}