// M3 を本物の Alloy 6 にかける結合テスト（M3 の設計 3.3）。
// 環境変数 ALLOY_JAR（org.alloytools.alloy.dist.jar のパス）があるときだけ走る。CI では ci.yml が版と SHA-256 を固定して取ってくる。

import { test } from "node:test";
import assert from "node:assert/strict";

import { CliAlloyAdapter } from "../src/adapters/CliAlloyAdapter.js";
import { extractContext } from "../src/core/context_extractor.js";
import { transpileFormal } from "../src/core/formal_transpiler.js";
import { verifySpecification } from "../src/core/formal_solver.js";
import { synthesizeLedger } from "../src/core/ledger_synthesizer.js";
import { projectSpecification } from "../src/core/spec_projector.js";
import type { FileSystemPort } from "../src/ports/FileSystemPort.js";
import type { LanguageModelPort } from "../src/ports/LanguageModelPort.js";
import type { SolverRequest } from "../src/ports/SolverPort.js";
import type { ScenarioTarget } from "../src/types/scenario.js";

const JAR = process.env.ALLOY_JAR;
const skip = JAR === undefined || JAR === "" ? "ALLOY_JAR が無い" : false;

function adapter(): CliAlloyAdapter {
  return new CliAlloyAdapter({ jarPath: JAR as string });
}

function request(source: string, command: string, steps = 3, preventOverflow = true): SolverRequest {
  return { source, command, steps, bitwidth: 4, preventOverflow, timeoutMs: 60000 };
}

const BOOL_MODEL = [
  "abstract sig Bool {}",
  "one sig True, False extends Bool {}",
  "one sig System { var v1: one Bool }",
  "fact Init { System.v1 = False }",
  "pred flip { System.v1 = False and System.v1' = True }",
  "pred stutter { System.v1' = System.v1 }",
  "fact Steps { always (flip or stutter) }",
  "pred flip_guard { System.v1 = False }",
].join("\n");

test("CLI: 反例があれば SAT で、最短の実行列（2 時点）と版を返す", { skip }, async () => {
  const source = `${BOOL_MODEL}\ncheck m3_cover {\n  always (flip_guard)\n} for 3 but 4 Int, 1..3 steps\n`;
  const response = await adapter().run(request(source, "m3_cover"));
  assert.equal(response.kind, "SAT", JSON.stringify(response));
  if (response.kind !== "SAT") return;
  assert.equal(response.engine.alloyVersion, "6.2.0");
  assert.equal(response.engine.satSolver, "sat4j");
  assert.deepEqual(response.instance.states, [{ "System.v1": [["False$0"]] }, { "System.v1": [["True$0"]] }]);
});

test("CLI: 成り立つ性質は UNSAT", { skip }, async () => {
  const source = `${BOOL_MODEL}\ncheck m3_holds {\n  always (System.v1 = True implies after System.v1 = True)\n} for 3 but 4 Int, 1..3 steps\n`;
  const response = await adapter().run(request(source, "m3_holds"));
  assert.equal(response.kind, "UNSAT", JSON.stringify(response));
});

test("CLI: 構文の誤りは ENGINE_ERROR で、行と列を含む", { skip }, async () => {
  const response = await adapter().run(request("one sig System { var v1: one Int\nrun m3_x { } for 3\n", "m3_x"));
  assert.equal(response.kind, "ENGINE_ERROR");
  if (response.kind === "ENGINE_ERROR") assert.match(response.message, /line 2 column 1/);
});

test("CLI: 知らないコマンド名は UNSAT ではなく ENGINE_ERROR", { skip }, async () => {
  const source = `${BOOL_MODEL}\nrun m3_reach { eventually flip } for 3 but 4 Int, 1..3 steps\n`;
  const response = await adapter().run(request(source, "m3_no_such_command"));
  assert.equal(response.kind, "ENGINE_ERROR", JSON.stringify(response));
});

const OVERFLOW_MODEL = [
  "one sig C { var n: one Int }",
  "fact Init { C.n = 7 }",
  "pred inc { C.n' = plus[C.n, 1] }",
  "pred stutter { C.n' = C.n }",
  "fact Steps { always (inc or stutter) }",
  "run m3_wrap {\n  eventually C.n < 0\n} for 3 but 4 Int, 1..3 steps",
].join("\n");

test("CLI: あふれを禁じると、7 + 1 が -8 になる実例は返らない", { skip }, async () => {
  const allowed = await adapter().run(request(OVERFLOW_MODEL, "m3_wrap", 3, false));
  assert.equal(allowed.kind, "SAT", JSON.stringify(allowed));
  const prevented = await adapter().run(request(OVERFLOW_MODEL, "m3_wrap", 3, true));
  assert.equal(prevented.kind, "UNSAT", JSON.stringify(prevented));
});

