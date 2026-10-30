// M5（SpecProjector）のテスト（M5 の設計 2〜4・8、仕様 3）。形式仕様・論点カタログ・辞書・意図の候補は手で組む。
// 本物のエンジンの結果からの射影は tests/m3_alloy_integration.test.ts（ALLOY_JAR があるときだけ走る）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectSpecification } from "../src/core/spec_projector.js";
import { stepText } from "../src/core/m5/sentences.js";
import { sha256Hex } from "../src/lib/sha256.js";
import type { LlmText } from "../src/types/index.js";
import type { FormalSpecification, OperationStep } from "../src/types/formal.js";
import type { Glossary, GlossaryTerm } from "../src/types/glossary.js";
import type { IntentCatalog } from "../src/types/intent.js";
import type { DomainLedgerCatalog, LedgerIssue } from "../src/types/ledger.js";
import {
  ProjectionContractError,
  type ProjectionContext,
  type ProjectionRequest,
  type ScenarioViewFormat,
  type ViewRole,
} from "../src/types/projection.js";
import type { ScenarioTarget } from "../src/types/scenario.js";


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

// シナリオの内部の識別子は、実際には起点のファイルと関数を含む（"SCN-<ファイル>#<関数>"）。
// ビューに出ないことを確かめるため、テストでもその形にする。
const SCENARIO_ID = "SCN-src/order.ts#closeOrder";

