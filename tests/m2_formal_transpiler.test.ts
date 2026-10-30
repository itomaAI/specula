// M2（FormalTranspiler）のテスト（M2 の設計 2〜5）。
// M1 をメモリの上の小さなソースにかけ、その RawContextModel を M2 に通した結果を確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractContext } from "../src/core/context_extractor.js";
import { transpileFormal } from "../src/core/formal_transpiler.js";
import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { withRoot } from "../src/lib/rooted_file_system.js";
import type { FileSystemPort } from "../src/ports/FileSystemPort.js";
import type { LanguageModelPort, OutputCheck } from "../src/ports/LanguageModelPort.js";
import type { RawContextModel } from "../src/types/context.js";
import type { FormalSpecification, Operation, TranspilerResult } from "../src/types/formal.js";
import { TranspileContractError } from "../src/types/formal.js";
import type { LlmRequest, LlmText } from "../src/types/index.js";
import type { ScenarioTarget } from "../src/types/scenario.js";

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

/** 頼まれた形で答える LLM。check を通らなければ INVALID_OUTPUT を返す（RecordingLanguageModel と同じ）。 */
class FakeLlm implements LanguageModelPort {
  readonly tasks: string[] = [];
  constructor(private readonly answer: (request: LlmRequest) => string) {}
  async generate(request: LlmRequest, check: OutputCheck): Promise<LlmText> {
    this.tasks.push(request.task);
    const text = this.answer(request);
    const result = check(text);
    return result.ok
      ? { status: "GENERATED", text, recordKey: `rk-${request.task}` }
      : { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: result.detail };
  }
}

/** 入力の items・issues のすべてに短い文を返す。 */
function politeAnswer(request: LlmRequest): string {
  const input = request.input as { items?: Array<{ id: string }>; issues?: Array<{ number: string }> };
  const out: Record<string, string> = {};
  for (const item of input.items ?? []) out[item.id] = `名前 ${item.id}`;
  for (const issue of input.issues ?? []) out[issue.number] = `質問 ${issue.number}`;
  return "```json\n" + JSON.stringify(out) + "\n```";
}

