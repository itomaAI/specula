// 操作の一覧表（MATRIX）を描く（M5 の設計 4.2）。
//
// 条件と書き込みは別の列に分かれるが、条件の文はそれより前の書き込みを反映した値についての文である（設計 3.2）。
// このため、どちらの列でも各項目の前に経路の中の位置「(n)」を付け、列をまたいで順が読めるようにする。

import { joinLines, mdCell, mdLine } from "./escape.js";
import type { OperationView, ViewModel } from "./view_model.js";

function stepsCell(operation: OperationView, kind: "CONDITION" | "WRITE"): string {
  const parts: string[] = [];
  operation.steps.forEach((step, index) => {
    if (step.kind === kind) parts.push(`(${index + 1}) ${step.text}`);
  });
  return parts.length === 0 ? "なし" : parts.join("；");
}

export function renderMatrix(model: ViewModel): string {
  const lines: string[] = [];
  // 題は仕様書と同じ（設計 4.1）。内部の識別子は出さない。
  lines.push(`# 操作の一覧表: ${mdLine(model.title)}${model.titleNote}`, "");
  if (model.ledgerIsStale === true) {
    lines.push("> 注意: この論点カタログは、いまの形式仕様正本とは別の版から作った。論点は古い版について見つかったものである。", "");
  }
  if (model.issueGroups === null) {
    lines.push("論点カタログが無いので、「関わる論点」の列は空にした（M4 を実行していない）。", "");
  } else if (model.issueGroups.length > 0) {
    lines.push("論点はすべて未決である。", "");
  }
  lines.push("「(n)」は経路の中の位置で、条件はそれより前の書き込みを反映した値についての文である。", "");

  lines.push("| 表示名 | 実行できる条件 | 結果 | 状態の変化 | 状態として検証していない変更 | 関わる論点 |");
  lines.push("| :-- | :-- | :-- | :-- | :-- | :-- |");
  for (const operation of model.operations) {
    const mutations = operation.dataMutationCount === 0 ? "なし" : `${operation.dataMutationCount} 件`;
    const issues = model.issueGroups === null ? "" : operation.issueIds.length === 0 ? "なし" : operation.issueIds.join("、");
    lines.push(
      `| ${mdCell(operation.label)} | ${mdCell(stepsCell(operation, "CONDITION"))} | ${mdCell(operation.outcome)} | ${mdCell(stepsCell(operation, "WRITE"))} | ${mutations} | ${mdCell(issues)} |`,
    );
  }
  return joinLines(lines);
}