// M3（FormalSolver）の入出力の型（M3 の設計 2.1・4.2）。

import type { EngineInfo } from "../ports/SolverPort.js";

/** 検査のオプション。省いた項目は既定値（M3 の設計 2.4）。 */
export interface SolverOptions {
  /** 時相のステップ数の上限。既定 10。 */
  maxSteps?: number;
  /** 整数のビット幅。既定 4。 */
  bitwidth?: number;
  /** 検査 1 回（ステップ数 1 つ）あたりの制限時間。既定 60000。 */
  timeoutMs?: number;
}

export type CheckKind = "COVER" | "OVERLAP" | "REACH" | "ESCAPE";

export type UnverifiedReason = "NO_SOLVER" | "UNREACHABLE" | "TIMEOUT" | "ENGINE_ERROR";

export interface SolverConditions {
  /** 実際に使われた版。実行できなかったときは null。 */
  engine: EngineInfo | null;
  /** 3 */
  scope: number;
  bitwidth: number;
  maxSteps: number;
  preventOverflow: boolean;
  timeoutMs: number;
  partitioning: "NONE";
}

export interface CheckResult {
  /** "m3_cover" など。M3 の設計 2.2 の順。 */
  id: string;
  kind: CheckKind;
  /** 対象の操作の識別子。 */
  targets: string[];
  result: "FOUND" | "NOT_FOUND_WITHIN_SCOPE";
  /** COVER は false（反例は 1 件目だけ）。 */
  exhaustive: boolean;
  /** 見つかった長さ。見つからなければ null。 */
  steps: number | null;
}

export interface TraceStep {
  /** 0 が初期状態。 */
  index: number;
  /** 状態変数の識別子 → 値の識別子か整数。 */
  values: Record<string, string | number>;
  /** "Idle" か出口の識別子。 */
  outcome: string;
  /** その時点で成り立つ命題の識別子（番号順）。 */
  holds: string[];
}

export type FindingKind = "UNHANDLED_TRANSITION" | "OVERLAPPING_OPERATIONS" | "UNREACHABLE_OPERATION" | "DEADLOCK";

export interface Finding {
  kind: FindingKind;
  checkId: string;
  /** 関わる操作の識別子。 */
  operations: string[];
  /** UNREACHABLE_OPERATION は実行列が無いので null。 */
  trace: TraceStep[] | null;
}

export interface SolverReport {
  /** specSourceHash・検査の一覧・conditions を正準化した JSON の SHA-256（M3 の設計 4.2）。 */
  reportId: string;
  scenarioId: string;
  /** M2 のソースの SHA-256。 */
  specSourceHash: string;
  status: "CHECKED" | "UNVERIFIED";
  reason: null | { kind: UnverifiedReason; detail: string };
  conditions: SolverConditions;
  /** 実行した検査。M3 の設計 2.2 の順。 */
  checks: CheckResult[];
  /** 実行しなかった検査の識別子。 */
  unexecutedChecks: string[];
  /** 検査の順、同じ検査の中では操作の識別子の順。 */
  findings: Finding[];
  invariantChecks: { status: "NOT_APPLICABLE"; reason: "NO_ASSERTIONS_FIRST_RUN" };
}

/** M2 の契約違反。オーケストレーターは「M3 で止まった」と理由付きで報告に残す。 */
export class SolverContractError extends Error {
  constructor(
    readonly scenarioId: string,
    readonly reason: "NO_OPERATIONS" | "MISSING_GUARD_PREDICATE" | "MISSING_STATE_VARIABLE" | "INVALID_IDENTIFIER",
    readonly detail: string,
  ) {
    super(`M3 の入力の契約が破れている（${scenarioId}）: ${reason}: ${detail}`);
    this.name = "SolverContractError";
  }
}