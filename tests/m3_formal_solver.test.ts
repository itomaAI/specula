// M3（FormalSolver）のテスト（M3 の設計 2・4）。エンジンは偽の SolverPort に置き換える。
// 本物の Alloy 6 での確かめは tests/m3_alloy_integration.test.ts（ALLOY_JAR があるときだけ走る）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractContext } from "../src/core/context_extractor.js";
import { transpileFormal } from "../src/core/formal_transpiler.js";
import { verifySpecification } from "../src/core/formal_solver.js";
import type { FileSystemPort } from "../src/ports/FileSystemPort.js";
import type { EngineInfo, RawInstance, SolverPort, SolverRequest, SolverResponse } from "../src/ports/SolverPort.js";
import type { FormalSpecification } from "../src/types/formal.js";
import type { CommandTarget } from "../src/types/command.js";
import { SolverContractError } from "../src/types/solver.js";

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

function target(file: string, symbol: string): CommandTarget {
  return {
    id: "CT-1",
    boundedContext: "DEFAULT_CONTEXT",
    origin: "EXTRACTED",
    inletTrigger: { id: "CMD-1", handler: { file, symbol, line: 1 } },
    actor: { id: "Caller", name: "Caller" },
    expectedEvents: ["EVT-1"],
    invokedBy: [],
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

async function boolSpec(): Promise<FormalSpecification> {
  const facts = await extractContext(target("src/a.ts", "openIt"), { fs: new MemoryFs({ "src/a.ts": BOOL_SOURCE.join("\n") }) });
  const result = await transpileFormal(facts, {});
  if (result.kind !== "SPEC") assert.fail("SPEC ではない");
  return result.spec;
}

const ENGINE: EngineInfo = { alloyVersion: "6.test", satSolver: "sat4j", satSolverVersion: null };

/** コマンドとステップ数で答えを決める偽のエンジン。決めていない呼び出しは UNSAT。 */
class ScriptedSolver implements SolverPort {
  readonly requests: SolverRequest[] = [];
  constructor(private readonly answer: (request: SolverRequest) => SolverResponse | undefined = () => undefined) {}
  async run(request: SolverRequest): Promise<SolverResponse> {
    this.requests.push(request);
    return this.answer(request) ?? { kind: "UNSAT", engine: ENGINE };
  }
  countFor(command: string): number {
    return this.requests.filter((request) => request.command === command).length;
  }
}

function state(v1: string, outcome: string, holds: string[] = []): Record<string, string[][]> {
  return { "System.outcome": [[`${outcome}$0`]], "System.v1": [[`${v1}$0`]], "Env.holds": holds.map((h) => [`${h}$0`]) };
}

function sat(...states: Array<Record<string, string[][]>>): SolverResponse {
  const instance: RawInstance = { states, loopBack: states.length - 1 };
  return { kind: "SAT", engine: ENGINE, instance };
}

// ---------------------------------------------------------------------------

test("検査の一覧: COVER → OVERLAP → REACH の順で、各検査をステップ数 1 から上限まで呼ぶ", async () => {
  const spec = await boolSpec();
  const solver = new ScriptedSolver();
  const report = await verifySpecification(spec, { solver }, { maxSteps: 3 });

  assert.equal(report.status, "CHECKED");
  assert.equal(report.reason, null);
  assert.deepEqual(
    report.checks.map((check) => [check.id, check.kind, check.result, check.exhaustive]),
    [
      ["m3_cover", "COVER", "NOT_FOUND_WITHIN_SCOPE", false],
      ["m3_overlap_op1_op2", "OVERLAP", "NOT_FOUND_WITHIN_SCOPE", true],
      ["m3_reach_op1", "REACH", "NOT_FOUND_WITHIN_SCOPE", true],
      ["m3_reach_op2", "REACH", "NOT_FOUND_WITHIN_SCOPE", true],
    ],
  );
  assert.deepEqual(solver.requests.map((request) => request.steps).slice(0, 3), [1, 2, 3]);
  assert.equal(solver.requests.length, 4 * 3);
  // REACH が見つからなければ到達不能（実行列は無い）。
  assert.deepEqual(
    report.findings.map((finding) => [finding.kind, finding.operations, finding.trace]),
    [
      ["UNREACHABLE_OPERATION", ["op1"], null],
      ["UNREACHABLE_OPERATION", ["op2"], null],
    ],
  );
  assert.deepEqual(report.unexecutedChecks, []);
  assert.deepEqual(report.invariantChecks, { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" });
  assert.deepEqual(report.conditions, {
    engine: ENGINE,
    scope: 3,
    bitwidth: 4,
    maxSteps: 3,
    preventOverflow: true,
    timeoutMs: 60000,
    partitioning: "NONE",
  });
});

test("コマンド: M2 のソースを書き換えず、後ろにコマンドを 1 つだけ足す", async () => {
  const spec = await boolSpec();
  const solver = new ScriptedSolver();
  await verifySpecification(spec, { solver }, { maxSteps: 2, bitwidth: 5 });
  const first = solver.requests[0] as SolverRequest;
  assert.ok(first.source.startsWith(spec.source.replace(/\n*$/, "")));
  assert.ok(first.source.endsWith("check m3_cover {\n  always (op1_guard or op2_guard)\n} for 3 but 5 Int, 1..1 steps\n"));
  assert.equal(first.preventOverflow, true);
  assert.equal(first.bitwidth, 5);
  const overlap = solver.requests.find((request) => request.command === "m3_overlap_op1_op2" && request.steps === 2) as SolverRequest;
  assert.ok(overlap.source.endsWith("check m3_overlap_op1_op2 {\n  always not (op1_guard and op2_guard)\n} for 3 but 5 Int, 1..2 steps\n"));
  const reach = solver.requests.find((request) => request.command === "m3_reach_op2") as SolverRequest;
  assert.ok(reach.source.includes("run m3_reach_op2 {\n  eventually op2\n}"));
  for (const request of solver.requests) assert.equal(request.source.match(/^(check|run) /gm)?.length, 1, "コマンドは 1 つだけ");
});

test("最短: 最初に見つかったステップ数で止め、その長さを記録する", async () => {
  const spec = await boolSpec();
  const solver = new ScriptedSolver((request) =>
    request.command === "m3_reach_op2" && request.steps >= 2 ? sat(state("False", "Idle"), state("True", "o2")) : undefined,
  );
  const report = await verifySpecification(spec, { solver }, { maxSteps: 5 });
  const reach = report.checks.find((check) => check.id === "m3_reach_op2");
  assert.equal(reach?.result, "FOUND");
  assert.equal(reach?.steps, 2);
  assert.equal(solver.countFor("m3_reach_op2"), 2);
  assert.ok(!report.findings.some((finding) => finding.checkId === "m3_reach_op2"), "到達できる操作は見つかったものに入れない");
});

test("COVER の反例: 最後の時点の状態から ESCAPE を作り、抜け出せなければ DEADLOCK", async () => {
  const spec = await boolSpec();
  const solver = new ScriptedSolver((request) =>
    request.command === "m3_cover" && request.steps >= 2 ? sat(state("False", "Idle"), state("True", "o2")) : undefined,
  );
  const report = await verifySpecification(spec, { solver }, { maxSteps: 3 });
  assert.equal(report.status, "CHECKED");
  assert.deepEqual(
    report.checks.map((check) => check.id),
    ["m3_cover", "m3_overlap_op1_op2", "m3_reach_op1", "m3_reach_op2", "m3_escape_1"],
  );
  const escape = solver.requests.find((request) => request.command === "m3_escape_1") as SolverRequest;
  assert.ok(escape.source.includes("run m3_escape_1 {\n  eventually (System.v1 = True and (op1_guard or op2_guard))\n}"));

  const unhandled = report.findings.find((finding) => finding.kind === "UNHANDLED_TRANSITION");
  assert.deepEqual(unhandled?.trace, [
    { index: 0, values: { v1: "False" }, outcome: "Idle", holds: [] },
    { index: 1, values: { v1: "True" }, outcome: "o2", holds: [] },
  ]);
  assert.deepEqual(unhandled?.operations, ["op1", "op2"]);
  const deadlock = report.findings.find((finding) => finding.kind === "DEADLOCK");
  assert.equal(deadlock?.checkId, "m3_escape_1");
  assert.deepEqual(deadlock?.trace, unhandled?.trace, "DEADLOCK の実行列は COVER の反例");
  // 並びは検査の順。
  assert.deepEqual(
    report.findings.map((finding) => finding.checkId),
    ["m3_cover", "m3_reach_op1", "m3_reach_op2", "m3_escape_1"],
  );
});

test("未検証: 途中で届かなくなったら止め、それまでの見つかったものは残す", async () => {
  const spec = await boolSpec();
  const solver = new ScriptedSolver((request) => {
    if (request.command === "m3_cover") return sat(state("False", "Idle"));
    if (request.command === "m3_overlap_op1_op2") return { kind: "UNREACHABLE", detail: "bridge down" };
    return undefined;
  });
  const report = await verifySpecification(spec, { solver }, { maxSteps: 2 });
  assert.equal(report.status, "UNVERIFIED");
  assert.deepEqual(report.reason, { kind: "UNREACHABLE", detail: "bridge down" });
  assert.deepEqual(report.checks.map((check) => check.id), ["m3_cover"]);
  assert.deepEqual(report.unexecutedChecks, ["m3_overlap_op1_op2", "m3_reach_op1", "m3_reach_op2", "m3_escape_1"]);
  assert.deepEqual(report.findings.map((finding) => finding.kind), ["UNHANDLED_TRANSITION"]);
});

test("未検証: アダプターが無ければ検査をせずに NO_SOLVER", async () => {
  const spec = await boolSpec();
  const report = await verifySpecification(spec, { solver: null });
  assert.equal(report.status, "UNVERIFIED");
  assert.equal(report.reason?.kind, "NO_SOLVER");
  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.unexecutedChecks, ["m3_cover", "m3_overlap_op1_op2", "m3_reach_op1", "m3_reach_op2"]);
  assert.equal(report.conditions.engine, null);
  assert.deepEqual(report.findings, []);
});

test("未検証: 実例の形が想定と違えば ENGINE_ERROR、時間切れは TIMEOUT", async () => {
  const spec = await boolSpec();
  const broken = await verifySpecification(
    spec,
    { solver: new ScriptedSolver((request) => (request.command === "m3_cover" ? sat({ "System.outcome": [["Idle$0"]] }) : undefined)) },
    { maxSteps: 1 },
  );
  assert.equal(broken.status, "UNVERIFIED");
  assert.equal(broken.reason?.kind, "ENGINE_ERROR");
  assert.deepEqual(broken.checks, []);
  assert.equal(broken.unexecutedChecks[0], "m3_cover");

  const slow = await verifySpecification(
    spec,
    { solver: new ScriptedSolver((request) => (request.command === "m3_reach_op1" ? { kind: "TIMEOUT", engine: ENGINE } : undefined)) },
    { maxSteps: 1, timeoutMs: 10 },
  );
  assert.equal(slow.reason?.kind, "TIMEOUT");
  assert.deepEqual(slow.unexecutedChecks, ["m3_reach_op1", "m3_reach_op2"]);
});

test("reportId: 同じ仕様と同じ条件なら同じ、条件が違えば違う", async () => {
  const spec = await boolSpec();
  const a = await verifySpecification(spec, { solver: new ScriptedSolver() }, { maxSteps: 2 });
  const b = await verifySpecification(spec, { solver: new ScriptedSolver() }, { maxSteps: 2 });
  const c = await verifySpecification(spec, { solver: new ScriptedSolver() }, { maxSteps: 3 });
  assert.match(a.reportId, /^[0-9a-f]{64}$/);
  assert.equal(a.reportId, b.reportId);
  assert.notEqual(a.reportId, c.reportId);
  assert.equal(a.specSourceHash, c.specSourceHash);
});

test("契約: 操作が無い・識別子が Alloy の形でない・述語がソースに無いときは SolverContractError", async () => {
  const spec = await boolSpec();
  const reasonOf = async (broken: FormalSpecification): Promise<string> => {
    try {
      await verifySpecification(broken, { solver: new ScriptedSolver() });
    } catch (error) {
      assert.ok(error instanceof SolverContractError);
      return error.reason;
    }
    return assert.fail("例外にならなかった");
  };
  assert.equal(await reasonOf({ ...spec, operations: [] }), "NO_OPERATIONS");
  const [first, ...rest] = spec.operations;
  assert.ok(first !== undefined);
  assert.equal(await reasonOf({ ...spec, operations: [{ ...first, guardPredicate: "op1_guard } run x {" }, ...rest] }), "INVALID_IDENTIFIER");
  assert.equal(await reasonOf({ ...spec, operations: [{ ...first, guardPredicate: "op9_guard" }, ...rest] }), "MISSING_GUARD_PREDICATE");
  assert.equal(
    await reasonOf({ ...spec, stateVariables: spec.stateVariables.map((variable) => ({ ...variable, id: "v7" })) }),
    "MISSING_STATE_VARIABLE",
  );
});