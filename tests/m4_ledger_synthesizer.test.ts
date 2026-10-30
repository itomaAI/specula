// M4（LedgerSynthesizer）のテスト（M4 の設計 2〜6）。報告と形式仕様は手で組み、LLM は偽のポートに置き換える。
// 本物のエンジンの反例でのまとめ方は tests/m3_alloy_integration.test.ts（ALLOY_JAR があるときだけ走る）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { synthesizeLedger } from "../src/core/ledger_synthesizer.js";
import { leakedIdentifiers, specIdentifiers } from "../src/core/m4/issue_text.js";
import { sha256Hex } from "../src/lib/sha256.js";
import type { LanguageModelPort, OutputCheck } from "../src/ports/LanguageModelPort.js";
import type { JsonValue, LlmRequest, LlmText } from "../src/types/index.js";
import type { FormalSpecification } from "../src/types/formal.js";
import { LedgerContractError } from "../src/types/ledger.js";
import type { Finding, SolverReport, TraceStep } from "../src/types/solver.js";

const GOOD_REPLY = JSON.stringify({
  claim: "受付中の注文は、取り消すか確定するかのどちらかに進めるべきである。",
  observation: "確定済みの注文に対して、受け付けられる操作が一つも無かった。",
  question: "確定済みの注文に取り消しの依頼が来たとき、どう扱いますか。",
});

class FakeLlm implements LanguageModelPort {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly reply: (request: LlmRequest) => string | null = () => GOOD_REPLY) {}
  async generate(request: LlmRequest, check: OutputCheck): Promise<LlmText> {
    this.requests.push(request);
    const text = this.reply(request);
    if (text === null) return { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "fake" };
    const result = check(text);
    if (!result.ok) return { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: result.detail };
    return { status: "GENERATED", text, recordKey: `key-${this.requests.length}` };
  }
}

function generated(text: string): LlmText {
  return { status: "GENERATED", text, recordKey: `label-${text}` };
}

