// 出力先のファイルが、同じ 1 回の実行の出力としてそろっているかを確かめる（SpecViewer 仕様 3.1、基本設計 6.2）。
// 純粋な関数。返す problems は、すべて画面を作れない理由である。任意のファイル（辞書・意図の候補・実装との対応表・俯瞰図）が
// 無いことは problems に入れない（仕様 2.1。どの画面で何を出すかは buildRunView が決める）。
// basis は run_report.json のものを基準にし、ほかのファイルと比べる。並びは決まった順にする（仕様 3.3 の決定論性）。

import type { FileRead, RunOutputs, RunOutputsCheck, RunOutputsProblem } from "./types.js";

interface Basis {
  mapHash: string;
  documentsHash: string;
}

/** 値の basis を取り出す。basis が無いか、mapHash・documentsHash が文字列でなければ null。 */
function basisOf(value: unknown): Basis | null {
  if (typeof value !== "object" || value === null) return null;
  const basis = (value as { basis?: unknown }).basis;
  if (typeof basis !== "object" || basis === null) return null;
  const { mapHash, documentsHash } = basis as Record<string, unknown>;
  return typeof mapHash === "string" && typeof documentsHash === "string" ? { mapHash, documentsHash } : null;
}

export function checkRunOutputs(outputs: RunOutputs): RunOutputsCheck {
  const problems: RunOutputsProblem[] = [];
  const add = (reason: RunOutputsProblem["reason"], file: string, scenario: string | null, detail: string): void => {
    problems.push({ reason, file, scenario, detail });
  };

  // 実行の報告は必須（仕様 2.1）。basis の基準にする。
  let reference: Basis | null = null;
  if (outputs.report.kind === "MISSING") {
    add("REPORT_MISSING", "run_report.json", null, "実行の報告が無い。出力先が正しいかを確かめてください。");
  } else if (outputs.report.kind === "INVALID") {
    add("INVALID_JSON", "run_report.json", null, outputs.report.reason);
  } else {
    reference = basisOf(outputs.report.value);
    if (reference === null) add("NO_BASIS", "run_report.json", null, "basis が無い。basis を足す前の古い出力なので、実行し直してください。");
  }

  // 任意のファイル。あるものだけを確かめる。
  const others: Array<[string, FileRead<unknown>]> = [
    ["glossary.json", outputs.glossary],
    ["intents.json", outputs.intents],
    ["implementation_map.json", outputs.implementationMap],
    ["system_map.json", outputs.systemMap],
  ];
  for (const [file, read] of others) {
    if (read.kind === "MISSING") continue;
    if (read.kind === "INVALID") {
      add("INVALID_JSON", file, null, read.reason);
      continue;
    }
    const basis = basisOf(read.value);
    if (basis === null) {
      add("NO_BASIS", file, null, "basis が無い。basis を足す前の古い出力なので、実行し直してください。");
      continue;
    }
    if (reference === null) continue;
    const differs: string[] = [];
    if (basis.mapHash !== reference.mapHash) differs.push("全体マップのハッシュ（mapHash）");
    if (basis.documentsHash !== reference.documentsHash) differs.push("資料のハッシュ（documentsHash）");
    if (differs.length > 0) {
      add("BASIS_MISMATCH", file, null, `実行の報告と${differs.join("と")}が違う。別の実行の出力が混ざっている。`);
    }
  }

  // シナリオのファイル。同じ実行の書き出しなら、シナリオの kind から決まるファイルは必ずある（設計 6.1）。
  for (const scenario of outputs.scenarios) {
    const files: Array<[string, FileRead<unknown>]> =
      scenario.kind === "COMPLETED"
        ? [
            ["spec.json", scenario.spec],
            ["spec.md", scenario.document],
            ["matrix.md", scenario.matrix],
            ["flow.mmd", scenario.flow],
            ["spec.als", scenario.source],
            ["ledger.json", scenario.ledger],
          ]
        : scenario.kind === "AMBIGUOUS"
          ? [["ambiguity.json", scenario.ambiguity]]
          : [];
    for (const [file, read] of files) {
      // INVALID になるのは JSON のファイルだけ（readRunOutputs は文字列のファイルをパースしない）。
      if (read.kind === "MISSING") {
        add("SCENARIO_FILE_MISSING", file, scenario.displayId, "実行の報告にあるシナリオのファイルが無い。");
      } else if (read.kind === "INVALID") {
        add("INVALID_JSON", file, scenario.displayId, read.reason);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}