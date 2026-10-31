// M3（FormalSolver）: 形式仕様を Alloy 6 で検査する（M3 の設計・仕様 03）。LLM は使わない。
//
// 流れ: 契約の検査 → 検査の一覧（COVER・OVERLAP・REACH）→ 検査ごとにステップ数を 1 から上げて実行
//       → COVER の反例があれば ESCAPE を 1 件足す → 報告。
// エンジンに届かない・時間切れ・エンジンの誤りが出たら、そこで止めて、残りの検査を unexecutedChecks に並べる。
// それまでに見つかったものは残す（M3 の設計 4.1）。

import { canonicalJson } from "../lib/canonical_json.js";
import { sha256Hex } from "../lib/sha256.js";
import type { EngineInfo, RawInstance, SolverPort } from "../ports/SolverPort.js";
import type { FormalSpecification } from "../types/formal.js";
import type { CheckResult, Finding, SolverConditions, SolverOptions, SolverReport, TraceStep, UnverifiedReason } from "../types/solver.js";
import { checkSpecContract } from "./m3/contract.js";
import { InstanceShapeError, toTrace } from "./m3/normalize.js";
import { SCOPE, commandSource, planChecks, planEscape, type PlannedCheck } from "./m3/plan.js";

export const SOLVER_DEFAULTS = { maxSteps: 10, bitwidth: 4, timeoutMs: 60000 } as const;

type Outcome =
  | { kind: "FOUND"; steps: number; instance: RawInstance }
  | { kind: "NOT_FOUND" }
  | { kind: "STOP"; reason: UnverifiedReason; detail: string };

