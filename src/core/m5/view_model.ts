// 中間表現（M5 の設計 3）。どのビューも、ここで作った 1 つの値から描く。
// 表示名の解決や「未決」「未検証」の判定を描画ごとに書くと、ビューどうしで表示が食い違うため（設計 1.3）。
//
// 並びは spec の配列の順（M2 が振った番号の順）。識別子の文字列で並べ替えない（設計 3.6）。
// 論点は本体の反例の種類で見出しを分け、見出しの中はカタログの並びのまま（設計 3.5）。

import type { FormalSpecification } from "../../types/formal.js";
import type { DomainLedgerCatalog, LedgerIssue } from "../../types/ledger.js";
import type { LlmText } from "../../types/index.js";
import type { FindingKind, UnverifiedReason } from "../../types/solver.js";
import { checkText, domainValuesText, initialText, labelOf, outcomeText, traceOutcomeText, valueText } from "./labels.js";
import { stepText } from "./sentences.js";

export interface StateVariableView {
  label: string;
  domain: string;
  values: string;
  initial: string;
}

export interface StepView {
  kind: "CONDITION" | "WRITE";
  text: string;
}

export interface OperationView {
  id: string;
  label: string;
  steps: StepView[];
  outcome: string;
  /** 状態として検証していない変更（dataMutations）の件数。中身は実装の所在なので出さない。 */
  dataMutationCount: number;
  /** この操作が関わる論点の識別子（カタログの並び）。 */
  issueIds: string[];
}

export interface VerificationView {
  /** 1 行目に書く状態。 */
  headline: string;
  /** そのあとに箇条書きにする文。 */
  lines: string[];
}

export interface TraceRowView {
  index: number;
  /** 状態変数ごとの「表示名: 値」（spec の並び）。 */
  values: string[];
  outcome: string;
  holds: string;
}

export interface IssueView {
  id: string;
  status: "未決";
  claim: string;
  observation: string;
  question: string;
  operations: string[];
  /** UNREACHABLE_OPERATION は null。 */
  trace: TraceRowView[] | null;
  options: Array<{ id: string; meaning: string }>;
  dependentCount: number;
}

export interface IssueGroupView {
  kind: FindingKind;
  heading: string;
  issues: IssueView[];
}

export interface ViewModel {
  scenarioId: string;
  specSourceHash: string;
  ledgerReportId: string | null;
  ledgerIsStale: boolean | null;
  stateVariables: StateVariableView[];
  propositions: string[];
  operations: OperationView[];
  /** カタログが無ければ null。 */
  verification: VerificationView | null;
  /** カタログが無ければ null。空の配列は「論点 0 件」。 */
  issueGroups: IssueGroupView[] | null;
  /** 形式仕様のソース（付録用。`-- @source:` の除去は描画の側で行う）。 */
  source: string;
}

export const ISSUE_HEADINGS: ReadonlyArray<{ kind: FindingKind; heading: string }> = [
  { kind: "DEADLOCK", heading: "抜けられない状態" },
  { kind: "UNHANDLED_TRANSITION", heading: "扱いの決まっていない状況" },
  { kind: "OVERLAPPING_OPERATIONS", heading: "複数の操作の条件が重なる状況" },
  { kind: "UNREACHABLE_OPERATION", heading: "到達しない操作" },
];

const DOMAIN_TEXT = { BOOL: "真偽値", ENUM: "列挙", INT: "整数" } as const;

const UNVERIFIED_REASON_TEXT: Readonly<Record<UnverifiedReason, string>> = {
  NO_SOLVER: "検査のエンジンが用意されていない",
  UNREACHABLE: "検査のエンジンに届かなかった",
  TIMEOUT: "検査が制限時間を超えた",
  ENGINE_ERROR: "検査のエンジンがエラーを返した",
};

const NOT_GENERATED_TEXT = {
  UNREACHABLE: "LLM に届かなかった",
  INVALID_OUTPUT: "LLM の出力が検査を通らなかった",
} as const;

/**
 * LLM の文。未生成なら「未生成」と理由を書く（M4 の設計 5 節）。
 * detail は書かない。検出した形式仕様の識別子を含みうるため（仕様 3.2）。
 */
function llmText(text: LlmText): string {
  if (text.status === "GENERATED") return text.text;
  return `未生成（${NOT_GENERATED_TEXT[text.reason]}）`;
}