const NOT_GENERATED = { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" } as const;

function target(file: string, symbol: string, line = 1): ScenarioTarget {
  return {
    id: "SCN-1",
    boundedContext: "DEFAULT_CONTEXT",
    origin: "EXTRACTED",
    intent: NOT_GENERATED,
    intentStatus: "CANDIDATE",
    inletType: "COMMAND",
    inletTrigger: { id: "CMD-1", name: NOT_GENERATED, handler: { file, symbol, line } },
    actor: { id: "Caller", name: "Caller" },
    expectedEvent: "EVT-1",
  };
}

async function facts(source: string[], symbol: string): Promise<RawContextModel> {
  return extractContext(target("src/a.ts", symbol), { fs: new MemoryFs({ "src/a.ts": source.join("\n") }) });
}

function spec(result: TranspilerResult): FormalSpecification {
  if (result.kind !== "SPEC") assert.fail(`SPEC ではない: ${JSON.stringify(result.report.counts)}`);
  return result.spec;
}

const writing = (s: FormalSpecification): Operation[] => s.operations.filter((op) => op.steps.some((step) => step.kind === "WRITE"));

// ---------------------------------------------------------------------------

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

test("真偽値: Bool の変数・初期値・条件・書き込み・フレーム条件", async () => {
  const s = spec(await transpileFormal(await facts(BOOL_SOURCE, "openIt"), {}, null));
  assert.equal(s.stateVariables.length, 1);
  const v = s.stateVariables[0];
  assert.equal(v?.domain, "BOOL");
  assert.equal(v?.initial, "False");
  assert.deepEqual(v?.values, []);
  assert.equal(s.operations.length, 2);
  assert.equal(s.propositions.length, 0);

  const [write] = writing(s);
  assert.ok(write !== undefined, "書き込みのある操作がある");
  assert.deepEqual(
    write.steps.map((step) => (step.kind === "CONDITION" ? ["C", step.holds] : ["W", step.change])),
    [["C", false], ["W", { op: "SET", value: "True" }]],
  );
  const condition = write.steps[0];
  assert.ok(condition?.kind === "CONDITION");
  assert.deepEqual(condition.expr, { op: "IS", variable: "v1", value: "True" });

  assert.ok(s.source.includes("one sig System {"));
  assert.ok(s.source.includes("  var v1: one Bool"));
  assert.ok(s.source.includes("  System.v1 = False"), "Init に初期値");
  assert.ok(s.source.includes(`pred ${write.guardPredicate} {\n  (not (System.v1 = True))\n}`), "guard はプライムを含まない");
  assert.ok(s.source.includes(`  System.v1' = True\n  System.outcome' = ${write.outcome}`));
  const other = s.operations.find((op) => op !== write) as Operation;
  assert.ok(s.source.includes(`pred ${other.id} {\n  ${other.guardPredicate}\n  System.v1' = System.v1\n`), "フレーム条件");
  assert.ok(s.source.includes("always (op1 or op2 or stutter)"));
  assert.deepEqual(s.previousDiff, { status: "NOT_COMPUTED", reason: "FIRST_RUN" });
  for (const id of ["v1", "op1", "op2", "o1", "o2", "op1_guard"]) assert.ok(id in s.sourceMap, `${id} の sourceMap`);
});

test("列挙: 値の識別子は初期値 → 書き込みの順、比較は値ごとに評価する", async () => {
  const s = spec(
    await transpileFormal(
      await facts(
        [
          'let mode = "idle";',
          "export function start() {",
          '  if (mode === "running") {',
          '    throw new Error("busy");',
          "  }",
          '  mode = "running";',
          "  return 1;",
          "}",
        ],
        "start",
      ),
      {},
    ),
  );
  const v = s.stateVariables[0];
  assert.equal(v?.domain, "ENUM");
  assert.deepEqual(v?.values, ["v1_1", "v1_2"]);
  assert.deepEqual(v?.valueLiterals, { v1_1: '"idle"', v1_2: '"running"' });
  assert.equal(v?.initial, "v1_1");
  const [write] = writing(s);
  const condition = write?.steps[0];
  assert.ok(condition?.kind === "CONDITION");
  assert.deepEqual(condition.expr, { op: "OR", args: [{ op: "IS", variable: "v1", value: "v1_2" }] });
  assert.ok(s.source.includes("abstract sig V1 {}\n-- @source: "));
  assert.ok(s.source.includes("one sig v1_2 extends V1 {}"));
});

test("整数: 書き込みを経路の順に合成し、読めない比較は命題にする", async () => {
  const s = spec(
    await transpileFormal(
      await facts(
        [
          "let count = 0;",
          "export function inc(limit: number) {",
          "  if (limit < 0) {",
          "    return null;",
          "  }",
          "  if (count >= 3) {",
          "    return false;",
          "  }",
          "  count++;",
          "  count += 2;",
          "  return true;",
          "}",
        ],
        "inc",
      ),
      {},
    ),
  );
  const v = s.stateVariables[0];
  assert.equal(v?.domain, "INT");
  assert.equal(v?.initial, "0");
  assert.equal(s.propositions.length, 1);
  assert.equal(s.propositions[0]?.expression, "limit < 0");
  const [write] = writing(s);
  assert.ok(write !== undefined);
  const conditions = write.steps.flatMap((step) => (step.kind === "CONDITION" ? [step.expr] : []));
  assert.deepEqual(conditions, [
    { op: "PROP", prop: "c1" },
    { op: "CMP", variable: "v1", cmp: "gte", value: 3 },
  ]);
  assert.ok(s.source.includes("System.v1' = plus[plus[System.v1, 1], 2]"));
  assert.ok(s.source.includes("(System.v1 >= 3)"));
  assert.ok(s.source.includes("one sig c1 extends Prop {}"));
});

test("for…of と catch の条件は式全体を命題にし、枝の中の書き込みには条件が付く", async () => {
  const s = spec(
    await transpileFormal(
      await facts(
        [
          "let done = false;",
          "export function run(items: string[]) {",
          "  for (const item of items) {",
          '    if (item === "x") {',
          "      done = true;",
          "    }",
          "  }",
          "  try {",
          "    return load();",
          "  } catch {",
          "    return null;",
          "  }",
          "}",
        ],
        "run",
      ),
      {},
    ),
  );
  assert.ok(s.propositions.some((p) => p.expression === "catch"), JSON.stringify(s.propositions));
  assert.ok(s.propositions.some((p) => p.expression === 'item === "x"'), JSON.stringify(s.propositions));
  const writes = s.operations.flatMap((op) => op.steps.flatMap((step) => (step.kind === "WRITE" ? [step] : [])));
  assert.ok(writes.length >= 1);
  for (const write of writes) assert.ok(write.when.length > 0, "枝の中の書き込みには条件");
  assert.ok(s.source.includes("=> True else System.v1)"));
});

test("書き込みの条件: 経路に出た条件は when に入れず、枝の条件は枝の最初の書き込みの前の値で評価する", async () => {
  const s = spec(
    await transpileFormal(
      await facts(
        [
          "let count = 0;",
          "export function bump() {",
          "  if (count >= 5) {",
          "    return false;",
          "  }",
          "  if (count < 3) {",
          "    count++;",
          "    count++;",
          "  }",
          "  return true;",
          "}",
        ],
        "bump",
      ),
      {},
    ),
  );
  const [write] = writing(s);
  assert.ok(write !== undefined);
  const whens = write.steps.flatMap((step) => (step.kind === "WRITE" ? [step.when.map((term) => term.holds)] : []));
  // count >= 5 の偽の側は経路の CONDITION にあるので when に入らない。count < 3 の真の側だけが残る。
  assert.deepEqual(whens, [[true], [true]]);
  const once = "((System.v1 < 3) => plus[System.v1, 1] else System.v1)";
  assert.ok(s.source.includes(`System.v1' = ((System.v1 < 3) => plus[${once}, 1] else ${once})`), s.source);
  assert.ok(!s.source.includes("plus[System.v1, 1] < 3"), "2 度目の条件を 1 度目の書き込みの後の値で評価しない");
});

const AMBIGUOUS_SOURCE = [
  'let state = "a";',
  "export function go(x: number) {",
  "  state = compute(x);",
  "  save(state);",
  "  state.trim();",
  "  log(x);",
  "  return 1;",
  "}",
];

test("曖昧性: UNDETERMINED_VALUE と EXTERNAL_EFFECT（引数と受け手）をすべて集め、ソースは作らない", async () => {
  const result = await transpileFormal(await facts(AMBIGUOUS_SOURCE, "go"), {});
  assert.equal(result.kind, "AMBIGUITY");
  if (result.kind !== "AMBIGUITY") return;
  const { report } = result;
  assert.equal(report.counts.UNDETERMINED_VALUE, 1);
  assert.equal(report.counts.EXTERNAL_EFFECT, 2, JSON.stringify(report.issues.map((i) => i.detail)));
  assert.equal(report.counts.CONFLICTING_SLICES, 0);
  assert.deepEqual(
    report.issues.map((issue) => [issue.kind, issue.detail]),
    [
      ["UNDETERMINED_VALUE", "state = compute(x)"],
      ["EXTERNAL_EFFECT", "save(state)"],
      ["EXTERNAL_EFFECT", "state.trim()"],
    ],
  );
  for (const issue of report.issues) assert.deepEqual(issue.question, { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "LLM のポートが渡されていない" });

  const llm = new FakeLlm(politeAnswer);
  const asked = await transpileFormal(await facts(AMBIGUOUS_SOURCE, "go"), { llm });
  assert.deepEqual(llm.tasks, ["m2.ambiguity-question"], "質問の文はレポートごとに 1 回");
  assert.ok(asked.kind === "AMBIGUITY");
  assert.deepEqual(asked.report.issues[1]?.question, { status: "GENERATED", text: "質問 2", recordKey: "rk-m2.ambiguity-question" });
});

const PURE_CALL_SOURCE = [
  'let state = "a";',
  "export function go(xs: string[]) {",
  '  state = "b";',
  "  xs.map((x) => x.trim());",
  "  xs.map((x) => String(x).trim());",
  '  xs.map((x) => x.trim()).join(",");',
  "  xs.map(toItem);",
  "  Object.keys(xs);",
  "  xs.map((x) => x + state);",
  "  xs.forEach((x) => save(x));",
  "  xs.map((x) => new Date(x));",
  '  state.split(",");',
  "  xs.filter(function (x) { return this.ok; });",
  "  return 1;",
  "}",
];

test("曖昧性: 状態を変えない組み込みのメソッドは、渡した関数の本体と受け手の参照で判定する", async () => {
  const result = await transpileFormal(await facts(PURE_CALL_SOURCE, "go"), {});
  assert.equal(result.kind, "AMBIGUITY");
  if (result.kind !== "AMBIGUITY") return;
  const { report } = result;
  assert.equal(report.counts.UNDETERMINED_VALUE, 0);
  assert.equal(report.counts.CONFLICTING_SLICES, 0);
  // 当たらないもの: ローカルの配列へのアロー関数つきの map、組み込みだけを呼ぶ本体、受け手の中の関数（join）、名前で渡した関数、Object.keys
  // 当たるもの: 本体が状態を参照する、本体が組み込みでない関数や new を呼ぶ、受け手が状態、本体が this を参照する
  assert.deepEqual(
    report.issues.map((issue) => [issue.kind, issue.detail]),
    [
      ["EXTERNAL_EFFECT", "xs.map((x) => x + state)"],
      ["EXTERNAL_EFFECT", "xs.forEach((x) => save(x))"],
      ["EXTERNAL_EFFECT", "xs.map((x) => new Date(x))"],
      ["EXTERNAL_EFFECT", 'state.split(",")'],
      ["EXTERNAL_EFFECT", "xs.filter(function (x) { return this.ok; })"],
    ],
  );
});

test("曖昧性: 条件の組が同じで出口が違うスライスは CONFLICTING_SLICES", async () => {
  const model = await facts(BOOL_SOURCE, "openIt");
  const [first, second] = model.slices;
  assert.ok(first !== undefined && second !== undefined);
  const forged: RawContextModel = { ...model, slices: [first, { ...second, conditions: first.conditions }] };
  const result = await transpileFormal(forged, {});
  assert.ok(result.kind === "AMBIGUITY");
  assert.equal(result.report.counts.CONFLICTING_SLICES, 1);
  const issue = result.report.issues.find((i) => i.kind === "CONFLICTING_SLICES");
  assert.deepEqual([...(issue?.unitIds ?? [])].sort(), [first.outlet.unitId, second.outlet.unitId].sort());
});

test("M1 の契約違反は TranspileContractError", async () => {
  const model = await facts(BOOL_SOURCE, "openIt");
  const reasonOf = async (broken: RawContextModel): Promise<string> => {
    try {
      await transpileFormal(broken, {});
    } catch (error) {
      assert.ok(error instanceof TranspileContractError);
      return error.reason;
    }
    return "no error";
  };
  assert.equal(await reasonOf({ ...model, slices: [] }), "NO_SLICES");
  const [first] = model.slices;
  assert.ok(first !== undefined);
  assert.equal(await reasonOf({ ...model, slices: [{ ...first, unitIds: [...first.unitIds, "nowhere"] }] }), "UNKNOWN_UNIT");
  const units = model.units.map((unit) => (unit.kind === "STATE_WRITE" ? { ...unit, details: { ...unit.details, expression: "" } } : unit));
  assert.equal(await reasonOf({ ...model, units }), "WRITE_WITHOUT_EXPRESSION");
});

test("表示名: 1 回で全部の識別子に付く。形が合わなければ全部 NOT_GENERATED、ソースは LLM によらない", async () => {
  const model = await facts(BOOL_SOURCE, "openIt");
  const llm = new FakeLlm(politeAnswer);
  const named = spec(await transpileFormal(model, { llm }));
  assert.deepEqual(llm.tasks, ["m2.label-vocabulary"]);
  for (const id of ["v1", "op1", "op2", "o1", "o2"]) {
    assert.deepEqual(named.labels[id], { status: "GENERATED", text: `名前 ${id}`, recordKey: "rk-m2.label-vocabulary" });
  }

  const tooLong = new FakeLlm(() => JSON.stringify({ v1: "あ".repeat(41) }));
  const broken = spec(await transpileFormal(model, { llm: tooLong }));
  for (const label of Object.values(broken.labels)) assert.equal(label.status === "NOT_GENERATED" && label.reason, "INVALID_OUTPUT");

  const none = spec(await transpileFormal(model, {}));
  assert.equal(none.source, named.source);
  assert.equal(none.source, broken.source);
  assert.deepEqual(none.sourceMap, named.sourceMap);
});

test("同じ入力からは 1 バイトも違わないソースが出る", async () => {
  const first = spec(await transpileFormal(await facts(BOOL_SOURCE, "openIt"), {}));
  const second = spec(await transpileFormal(await facts(BOOL_SOURCE, "openIt"), {}));
  assert.equal(first.source, second.source);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const again = spec(await transpileFormal(await facts(BOOL_SOURCE, "openIt"), {}, first));
  assert.deepEqual(again.previousDiff, { status: "NOT_COMPUTED", reason: "OUT_OF_SCOPE" });
});

test("specula 自身の公開関数を M1 → M2 に通すと、例外なしで SPEC か AMBIGUITY が返る", async () => {
  const fs = withRoot(new NodeFsAdapter(), process.cwd());
  const inlets: Array<[string, string]> = [
    ["src/core/scenario_extractor.ts", "discoverSystemContext"],
    ["src/core/scenario_extractor.ts", "sliceScenarios"],
    ["src/core/context_extractor.ts", "extractContext"],
  ];
  for (const [file, symbol] of inlets) {
    const model = await extractContext(target(file, symbol), { fs });
    const result = await transpileFormal(model, {});
    assert.ok(result.kind === "SPEC" || result.kind === "AMBIGUITY");
    const summary =
      result.kind === "SPEC"
        ? { kind: "SPEC", states: result.spec.stateVariables.length, operations: result.spec.operations.length }
        : { kind: "AMBIGUITY", counts: result.report.counts };
    console.log(`# m2-self ${file}#${symbol} slices=${model.slices.length} ${JSON.stringify(summary)}`);
  }
});