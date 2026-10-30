// M5 の曖昧さの一覧（AMBIGUITY_DOCUMENT。SpecProjector の設計 8.4）のテスト。報告・辞書は手で組む。

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectAmbiguities } from "../src/core/spec_projector.js";
import type { LlmText } from "../src/types/index.js";
import type { AmbiguityReport } from "../src/types/formal.js";
import type { Glossary } from "../src/types/glossary.js";
import {
  ProjectionContractError,
  type AmbiguityProjectionRequest,
  type ProjectionContext,
  type ViewRole,
} from "../src/types/projection.js";
import type { ScenarioTarget } from "../src/types/scenario.js";

// シナリオの内部の識別子は、実際には起点のファイルと関数を含む。ビューに出ないことを確かめるため、その形にする。
const SCENARIO_ID = "SCN-src/pay.ts#charge";
const INLET_ID = "CMD-src/pay.ts#charge";

const SCENARIO: ScenarioTarget = {
  id: SCENARIO_ID,
  boundedContext: "DEFAULT_CONTEXT",
  origin: "EXTRACTED",
  inletType: "COMMAND",
  inletTrigger: { id: INLET_ID, handler: { file: "src/pay.ts", symbol: "charge", line: 2 } },
  actor: { id: "Caller", name: "Caller" },
  expectedEvent: "EVT-src/pay.ts#charge",
};

const GLOSSARY: Glossary = {
  entries: [
    {
      id: INLET_ID,
      kind: "COMMAND",
      scope: "PRESENTED",
      term: { status: "GENERATED", term: "Charge", label: "支払いの請求", recordKey: "term-1" },
      implementation: { names: ["charge"], locations: [{ file: "src/pay.ts", symbol: "charge", line: 2 }] },
      sources: [],
      contextId: "DEFAULT_CONTEXT",
      crossesTo: null,
      termStatus: "CANDIDATE",
      excerpt: null,
    },
  ],
  gaps: { undocumentedEntries: [], unmatchedDocumentNames: [], sharedTerms: [], contextHomonyms: [], multiSourceEntries: [] },
  documents: { read: [], truncated: [], omitted: [] },
  basis: { mapHash: "a".repeat(64), documentsHash: "b".repeat(64) },
};

const NOT_GENERATED: LlmText = { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: "compute を含む詳細" };

const REPORT: AmbiguityReport = {
  scenarioId: SCENARIO_ID,
  issues: [
    {
      kind: "UNDETERMINED_VALUE",
      unitIds: ["src/pay.ts:3:3:STATE_WRITE"],
      location: { file: "src/pay.ts", line: 3, column: 3 },
      detail: "state = compute(x)",
      question: { status: "GENERATED", text: "請求額はどう決まりますか。", recordKey: "q-1" },
      questionStatus: "CANDIDATE",
    },
    {
      kind: "EXTERNAL_EFFECT",
      unitIds: ["src/pay.ts:4:3:EXTERNAL_CALL"],
      location: { file: "src/pay.ts", line: 4, column: 3 },
      detail: "save(`a` + ``b``)",
      question: NOT_GENERATED,
      questionStatus: "NOT_GENERATED",
    },
  ],
  counts: { UNDETERMINED_VALUE: 1, EXTERNAL_EFFECT: 1, CONFLICTING_SLICES: 0 },
};

const CONTEXT: ProjectionContext = { scenario: SCENARIO, glossary: GLOSSARY, intents: null };

function request(viewRole: ViewRole = "PdM"): AmbiguityProjectionRequest {
  return { format: "AMBIGUITY_DOCUMENT", viewRole, displayId: "S-02" };
}

