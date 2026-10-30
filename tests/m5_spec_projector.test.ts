// M5（SpecProjector）のテスト（M5 の設計 2〜4、仕様 3）。形式仕様・論点カタログ・全体マップは手で組む。
// 本物のエンジンの結果からの射影は tests/m3_alloy_integration.test.ts（ALLOY_JAR があるときだけ走る）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectSpecification, projectSystemMap } from "../src/core/spec_projector.js";
import { stepText } from "../src/core/m5/sentences.js";
import { sha256Hex } from "../src/lib/sha256.js";
import type { LlmText } from "../src/types/index.js";
import type { FormalSpecification, OperationStep } from "../src/types/formal.js";
import type { DomainLedgerCatalog, LedgerIssue } from "../src/types/ledger.js";
import { ProjectionContractError, type ProjectionRequest } from "../src/types/projection.js";
import type { EventStormingMap } from "../src/types/scenario.js";

function generated(text: string): LlmText {
  return { status: "GENERATED", text, recordKey: `label-${text}` };
}

const NOT_GENERATED: LlmText = { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "op1 を含む詳細" };

const SOURCE = [
  "module order",
  "-- @source: src/order.ts:3:7:STATE",
  "one sig v1_1, v1_2 extends V1 {}",
  "  -- @source: src/order.ts:9:5:BRANCH_CONDITION",
  "pred op1_guard[s: System] { s.v1 = v1_1 }",
  "-- 説明の中のバッククォート ```` を含む行",
  "",
].join("\n");

const SPEC: FormalSpecification = {
  scenarioId: "SCN-1",
  source: SOURCE,
  stateVariables: [
    { id: "v1", unitId: "src/order.ts:3:7:STATE", domain: "ENUM", values: ["v1_1", "v1_2", "v1_unknown"], valueLiterals: { v1_1: '"open"', v1_2: '"closed"' }, initial: "v1_1" },
    { id: "v2", unitId: "src/order.ts:4:7:STATE", domain: "INT", values: [], valueLiterals: {}, initial: "0" },
    { id: "v3", unitId: "src/order.ts:5:7:STATE", domain: "BOOL", values: [], valueLiterals: {}, initial: null },
  ],
  propositions: [{ id: "c1", unitId: "src/order.ts:9:5:BRANCH_CONDITION", expression: "request.force" }],
  operations: [
    {
      id: "op1",
      sliceId: "S-1",
      outcome: "o1",
      outletKind: "RETURN",
      guardPredicate: "op1_guard",
      steps: [
        { kind: "CONDITION", unitId: "U-a", expr: { op: "IS", variable: "v1", value: "v1_1" }, holds: true },
        { kind: "WRITE", unitId: "U-b", variable: "v2", change: { op: "ADD", amount: 1 }, when: [] },
        { kind: "CONDITION", unitId: "U-c", expr: { op: "CMP", variable: "v2", cmp: "lt", value: 3 }, holds: true },
        { kind: "WRITE", unitId: "U-d", variable: "v1", change: { op: "SET", value: "v1_2" }, when: [{ unitId: "U-e", holds: false, expr: { op: "PROP", prop: "c1" } }] },
      ],
      dataMutations: ["src/order.ts:20:3:DATA_MUTATION"],
    },
    {
      id: "op2",
      sliceId: "S-2",
      outcome: "o2",
      outletKind: "THROW",
      guardPredicate: "op2_guard",
      steps: [{ kind: "CONDITION", unitId: "U-f", expr: { op: "PROP", prop: "c1" }, holds: false }],
      dataMutations: [],
    },
  ],
  sourceMap: {},
  labels: {
    v1: generated("注文の状態"),
    v1_1: generated("受付中"),
    v1_2: generated("締め切り済み"),
    v2: generated("試行回数"),
    v3: generated("確認済み | 印"),
    c1: generated("強制の指定"),
    op1: generated("注文を締める"),
    op2: generated("締めを断る \"強制\""),
    o1: generated("締めた結果"),
    o2: generated("断りの例外"),
  },
  previousDiff: { status: "NOT_COMPUTED", reason: "FIRST_RUN" },
};

