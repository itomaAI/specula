// 全体地図のビューモデルのテスト（SpecViewer 基本設計 3.4・6.10）。
// viewer_glossary.test と同じく、コマンドラインの入口で一時ディレクトリに実際の出力を書き、読み戻してから組み立てる。
// この入力は Bounded Context が 1 つで、またぐポリシーも用語も出ないので、地図 1 のつながり・ポップアップ・役割は
// 俯瞰図・辞書・対応表・意図の候補を差し替えて確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { main } from "../src/cli.js";
import { EDGE_TEXT } from "../src/core/m5/render_system.js";
import { readRunOutputs } from "../src/lib/read_outputs.js";
import type { Glossary, GlossaryEntry, PresentedEntryKind } from "../src/types/glossary.js";
import type { IntentCatalog } from "../src/types/intent.js";
import type { ImplementationMap } from "../src/types/projection.js";
import type { RunReport, SystemMapBundle } from "../src/types/run.js";
import { checkRunOutputs } from "../src/viewer/check.js";
import { buildMapView } from "../src/viewer/map.js";
import type { RunOutputs } from "../src/viewer/types.js";

const OPEN_SOURCE = [
  "let open = false;",
  "export function openIt() {",
  "  if (open) {",
  '    return "already";',
  "  }",
  "  open = true;",
  '  return "opened";',
  "}",
  "",
].join("\n");

const REPO: Record<string, string> = {
  "src/index.ts": 'export { openIt } from "./a.js";\n',
  "src/a.ts": OPEN_SOURCE,
};

const fs = new NodeFsAdapter();

