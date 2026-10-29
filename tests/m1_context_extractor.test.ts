// M1（ContextExtractor）のテスト（M1 の設計 2〜4、仕様 01 の 3）。
// メモリの上の FileSystemPort に小さなソースを置き、起点から呼び出しをたどった結果を確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractContext } from "../src/core/context_extractor.js";
import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { withRoot } from "../src/lib/rooted_file_system.js";
import type { FileSystemPort } from "../src/ports/FileSystemPort.js";
import { InletNotFoundError, SyntaxExtractionError, type RawContextModel } from "../src/types/context.js";
import type { ScenarioTarget } from "../src/types/scenario.js";

class MemoryFs implements FileSystemPort {
  readonly reads: string[] = [];
  constructor(private readonly files: Record<string, string>) {}
  async read(path: string): Promise<string> {
    this.reads.push(path);
    const text = this.files[path];
    if (text === undefined) throw new Error(`no such file: ${path}`);
    return text;
  }
  async write(): Promise<void> {
    throw new Error("M1 は書かない");
  }
  async exists(path: string): Promise<boolean> {
    return path in this.files || Object.keys(this.files).some((key) => key.startsWith(`${path}/`));
  }
  async list(): Promise<string[]> {
    return [];
  }
}

const NOT_GENERATED = { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" } as const;

function target(file: string, symbol: string, line = 1, inletType: "COMMAND" | "POLICY" = "COMMAND"): ScenarioTarget {
  return {
    id: "SCN-1",
    boundedContext: "DEFAULT_CONTEXT",
    origin: "EXTRACTED",
    intent: NOT_GENERATED,
    intentStatus: "CANDIDATE",
    inletType,
    inletTrigger: { id: "CMD-1", name: NOT_GENERATED, handler: { file, symbol, line } },
    actor: { id: "Caller", name: "Caller" },
    expectedEvent: "EVT-1",
  };
}

/** どのテストでも成り立つこと: スライスが参照するユニットはすべてあり、出口は経路の最後にある。 */
function checkInvariants(model: RawContextModel): void {
  const ids = new Set(model.units.map((unit) => unit.id));
  assert.equal(ids.size, model.units.length, "ユニットの識別子は重ならない");
  for (const slice of model.slices) {
    for (const id of slice.unitIds) assert.ok(ids.has(id), `${slice.sliceId} の ${id} がユニットにある`);
    for (const id of slice.writes) assert.ok(slice.unitIds.includes(id), `書き込み ${id} は経路にある`);
    for (const condition of slice.conditions) assert.ok(slice.unitIds.includes(condition.unitId));
    assert.equal(slice.unitIds[slice.unitIds.length - 1], slice.outlet.unitId, "出口は経路の最後");
  }
  assert.equal(new Set(model.slices.map((slice) => slice.sliceId)).size, model.slices.length, "スライスの識別子は重ならない");
}

const conditionsOf = (model: RawContextModel): Array<Array<[string, boolean]>> =>
  model.slices.map((slice) => slice.conditions.map((c) => [c.expression, c.holds] as [string, boolean]));

// ---------------------------------------------------------------------------

test("ガード節: 出口ごとに 1 つのスライスになり、続く経路には逆の条件が付く", async () => {
  const fs = new MemoryFs({
    "src/a.ts": [
      "export function run(x: number) {",
      "  if (x < 0) {",
      '    throw new Error("neg");',
      "  }",
      "  return x * 2;",
      "}",
    ].join("\n"),
  });
  const model = await extractContext(target("src/a.ts", "run"), { fs });
  checkInvariants(model);
  assert.deepEqual(
    model.slices.map((slice) => [slice.sliceId, slice.outlet.kind]),
    [
      ["SCN-1#src/a.ts:3:5:THROW", "THROW"],
      ["SCN-1#src/a.ts:5:3:RETURN", "RETURN"],
    ],
  );
  assert.deepEqual(conditionsOf(model), [[["x < 0", true]], [["x < 0", false]]]);
  assert.deepEqual(model.slices[0]?.unitIds, [
    "src/a.ts:2:7:BRANCH_CONDITION",
    "src/a.ts:3:15:EXTERNAL_CALL",
    "src/a.ts:3:5:THROW",
  ]);
  assert.deepEqual(model.unresolved, [
    { unitId: "src/a.ts:3:15:EXTERNAL_CALL", location: { file: "src/a.ts", line: 3, column: 15 }, reason: "CONSTRUCTOR" },
  ]);
  assert.deepEqual(model.inlet, { kind: "COMMAND", handler: { file: "src/a.ts", symbol: "run", line: 1 } });
});

test("ときどき出口に至る枝: 出口の経路だけを分け、続く経路には条件を足さない", async () => {
  const fs = new MemoryFs({
    "src/a.ts": [
      "export function run(a: boolean, b: boolean) {",
      "  if (a) {",
      "    if (b) {",
      "      return 1;",
      "    }",
      "  }",
      "  return 2;",
      "}",
    ].join("\n"),
  });
  const model = await extractContext(target("src/a.ts", "run"), { fs });
  checkInvariants(model);
  assert.equal(model.slices.length, 2);
  assert.deepEqual(conditionsOf(model), [[["a", true], ["b", true]], []]);
});

test("出口に至らない枝の書き込みには guard が付き、最上位の let は状態になる", async () => {
  const fs = new MemoryFs({
    "src/a.ts": [
      "let count = 0;",
      "export function bump(flag: boolean) {",
      "  if (flag) {",
      "    count++;",
      "  }",
      "  return count;",
      "}",
    ].join("\n"),
  });
  const model = await extractContext(target("src/a.ts", "bump"), { fs });
  checkInvariants(model);
  const state = model.units.find((unit) => unit.kind === "STATE");
  assert.deepEqual(state, {
    id: "src/a.ts:1:5:STATE",
    kind: "STATE",
    name: "count",
    layer: "LOGIC",
    location: { file: "src/a.ts", line: 1, column: 5 },
    componentScope: "bump",
    details: { initial: "0", scope: "MODULE", owner: null },
  });
  const write = model.units.find((unit) => unit.kind === "STATE_WRITE");
  assert.deepEqual(write?.details, {
    target: "src/a.ts:1:5:STATE",
    expression: "count++",
    guard: "flag",
    guardHolds: true,
    guardTerms: JSON.stringify([{ unitId: "src/a.ts:3:7:BRANCH_CONDITION", holds: true }]),
  });
  assert.ok(model.units.some((unit) => unit.id === "src/a.ts:3:7:BRANCH_CONDITION"), "guardTerms の識別子は条件のユニットにある");
  assert.equal(model.slices.length, 1);
  assert.deepEqual(model.slices[0]?.conditions, []);
  assert.deepEqual(model.slices[0]?.writes, ["src/a.ts:4:5:STATE_WRITE"]);
});

test("switch: case ごとに条件の式を作り、default はほかの case のどれでもないこと", async () => {
  const fs = new MemoryFs({
    "src/a.ts": [
      "export function kind(k: string) {",
      "  switch (k) {",
      '    case "a":',
      "      return 1;",
      "    default:",
      "      return 0;",
      "  }",
      "}",
    ].join("\n"),
  });
  const model = await extractContext(target("src/a.ts", "kind"), { fs });
  checkInvariants(model);
  assert.deepEqual(conditionsOf(model), [[['k === "a"', true]], [['k !== "a"', true]]]);
  assert.ok(!model.units.some((unit) => unit.kind === "RETURN" && unit.details?.["implicit"] === true), "暗黙の return は無い");
});

const THROWING = {
  "src/b.ts": [
    "export function check(v: number) {",
    "  if (v > 10) {",
    '    throw new Error("big");',
    "  }",
    "}",
  ].join("\n"),
  "src/a.ts": [
    'import { check } from "./b.js";',
    "export function guarded(v: number) {",
    "  try {",
    "    check(v);",
    "  } catch (e) {",
    '    return "caught";',
    "  }",
    '  return "ok";',
    "}",
    "export function unguarded(v: number) {",
    "  check(v);",
    '  return "ok";',
    "}",
  ].join("\n"),
};

test("呼ばれた関数の throw: catch されなければ呼び出した側の出口になる", async () => {
  const model = await extractContext(target("src/a.ts", "unguarded", 10), { fs: new MemoryFs(THROWING) });
  checkInvariants(model);
  assert.deepEqual(
    model.slices.map((slice) => [slice.sliceId, slice.outlet.kind]),
    [
      ["SCN-1#src/a.ts:12:3:RETURN", "RETURN"],
      ["SCN-1#src/a.ts:11:3:CALL>src/b.ts:3:5:THROW", "THROW"],
    ],
  );
  assert.deepEqual(conditionsOf(model), [[], [["v > 10", true]]]);
  const call = model.units.find((unit) => unit.kind === "CALL");
  assert.equal(call?.details?.["target"], "src/b.ts#check");
});

test("呼ばれた関数の throw: catch のある try の中なら出口にならず、catch の枝がスライスになる", async () => {
  const model = await extractContext(target("src/a.ts", "guarded", 2), { fs: new MemoryFs(THROWING) });
  checkInvariants(model);
  assert.deepEqual(
    model.slices.map((slice) => slice.outlet.kind),
    ["RETURN", "RETURN"],
  );
  assert.deepEqual(conditionsOf(model), [[["catch", true]], []]);
  const catchUnit = model.units.find((unit) => unit.kind === "BRANCH_CONDITION" && unit.name === "catch");
  assert.equal(catchUnit?.details?.["branch"], "CATCH");
});

test("再帰の呼び出しは RECURSION として記録して止まる", async () => {
  const fs = new MemoryFs({
    "src/a.ts": [
      "export function fact(n: number): number {",
      "  if (n <= 1) {",
      "    return 1;",
      "  }",
      "  return n * fact(n - 1);",
      "}",
    ].join("\n"),
  });
  const model = await extractContext(target("src/a.ts", "fact"), { fs });
  checkInvariants(model);
  assert.equal(model.slices.length, 2);
  assert.deepEqual(
    model.unresolved.map((item) => [item.unitId, item.reason]),
    [["src/a.ts:5:14:RECURSION", "RECURSION"]],
  );
});

test("追跡しなかった呼び出しは理由つきで全部残り、コールバックの中には入らない", async () => {
  const fs = new MemoryFs({
    "src/a.ts": [
      'import { readFile } from "node:fs/promises";',
      "export async function load(p: string, items: string[]) {",
      '  const text = await readFile(p, "utf8");',
      "  const parts = items.map((x) => x.trim());",
      '  return text + parts.join(",");',
      "}",
    ].join("\n"),
  });
  const model = await extractContext(target("src/a.ts", "load"), { fs });
  checkInvariants(model);
  assert.deepEqual(
    model.unresolved.map((item) => item.reason),
    ["PACKAGE", "METHOD", "METHOD"],
  );
  const map = model.units.find((unit) => unit.name === "items.map");
  assert.deepEqual(map?.details, { callee: "items.map", args: JSON.stringify(["(x) => x.trim()"]), receiver: "items", reason: "METHOD" });
  assert.ok(!model.units.some((unit) => unit.name === "x.trim"), "コールバックの中の呼び出しは記録しない");
  assert.deepEqual(fs.reads, ["src/a.ts"], "パッケージのファイルは読まない");
});

test("POLICY: リスナーの登録の行から、渡された関数をたどる", async () => {
  const fs = new MemoryFs({
    "src/listen.ts": [
      'import { onSaved } from "./handlers.js";',
      "export function setup(bus: { on(n: string, f: unknown): void }) {",
      '  bus.on("saved", onSaved);',
      "}",
    ].join("\n"),
    "src/handlers.ts": ["export function onSaved() {", "  return true;", "}"].join("\n"),
  });
  const model = await extractContext(target("src/listen.ts", "setup", 3, "POLICY"), { fs });
  checkInvariants(model);
  assert.deepEqual(model.inlet, { kind: "POLICY", handler: { file: "src/handlers.ts", symbol: "onSaved", line: 1 } });
  assert.deepEqual(model.slices.map((slice) => slice.sliceId), ["SCN-1#src/handlers.ts:2:3:RETURN"]);
});

test("クラスのメソッドを起点にでき、this のフィールドは状態になる", async () => {
  const fs = new MemoryFs({
    "src/a.ts": [
      "export class Counter {",
      "  value = 0;",
      "  inc() {",
      "    this.value += 1;",
      "    return this.value;",
      "  }",
      "}",
    ].join("\n"),
  });
  const model = await extractContext(target("src/a.ts", "Counter.inc"), { fs });
  checkInvariants(model);
  assert.deepEqual(
    model.units.filter((unit) => unit.kind === "STATE" || unit.kind === "STATE_WRITE").map((unit) => [unit.id, unit.name]),
    [
      ["src/a.ts:4:5:STATE", "this.value"],
      ["src/a.ts:4:5:STATE_WRITE", "this.value"],
    ],
  );
  const write = model.units.find((unit) => unit.kind === "STATE_WRITE");
  assert.equal(write?.details?.["expression"], "this.value += 1");
  assert.equal(write?.details?.["guard"], null);
  assert.equal(write?.details?.["guardTerms"], "[]");
  const state = model.units.find((unit) => unit.kind === "STATE");
  assert.equal(state?.componentScope, "Counter.inc");
  assert.deepEqual(state?.details, { initial: null, scope: "CLASS", owner: "Counter" });
});

test("書き込みの guardTerms には、枝を戻すときに落ちる経路の条件も入る", async () => {
  const fs = new MemoryFs({
    "src/a.ts": [
      "let x = 0;",
      "export function run(a: boolean, b: boolean) {",
      "  if (a) {",
      "    if (b) {",
      "      return 1;",
      "    }",
      "    x = 1;",
      "  }",
      "  return x;",
      "}",
    ].join("\n"),
  });
  const model = await extractContext(target("src/a.ts", "run"), { fs });
  checkInvariants(model);
  const write = model.units.find((unit) => unit.kind === "STATE_WRITE");
  assert.equal(write?.id, "src/a.ts:7:5:STATE_WRITE");
  assert.equal(write?.details?.["guard"], "(a) && !(b)");
  assert.equal(
    write?.details?.["guardTerms"],
    JSON.stringify([
      { unitId: "src/a.ts:3:7:BRANCH_CONDITION", holds: true },
      { unitId: "src/a.ts:4:9:BRANCH_CONDITION", holds: false },
    ]),
  );
});

test("起点が無ければ InletNotFoundError、構文が読めなければ SyntaxExtractionError", async () => {
  const fs = new MemoryFs({
    "src/a.ts": "export function run() {\n  return 1;\n}",
    "src/broken.ts": "export function run( {\n",
  });
  await assert.rejects(extractContext(target("src/a.ts", "other"), { fs }), InletNotFoundError);
  await assert.rejects(extractContext(target("src/missing.ts", "run"), { fs }), InletNotFoundError);
  await assert.rejects(extractContext(target("src/broken.ts", "run"), { fs }), (error: unknown) => {
    assert.ok(error instanceof SyntaxExtractionError);
    assert.equal(error.file, "src/broken.ts");
    assert.ok(error.line >= 1);
    return true;
  });
});

test("同じ入力からは同じ RawContextModel が出る", async () => {
  const first = await extractContext(target("src/a.ts", "unguarded", 10), { fs: new MemoryFs(THROWING) });
  const second = await extractContext(target("src/a.ts", "unguarded", 10), { fs: new MemoryFs(THROWING) });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("specula 自身の discoverSystemContext にかけると、例外なしで出口ごとのスライスが出る", async () => {
  const fs = withRoot(new NodeFsAdapter(), process.cwd());
  const model = await extractContext(target("src/core/scenario_extractor.ts", "discoverSystemContext"), { fs });
  checkInvariants(model);
  assert.ok(model.slices.length >= 1);
  assert.ok(model.units.some((unit) => unit.kind === "CALL"), "M0 の中の関数をたどっている");
  for (const item of model.unresolved) assert.notEqual(item.reason, "", `${item.unitId} に理由がある`);
  assert.deepEqual(
    model.coverage.notAnalyzed.map((item) => item.analyzer),
    ["UI", "API_ENDPOINT", "ASYNC_TRIGGER", "SCHEMA"],
  );
});