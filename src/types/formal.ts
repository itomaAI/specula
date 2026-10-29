// M2（FormalTranspiler）の出力の型（M2 の設計 4.3・5）。

import type { LlmText } from "./index.js";
import type { OutletKind, UnitLocation } from "./context.js";

/** 状態変数のドメイン（M2 の設計 2.1）。 */
export type StateDomain = "BOOL" | "ENUM" | "INT";

export interface StateVariable {
  /** "v1" */
  id: string;
  /** M1 の STATE の識別子。 */
  unitId: string;
  domain: StateDomain;
  /** ENUM の値の識別子（"v1_1" …。初期値が決まらなければ "v1_unknown" を含む）。BOOL・INT は空。 */
  values: string[];
  /** 値の識別子 → 元のリテラルの原文（ENUM だけ。"v1_unknown" は含まない）。M5 が表示に使う。 */
  valueLiterals: Record<string, string>;
  /** 初期値: BOOL は "True"・"False"、ENUM は値の識別子、INT は整数の文字列。決まらなければ null。 */
  initial: string | null;
}

/** 環境が決める命題（M2 の設計 2.3）。出現ごとに 1 つ。 */
export interface Proposition {
  /** "c1" */
  id: string;
  /** 命題が出てきた条件のユニット（BRANCH_CONDITION）の識別子。 */
  unitId: string;
  /** 命題に置き換えた部分式の原文。 */
  expression: string;
}

/** 条件の式を訳した結果（M2 の設計 3.2）。変数は、その時点の値（それより前の書き込みを反映した値）を指す。 */
export type GuardExpr =
  | { op: "PROP"; prop: string }
  | { op: "IS"; variable: string; value: string }
  | { op: "CMP"; variable: string; cmp: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; value: number }
  | { op: "NOT"; arg: GuardExpr }
  | { op: "AND" | "OR"; args: GuardExpr[] };

export type WriteChange = { op: "SET"; value: string | number } | { op: "ADD"; amount: number };

/**
 * 書き込みの条件の 1 項（M1 の details.guardTerms の 1 つを訳したもの）。
 * 条件は、それを持つ最初の書き込みの直前の値で評価する（枝の条件は、枝の中のどの書き込みよりも前に評価されるため）。
 */
export interface WriteCondition {
  /** 条件のユニット（BRANCH_CONDITION）の識別子。 */
  unitId: string;
  holds: boolean;
  expr: GuardExpr;
}

export type OperationStep =
  | { kind: "CONDITION"; unitId: string; expr: GuardExpr; holds: boolean }
  | {
      kind: "WRITE";
      unitId: string;
      /** "v1" */
      variable: string;
      /** SET の value は BOOL・ENUM なら値の識別子、INT なら整数。ADD は負の数で減らす。 */
      change: WriteChange;
      /**
       * 書き込みの条件（すべての項の AND）。経路の上でこの書き込みより前に同じ側の CONDITION がある項は、
       * 操作の guard が既に要求しているので除く。空なら条件なし。
       */
      when: WriteCondition[];
    };

export interface Operation {
  /** "op1" */
  id: string;
  sliceId: string;
  /** "o1" */
  outcome: string;
  outletKind: OutletKind;
  /** "op1_guard"（M2 の設計 3.1） */
  guardPredicate: string;
  /** 経路の順の条件と書き込み。 */
  steps: OperationStep[];
  /** 経路にある DATA_MUTATION のユニットの識別子（経路の順）。 */
  dataMutations: string[];
}

export interface FormalSpecification {
  scenarioId: string;
  /** Alloy 6 のソース。 */
  source: string;
  stateVariables: StateVariable[];
  propositions: Proposition[];
  operations: Operation[];
  /** Alloy の識別子 → ユニットの識別子。 */
  sourceMap: Record<string, string[]>;
  /** Alloy の識別子 → 表示名。 */
  labels: Record<string, LlmText>;
  previousDiff: { status: "NOT_COMPUTED"; reason: "FIRST_RUN" | "OUT_OF_SCOPE" };
}

export type AmbiguityKind = "UNDETERMINED_VALUE" | "EXTERNAL_EFFECT" | "CONFLICTING_SLICES";

export interface AmbiguityIssue {
  kind: AmbiguityKind;
  unitIds: string[];
  /** 最初のユニットの所在（M1 のユニットの所在。列を含む）。 */
  location: UnitLocation;
  /** 式や呼び出しの原文。 */
  detail: string;
  /** 人への質問の文（LLM。task: "m2.ambiguity-question"）。 */
  question: LlmText;
}

export interface AmbiguityReport {
  scenarioId: string;
  /** ユニットの並び順。 */
  issues: AmbiguityIssue[];
  counts: Record<AmbiguityKind, number>;
}

export type TranspilerResult = { kind: "SPEC"; spec: FormalSpecification } | { kind: "AMBIGUITY"; report: AmbiguityReport };

/** M1 の契約違反（曖昧性ではない）。オーケストレーターは「M2 で止まった」と理由付きで報告に残す。 */
export class TranspileContractError extends Error {
  constructor(
    readonly scenarioId: string,
    readonly reason: "NO_SLICES" | "WRITE_WITHOUT_EXPRESSION" | "UNKNOWN_UNIT" | "MALFORMED_DETAILS",
    readonly detail: string,
  ) {
    super(`M2 の入力の契約が破れている（${scenarioId}）: ${reason}: ${detail}`);
    this.name = "TranspileContractError";
  }
}