const SPEC: FormalSpecification = {
  scenarioId: "SCN-1",
  source: "module order\n// テスト用の形式仕様（中身は M4 では読まない）\n",
  stateVariables: [
    { id: "v1", unitId: "U-1", name: "status", domain: "ENUM", values: ["v1_1", "v1_2"], valueLiterals: { v1_1: '"open"', v1_2: '"closed"' }, initial: "v1_1" },
    { id: "v2", unitId: "U-2", name: "retryCount", domain: "INT", values: [], valueLiterals: {}, initial: "0" },
  ],
  propositions: [{ id: "c1", unitId: "U-3", expression: "request.force" }],
  operations: [
    {
      id: "op1",
      sliceId: "S-1",
      outcome: "o1",
      outletKind: "RETURN",
      guardPredicate: "op1_guard",
      steps: [{ kind: "CONDITION", unitId: "U-3", expr: { op: "PROP", prop: "c1" }, holds: true }],
      dataMutations: [],
    },
    {
      id: "op2",
      sliceId: "S-2",
      outcome: "o2",
      outletKind: "THROW",
      guardPredicate: "op2_guard",
      steps: [],
      dataMutations: [],
    },
    {
      id: "op3",
      sliceId: "S-3",
      outcome: "o3",
      outletKind: "RETURN",
      guardPredicate: "op3_guard",
      steps: [],
      dataMutations: [],
    },
  ],
  sourceMap: {},
  labels: {
    v1: generated("注文の状態"),
    v1_1: generated("受付中"),
    v1_2: { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" },
    op1: generated("強制的に閉じる"),
  },
  labelStatus: { v1: "CANDIDATE", v1_1: "CANDIDATE", v1_2: "NOT_GENERATED", op1: "CANDIDATE" },
  previousDiff: { status: "NOT_COMPUTED", reason: "FIRST_RUN" },
};

function trace(lastV1: string, lastV2 = 0): TraceStep[] {
  return [
    { index: 0, values: { v1: "v1_1", v2: 0 }, outcome: "Idle", holds: [] },
    { index: 1, values: { v1: lastV1, v2: lastV2 }, outcome: "o1", holds: ["c1"] },
  ];
}

async function report(findings: Finding[], overrides: Partial<SolverReport> = {}): Promise<SolverReport> {
  return {
    reportId: "REPORT-1",
    scenarioId: "SCN-1",
    specSourceHash: await sha256Hex(SPEC.source),
    status: "CHECKED",
    reason: null,
    conditions: {
      engine: { alloyVersion: "6.2.0", satSolver: "sat4j", satSolverVersion: null },
      scope: 3,
      bitwidth: 4,
      maxSteps: 10,
      preventOverflow: true,
      timeoutMs: 60000,
      partitioning: "NONE",
    },
    checks: [
      { id: "m3_cover", kind: "COVER", targets: ["op1", "op2", "op3"], result: "FOUND", exhaustive: false, steps: 1 },
      { id: "m3_overlap_op1_op2", kind: "OVERLAP", targets: ["op1", "op2"], result: "FOUND", exhaustive: true, steps: 1 },
    ],
    unexecutedChecks: [],
    findings,
    invariantChecks: { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" },
    ...overrides,
  };
}

const COVER: Finding = { kind: "UNHANDLED_TRANSITION", checkId: "m3_cover", operations: ["op1", "op2", "op3"], trace: trace("v1_2") };
const OVERLAP_12: Finding = { kind: "OVERLAPPING_OPERATIONS", checkId: "m3_overlap_op1_op2", operations: ["op1", "op2"], trace: trace("v1_1", 3) };
const OVERLAP_13: Finding = { kind: "OVERLAPPING_OPERATIONS", checkId: "m3_overlap_op1_op3", operations: ["op1", "op3"], trace: trace("v1_1", 3) };
const UNREACH: Finding = { kind: "UNREACHABLE_OPERATION", checkId: "m3_reach_op3", operations: ["op3"], trace: null };
const DEADLOCK: Finding = { kind: "DEADLOCK", checkId: "m3_escape", operations: ["op1", "op2", "op3"], trace: trace("v1_2") };

function rootsAndDependents(catalog: { issues: { rootFinding: number; dependentFindings: number[] }[] }): number[] {
  return catalog.issues.flatMap((issue) => [issue.rootFinding, ...issue.dependentFindings]).sort((a, b) => a - b);
}

test("M4: 見つかったものが 0 件なら、論点は無く「見つからなかった」とスコープを書く（LLM は呼ばない）", async () => {
  const llm = new FakeLlm();
  const catalog = await synthesizeLedger(await report([]), SPEC, { llm });
  assert.equal(catalog.verification.outcome, "NONE_FOUND_WITHIN_SCOPE");
  assert.deepEqual(catalog.verification.scope, { scope: 3, maxSteps: 10, bitwidth: 4 });
  assert.deepEqual(catalog.verification.nonExhaustiveChecks, ["m3_cover"]);
  assert.deepEqual(catalog.verification.invariantChecks, { status: "NOT_APPLICABLE", reason: "NO_ASSERTIONS_FIRST_RUN" });
  assert.deepEqual(catalog.issues, []);
  assert.equal(catalog.basis.findingCount, 0);
  assert.equal(catalog.basis.issueCount, 0);
  assert.equal(llm.requests.length, 0);
  assert.equal("recommendation" in catalog, false);
});

test("M4: 未検証の報告は UNVERIFIED のまま、見つかった反例は論点にする", async () => {
  const unverified = await report([COVER], {
    status: "UNVERIFIED",
    reason: { kind: "TIMEOUT", detail: "m3_overlap_op1_op2: ステップ数 3 で 60000 ms を超えた" },
    unexecutedChecks: ["m3_overlap_op1_op2", "m3_reach_op1"],
  });
  const catalog = await synthesizeLedger(unverified, SPEC, { llm: new FakeLlm() });
  assert.equal(catalog.verification.outcome, "UNVERIFIED");
  assert.equal(catalog.verification.reason?.kind, "TIMEOUT");
  assert.deepEqual(catalog.verification.unexecutedChecks, ["m3_overlap_op1_op2", "m3_reach_op1"]);
  assert.equal(catalog.issues.length, 1);
  assert.equal(catalog.issues[0]?.kind, "UNHANDLED_TRANSITION");
});

test("M4: 同じ状態の未定義遷移とデッドロックは、デッドロックを本体にした 1 つの論点になる", async () => {
  const catalog = await synthesizeLedger(await report([COVER, DEADLOCK]), SPEC, { llm: new FakeLlm() });
  assert.equal(catalog.issues.length, 1);
  const issue = catalog.issues[0];
  assert.equal(issue?.id, "LEDGER-SCN-1-001");
  assert.equal(issue?.kind, "DEADLOCK");
  assert.equal(issue?.rootFinding, 1);
  assert.deepEqual(issue?.dependentFindings, [0]);
  assert.deepEqual(issue?.trace, DEADLOCK.trace);
  assert.deepEqual(issue?.options.map((option) => option.id), ["SPECIFY_EXIT", "DECLARE_TERMINAL", "FIX_IMPLEMENTATION"]);
});

test("M4: 到達できない操作は単独、同じ状態の重なり 2 件は 1 つにまとめ、すべての反例がどれかの論点からたどれる", async () => {
  const findings = [COVER, OVERLAP_12, OVERLAP_13, UNREACH, DEADLOCK];
  const catalog = await synthesizeLedger(await report(findings), SPEC, { llm: new FakeLlm() });
  assert.deepEqual(
    catalog.issues.map((issue) => [issue.id, issue.kind, issue.rootFinding, issue.dependentFindings]),
    [
      ["LEDGER-SCN-1-001", "OVERLAPPING_OPERATIONS", 1, [2]],
      ["LEDGER-SCN-1-002", "UNREACHABLE_OPERATION", 3, []],
      ["LEDGER-SCN-1-003", "DEADLOCK", 4, [0]],
    ],
  );
  assert.deepEqual(catalog.issues[0]?.operations, ["op1", "op2", "op3"]);
  assert.equal(catalog.issues[1]?.trace, null);
  assert.deepEqual(catalog.issues[1]?.options.map((option) => option.id), ["FIX_IMPLEMENTATION", "REMOVE_OPERATION", "RECHECK_WITH_LARGER_SCOPE"]);
  assert.deepEqual(catalog.issues[0]?.options.map((option) => option.id), ["SPECIFY_PRIORITY", "FIX_IMPLEMENTATION", "ACCEPT_AS_UNREACHABLE"]);
  assert.equal(catalog.basis.findingCount, 5);
  assert.equal(catalog.basis.issueCount, 3);
  assert.deepEqual(rootsAndDependents(catalog), [0, 1, 2, 3, 4]);
  assert.equal(catalog.verification.outcome, "FOUND");
  for (const issue of catalog.issues) assert.equal(issue.decision, null);
});

test("M4: 同じ入力からは、同じ論点の数・まとめ方・識別子・選択肢・並び・LLM への入力になる", async () => {
  const findings = [COVER, OVERLAP_12, OVERLAP_13, UNREACH, DEADLOCK];
  const first = new FakeLlm();
  const second = new FakeLlm();
  const a = await synthesizeLedger(await report(findings), SPEC, { llm: first });
  const b = await synthesizeLedger(await report(findings), SPEC, { llm: second });
  assert.deepEqual(a, b);
  assert.deepEqual(first.requests, second.requests);
});

test("M4: LLM の入力は表示名を GENERATED だけ渡し、未生成は null にする", async () => {
  const llm = new FakeLlm();
  await synthesizeLedger(await report([COVER]), SPEC, { llm });
  assert.equal(llm.requests.length, 1);
  const request = llm.requests[0] as LlmRequest;
  assert.equal(request.task, "m4.issue-text");
  const input = request.input as unknown as { vocabulary: { stateVariables: { id: string; label: string | null; values: { id: string; label: string | null; literal: string | null }[] }[]; propositions: JsonValue[]; operations: { id: string; label: string | null }[] } };
  const v1 = input.vocabulary.stateVariables[0];
  assert.equal(v1?.label, "注文の状態");
  assert.deepEqual(v1?.values, [
    { id: "v1_1", label: "受付中", literal: '"open"' },
    { id: "v1_2", label: null, literal: '"closed"' },
  ]);
  assert.equal(input.vocabulary.stateVariables[1]?.label, null);
  assert.deepEqual(input.vocabulary.propositions, [{ id: "c1", label: null, expression: "request.force" }]);
  assert.deepEqual(input.vocabulary.operations.map((operation) => [operation.id, operation.label]), [
    ["op1", "強制的に閉じる"],
    ["op2", null],
    ["op3", null],
  ]);
});

test("M4: LLM が届かなければ 3 つの文を未生成にし、論点の構成は残す", async () => {
  const catalog = await synthesizeLedger(await report([COVER, DEADLOCK]), SPEC, { llm: new FakeLlm(() => null) });
  const issue = catalog.issues[0];
  assert.equal(issue?.claim.status, "NOT_GENERATED");
  assert.equal(issue?.observation.status, "NOT_GENERATED");
  assert.equal(issue?.question.status, "NOT_GENERATED");
  assert.deepEqual([issue?.claimStatus, issue?.observationStatus, issue?.questionStatus], ["NOT_GENERATED", "NOT_GENERATED", "NOT_GENERATED"]);
  assert.equal(issue?.options.length, 3);
  assert.deepEqual(issue?.dependentFindings, [0]);
});

test("M4: 書けた文の確定の状態は CANDIDATE で、論点の決定は未決のまま（M4 の設計 8）", async () => {
  const catalog = await synthesizeLedger(await report([COVER]), SPEC, { llm: new FakeLlm() });
  const issue = catalog.issues[0];
  assert.equal(issue?.claim.status, "GENERATED");
  assert.deepEqual([issue?.claimStatus, issue?.observationStatus, issue?.questionStatus], ["CANDIDATE", "CANDIDATE", "CANDIDATE"]);
  assert.equal(issue?.decision, null);
});

test("M4: 文に形式仕様の識別子が出たら INVALID_OUTPUT にする", async () => {
  const leaking = JSON.stringify({ claim: "v1 が受付中のときに", observation: "見つかった", question: "どうしますか" });
  const catalog = await synthesizeLedger(await report([COVER]), SPEC, { llm: new FakeLlm(() => leaking) });
  const claim = catalog.issues[0]?.claim;
  assert.equal(claim?.status, "NOT_GENERATED");
  assert.equal(claim?.status === "NOT_GENERATED" ? claim.reason : null, "INVALID_OUTPUT");
  assert.equal(catalog.issues[0]?.question.status, "NOT_GENERATED");
  assert.deepEqual(leakedIdentifiers("op1_guard と c1、v10 と Idle", specIdentifiers(SPEC)), ["op1_guard", "c1"]);
});

test("M4: 文が空、400 文字を超える、JSON でないときも INVALID_OUTPUT にする", async () => {
  const replies = [
    JSON.stringify({ claim: "", observation: "a", question: "b" }),
    JSON.stringify({ claim: "あ".repeat(401), observation: "a", question: "b" }),
    "主張: …",
  ];
  for (const reply of replies) {
    const catalog = await synthesizeLedger(await report([COVER]), SPEC, { llm: new FakeLlm(() => reply) });
    const text = catalog.issues[0]?.observation;
    assert.equal(text?.status === "NOT_GENERATED" ? text.reason : null, "INVALID_OUTPUT", reply.slice(0, 20));
  }
  const fenced = "```json\n" + GOOD_REPLY + "\n```";
  const ok = await synthesizeLedger(await report([COVER]), SPEC, { llm: new FakeLlm(() => fenced) });
  const claim = ok.issues[0]?.claim;
  assert.equal(claim?.status === "GENERATED" ? claim.text : null, "受付中の注文は、取り消すか確定するかのどちらかに進めるべきである。");
});

test("M4: 入力の契約が破れていれば LedgerContractError", async () => {
  const cases: Array<[SolverReport, LedgerContractError["reason"]]> = [
    [await report([], { scenarioId: "SCN-2" }), "SCENARIO_MISMATCH"],
    [await report([], { specSourceHash: "0".repeat(64) }), "SPEC_HASH_MISMATCH"],
    [await report([{ ...UNREACH, operations: ["op9"] }]), "UNKNOWN_OPERATION"],
    [await report([{ ...COVER, trace: [{ index: 0, values: { v9: 1 }, outcome: "Idle", holds: [] }] }]), "UNKNOWN_STATE_VARIABLE"],
  ];
  for (const [input, reason] of cases) {
    await assert.rejects(
      () => synthesizeLedger(input, SPEC, { llm: new FakeLlm() }),
      (error: unknown) => error instanceof LedgerContractError && error.reason === reason,
    );
  }
});

test("M4: 報告（元の記録）を書き換えない", async () => {
  const input = await report([COVER, OVERLAP_12, OVERLAP_13, UNREACH, DEADLOCK]);
  const before = JSON.stringify(input);
  const catalog = await synthesizeLedger(input, SPEC, { llm: new FakeLlm() });
  (catalog.issues[0]?.trace?.[0] as TraceStep).values["v1"] = "changed";
  catalog.basis.conditions.maxSteps = 99;
  assert.equal(JSON.stringify(input), before);
});