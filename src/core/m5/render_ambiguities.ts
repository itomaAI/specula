// 曖昧さの一覧（AMBIGUITY_DOCUMENT）を描く（SpecProjector の設計 8.4・8.9）。
//
// FormalTranspiler の AmbiguityReport で止まったシナリオについて、人に答えてほしい曖昧さを並べる。
// - 題と起点の用語の引き方、Eng の併記は仕様書と同じ（view_model.ts の titleOf）。
// - PdM には、質問の文・所在・原文・種類を出さず、「エンジニアの確認待ち: N 件」と合計だけを書く。
//   質問は実装の振る舞いについての問いで、実装の名前を含みうるため（FormalTranspiler 仕様 2.2、設計 8.9）。
// - Eng には、曖昧さを report.issues の並びのまま、S-01-A-001 … と振って並べる（全体設計 2.2）。
// - unitIds は出さない（ファイルと行を含むため。設計 7.2 の dataMutations と同じ理由）。

import type { AmbiguityKind, AmbiguityReport } from "../../types/formal.js";
import type { AmbiguityProjectionRequest, ProjectionContext } from "../../types/projection.js";
import { fenceFor, joinLines, mdLine } from "./escape.js";
import { codeSpan } from "./implementation.js";
import { statusMark } from "./labels.js";
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

  if (request.viewRole === "PdM") {
    const total = KINDS.reduce((sum, { kind }) => sum + report.counts[kind], 0);
    lines.push("## 件数", "");
    lines.push(`エンジニアの確認待ち: ${total} 件`, "");
    lines.push("曖昧さの質問は実装の振る舞いについての問いなので、エンジニアが確かめる。", "");
    return joinLines(lines);
  }

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
    lines.push(`- 質問: ${mdLine(llmText(issue.question))}${statusMark(issue.questionStatus)}`);
    lines.push(`- 所在: ${codeSpan(issue.location.file)} L${issue.location.line}`);
    lines.push("");
    const detail = issue.detail.replace(/\n+$/, "");
    const fence = fenceFor(detail);
    lines.push("原文:", "", fence, detail, fence);
    lines.push("");
  });

  return joinLines(lines);
}