test("CLI: いちばん小さい整数（4 Int の -8）の書き方", { skip }, async (t) => {
  const model = (literal: string): string =>
    `one sig C { var n: one Int }\nfact Init { C.n = ${literal} }\nfact Steps { always C.n' = C.n }\nrun m3_min {\n  C.n < 0\n} for 3 but 4 Int, 1..1 steps\n`;
  // 負の整数はリテラルで書く（M2 の intText と plan.ts の valueText）。いちばん小さい整数でも、あふれを許しても禁じても -8 になる。
  for (const preventOverflow of [false, true]) {
    const response = await adapter().run(request(model("-8"), "m3_min", 1, preventOverflow));
    assert.equal(response.kind, "SAT", `preventOverflow=${preventOverflow}: ${JSON.stringify(response)}`);
    if (response.kind === "SAT") assert.deepEqual(response.instance.states[0], { "C.n": [["-8"]] });
  }
  // `minus[0, 8]` は範囲の外の 8 を使うので、あふれを禁じると充足できない（この書き方を採らない理由）。
  const outOfRange = await adapter().run(request(model("minus[0, 8]"), "m3_min", 1, true));
  t.diagnostic(`min-int minus[0, 8] preventOverflow=true: ${outOfRange.kind}`);
  assert.equal(outOfRange.kind, "UNSAT", JSON.stringify(outOfRange));
});

// ---------------------------------------------------------------------------
// M1 → M2 → M3 を本物のエンジンで通す。

