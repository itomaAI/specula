// M4（LedgerSynthesizer）の出力の型（M4 の設計 6）。

import type { ConfirmationStatus, LlmText } from "./index.js";
import type { FindingKind, SolverConditions, SolverReport, TraceStep } from "./solver.js";

/**
 * 検証の結果の分け方（M4 の設計 2 の表）。
 * - UNVERIFIED: 報告が未検証。見つかったものがあれば論点にするが、「見つからなかった」とは扱わない。
 * - NONE_FOUND_WITHIN_SCOPE: 検査済みで、指定のスコープの中で、行った検査では見つからなかった。
 * - FOUND: 検査済みで、見つかったものが 1 件以上。
 * 定型の文はカタログに入れない（M5 がこの値から表示する）。
 */
export type VerificationOutcome = "UNVERIFIED" | "NONE_FOUND_WITHIN_SCOPE" | "FOUND";

export interface LedgerVerification {
  outcome: VerificationOutcome;
  status: SolverReport["status"];
  reason: SolverReport["reason"];
  /** 検査の範囲。「見つからなかった」と言える範囲を人に示すため。 */
  scope: { scope: number; maxSteps: number; bitwidth: number };
  unexecutedChecks: string[];
  invariantChecks: SolverReport["invariantChecks"];
  /** 実行した検査のうち、反例を 1 件だけ返す検査（exhaustive: false）の id。 */
  nonExhaustiveChecks: string[];
}

export type LedgerOptionId =
  | "SPECIFY_HANDLING"
  | "SPECIFY_PRIORITY"
  | "SPECIFY_EXIT"
  | "DECLARE_TERMINAL"
  | "FIX_IMPLEMENTATION"
  | "ACCEPT_AS_UNREACHABLE"
  | "REMOVE_OPERATION"
  | "RECHECK_WITH_LARGER_SCOPE";

export interface LedgerOption {
  id: LedgerOptionId;
  /** M4 の設計 4 の表の文（固定。LLM で作らない）。 */
  meaning: string;
}

export interface LedgerIssue {
  /** "LEDGER-<scenarioId>-001" */
  id: string;
  /** 本体の反例の種類。 */
  kind: FindingKind;
  /** 本体の反例の、report.findings の中の位置。 */
  rootFinding: number;
  /** 従属する反例の位置（findings の中の順）。 */
  dependentFindings: number[];
  /** 本体の操作のあとに、従属する反例の操作を重ねずに足したもの。 */
  operations: string[];
  /** 本体の実行列。UNREACHABLE_OPERATION は null。 */
  trace: TraceStep[] | null;
  /** 本来あるべき前提（LLM。task "m4.issue-text"）。 */
  claim: LlmText;
  /** 検査で見つかったこと（LLM）。 */
  observation: LlmText;
  /** 人に判断を求める問い（LLM）。 */
  question: LlmText;
  /** 3 つの文の確定の状態（NOT_GENERATED か CANDIDATE。M4 の設計 8）。論点の decision とは別の欄。 */
  claimStatus: ConfirmationStatus;
  observationStatus: ConfirmationStatus;
  questionStatus: ConfirmationStatus;
  options: LedgerOption[];
  /** 初回は常に未決。2 回目以降のために置く。 */
  decision: null;
}

export interface DomainLedgerCatalog {
  scenarioId: string;
  basis: {
    reportId: string;
    /** 元にした形式仕様正本のソースの SHA-256。いまの正本と違えば、このカタログは古い。 */
    specSourceHash: string;
    conditions: SolverConditions;
    /** 元の記録の反例の件数 N。 */
    findingCount: number;
    /** まとめた論点の件数 k。 */
    issueCount: number;
  };
  verification: LedgerVerification;
  /** 本体の反例の findings の中の順。 */
  issues: LedgerIssue[];
}

/** 本体の選び方の順（M4 の設計 3.1）。 */
export const ROOT_PRIORITY: readonly FindingKind[] = [
  "DEADLOCK",
  "UNHANDLED_TRANSITION",
  "OVERLAPPING_OPERATIONS",
  "UNREACHABLE_OPERATION",
];


/** M3 の報告と M2 の形式仕様の組が契約を破っている。オーケストレーターは「M4 で止まった」と理由付きで残す。 */
export class LedgerContractError extends Error {
  constructor(
    readonly scenarioId: string,
    readonly reason: "SCENARIO_MISMATCH" | "SPEC_HASH_MISMATCH" | "UNKNOWN_OPERATION" | "UNKNOWN_STATE_VARIABLE",
    readonly detail: string,
  ) {
    super(`M4 の入力の契約が破れている（${scenarioId}）: ${reason}: ${detail}`);
    this.name = "LedgerContractError";
  }
}