export async function verifySpecification(
  spec: FormalSpecification,
  deps: { solver: SolverPort | null },
  options: SolverOptions = {},
): Promise<SolverReport> {
  checkSpecContract(spec);
  const maxSteps = positiveInteger("maxSteps", options.maxSteps ?? SOLVER_DEFAULTS.maxSteps);
  const bitwidth = positiveInteger("bitwidth", options.bitwidth ?? SOLVER_DEFAULTS.bitwidth);
  const timeoutMs = positiveInteger("timeoutMs", options.timeoutMs ?? SOLVER_DEFAULTS.timeoutMs);
  const preventOverflow = true;
  const specSourceHash = await sha256Hex(spec.source);

  const queue: PlannedCheck[] = planChecks(spec);
  const checks: CheckResult[] = [];
  const findings: Finding[] = [];
  let engine: EngineInfo | null = null;
  let stop: { reason: UnverifiedReason; detail: string } | null = null;
  let unexecuted: string[] = [];

  if (deps.solver === null) {
    stop = { reason: "NO_SOLVER", detail: "この環境に SolverPort のアダプターが無い" };
    unexecuted = queue.map((check) => check.id);
  } else {
    const solver = deps.solver;
    let coverTrace: TraceStep[] | null = null;
    for (let index = 0; index < queue.length; index++) {
      const check = queue[index] as PlannedCheck;
      const outcome = await runCheck(check);
      if (outcome.kind === "STOP") {
        stop = { reason: outcome.reason, detail: outcome.detail };
        unexecuted = queue.slice(index).map((item) => item.id);
        break;
      }
      let trace: TraceStep[] | null = null;
      if (outcome.kind === "FOUND") {
        try {
          trace = toTrace(spec, outcome.instance);
        } catch (error) {
          if (!(error instanceof InstanceShapeError)) throw error;
          stop = { reason: "ENGINE_ERROR", detail: error.message };
          unexecuted = queue.slice(index).map((item) => item.id);
          break;
        }
      }
      checks.push({
        id: check.id,
        kind: check.kind,
        targets: [...check.targets],
        result: outcome.kind === "FOUND" ? "FOUND" : "NOT_FOUND_WITHIN_SCOPE",
        exhaustive: check.exhaustive,
        steps: outcome.kind === "FOUND" ? outcome.steps : null,
      });
      const finding = findingOf(check, trace, coverTrace);
      if (finding !== null) findings.push(finding);
      if (check.kind === "COVER" && trace !== null) {
        // 最短の反例では、どの操作も実行できない時点は最後の時点になる（M3 の設計 2.3）。
        coverTrace = trace;
        const last = trace[trace.length - 1] as TraceStep;
        queue.push(planEscape(spec, 1, last.values));
      }
    }

    async function runCheck(check: PlannedCheck): Promise<Outcome> {
      for (let steps = 1; steps <= maxSteps; steps++) {
        const response = await solver.run({
          source: commandSource(spec, check, steps, bitwidth),
          command: check.id,
          steps,
          bitwidth,
          preventOverflow,
          timeoutMs,
        });
        if (response.kind === "UNREACHABLE") return { kind: "STOP", reason: "UNREACHABLE", detail: response.detail };
        if (response.kind === "TIMEOUT") {
          return { kind: "STOP", reason: "TIMEOUT", detail: `${check.id}: ステップ数 ${steps} で ${timeoutMs} ms を超えた` };
        }
        if (response.kind === "ENGINE_ERROR") return { kind: "STOP", reason: "ENGINE_ERROR", detail: response.message };
        if (engine === null) {
          engine = response.engine;
        } else if (canonicalJson(engineJson(engine)) !== canonicalJson(engineJson(response.engine))) {
          return { kind: "STOP", reason: "ENGINE_ERROR", detail: `エンジンの版が途中で変わった: ${canonicalJson(engineJson(response.engine))}` };
        }
        if (response.kind === "SAT") return { kind: "FOUND", steps, instance: response.instance };
      }
      return { kind: "NOT_FOUND" };
    }
  }

  const conditions: SolverConditions = {
    engine,
    scope: SCOPE,
    bitwidth,
    maxSteps,
    preventOverflow,
    timeoutMs,
    partitioning: "NONE",
  };
  const reportId = await sha256Hex(
    canonicalJson({
      specSourceHash,
      checks: [...checks.map((check) => check.id), ...unexecuted],
      conditions: {
        engine: engine === null ? null : engineJson(engine),
        scope: SCOPE,
        bitwidth,
        maxSteps,
        preventOverflow,
        timeoutMs,
        partitioning: "NONE",
      },
    }),
  );
  return {
    reportId,
    commandId: spec.commandId,
    specSourceHash,
    status: stop === null ? "CHECKED" : "UNVERIFIED",
    reason: stop === null ? null : { kind: stop.reason, detail: stop.detail },
    conditions,
    checks,
    unexecutedChecks: unexecuted,
    findings,
    invariantChecks: { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" },
  };
}

function findingOf(check: PlannedCheck, trace: TraceStep[] | null, coverTrace: TraceStep[] | null): Finding | null {
  const operations = [...check.targets];
  switch (check.kind) {
    case "COVER":
      return trace === null ? null : { kind: "UNHANDLED_TRANSITION", checkId: check.id, operations, trace };
    case "OVERLAP":
      return trace === null ? null : { kind: "OVERLAPPING_OPERATIONS", checkId: check.id, operations, trace };
    case "REACH":
      return trace === null ? { kind: "UNREACHABLE_OPERATION", checkId: check.id, operations, trace: null } : null;
    case "ESCAPE":
      // 抜け出せない状態への実行列は、COVER の反例そのもの。
      return trace === null ? { kind: "DEADLOCK", checkId: check.id, operations, trace: coverTrace } : null;
  }
}

function engineJson(engine: EngineInfo): { alloyVersion: string; satSolver: string; satSolverVersion: string | null } {
  return { alloyVersion: engine.alloyVersion, satSolver: engine.satSolver, satSolverVersion: engine.satSolverVersion };
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`M3: ${name} は 1 以上の整数（${String(value)}）`);
  return value;
}