// オーケストレーター（全体設計 2.1）のテスト。エンジンは渡さず（M3 は UNVERIFIED）、LLM は届かない偽のポート。
// 小さなライブラリ（入口から 3 つの関数を公開）を M0 から通し、3 通りの結果と合計を確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";

import { displayIdsOf, runPipeline } from "../src/core/orchestrator.js";
import type { FileSystemPort } from "../src/ports/FileSystemPort.js";
import type { LanguageModelPort } from "../src/ports/LanguageModelPort.js";
import type { RepositoryArtifacts } from "../src/types/scenario.js";

class MemoryFs implements FileSystemPort {
  constructor(
    private readonly files: Record<string, string>,
    private readonly broken: ReadonlySet<string> = new Set(),
  ) {}
  async read(path: string): Promise<string> {
    if (this.broken.has(path)) throw new Error(`disk failure: ${path}`);
    const text = this.files[path];
    if (text === undefined) throw new Error(`no such file: ${path}`);
    return text;
  }
  async write(): Promise<void> {
    throw new Error("書かない");
  }
  async exists(path: string): Promise<boolean> {
    return path in this.files || Object.keys(this.files).some((key) => key.startsWith(`${path}/`));
  }
  async list(): Promise<string[]> {
    return [];
  }
}

const NO_LLM: LanguageModelPort = {
  async generate() {
    return { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" };
  },
};

// 真偽値の旗を 1 つ持つ関数（M3 の結合テストと同じ。エンジンがあれば論点 0 件）。
const OPEN_SOURCE = [
  "let open = false;",
  "export function openIt() {",
  "  if (open) {",
  '    return "already";',
  "  }",
  "  open = true;",
  '  return "opened";',
  "}",
].join("\n");

// 値が決まらない書き込みと外への作用がある関数（M2 のテストと同じ。AmbiguityReport になる）。
const AMBIGUOUS_SOURCE = [
  'let state = "a";',
  "export function go(x: number) {",
  "  state = compute(x);",
  "  save(state);",
  "  state.trim();",
  "  log(x);",
  "  return 1;",
  "}",
].join("\n");

const FILES: Record<string, string> = {
  "src/index.ts": [
    'export { openIt } from "./a.js";',
    'export { go } from "./g.js";',
    'export { missing } from "./m.js";',
  ].join("\n"),
  "src/a.ts": OPEN_SOURCE,
  "src/g.ts": AMBIGUOUS_SOURCE,
  "src/m.ts": "export function missing() {\n  return 1;\n}\n",
};

const REPO: RepositoryArtifacts = {
  files: Object.entries(FILES).map(([path, text]) => ({ path, text })),
  documents: [],
  omittedDocuments: [],
};

/** M1 が読む口からは src/m.ts を外す（M0 の全体マップにはあるが、起点のファイルが無いので M1 で止まる）。 */
function sourceFs(broken: ReadonlySet<string> = new Set()): MemoryFs {
  const { "src/m.ts": _omitted, ...rest } = FILES;
  return new MemoryFs(rest, broken);
}

test("3 つのシナリオが、M5 まで進む・M2 で止まる・M1 で止まる に分かれ、合計が合う", async () => {
  const result = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  const { report } = result;

  assert.equal(report.system.mode, "PUBLIC_FUNCTIONS");
  assert.equal(report.system.commandCount, 3);
  assert.equal(report.slice.scenarioCount, 3);
  assert.deepEqual(report.slice.rejected, []);
  assert.deepEqual(
    report.scenarios.map((scenario) => scenario.kind),
    ["COMPLETED", "AMBIGUOUS", "STOPPED"],
    JSON.stringify(report.scenarios),
  );

  const [completed, ambiguous, stopped] = report.scenarios;
  assert.ok(completed?.kind === "COMPLETED");
  assert.equal(completed.outcome, "UNVERIFIED");
  assert.equal(completed.unverifiedReason, "NO_SOLVER");
  assert.equal(completed.findingCount, 0);
  assert.equal(completed.issueCount, 0);

  assert.ok(ambiguous?.kind === "AMBIGUOUS");
  assert.deepEqual(ambiguous.counts, { UNDETERMINED_VALUE: 1, EXTERNAL_EFFECT: 2, CONFLICTING_SLICES: 0 });

  assert.ok(stopped?.kind === "STOPPED");
  assert.equal(stopped.stage, "M1");
  assert.equal(stopped.error, "InletNotFoundError");
  assert.equal(stopped.reason, "ファイルが無い");

  assert.deepEqual(report.totals, {
    completed: 1,
    ambiguous: 1,
    stopped: 1,
    ambiguity: { UNDETERMINED_VALUE: 1, EXTERNAL_EFFECT: 2, CONFLICTING_SLICES: 0 },
    verification: { FOUND: 0, NONE_FOUND_WITHIN_SCOPE: 0, UNVERIFIED: 1 },
  });
});

test("成果物は報告と同じ順・同じ id で、M5 まで進んだシナリオは 3 形式のビューを持つ", async () => {
  const result = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  assert.deepEqual(
    result.scenarios.map((scenario) => [scenario.scenarioId, scenario.kind]),
    result.report.scenarios.map((scenario) => [scenario.scenarioId, scenario.kind]),
  );

  const completed = result.scenarios[0];
  assert.ok(completed?.kind === "COMPLETED");
  assert.equal(completed.solverReport.status, "UNVERIFIED");
  assert.equal(completed.ledger.basis.reportId, completed.solverReport.reportId);
  assert.equal(completed.document.format, "DOCUMENT");
  assert.equal(completed.matrix.format, "MATRIX");
  assert.equal(completed.flow.format, "FLOW");
  for (const view of [completed.document, completed.matrix, completed.flow]) {
    assert.equal(view.scenarioId, completed.scenarioId);
    assert.equal(view.basis.ledgerIsStale, false);
  }

  const ambiguous = result.scenarios[1];
  assert.ok(ambiguous?.kind === "AMBIGUOUS");
  assert.equal(ambiguous.ambiguity.issues.length, 3);
  assert.equal(ambiguous.view.format, "AMBIGUITY_DOCUMENT");
  assert.equal(ambiguous.view.displayId, "S-02");
  assert.ok(ambiguous.view.content.startsWith("# S-02"), ambiguous.view.content);
  assert.ok(ambiguous.view.content.includes("### S-02-A-003"));
  assert.ok(!ambiguous.view.content.includes("src/g.ts"));

  assert.equal(result.systemViews.mermaid.mediaType, "text/vnd.mermaid");
  assert.equal(result.systemViews.json.mediaType, "application/json");

  // 実装との対応表: シナリオは表示の id の順。曖昧さは止まったシナリオの分、状態変数と論点は最後まで進んだシナリオの分だけ。
  const entries = result.implementationMap.entries;
  assert.deepEqual(
    entries.filter((entry) => entry.kind === "SCENARIO").map((entry) => [entry.displayId, entry.internalId]),
    result.scenarios.map((scenario) => [scenario.displayId, scenario.scenarioId]),
  );
  assert.deepEqual(
    entries.filter((entry) => entry.kind === "AMBIGUITY").map((entry) => entry.displayId),
    ["S-02-A-001", "S-02-A-002", "S-02-A-003"],
  );
  assert.ok(entries.filter((entry) => entry.kind === "STATE_VARIABLE").every((entry) => entry.displayId.startsWith("S-01-V-")));
  assert.ok(!entries.some((entry) => entry.displayId.startsWith("S-03-")), "M1 で止まったシナリオはシナリオの行だけ");
  assert.deepEqual(result.implementationMap.basis, result.glossary.basis);
});

test("意図の候補を 1 回だけ作り、すべての Bounded Context とシナリオに 1 つずつ載せ、報告に要約を書く", async () => {
  const unreachable = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  assert.deepEqual(unreachable.report.intents, { contextCount: 1, scenarioCount: 3, notGenerated: { UNREACHABLE: 4, INVALID_OUTPUT: 0 } });
  for (const item of [...unreachable.intents.contexts, ...unreachable.intents.scenarios]) {
    assert.equal(item.intentStatus, "NOT_GENERATED");
  }

  const tasks: string[] = [];
  const intentLlm: LanguageModelPort = {
    async generate(request, check) {
      tasks.push(request.task);
      if (!request.task.startsWith("intent.")) return { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" };
      const text = "公開されている操作を呼び出す。";
      const result = check(text);
      return result.ok
        ? { status: "GENERATED", text, recordKey: `${request.task}:${JSON.stringify(request.input)}` }
        : { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: result.detail };
    },
  };
  const result = await runPipeline(REPO, { fs: sourceFs(), llm: intentLlm, solver: null });
  assert.deepEqual(result.report.intents, { contextCount: 1, scenarioCount: 3, notGenerated: { UNREACHABLE: 0, INVALID_OUTPUT: 0 } });
  assert.deepEqual(result.intents.contexts.map((item) => item.contextId), ["DEFAULT_CONTEXT"]);
  assert.deepEqual(
    result.intents.scenarios.map((item) => item.scenarioId),
    result.report.scenarios.map((scenario) => scenario.scenarioId).sort(),
  );
  for (const item of [...result.intents.contexts, ...result.intents.scenarios]) {
    assert.equal(item.intentStatus, "CANDIDATE");
    assert.equal(item.intent.status, "GENERATED");
  }
  assert.deepEqual(result.intents.basis, result.glossary.basis);
  assert.equal(tasks.filter((task) => task === "intent.context").length, 1);
  assert.equal(tasks.filter((task) => task === "intent.scenario").length, 3);
});

test("同じ入力から同じ報告とビューができる", async () => {
  const first = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  const second = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  assert.deepEqual(second.report, first.report);
  assert.equal(second.systemViews.mermaid.content, first.systemViews.mermaid.content);
  const a = first.scenarios[0];
  const b = second.scenarios[0];
  assert.ok(a?.kind === "COMPLETED" && b?.kind === "COMPLETED");
  assert.equal(b.document.content, a.document.content);
});

test("契約のエラーでない例外（読み込みの故障）は、報告に残さず投げ直す", async () => {
  await assert.rejects(
    runPipeline(REPO, { fs: sourceFs(new Set(["src/a.ts"])), llm: NO_LLM, solver: null }),
    /disk failure: src\/a\.ts/,
  );
});

test("選択で起点を絞ると、そのシナリオだけを回す", async () => {
  const result = await runPipeline(
    REPO,
    { fs: sourceFs(), llm: NO_LLM, solver: null },
    { selection: { filter: { inlets: ["src/g.ts#go"] } } },
  );
  assert.deepEqual(
    result.report.scenarios.map((scenario) => scenario.kind),
    ["AMBIGUOUS"],
  );
  assert.equal(result.report.totals.ambiguous, 1);
});

test("表示の id を切り出しの順に S-01 … と振り、報告と成果物とビューに同じ id を載せる", async () => {
  const result = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  assert.deepEqual(
    result.report.scenarios.map((scenario) => scenario.displayId),
    ["S-01", "S-02", "S-03"],
  );
  assert.deepEqual(
    result.scenarios.map((scenario) => [scenario.scenarioId, scenario.displayId]),
    result.report.scenarios.map((scenario) => [scenario.scenarioId, scenario.displayId]),
  );

  const completed = result.scenarios[0];
  assert.ok(completed?.kind === "COMPLETED");
  for (const view of [completed.document, completed.matrix, completed.flow]) {
    assert.equal(view.displayId, "S-01");
    assert.equal(view.viewRole, "PdM");
    assert.ok(view.content.includes("S-01"), view.format);
    assert.ok(!view.content.includes(completed.scenarioId), view.format);
  }
});

test("既定の役割は PdM で仕様書に付録が無く、Eng を渡すと付録が付く", async () => {
  const pdm = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  const eng = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null }, { viewRole: "Eng" });
  const a = pdm.scenarios[0];
  const b = eng.scenarios[0];
  assert.ok(a?.kind === "COMPLETED" && b?.kind === "COMPLETED");
  assert.ok(!a.document.content.includes("## 付録"));
  assert.ok(b.document.content.includes("## 付録: 形式仕様のソース"));
  assert.equal(b.document.viewRole, "Eng");
  assert.equal(pdm.systemViews.json.viewRole, "PdM");
  assert.equal(eng.systemViews.json.viewRole, "Eng");
});

test("選択で絞っても、表示の id は回したシナリオの中で S-01 から振る", async () => {
  const result = await runPipeline(
    REPO,
    { fs: sourceFs(), llm: NO_LLM, solver: null },
    { selection: { filter: { inlets: ["src/g.ts#go"] } } },
  );
  assert.deepEqual(result.report.scenarios.map((scenario) => scenario.displayId), ["S-01"]);
});

test("displayIdsOf: 2 桁を最小にし、100 件以上なら件数の桁にそろえる", () => {
  assert.deepEqual(displayIdsOf(0), []);
  assert.deepEqual(displayIdsOf(1), ["S-01"]);
  const ninetyNine = displayIdsOf(99);
  assert.equal(ninetyNine.length, 99);
  assert.equal(ninetyNine[0], "S-01");
  assert.equal(ninetyNine[98], "S-99");
  const hundred = displayIdsOf(100);
  assert.equal(hundred[0], "S-001");
  assert.equal(hundred[99], "S-100");
  assert.deepEqual([...hundred].sort(), hundred);
});