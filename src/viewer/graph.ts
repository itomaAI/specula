// 流れ図と地図のグラフ（SpecViewer 基本設計 3.2・3.4・6.4・6.9）。
// 純粋な関数。flow.mmd（SpecProjector の render_flow.ts が出す範囲）をグラフに戻すことと、
// ノードを層に並べる配置（決定論的）を受け持つ。描く側は配置の結果を SVG にするだけにする（設計 6.4）。
// ノードは並びの位置（0 から）で指す。flow.mmd のノードの識別子は形式仕様の操作の識別子（op1 など）を含むので、
// ビューモデルに入れない（設計 4 節・6.9）。

import type { FlowGraphRead, FlowNode, FlowNodeKind, FlowView, GraphEdge, GraphLayout } from "./types.js";

const HEADER = "flowchart TD";
const NODE_LINE = /^\s*([A-Za-z][A-Za-z0-9_]*)\["(.*)"\]\s*$/;
const EDGE_LINE = /^\s*([A-Za-z][A-Za-z0-9_]*) --> ([A-Za-z][A-Za-z0-9_]*)\s*$/;
const COMMENT_LINE = /^\s*%%\s?(.*)$/;
// render_flow.ts のノードの識別子: 起点は s、操作ごとに <操作>_0（操作）、<操作>_1 …（条件と書き込み）、<操作>_r（結果）。
const STEP_ID = /^[A-Za-z][A-Za-z0-9]*_(0|[1-9][0-9]*|r)$/;

/**
 * mermaidLabel（escape.ts）の逆。`#quot;`・`#lt;`・`#gt;` を `"`・`<`・`>` に戻す。
 * 1 回の置き換えで戻すので、戻した文字が次の置き換えに巻き込まれることはない。
 * mermaidLabel は `#` を逃がさないため、文にもともと「#quot;」と書いてあれば `"` に戻る（設計 6.9 の限界）。
 * 改行は空白にされているので戻せない。
 */
export function unescapeMermaidLabel(text: string): string {
  return text.replace(/#(quot|lt|gt);/g, (_match, name: string) => (name === "quot" ? '"' : name === "lt" ? "<" : ">"));
}

function flowNodeKind(id: string): FlowNodeKind | null {
  if (id === "s") return "START";
  const step = STEP_ID.exec(id);
  if (step === null) return null;
  if (step[1] === "0") return "OPERATION";
  if (step[1] === "r") return "RESULT";
  return "STEP";
}

function unreadable(line: number, what: string): FlowGraphRead {
  // 理由にはノードの識別子を入れない（形式仕様の識別子を含むため）。行の番号で場所を示す。
  return { kind: "UNREADABLE", reason: `流れ図の ${line} 行目を読めない: ${what}` };
}

/**
 * flow.mmd をグラフに戻す。読むのは render_flow.ts が出す行だけである（1 行目の「flowchart TD」、
 * 「%%」の注意の行、ノード `id["文"]`、つながり `a --> b`、空行）。それ以外の行があれば UNREADABLE を返す。
 * ノードは現れた順に並べ、つながりは現れた順にノードの位置で持つ。
 */
export function parseFlow(text: string): FlowGraphRead {
  const lines = text.split(/\r\n|\r|\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines[0]?.trim() !== HEADER) return unreadable(1, `「${HEADER}」で始まっていない`);

  const positions = new Map<string, number>();
  const nodes: FlowNode[] = [];
  const pending: Array<{ from: string; to: string; line: number }> = [];
  const notes: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const number = i + 1;
    if (line.trim() === "") continue;

    const comment = COMMENT_LINE.exec(line);
    if (comment !== null) {
      notes.push((comment[1] ?? "").trim());
      continue;
    }
    const node = NODE_LINE.exec(line);
    if (node !== null) {
      const id = node[1] ?? "";
      const kind = flowNodeKind(id);
      if (kind === null) return unreadable(number, "ノードの識別子の形が SpecProjector の流れ図と違う");
      if (positions.has(id)) return unreadable(number, "同じノードが 2 回ある");
      positions.set(id, nodes.length);
      nodes.push({ kind, label: unescapeMermaidLabel(node[2] ?? "") });
      continue;
    }
    const edge = EDGE_LINE.exec(line);
    if (edge !== null) {
      pending.push({ from: edge[1] ?? "", to: edge[2] ?? "", line: number });
      continue;
    }
    return unreadable(number, "SpecProjector の流れ図に無い書き方の行");
  }

  const edges: GraphEdge[] = [];
  for (const edge of pending) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from === undefined || to === undefined) return unreadable(edge.line, "つながりの端のノードが無い");
    edges.push({ from, to });
  }
  return { kind: "OK", notes, nodes, edges };
}