class MemoryFs implements FileSystemPort {
  constructor(private readonly files: Record<string, string>) {}
  async read(path: string): Promise<string> {
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

function target(file: string, symbol: string): ScenarioTarget {
  return {
    id: "SCN-1",
    boundedContext: "DEFAULT_CONTEXT",
    origin: "EXTRACTED",
    inletType: "COMMAND",
    inletTrigger: { id: "CMD-1", handler: { file, symbol, line: 1 } },
    actor: { id: "Caller", name: "Caller" },
    expectedEvent: "EVT-1",
  };
}

const BOOL_SOURCE = [
  "let open = false;",
  "export function openIt() {",
  "  if (open) {",
  '    return "already";',
  "  }",
  "  open = true;",
  '  return "opened";',
  "}",
];

test("M1 → M2 → M3: 真偽値の例を本物のエンジンにかける（どの操作も到達でき、重なりも行き詰まりも無い）", { skip }, async () => {
  const facts = await extractContext(target("src/a.ts", "openIt"), { fs: new MemoryFs({ "src/a.ts": BOOL_SOURCE.join("\n") }) });
  const result = await transpileFormal(facts, {});
  if (result.kind !== "SPEC") assert.fail("SPEC ではない");
  const report = await verifySpecification(result.spec, { solver: adapter() }, { maxSteps: 3 });

  assert.equal(report.status, "CHECKED", JSON.stringify(report.reason));
  assert.equal(report.conditions.engine?.alloyVersion, "6.2.0");
  assert.deepEqual(
    report.checks.map((check) => [check.id, check.result]),
    [
      ["m3_cover", "NOT_FOUND_WITHIN_SCOPE"],
      ["m3_overlap_op1_op2", "NOT_FOUND_WITHIN_SCOPE"],
      ["m3_reach_op1", "FOUND"],
      ["m3_reach_op2", "FOUND"],
    ],
  );
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.unexecutedChecks, []);
});

// ---------------------------------------------------------------------------
// M1 → M2 → M3 → M4。M4 は LLM が届かない偽のポートで、論点の構成だけを確かめる。

const NO_LLM: LanguageModelPort = {
  async generate() {
    return { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" };
  },
};

test("M1 → M2 → M3 → M4: 真偽値の例は論点 0 件で、「スコープの中で見つからなかった」になる", { skip }, async () => {
  const facts = await extractContext(target("src/a.ts", "openIt"), { fs: new MemoryFs({ "src/a.ts": BOOL_SOURCE.join("\n") }) });
  const result = await transpileFormal(facts, {});
  if (result.kind !== "SPEC") assert.fail("SPEC ではない");
  const report = await verifySpecification(result.spec, { solver: adapter() }, { maxSteps: 3 });
  const catalog = await synthesizeLedger(report, result.spec, { llm: NO_LLM });

  assert.equal(catalog.verification.outcome, "NONE_FOUND_WITHIN_SCOPE");
  assert.equal(catalog.basis.reportId, report.reportId);
  assert.equal(catalog.basis.findingCount, 0);
  assert.deepEqual(catalog.issues, []);
});

// 条件の旗に書くのは false だけなので、旗が立っているときの出口には届かない。
// 旗に書き込みが無いと M1 は状態変数にせず、条件は環境が決める命題になって両方の出口に届く（552f28d の CI で確かめた）。
// そのため、旗を false に書く行を経路に置いている。
const UNREACHABLE_SOURCE = [
  "let locked = false;",
  "export function read() {",
  "  if (locked) {",
  '    return "locked";',
  "  }",
  "  locked = false;",
  '  return "read";',
  "}",
];

test("M1 → M2 → M3 → M4: 届かない出口のある例は、到達できない操作が 1 件で 1 つの論点になる", { skip }, async (t) => {
  const facts = await extractContext(target("src/r.ts", "read"), { fs: new MemoryFs({ "src/r.ts": UNREACHABLE_SOURCE.join("\n") }) });
  const result = await transpileFormal(facts, {});
  if (result.kind !== "SPEC") assert.fail(`SPEC ではない: ${JSON.stringify(result)}`);
  const report = await verifySpecification(result.spec, { solver: adapter() }, { maxSteps: 3 });
  t.diagnostic(`unreachable checks: ${JSON.stringify(report.checks.map((check) => [check.id, check.result]))}`);

  assert.equal(report.status, "CHECKED", JSON.stringify(report.reason));
  assert.deepEqual(
    report.findings.map((finding) => finding.kind),
    ["UNREACHABLE_OPERATION"],
  );

  const catalog = await synthesizeLedger(report, result.spec, { llm: NO_LLM });
  assert.equal(catalog.verification.outcome, "FOUND");
  assert.equal(catalog.basis.findingCount, 1);
  assert.equal(catalog.issues.length, 1);
  const issue = catalog.issues[0];
  assert.equal(issue?.kind, "UNREACHABLE_OPERATION");
  assert.equal(issue?.rootFinding, 0);
  assert.deepEqual(issue?.dependentFindings, []);
  assert.equal(issue?.trace, null);
  assert.deepEqual(issue?.operations, report.findings[0]?.operations);
  assert.equal(issue?.decision, null);
  assert.equal(issue?.claim.status, "NOT_GENERATED");
});

// ---------------------------------------------------------------------------
// M1 → M2 → M3 → M4 → M5。LLM は届かないので表示名はすべて未生成になる。
// 仕様 3.2 のとおり、識別子が出てよいのは「（表示名は未生成）」を添えたところだけであることを確かめる。

const M5_IDENTIFIER = /\b(?:v\d+(?:_\d+|_unknown)?|c\d+|op\d+(?:_guard)?|o\d+|m3_\w+)\b/;

test("M1 → M2 → M3 → M4 → M5: 本物のエンジンの結果から仕様書を作り、未決・検証の状態・識別子の扱いが設計どおり", { skip }, async () => {
  const facts = await extractContext(target("src/r.ts", "read"), { fs: new MemoryFs({ "src/r.ts": UNREACHABLE_SOURCE.join("\n") }) });
  const result = await transpileFormal(facts, {});
  if (result.kind !== "SPEC") assert.fail(`SPEC ではない: ${JSON.stringify(result)}`);
  const report = await verifySpecification(result.spec, { solver: adapter() }, { maxSteps: 3 });
  const catalog = await synthesizeLedger(report, result.spec, { llm: NO_LLM });

  // 辞書と意図の候補は渡さない（起点の用語は「名前は未生成」になる）。役割は BUSINESS。
  const context = { scenario: target("src/r.ts", "read"), glossary: null, intents: null };
  const view = await projectSpecification(result.spec, catalog, context, { format: "DOCUMENT", viewRole: "BUSINESS", displayId: "S-01" });
  const again = await projectSpecification(result.spec, catalog, context, { format: "DOCUMENT", viewRole: "BUSINESS", displayId: "S-01" });
  assert.equal(view.content, again.content);
  assert.equal(view.basis.ledgerIsStale, false);
  assert.equal(view.basis.ledgerReportId, report.reportId);

  // BUSINESS には付録（形式仕様のソース）が無いので、本文全体を見る。
  assert.ok(!view.content.includes("## 付録"));
  assert.ok(!view.content.includes("SCN-1"));
  const body = view.content;
  assert.ok(body.includes("検査済み。論点 1 件（元の反例 1 件をまとめたもの）。"));
  assert.ok(body.includes("### 到達しない操作"));
  assert.ok(body.includes("- 状態: 未決"));
  assert.ok(body.includes("- 主張: 未生成（LLM に届かなかった）"));
  assert.ok(!view.content.includes("@source"));
  assert.ok(!view.content.includes("src/r.ts"));
  assert.doesNotMatch(body.replace(/[A-Za-z0-9_]+（表示名は未生成）/g, ""), M5_IDENTIFIER);

  for (const format of ["MATRIX", "FLOW"] as const) {
    const other = await projectSpecification(result.spec, catalog, context, { format, viewRole: "BUSINESS", displayId: "S-01" });
    assert.ok(!other.content.includes("src/r.ts"), format);
  }
});