function issue(overrides: Partial<LedgerIssue> = {}): LedgerIssue {
  return {
    id: "LEDGER-SCN-1-001",
    kind: "UNHANDLED_TRANSITION",
    rootFinding: 0,
    dependentFindings: [1],
    operations: ["op1", "op2"],
    trace: [
      { index: 0, values: { v1: "v1_1", v2: 0, v3: "False" }, outcome: "Idle", holds: [] },
      { index: 1, values: { v1: "v1_2", v2: 1, v3: "True" }, outcome: "o1", holds: ["c1"] },
    ],
    claim: generated("締め切り済みの注文にも、扱いが決まっているべきである。"),
    observation: generated("締め切り済みで強制の指定があるとき、受け付ける操作が無かった。"),
    question: generated("締め切り済みの注文に強制の指定が来たら、どう扱いますか。"),
    options: [
      { id: "SPECIFY_HANDLING", meaning: "この状況での扱いを決めて、実装に足す" },
      { id: "RECHECK_WITH_LARGER_SCOPE", meaning: "範囲を広げて調べ直す" },
    ],
    decision: null,
    ...overrides,
  };
}

async function catalog(overrides: Partial<DomainLedgerCatalog> = {}, issues: LedgerIssue[] = [issue()]): Promise<DomainLedgerCatalog> {
  return {
    scenarioId: "SCN-1",
    basis: {
      reportId: "REPORT-1",
      specSourceHash: await sha256Hex(SOURCE),
      conditions: {
        engine: { alloyVersion: "6.2.0", satSolver: "sat4j", satSolverVersion: null },
        scope: 3,
        bitwidth: 4,
        maxSteps: 10,
        preventOverflow: true,
        timeoutMs: 60000,
        partitioning: "NONE",
      },
      findingCount: 2,
      issueCount: issues.length,
    },
    verification: {
      outcome: issues.length === 0 ? "NONE_FOUND_WITHIN_SCOPE" : "FOUND",
      status: "CHECKED",
      reason: null,
      scope: { scope: 3, maxSteps: 10, bitwidth: 4 },
      unexecutedChecks: [],
      invariantChecks: { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" },
      nonExhaustiveChecks: ["m3_cover"],
    },
    issues,
    ...overrides,
  };
}

const DOCUMENT: ProjectionRequest = { format: "DOCUMENT" };
const IDENTIFIER = /\b(?:v\d+(?:_\d+|_unknown)?|c\d+|op\d+(?:_guard)?|o\d+|m3_\w+)\b/;
const FORBIDDEN = ["健全", "証明済み", "問題なし", "採択済み", "合意済み"];

function bodyOf(markdown: string): string {
  const index = markdown.indexOf("## 付録");
  return index < 0 ? markdown : markdown.slice(0, index);
}

test("M5: 仕様書は決定論的で、末尾は改行 1 つ", async () => {
  const ledger = await catalog();
  const a = await projectSpecification(SPEC, ledger, DOCUMENT);
  const b = await projectSpecification(SPEC, ledger, DOCUMENT);
  assert.equal(a.content, b.content);
  assert.ok(a.content.endsWith("\n") && !a.content.endsWith("\n\n"));
  assert.equal(a.mediaType, "text/markdown");
  assert.equal(a.basis.specSourceHash, await sha256Hex(SOURCE));
  assert.equal(a.basis.ledgerReportId, "REPORT-1");
  assert.equal(a.basis.ledgerIsStale, false);
});

test("M5: 仕様書に状態変数・命題・操作・論点がすべて表示名で出て、識別子と禁止語が出ない", async () => {
  const view = await projectSpecification(SPEC, await catalog(), DOCUMENT);
  const body = bodyOf(view.content);
  for (const label of ["注文の状態", "試行回数", "確認済み \\| 印", "強制の指定", "注文を締める", "LEDGER-SCN-1-001"]) {
    assert.ok(body.includes(label), `${label} が無い`);
  }
  assert.doesNotMatch(body, IDENTIFIER);
  for (const word of FORBIDDEN) assert.ok(!view.content.includes(word), `${word} が出た`);
  assert.ok(!view.content.includes("@source"));
  assert.ok(!view.content.includes("src/order.ts"));
  assert.ok(body.includes("- 状態: 未決"));
  assert.ok(body.includes("選択肢（候補。どれも採択していない）"));
  assert.ok(body.includes("状態として検証していない変更: 1 件"));
  assert.ok(body.includes("反例を 1 件だけ返す検査（ほかの反例があっても出ない）: どの操作の条件も成り立たない状態を探す検査"));
  assert.ok(body.includes("不変条件の検査はしていない"));
  assert.ok(body.includes("論点 1 件（元の反例 2 件をまとめたもの）"));
  assert.ok(body.includes("従属する反例: 1 件"));
});

test("M5: 検証の状態は論点より前に書く", async () => {
  const view = await projectSpecification(SPEC, await catalog(), DOCUMENT);
  assert.ok(view.content.indexOf("## 検証の状態") < view.content.indexOf("## 論点"));
});

test("M5: 付録のソースは @source の行を除き、囲みはバッククォートの並びより長い", async () => {
  const view = await projectSpecification(SPEC, null, DOCUMENT);
  const appendix = view.content.slice(view.content.indexOf("## 付録"));
  assert.ok(appendix.includes("`````alloy\n"));
  assert.ok(appendix.includes("pred op1_guard"));
  assert.ok(!appendix.includes("@source"));
});

test("M5: 条件と書き込みの文（設計 3.2）", () => {
  const text = (step: OperationStep): string => stepText(SPEC, step);
  const ops = SPEC.operations[0]!.steps;
  assert.equal(text(ops[0]!), "注文の状態が受付中である");
  assert.equal(text(ops[1]!), "試行回数に 1 を足す");
  assert.equal(text(ops[2]!), "試行回数が 3 より小さい");
  assert.equal(text(ops[3]!), "「次が成り立たない: 強制の指定が成り立つ」のとき、注文の状態を締め切り済みにする");
  assert.equal(
    text({ kind: "WRITE", unitId: "x", variable: "v2", change: { op: "ADD", amount: -2 }, when: [] }),
    "試行回数から 2 を引く",
  );
  assert.equal(
    text({
      kind: "CONDITION",
      unitId: "x",
      holds: true,
      expr: { op: "AND", args: [{ op: "PROP", prop: "c1" }, { op: "OR", args: [{ op: "IS", variable: "v3", value: "True" }, { op: "CMP", variable: "v2", cmp: "gte", value: 2 }] }] },
    }),
    "強制の指定が成り立つ、かつ、（確認済み | 印が真である、または、試行回数が 2 以上）",
  );
});

test("M5: 未検証のときは理由と実行しなかった検査を書き、検査の id は出さない", async () => {
  const ledger = await catalog({
    verification: {
      outcome: "UNVERIFIED",
      status: "UNVERIFIED",
      reason: { kind: "TIMEOUT", detail: "m3_reach_op2 が 60000 ms を超えた" },
      scope: { scope: 3, maxSteps: 10, bitwidth: 4 },
      unexecutedChecks: ["m3_reach_op2", "m3_overlap_op1_op2", "m3_escape_3"],
      invariantChecks: { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" },
      nonExhaustiveChecks: [],
    },
  });
  const view = await projectSpecification(SPEC, ledger, DOCUMENT);
  const body = bodyOf(view.content);
  assert.ok(body.includes("未検証。"));
  assert.ok(body.includes("未検証の理由: 検査が制限時間を超えた"));
  assert.ok(body.includes("「締めを断る \"強制\"」に到達できるかの検査"));
  assert.ok(body.includes("「注文を締める」と「締めを断る \"強制\"」の条件が重なる状態を探す検査"));
  assert.ok(body.includes("抜けられない状態を探す検査"));
  assert.ok(!body.includes("見つからなかった"));
  assert.doesNotMatch(body, IDENTIFIER);
});

test("M5: 論点 0 件で検査済みなら、範囲つきで「見つからなかった」と書く", async () => {
  const view = await projectSpecification(SPEC, await catalog({}, []), DOCUMENT);
  assert.ok(view.content.includes("指定のスコープの中で、行った検査では見つからなかった"));
  assert.ok(view.content.includes("スコープ 3、整数のビット幅 4、ステップ数の上限 10"));
  assert.ok(view.content.includes("論点は無い。"));
});

test("M5: カタログが古いときは先頭で知らせ、論点は消さない", async () => {
  const ledger = await catalog();
  ledger.basis.specSourceHash = "0".repeat(64);
  const view = await projectSpecification(SPEC, ledger, DOCUMENT);
  assert.equal(view.basis.ledgerIsStale, true);
  const notice = view.content.indexOf("別の版から作った");
  assert.ok(notice > 0 && notice < view.content.indexOf("## 検証の状態"));
  assert.ok(view.content.includes("LEDGER-SCN-1-001"));
});

test("M5: カタログが無いときは、そのことを書き、basis は null", async () => {
  const view = await projectSpecification(SPEC, null, DOCUMENT);
  assert.ok(view.content.includes("論点カタログが無いので、検証の状態は分からない"));
  assert.ok(view.content.includes("論点カタログが無い（M4 を実行していない）"));
  assert.equal(view.basis.ledgerReportId, null);
  assert.equal(view.basis.ledgerIsStale, null);
});

test("M5: 表示名と論点の文が未生成なら、そのまま「未生成」と書き、detail は出さない", async () => {
  const spec: FormalSpecification = { ...SPEC, labels: { ...SPEC.labels, v1_2: NOT_GENERATED, op2: NOT_GENERATED } };
  const view = await projectSpecification(spec, await catalog({}, [issue({ claim: NOT_GENERATED })]), DOCUMENT);
  assert.ok(view.content.includes("v1_2（表示名は未生成）"));
  assert.ok(view.content.includes("### op2（表示名は未生成）"));
  assert.ok(view.content.includes("- 主張: 未生成（LLM に届かなかった）"));
  assert.ok(!view.content.includes("op1 を含む詳細"));
});

test("M5: 実行列は時点ごとに表示名で書く", async () => {
  const view = await projectSpecification(SPEC, await catalog(), DOCUMENT);
  assert.ok(view.content.includes("| 0 | 注文の状態: 受付中、試行回数: 0、確認済み \\| 印: 偽 | まだ操作していない | なし |"));
  assert.ok(view.content.includes("| 1 | 注文の状態: 締め切り済み、試行回数: 1、確認済み \\| 印: 真 | 締めた結果（戻り値を返して終わる） | 強制の指定 |"));
});

test("M5: 操作の一覧表はすべての操作を行にし、セルの | を逃がす", async () => {
  const view = await projectSpecification(SPEC, await catalog(), { format: "MATRIX" });
  assert.equal(view.mediaType, "text/markdown");
  const rows = view.content.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| 表示名") && !line.startsWith("| :--"));
  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.startsWith("| 注文を締める | (1) 注文の状態が受付中である；(3) 試行回数が 3 より小さい |"));
  assert.ok(rows[0]!.includes("| 1 件 | LEDGER-SCN-1-001 |"));
  assert.doesNotMatch(view.content, IDENTIFIER);
});

test("M5: 操作の流れ図は Mermaid で、表示する文の \" を置き換える", async () => {
  const view = await projectSpecification(SPEC, await catalog(), { format: "FLOW" });
  assert.equal(view.mediaType, "text/vnd.mermaid");
  assert.ok(view.content.startsWith("flowchart TD\n"));
  assert.ok(view.content.includes('op2_0["操作: 締めを断る #quot;強制#quot;"]'));
  assert.ok(view.content.includes("op1_r"));
  assert.ok(view.content.includes("未決の論点: LEDGER-SCN-1-001"));
  const labels = [...view.content.matchAll(/\["([^"]*)"\]/g)].map((match) => match[1]!).join("\n");
  assert.doesNotMatch(labels, IDENTIFIER);
});

test("M5: 同じ項目は、どのビューでも同じ表示名", async () => {
  const ledger = await catalog();
  for (const format of ["DOCUMENT", "MATRIX", "FLOW"] as const) {
    const view = await projectSpecification(SPEC, ledger, { format });
    assert.ok(view.content.includes("注文を締める"), format);
    assert.ok(view.content.includes("締めた結果（戻り値を返して終わる）"), format);
  }
});

test("M5: 射影は入力を変えない", async () => {
  const spec = structuredClone(SPEC);
  const ledger = await catalog();
  const before = structuredClone(ledger);
  await projectSpecification(spec, ledger, DOCUMENT);
  assert.deepEqual(spec, SPEC);
  assert.deepEqual(ledger, before);
});

test("M5: 契約の違反", async () => {
  await assert.rejects(projectSpecification(SPEC, await catalog({ scenarioId: "SCN-2" }), DOCUMENT), (error: unknown) => {
    return error instanceof ProjectionContractError && error.reason === "SCENARIO_MISMATCH";
  });
  await assert.rejects(projectSpecification(SPEC, await catalog({}, [issue({ operations: ["op9"] })]), DOCUMENT), (error: unknown) => {
    return error instanceof ProjectionContractError && error.reason === "UNKNOWN_OPERATION";
  });
  const badTrace = issue({ trace: [{ index: 0, values: { v9: 1 }, outcome: "Idle", holds: [] }] });
  await assert.rejects(projectSpecification(SPEC, await catalog({}, [badTrace]), DOCUMENT), (error: unknown) => {
    return error instanceof ProjectionContractError && error.reason === "UNKNOWN_STATE_VARIABLE";
  });
  await assert.rejects(projectSpecification(SPEC, null, { format: "SEQUENCE" } as unknown as ProjectionRequest), (error: unknown) => {
    return error instanceof ProjectionContractError && error.reason === "UNSUPPORTED_FORMAT";
  });
});

const LOC = { file: "src/order.ts", symbol: "f", line: 1 };
const MAP: EventStormingMap = {
  boundedContexts: [
    { id: "src_order", name: "注文", rootPaths: ["src/order"], isDefaultFallback: false, intent: generated("注文を扱う"), intentStatus: "CANDIDATE" },
  ],
  events: [
    { id: "src/order.ts#close", name: generated("注文が締められた"), contextId: "src_order", handler: LOC, signal: { kind: "DB_MUTATION", callee: "db.update", label: null, line: 1 }, after: [] },
    { id: "src/order.ts#notify", name: NOT_GENERATED, contextId: "src_order", handler: LOC, signal: { kind: "EVENT_EMIT", callee: "emit", label: "notify", line: 2 }, after: ["src/order.ts#close"] },
  ],
  commands: [
    { id: "src/order.ts#closeOrder", name: generated("注文を締める"), contextId: "src_order", actorId: "Caller", eventIds: ["src/order.ts#close"], handler: LOC },
  ],
  policies: [
    { id: "src/order.ts#onClose", triggerEventId: "src/order.ts#close", actionCommandId: "src/order.ts#closeOrder", name: generated("締めたら知らせる"), listener: LOC },
  ],
  readModels: [],
  actors: [{ id: "Caller", name: "Caller" }],
  diagnostics: { mode: "STATE_SIGNALS", entryFiles: [], parsedFileCount: 1, parseFailures: [], unattributedSignals: [] },
};

test("M5: 全体の俯瞰図（Mermaid）は Bounded Context ごとにまとめ、地図の id を出さない", () => {
  const a = projectSystemMap(MAP, { format: "SYSTEM_MERMAID" });
  const b = projectSystemMap(MAP, { format: "SYSTEM_MERMAID" });
  assert.equal(a.content, b.content);
  assert.equal(a.scenarioId, null);
  assert.equal(a.mediaType, "text/vnd.mermaid");
  assert.ok(a.content.includes('subgraph c1["注文"]'));
  assert.ok(a.content.includes('n1["イベント: 注文が締められた"]'));
  assert.ok(a.content.includes('n2["イベント: イベント n2（名前は未生成）"]'));
  assert.ok(a.content.includes("n3 -->|発生させる| n1"));
  assert.ok(a.content.includes("n1 -->|このあとに起きる| n2"));
  assert.ok(a.content.includes("n1 -->|反応する| n4"));
  assert.ok(a.content.includes("n4 -->|起動する| n3"));
  assert.ok(!a.content.includes("src/order.ts"));
});

test("M5: 全体の俯瞰図（JSON）はノードとつながりを決まった順で返す", () => {
  const view = projectSystemMap(MAP, { format: "SYSTEM_JSON" });
  assert.equal(view.mediaType, "application/json");
  const value = JSON.parse(view.content) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(value.nodes[0]!), ["id", "kind", "label", "context"]);
  assert.deepEqual(value.nodes.map((node) => node.kind), ["EVENT", "EVENT", "COMMAND", "POLICY"]);
  assert.equal(value.nodes[3]!.context, null);
  assert.deepEqual(value.edges, [
    { from: "n3", to: "n1", kind: "EMITS" },
    { from: "n1", to: "n2", kind: "AFTER" },
    { from: "n1", to: "n4", kind: "TRIGGERS" },
    { from: "n4", to: "n3", kind: "INVOKES" },
  ]);
});