/**
 * ノードを層に並べる（決定論的。同じ入力から必ず同じ配置になる）。
 * 1. 閉路を切る: ノードの並びの順に深さ優先でたどり、たどっている途中のノードへ戻るつながりを逆向き（reversed）とする。
 *    自分へのつながりは、層を決めるのに使わない（reversed は false のまま）。
 * 2. 層: 逆向きのつながりを向きを変えて数え、各ノードを、上の層から届く最も長い道の長さの層に置く。
 *    逆向きでないつながりは、必ず上の層から下の層へ向かう。
 * 3. 層の中の並び: 上の層から順に、上の層にあるつながりの元の並びの位置の平均で並べる。
 *    つながりの元が無いノードは後ろに置き、同じ値どうしはノードの並びの順にする。
 * 層をまたぐつながりに中継の点は置かない（描く側は端どうしを結ぶ）。
 */
export function layoutLayers(nodeCount: number, edges: readonly GraphEdge[]): GraphLayout {
  const outgoing: number[][] = Array.from({ length: nodeCount }, () => []);
  edges.forEach((edge, index) => {
    outgoing[edge.from]?.push(index);
  });

  // 1. 閉路を切る。大きな地図でも呼び出しの深さが尽きないよう、再帰を使わずに積み木（stack）でたどる。
  const reversed = edges.map(() => false);
  const state: number[] = new Array<number>(nodeCount).fill(0); // 0: 未訪問、1: たどっている途中、2: 済み
  for (let root = 0; root < nodeCount; root += 1) {
    if (state[root] !== 0) continue;
    state[root] = 1;
    const stack: Array<{ node: number; next: number }> = [{ node: root, next: 0 }];
    while (stack.length > 0) {
      const top = stack.at(-1);
      if (top === undefined) break;
      const list = outgoing[top.node] ?? [];
      if (top.next >= list.length) {
        state[top.node] = 2;
        stack.pop();
        continue;
      }
      const edgeIndex = list[top.next] ?? -1;
      top.next += 1;
      const edge = edges[edgeIndex];
      if (edge === undefined || edge.from === edge.to) continue;
      if (state[edge.to] === 1) {
        reversed[edgeIndex] = true;
      } else if (state[edge.to] === 0) {
        state[edge.to] = 1;
        stack.push({ node: edge.to, next: 0 });
      }
    }
  }

  // 2. 層。逆向きのつながりを向きを変えると閉路が無くなるので、入ってくるつながりが無くなったノードから順に決める。
  const successors: number[][] = Array.from({ length: nodeCount }, () => []);
  const predecessors: number[][] = Array.from({ length: nodeCount }, () => []);
  const remaining: number[] = new Array<number>(nodeCount).fill(0);
  edges.forEach((edge, index) => {
    if (edge.from === edge.to) return;
    const upper = reversed[index] === true ? edge.to : edge.from;
    const lower = reversed[index] === true ? edge.from : edge.to;
    successors[upper]?.push(lower);
    predecessors[lower]?.push(upper);
    remaining[lower] = (remaining[lower] ?? 0) + 1;
  });
  const layerOf: number[] = new Array<number>(nodeCount).fill(0);
  const queue: number[] = [];
  for (let node = 0; node < nodeCount; node += 1) if (remaining[node] === 0) queue.push(node);
  for (let head = 0; head < queue.length; head += 1) {
    const upper = queue[head] ?? 0;
    for (const lower of successors[upper] ?? []) {
      layerOf[lower] = Math.max(layerOf[lower] ?? 0, (layerOf[upper] ?? 0) + 1);
      remaining[lower] = (remaining[lower] ?? 0) - 1;
      if (remaining[lower] === 0) queue.push(lower);
    }
  }

  // 3. 層の中の並び。
  const layerCount = layerOf.reduce((max, layer) => Math.max(max, layer + 1), 0);
  const layers: number[][] = [];
  const orderOf: number[] = new Array<number>(nodeCount).fill(0);
  for (let layer = 0; layer < layerCount; layer += 1) {
    const keyed: Array<{ node: number; key: number }> = [];
    for (let node = 0; node < nodeCount; node += 1) {
      if (layerOf[node] !== layer) continue;
      const uppers = predecessors[node] ?? [];
      const key =
        uppers.length === 0
          ? Number.POSITIVE_INFINITY
          : uppers.reduce((sum, upper) => sum + (orderOf[upper] ?? 0), 0) / uppers.length;
      keyed.push({ node, key });
    }
    keyed.sort((a, b) => (a.key === b.key ? a.node - b.node : a.key - b.key));
    keyed.forEach((item, order) => {
      orderOf[item.node] = order;
    });
    layers.push(keyed.map((item) => item.node));
  }
  return { layerOf, orderOf, layers, reversed };
}

/** シナリオの詳細の流れ図のタブ（設計 3.2・6.9）。flow.mmd を読み、層に並べる。読めなければ理由を返す。 */
export function buildFlowView(text: string): FlowView {
  const graph = parseFlow(text);
  if (graph.kind === "UNREADABLE") return graph;
  return { ...graph, layout: layoutLayers(graph.nodes.length, graph.edges) };
}