async function withOutputs(body: (out: string, report: RunReport) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "specula-viewer-map-"));
  try {
    await mkdir(join(root, "repo", "src"), { recursive: true });
    for (const [path, text] of Object.entries(REPO)) await writeFile(join(root, "repo", path), text, "utf8");
    const out = join(root, "out");
    const io = { stdout: (): void => {}, stderr: (): void => {} };
    assert.equal(await main([join(root, "repo"), "--out", out], io), 0);
    const report = JSON.parse(await readFile(join(out, "run_report.json"), "utf8")) as RunReport;
    await body(out, report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function checkedOutputs(out: string): Promise<RunOutputs> {
  const outputs = await readRunOutputs(fs, out);
  assert.deepEqual(checkRunOutputs(outputs), { ok: true, problems: [] });
  return outputs;
}

test("実際の出力: 俯瞰図の要素と文をそのまま使い、地図 2 の Bounded Context は箱の題として層から外す", async () => {
  await withOutputs(async (out, report) => {
    const outputs = await checkedOutputs(out);
    assert.ok(outputs.systemMap.kind === "OK");
    const bundle = outputs.systemMap.value;
    const view = buildMapView(outputs, "BUSINESS");
    assert.ok(view.kind === "OK", JSON.stringify(view));

    assert.equal(view.startWithDetail, bundle.contextMap.nodes.length === 1);
    assert.deepEqual(
      view.contextMap.nodes.map((node) => [node.displayId, node.kind, node.label]),
      bundle.contextMap.nodes.map((node) => [node["id"], node["kind"], node["label"]]),
    );
    assert.equal(view.details.length, bundle.details.length);
    for (const [index, detail] of view.details.entries()) {
      const source = bundle.details[index]!;
      assert.equal(detail.context.displayId, source.context);
      for (const [graph, json] of [
        [detail.core, source.core],
        [detail.supporting, source.supporting],
      ] as const) {
        // 先頭の Bounded Context のノードを除いた残りが、並びのまま入る
        assert.deepEqual(
          graph.nodes.map((node) => [node.displayId, node.label]),
          json.nodes.slice(1).map((node) => [node["id"], node["label"]]),
        );
        assert.equal(graph.edges.length, json.edges.length);
        for (const edge of graph.edges) assert.equal(edge.text, EDGE_TEXT[edge.kind as keyof typeof EDGE_TEXT]);
        assert.equal(graph.layout.layerOf.length, graph.nodes.length);
        assert.equal(graph.layout.reversed.length, graph.edges.length);
      }
    }

    // Bounded Context の箱: 属するコマンドの数は実行の報告の行の数と同じ（この入力は Bounded Context が 1 つ）
    if (view.contextMap.nodes.length === 1) {
      assert.equal(view.contextMap.nodes[0]!.popup.commandTargetCount, report.commands.length);
    }
    // コマンドとポリシーの起点にしたコマンドの単位は、実行の報告にある表示の id だけ
    const known = new Set(report.commands.map((row) => row.displayId));
    const starts = view.details.flatMap((detail) => detail.core.nodes).flatMap((node) => node.popup.commands ?? []);
    assert.ok(starts.length > 0, "起点にしたコマンドの単位が 1 つも引けない");
    for (const id of starts) assert.ok(known.has(id), id);

    // BUSINESS では実装の名前と所在を持たない
    assert.ok(!JSON.stringify(view).includes("src/a.ts"));
  });
});

// ---- 差し替える入力（Bounded Context 2 つ、またぐポリシー、アクター） ----
const SECTION = "docs/a.md#概要";

function entry(id: string, kind: PresentedEntryKind, contextId: string | null, label: string, extra: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return {
    id,
    kind,
    scope: "PRESENTED",
    term: { status: "GENERATED", term: "Term", label, recordKey: `k-${id}` },
    implementation: { names: [`impl_${id}`], locations: [{ file: "src/x.ts", line: 1 }] },
    sources: [SECTION],
    contextId,
    crossesTo: null,
    termStatus: "CANDIDATE",
    excerpt: { text: `${label}の説明。`, source: SECTION, truncated: false, status: "CANDIDATE" },
    ...extra,
  };
}

const INTERNAL_IDS = ["ctxA", "ctxB", "cmdB", "polAB", "commandTarget-1"];

function syntheticGlossary(basis: Glossary["basis"]): Glossary {
  return {
    entries: [
      entry("cmdB", "COMMAND", "ctxB", "出荷を指示する"),
      entry("ctxA", "BOUNDED_CONTEXT", "ctxA", "受注"),
      entry("ctxB", "BOUNDED_CONTEXT", "ctxB", "出荷"),
      entry("polAB", "POLICY", "ctxA", "受注のあと出荷する", { crossesTo: "ctxB" }),
    ],
    gaps: { undocumentedEntries: [], unmatchedDocumentNames: [], sharedTerms: [], contextHomonyms: [], multiSourceEntries: [] },
    documents: { read: ["docs/a.md"], truncated: [], omitted: [] },
    basis,
  };
}

function syntheticImplementationMap(basis: ImplementationMap["basis"]): ImplementationMap {
  const row = (displayId: string, kind: PresentedEntryKind | "COMMAND_TARGET", internalId: string, glossaryEntryId: string) => ({
    displayId,
    kind,
    internalId,
    glossaryEntryId,
    implementation: { names: [], locations: [] },
  });
  return {
    entries: [
      row("c1", "BOUNDED_CONTEXT", "ctxA", "ctxA"),
      row("c2", "BOUNDED_CONTEXT", "ctxB", "ctxB"),
      row("n1", "COMMAND", "cmdB", "cmdB"),
      row("n2", "POLICY", "polAB", "polAB"),
      row("C-01", "COMMAND_TARGET", "commandTarget-1", "cmdB"),
    ],
    basis,
  };
}

function syntheticIntents(basis: IntentCatalog["basis"]): IntentCatalog {
  return {
    contexts: [{ contextId: "ctxB", intent: { status: "GENERATED", text: "出荷を手配する", recordKey: "k" }, intentStatus: "CANDIDATE" }],
    commands: [],
    basis,
  };
}

function syntheticSystemMap(base: SystemMapBundle, withImplementation: boolean): SystemMapBundle {
  const c1 = { id: "c1", kind: "BOUNDED_CONTEXT", label: "受注", context: null, intent: null, broken: null };
  const c2 = { id: "c2", kind: "BOUNDED_CONTEXT", label: "出荷", context: null, intent: "出荷を手配する", broken: null };
  const n1 = {
    id: "n1",
    kind: "COMMAND",
    label: "コマンド: 出荷を指示する",
    context: "出荷",
    broken: null,
    ...(withImplementation ? { implementation: { names: ["impl_cmdB"], locations: [{ file: "src/x.ts", line: 1 }] } } : {}),
  };
  const n2 = { id: "n2", kind: "POLICY", label: "ポリシー: 受注のあと出荷する", context: null, crossing: { from: "c1", to: "c2" }, broken: null };
  const n4 = { id: "n4", kind: "ACTOR", label: "アクター n4", context: null, broken: null };
  const invokes = { from: "n2", to: "n1", kind: "INVOKES", broken: null };
  return {
    ...base,
    contextMap: {
      nodes: [c1, c2],
      edges: [{ from: "c1", to: "c2", kind: "POLICY", policy: "n2", label: n2.label, broken: null }],
    },
    details: [
      { context: "c1", core: { nodes: [c1, n2], edges: [] }, supporting: { nodes: [c1, n2], edges: [] } },
      {
        context: "c2",
        core: { nodes: [c2, n1, n2], edges: [invokes] },
        supporting: { nodes: [c2, n1, n2, n4], edges: [invokes, { from: "n4", to: "n1", kind: "EXECUTES", broken: { reason: "x" } }] },
      },
    ],
  };
}

function withSynthetic(outputs: RunOutputs, options: { map: boolean; implementation: boolean }): RunOutputs {
  assert.ok(outputs.glossary.kind === "OK" && outputs.systemMap.kind === "OK" && outputs.report.kind === "OK");
  const basis = outputs.glossary.value.basis;
  const report = outputs.report.value;
  return {
    ...outputs,
    report: { kind: "OK", value: { ...report, commands: report.commands.map((row) => ({ ...row, boundedContext: "ctxB" })) } },
    glossary: { kind: "OK", value: syntheticGlossary(basis) },
    intents: { kind: "OK", value: syntheticIntents(basis) },
    implementationMap: options.map ? { kind: "OK", value: syntheticImplementationMap(basis) } : { kind: "MISSING" },
    systemMap: { kind: "OK", value: syntheticSystemMap(outputs.systemMap.value, options.implementation) },
  };
}

test("地図 1 と地図 2: またぐポリシーのつながり、箱のポップアップ、起点にしたコマンドの単位、壊れた印", async () => {
  await withOutputs(async (out, report) => {
    const view = buildMapView(withSynthetic(await checkedOutputs(out), { map: true, implementation: true }), "BUSINESS");
    assert.ok(view.kind === "OK", JSON.stringify(view));
    assert.equal(view.startWithDetail, false);

    assert.deepEqual(view.contextMap.edges, [
      { from: 0, to: 1, kind: "POLICY", text: "ポリシー: 受注のあと出荷する", policy: "n2", broken: false },
    ]);
    const [c1, c2] = view.contextMap.nodes;
    assert.equal(c1!.popup.entry?.term, "受注");
    assert.equal(c1!.popup.intent, "意図の候補が無い");
    assert.equal(c1!.popup.commandTargetCount, 0);
    assert.equal(c2!.popup.intent, "出荷を手配する");
    assert.equal(c2!.popup.commandTargetCount, report.commands.length);
    assert.equal(c2!.popup.lookupNote, null);

    const detail = view.details[1]!;
    assert.equal(detail.context.displayId, "c2");
    assert.deepEqual(
      detail.core.nodes.map((node) => node.displayId),
      ["n1", "n2"],
    );
    assert.deepEqual(detail.core.edges, [{ from: 1, to: 0, kind: "INVOKES", text: "起動する", policy: null, broken: false }]);
    // ポリシーが上、コマンドが下
    assert.deepEqual(detail.core.layout.layerOf, [1, 0]);

    const [command, policy] = detail.core.nodes;
    assert.deepEqual(command!.popup.commands, ["C-01"]);
    assert.equal(command!.popup.entry?.meaning, "出荷を指示するの説明。");
    assert.deepEqual(policy!.crossing, { from: "c1", to: "c2" });
    assert.deepEqual(policy!.popup.commands, []);
    // またぎは要素の crossing で持ち、ポップアップの項目には持たない
    assert.equal(policy!.popup.entry?.crossing, null);

    // 足す要素ありの版: アクターは JSON の文だけ。壊れた印は broken が null でないつながり
    const actor = detail.supporting.nodes[2]!;
    assert.equal(actor.label, "アクター n4");
    assert.deepEqual(actor.popup, { entry: null, entryNote: null, intent: null, commandTargetCount: null, commands: null, lookupNote: null });
    assert.deepEqual(
      detail.supporting.edges.map((edge) => [edge.text, edge.broken]),
      [
        ["起動する", false],
        ["実行する", true],
      ],
    );

    // BUSINESS: JSON に実装の名前と所在があっても持たない。内部の識別子も出ない
    assert.equal(command!.implementation, null);
    const text = JSON.stringify(view);
    assert.ok(!text.includes("impl_"));
    for (const id of INTERNAL_IDS) assert.ok(!text.includes(id), id);
  });
});

test("IMPLEMENTATION: JSON に実装の名前と所在があるときだけ持つ", async () => {
  await withOutputs(async (out) => {
    const outputs = await checkedOutputs(out);
    const withIt = buildMapView(withSynthetic(outputs, { map: true, implementation: true }), "IMPLEMENTATION");
    assert.ok(withIt.kind === "OK");
    assert.deepEqual(withIt.details[1]!.core.nodes[0]!.implementation, { names: ["impl_cmdB"], locations: [{ file: "src/x.ts", line: 1 }] });
    assert.equal(withIt.details[1]!.core.nodes[1]!.implementation, null);

    const without = buildMapView(withSynthetic(outputs, { map: true, implementation: false }), "IMPLEMENTATION");
    assert.ok(without.kind === "OK");
    assert.equal(without.details[1]!.core.nodes[0]!.implementation, null);
  });
});

test("実装との対応表が無いとき: 用語・意図の候補・起点にしたコマンドの単位を引けない理由を書く", async () => {
  await withOutputs(async (out) => {
    const view = buildMapView(withSynthetic(await checkedOutputs(out), { map: false, implementation: false }), "BUSINESS");
    assert.ok(view.kind === "OK");
    const c2 = view.contextMap.nodes[1]!;
    assert.equal(c2.popup.entry, null);
    assert.equal(c2.popup.entryNote, "用語と意味を引けない: 実装との対応表が無い");
    assert.equal(c2.popup.intent, null);
    assert.equal(c2.popup.commandTargetCount, null);
    assert.equal(c2.popup.lookupNote, "意図の候補と属するコマンドの数を引けない: 実装との対応表が無い");
    const command = view.details[1]!.core.nodes[0]!;
    assert.equal(command.popup.commands, null);
    assert.equal(command.popup.lookupNote, "起点にしたコマンドの単位を引けない: 実装との対応表が無い");
    // 地図そのものは出す
    assert.equal(command.label, "コマンド: 出荷を指示する");
  });
});

test("俯瞰図が無いとき・形が違うとき: 全体地図だけを理由にする", async () => {
  await withOutputs(async (out) => {
    const outputs = await checkedOutputs(out);
    const synthetic = withSynthetic(outputs, { map: true, implementation: false });
    assert.ok(synthetic.systemMap.kind === "OK");
    const bundle = synthetic.systemMap.value;
    const withMap = (value: unknown): RunOutputs => ({ ...synthetic, systemMap: { kind: "OK", value: value as SystemMapBundle } });

    assert.deepEqual(buildMapView({ ...synthetic, systemMap: { kind: "MISSING" } }, "BUSINESS"), {
      kind: "UNAVAILABLE",
      reason: "全体地図を出せない: 俯瞰図が無い",
    });

    const badKind = withMap({ ...bundle, contextMap: { ...bundle.contextMap, nodes: [{ ...bundle.contextMap.nodes[0], kind: "FOO" }] } });
    assert.deepEqual(buildMapView(badKind, "BUSINESS"), {
      kind: "UNAVAILABLE",
      reason: "全体地図を出せない: 俯瞰図の形が違う（地図 1 の 1 番目のノード: kind）",
    });

    const core = bundle.details[1]!.core;
    const danglingEdge = withMap({
      ...bundle,
      details: [bundle.details[0], { ...bundle.details[1], core: { ...core, edges: [{ from: "n2", to: "n9", kind: "INVOKES", broken: null }] } }],
    });
    assert.deepEqual(buildMapView(danglingEdge, "BUSINESS"), {
      kind: "UNAVAILABLE",
      reason: "全体地図を出せない: 俯瞰図の形が違う（地図 2（c2）の 1 番目のつながり: 地図に無いノードを指している）",
    });

    // 地図 2 の並びが地図 1 と違っても、地図 1 の並びに並べ替えて出す（Q12）
    const reordered = buildMapView(withMap({ ...bundle, details: [bundle.details[1], bundle.details[0]] }), "BUSINESS");
    assert.ok(reordered.kind === "OK", JSON.stringify(reordered));
    assert.deepEqual(
      reordered.details.map((detail) => detail.context.displayId),
      bundle.contextMap.nodes.map((node) => node["id"]),
    );
    assert.equal(JSON.stringify(reordered), JSON.stringify(buildMapView(withMap(bundle), "BUSINESS")));

    const missing = withMap({ ...bundle, details: [bundle.details[0]] });
    assert.deepEqual(buildMapView(missing, "BUSINESS"), {
      kind: "UNAVAILABLE",
      reason: "全体地図を出せない: 俯瞰図の形が違う（地図 2: c2 が無い）",
    });

    const duplicated = withMap({ ...bundle, details: [bundle.details[0], bundle.details[0]] });
    assert.deepEqual(buildMapView(duplicated, "BUSINESS"), {
      kind: "UNAVAILABLE",
      reason: "全体地図を出せない: 俯瞰図の形が違う（地図 2: c1 が 2 つある）",
    });
  });
});

test("全体地図: 事前条件を通っていない入力では例外を投げる", async () => {
  await withOutputs(async (out) => {
    await rm(join(out, "run_report.json"));
    const outputs = await readRunOutputs(fs, out);
    assert.throws(() => buildMapView(outputs, "BUSINESS"), /checkRunOutputs/);
  });
});