// コマンド一覧とコマンドの詳細のビューモデル（SpecViewer 基本設計 3.1・3.2・6.5）。
// 純粋な関数。checkRunOutputs を通った RunOutputs を受け取る（通っていない入力では例外を投げる）。
// 検証の状態・論点・LLM の文・確定の状態の印は SpecProjector の関数で作り、文を写し直さない（設計 6.5）。
// ビューモデルには内部の識別子を入れない。内部の識別子は辞書と意図の候補を引くためだけに使う（設計 4 節）。

import { stripSourceComments } from "../core/m5/escape.js";
import { statusMark } from "../core/m5/labels.js";
import { AMBIGUITY_KIND_TEXT } from "../core/m5/render_ambiguities.js";
import { UNVERIFIED_REASON_TEXT, issueDisplayIds, issueGroupsOf, llmText, verificationView } from "../core/m5/view_model.js";
import type { AmbiguityKind } from "../types/formal.js";
import type { EntryKind, Glossary, GlossaryLocation } from "../types/glossary.js";
import type { IntentCatalog } from "../types/intent.js";
import type { VerificationOutcome } from "../types/ledger.js";
import type { ImplementationMap, ViewRole } from "../types/projection.js";
import type { RunReport, CommandRunResult } from "../types/run.js";
import type {
  FileRead,
  RunOutputs,
  RunSummaryView,
  CommandDetailView,
  CommandKind,
  CommandListView,
  CommandRowView,
} from "./types.js";
import { buildFlowView } from "./graph.js";
import { parseMarkdown } from "./markdown.js";

const KIND_TEXT: Readonly<Record<CommandKind, string>> = {
  COMPLETED: "仕様になった",
  AMBIGUOUS: "曖昧さで止まった",
  STOPPED: "途中で止まった",
};

const AMBIGUITY_KINDS: readonly AmbiguityKind[] = ["UNDETERMINED_VALUE", "EXTERNAL_EFFECT", "CONFLICTING_SLICES"];

const OUTCOMES: ReadonlyArray<{ outcome: VerificationOutcome; text: string }> = [
  { outcome: "FOUND", text: "論点が見つかった" },
  { outcome: "NONE_FOUND_WITHIN_SCOPE", text: "指定の範囲で、行った検査では見つからなかった" },
  { outcome: "UNVERIFIED", text: "未検証" },
];


const NO_MAP = "（名前を引けない: 実装との対応表が無い）";
const NO_GLOSSARY = "（名前を引けない: 辞書が無い）";
const NOT_GENERATED = "（名前は未生成）";
const NO_INTENT = "意図の候補が無い";

function valueOf<T>(read: FileRead<T>): T | null {
  return read.kind === "OK" ? read.value : null;
}

interface Sources {
  report: RunReport;
  glossary: Glossary | null;
  intents: IntentCatalog | null;
  implementationMap: ImplementationMap | null;
}

function sourcesOf(outputs: RunOutputs): Sources {
  const report = valueOf(outputs.report);
  if (report === null) throw new Error("run_report.json が読めていない。先に checkRunOutputs を通してください。");
  return {
    report,
    glossary: valueOf(outputs.glossary),
    intents: valueOf(outputs.intents),
    implementationMap: valueOf(outputs.implementationMap),
  };
}

/**
 * 辞書の項目の表示名と確定の状態の印。項目が無いか、種類が違うか、用語が未生成なら「名前は未生成」（設計 6.5）。
 * 辞書が無いことを「未生成」と書くと事実と違うので、理由を分ける。
 */
function labelOfEntry(glossary: Glossary | null, id: string | null, kind: EntryKind): { ok: true; text: string } | { ok: false; text: string } {
  if (glossary === null) return { ok: false, text: NO_GLOSSARY };
  const entry = id === null ? undefined : glossary.entries.find((candidate) => candidate.id === id);
  if (entry === undefined || entry.kind !== kind || entry.term === undefined || entry.term.status !== "GENERATED") {
    return { ok: false, text: NOT_GENERATED };
  }
  return { ok: true, text: `${entry.term.label}${statusMark(entry.termStatus)}` };
}

/** 対応表の COMMAND_TARGET の行。対応表が無ければ null、行が無ければ undefined。 */
function commandMapRow(sources: Sources, displayId: string) {
  if (sources.implementationMap === null) return null;
  return sources.implementationMap.entries.find((entry) => entry.kind === "COMMAND_TARGET" && entry.displayId === displayId);
}

