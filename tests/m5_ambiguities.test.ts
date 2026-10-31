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
import type { CommandTarget } from "../src/types/command.js";

// シナリオの内部の識別子は、実際には起点のファイルと関数を含む。ビューに出ないことを確かめるため、その形にする。
const COMMAND_ID = "CT-src/pay.ts#charge";
const INLET_ID = "CMD-src/pay.ts#charge";

const COMMAND_TARGET: CommandTarget = {
  id: COMMAND_ID,
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
  commandId: COMMAND_ID,
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

const CONTEXT: ProjectionContext = { commandTarget: COMMAND_TARGET, glossary: GLOSSARY, intents: null };

function request(viewRole: ViewRole = "BUSINESS"): AmbiguityProjectionRequest {
  return { format: "AMBIGUITY_DOCUMENT", viewRole, displayId: "C-02" };
}

test("M5 曖昧さ: BUSINESS には「エンジニアの確認待ち: N 件」と合計だけを書き、質問・種類・所在・原文を出さない（設計 8.9）", async () => {
  const view = await projectAmbiguities(REPORT, CONTEXT, request());
  assert.equal(view.format, "AMBIGUITY_DOCUMENT");
  assert.equal(view.mediaType, "text/markdown");
  assert.equal(view.commandId, COMMAND_ID);
  assert.equal(view.displayId, "C-02");
  assert.equal(view.viewRole, "BUSINESS");
  assert.deepEqual(view.basis, { specSourceHash: null, ledgerReportId: null, ledgerIsStale: null });

  const content = view.content;
  assert.ok(content.startsWith("# C-02 支払いの請求 の曖昧さ\n"), content);
  assert.ok(content.includes("## 件数\n\nエンジニアの確認待ち: 2 件\n"), content);
  for (const hidden of [
    "src/pay.ts",
    "charge",
    "compute",
    "save(",
    "STATE_WRITE",
    "CT-",
    "所在",
    "原文",
    "質問:",
    "請求額",
    "未生成",
    "値が決まらない",
    "外部への作用がある",
    "C-02-A-",
  ]) {
    assert.ok(!content.includes(hidden), hidden);
  }
  assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"));
});

test("M5 曖昧さ: IMPLEMENTATION のときは題に所在を併記し、種類ごとの件数・質問・所在・原文を書く", async () => {
  const view = await projectAmbiguities(REPORT, CONTEXT, request("IMPLEMENTATION"));
  assert.equal(view.viewRole, "IMPLEMENTATION");
  assert.ok(view.content.startsWith("# C-02 支払いの請求（`src/pay.ts#charge` L2） の曖昧さ\n"), view.content);
  assert.ok(view.content.includes("- 値が決まらない: 1 件\n- 外部への作用がある: 1 件\n- 同じ条件で別の経路に進む: 0 件\n"));
  assert.ok(view.content.includes("### C-02-A-001\n\n- 種類: 値が決まらない\n- 質問: 請求額はどう決まりますか。\n"));
  assert.ok(view.content.includes("### C-02-A-002\n\n- 種類: 外部への作用がある\n- 質問: 未生成（LLM の出力が検査を通らなかった）\n"));
  assert.ok(view.content.includes("- 所在: `src/pay.ts` L3\n\n原文:\n\n```\nstate = compute(x)\n```\n"));
  // 原文にバッククォートの並びがあれば、囲みはそれより長くする
  assert.ok(view.content.includes("原文:\n\n```\nsave(`a` + ``b``)\n```\n"));
  assert.ok(!view.content.includes("エンジニアの確認待ち"));
  assert.ok(!view.content.includes("compute を含む詳細"));
});

test("M5 曖昧さ: IMPLEMENTATION の質問の文に、確定と要再確認の印を付ける。候補と未生成には付けない（設計 8.9）", async () => {
  const [first, second] = REPORT.issues;
  const report: AmbiguityReport = {
    ...REPORT,
    issues: [
      { ...first!, questionStatus: "CONFIRMED" },
      { ...second!, question: { status: "GENERATED", text: "保存先はどこですか。", recordKey: "q-2" }, questionStatus: "NEEDS_RECHECK" },
    ],
  };
  const view = await projectAmbiguities(report, CONTEXT, request("IMPLEMENTATION"));
  assert.ok(view.content.includes("- 質問: 請求額はどう決まりますか。（確定）\n"));
  assert.ok(view.content.includes("- 質問: 保存先はどこですか。（要再確認）\n"));

  const plain = await projectAmbiguities(REPORT, CONTEXT, request("IMPLEMENTATION"));
  assert.ok(!plain.content.includes("（確定）") && !plain.content.includes("（要再確認）") && !plain.content.includes("（候補）"));
});

test("M5 曖昧さ: 辞書が無いか用語が未生成なら「名前は未生成」、曖昧さが 0 件ならそう書く", async () => {
  const empty: AmbiguityReport = { ...REPORT, issues: [], counts: { UNDETERMINED_VALUE: 0, EXTERNAL_EFFECT: 0, CONFLICTING_SLICES: 0 } };
  const view = await projectAmbiguities(empty, { ...CONTEXT, glossary: null }, request("IMPLEMENTATION"));
  assert.ok(view.content.startsWith("# C-02（名前は未生成） の曖昧さ\n"), view.content);
  assert.ok(view.content.includes("## 曖昧さ\n\n曖昧さは無い。\n"));

  const pdm = await projectAmbiguities(empty, { ...CONTEXT, glossary: null }, request());
  assert.ok(pdm.content.startsWith("# C-02（名前は未生成） の曖昧さ\n"), pdm.content);
  assert.ok(pdm.content.includes("エンジニアの確認待ち: 0 件\n"));
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
    await reasonOf(() => projectAmbiguities(REPORT, { ...CONTEXT, commandTarget: { ...COMMAND_TARGET, id: "CT-other" } }, request())),
    "COMMAND_MISMATCH",
  );
});

test("M5 曖昧さ: 同じ入力から同じ出力になる", async () => {
  const first = await projectAmbiguities(REPORT, CONTEXT, request("IMPLEMENTATION"));
  const second = await projectAmbiguities(REPORT, CONTEXT, request("IMPLEMENTATION"));
  assert.equal(second.content, first.content);
});