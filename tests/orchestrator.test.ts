// オーケストレーター（全体設計 2.1）のテスト。エンジンは渡さず（M3 は UNVERIFIED）、LLM は届かない偽のポート。
// 小さなライブラリ（入口から 3 つの関数を公開）を M0 から通し、3 通りの結果と合計を確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";

import { displayIdsOf, runPipeline } from "../src/core/orchestrator.js";
import { discoverSystemContext, sliceCommands } from "../src/core/command_extractor.js";
import { projectSystemMap } from "../src/core/spec_projector.js";
import type { FileSystemPort } from "../src/ports/FileSystemPort.js";
import type { LanguageModelPort } from "../src/ports/LanguageModelPort.js";
import type { EngineInfo, SolverPort, SolverResponse } from "../src/ports/SolverPort.js";
import type { SystemProjectionRequest } from "../src/types/projection.js";
import type { RepositoryArtifacts } from "../src/types/command.js";

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
  assert.equal(report.slice.commandTargetCount, 3);
  assert.deepEqual(report.slice.rejected, []);
  assert.deepEqual(
    report.commands.map((commandTarget) => commandTarget.kind),
    ["COMPLETED", "AMBIGUOUS", "STOPPED"],
    JSON.stringify(report.commands),
  );

  const [completed, ambiguous, stopped] = report.commands;
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

  // シナリオの行の項目は CommandTarget の欄を写したもの（全体設計 2.1）。止まったシナリオも同じ欄を持つ。
  const targets = sliceCommands(discoverSystemContext(REPO)).commands;
  assert.deepEqual(
    report.commands.map((commandTarget) => [commandTarget.commandId, commandTarget.inletType, commandTarget.actor, commandTarget.route, commandTarget.expectedEvent]),
    targets.map((target) => [
      target.id,
      target.inletType,
      { id: target.actor.id, name: target.actor.name },
      target.readModel?.route ?? null,
      target.expectedEvent,
    ]),
  );
  // 画面の無いライブラリなので、画面のルートはどれも null
  assert.deepEqual(
    report.commands.map((commandTarget) => commandTarget.route),
    [null, null, null],
  );

  // 検査の範囲: 未検証・曖昧さで止まった・途中で止まったのどれも、検証の結果を持たない
  assert.deepEqual(report.inspectionScope, {
    unit: "PER_COMMAND",
    invariantChecks: { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" },
    commandsWithoutVerification: ["C-01", "C-02", "C-03"],
  });

  // 元にした入力は辞書の basis の写し（意図の候補・実装との対応表と同じ）
  assert.deepEqual(report.basis, result.glossary.basis);
  assert.deepEqual(report.basis, result.intents.basis);
  assert.deepEqual(report.basis, result.implementationMap.basis);
});

test("検査の範囲: 検証の結果を持つシナリオは、検証の結果が無いシナリオに入れない", async () => {
  // どの検査にも UNSAT を返す偽のエンジン（M3 のテストの ScriptedSolver と同じ既定の答え）。
  const engine: EngineInfo = { alloyVersion: "6.test", satSolver: "sat4j", satSolverVersion: null };
  const solver: SolverPort = {
    async run(): Promise<SolverResponse> {
      return { kind: "UNSAT", engine };
    },
  };
  const { report } = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver });
  const [completed] = report.commands;
  assert.ok(completed?.kind === "COMPLETED");
  assert.notEqual(completed.outcome, "UNVERIFIED", JSON.stringify(completed));
  assert.deepEqual(report.inspectionScope.commandsWithoutVerification, ["C-02", "C-03"]);
  assert.deepEqual(report.inspectionScope.invariantChecks, { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" });
});