function verificationView(spec: FormalSpecification, ledger: DomainLedgerCatalog): VerificationView {
  const v = ledger.verification;
  const scopeLine = `検査の範囲: スコープ ${v.scope.scope}、整数のビット幅 ${v.scope.bitwidth}、ステップ数の上限 ${v.scope.maxSteps}`;
  let headline: string;
  const lines: string[] = [];

  switch (v.outcome) {
    case "NONE_FOUND_WITHIN_SCOPE":
      headline = "検査済み。指定のスコープの中で、行った検査では見つからなかった。";
      lines.push(scopeLine);
      break;
    case "FOUND":
      headline = `検査済み。論点 ${ledger.basis.issueCount} 件（元の反例 ${ledger.basis.findingCount} 件をまとめたもの）。`;
      lines.push(scopeLine);
      break;
    case "UNVERIFIED": {
      headline = "未検証。下の論点は見つかったものだけで、ほかに無いとは言えない。";
      const reason = v.reason === null ? "理由は記録されていない" : UNVERIFIED_REASON_TEXT[v.reason.kind];
      lines.push(`未検証の理由: ${reason}`);
      lines.push(scopeLine);
      break;
    }
  }

  if (v.unexecutedChecks.length > 0) {
    lines.push(`実行しなかった検査: ${v.unexecutedChecks.map((id) => checkText(spec, id)).join("、")}`);
  }
  if (v.nonExhaustiveChecks.length > 0) {
    lines.push(`反例を 1 件だけ返す検査（ほかの反例があっても出ない）: ${v.nonExhaustiveChecks.map((id) => checkText(spec, id)).join("、")}`);
  }
  lines.push("不変条件の検査はしていない（初回は不変条件を作らないため）。");
  return { headline, lines };
}

function issueView(spec: FormalSpecification, issue: LedgerIssue): IssueView {
  const trace =
    issue.trace === null
      ? null
      : issue.trace.map((step) => ({
          index: step.index,
          values: spec.stateVariables
            .filter((variable) => Object.hasOwn(step.values, variable.id))
            .map((variable) => `${labelOf(spec, variable.id)}: ${valueText(spec, variable, step.values[variable.id]!)}`),
          outcome: traceOutcomeText(spec, step.outcome),
          holds: step.holds.length === 0 ? "なし" : step.holds.map((prop) => labelOf(spec, prop)).join("、"),
        }));
  return {
    id: issue.id,
    status: "未決",
    claim: llmText(issue.claim),
    observation: llmText(issue.observation),
    question: llmText(issue.question),
    operations: issue.operations.map((operation) => labelOf(spec, operation)),
    trace,
    options: issue.options.map((option) => ({ id: option.id, meaning: option.meaning })),
    dependentCount: issue.dependentFindings.length,
  };
}

export function buildViewModel(
  spec: FormalSpecification,
  ledger: DomainLedgerCatalog | null,
  specSourceHash: string,
): ViewModel {
  const issueIdsByOperation = new Map<string, string[]>();
  for (const issue of ledger?.issues ?? []) {
    for (const operation of issue.operations) {
      const ids = issueIdsByOperation.get(operation) ?? [];
      if (!ids.includes(issue.id)) ids.push(issue.id);
      issueIdsByOperation.set(operation, ids);
    }
  }

  const issueGroups =
    ledger === null
      ? null
      : ISSUE_HEADINGS.map(({ kind, heading }) => ({
          kind,
          heading,
          issues: ledger.issues.filter((issue) => issue.kind === kind).map((issue) => issueView(spec, issue)),
        })).filter((group) => group.issues.length > 0);

  return {
    scenarioId: spec.scenarioId,
    specSourceHash,
    ledgerReportId: ledger === null ? null : ledger.basis.reportId,
    ledgerIsStale: ledger === null ? null : ledger.basis.specSourceHash !== specSourceHash,
    stateVariables: spec.stateVariables.map((variable) => ({
      label: labelOf(spec, variable.id),
      domain: DOMAIN_TEXT[variable.domain],
      values: domainValuesText(spec, variable),
      initial: initialText(spec, variable),
    })),
    propositions: spec.propositions.map((prop) => labelOf(spec, prop.id)),
    operations: spec.operations.map((operation) => ({
      id: operation.id,
      label: labelOf(spec, operation.id),
      steps: operation.steps.map((step) => ({ kind: step.kind, text: stepText(spec, step) })),
      outcome: outcomeText(spec, operation.outcome),
      dataMutationCount: operation.dataMutations.length,
      issueIds: issueIdsByOperation.get(operation.id) ?? [],
    })),
    verification: ledger === null ? null : verificationView(spec, ledger),
    issueGroups,
    source: spec.source,
  };
}