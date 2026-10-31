// 中間表現（M5 の設計 3）。どのビューも、ここで作った 1 つの値から描く。
// 表示名の解決や「未決」「未検証」の判定を描画ごとに書くと、ビューどうしで表示が食い違うため（設計 1.3）。
//
// 並びは spec の配列の順（M2 が振った番号の順）。識別子の文字列で並べ替えない（設計 3.6）。
// 論点は本体の反例の種類で見出しを分け、見出しの中はカタログの並びのまま（設計 3.5）。

import type { FormalSpecification } from "../../types/formal.js";
import type { DomainLedgerCatalog, LedgerIssue } from "../../types/ledger.js";
import type { LlmText } from "../../types/index.js";
import type { ProjectionContext, ProjectionRequest, ViewRole } from "../../types/projection.js";
import type { FindingKind, UnverifiedReason } from "../../types/solver.js";
import { markdownImplementationNote } from "./implementation.js";
import {
  checkText,
  domainValuesText,
  initialText,
  labelOf,
  markedLabelOf,
  outcomeText,
  statusMark,
  traceOutcomeText,
  valueText,
} from "./labels.js";
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
  /** この操作が関わる論点の表示の id（"C-01-L-001"。カタログの並び）。 */
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

/** 仕様書の「意図の候補」の節（M5 の設計 4.1 の 3）。 */
export interface IntentView {
  /** IntentSynthesizer の候補の文。未生成なら「未生成（理由）」。 */
  text: string;
  /** 利用者定義のシナリオで、利用者が書いた目的。無ければ null。 */
  userIntent: string | null;
}

