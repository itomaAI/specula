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

test("3 つのコマンドが、M5 まで進む・M2 で止まる・M1 で止まる に分かれ、合計が合う", async () => {
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

  // コマンドの行の項目は CommandTarget の欄を写したもの（全体設計 2.1）。止まったコマンドも同じ欄を持つ。
  const targets = sliceCommands(discoverSystemContext(REPO)).commands;
  assert.deepEqual(
    report.commands.map((commandTarget) => [
      commandTarget.commandId,
      commandTarget.actor,
      commandTarget.route,
      commandTarget.expectedEvents,
      commandTarget.invokedBy,
    ]),
    targets.map((target) => [
      target.id,
      { id: target.actor.id, name: target.actor.name },
      target.readModel?.route ?? null,
      target.expectedEvents,
      target.invokedBy.map((policy) => policy.policyId),
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

test("検査の範囲: 検証の結果を持つコマンドは、検証の結果が無いコマンドに入れない", async () => {
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

test("成果物は報告と同じ順・同じ id で、M5 まで進んだコマンドは 3 形式のビューを持つ", async () => {
  const result = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  assert.deepEqual(
    result.commands.map((commandTarget) => [commandTarget.commandId, commandTarget.kind]),
    result.report.commands.map((commandTarget) => [commandTarget.commandId, commandTarget.kind]),
  );

  const completed = result.commands[0];
  assert.ok(completed?.kind === "COMPLETED");
  assert.equal(completed.solverReport.status, "UNVERIFIED");
  assert.equal(completed.ledger.basis.reportId, completed.solverReport.reportId);

  const ambiguous = result.commands[1];
  assert.ok(ambiguous?.kind === "AMBIGUOUS");
  assert.equal(ambiguous.ambiguity.issues.length, 3);

  // 利用者向けの出力は両方の役割で持つ。コマンドは報告の順で、途中で止まったコマンドは入らない（全体設計 4.1）。
  assert.deepEqual(result.views.map((views) => views.viewRole), ["BUSINESS", "IMPLEMENTATION"]);
  for (const views of result.views) {
    assert.deepEqual(
      views.commands.map((commandViews) => [commandViews.commandId, commandViews.displayId, commandViews.kind]),
      result.commands.filter((commandTarget) => commandTarget.kind !== "STOPPED").map((commandTarget) => [commandTarget.commandId, commandTarget.displayId, commandTarget.kind]),
    );
    for (const commandViews of views.commands) {
      const formats = commandViews.kind === "COMPLETED" ? [commandViews.document, commandViews.matrix, commandViews.flow] : [commandViews.view];
      for (const view of formats) assert.equal(view.viewRole, views.viewRole);
    }
    assert.equal(views.system.mermaid.viewRole, views.viewRole);
    assert.equal(views.system.json.viewRole, views.viewRole);
  }
  const business = result.views[0]!;

  const completedViews = business.commands[0];
  assert.ok(completedViews?.kind === "COMPLETED");
  assert.equal(completedViews.document.format, "DOCUMENT");
  assert.equal(completedViews.matrix.format, "MATRIX");
  assert.equal(completedViews.flow.format, "FLOW");
  for (const view of [completedViews.document, completedViews.matrix, completedViews.flow]) {
    assert.equal(view.commandId, completed.commandId);
    assert.equal(view.basis.ledgerIsStale, false);
  }

  const ambiguousViews = business.commands[1];
  assert.ok(ambiguousViews?.kind === "AMBIGUOUS");
  assert.equal(ambiguousViews.view.format, "AMBIGUITY_DOCUMENT");
  assert.equal(ambiguousViews.view.displayId, "C-02");
  assert.ok(ambiguousViews.view.content.startsWith("# C-02"), ambiguousViews.view.content);
  // BUSINESS の曖昧さの一覧は合計だけ（SpecProjector の設計 8.9）。表示の id は対応表に残る（下）
  assert.ok(ambiguousViews.view.content.includes("エンジニアの確認待ち: 3 件"), ambiguousViews.view.content);
  assert.ok(!ambiguousViews.view.content.includes("src/g.ts"));

  assert.equal(business.system.mermaid.mediaType, "text/vnd.mermaid");
  // system_map.json: 地図 1 と、Bounded Context ごとの地図 2（足す要素なし・あり）を束ね、辞書の basis を写す（全体設計 4.1）。
  const maps = business.system.json;
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

  // 実装との対応表: コマンドは表示の id の順。曖昧さは止まったコマンドの分、状態変数と論点は最後まで進んだコマンドの分だけ。
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
  assert.ok(!entries.some((entry) => entry.displayId.startsWith("C-03-")), "M1 で止まったコマンドはコマンドの行だけ");
  assert.deepEqual(result.implementationMap.basis, result.glossary.basis);
});

test("意図の候補を 1 回だけ作り、すべての Bounded Context とコマンドに 1 つずつ載せ、報告に要約を書く", async () => {
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
  // ビューは両方の役割とも同じになる（俯瞰図・仕様書・一覧表・流れ図・曖昧さの一覧）。
  assert.equal(first.views.length, 2);
  assert.deepEqual(second.views, first.views);
  const a = first.views[0]?.commands[0];
  assert.ok(a?.kind === "COMPLETED");
  assert.ok(a.document.content.length > 0);
});

test("契約のエラーでない例外（読み込みの故障）は、報告に残さず投げ直す", async () => {
  await assert.rejects(
    runPipeline(REPO, { fs: sourceFs(new Set(["src/a.ts"])), llm: NO_LLM, solver: null }),
    /disk failure: src\/a\.ts/,
  );
});

test("選択で起点を絞ると、そのコマンドだけを回す", async () => {
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
  for (const views of result.views) {
    const completedViews = views.commands[0];
    assert.ok(completedViews?.kind === "COMPLETED");
    assert.equal(completedViews.displayId, "C-01");
    for (const view of [completedViews.document, completedViews.matrix, completedViews.flow]) {
      assert.equal(view.displayId, "C-01");
      assert.equal(view.viewRole, views.viewRole);
      assert.ok(view.content.includes("C-01"), `${views.viewRole} ${view.format}`);
      // 内部の id を出さないのは BUSINESS だけ（IMPLEMENTATION の付録の形式仕様のソースは識別子を含む。render_document.ts）。
      if (views.viewRole === "BUSINESS") assert.ok(!view.content.includes(completed.commandId), view.format);
    }
  }
});

test("1 回の実行で両方の役割のビューを作り、BUSINESS の仕様書に付録は無く、IMPLEMENTATION には付録が付く", async () => {
  const result = await runPipeline(REPO, { fs: sourceFs(), llm: NO_LLM, solver: null });
  const [business, implementation] = result.views;
  assert.ok(business !== undefined && implementation !== undefined);
  assert.equal(business.viewRole, "BUSINESS");
  assert.equal(implementation.viewRole, "IMPLEMENTATION");
  const a = business.commands[0];
  const b = implementation.commands[0];
  assert.ok(a?.kind === "COMPLETED" && b?.kind === "COMPLETED");
  assert.ok(!a.document.content.includes("## 付録"));
  assert.ok(b.document.content.includes("## 付録: 形式仕様のソース"));
  assert.equal(b.document.viewRole, "IMPLEMENTATION");
  assert.equal(business.system.json.viewRole, "BUSINESS");
  assert.equal(implementation.system.json.viewRole, "IMPLEMENTATION");
});

test("選択で絞っても、表示の id は回したコマンドの中で C-01 から振る", async () => {
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