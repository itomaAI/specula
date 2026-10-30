// 仕様不備一覧のビューモデル（SpecViewer 基本設計 3.3・6.7）。
// 純粋な関数。checkRunOutputs を通った RunOutputs を受け取る（通っていない入力では例外を投げる）。
// 論点は SpecProjector の issueGroupsOf で作り、曖昧さの文は SpecProjector の曖昧さの一覧（render_ambiguities.ts）と同じにする。
// PdM には曖昧さの質問・箇所・原文を出さず、シナリオごとの件数だけにする（仕様 3.2、設計 3.3）。
// ビューモデルには内部の識別子を入れない。シナリオ・論点・曖昧さは表示の id で指す（設計 6.7）。

import { statusMark } from "../core/m5/labels.js";
import { AMBIGUITY_KIND_TEXT } from "../core/m5/render_ambiguities.js";
import { issueDisplayIds, issueGroupsOf, llmText } from "../core/m5/view_model.js";
import type { ViewRole } from "../types/projection.js";
import { ambiguityCountText, ambiguityTotal, scenarioTitleOf, sourcesOf, valueOf } from "./scenarios.js";
import type { AmbiguityItemView, IssueListView, RunOutputs, ScenarioAmbiguitiesView, ScenarioIssuesView } from "./types.js";

function unread(displayId: string): Error {
  return new Error(`${displayId} のファイルが読めていない。先に checkRunOutputs を通してください。`);
}

/** 仕様不備一覧（設計 3.3）。論点と曖昧さを、それぞれ実行の報告の順に並べる。途中で止まったシナリオは不備を持たない。 */
export function buildIssueList(outputs: RunOutputs, viewRole: ViewRole): IssueListView {
  const sources = sourcesOf(outputs);
  const scenarios: ScenarioIssuesView[] = [];
  const ambiguities: ScenarioAmbiguitiesView[] = [];

  for (const row of sources.report.scenarios) {
    if (row.kind === "STOPPED") continue;
    const files = outputs.scenarios.find((s) => s.displayId === row.displayId);

    if (row.kind === "COMPLETED") {
      if (files?.kind !== "COMPLETED") throw unread(row.displayId);
      const spec = valueOf(files.spec);
      const ledger = valueOf(files.ledger);
      if (spec === null || ledger === null) throw unread(row.displayId);
      if (ledger.issues.length === 0) continue;

      const displayIds = issueDisplayIds(ledger, row.displayId);
      // 操作の一覧表の行は形式仕様の操作の順に並ぶ（render_matrix.ts）。その位置で一覧表の行を指す。
      const operationRows: Record<string, number[]> = {};
      for (const issue of ledger.issues) {
        operationRows[displayIds.get(issue.id)!] = issue.operations
          .map((operation) => spec.operations.findIndex((candidate) => candidate.id === operation))
          .filter((index) => index >= 0);
      }
      scenarios.push({
        displayId: row.displayId,
        title: scenarioTitleOf(sources, row),
        issueCount: ledger.issues.length,
        groups: issueGroupsOf(spec, ledger, displayIds),
        operationRows,
      });
      continue;
    }

    if (files?.kind !== "AMBIGUOUS") throw unread(row.displayId);
    const report = valueOf(files.ambiguity);
    if (report === null) throw unread(row.displayId);
    const total = ambiguityTotal(row.counts);
    ambiguities.push({
      displayId: row.displayId,
      title: scenarioTitleOf(sources, row),
      total,
      countText: ambiguityCountText(total, viewRole),
      // 並びと番号は SpecProjector の曖昧さの一覧と同じ（report.issues の並び。S-02-A-001 …）。
      items:
        viewRole === "Eng"
          ? report.issues.map(
              (issue, index): AmbiguityItemView => ({
                id: `${row.displayId}-A-${String(index + 1).padStart(3, "0")}`,
                kind: issue.kind,
                kindText: AMBIGUITY_KIND_TEXT[issue.kind],
                question: `${llmText(issue.question)}${statusMark(issue.questionStatus)}`,
                location: { file: issue.location.file, line: issue.location.line },
                detail: issue.detail.replace(/\n+$/, ""),
              }),
            )
          : null,
    });
  }

  return {
    issueTotal: scenarios.reduce((sum, s) => sum + s.issueCount, 0),
    scenarios,
    ambiguityTotal: ambiguities.reduce((sum, a) => sum + a.total, 0),
    ambiguities,
  };
}