/** 題（設計 6.5）。形は SpecProjector の titleOf と同じ。 */
function titleOf(sources: Sources, row: CommandRunResult): string {
  const mapRow = commandMapRow(sources, row.displayId);
  if (mapRow === null) return `${row.displayId}${NO_MAP}`;
  const label = labelOfEntry(sources.glossary, mapRow?.glossaryEntryId ?? null, "COMMAND");
  return label.ok ? `${row.displayId} ${label.text}` : `${row.displayId}${label.text}`;
}

function inletLocationsOf(sources: Sources, row: CommandRunResult, viewRole: ViewRole): GlossaryLocation[] | null {
  if (viewRole !== "IMPLEMENTATION") return null;
  return commandMapRow(sources, row.displayId)?.implementation.locations ?? [];
}

/** 意図の候補（SpecProjector の仕様書と同じ文）。 */
function intentOf(sources: Sources, row: CommandRunResult): { text: string; userIntent: string | null } {
  const item = sources.intents?.commands.find((candidate) => candidate.commandId === row.commandId);
  if (item === undefined) return { text: NO_INTENT, userIntent: null };
  return { text: `${llmText(item.intent)}${statusMark(item.intentStatus)}`, userIntent: item.userIntent ?? null };
}

function ambiguityTotal(counts: Record<AmbiguityKind, number>): number {
  return AMBIGUITY_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
}

/** 曖昧さの件数の文。BUSINESS は「エンジニアの確認待ち」だけ（設計 3.1・3.3）。 */
function ambiguityCountText(total: number, viewRole: ViewRole): string {
  return viewRole === "BUSINESS" ? `エンジニアの確認待ち: ${total} 件` : `曖昧さ ${total} 件`;
}

function verificationTextOf(row: CommandRunResult): string | null {
  if (row.kind !== "COMPLETED") return null;
  if (row.outcome !== "UNVERIFIED") return OUTCOMES.find((o) => o.outcome === row.outcome)!.text;
  const reason = row.unverifiedReason === null ? "理由は記録されていない" : UNVERIFIED_REASON_TEXT[row.unverifiedReason];
  return `未検証（${reason}）`;
}

function countTextOf(row: CommandRunResult, viewRole: ViewRole): string | null {
  if (row.kind === "COMPLETED") return `論点 ${row.issueCount} 件`;
  if (row.kind === "AMBIGUOUS") return ambiguityCountText(ambiguityTotal(row.counts), viewRole);
  return null;
}

function summaryOf(report: RunReport, viewRole: ViewRole): RunSummaryView {
  const total = ambiguityTotal(report.totals.ambiguity);
  const inspectionScope = ["検査はコマンドごとに行った。コマンドどうしの矛盾は見ていない。"];
  if (report.inspectionScope.invariantChecks.status === "NOT_APPLICABLE") {
    inspectionScope.push("不変条件の検査はしていない（初回は不変条件を作らないため）。");
  }
  if (report.inspectionScope.commandsWithoutVerification.length > 0) {
    inspectionScope.push(`検証の結果が無いコマンド: ${report.inspectionScope.commandsWithoutVerification.join("、")}`);
  }
  const sum = (counts: { UNREACHABLE: number; INVALID_OUTPUT: number }): number => counts.UNREACHABLE + counts.INVALID_OUTPUT;
  return {
    parsedFileCount: report.system.parsedFileCount,
    parseFailureCount: report.system.parseFailureCount,
    boundedContextCount: report.system.boundedContextCount,
    commandCount: report.system.commandCount,
    eventCount: report.system.eventCount,
    commandTargetCounts: { COMPLETED: report.totals.completed, AMBIGUOUS: report.totals.ambiguous, STOPPED: report.totals.stopped },
    ambiguity: {
      total,
      text: ambiguityCountText(total, viewRole),
      byKind:
        viewRole === "IMPLEMENTATION"
          ? AMBIGUITY_KINDS.map((kind) => ({ kind, text: AMBIGUITY_KIND_TEXT[kind], count: report.totals.ambiguity[kind] }))
          : null,
    },
    verification: OUTCOMES.map(({ outcome, text }) => ({ outcome, text, count: report.totals.verification[outcome] })),
    inspectionScope,
    notGenerated: { glossary: sum(report.glossary.notGenerated), intents: sum(report.intents.notGenerated) },
    documents: { ...report.glossary.documents },
  };
}

