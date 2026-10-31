// 流れ図のグラフと層の配置のテスト（SpecViewer 基本設計 3.2・6.4・6.9）。
// flow.mmd は SpecProjector の renderFlow で作り、parseFlow で戻す。

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderFlow } from "../src/core/m5/render_flow.js";
import type { ViewModel } from "../src/core/m5/view_model.js";
import { buildFlowView, layoutLayers, parseFlow, unescapeMermaidLabel } from "../src/viewer/graph.js";
import type { GraphEdge, GraphLayout } from "../src/viewer/types.js";

/** 流れ図に要る値だけを埋めたビューモデル。文に Mermaid で置き換えられる記号と改行を入れる。 */
function model(ledgerIsStale: boolean | null): ViewModel {
  return {
    displayId: "S-01",
    title: "S-01 開く",
    titleNote: "",
    viewRole: "BUSINESS",
    intent: null,
    specSourceHash: "h",
    ledgerReportId: null,
    ledgerIsStale,
    stateVariables: [],
    propositions: [],
    operations: [
      {
        id: "op1",
        label: '"開く" <すでに開いている>',
        steps: [
          { kind: "CONDITION", text: "開いていない\nとき" },
          { kind: "WRITE", text: "開いている = 真" },
        ],
        outcome: "opened",
        dataMutationCount: 1,
        issueIds: ["S-01-L-001"],
      },
      { id: "op2", label: "閉じる", steps: [], outcome: "closed", dataMutationCount: 0, issueIds: [] },
    ],
    verification: null,
    issueGroups: null,
    source: "",
  };
}

/** 逆向きでないつながりは上の層から下の層へ、逆向きのつながりは下の層から上の層へ向かう。 */
function assertDownward(layout: GraphLayout, edges: readonly GraphEdge[]): void {
  edges.forEach((edge, index) => {
    if (edge.from === edge.to) return;
    const from = layout.layerOf[edge.from] ?? -1;
    const to = layout.layerOf[edge.to] ?? -1;
    if (layout.reversed[index] === true) assert.ok(from > to, `つながり ${index} が上へ向かっていない`);
    else assert.ok(to > from, `つながり ${index} が下へ向かっていない`);
  });
}

test("renderFlow の出力のノードとつながりが、文を戻してすべて読める", () => {
  const read = parseFlow(renderFlow(model(true)));
  assert.equal(read.kind, "OK");
  if (read.kind !== "OK") return;
  assert.deepEqual(read.notes, ["注意: 論点カタログは、いまの形式仕様正本とは別の版から作った。"]);
  assert.deepEqual(
    read.nodes.map((node) => [node.kind, node.label]),
    [
      ["START", "シナリオ S-01 の起点"],
      ["OPERATION", '操作: "開く" <すでに開いている>'],
      ["STEP", "条件: 開いていない とき"],
      ["STEP", "書き込み: 開いている = 真"],
      ["RESULT", "結果: opened（状態として検証していない変更 1 件。未決の論点: S-01-L-001）"],
      ["OPERATION", "操作: 閉じる"],
      ["RESULT", "結果: closed"],
    ],
  );
  const label = (index: number): string => read.nodes[index]?.label ?? "";
  assert.deepEqual(
    read.edges.map((edge) => [label(edge.from), label(edge.to)]),
    [
      ["シナリオ S-01 の起点", '操作: "開く" <すでに開いている>'],
      ['操作: "開く" <すでに開いている>', "条件: 開いていない とき"],
      ["条件: 開いていない とき", "書き込み: 開いている = 真"],
      ["書き込み: 開いている = 真", "結果: opened（状態として検証していない変更 1 件。未決の論点: S-01-L-001）"],
      ["シナリオ S-01 の起点", "操作: 閉じる"],
      ["操作: 閉じる", "結果: closed"],
    ],
  );
  // 注意の行は論点カタログが古いときだけ
  const fresh = parseFlow(renderFlow(model(false)));
  assert.ok(fresh.kind === "OK" && fresh.notes.length === 0);
});

test("流れ図の配置は決定論的で、つながりは上の層から下の層へ向かう", () => {
  const text = renderFlow(model(null));
  const view = buildFlowView(text);
  assert.equal(view.kind, "OK");
  if (view.kind !== "OK") return;
  assert.deepEqual(buildFlowView(text), view);
  assert.ok(view.layout.reversed.every((r) => r === false));
  assertDownward(view.layout, view.edges);
  // 起点だけが最も上の層にあり、操作は 2 段目に並びの順で並ぶ
  assert.deepEqual(view.layout.layers[0], [0]);
  assert.deepEqual(view.layout.layers[1], [1, 5]);
  // 層と並びの位置の配列は、layers と食い違わない
  view.layout.layers.forEach((members, layer) => {
    members.forEach((node, order) => {
      assert.equal(view.layout.layerOf[node], layer);
      assert.equal(view.layout.orderOf[node], order);
    });
  });
  // ビューモデルには flow.mmd のノードの識別子（形式仕様の操作の識別子）が入らない
  assert.ok(!JSON.stringify(view).includes("op1"));
});

test("閉路があるときは、戻るつながりを逆向きにして層に並べる", () => {
  const edges: GraphEdge[] = [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 2, to: 0 },
    { from: 1, to: 1 },
    { from: 3, to: 2 },
  ];
  const layout = layoutLayers(4, edges);
  assert.deepEqual(layout.reversed, [false, false, true, false, false]);
  assert.deepEqual(layout.layerOf, [0, 1, 2, 0]);
  assertDownward(layout, edges);
  assert.deepEqual(layoutLayers(4, edges), layout);
  // つながりの元が無いノードどうしは、ノードの並びの順に置く
  assert.deepEqual(layout.layers[0], [0, 3]);
  assert.deepEqual(layoutLayers(0, []), { layerOf: [], orderOf: [], layers: [], reversed: [] });
});

test("SpecProjector の流れ図に無い書き方は、行の番号を付けて読めないと返す", () => {
  const text = renderFlow(model(null));
  const cases = [
    { text: text.replace("flowchart TD", "graph LR"), line: 1 },
    { text: `${text}  op1_0 -.-> op1_r\n`, line: text.split("\n").length },
    { text: `${text}  op1_0 --> op9_0\n`, line: text.split("\n").length },
    { text: `${text}  op1_0["もう一度"]\n`, line: text.split("\n").length },
  ];
  for (const c of cases) {
    const read = parseFlow(c.text);
    assert.equal(read.kind, "UNREADABLE");
    if (read.kind !== "UNREADABLE") continue;
    assert.ok(read.reason.startsWith(`流れ図の ${c.line} 行目を読めない: `), read.reason);
    // 理由に形式仕様の識別子を出さない
    assert.ok(!read.reason.includes("op1") && !read.reason.includes("op9"));
  }
});

test("Mermaid の文の置き換えを 1 回で戻す", () => {
  assert.equal(unescapeMermaidLabel("#quot;a#quot; #lt;b#gt;"), '"a" <b>');
  // 戻した文字が次の置き換えに巻き込まれない（「<quot;」は #lt;quot; と書かれる）
  assert.equal(unescapeMermaidLabel("#lt;quot;"), "<quot;");
  assert.equal(unescapeMermaidLabel("# と #amp;"), "# と #amp;");
});