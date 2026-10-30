// 曖昧さの一覧（AMBIGUITY_DOCUMENT）を描く（SpecProjector の設計 8.4）。
//
// FormalTranspiler の AmbiguityReport で止まったシナリオについて、人に答えてほしい曖昧さを並べる。
// - 題と起点の用語の引き方、Eng の併記は仕様書と同じ（view_model.ts の titleOf）。
// - 曖昧さは report.issues の並びのまま、S-01-A-001 … と振る（全体設計 2.2）。
// - unitIds は出さない（ファイルと行を含むため。設計 7.2 の dataMutations と同じ理由）。
// - 所在と原文は Eng のときだけ出す。原文は式や呼び出しのコードの断片なので PdM には出さない（全体設計 2.2）。

import type { AmbiguityKind, AmbiguityReport } from "../../types/formal.js";
import type { AmbiguityProjectionRequest, ProjectionContext } from "../../types/projection.js";
import { fenceFor, joinLines, mdLine } from "./escape.js";
import { codeSpan } from "./implementation.js";
import { llmText, titleOf } from "./view_model.js";

const KINDS: ReadonlyArray<{ kind: AmbiguityKind; text: string }> = [
  { kind: "UNDETERMINED_VALUE", text: "値が決まらない" },
  { kind: "EXTERNAL_EFFECT", text: "外部への作用がある" },
  { kind: "CONFLICTING_SLICES", text: "同じ条件で別の経路に進む" },
];

const KIND_TEXT = Object.fromEntries(KINDS.map(({ kind, text }) => [kind, text])) as Record<AmbiguityKind, string>;

export function renderAmbiguities(
  report: AmbiguityReport,
  context: ProjectionContext,
  request: AmbiguityProjectionRequest,
): string {
  const { title, titleNote } = titleOf(context, request);
  const lines: string[] = [];

  lines.push(`# ${mdLine(title)}${titleNote} の曖昧さ`, "");
  lines.push("このシナリオは曖昧さがあるので、形式仕様の検査まで進まなかった。", "");

  lines.push("## 件数", "");
  for (const { kind, text } of KINDS) lines.push(`- ${text}: ${report.counts[kind]} 件`);
  lines.push("");

  lines.push("## 曖昧さ", "");
  if (report.issues.length === 0) {
    lines.push("曖昧さは無い。", "");
  }
  report.issues.forEach((issue, index) => {
    lines.push(`### ${request.displayId}-A-${String(index + 1).padStart(3, "0")}`, "");
    lines.push(`- 種類: ${KIND_TEXT[issue.kind]}`);
    lines.push(`- 質問: ${mdLine(llmText(issue.question))}`);
    if (request.viewRole === "Eng") {
      lines.push(`- 所在: ${codeSpan(issue.location.file)} L${issue.location.line}`);
      lines.push("");
      const detail = issue.detail.replace(/\n+$/, "");
      const fence = fenceFor(detail);
      lines.push("原文:", "", fence, detail, fence);
    }
    lines.push("");
  });

  return joinLines(lines);
}