export interface ViewModel {
  // シナリオの内部の識別子（CT-<ファイル>#<関数>）は持たない。起点のファイルと関数を含むので、
  // どのビューにも出さないため（M5 の設計 4.1・7.4・8.6）。
  /** 表示の id（"C-01"）。 */
  displayId: string;
  /** 題: 「C-01 〈起点の用語〉」、用語が未生成なら「C-01（名前は未生成）」（設計 4.1）。 */
  title: string;
  /** 題の後ろに足す併記（IMPLEMENTATION のときだけ。設計 8.3）。BUSINESS と、所在が無いときは ""。 */
  titleNote: string;
  viewRole: ViewRole;
  /** このシナリオの意図の候補。意図の候補の一覧が無いか、このシナリオの候補が無ければ null。 */
  intent: IntentView | null;
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

// 画面（SpecViewer）のシナリオ一覧も同じ文を出す（SpecViewer 基本設計 6.5）。
export const UNVERIFIED_REASON_TEXT: Readonly<Record<UnverifiedReason, string>> = {
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
export function llmText(text: LlmText): string {
  if (text.status === "GENERATED") return text.text;
  return `未生成（${NOT_GENERATED_TEXT[text.reason]}）`;
}

// 画面（SpecViewer）も同じ文を出すために使う（SpecViewer 基本設計 6.5）。
export function verificationView(spec: FormalSpecification, ledger: DomainLedgerCatalog): VerificationView {
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

  // 検査の範囲（設計 8.9）。検査はシナリオごとに行い、シナリオどうしの矛盾は見ていない。
  lines.push("検査はこのシナリオだけで行った。ほかのシナリオとの矛盾は見ていない。");

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
    claim: `${llmText(issue.claim)}${statusMark(issue.claimStatus)}`,
    observation: `${llmText(issue.observation)}${statusMark(issue.observationStatus)}`,
    question: `${llmText(issue.question)}${statusMark(issue.questionStatus)}`,
    operations: issue.operations.map((operation) => labelOf(spec, operation)),
    trace,
    options: issue.options.map((option) => ({ id: option.id, meaning: option.meaning })),
    dependentCount: issue.dependentFindings.length,
  };
}

/**
 * 論点の表示の id（"C-01-L-001"）。カタログの並び（LedgerSynthesizer が振った連番の順）に振る。
 * 論点の識別子 "LEDGER-<commandId>-001" はシナリオの内部の識別子（起点のファイルと関数）を含むので、
 * ビューには出さない。内部の識別子との対応は実装との対応表（設計 8.5）に持つ。
 * 画面（SpecViewer）も同じ番号を振る（SpecViewer 基本設計 6.5）。
 */
export function issueDisplayIds(ledger: DomainLedgerCatalog | null, displayId: string): Map<string, string> {
  return new Map((ledger?.issues ?? []).map((issue, index) => [issue.id, `${displayId}-L-${String(index + 1).padStart(3, "0")}`] as const));
}

/** 論点を本体の反例の種類で見出しに分ける（設計 3.5）。論点の id は表示の id にする。画面（SpecViewer）も使う。 */
export function issueGroupsOf(
  spec: FormalSpecification,
  ledger: DomainLedgerCatalog,
  displayIds: ReadonlyMap<string, string>,
): IssueGroupView[] {
  return ISSUE_HEADINGS.map(({ kind, heading }) => ({
    kind,
    heading,
    issues: ledger.issues
      .filter((issue) => issue.kind === kind)
      .map((issue) => ({ ...issueView(spec, issue), id: displayIds.get(issue.id)! })),
  })).filter((group) => group.issues.length > 0);
}

/**
 * 題（設計 4.1）。起点のコマンドの項目を辞書で引く（設計 8.2）。
 * 項目が無いか、種類が COMMAND でないか、用語が未生成なら「名前は未生成」とする。
 * 併記は IMPLEMENTATION のときだけ、項目の implementation.locations から作る（設計 8.3）。
 */
export function titleOf(
  context: ProjectionContext,
  request: Pick<ProjectionRequest, "displayId" | "viewRole">,
): { title: string; titleNote: string } {
  const inlet = context.commandTarget.inletTrigger.id;
  const entry = context.glossary?.entries.find((candidate) => candidate.id === inlet);
  const matched = entry !== undefined && entry.kind === "COMMAND" ? entry : undefined;
  const term = matched?.term;
  // 用語に確定の状態の印を足す（設計 8.9）。候補と未生成には付かない。
  const title =
    term !== undefined && term.status === "GENERATED"
      ? `${request.displayId} ${term.label}${statusMark(matched?.termStatus)}`
      : `${request.displayId}（名前は未生成）`;
  const titleNote =
    request.viewRole === "IMPLEMENTATION" && matched !== undefined ? markdownImplementationNote(matched.implementation.locations) : "";
  return { title, titleNote };
}

/** このシナリオの意図の候補（設計 4.1 の 3）。一覧が無いか、このシナリオの候補が無ければ null。 */
function intentOf(context: ProjectionContext): IntentView | null {
  const item = context.intents?.commands.find((candidate) => candidate.commandId === context.commandTarget.id);
  if (item === undefined) return null;
  return { text: `${llmText(item.intent)}${statusMark(item.intentStatus)}`, userIntent: item.userIntent ?? null };
}

export function buildViewModel(
  spec: FormalSpecification,
  ledger: DomainLedgerCatalog | null,
  specSourceHash: string,
  context: ProjectionContext,
  request: ProjectionRequest,
): ViewModel {
  const displayIds = issueDisplayIds(ledger, request.displayId);
  const displayIssueId = (id: string): string => displayIds.get(id)!;

  const issueIdsByOperation = new Map<string, string[]>();
  for (const issue of ledger?.issues ?? []) {
    for (const operation of issue.operations) {
      const ids = issueIdsByOperation.get(operation) ?? [];
      const displayId = displayIssueId(issue.id);
      if (!ids.includes(displayId)) ids.push(displayId);
      issueIdsByOperation.set(operation, ids);
    }
  }

  const issueGroups = ledger === null ? null : issueGroupsOf(spec, ledger, displayIds);

  return {
    displayId: request.displayId,
    ...titleOf(context, request),
    viewRole: request.viewRole,
    intent: intentOf(context),
    specSourceHash,
    ledgerReportId: ledger === null ? null : ledger.basis.reportId,
    ledgerIsStale: ledger === null ? null : ledger.basis.specSourceHash !== specSourceHash,
    // 表示名の確定の状態の印は、項目を定義する箇所（状態変数・列挙の値・環境が決める条件・操作・操作の結果）
    // にだけ付ける。条件・書き込み・実行列・検査の文の中の表示名には付けない（設計 8.9）。
    stateVariables: spec.stateVariables.map((variable) => ({
      label: markedLabelOf(spec, variable.id),
      domain: DOMAIN_TEXT[variable.domain],
      values: domainValuesText(spec, variable),
      initial: initialText(spec, variable),
    })),
    propositions: spec.propositions.map((prop) => markedLabelOf(spec, prop.id)),
    operations: spec.operations.map((operation) => ({
      id: operation.id,
      label: markedLabelOf(spec, operation.id),
      steps: operation.steps.map((step) => ({ kind: step.kind, text: stepText(spec, step) })),
      outcome: outcomeText(spec, operation.outcome, true),
      dataMutationCount: operation.dataMutations.length,
      issueIds: issueIdsByOperation.get(operation.id) ?? [],
    })),
    verification: ledger === null ? null : verificationView(spec, ledger),
    issueGroups,
    source: spec.source,
  };
}