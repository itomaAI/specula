// SpecProjector の実装との対応表（projectImplementationMap）のテスト（SpecProjector の設計 8.5・8.7）。
// 全体マップ・辞書・形式仕様・曖昧さの報告・論点カタログは手で組む。辞書の basis.mapHash は GlossaryBuilder と同じ方法で計算する。

import { test } from "node:test";
import assert from "node:assert/strict";

import { mapHashOf } from "../src/core/glossary_builder.js";
import { locationOfUnitId } from "../src/core/m5/implementation_map.js";
import { projectImplementationMap } from "../src/core/spec_projector.js";
import type { LlmText } from "../src/types/index.js";
import type { AmbiguityReport, FormalSpecification } from "../src/types/formal.js";
import type { Glossary, GlossaryEntry, GlossaryLocation, PresentedEntryKind } from "../src/types/glossary.js";
import type { DomainLedgerCatalog, LedgerIssue } from "../src/types/ledger.js";
import { ProjectionContractError, type ImplementationMapInput } from "../src/types/projection.js";
import type { EventStormingMap, ScenarioTarget } from "../src/types/scenario.js";

const LOC = { file: "src/order.ts", symbol: "f", line: 1 };
const MAP: EventStormingMap = {
  boundedContexts: [{ id: "src_order", name: "order", rootPaths: ["src/order"], isDefaultFallback: false }],
  events: [
    { id: "src/order.ts#close", contextId: "src_order", handler: LOC, signal: { kind: "DB_MUTATION", callee: "db.update", label: null, line: 1 }, after: [] },
    { id: "src/order.ts#notify", contextId: "src_order", handler: LOC, signal: { kind: "EVENT_EMIT", callee: "emit", label: "notify", line: 2 }, after: ["src/order.ts#close"] },
  ],
  commands: [{ id: "src/order.ts#closeOrder", contextId: "src_order", actorId: "Caller", eventIds: ["src/order.ts#close"], handler: LOC }],
  policies: [{ id: "src/order.ts#onClose", triggerEventId: "src/order.ts#close", actionCommandId: "src/order.ts#closeOrder", listener: LOC }],
  readModels: [],
  actors: [{ id: "Caller", name: "Caller" }],
  diagnostics: { mode: "STATE_SIGNALS", entryFiles: [], parsedFileCount: 1, parseFailures: [], unattributedSignals: [] },
};

const COMMAND_LOCATIONS: GlossaryLocation[] = [{ file: "src/order.ts", symbol: "closeOrder", line: 10 }];

function recorded(id: string, kind: GlossaryEntry["kind"], names: string[]): GlossaryEntry {
  return {
    id,
    kind,
    scope: "RECORDED",
    implementation: { names, locations: [] },
    sources: [],
    contextId: null,
    crossesTo: null,
    termStatus: null,
    excerpt: null,
  };
}

