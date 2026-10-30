// 操作の流れ図（FLOW）を描く（M5 の設計 4.3）。Mermaid の flowchart TD。
//
// シナリオの起点から操作ごとに枝を出し、操作の表示名 → 条件と書き込み（経路の順）→ 結果、とつなぐ。
// ノードの識別子は機械的に振る（s、op1_0、op1_1 …、op1_r）。表示する文はすべて mermaidLabel で置き換える。

import { joinLines, mermaidLabel } from "./escape.js";
import type { ViewModel } from "./view_model.js";

export function renderFlow(model: ViewModel): string {
  const lines: string[] = [];
  lines.push("flowchart TD");
  if (model.ledgerIsStale === true) {
    lines.push("  %% 注意: 論点カタログは、いまの形式仕様正本とは別の版から作った。");
  }
  // 起点は表示の id で書く。内部の識別子は起点のファイルと関数を含むので出さない（設計 7.4・8.6）。
  lines.push(`  s${mermaidLabel(`シナリオ ${model.displayId} の起点`)}`);

  for (const operation of model.operations) {
    const head = `${operation.id}_0`;
    lines.push(`  ${head}${mermaidLabel(`操作: ${operation.label}`)}`);
    lines.push(`  s --> ${head}`);

    let previous = head;
    operation.steps.forEach((step, index) => {
      const node = `${operation.id}_${index + 1}`;
      lines.push(`  ${node}${mermaidLabel(`${step.kind === "CONDITION" ? "条件" : "書き込み"}: ${step.text}`)}`);
      lines.push(`  ${previous} --> ${node}`);
      previous = node;
    });

    const notes: string[] = [];
    if (operation.dataMutationCount > 0) notes.push(`状態として検証していない変更 ${operation.dataMutationCount} 件`);
    if (operation.issueIds.length > 0) notes.push(`未決の論点: ${operation.issueIds.join("、")}`);
    const result = `${operation.id}_r`;
    const text = notes.length === 0 ? `結果: ${operation.outcome}` : `結果: ${operation.outcome}（${notes.join("。")}）`;
    lines.push(`  ${result}${mermaidLabel(text)}`);
    lines.push(`  ${previous} --> ${result}`);
  }
  return joinLines(lines);
}