test("成果物は報告と同じ順・同じ id で、M5 まで進んだシナリオは 3 形式のビューを持つ", async () => {
  const result = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  assert.deepEqual(
    result.commands.map((commandTarget) => [commandTarget.commandId, commandTarget.kind]),
    result.report.commands.map((commandTarget) => [commandTarget.commandId, commandTarget.kind]),
  );

  const completed = result.commands[0];
  assert.ok(completed?.kind === "COMPLETED");
  assert.equal(completed.solverReport.status, "UNVERIFIED");
  assert.equal(completed.ledger.basis.reportId, completed.solverReport.reportId);
  assert.equal(completed.document.format, "DOCUMENT");
  assert.equal(completed.matrix.format, "MATRIX");
  assert.equal(completed.flow.format, "FLOW");
  for (const view of [completed.document, completed.matrix, completed.flow]) {
    assert.equal(view.commandId, completed.commandId);
    assert.equal(view.basis.ledgerIsStale, false);
  }

  const ambiguous = result.commands[1];
  assert.ok(ambiguous?.kind === "AMBIGUOUS");
  assert.equal(ambiguous.ambiguity.issues.length, 3);
  assert.equal(ambiguous.view.format, "AMBIGUITY_DOCUMENT");
  assert.equal(ambiguous.view.displayId, "C-02");
  assert.ok(ambiguous.view.content.startsWith("# C-02"), ambiguous.view.content);
  // BUSINESS の曖昧さの一覧は合計だけ（SpecProjector の設計 8.9）。表示の id は対応表に残る（下）
  assert.ok(ambiguous.view.content.includes("エンジニアの確認待ち: 3 件"), ambiguous.view.content);
  assert.ok(!ambiguous.view.content.includes("src/g.ts"));

  assert.equal(result.systemViews.mermaid.mediaType, "text/vnd.mermaid");
  // system_map.json: 地図 1 と、Bounded Context ごとの地図 2（足す要素なし・あり）を束ね、辞書の basis を写す（全体設計 4.1）。
  const maps = result.systemViews.json;
  assert.equal(maps.viewRole, "BUSINESS");
  assert.deepEqual(maps.basis, result.glossary.basis);
  const projected = async (request: Omit<SystemProjectionRequest, "format" | "viewRole">): Promise<unknown> =>
    JSON.parse(
      (await projectSystemMap(result.map, result.glossary, result.intents, { format: "SYSTEM_JSON", viewRole: "BUSINESS", ...request })).content,
    );
  assert.deepEqual(maps.contextMap, await projected({ level: "CONTEXT_MAP" }));
  assert.deepEqual(maps.details.map((detail) => detail.context), ["c1"]);
  const detail = maps.details[0];
  assert.ok(detail !== undefined);
  assert.deepEqual(detail.core, await projected({ level: "CONTEXT_DETAIL", contextId: "DEFAULT_CONTEXT" }));
  assert.deepEqual(
    detail.supporting,
    await projected({ level: "CONTEXT_DETAIL", contextId: "DEFAULT_CONTEXT", includeSupporting: true }),
  );
  const supportingKinds = new Set(["ACTOR", "READ_MODEL", "AGGREGATE"]);
  assert.ok(detail.core.nodes.every((node) => !supportingKinds.has(String(node["kind"]))));

  // 実装との対応表: シナリオは表示の id の順。曖昧さは止まったシナリオの分、状態変数と論点は最後まで進んだシナリオの分だけ。
  const entries = result.implementationMap.entries;
  assert.deepEqual(
    entries.filter((entry) => entry.kind === "COMMAND_TARGET").map((entry) => [entry.displayId, entry.internalId]),
    result.commands.map((commandTarget) => [commandTarget.displayId, commandTarget.commandId]),
  );
  assert.deepEqual(
    entries.filter((entry) => entry.kind === "AMBIGUITY").map((entry) => entry.displayId),
    ["C-02-A-001", "C-02-A-002", "C-02-A-003"],
  );
  assert.ok(entries.filter((entry) => entry.kind === "STATE_VARIABLE").every((entry) => entry.displayId.startsWith("C-01-V-")));
  assert.ok(!entries.some((entry) => entry.displayId.startsWith("C-03-")), "M1 で止まったシナリオはシナリオの行だけ");
  assert.deepEqual(result.implementationMap.basis, result.glossary.basis);
});