async function glossaryOf(map: EventStormingMap): Promise<Glossary> {
  const presented: Array<[string, PresentedEntryKind]> = [
    ...map.boundedContexts.map((c) => [c.id, "BOUNDED_CONTEXT"] as [string, PresentedEntryKind]),
    ...map.events.map((e) => [e.id, "EVENT"] as [string, PresentedEntryKind]),
    ...map.commands.map((c) => [c.id, "COMMAND"] as [string, PresentedEntryKind]),
    ...map.policies.map((p) => [p.id, "POLICY"] as [string, PresentedEntryKind]),
  ];
  const entries: GlossaryEntry[] = presented.map(([id, kind]) => {
    const locations = id === "src/order.ts#closeOrder" ? COMMAND_LOCATIONS : [];
    return {
      id,
      kind,
      scope: "PRESENTED",
      term: { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" },
      implementation: { names: locations.map((location) => location.symbol as string), locations },
      sources: [],
      contextId: null,
      crossesTo: null,
      termStatus: "NOT_GENERATED",
      excerpt: null,
    };
  });
  // 状態変数との照合用: status はちょうど 1 項目、locked は 2 項目にある。retryCount はどこにも無い。
  entries.push(
    recorded("SCHEMA_FIELD:orders.status", "SCHEMA_FIELD", ["status"]),
    recorded("SCHEMA_FIELD:orders.locked", "SCHEMA_FIELD", ["locked"]),
    recorded("DB_TARGET:locked", "DB_TARGET", ["locked"]),
  );
  return {
    entries,
    gaps: { undocumentedEntries: [], unmatchedDocumentNames: [], sharedTerms: [], contextHomonyms: [], multiSourceEntries: [] },
    documents: { read: [], truncated: [], omitted: [] },
    basis: { mapHash: await mapHashOf(map), documentsHash: "d".repeat(64) },
  };
}

const NOT_GENERATED: LlmText = { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" };

const ORDER_ID = "SCN-src/order.ts#closeOrder";
const NOTIFY_ID = "SCN-src/order.ts#onClose";

const ORDER: ScenarioTarget = {
  id: ORDER_ID,
  boundedContext: "src_order",
  origin: "EXTRACTED",
  inletType: "COMMAND",
  inletTrigger: { id: "src/order.ts#closeOrder", handler: { file: "src/order.ts", symbol: "closeOrder", line: 10 } },
  actor: { id: "Caller", name: "Caller" },
  expectedEvent: "src/order.ts#close",
};

const NOTIFY: ScenarioTarget = {
  ...ORDER,
  id: NOTIFY_ID,
  inletType: "POLICY",
  inletTrigger: { id: "src/order.ts#onClose", handler: { file: "src/order.ts", symbol: "onClose", line: 20 } },
};

const SPEC: FormalSpecification = {
  scenarioId: ORDER_ID,
  source: "module specula_m2\n",
  stateVariables: [
    { id: "v1", unitId: "src/order.ts:3:7:STATE", name: "status", domain: "ENUM", values: ["v1_1"], valueLiterals: { v1_1: '"open"' }, initial: "v1_1" },
    { id: "v2", unitId: "src/order.ts:4:7:STATE", name: "retryCount", domain: "INT", values: [], valueLiterals: {}, initial: "0" },
    { id: "v3", unitId: "src/order.ts:5:7:STATE", name: "locked", domain: "BOOL", values: [], valueLiterals: {}, initial: null },
  ],
  propositions: [],
  operations: [
    { id: "op1", sliceId: "S-1", outcome: "o1", outletKind: "RETURN", guardPredicate: "op1_guard", steps: [], dataMutations: [] },
    { id: "op2", sliceId: "S-2", outcome: "o2", outletKind: "THROW", guardPredicate: "op2_guard", steps: [], dataMutations: [] },
  ],
  // v3 は sourceMap に無い（unitId から作ることを確かめる）。op1 の経路のユニットは対応表に使わない。
  sourceMap: {
    v1: ["src/order.ts:3:7:STATE"],
    v2: ["src/order.ts:4:7:STATE"],
    o1: ["src/order.ts:12:5:RETURN"],
    o2: ["src/order.ts:15:5:THROW"],
    op1: ["src/order.ts:11:3:BRANCH_CONDITION", "src/order.ts:12:5:RETURN"],
  },
  labels: {},
  previousDiff: { status: "NOT_COMPUTED", reason: "FIRST_RUN" },
};

function issue(id: string, operations: string[]): LedgerIssue {
  return {
    id,
    kind: "UNHANDLED_TRANSITION",
    rootFinding: 0,
    dependentFindings: [],
    operations,
    trace: null,
    claim: NOT_GENERATED,
    observation: NOT_GENERATED,
    question: NOT_GENERATED,
    options: [{ id: "SPECIFY_HANDLING", meaning: "この状況での扱いを決めて、実装に足す" }],
    decision: null,
  };
}

function ledgerOf(issues: LedgerIssue[], scenarioId = ORDER_ID): DomainLedgerCatalog {
  return {
    scenarioId,
    basis: {
      reportId: "REPORT-1",
      specSourceHash: "0".repeat(64),
      conditions: {
        engine: { alloyVersion: "6.2.0", satSolver: "sat4j", satSolverVersion: null },
        scope: 3,
        bitwidth: 4,
        maxSteps: 10,
        preventOverflow: true,
        timeoutMs: 60000,
        partitioning: "NONE",
      },
      findingCount: issues.length,
      issueCount: issues.length,
    },
    verification: {
      outcome: "FOUND",
      status: "CHECKED",
      reason: null,
      scope: { scope: 3, maxSteps: 10, bitwidth: 4 },
      unexecutedChecks: [],
      invariantChecks: { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" },
      nonExhaustiveChecks: [],
    },
    issues,
  };
}

const LEDGER = ledgerOf([issue(`LEDGER-${ORDER_ID}-001`, ["op1", "op2"]), issue(`LEDGER-${ORDER_ID}-002`, ["op1"])]);

const AMBIGUITY: AmbiguityReport = {
  scenarioId: NOTIFY_ID,
  issues: [
    {
      kind: "UNDETERMINED_VALUE",
      unitIds: ["src/order.ts:22:5:STATE_WRITE"],
      location: { file: "src/order.ts", line: 22, column: 5 },
      detail: "status = next()",
      question: NOT_GENERATED,
    },
  ],
  counts: { UNDETERMINED_VALUE: 1, EXTERNAL_EFFECT: 0, CONFLICTING_SLICES: 0 },
};

function inputs(): ImplementationMapInput[] {
  return [
    { displayId: "S-01", scenario: ORDER, spec: SPEC, ambiguity: null, ledger: LEDGER },
    { displayId: "S-02", scenario: NOTIFY, spec: null, ambiguity: AMBIGUITY, ledger: null },
  ];
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProjectionContractError, String(error));
    return error.reason;
  }
  assert.fail("例外にならなかった");
}

test("対応表: 地図の要素 → シナリオごとにシナリオ・曖昧さ・状態変数・論点の順で、表示の id を振る", async () => {
  const glossary = await glossaryOf(MAP);
  const table = await projectImplementationMap(MAP, glossary, inputs());
  assert.deepEqual(
    table.entries.map((entry) => [entry.displayId, entry.kind, entry.internalId]),
    [
      ["c1", "BOUNDED_CONTEXT", "src_order"],
      ["n1", "EVENT", "src/order.ts#close"],
      ["n2", "EVENT", "src/order.ts#notify"],
      ["n3", "COMMAND", "src/order.ts#closeOrder"],
      ["n4", "POLICY", "src/order.ts#onClose"],
      ["S-01", "SCENARIO", ORDER_ID],
      ["S-01-V-01", "STATE_VARIABLE", "v1"],
      ["S-01-V-02", "STATE_VARIABLE", "v2"],
      ["S-01-V-03", "STATE_VARIABLE", "v3"],
      ["S-01-L-001", "LEDGER_ISSUE", `LEDGER-${ORDER_ID}-001`],
      ["S-01-L-002", "LEDGER_ISSUE", `LEDGER-${ORDER_ID}-002`],
      ["S-02", "SCENARIO", NOTIFY_ID],
      ["S-02-A-001", "AMBIGUITY", "src/order.ts:22:5:STATE_WRITE"],
    ],
  );
  assert.deepEqual(table.basis, glossary.basis);
  // 同じ入力からは同じ表
  assert.deepEqual(await projectImplementationMap(MAP, glossary, inputs()), table);
});

test("対応表: 地図の要素とシナリオは辞書の項目を写し、曖昧さと論点は辞書と結び付けない", async () => {
  const glossary = await glossaryOf(MAP);
  const table = await projectImplementationMap(MAP, glossary, inputs());
  const byId = new Map(table.entries.map((entry) => [entry.displayId, entry] as const));

  assert.equal(byId.get("n3")?.glossaryEntryId, "src/order.ts#closeOrder");
  assert.deepEqual(byId.get("n3")?.implementation, { names: ["closeOrder"], locations: COMMAND_LOCATIONS });
  assert.equal(byId.get("S-01")?.glossaryEntryId, "src/order.ts#closeOrder");
  assert.deepEqual(byId.get("S-01")?.implementation, { names: ["closeOrder"], locations: COMMAND_LOCATIONS });
  assert.equal(byId.get("S-02")?.glossaryEntryId, "src/order.ts#onClose");

  assert.equal(byId.get("S-02-A-001")?.glossaryEntryId, null);
  assert.deepEqual(byId.get("S-02-A-001")?.implementation, { names: [], locations: [{ file: "src/order.ts", line: 22 }] });

  // 論点の所在は、操作ごとの出口のユニット（経路の全ユニットではない）。同じ所在は重ねない。
  assert.equal(byId.get("S-01-L-001")?.glossaryEntryId, null);
  assert.deepEqual(byId.get("S-01-L-001")?.implementation, {
    names: [],
    locations: [{ file: "src/order.ts", line: 12 }, { file: "src/order.ts", line: 15 }],
  });
  assert.deepEqual(byId.get("S-01-L-002")?.implementation.locations, [{ file: "src/order.ts", line: 12 }]);

  // 写しは辞書の配列を共有しない
  byId.get("n3")?.implementation.names.push("x");
  assert.deepEqual(glossary.entries.find((entry) => entry.id === "src/order.ts#closeOrder")?.implementation.names, ["closeOrder"]);
});

test("対応表: 状態変数は実装の名前を持つ辞書の項目がちょうど 1 つのときだけ結び付ける", async () => {
  const table = await projectImplementationMap(MAP, await glossaryOf(MAP), inputs());
  const byId = new Map(table.entries.map((entry) => [entry.displayId, entry] as const));
  assert.equal(byId.get("S-01-V-01")?.glossaryEntryId, "SCHEMA_FIELD:orders.status");
  assert.deepEqual(byId.get("S-01-V-01")?.implementation, { names: ["status"], locations: [{ file: "src/order.ts", line: 3 }] });
  assert.equal(byId.get("S-01-V-02")?.glossaryEntryId, null, "辞書に無い");
  assert.equal(byId.get("S-01-V-03")?.glossaryEntryId, null, "2 つの項目にある");
  // sourceMap に無いときは unitId から所在を作る
  assert.deepEqual(byId.get("S-01-V-03")?.implementation.locations, [{ file: "src/order.ts", line: 5 }]);
});

test("対応表: 状態変数の表示の id は 2 桁を最小にし、100 件以上なら件数の桁にそろえる", async () => {
  const many: FormalSpecification = {
    ...SPEC,
    stateVariables: Array.from({ length: 100 }, (_, index) => ({
      id: `v${index + 1}`,
      unitId: `src/order.ts:${index + 1}:1:STATE`,
      name: `s${index + 1}`,
      domain: "INT" as const,
      values: [],
      valueLiterals: {},
      initial: "0",
    })),
    sourceMap: {},
  };
  const table = await projectImplementationMap(MAP, await glossaryOf(MAP), [
    { displayId: "S-01", scenario: ORDER, spec: many, ambiguity: null, ledger: null },
  ]);
  const ids = table.entries.filter((entry) => entry.kind === "STATE_VARIABLE").map((entry) => entry.displayId);
  assert.equal(ids[0], "S-01-V-001");
  assert.equal(ids[99], "S-01-V-100");
});

test("対応表の契約: 辞書の古さ、シナリオの食い違い、論点カタログだけがある、論点が知らない操作を指す", async () => {
  const glossary = await glossaryOf(MAP);
  assert.equal(
    await reasonOf(projectImplementationMap(MAP, { ...glossary, basis: { ...glossary.basis, mapHash: "f".repeat(64) } }, inputs())),
    "GLOSSARY_STALE",
  );
  assert.equal(
    await reasonOf(
      projectImplementationMap(MAP, glossary, [{ displayId: "S-01", scenario: ORDER, spec: SPEC, ambiguity: null, ledger: ledgerOf([], NOTIFY_ID) }]),
    ),
    "SCENARIO_MISMATCH",
  );
  assert.equal(
    await reasonOf(projectImplementationMap(MAP, glossary, [{ displayId: "S-01", scenario: NOTIFY, spec: SPEC, ambiguity: null, ledger: null }])),
    "SCENARIO_MISMATCH",
  );
  assert.equal(
    await reasonOf(projectImplementationMap(MAP, glossary, [{ displayId: "S-01", scenario: ORDER, spec: null, ambiguity: null, ledger: LEDGER }])),
    "SCENARIO_MISMATCH",
  );
  assert.equal(
    await reasonOf(
      projectImplementationMap(MAP, glossary, [
        { displayId: "S-01", scenario: ORDER, spec: SPEC, ambiguity: null, ledger: ledgerOf([issue(`LEDGER-${ORDER_ID}-001`, ["op9"])]) },
      ]),
    ),
    "UNKNOWN_OPERATION",
  );
  // 辞書に起点の項目が無い
  assert.equal(
    await reasonOf(
      projectImplementationMap(MAP, glossary, [
        { displayId: "S-01", scenario: { ...ORDER, inletTrigger: { ...ORDER.inletTrigger, id: "src/order.ts#missing" } }, spec: null, ambiguity: null, ledger: null },
      ]),
    ),
    "GLOSSARY_STALE",
  );
});

test("ユニットの識別子から所在を作る: パスに「:」があっても右から分ける。形が違えば止める", () => {
  assert.deepEqual(locationOfUnitId("src/a.ts:3:7:STATE"), { file: "src/a.ts", line: 3 });
  assert.deepEqual(locationOfUnitId("C:/repo/a.ts:12:1:RETURN"), { file: "C:/repo/a.ts", line: 12 });
  assert.throws(() => locationOfUnitId("U-1"));
  assert.throws(() => locationOfUnitId("src/a.ts:x:7:STATE"));
});