const SPEC: FormalSpecification = {
  scenarioId: SCENARIO_ID,
  source: SOURCE,
  stateVariables: [
    { id: "v1", unitId: "src/order.ts:3:7:STATE", name: "status", domain: "ENUM", values: ["v1_1", "v1_2", "v1_unknown"], valueLiterals: { v1_1: '"open"', v1_2: '"closed"' }, initial: "v1_1" },
    { id: "v2", unitId: "src/order.ts:4:7:STATE", name: "retryCount", domain: "INT", values: [], valueLiterals: {}, initial: "0" },
    { id: "v3", unitId: "src/order.ts:5:7:STATE", name: "locked", domain: "BOOL", values: [], valueLiterals: {}, initial: null },
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

const INLET_ID = "CMD-src/order.ts#closeOrder";

const SCENARIO: ScenarioTarget = {
  id: SCENARIO_ID,
  boundedContext: "DEFAULT_CONTEXT",
  origin: "EXTRACTED",
  inletType: "COMMAND",
  inletTrigger: { id: INLET_ID, handler: { file: "src/order.ts", symbol: "closeOrder", line: 3 } },
  actor: { id: "Caller", name: "Caller" },
  expectedEvent: "EVT-src/order.ts#closeOrder",
};

const BASIS = { mapHash: "a".repeat(64), documentsHash: "b".repeat(64) };

function glossaryWith(term: GlossaryTerm): Glossary {
  return {
    entries: [
      {
        id: INLET_ID,
        kind: "COMMAND",
        scope: "PRESENTED",
        term,
        implementation: { names: ["closeOrder"], locations: [{ file: "src/order.ts", symbol: "closeOrder", line: 3 }] },
        sources: [],
        contextId: null,
        crossesTo: null,
        termStatus: term.status === "GENERATED" ? "CANDIDATE" : "NOT_GENERATED",
        excerpt: null,
      },
    ],
    gaps: { undocumentedEntries: [], unmatchedDocumentNames: [], sharedTerms: [], contextHomonyms: [], multiSourceEntries: [] },
    documents: { read: [], truncated: [], omitted: [] },
    basis: BASIS,
  };
}

const GLOSSARY = glossaryWith({ status: "GENERATED", term: "CloseOrder", label: "注文の締め", recordKey: "term-1" });

function intentsWith(intent: LlmText, userIntent?: string): IntentCatalog {
  return {
    contexts: [],
    scenarios: [{ scenarioId: SCENARIO_ID, intent, intentStatus: "CANDIDATE", ...(userIntent === undefined ? {} : { userIntent }) }],
    basis: BASIS,
  };
}

const CONTEXT: ProjectionContext = {
  scenario: SCENARIO,
  glossary: GLOSSARY,
  intents: intentsWith(generated("受付中の注文を締め切り、それ以上の変更を止める")),
};

function issue(overrides: Partial<LedgerIssue> = {}): LedgerIssue {
  return {
    id: `LEDGER-${SCENARIO_ID}-001`,
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
    scenarioId: SCENARIO_ID,
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

function request(format: ScenarioViewFormat, viewRole: ViewRole = "PdM"): ProjectionRequest {
  return { format, viewRole, displayId: "S-01" };
}

const DOCUMENT = request("DOCUMENT");
const IDENTIFIER = /\b(?:v\d+(?:_\d+|_unknown)?|c\d+|op\d+(?:_guard)?|o\d+|m3_\w+)\b/;
const FORBIDDEN = ["健全", "証明済み", "問題なし", "採択済み", "合意済み"];
/** PdM の出力に出てはいけない実装の名前と内部の識別子。 */
const IMPLEMENTATION = ["SCN-", "LEDGER-", "src/order.ts", "closeOrder", "@source"];

function bodyOf(markdown: string): string {
  const index = markdown.indexOf("## 付録");
  return index < 0 ? markdown : markdown.slice(0, index);
}

test("M5: 仕様書は決定論的で、末尾は改行 1 つ", async () => {
  const ledger = await catalog();
  const a = await projectSpecification(SPEC, ledger, CONTEXT, DOCUMENT);
  const b = await projectSpecification(SPEC, ledger, CONTEXT, DOCUMENT);
  assert.equal(a.content, b.content);
  assert.ok(a.content.endsWith("\n") && !a.content.endsWith("\n\n"));
  assert.equal(a.mediaType, "text/markdown");
  assert.equal(a.scenarioId, SCENARIO_ID);
  assert.equal(a.displayId, "S-01");
  assert.equal(a.viewRole, "PdM");
  assert.equal(a.basis.specSourceHash, await sha256Hex(SOURCE));
  assert.equal(a.basis.ledgerReportId, "REPORT-1");
  assert.equal(a.basis.ledgerIsStale, false);
});

test("M5: 仕様書に状態変数・命題・操作・論点がすべて表示名で出て、識別子と禁止語が出ない", async () => {
  const view = await projectSpecification(SPEC, await catalog(), CONTEXT, DOCUMENT);
  const body = bodyOf(view.content);
  for (const label of ["注文の状態", "試行回数", "確認済み \\| 印", "強制の指定", "注文を締める", "S-01-L-001"]) {
    assert.ok(body.includes(label), `${label} が無い`);
  }
  assert.doesNotMatch(body, IDENTIFIER);
  for (const word of FORBIDDEN) assert.ok(!view.content.includes(word), `${word} が出た`);
  assert.ok(body.includes("- 状態: 未決"));
  assert.ok(body.includes("選択肢（候補。どれも採択していない）"));
  assert.ok(body.includes("状態として検証していない変更: 1 件"));
  assert.ok(body.includes("反例を 1 件だけ返す検査（ほかの反例があっても出ない）: どの操作の条件も成り立たない状態を探す検査"));
  assert.ok(body.includes("不変条件の検査はしていない"));
  assert.ok(body.includes("論点 1 件（元の反例 2 件をまとめたもの）"));
  assert.ok(body.includes("従属する反例: 1 件"));
});

test("M5: PdM の仕様書・一覧表・流れ図に、実装の名前と内部の識別子が出ない（全体設計 2.2）", async () => {
  const ledger = await catalog();
  for (const format of ["DOCUMENT", "MATRIX", "FLOW"] as const) {
    const view = await projectSpecification(SPEC, ledger, CONTEXT, request(format));
    for (const name of IMPLEMENTATION) assert.ok(!view.content.includes(name), `${format} に ${name} が出た`);
  }
  const document = await projectSpecification(SPEC, ledger, CONTEXT, DOCUMENT);
  assert.ok(!document.content.includes("## 付録"));
});

test("M5: 題は「表示の id と起点の用語」で、用語が無ければ「名前は未生成」（設計 4.1・8.2）", async () => {
  const view = await projectSpecification(SPEC, null, CONTEXT, DOCUMENT);
  assert.ok(view.content.startsWith("# 仕様書: S-01 注文の締め\n"));
  const matrix = await projectSpecification(SPEC, null, CONTEXT, request("MATRIX"));
  assert.ok(matrix.content.startsWith("# 操作の一覧表: S-01 注文の締め\n"));

  const notGenerated = glossaryWith({ status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: "closeOrder を含む詳細" });
  for (const glossary of [notGenerated, null]) {
    const other = await projectSpecification(SPEC, null, { ...CONTEXT, glossary }, DOCUMENT);
    assert.ok(other.content.startsWith("# 仕様書: S-01（名前は未生成）\n"));
    assert.ok(!other.content.includes("closeOrder"));
  }
});

test("M5: 流れ図の起点は表示の id で書く（設計 7.4）", async () => {
  const view = await projectSpecification(SPEC, null, CONTEXT, request("FLOW"));
  assert.ok(view.content.includes('s["シナリオ S-01 の起点"]'));
});

test("M5: 意図の候補の節は検証の状態の後に置き、候補であることを書く（設計 4.1）", async () => {
  const view = await projectSpecification(SPEC, await catalog(), CONTEXT, DOCUMENT);
  const intent = view.content.indexOf("## 意図の候補");
  assert.ok(view.content.indexOf("## 検証の状態") < intent && intent < view.content.indexOf("## 状態\n"));
  assert.ok(view.content.includes("まだ人が確かめていない。"));
  assert.ok(view.content.includes("- 候補: 受付中の注文を締め切り、それ以上の変更を止める"));
  assert.ok(!view.content.includes("利用者が書いた目的"));

  const missing = await projectSpecification(SPEC, null, { ...CONTEXT, intents: null }, DOCUMENT);
  assert.ok(missing.content.includes("## 意図の候補\n\n意図の候補が無い。\n"));
  const other = await projectSpecification(SPEC, null, { ...CONTEXT, intents: { ...intentsWith(NOT_GENERATED), scenarios: [] } }, DOCUMENT);
  assert.ok(other.content.includes("意図の候補が無い。"));

  const notGenerated = await projectSpecification(SPEC, null, { ...CONTEXT, intents: intentsWith(NOT_GENERATED, "締め切りを強制できるようにする") }, DOCUMENT);
  assert.ok(notGenerated.content.includes("- 候補: 未生成（LLM に届かなかった）"));
  assert.ok(notGenerated.content.includes("- 利用者が書いた目的: 締め切りを強制できるようにする"));
  assert.ok(!notGenerated.content.includes("op1 を含む詳細"));
});

test("M5: Eng のときは題に所在を併記し、付録を載せる（設計 8.3）", async () => {
  const view = await projectSpecification(SPEC, null, CONTEXT, request("DOCUMENT", "Eng"));
  assert.equal(view.viewRole, "Eng");
  assert.ok(view.content.startsWith("# 仕様書: S-01 注文の締め（`src/order.ts#closeOrder` L3）\n"));
  assert.ok(view.content.includes("## 付録: 形式仕様のソース"));
  const matrix = await projectSpecification(SPEC, null, CONTEXT, request("MATRIX", "Eng"));
  assert.ok(matrix.content.startsWith("# 操作の一覧表: S-01 注文の締め（`src/order.ts#closeOrder` L3）\n"));
  // 本文の文は役割で変えない
  const pdm = await projectSpecification(SPEC, null, CONTEXT, DOCUMENT);
  // 題の行を除き、末尾の空行をそろえる（Eng は付録の見出しの前に空行が 1 つ入る）
  const strip = (text: string): string => bodyOf(text).split("\n").slice(1).join("\n").replace(/\n+$/, "\n");
  assert.equal(strip(view.content), strip(pdm.content));
});

test("M5: 付録のソースは @source の行を除き、囲みはバッククォートの並びより長い", async () => {
  const view = await projectSpecification(SPEC, null, CONTEXT, request("DOCUMENT", "Eng"));
  const appendix = view.content.slice(view.content.indexOf("## 付録"));
  assert.ok(appendix.includes("`````alloy\n"));
  assert.ok(appendix.includes("pred op1_guard"));
  assert.ok(!appendix.includes("@source"));
});

test("M5: 検証の状態は論点より前に書く", async () => {
  const view = await projectSpecification(SPEC, await catalog(), CONTEXT, DOCUMENT);
  assert.ok(view.content.indexOf("## 検証の状態") < view.content.indexOf("## 論点"));
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
  const view = await projectSpecification(SPEC, ledger, CONTEXT, DOCUMENT);
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
  const view = await projectSpecification(SPEC, await catalog({}, []), CONTEXT, DOCUMENT);
  assert.ok(view.content.includes("指定のスコープの中で、行った検査では見つからなかった"));
  assert.ok(view.content.includes("スコープ 3、整数のビット幅 4、ステップ数の上限 10"));
  assert.ok(view.content.includes("論点は無い。"));
});

test("M5: カタログが古いときは先頭で知らせ、論点は消さない", async () => {
  const ledger = await catalog();
  ledger.basis.specSourceHash = "0".repeat(64);
  const view = await projectSpecification(SPEC, ledger, CONTEXT, DOCUMENT);
  assert.equal(view.basis.ledgerIsStale, true);
  const notice = view.content.indexOf("別の版から作った");
  assert.ok(notice > 0 && notice < view.content.indexOf("## 検証の状態"));
  assert.ok(view.content.includes("S-01-L-001"));
});

test("M5: カタログが無いときは、そのことを書き、basis は null", async () => {
  const view = await projectSpecification(SPEC, null, CONTEXT, DOCUMENT);
  assert.ok(view.content.includes("論点カタログが無いので、検証の状態は分からない"));
  assert.ok(view.content.includes("論点カタログが無い（M4 を実行していない）"));
  assert.equal(view.basis.ledgerReportId, null);
  assert.equal(view.basis.ledgerIsStale, null);
});

test("M5: 表示名と論点の文が未生成なら、そのまま「未生成」と書き、detail は出さない", async () => {
  const spec: FormalSpecification = { ...SPEC, labels: { ...SPEC.labels, v1_2: NOT_GENERATED, op2: NOT_GENERATED } };
  const view = await projectSpecification(spec, await catalog({}, [issue({ claim: NOT_GENERATED })]), CONTEXT, DOCUMENT);
  assert.ok(view.content.includes("v1_2（表示名は未生成）"));
  assert.ok(view.content.includes("### op2（表示名は未生成）"));
  assert.ok(view.content.includes("- 主張: 未生成（LLM に届かなかった）"));
  assert.ok(!view.content.includes("op1 を含む詳細"));
});

test("M5: 実行列は時点ごとに表示名で書く", async () => {
  const view = await projectSpecification(SPEC, await catalog(), CONTEXT, DOCUMENT);
  assert.ok(view.content.includes("| 0 | 注文の状態: 受付中、試行回数: 0、確認済み \\| 印: 偽 | まだ操作していない | なし |"));
  assert.ok(view.content.includes("| 1 | 注文の状態: 締め切り済み、試行回数: 1、確認済み \\| 印: 真 | 締めた結果（戻り値を返して終わる） | 強制の指定 |"));
});

test("M5: 論点の表示の id はカタログの並びに S-01-L-001 から振る", async () => {
  const second = issue({ id: `LEDGER-${SCENARIO_ID}-002`, kind: "DEADLOCK", operations: ["op1"] });
  const view = await projectSpecification(SPEC, await catalog({}, [issue(), second]), CONTEXT, DOCUMENT);
  // 見出しは DEADLOCK が先でも、番号はカタログの並び
  assert.ok(view.content.indexOf("#### S-01-L-002") < view.content.indexOf("#### S-01-L-001"));
  assert.ok(view.content.includes("- 関わる論点: S-01-L-001、S-01-L-002"));
});

test("M5: 操作の一覧表はすべての操作を行にし、セルの | を逃がす", async () => {
  const view = await projectSpecification(SPEC, await catalog(), CONTEXT, request("MATRIX"));
  assert.equal(view.mediaType, "text/markdown");
  const rows = view.content.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| 表示名") && !line.startsWith("| :--"));
  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.startsWith("| 注文を締める | (1) 注文の状態が受付中である；(3) 試行回数が 3 より小さい |"));
  assert.ok(rows[0]!.includes("| 1 件 | S-01-L-001 |"));
  assert.doesNotMatch(view.content, IDENTIFIER);
});

test("M5: 操作の流れ図は Mermaid で、表示する文の \" を置き換える", async () => {
  const view = await projectSpecification(SPEC, await catalog(), CONTEXT, request("FLOW"));
  assert.equal(view.mediaType, "text/vnd.mermaid");
  assert.ok(view.content.startsWith("flowchart TD\n"));
  assert.ok(view.content.includes('op2_0["操作: 締めを断る #quot;強制#quot;"]'));
  assert.ok(view.content.includes("op1_r"));
  assert.ok(view.content.includes("未決の論点: S-01-L-001"));
  const labels = [...view.content.matchAll(/\["([^"]*)"\]/g)].map((match) => match[1]!).join("\n");
  assert.doesNotMatch(labels, IDENTIFIER);
});

test("M5: 同じ項目は、どのビューでも同じ表示名", async () => {
  const ledger = await catalog();
  for (const format of ["DOCUMENT", "MATRIX", "FLOW"] as const) {
    const view = await projectSpecification(SPEC, ledger, CONTEXT, request(format));
    assert.ok(view.content.includes("注文を締める"), format);
    assert.ok(view.content.includes("締めた結果（戻り値を返して終わる）"), format);
  }
});

test("M5: 射影は入力を変えない", async () => {
  const spec = structuredClone(SPEC);
  const ledger = await catalog();
  const before = structuredClone(ledger);
  const context = structuredClone(CONTEXT);
  await projectSpecification(spec, ledger, context, DOCUMENT);
  assert.deepEqual(spec, SPEC);
  assert.deepEqual(ledger, before);
  assert.deepEqual(context, CONTEXT);
});

test("M5: 契約の違反", async () => {
  const reason = (expected: string) => (error: unknown) => error instanceof ProjectionContractError && error.reason === expected;
  await assert.rejects(projectSpecification(SPEC, await catalog({ scenarioId: "SCN-2" }), CONTEXT, DOCUMENT), reason("SCENARIO_MISMATCH"));
  await assert.rejects(
    projectSpecification(SPEC, null, { ...CONTEXT, scenario: { ...SCENARIO, id: "SCN-2" } }, DOCUMENT),
    reason("SCENARIO_MISMATCH"),
  );
  await assert.rejects(projectSpecification(SPEC, await catalog({}, [issue({ operations: ["op9"] })]), CONTEXT, DOCUMENT), reason("UNKNOWN_OPERATION"));
  const badTrace = issue({ trace: [{ index: 0, values: { v9: 1 }, outcome: "Idle", holds: [] }] });
  await assert.rejects(projectSpecification(SPEC, await catalog({}, [badTrace]), CONTEXT, DOCUMENT), reason("UNKNOWN_STATE_VARIABLE"));
  await assert.rejects(
    projectSpecification(SPEC, null, CONTEXT, { ...DOCUMENT, format: "SEQUENCE" } as unknown as ProjectionRequest),
    reason("UNSUPPORTED_FORMAT"),
  );
  await assert.rejects(
    projectSpecification(SPEC, null, CONTEXT, { ...DOCUMENT, viewRole: "Admin" } as unknown as ProjectionRequest),
    reason("UNSUPPORTED_FORMAT"),
  );
});