test("意図の候補を 1 回だけ作り、すべての Bounded Context とシナリオに 1 つずつ載せ、報告に要約を書く", async () => {
  const unreachable = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  assert.deepEqual(unreachable.report.intents, { contextCount: 1, commandTargetCount: 3, notGenerated: { UNREACHABLE: 4, INVALID_OUTPUT: 0 } });
  for (const item of [...unreachable.intents.contexts, ...unreachable.intents.commands]) {
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
  assert.deepEqual(result.report.intents, { contextCount: 1, commandTargetCount: 3, notGenerated: { UNREACHABLE: 0, INVALID_OUTPUT: 0 } });
  assert.deepEqual(result.intents.contexts.map((item) => item.contextId), ["DEFAULT_CONTEXT"]);
  assert.deepEqual(
    result.intents.commands.map((item) => item.commandId),
    result.report.commands.map((commandTarget) => commandTarget.commandId).sort(),
  );
  for (const item of [...result.intents.contexts, ...result.intents.commands]) {
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
  assert.deepEqual(second.systemViews.json, first.systemViews.json);
  const a = first.commands[0];
  const b = second.commands[0];
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
    result.report.commands.map((commandTarget) => commandTarget.kind),
    ["AMBIGUOUS"],
  );
  assert.equal(result.report.totals.ambiguous, 1);
});

test("表示の id を切り出しの順に C-01 … と振り、報告と成果物とビューに同じ id を載せる", async () => {
  const result = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  assert.deepEqual(
    result.report.commands.map((commandTarget) => commandTarget.displayId),
    ["C-01", "C-02", "C-03"],
  );
  assert.deepEqual(
    result.commands.map((commandTarget) => [commandTarget.commandId, commandTarget.displayId]),
    result.report.commands.map((commandTarget) => [commandTarget.commandId, commandTarget.displayId]),
  );

  const completed = result.commands[0];
  assert.ok(completed?.kind === "COMPLETED");
  for (const view of [completed.document, completed.matrix, completed.flow]) {
    assert.equal(view.displayId, "C-01");
    assert.equal(view.viewRole, "BUSINESS");
    assert.ok(view.content.includes("C-01"), view.format);
    assert.ok(!view.content.includes(completed.commandId), view.format);
  }
});

test("既定の役割は BUSINESS で仕様書に付録が無く、IMPLEMENTATION を渡すと付録が付く", async () => {
  const pdm = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  const eng = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null }, { viewRole: "IMPLEMENTATION" });
  const a = pdm.commands[0];
  const b = eng.commands[0];
  assert.ok(a?.kind === "COMPLETED" && b?.kind === "COMPLETED");
  assert.ok(!a.document.content.includes("## 付録"));
  assert.ok(b.document.content.includes("## 付録: 形式仕様のソース"));
  assert.equal(b.document.viewRole, "IMPLEMENTATION");
  assert.equal(pdm.systemViews.json.viewRole, "BUSINESS");
  assert.equal(eng.systemViews.json.viewRole, "IMPLEMENTATION");
});

test("選択で絞っても、表示の id は回したシナリオの中で C-01 から振る", async () => {
  const result = await runPipeline(
    REPO,
    { fs: sourceFs(), llm: NO_LLM, solver: null },
    { selection: { filter: { inlets: ["src/g.ts#go"] } } },
  );
  assert.deepEqual(result.report.commands.map((commandTarget) => commandTarget.displayId), ["C-01"]);
});

test("displayIdsOf: 2 桁を最小にし、100 件以上なら件数の桁にそろえる", () => {
  assert.deepEqual(displayIdsOf(0), []);
  assert.deepEqual(displayIdsOf(1), ["C-01"]);
  const ninetyNine = displayIdsOf(99);
  assert.equal(ninetyNine.length, 99);
  assert.equal(ninetyNine[0], "C-01");
  assert.equal(ninetyNine[98], "C-99");
  const hundred = displayIdsOf(100);
  assert.equal(hundred[0], "C-001");
  assert.equal(hundred[99], "C-100");
  assert.deepEqual([...hundred].sort(), hundred);
});