/** コマンド一覧（設計 3.1）。行は実行の報告の順。 */
export function buildCommandList(outputs: RunOutputs, viewRole: ViewRole): CommandListView {
  const sources = sourcesOf(outputs);
  const rows: CommandRowView[] = sources.report.commands.map((row) => ({
    displayId: row.displayId,
    title: titleOf(sources, row),
    kind: row.kind,
    kindText: KIND_TEXT[row.kind],
    verificationText: verificationTextOf(row),
    countText: countTextOf(row, viewRole),
    intentText: intentOf(sources, row).text,
    boundedContext: labelOfEntry(sources.glossary, row.boundedContext, "BOUNDED_CONTEXT").text,
    inletLocations: inletLocationsOf(sources, row, viewRole),
  }));
  return {
    summary: summaryOf(sources.report, viewRole),
    showContextColumn: sources.report.system.boundedContextCount > 1,
    rows,
  };
}

/** コマンドの詳細（設計 3.2）。実行の報告の順に、すべてのコマンドの分を返す。 */
export function buildCommandDetails(outputs: RunOutputs, viewRole: ViewRole): CommandDetailView[] {
  const sources = sourcesOf(outputs);
  return sources.report.commands.map((row): CommandDetailView => {
    const intent = intentOf(sources, row);
    const base = {
      displayId: row.displayId,
      title: titleOf(sources, row),
      kind: row.kind,
      kindText: KIND_TEXT[row.kind],
      boundedContext: labelOfEntry(sources.glossary, row.boundedContext, "BOUNDED_CONTEXT").text,
      intentText: intent.text,
      userIntent: intent.userIntent,
      invokedBy: row.invokedBy.map((policyId) => labelOfEntry(sources.glossary, policyId, "POLICY").text),
      actor: row.actor.name,
      route: row.route,
      expectedEvents: row.expectedEvents.map((eventId) => labelOfEntry(sources.glossary, eventId, "EVENT").text),
      inletLocations: inletLocationsOf(sources, row, viewRole),
    };

    if (row.kind === "COMPLETED") {
      const files = outputs.commands.find((s) => s.displayId === row.displayId);
      if (files?.kind !== "COMPLETED") {
        throw new Error(`${row.displayId} のファイルが読めていない。先に checkRunOutputs を通してください。`);
      }
      const spec = valueOf(files.spec);
      const ledger = valueOf(files.ledger);
      const document = valueOf(files.document);
      const matrix = valueOf(files.matrix);
      const source = valueOf(files.source);
      const flow = valueOf(files.flow);
      if (spec === null || ledger === null || document === null || matrix === null || source === null || flow === null) {
        throw new Error(`${row.displayId} のファイルが読めていない。先に checkRunOutputs を通してください。`);
      }
      return {
        ...base,
        verification: verificationView(spec, ledger),
        issueCount: ledger.issues.length,
        issueGroups: issueGroupsOf(spec, ledger, issueDisplayIds(ledger, row.displayId)),
        tabs: {
          document: parseMarkdown(document),
          matrix: parseMarkdown(matrix),
          // SpecProjector の付録と同じく、`-- @source:` の行を除く（設計 6.6）。
          source: viewRole === "IMPLEMENTATION" ? stripSourceComments(source).replace(/\n+$/, "") : null,
          // 流れ図は flow.mmd を読み、全体地図と同じ配置の関数で層に並べる（設計 6.9）。
          flow: buildFlowView(flow),
        },
        notice: null,
      };
    }

    const notice =
      row.kind === "AMBIGUOUS"
        ? `このコマンドは、エンジニアの確認待ちの箇所が ${ambiguityTotal(row.counts)} 件あるため、形式仕様にできなかった。`
        : viewRole === "IMPLEMENTATION"
          ? `このコマンドは途中で止まったため、仕様にならなかった（${row.stage} で止まった: ${row.error}）。`
          : "このコマンドは途中で止まったため、仕様にならなかった。";
    return { ...base, verification: null, issueCount: null, issueGroups: null, tabs: null, notice };
  });
}

// 仕様不備一覧（issues.ts）も同じ題と件数の文を出すために使う（設計 6.7）。
// 用語辞典（glossary.ts）は、用語の文を同じ形にするために labelOfEntry を使う（設計 6.8）。
export { ambiguityCountText, ambiguityTotal, labelOfEntry, sourcesOf, titleOf as commandTitleOf, valueOf };