test("M5 曖昧さ: 題・件数・表示の id・質問を書き、PdM には所在・原文・内部の識別子を出さない（設計 8.4）", async () => {
  const view = await projectAmbiguities(REPORT, CONTEXT, request());
  assert.equal(view.format, "AMBIGUITY_DOCUMENT");
  assert.equal(view.mediaType, "text/markdown");
  assert.equal(view.scenarioId, SCENARIO_ID);
  assert.equal(view.displayId, "S-02");
  assert.equal(view.viewRole, "PdM");
  assert.deepEqual(view.basis, { specSourceHash: null, ledgerReportId: null, ledgerIsStale: null });

  const content = view.content;
  assert.ok(content.startsWith("# S-02 支払いの請求 の曖昧さ\n"), content);
  assert.ok(content.includes("- 値が決まらない: 1 件\n- 外部への作用がある: 1 件\n- 同じ条件で別の経路に進む: 0 件\n"));
  assert.ok(content.includes("### S-02-A-001\n\n- 種類: 値が決まらない\n- 質問: 請求額はどう決まりますか。\n"));
  assert.ok(content.includes("### S-02-A-002\n\n- 種類: 外部への作用がある\n- 質問: 未生成（LLM の出力が検査を通らなかった）\n"));
  for (const hidden of ["src/pay.ts", "charge", "compute", "save(", "STATE_WRITE", "SCN-", "所在", "原文"]) {
    assert.ok(!content.includes(hidden), hidden);
  }
  assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"));
});

test("M5 曖昧さ: Eng のときは題に所在を併記し、各曖昧さに所在と原文を足す", async () => {
  const view = await projectAmbiguities(REPORT, CONTEXT, request("Eng"));
  assert.equal(view.viewRole, "Eng");
  assert.ok(view.content.startsWith("# S-02 支払いの請求（`src/pay.ts#charge` L2） の曖昧さ\n"), view.content);
  assert.ok(view.content.includes("- 所在: `src/pay.ts` L3\n\n原文:\n\n```\nstate = compute(x)\n```\n"));
  // 原文にバッククォートの並びがあれば、囲みはそれより長くする
  assert.ok(view.content.includes("原文:\n\n```\nsave(`a` + ``b``)\n```\n"));
  // 文は役割で変えない
  const pdm = await projectAmbiguities(REPORT, CONTEXT, request());
  const questions = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("- 質問: "));
  assert.deepEqual(questions(view.content), questions(pdm.content));
});

test("M5 曖昧さ: 辞書が無いか用語が未生成なら「名前は未生成」、曖昧さが 0 件ならそう書く", async () => {
  const view = await projectAmbiguities(
    { ...REPORT, issues: [], counts: { UNDETERMINED_VALUE: 0, EXTERNAL_EFFECT: 0, CONFLICTING_SLICES: 0 } },
    { ...CONTEXT, glossary: null },
    request(),
  );
  assert.ok(view.content.startsWith("# S-02（名前は未生成） の曖昧さ\n"), view.content);
  assert.ok(view.content.includes("## 曖昧さ\n\n曖昧さは無い。\n"));
});

test("M5 曖昧さ: 入力の契約（表現形式・表示の役割・シナリオの照合）", async () => {
  const reasonOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof ProjectionContractError, String(error));
      return error.reason;
    }
    return "no error";
  };
  assert.equal(
    await reasonOf(() => projectAmbiguities(REPORT, CONTEXT, { ...request(), format: "DOCUMENT" } as unknown as AmbiguityProjectionRequest)),
    "UNSUPPORTED_FORMAT",
  );
  assert.equal(
    await reasonOf(() => projectAmbiguities(REPORT, CONTEXT, { ...request(), viewRole: "QA" } as unknown as AmbiguityProjectionRequest)),
    "UNSUPPORTED_FORMAT",
  );
  assert.equal(
    await reasonOf(() => projectAmbiguities(REPORT, { ...CONTEXT, scenario: { ...SCENARIO, id: "SCN-other" } }, request())),
    "SCENARIO_MISMATCH",
  );
});

test("M5 曖昧さ: 同じ入力から同じ出力になる", async () => {
  const first = await projectAmbiguities(REPORT, CONTEXT, request("Eng"));
  const second = await projectAmbiguities(REPORT, CONTEXT, request("Eng"));
  assert.equal(second.content, first.content);
});