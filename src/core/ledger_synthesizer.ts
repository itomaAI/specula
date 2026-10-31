// M4（LedgerSynthesizer）: 検証の報告を、人が判断する論点のカタログにする（M4 の設計・仕様 04）。
//
// 流れ: 契約の検査 → 検証の状態の写し → 同じ状態の反例をまとめる → 種類ごとの選択肢 → LLM で論点の文 → カタログ。
// 論点の数・まとめ方・識別子・選択肢・並びは決定論的に決める。LLM が書くのは論点の文（主張・観測事実・判断質問）だけ。
// どの選択肢も採択しない（decision は常に null）。見つかったものが 0 件でも、仕様を確定する推奨は出さない。
// 報告（元の記録）は書き換えない。

import type { LanguageModelPort } from "../ports/LanguageModelPort.js";
import type { ConfirmationStatus, LlmText } from "../types/index.js";
import type { FormalSpecification } from "../types/formal.js";
import type { DomainLedgerCatalog, LedgerIssue, LedgerVerification } from "../types/ledger.js";
import type { Finding, SolverReport } from "../types/solver.js";
import { checkLedgerContract } from "./m4/contract.js";
import { groupFindings } from "./m4/group.js";
import { issueInput, writeIssueTexts } from "./m4/issue_text.js";
import { optionsFor } from "./m4/options.js";

export { M4_PROMPT_VERSION } from "./m4/issue_text.js";

export async function synthesizeLedger(
  report: SolverReport,
  spec: FormalSpecification,
  deps: { llm: LanguageModelPort },
): Promise<DomainLedgerCatalog> {
  await checkLedgerContract(report, spec);

  const groups = groupFindings(report.commandId, report.findings);
  const issues: LedgerIssue[] = [];
  // 1 件ずつ順に呼ぶ（記録の保存の順と、LLM への負荷を一定にするため）。
  for (const group of groups) {
    const root = report.findings[group.root] as Finding;
    const input = issueInput(spec, group.id, report.findings, group.root, group.dependents, group.operations);
    const texts = await writeIssueTexts(deps.llm, spec, input);
    issues.push({
      id: group.id,
      kind: root.kind,
      rootFinding: group.root,
      dependentFindings: [...group.dependents],
      operations: [...group.operations],
      trace: root.trace === null ? null : root.trace.map((step) => ({ ...step, values: { ...step.values }, holds: [...step.holds] })),
      claim: texts.claim,
      observation: texts.observation,
      question: texts.question,
      claimStatus: statusOf(texts.claim),
      observationStatus: statusOf(texts.observation),
      questionStatus: statusOf(texts.question),
      options: optionsFor(root.kind),
      decision: null,
    });
  }

  return {
    commandId: report.commandId,
    basis: {
      reportId: report.reportId,
      specSourceHash: report.specSourceHash,
      conditions: { ...report.conditions, engine: report.conditions.engine === null ? null : { ...report.conditions.engine } },
      findingCount: report.findings.length,
      issueCount: issues.length,
    },
    verification: verificationOf(report),
    issues,
  };
}

function verificationOf(report: SolverReport): LedgerVerification {
  const outcome: LedgerVerification["outcome"] =
    report.status === "UNVERIFIED" ? "UNVERIFIED" : report.findings.length === 0 ? "NONE_FOUND_WITHIN_SCOPE" : "FOUND";
  return {
    outcome,
    status: report.status,
    reason: report.reason === null ? null : { ...report.reason },
    scope: { scope: report.conditions.scope, maxSteps: report.conditions.maxSteps, bitwidth: report.conditions.bitwidth },
    unexecutedChecks: [...report.unexecutedChecks],
    invariantChecks: { ...report.invariantChecks },
    nonExhaustiveChecks: report.checks.filter((check) => !check.exhaustive).map((check) => check.id),
  };
}

/** 文の確定の状態。確定の操作は無いので、書くのは NOT_GENERATED と CANDIDATE だけ（M4 の設計 8）。 */
function statusOf(text: LlmText): ConfirmationStatus {
  return text.status === "GENERATED" ? "CANDIDATE" : "NOT_GENERATED";
}