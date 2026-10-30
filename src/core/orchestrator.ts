// オーケストレーター（全体設計 2・2.1）。M0〜M5 をつなぎ、シナリオごとの結果を実行の報告にまとめる。
// コアに属するので、ファイルには書かない（成果物と報告を値で返す。書き込みは入口が行う）。
//
// - シナリオは M0 の切り出しの順に 1 つずつ進める。
// - 各段の入力の契約のエラーだけを「その段で止まった」として残し、次のシナリオへ進む。
//   それ以外の例外（環境の故障）は投げ直して、実行全体を止める。

import type { AmbiguityKind } from "../types/formal.js";
import { TranspileContractError } from "../types/formal.js";
import { InletNotFoundError, SyntaxExtractionError } from "../types/context.js";
import { SolverContractError } from "../types/solver.js";
import type { VerificationOutcome } from "../types/ledger.js";
import { LedgerContractError } from "../types/ledger.js";
import { ProjectionContractError } from "../types/projection.js";
import type { RepositoryArtifacts, ScenarioTarget } from "../types/scenario.js";
import type {
  PipelineDeps,
  PipelineOptions,
  PipelineResult,
  RunReport,
  ScenarioArtifacts,
  ScenarioRunResult,
  StoppedStage,
} from "../types/run.js";
import { discoverSystemContext, sliceScenarios } from "./scenario_extractor.js";
import { extractContext } from "./context_extractor.js";
import { transpileFormal } from "./formal_transpiler.js";
import { verifySpecification } from "./formal_solver.js";
import { synthesizeLedger } from "./ledger_synthesizer.js";
import { projectSpecification, projectSystemMap } from "./spec_projector.js";

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

export async function runPipeline(
  repo: RepositoryArtifacts,
  deps: PipelineDeps,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const map = await discoverSystemContext(repo, { llm: deps.llm });
  const sliced = await sliceScenarios(map, options.selection, { llm: deps.llm });
  const systemViews = {
    mermaid: projectSystemMap(map, { format: "SYSTEM_MERMAID" }),
    json: projectSystemMap(map, { format: "SYSTEM_JSON" }),
  };

  const results: ScenarioRunResult[] = [];
  const artifacts: ScenarioArtifacts[] = [];
  for (const target of sliced.scenarios) {
    try {
      const [result, artifact] = await runScenario(target, deps, options);
      results.push(result);
      artifacts.push(artifact);
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      results.push(stoppedResult(target, error));
      artifacts.push({ scenarioId: target.id, kind: "STOPPED" });
    }
  }

  const report: RunReport = {
    system: {
      mode: map.diagnostics.mode,
      parsedFileCount: map.diagnostics.parsedFileCount,
      parseFailureCount: map.diagnostics.parseFailures.length,
      boundedContextCount: map.boundedContexts.length,
      commandCount: map.commands.length,
      eventCount: map.events.length,
    },
    slice: { scenarioCount: sliced.scenarios.length, rejected: sliced.rejected.map((item) => ({ ...item })) },
    scenarios: results,
    totals: totalsOf(results),
  };
  return { report, map, systemViews, scenarios: artifacts };
}

async function runScenario(
  target: ScenarioTarget,
  deps: PipelineDeps,
  options: PipelineOptions,
): Promise<[ScenarioRunResult, ScenarioArtifacts]> {
  const base = { scenarioId: target.id, boundedContext: target.boundedContext };

  const facts = await stage("M1", () => extractContext(target, { fs: deps.fs }));
  const transpiled = await stage("M2", () => transpileFormal(facts, { llm: deps.llm }, null));
  if (transpiled.kind === "AMBIGUITY") {
    return [
      { ...base, kind: "AMBIGUOUS", counts: { ...transpiled.report.counts } },
      { scenarioId: target.id, kind: "AMBIGUOUS", ambiguity: transpiled.report },
    ];
  }
  const spec = transpiled.spec;
  const solverReport = await stage("M3", () => verifySpecification(spec, { solver: deps.solver }, options.solver));
  const ledger = await stage("M4", () => synthesizeLedger(solverReport, spec, { llm: deps.llm }));
  const document = await stage("M5", () => projectSpecification(spec, ledger, { format: "DOCUMENT" }));
  const matrix = await stage("M5", () => projectSpecification(spec, ledger, { format: "MATRIX" }));
  const flow = await stage("M5", () => projectSpecification(spec, ledger, { format: "FLOW" }));

  return [
    {
      ...base,
      kind: "COMPLETED",
      outcome: ledger.verification.outcome,
      unverifiedReason: solverReport.reason === null ? null : solverReport.reason.kind,
      findingCount: solverReport.findings.length,
      issueCount: ledger.issues.length,
    },
    { scenarioId: target.id, kind: "COMPLETED", spec, solverReport, ledger, document, matrix, flow },
  ];
}

function stoppedResult(target: ScenarioTarget, stopped: Stopped): ScenarioRunResult {
  const error = stopped.error;
  const reason = "reason" in error && typeof error.reason === "string" ? error.reason : null;
  const detail = "detail" in error && typeof error.detail === "string" ? error.detail : error.message;
  return {
    scenarioId: target.id,
    boundedContext: target.boundedContext,
    kind: "STOPPED",
    stage: stopped.stage,
    error: error.name,
    reason,
    detail,
  };
}

function totalsOf(results: readonly ScenarioRunResult[]): RunReport["totals"] {
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